import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiMap } from '../../shared/api';
import type {
  AuthInput,
  AuthOption,
  BranchDeletePreview,
  BranchDeleteResult,
  BranchMergePreview,
  BranchMergeResult,
  BranchPublishPreview,
  BranchPublishResult,
  BranchSwitchPreview,
  BranchSwitchResult,
  MergeIssue,
  CommitInfo,
  SwitchSession,
  FriendlyError,
  RepoRecord,
  SavedSshKey,
  SshKeyMatch,
  SshLocalKey,
} from '../../shared/types';
import type { AppContext } from '../context';
import { AppError, toFriendlyError } from '../git/errors';
import type { GitService } from '../git/GitService';
import { generateSshKey, inspectSshKey, listLocalPublicKeys, parsePublicKey, sshDirectory, verifySshPassphrase } from '../git/sshKeys';
import { readSigningConfig, signingSettings, testSshConnection, writeSigningConfig } from '../git/sshTest';
import { gpgStatus, listLocalGpgKeys, resetGpgLocation } from '../git/gpg';
import { DEFAULT_API_BASE } from '../github/GitHubService';
import { describeAuthOptions, type AuthPurpose, type ResolvedAuth } from '../github/authResolver';
import { redactSecrets } from '../util/redact';
import { asBoolean, asBranchName, asEnum, asId, asLine, asObject, asString } from '../util/validate';
import { asConfirmed, parseAuthInput } from './authInput';

type Handler<C extends keyof ApiMap> = (payload: unknown) => Promise<ApiMap[C]['res']>;

export type BranchChannels =
  | 'git:switchPreview'
  | 'git:switchExecute'
  | 'git:switchSession'
  | 'git:switchFinish'
  | 'git:switchUndo'
  | 'git:mergePreview'
  | 'git:mergeExecute'
  | 'git:fastForwardBranch'
  | 'git:publishPreview'
  | 'git:publishExecute'
  | 'git:deletePreview'
  | 'git:deleteExecute'
  | 'ssh:listKeys'
  | 'ssh:generateKey'
  | 'ssh:testConnection'
  | 'ssh:signingConfig'
  | 'ssh:useForSigning';

type HandlerMap = { [C in BranchChannels]: Handler<C> };

interface Remote {
  name: string;
  url: string;
}

export interface BranchHelpers {
  authFor: (repo: RepoRecord, remoteUrl: string, input: AuthInput, purpose: AuthPurpose) => Promise<ResolvedAuth>;
  primaryRemote: (git: GitService, upstream: string | null) => Promise<Remote | null>;
  savedSshKey: (repo: RepoRecord) => SavedSshKey | null;
  repoAccount: (repo: RepoRecord, remoteUrl: string | null) => { id: string; login: string } | null;
  matchResult: (pub: { type: string; fingerprint: string; comment: string }, keyPath: string | null) => SshKeyMatch;
}

interface MergeReview {
  source: string;
  target: string;
  sourceOid: string;
  targetOid: string;
  currentBranch: string | null;
  headOid: string | null;
  state: BranchMergePreview['state'];
  remote: (Remote & { remoteBranch: string; hasUpstream: boolean }) | null;
}

interface PublishReview {
  name: string;
  baseRef: string | null;
  baseOid: string;
  localOid: string | null;
  currentBranch: string | null;
  headOid: string | null;
  pending: string[];
  canCommitPending: boolean;
  remote: Remote;
}

interface DeleteReview {
  local: { name: string; oid: string; current: boolean; merged: boolean } | null;
  remote: (Remote & { branch: string; isDefault: boolean }) | null;
}

interface SwitchReview {
  current: string | null;
  headOid: string | null;
  target: string;
  targetRef: string;
  targetOid: string;
  createsLocalFrom: string | null;
  fingerprint: string;
  canCarry: boolean;
  canReapply: boolean;
  dirty: boolean;
}

interface SwitchMarker {
  from: string | null;
  to: string;
  stashOid: string;
  startedAt: string;
}

const MARKER = 'gitbaba-switch.json';

const UNSIGNED = 'Unsigned (Git identity only)';

/**
 * Branch merge, create & publish, and delete — each with the same per-operation
 * authentication choice as push (Unsigned / SSH / GitHub App installation token),
 * resolved through the shared resolver so no credential handling is duplicated.
 */
export function createBranchHandlers(ctx: AppContext, h: BranchHelpers): HandlerMap {
  /** A .pub path from the renderer is only accepted when it is one of the keys ssh:listKeys reports. */
  function localKeyFor(raw: unknown) {
    const pubPath = asString(raw, 'key', { max: 1024 });
    const want = path.resolve(pubPath).toLowerCase();
    const key = listLocalPublicKeys(sshDirectory()).find((k) => path.resolve(k.pubPath).toLowerCase() === want);
    if (!key) throw new AppError({ code: 'ssh-key-missing', title: 'SSH Key Not Found', message: `${path.basename(pubPath)} is no longer in ${sshDirectory()}. Refresh the list.` });
    return key;
  }

  /** SSH host of the account selected in the header (github.com unless it is a GitHub Enterprise Server account). */
  function activeSshHost(): string {
    const id = ctx.accounts.activeId();
    const a = id ? ctx.accounts.get(id) : null;
    const host = new URL(a?.apiBaseUrl ?? DEFAULT_API_BASE).hostname;
    return host === 'api.github.com' ? 'github.com' : host;
  }

  function authContext(repo: RepoRecord, remote: Remote | null) {
    let authOptions: AuthOption[];
    if (!remote) {
      authOptions = [{ method: 'system', label: UNSIGNED, description: 'No remote is configured, so only local changes are made and no credentials are needed.' }];
    } else {
      authOptions = describeAuthOptions(repo, remote.url, 'push', ctx.secrets.status(repo.id))
        .filter((o) => o.method === 'system' || o.method === 'ssh' || o.method === 'github-app' || o.method === 'none')
        .map((o) =>
          o.method === 'system'
            ? { ...o, label: UNSIGNED, description: "Uses this computer's existing Git setup (ssh-agent / ~/.ssh keys, Git Credential Manager). No credentials are entered here." }
            : o,
        );
    }
    return { authOptions, githubApp: repo.settings.githubApp, savedSshKey: h.savedSshKey(repo), account: h.repoAccount(repo, remote?.url ?? null) };
  }

  /** Resolves auth BEFORE any change is made, so a wrong passphrase or key fails safely. */
  async function resolveFor(repo: RepoRecord, remote: Remote | null, auth: AuthInput): Promise<ResolvedAuth> {
    if (remote) return h.authFor(repo, remote.url, auth, 'push');
    if (auth.method !== 'system') throw new AppError({ code: 'auth-not-applicable', title: 'No Remote Configured', message: 'This repository has no remote, so only "Unsigned" applies.', actions: ['review-auth'] });
    return { git: { kind: 'system' }, description: `${UNSIGNED}, local only`, secrets: [], cleanup: async () => {} };
  }

  async function branchUpstream(git: GitService, branch: string): Promise<{ remote: string; branch: string } | null> {
    const remote = await git.getConfig(`branch.${branch}.remote`);
    const merge = await git.getConfig(`branch.${branch}.merge`);
    if (!remote || remote === '.' || !merge?.startsWith('refs/heads/')) return null;
    return { remote, branch: merge.slice('refs/heads/'.length) };
  }

  async function remoteByName(git: GitService, name: string): Promise<Remote | null> {
    const r = (await git.remotes()).find((x) => x.name === name);
    return r ? { name: r.name, url: r.pushUrl } : null;
  }

  const changed = (what: string) => new AppError({ code: 'changed-since-review', title: 'Changed Since Review', message: `${what} changed after you reviewed this operation. Review it again.` });

  const blockIfBusy = (st: { operation: unknown; conflicted: unknown[] }) => {
    if (st.operation || st.conflicted.length) {
      throw new AppError({ code: 'operation-in-progress', title: 'Operation in Progress', message: 'Finish or abort the current merge/rebase first.', actions: ['resolve-conflicts'] });
    }
  };

  async function verifyPublished(git: GitService, remote: Remote, branch: string, oid: string, resolved: ResolvedAuth): Promise<string> {
    const remoteOid = await git.lsRemoteBranch(remote.name, branch, resolved.git, resolved.transportUrl);
    if (remoteOid !== oid) {
      throw new AppError({
        code: 'publish-unverified',
        title: 'Could Not Verify the Remote Branch',
        message: remoteOid
          ? `${remote.name}/${branch} points to ${remoteOid.slice(0, 10)}, not the pushed commit ${oid.slice(0, 10)}.`
          : `${remote.name}/${branch} was not found on the remote after pushing.`,
      });
    }
    return remoteOid;
  }

  const dirtyFingerprint = (st: { staged: { path: string; kind: string }[]; unstaged: { path: string; kind: string }[]; untracked: { path: string }[] }) =>
    [...st.staged.map((f) => `S:${f.kind}:${f.path}`), ...st.unstaged.map((f) => `U:${f.kind}:${f.path}`), ...st.untracked.map((f) => `N:${f.path}`)].sort().join('\n');

  async function readMarker(git: GitService): Promise<SwitchMarker | null> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(await git.gitDir(), MARKER), 'utf8')) as SwitchMarker;
      if (!/^[0-9a-f]{40}$/.test(raw.stashOid) || typeof raw.to !== 'string') return null;
      return raw;
    } catch {
      return null;
    }
  }
  async function writeMarker(git: GitService, m: SwitchMarker | null) {
    const file = path.join(await git.gitDir(), MARKER);
    if (m) fs.writeFileSync(file, JSON.stringify(m, null, 2));
    else {
      fs.rmSync(file, { force: true });
      // The conflicts of that switch are finished or undone: their undo snapshots no longer apply.
      await git.clearConflictSnapshots();
    }
  }

  return {
    // ---------------- switch branches safely ----------------

    'git:switchPreview': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const target = asBranchName(p.target);
      const kind = asEnum(p.kind, 'kind', ['local', 'remote'] as const);
      const st = await git.status();
      blockIfBusy(st);
      if (await readMarker(git)) {
        throw new AppError({ code: 'switch-in-progress', title: 'Finish the Previous Switch First', message: 'Changes re-applied during an earlier switch still have conflicts. Finish or undo that in the Conflicts tab.', actions: ['resolve-conflicts'] });
      }

      let local = target;
      let targetRef = `refs/heads/${target}`;
      let createsLocalFrom: string | null = null;
      if (kind === 'remote') {
        const r = (await git.remotes()).filter((x) => target.startsWith(`${x.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
        if (!r) throw new AppError({ code: 'branch-not-found', title: 'Remote Not Found', message: `No remote matches "${target}".` });
        local = target.slice(r.name.length + 1);
        if (await git.tryRevParse(`refs/heads/${local}`)) {
          throw new AppError({ code: 'already-exists', title: 'Local Branch Exists', message: `A local branch "${local}" already exists. Switch to it instead.` });
        }
        targetRef = `refs/remotes/${target}`;
        createsLocalFrom = target;
      }
      if (st.branch === local && !createsLocalFrom) throw new AppError({ code: 'same-branch', title: 'Already on This Branch', message: `You are already on ${local}.` });
      const targetOid = await git.tryRevParse(targetRef);
      if (!targetOid) throw new AppError({ code: 'branch-not-found', title: 'Branch Not Found', message: `The branch "${target}" does not exist.` });

      // Classify every uncommitted file — all read-only (stash create / merge-tree / ls-tree).
      const tracked = new Map<string, { kind: BranchSwitchPreview['files'][number]['kind']; staged: boolean }>();
      for (const f of st.unstaged) tracked.set(f.path, { kind: f.kind, staged: false });
      for (const f of st.staged) tracked.set(f.path, { kind: f.kind, staged: true });
      const untracked = st.untracked.map((f) => f.path);
      const changedOnTarget = new Set(st.headOid ? (await git.nameStatus(st.headOid, targetOid)).map((f) => f.path) : []);
      let conflicts: string[] | null = [];
      if (tracked.size && st.headOid) {
        const snapshot = await git.snapshotTrackedChanges();
        conflicts = snapshot ? await git.predictApplyConflicts(st.headOid, targetOid, snapshot) : [];
      }
      const conflictSet = new Set(conflicts ?? []);
      const untrackedOnTarget = await git.pathsInTree(targetOid, untracked);
      const files: BranchSwitchPreview['files'] = [
        ...[...tracked].map(([p2, f]) => ({
          path: p2,
          kind: f.kind,
          staged: f.staged,
          state: (conflictSet.has(p2) ? 'conflict' : changedOnTarget.has(p2) ? (conflicts === null ? 'conflict' : 'merges') : 'safe') as BranchSwitchPreview['files'][number]['state'],
        })),
        ...untracked.map((p2) => ({ path: p2, kind: 'untracked' as const, staged: false, state: (untrackedOnTarget.has(p2) ? 'blocked' : 'safe') as BranchSwitchPreview['files'][number]['state'] })),
      ].sort((a, b) => a.path.localeCompare(b.path));

      const canCarry = files.every((f) => f.state === 'safe');
      const canReapply = !files.some((f) => f.state === 'blocked');
      const dirty = files.length > 0;
      const recommended: BranchSwitchPreview['recommended'] = !dirty || canCarry ? 'carry' : canReapply && !files.some((f) => f.state === 'conflict') ? 'stash-apply' : 'stash';
      const parent = await git.parentOf(targetOid);
      const [tc] = parent ? await git.log({ range: `${parent}..${targetOid}`, limit: 1 }).catch(() => [] as CommitInfo[]) : [];

      const review: SwitchReview = { current: st.branch, headOid: st.headOid, target: local, targetRef, targetOid, createsLocalFrom, fingerprint: dirtyFingerprint(st), canCarry, canReapply, dirty };
      return {
        confirmationId: ctx.confirmations.create('branch-switch', repo.id, review),
        current: st.branch,
        target: local,
        targetRef,
        targetOid,
        targetSubject: tc?.subject ?? '',
        createsLocalFrom,
        files,
        canCarry,
        canReapply,
        predictionAvailable: conflicts !== null,
        recommended,
      };
    },

    'git:switchExecute': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const strategy = asEnum(p.strategy, 'strategy', ['carry', 'stash', 'stash-apply'] as const);
      return ctx.withLock(repo.id, async (): Promise<BranchSwitchResult> => {
        const r = ctx.confirmations.consume<SwitchReview>(asId(p.confirmationId, 'confirmationId'), 'branch-switch', repo.id);
        const st = await git.status();
        blockIfBusy(st);
        if (st.branch !== r.current || st.headOid !== r.headOid) throw changed('The current branch');
        if (dirtyFingerprint(st) !== r.fingerprint) throw changed('Your uncommitted changes');
        if ((await git.tryRevParse(r.targetRef)) !== r.targetOid) throw changed(r.target);
        const doSwitch = () => (r.createsLocalFrom ? git.switchToNewTracking(r.target, r.createsLocalFrom) : git.switchBranch(r.target));
        const from = r.current ?? 'detached HEAD';

        if (!r.dirty || strategy === 'carry') {
          if (r.dirty && !r.canCarry) {
            throw new AppError({ code: 'local-changes', title: 'Changes Would Be Overwritten', message: `Some of your changes differ on ${r.target}, so they cannot simply come along. Stash them, or stash and re-apply.` });
          }
          await doSwitch();
          ctx.recordOperation(repo, 'Switch branch', 'SUCCESS', `${from} → ${r.target}${r.dirty ? ' (uncommitted changes carried over)' : ''}`);
          return { outcome: r.dirty ? 'carried' : 'switched', branch: r.target, stashRef: null, conflicted: [], message: r.dirty ? `Switched to ${r.target}. Your uncommitted changes came along unchanged.` : `Switched to ${r.target}.` };
        }
        if (strategy === 'stash-apply' && !r.canReapply) {
          throw new AppError({ code: 'untracked-collision', title: 'Cannot Re-apply Automatically', message: `Some of your untracked files also exist on ${r.target}. Stash your changes instead and decide on ${r.target}.` });
        }

        const message = `Git Baba: changes from ${from} before switching to ${r.target}`;
        const stashOid = await git.stashAll(message);
        try {
          await doSwitch();
        } catch (err) {
          // Put everything back exactly where it was.
          if (!(await git.stashApplyCommit(stashOid))) await git.stashDropCommit(stashOid);
          throw err;
        }
        if (strategy === 'stash') {
          ctx.recordOperation(repo, 'Switch branch', 'SUCCESS', `${from} → ${r.target}; changes stashed ("${message}")`);
          return { outcome: 'stashed', branch: r.target, stashRef: message, conflicted: [], message: `Switched to ${r.target}. Your changes are saved in the stash "${message}" — apply or pop it from Branches & Stash whenever you want.` };
        }
        const conflicts = await git.stashApplyCommit(stashOid);
        if (!conflicts) {
          await git.stashDropCommit(stashOid);
          ctx.recordOperation(repo, 'Switch branch', 'SUCCESS', `${from} → ${r.target}; changes re-applied cleanly`);
          return { outcome: 'reapplied', branch: r.target, stashRef: null, conflicted: [], message: `Switched to ${r.target} and re-applied your changes cleanly.` };
        }
        await writeMarker(git, { from: r.current, to: r.target, stashOid, startedAt: new Date().toISOString() });
        const conflicted = (await git.status()).conflicted.map((f) => f.path);
        ctx.recordOperation(repo, 'Switch branch', 'WARNING', `${from} → ${r.target}; re-applying changes stopped with ${conflicted.length} conflict(s); backup stash kept`);
        return {
          outcome: 'conflicts',
          branch: r.target,
          stashRef: message,
          conflicted,
          message: `Switched to ${r.target}, but ${conflicted.length} file(s) conflict with your changes. Resolve them in the Conflicts tab. Your original changes are kept in a backup stash until you finish, so you can always undo.`,
        };
      });
    },

    'git:switchSession': async (payload) => {
      const { git } = ctx.git(asObject(payload).repoId);
      const m = await readMarker(git);
      if (!m) return null;
      return { ...m, stashExists: (await git.stashIndexOf(m.stashOid)) !== null } satisfies SwitchSession;
    },

    'git:switchFinish': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const dropBackup = asBoolean(p.dropBackup, 'dropBackup');
      return ctx.withLock(repo.id, async () => {
        const m = await readMarker(git);
        if (!m) throw new AppError({ code: 'no-operation', title: 'Nothing to Finish', message: 'No switch is waiting for conflict resolution.' });
        const st = await git.status();
        if (st.conflicted.length) throw new AppError({ code: 'unresolved', title: 'Unresolved Conflicts Remain', message: `${st.conflicted.length} file(s) still have conflicts.`, actions: ['resolve-conflicts'] });
        // Resolved files were staged by "Mark as resolved"; leave them as ordinary uncommitted changes.
        await git.unstageAllKeepFiles();
        const droppedBackup = dropBackup ? await git.stashDropCommit(m.stashOid) : false;
        await writeMarker(git, null);
        ctx.recordOperation(repo, 'Switch branch', 'SUCCESS', `Finished bringing changes from ${m.from ?? 'detached HEAD'} to ${m.to}${droppedBackup ? '' : '; backup stash kept'}`);
        return { droppedBackup };
      });
    },

    'git:switchUndo': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const returnToSource = asBoolean(p.returnToSource, 'returnToSource');
      return ctx.withLock(repo.id, async () => {
        const m = await readMarker(git);
        if (!m) throw new AppError({ code: 'no-operation', title: 'Nothing to Undo', message: 'No switch is waiting for conflict resolution.' });
        if ((await git.stashIndexOf(m.stashOid)) === null) {
          throw new AppError({ code: 'backup-missing', title: 'Backup Stash Missing', message: 'The backup stash of your changes no longer exists, so undoing could lose work. Resolve the conflicts instead.' });
        }
        // The working tree was clean before re-applying, so everything now uncommitted came from the stash — which is kept.
        const fromStash = await git.stashUntrackedPaths(m.stashOid);
        await git.resetHardHead();
        await git.cleanUntracked(fromStash);
        await writeMarker(git, null);
        const stashName = `Git Baba: changes from ${m.from ?? 'detached HEAD'} before switching to ${m.to}`;
        if (returnToSource && m.from) {
          await git.switchBranch(m.from);
          if (!(await git.stashApplyCommit(m.stashOid))) {
            await git.stashDropCommit(m.stashOid);
            ctx.recordOperation(repo, 'Undo switch', 'SUCCESS', `Back on ${m.from} with the original changes`);
            return { branch: m.from, restored: true, message: `You are back on ${m.from} with your changes exactly as before.` };
          }
          await writeMarker(git, { from: m.to, to: m.from, stashOid: m.stashOid, startedAt: new Date().toISOString() });
          return { branch: m.from, restored: false, message: `Back on ${m.from}, but ${m.from} changed in the meantime and your changes conflict. Resolve them in the Conflicts tab (the backup stash is kept).` };
        }
        ctx.recordOperation(repo, 'Undo switch', 'SUCCESS', `Re-applied changes removed from ${m.to}; kept in stash`);
        return { branch: m.to, restored: true, message: `Your changes were taken off ${m.to} and are safe in the stash "${stashName}".` };
      });
    },

    // ---------------- merge one branch into another ----------------

    'git:mergePreview': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const source = asBranchName(p.source, 'source branch');
      const target = asBranchName(p.target, 'target branch');
      if (source === target) throw new AppError({ code: 'same-branch', title: 'Same Branch', message: 'Choose two different branches.' });
      const st = await git.status();
      blockIfBusy(st);
      const targetOid = await git.tryRevParse(`refs/heads/${target}`);
      if (!targetOid) throw new AppError({ code: 'branch-not-found', title: 'Target Branch Not Found', message: `The local branch "${target}" does not exist.` });
      const sourceOid = (await git.tryRevParse(`refs/heads/${source}`)) ?? (await git.tryRevParse(`refs/remotes/${source}`));
      if (!sourceOid) throw new AppError({ code: 'branch-not-found', title: 'Source Branch Not Found', message: `The branch "${source}" does not exist.` });

      // ---- Diagnose (all read-only) ----
      const mergeBase = await git.mergeBase(targetOid, sourceOid);
      const upToDate = await git.isAncestor(sourceOid, targetOid);
      const ff = !upToDate && (await git.isAncestor(targetOid, sourceOid));
      const state: BranchMergePreview['state'] = upToDate ? 'up-to-date' : ff ? 'fast-forward' : mergeBase ? 'merge' : 'unrelated';
      const commits = upToDate ? [] : await git.log({ range: `${targetOid}..${sourceOid}`, limit: 300 });
      const targetOnlyCommits = upToDate || ff ? [] : await git.log({ range: `${sourceOid}..${targetOid}`, limit: 1000 });
      // Without a merge base a three-dot diff is impossible; compare the two trees directly.
      const files = upToDate ? [] : await git.nameStatus(mergeBase ?? targetOid, sourceOid);
      const predictedConflicts = state === 'merge' || state === 'unrelated' ? await git.predictMergeConflicts(targetOid, sourceOid, state === 'unrelated') : [];

      const up = await branchUpstream(git, target);
      const remote = up ? await remoteByName(git, up.remote) : await h.primaryRemote(git, null);
      let remoteInfo: BranchMergePreview['remote'] = null;
      let reviewRemote: MergeReview['remote'] = null;
      if (remote) {
        const remoteBranch = up?.branch ?? target;
        const trackingOid = await git.tryRevParse(`refs/remotes/${remote.name}/${remoteBranch}`);
        const behindRemote = trackingOid && !(await git.isAncestor(trackingOid, targetOid)) ? (await git.log({ range: `${targetOid}..${trackingOid}`, limit: 500 })).length : 0;
        const canFastForward = !!trackingOid && behindRemote > 0 && (await git.isAncestor(targetOid, trackingOid));
        remoteInfo = { name: remote.name, url: redactSecrets(remote.url), remoteBranch, trackingExists: !!trackingOid, behindRemote, canFastForward };
        reviewRemote = { ...remote, remoteBranch, hasUpstream: !!up };
      }

      // The source's own remote branch (e.g. local qa vs origin/qa).
      let sourceRemote: BranchMergePreview['sourceRemote'] = null;
      const srcIsLocal = !!(await git.tryRevParse(`refs/heads/${source}`));
      if (srcIsLocal && remote) {
        const sUp = await branchUpstream(git, source);
        const ref = sUp ? `${sUp.remote}/${sUp.branch}` : `${remote.name}/${source}`;
        const oid = await git.tryRevParse(`refs/remotes/${ref}`);
        sourceRemote = {
          ref,
          exists: !!oid,
          localAhead: oid ? (await git.log({ range: `${oid}..${sourceOid}`, limit: 500 })).length : 0,
          localBehind: oid ? (await git.log({ range: `${sourceOid}..${oid}`, limit: 500 })).length : 0,
        };
      }

      const dirtyFiles = [...new Set([...st.staged, ...st.unstaged].map((f) => f.path))];
      const issues: MergeIssue[] = [];
      if (state === 'unrelated') {
        issues.push({
          id: 'unrelated',
          category: 'history',
          severity: 'blocker',
          title: `${source} and ${target} have no common history`,
          explanation: `Git found no shared ancestor commit (no merge base): the branches were started independently, or one was re-created or rewritten. A normal merge is impossible, and GitHub cannot open a pull request between them directly. You can still combine them with "Merge anyway" (Git's --allow-unrelated-histories): every file that exists on both sides with different content becomes a conflict for you to decide.`,
          fix: 'merge-anyway',
        });
      }
      if (predictedConflicts && predictedConflicts.length) {
        issues.push({
          id: 'conflicts',
          category: 'git-conflict',
          severity: 'warning',
          title: `${predictedConflicts.length} file(s) will conflict`,
          explanation: 'Both branches changed the same parts of these files. Stop and resolve them yourself, or let Git keep one side for each conflicting part automatically.',
          fix: 'resolve-conflicts',
        });
      }
      if (predictedConflicts === null && state !== 'up-to-date') {
        issues.push({ id: 'no-prediction', category: 'git-conflict', severity: 'info', title: 'Conflicts could not be predicted', explanation: 'This Git version cannot preview merges. Any conflicts appear during the merge and can be resolved in the Conflicts tab.', fix: null });
      }
      if (st.branch !== target && dirtyFiles.length) {
        issues.push({ id: 'dirty', category: 'working-tree', severity: 'blocker', title: `${dirtyFiles.length} uncommitted file(s)`, explanation: `The merge happens on ${target}, so Git must switch branches, which needs a clean working tree. Commit or stash your changes first.`, fix: 'commit-or-stash' });
      }
      if (remoteInfo && remoteInfo.behindRemote > 0) {
        issues.push({
          id: 'target-behind',
          category: 'remote',
          severity: 'warning',
          title: `${target} is ${remoteInfo.behindRemote} commit(s) behind ${remoteInfo.name}/${remoteInfo.remoteBranch}`,
          explanation: remoteInfo.canFastForward
            ? `Your local ${target} is out of date, so publishing would be rejected. It can be moved forward safely (fast-forward, no merge commit) before merging.`
            : `Your local ${target} and ${remoteInfo.name}/${remoteInfo.remoteBranch} have diverged. Pull ${target} first, or merge into a new branch and open a pull request.`,
          fix: remoteInfo.canFastForward ? 'fast-forward-target' : 'bridge-pr',
        });
      }
      if (sourceRemote?.exists && sourceRemote.localBehind > 0) {
        issues.push({ id: 'source-behind', category: 'remote', severity: 'info', title: `Local ${source} is ${sourceRemote.localBehind} commit(s) behind ${sourceRemote.ref}`, explanation: `Those newer remote commits are not part of this merge. Pull ${source} first if you want them included.`, fix: null });
      }
      if (remote && remoteInfo && !remoteInfo.trackingExists) {
        issues.push({ id: 'target-untracked', category: 'remote', severity: 'info', title: `${remote.name}/${remoteInfo.remoteBranch} is not known locally`, explanation: 'The remote state is unknown or the branch is new. Fetch to refresh what Git Baba knows about the remote.', fix: 'fetch' });
      }

      const shortSource = remote && !srcIsLocal && source.startsWith(`${remote.name}/`) ? source.slice(remote.name.length + 1) : source;
      const review: MergeReview = { source, target, sourceOid, targetOid, currentBranch: st.branch, headOid: st.headOid, state, remote: reviewRemote };
      const preview: BranchMergePreview = {
        confirmationId: ctx.confirmations.create('branch-merge', repo.id, review),
        source,
        target,
        sourceOid,
        targetOid,
        currentBranch: st.branch,
        state,
        mergeBase,
        sourceOnly: commits.length,
        targetOnly: targetOnlyCommits.length,
        commits,
        files,
        predictedConflicts,
        dirtyFiles,
        remote: remoteInfo,
        sourceRemote,
        issues,
        suggestedBridge: `merge/${shortSource}-into-${target}`.replace(/[^A-Za-z0-9._/-]+/g, '-'),
        ...authContext(repo, remote),
      };
      return preview;
    },

    'git:mergeExecute': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const auth = parseAuthInput(p.auth);
      const returnToCurrent = asBoolean(p.returnToCurrent, 'returnToCurrent');
      const allowUnrelated = p.allowUnrelated === true;
      const strategy = p.conflictStrategy ? asEnum(p.conflictStrategy, 'conflict strategy', ['stop', 'prefer-target', 'prefer-source'] as const) : 'stop';
      const bridge = p.bridge ? asBranchName(p.bridge, 'merge branch name') : null;
      const method = p.method ? asEnum(p.method, 'merge method', ['merge', 'squash', 'rebase'] as const) : 'merge';
      const customMessage = typeof p.message === 'string' && p.message.trim() ? p.message.trim().slice(0, 20_000) : null;
      // A merge branch exists to be published for a pull request.
      const push = bridge ? true : asBoolean(p.push, 'push');
      return ctx.withLock(repo.id, async (): Promise<BranchMergeResult> => {
        const r = ctx.confirmations.consume<MergeReview>(asId(p.confirmationId, 'confirmationId'), 'branch-merge', repo.id);
        const st = await git.status();
        blockIfBusy(st);
        if (st.branch !== r.currentBranch || st.headOid !== r.headOid) throw changed('The current branch');
        if ((await git.tryRevParse(`refs/heads/${r.target}`)) !== r.targetOid) throw changed(r.target);
        const srcNow = (await git.tryRevParse(`refs/heads/${r.source}`)) ?? (await git.tryRevParse(`refs/remotes/${r.source}`));
        if (srcNow !== r.sourceOid) throw changed(r.source);
        if (r.state === 'unrelated' && !allowUnrelated) {
          throw new AppError({ code: 'unrelated-histories', title: 'No Common History', message: `${r.source} and ${r.target} share no history. Tick "Merge anyway" to combine them on purpose.` });
        }
        if (method === 'rebase' && r.state === 'unrelated') {
          throw new AppError({ code: 'unrelated-histories', title: 'Cannot Rebase', message: `${r.source} and ${r.target} share no history, so there is nothing to rebase onto. Use a merge commit or squash instead.` });
        }
        const workBranch = bridge ?? r.target;
        if (bridge && (await git.tryRevParse(`refs/heads/${bridge}`))) {
          throw new AppError({ code: 'already-exists', title: 'Merge Branch Exists', message: `A branch named "${bridge}" already exists. Choose another name.` });
        }
        if ((bridge || st.branch !== r.target) && (st.staged.length || st.unstaged.length)) {
          throw new AppError({
            code: 'local-changes',
            title: 'Uncommitted Changes',
            message: `Switching to ${workBranch} for the merge needs a clean working tree. Commit or stash your changes first — nothing was changed.`,
          });
        }
        if (push && !r.remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'There is no remote to publish the merge to.' });

        const resolved = await resolveFor(repo, r.remote, auth);
        try {
          let switched = false;
          if (bridge) {
            // New branch at exactly the reviewed target commit; the target itself is not changed.
            await git.createBranch(bridge, r.targetOid, true);
            switched = true;
          } else if (st.branch !== r.target) {
            await git.switchBranch(r.target);
            switched = true;
          }
          let outcome: BranchMergeResult['outcome'] = 'up-to-date';
          if (r.state !== 'up-to-date') {
            const prefer = strategy === 'prefer-target' ? 'ours' : strategy === 'prefer-source' ? 'theirs' : undefined;
            // A fast-forward is already linear: rebase adds nothing, so it simply moves the branch.
            const base = method === 'rebase' && r.state !== 'fast-forward' ? await git.mergeBase(r.targetOid, r.sourceOid) : null;
            const conflicts =
              method === 'squash'
                ? await git.squashMerge(r.sourceOid, customMessage ?? `Squashed merge of '${r.source}' into ${r.target}`, { allowUnrelated: r.state === 'unrelated', prefer })
                : base
                  ? await git.replayCommits(base, r.sourceOid, { prefer })
                  : await git.merge(r.sourceOid, { message: customMessage ?? `Merge branch '${r.source}' into ${r.target}`, allowUnrelated: r.state === 'unrelated', prefer });
            if (conflicts) {
              const conflicted = (await git.status()).conflicted.map((f) => f.path);
              ctx.recordOperation(repo, 'Merge branch', 'WARNING', `${r.source} → ${workBranch}: ${conflicted.length} conflicted file(s)`);
              return {
                outcome: 'conflicts',
                bridge,
                newOid: null,
                conflicted,
                pushed: false,
                pushError: null,
                verifiedRemoteOid: null,
                returnedTo: null,
                authDescription: resolved.description,
                message: `Merging ${r.source} into ${workBranch} stopped with conflicts. You are now on ${workBranch}. Resolve them (or abort the merge) in the Conflicts tab, then Continue; nothing was pushed.${bridge ? ` Afterwards publish ${bridge} (Push) and open the pull request ${bridge} → ${r.target}.` : ''}`,
              };
            }
            outcome = r.state === 'fast-forward' ? 'fast-forward' : 'merged';
          }
          const newOid = await git.revParse('HEAD');
          ctx.recordOperation(
            repo,
            'Merge branch',
            'SUCCESS',
            `${r.source} → ${workBranch} (${method}, ${outcome}${r.state === 'unrelated' ? ', unrelated histories' : ''}${strategy !== 'stop' ? `, conflicts auto-resolved ${strategy}` : ''}, ${newOid.slice(0, 8)})`,
          );

          let pushed = false;
          let pushError: FriendlyError | null = null;
          let verifiedRemoteOid: string | null = null;
          const remoteBranch = bridge ?? r.remote?.remoteBranch;
          if (push && r.remote && remoteBranch) {
            try {
              await git.push(r.remote.name, newOid, remoteBranch, resolved.git, { setUpstreamFor: bridge ? bridge : r.remote.hasUpstream ? undefined : r.target, transportUrl: resolved.transportUrl });
              verifiedRemoteOid = await verifyPublished(git, r.remote, remoteBranch, newOid, resolved);
              pushed = true;
              ctx.recordOperation(repo, 'Push', 'SUCCESS', `${workBranch} → ${r.remote.name}/${remoteBranch} after merge, using ${resolved.description}`);
            } catch (err) {
              pushError = toFriendlyError(err, 'Push', resolved.secrets);
              ctx.recordOperation(repo, 'Push', 'FAILED', `${workBranch} → ${r.remote.name}/${remoteBranch} after merge, using ${resolved.description}`);
            }
          }
          let returnedTo: string | null = null;
          if (switched && returnToCurrent && r.currentBranch) {
            try {
              await git.switchBranch(r.currentBranch);
              returnedTo = r.currentBranch;
            } catch {
              returnedTo = null;
            }
          }
          const what =
            outcome === 'up-to-date'
              ? `${r.target} already contained ${r.source}`
              : `${r.source} was ${method === 'squash' ? 'squashed into one commit on' : method === 'rebase' && outcome !== 'fast-forward' ? 'rebased onto' : 'merged into'} ${bridge ? `the new branch ${bridge} (based on ${r.target})` : r.target}${outcome === 'fast-forward' && method !== 'squash' ? ' (fast-forward)' : ''}`;
          return {
            outcome,
            bridge,
            newOid,
            conflicted: [],
            pushed,
            pushError,
            verifiedRemoteOid,
            returnedTo,
            authDescription: resolved.description,
            message: `${what}.${push ? (pushed ? ` Published to ${r.remote!.name}/${remoteBranch} and verified.` : ' The merge is done locally, but publishing it failed.') : ' Not pushed (local only).'}`,
          };
        } finally {
          await resolved.cleanup();
        }
      });
    },

    'git:fastForwardBranch': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const branch = asBranchName(p.branch);
      return ctx.withLock(repo.id, async () => {
        const local = await git.tryRevParse(`refs/heads/${branch}`);
        if (!local) throw new AppError({ code: 'branch-not-found', title: 'Branch Not Found', message: `The local branch "${branch}" does not exist.` });
        const up = await branchUpstream(git, branch);
        const remote = up ? up.remote : (await h.primaryRemote(git, null))?.name;
        const ref = `refs/remotes/${remote}/${up?.branch ?? branch}`;
        const remoteOid = remote ? await git.tryRevParse(ref) : null;
        if (!remoteOid) throw new AppError({ code: 'no-upstream', title: 'No Remote Branch', message: `There is no remote branch for ${branch}. Fetch first.` });
        if (remoteOid === local) return { from: local, to: local };
        if (!(await git.isAncestor(local, remoteOid))) {
          throw new AppError({ code: 'diverged', title: 'Branches Have Diverged', message: `${branch} has commits that are not on the remote, so it cannot simply move forward. Pull it with a merge or rebase instead.` });
        }
        const st = await git.status();
        // Checked-out branch: Git's own fast-forward refuses to overwrite local changes. Otherwise move the ref atomically.
        if (st.branch === branch) await git.mergeFastForwardOnly(remoteOid);
        else await git.updateBranchRef(branch, remoteOid, local);
        ctx.recordOperation(repo, 'Fast-forward branch', 'SUCCESS', `${branch} ${local.slice(0, 8)} → ${remoteOid.slice(0, 8)}`);
        return { from: local, to: remoteOid };
      });
    },

    // ---------------- create & publish ----------------

    'git:publishPreview': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const name = asBranchName(p.name, 'branch name');
      const base = p.base ? asBranchName(p.base, 'base branch') : null;
      const st = await git.status();
      blockIfBusy(st);
      let baseRef: string | null = null;
      let baseOid: string | null = null;
      if (base) {
        baseOid = await git.tryRevParse(`refs/heads/${base}`);
        baseRef = baseOid ? `refs/heads/${base}` : null;
        if (!baseOid) {
          baseOid = await git.tryRevParse(`refs/remotes/${base}`);
          baseRef = baseOid ? `refs/remotes/${base}` : null;
        }
        // A commit chosen in Git History: commits never move, so there is no ref to re-check.
        if (!baseOid && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base)) baseOid = await git.tryRevParse(`${base}^{commit}`);
        if (!baseOid) throw new AppError({ code: 'branch-not-found', title: 'Base Branch Not Found', message: `The branch "${base}" does not exist.` });
      } else {
        baseOid = st.headOid;
        if (!baseOid) throw new AppError({ code: 'no-commits', title: 'No Commits Yet', message: 'Create a first commit before creating branches.' });
      }
      const localOid = await git.tryRevParse(`refs/heads/${name}`);
      if (localOid && !(await git.isAncestor(baseOid, localOid))) {
        throw new AppError({ code: 'already-exists', title: 'Branch Already Exists', message: `A different branch named "${name}" already exists locally. Choose another name.` });
      }
      const remote = await h.primaryRemote(git, null);
      if (!remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'Publishing needs a remote. Add one in Settings, or use "Create locally".', actions: ['open-settings'] });
      const pending = [...new Set([...st.staged, ...st.unstaged, ...st.untracked].map((f) => f.path))].sort();
      const canCommitPending = pending.length > 0 && baseOid === st.headOid;
      const baseParent = await git.parentOf(baseOid);
      const [baseCommit] = baseParent ? await git.log({ range: `${baseParent}..${baseOid}`, limit: 1 }).catch(() => [] as CommitInfo[]) : [];
      const review: PublishReview = { name, baseRef, baseOid, localOid, currentBranch: st.branch, headOid: st.headOid, pending, canCommitPending, remote };
      const preview: BranchPublishPreview = {
        confirmationId: ctx.confirmations.create('branch-publish', repo.id, review),
        name,
        base: base ?? st.branch ?? 'HEAD',
        baseOid,
        baseSubject: baseCommit?.subject ?? '',
        currentBranch: st.branch,
        localExists: !!localOid,
        localOid,
        remote: { name: remote.name, url: redactSecrets(remote.url) },
        remoteTrackingExists: !!(await git.tryRevParse(`refs/remotes/${remote.name}/${name}`)),
        pendingFiles: pending,
        canCommitPending,
        ...authContext(repo, remote),
      };
      return preview;
    },

    'git:publishExecute': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const auth = parseAuthInput(p.auth);
      const switchTo = asBoolean(p.switchTo, 'switchTo');
      const commitMessage = p.commitMessage ? asString(p.commitMessage, 'Commit message', { max: 20_000 }) : null;
      return ctx.withLock(repo.id, async (): Promise<BranchPublishResult> => {
        const r = ctx.confirmations.consume<PublishReview>(asId(p.confirmationId, 'confirmationId'), 'branch-publish', repo.id);
        const st = await git.status();
        blockIfBusy(st);
        if (st.branch !== r.currentBranch || st.headOid !== r.headOid) throw changed('The current branch');
        if (r.baseRef && (await git.tryRevParse(r.baseRef)) !== r.baseOid) throw changed('The base branch');
        if ((await git.tryRevParse(`refs/heads/${r.name}`)) !== r.localOid) throw changed(`The branch ${r.name}`);
        if (commitMessage) {
          if (!r.canCommitPending) throw new AppError({ code: 'cannot-commit-pending', title: 'Cannot Commit Pending Changes', message: 'Pending changes can only be committed when the new branch starts from the current commit.' });
          const now = [...new Set([...st.staged, ...st.unstaged, ...st.untracked].map((f) => f.path))].sort();
          if (now.join('\n') !== r.pending.join('\n')) throw changed('Your uncommitted changes');
          const identity = await git.identity();
          if (!identity.name || !identity.email) throw new AppError({ code: 'identity-missing', title: 'Git Identity Not Configured', message: 'Set your name and email before committing.', actions: ['set-identity'] });
        }

        const resolved = await resolveFor(repo, r.remote, auth);
        try {
          const checkout = switchTo || !!commitMessage;
          if (!r.localOid) await git.createBranch(r.name, r.baseOid, checkout);
          else if (checkout && st.branch !== r.name) await git.switchBranch(r.name);

          // The branch must contain exactly the reviewed base state (or build on it, when reused).
          let oid = await git.revParse(`refs/heads/${r.name}`);
          if (oid !== r.baseOid && !(await git.isAncestor(r.baseOid, oid))) throw changed(`The branch ${r.name}`);

          let committed: CommitInfo | null = null;
          if (commitMessage) {
            await git.stageAll();
            committed = await git.commit(commitMessage, 'none');
            oid = await git.revParse(`refs/heads/${r.name}`);
            ctx.recordOperation(repo, 'Commit', 'SUCCESS', `${committed.shortHash} "${committed.subject}" on new branch ${r.name} (unsigned)`);
          }

          const out = await git.push(r.remote.name, oid, r.name, resolved.git, { setUpstreamFor: r.name, transportUrl: resolved.transportUrl });
          const verifiedRemoteOid = await verifyPublished(git, r.remote, r.name, oid, resolved);
          const summary = `${r.name} created from ${r.baseOid.slice(0, 8)} and published to ${r.remote.name}/${r.name} using ${resolved.description}`;
          ctx.recordOperation(repo, 'Create & publish branch', 'SUCCESS', summary);
          return { branch: r.name, oid, remote: r.remote.name, verifiedRemoteOid, committed, authDescription: resolved.description, summary: redactSecrets(out, resolved.secrets) || summary };
        } catch (err) {
          ctx.recordOperation(repo, 'Create & publish branch', 'FAILED', `${r.name} using ${resolved.description}`);
          const f = toFriendlyError(err, 'Publish branch', resolved.secrets);
          const exists = await git.tryRevParse(`refs/heads/${r.name}`);
          throw new AppError({
            ...f,
            message: exists ? `${f.message} The branch “${r.name}” exists locally but is NOT published. Fix the problem and choose Create & Publish again — the local branch is reused.` : f.message,
          });
        } finally {
          await resolved.cleanup();
        }
      });
    },

    // ---------------- delete ----------------

    'git:deletePreview': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const branch = asBranchName(p.branch);
      const kind = asEnum(p.kind, 'kind', ['local', 'remote'] as const);
      const st = await git.status();
      const remotes = await git.remotes();

      let localName: string | null = null;
      let remote: Remote | null = null;
      let remoteBranch: string | null = null;
      if (kind === 'local') {
        localName = branch;
        const up = await branchUpstream(git, branch);
        if (up) {
          remote = await remoteByName(git, up.remote);
          remoteBranch = up.branch;
        } else {
          const r = await h.primaryRemote(git, null);
          if (r && (await git.tryRevParse(`refs/remotes/${r.name}/${branch}`))) {
            remote = r;
            remoteBranch = branch;
          }
        }
      } else {
        const r = remotes.filter((x) => branch.startsWith(`${x.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
        if (!r) throw new AppError({ code: 'branch-not-found', title: 'Remote Not Found', message: `No remote matches "${branch}".` });
        remote = { name: r.name, url: r.pushUrl };
        remoteBranch = branch.slice(r.name.length + 1);
        if (await git.tryRevParse(`refs/heads/${remoteBranch}`)) localName = remoteBranch;
      }

      let local: BranchDeletePreview['local'] = null;
      if (localName) {
        const oid = await git.tryRevParse(`refs/heads/${localName}`);
        if (!oid) throw new AppError({ code: 'branch-not-found', title: 'Branch Not Found', message: `The local branch "${localName}" does not exist.` });
        const up = await branchUpstream(git, localName);
        const upOid = up ? await git.tryRevParse(`refs/remotes/${up.remote}/${up.branch}`) : null;
        const merged = (!!st.headOid && st.branch !== localName && (await git.isAncestor(oid, st.headOid))) || (!!upOid && (await git.isAncestor(oid, upOid)));
        local = { name: localName, oid, current: st.branch === localName, merged, upstream: up ? `${up.remote}/${up.branch}` : null };
      }

      let remoteInfo: BranchDeletePreview['remote'] = null;
      if (remote && remoteBranch) {
        const trackingRef = `refs/remotes/${remote.name}/${remoteBranch}`;
        const oid = await git.tryRevParse(trackingRef);
        const isDefault = (await git.remoteDefaultBranch(remote.name)) === remoteBranch;
        const uniqueCommits = oid ? await git.uniqueCommitCount(trackingRef, [trackingRef]) : 0;
        const uniqueCommitsWithLocal = oid ? await git.uniqueCommitCount(trackingRef, localName ? [trackingRef, `refs/heads/${localName}`] : [trackingRef]) : 0;
        remoteInfo = { name: remote.name, url: redactSecrets(remote.url), branch: remoteBranch, oid, isDefault, uniqueCommits, uniqueCommitsWithLocal };
      }

      const review: DeleteReview = {
        local: local ? { name: local.name, oid: local.oid, current: local.current, merged: local.merged } : null,
        remote: remote && remoteInfo ? { ...remote, branch: remoteInfo.branch, isDefault: remoteInfo.isDefault } : null,
      };
      const preview: BranchDeletePreview = {
        confirmationId: ctx.confirmations.create('branch-delete', repo.id, review),
        local,
        remote: remoteInfo,
        ...authContext(repo, remote),
      };
      return preview;
    },

    'git:deleteExecute': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const auth = parseAuthInput(p.auth);
      const deleteLocal = asBoolean(p.deleteLocal, 'deleteLocal');
      const deleteRemote = asBoolean(p.deleteRemote, 'deleteRemote');
      const force = asBoolean(p.force, 'force');
      return ctx.withLock(repo.id, async (): Promise<BranchDeleteResult> => {
        const r = ctx.confirmations.consume<DeleteReview>(asId(p.confirmationId, 'confirmationId'), 'branch-delete', repo.id);
        if (!deleteLocal && !deleteRemote) throw new AppError({ code: 'invalid-input', title: 'Nothing Selected', message: 'Choose the local and/or remote branch to delete.' });
        if (deleteLocal && !r.local) throw new AppError({ code: 'invalid-input', title: 'No Local Branch', message: 'There is no local branch to delete.' });
        if (deleteRemote && !r.remote) throw new AppError({ code: 'invalid-input', title: 'No Remote Branch', message: 'There is no remote branch to delete.' });
        const st = await git.status();
        if (deleteLocal && r.local) {
          if (st.branch === r.local.name) throw new AppError({ code: 'current-branch', title: 'Branch Is Checked Out', message: `You are on ${r.local.name}. Switch to another branch before deleting it.` });
          if ((await git.tryRevParse(`refs/heads/${r.local.name}`)) !== r.local.oid) throw changed(`The branch ${r.local.name}`);
          if (!r.local.merged && !force) {
            throw new AppError({ code: 'branch-not-merged', title: 'Branch Not Fully Merged', message: `${r.local.name} has commits that are not merged into the current branch or its upstream. Confirm a forced delete if you really want to lose them.` });
          }
        }
        if (deleteRemote && r.remote?.isDefault) {
          throw new AppError({ code: 'default-branch-delete', title: 'Cannot Delete the Default Branch', message: `${r.remote.name}/${r.remote.branch} is the repository's default branch. Change the default branch on GitHub first.` });
        }

        const messages: string[] = [];
        let remoteDeleted = false;
        let remoteMissing = false;
        let localDeleted = false;
        const resolved = deleteRemote && r.remote ? await resolveFor(repo, r.remote, auth) : null;
        try {
          // Remote first: if the remote refuses (protected, no permission), nothing local has changed yet.
          if (deleteRemote && r.remote && resolved) {
            try {
              // Ask the server first: a branch that is already gone is reported as such, not as "deleted".
              if (await git.lsRemoteBranch(r.remote.name, r.remote.branch, resolved.git, resolved.transportUrl)) {
                await git.deleteRemoteBranch(r.remote.name, r.remote.branch, resolved.git, resolved.transportUrl);
              } else {
                remoteMissing = true;
                await git.dropTrackingRef(r.remote.name, r.remote.branch);
              }
            } catch (err) {
              const f = toFriendlyError(err, 'Delete remote branch', resolved.secrets);
              if (f.code !== 'remote-branch-missing') {
                ctx.recordOperation(repo, 'Delete remote branch', 'FAILED', `${r.remote.name}/${r.remote.branch} using ${resolved.description}`);
                throw err;
              }
              remoteMissing = true;
              await git.dropTrackingRef(r.remote.name, r.remote.branch);
            }
            if (await git.lsRemoteBranch(r.remote.name, r.remote.branch, resolved.git, resolved.transportUrl)) {
              throw new AppError({ code: 'delete-unverified', title: 'Remote Branch Still Exists', message: `${r.remote.name}/${r.remote.branch} still exists on the remote after deleting it.` });
            }
            remoteDeleted = !remoteMissing;
            messages.push(remoteMissing ? `${r.remote.name}/${r.remote.branch} was already gone on the remote; the stale reference was removed.` : `Deleted ${r.remote.name}/${r.remote.branch} on the remote (verified).`);
            ctx.recordOperation(repo, 'Delete remote branch', 'SUCCESS', `${r.remote.name}/${r.remote.branch} using ${resolved.description}`);
          }
          if (deleteLocal && r.local) {
            try {
              await git.deleteBranch(r.local.name, force);
            } catch (err) {
              if (remoteDeleted || remoteMissing) {
                const f = toFriendlyError(err, 'Delete branch');
                throw new AppError({ ...f, message: `${f.message} (The remote branch was already deleted; the local branch ${r.local.name} still exists.)` });
              }
              throw err;
            }
            localDeleted = true;
            messages.push(`Deleted the local branch ${r.local.name}${force ? ' (forced)' : ''}.`);
            ctx.recordOperation(repo, force ? 'Force delete branch' : 'Delete branch', 'SUCCESS', r.local.name);
          }
          return { localDeleted, remoteDeleted, remoteMissing, authDescription: resolved?.description ?? null, messages };
        } finally {
          await resolved?.cleanup();
        }
      });
    },

    // ---------------- SSH keys ----------------

    'ssh:listKeys': async () => {
      const directory = sshDirectory();
      const keys: SshLocalKey[] = listLocalPublicKeys(directory).map((k) => ({ ...h.matchResult(k.parsed, k.privatePath), publicKey: k.publicKey, pubPath: k.pubPath }));
      return { directory, keys };
    },

    'ssh:generateKey': async (payload) => {
      const p = asObject(payload);
      const type = asEnum(p.type, 'key type', ['ed25519', 'rsa', 'ecdsa'] as const);
      const fileName = asString(p.fileName, 'File name', { max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      if (fileName.endsWith('.pub') || fileName.startsWith('.') || /^(known_hosts|config|authorized_keys)/.test(fileName)) {
        throw new AppError({ code: 'invalid-input', title: 'Invalid File Name', message: 'Choose a file name such as id_ed25519_work (without .pub).' });
      }
      const comment = p.comment ? asLine(p.comment, 'Comment', { max: 200 }) : '';
      const passphrase = asString(p.passphrase ?? '', 'Passphrase', { min: 0, max: 1024, trim: false });
      if (passphrase && passphrase.length < 5) throw new AppError({ code: 'invalid-input', title: 'Passphrase Too Short', message: 'Use at least 5 characters, or leave the passphrase empty.' });
      const file = path.join(sshDirectory(), fileName);
      await generateSshKey({ type, file, comment, passphrase });
      const publicKey = fs.readFileSync(`${file}.pub`, 'utf8').trim().split(/\r?\n/)[0];
      ctx.recordOperation(null, 'Generate SSH key', 'SUCCESS', `${type} key ${file}${passphrase ? ' (passphrase protected)' : ' (no passphrase)'}`);
      return { ...h.matchResult(parsePublicKey(publicKey), file), publicKey, pubPath: `${file}.pub` };
    },

    'ssh:testConnection': async (payload) => {
      const p = asObject(payload);
      const key = localKeyFor(p.pubPath);
      if (!key.privatePath) throw new AppError({ code: 'ssh-key-missing', title: 'Private Key Missing', message: `${path.basename(key.pubPath)} has no matching private key next to it, so it cannot be tested from this computer.` });
      const passphrase = asString(p.passphrase ?? '', 'Passphrase', { min: 0, max: 1024, trim: false });
      let encrypted = false;
      try {
        encrypted = inspectSshKey(key.privatePath).encrypted;
      } catch {
        // unknown format: let ssh decide
      }
      if (encrypted && !passphrase) return { ok: false, login: null, reason: 'passphrase-needed', message: 'This key is protected by a passphrase. Type it to run the test (it is not stored).', via: null, detail: '' };
      if (encrypted && !(await verifySshPassphrase(key.privatePath, passphrase))) return { ok: false, login: null, reason: 'passphrase-wrong', message: 'Wrong passphrase for this key.', via: null, detail: '' };
      const r = await testSshConnection({ privateKey: key.privatePath, knownHosts: path.join(sshDirectory(), 'known_hosts'), host: activeSshHost(), passphrase: encrypted ? passphrase : undefined });
      ctx.recordOperation(null, 'Test SSH key', r.ok ? 'SUCCESS' : 'FAILED', `${path.basename(key.pubPath)} → ${r.ok ? r.message : r.reason}`);
      return r;
    },

    'ssh:signingConfig': async () => readSigningConfig(),

    'ssh:useForSigning': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const kind = asEnum(p.kind, 'kind', ['ssh', 'gpg'] as const);
      const signAll = p.signAll === undefined ? false : asBoolean(p.signAll, 'signAll');
      let settings: [string, string][];
      if (kind === 'ssh') {
        const key = localKeyFor(p.pubPath);
        if (!key.privatePath) throw new AppError({ code: 'ssh-key-missing', title: 'Private Key Missing', message: 'Commits can only be signed with a key whose private key is on this computer.' });
        settings = signingSettings({ kind: 'ssh', pubPath: key.pubPath, signAll });
      } else {
        const keyId = asString(p.keyId, 'key', { max: 40, pattern: /^[0-9A-Fa-f]{8,40}$/ }).toUpperCase();
        const st = await gpgStatus();
        if (!st.available) throw new AppError({ code: 'gpg-missing', title: 'GPG Not Found', message: 'Install GnuPG (Gpg4win on Windows) first.' });
        const keys = await listLocalGpgKeys();
        if (!keys.some((k) => k.keyId.toUpperCase() === keyId || k.fingerprint.toUpperCase().endsWith(keyId))) {
          throw new AppError({ code: 'gpg-key-missing', title: 'Key Not in Your Keyring', message: 'Only keys whose secret key is in your local GnuPG keyring can sign commits.' });
        }
        settings = signingSettings({ kind: 'gpg', keyId, gpgProgram: st.binary && st.binary !== 'gpg' ? st.binary : null, signAll });
      }
      const res = await writeSigningConfig(settings);
      if (kind === 'gpg') resetGpgLocation();
      ctx.recordOperation(null, 'Set commit signing key', 'SUCCESS', settings.map(([k, v]) => `${k}=${v}`).join(', '));
      return res;
    },
  };
}
