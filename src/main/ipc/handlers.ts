import { clipboard, dialog, shell, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApiMap, Channel, TokenPermissionPreset } from '../../shared/api';
import type {
  AuthInput,
  CommitPreview,
  ConflictOverview,
  DropFilePreview,
  DropFileResult,
  PrPreview,
  PushRuleReport,
  PullPreview,
  PushPreview,
  RepoRecord,
  RepoSettings,
  RepoSummary,
  SavedSshKey,
  SecurityStatus,
  SshKeyMatch,
} from '../../shared/types';
import type { AppContext } from '../context';
import { AppError, toFriendlyError } from '../git/errors';
import { EMPTY_TREE, GitService } from '../git/GitService';
import { countChanges } from '../git/parsers';
import { analyzeReport, recheckReport } from '../git/pushRuleAnalysis';
import { parsePushRejection } from '../git/pushRules';
import { parseRemoteUrl } from '../git/remoteUrl';
import { findPrivateKeyFor, inspectSshKey, parsePublicKey } from '../git/sshKeys';
import { runGit } from '../git/runner';
import { describeAuthOptions, resolveAuth, revokeWithRetry, type AuthPurpose } from '../github/authResolver';
import { apiBaseForHost, parsePrivateKey, privateKeyFingerprint, validateApiBaseUrl } from '../github/GitHubService';
import { ConfirmationError } from '../security/ConfirmationRegistry';
import { maskToken, redactSecrets } from '../util/redact';
import {
  asBoolean,
  asBranchName,
  asEnum,
  asFolderName,
  asGitHubName,
  asId,
  asInt,
  asLine,
  asNumericId,
  asObject,
  asOptionalNumericId,
  asOptionalString,
  asRemoteName,
  asString,
  asStringArray,
  isValidEmail,
  ValidationError,
} from '../util/validate';
import { asConfirmed, parseAuthInput } from './authInput';
import { createBranchHandlers, type BranchChannels } from './branchHandlers';
import { createExtraHandlers, type ExtraChannels } from './extraHandlers';
import { createHistoryHandlers, type HistoryChannels } from './historyHandlers';
import { assertRepoAccountActive, repoOwnerAccount } from '../accounts/repoAccount';
import { createGitHubHandlers, type GitHubChannels } from './githubHandlers';

type Handler<C extends Channel> = (payload: unknown) => Promise<ApiMap[C]['res']>;
export type Handlers = { [C in Channel]: Handler<C> };

interface PullReview {
  targetOid: string;
  headOid: string | null;
  upstream: string;
  branch: string;
  status: SecurityStatus;
  flagged: string[];
  /** Shown in the review; a merge then joins the two histories (--allow-unrelated-histories). */
  unrelated: boolean;
}

interface PushReview {
  headOid: string;
  branch: string;
  remote: string;
  remoteBranch: string;
  remoteUrl: string;
  setUpstream: boolean;
  commitCount: number;
  fileCount: number;
}

interface CommitReview {
  fingerprint: string;
  headOid: string | null;
  fileCount: number;
  signingAllowed: string[];
}

export function createHandlers(ctx: AppContext, getWindow: () => BrowserWindow | null, appVersion: string): Handlers {
  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  async function primaryRemote(git: GitService, upstream: string | null): Promise<{ name: string; url: string } | null> {
    const remotes = await git.remotes();
    if (remotes.length === 0) return null;
    if (upstream) {
      const byUpstream = remotes.filter((r) => upstream.startsWith(`${r.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (byUpstream) return { name: byUpstream.name, url: byUpstream.pushUrl };
    }
    const r = remotes.find((x) => x.name === 'origin') ?? remotes[0];
    return { name: r.name, url: r.pushUrl };
  }

  const authDeps = { secrets: ctx.secrets, vault: ctx.vault, githubFor: (b: string) => ctx.githubFor(b), tokens: ctx.tokens };

  /**
   * Resolves credentials for one repository operation and remembers the non-secret
   * choices the user asked to keep (GitHub App id/owner/repo/installation, SSH key path).
   */
  /**
   * Repository identity for display: normalised "host/owner/repo", the associated account
   * (explicitly chosen, or detected from the owner) and "personal" vs organisation owner.
   */
  function repoIdentity(repo: RepoRecord, parsed: ReturnType<typeof parseRemoteUrl> | null): Pick<RepoSummary, 'identity' | 'account' | 'ownerLabel'> {
    const identity = parsed?.host && parsed.owner && parsed.repo ? `${parsed.host}/${parsed.owner}/${parsed.repo}` : null;
    const account = repoOwnerAccount(ctx.accounts, repo, parsed);
    const owner = parsed?.isGitHub ? parsed.owner : null;
    const ownerLabel = owner ? (account && account.login.toLowerCase() === owner.toLowerCase() ? 'personal' : owner) : null;
    return { identity, account: account ? { id: account.id, login: account.login } : null, ownerLabel };
  }

  /** One account at a time: refuses work on a repository that belongs to another added account. */
  async function guardAccount(repo: RepoRecord, git: GitService, what: string): Promise<void> {
    const remote = await primaryRemote(git, null).catch(() => null);
    assertRepoAccountActive(ctx.accounts, repo, remote ? parseRemoteUrl(remote.url) : null, what);
  }

  /** Account context shown in auth dialogs ("Account: jahedul-hasan-kaz"). */
  function repoAccount(repo: RepoRecord, remoteUrl: string | null): { id: string; login: string } | null {
    return repoIdentity(repo, remoteUrl ? parseRemoteUrl(remoteUrl) : null).account;
  }

  async function authFor(repo: RepoRecord, remoteUrl: string, input: AuthInput, purpose: AuthPurpose) {
    const resolved = await resolveAuth(authDeps, repo, remoteUrl, input, purpose);
    const parsedRemote = parseRemoteUrl(remoteUrl);
    const account = repoAccount(repo, remoteUrl);
    if (input.method === 'pat' && account && parsedRemote.isGitHub && resolved.apiToken) {
      try {
        const owner = await ctx.githubFor(apiBaseForHost(parsedRemote.host)).getAuthenticatedUser(resolved.apiToken);
        if (owner.login.toLowerCase() !== account.login.toLowerCase()) {
          throw new AppError({
            code: 'account-mismatch',
            title: 'Token Belongs to Another Account',
            message: `This token belongs to "${owner.login}", but ${repo.name} is associated with "${account.login}". Use a token of ${account.login}, or change the repository's account in Settings.`,
            actions: ['review-auth', 'open-settings'],
          });
        }
      } catch (err) {
        await resolved.cleanup();
        throw err;
      }
    }
    const patch: Partial<RepoSettings> = {};
    if (input.method === 'ssh' && input.rememberKeyPath && resolved.sshKeyPath) patch.sshKeyPath = resolved.sshKeyPath;
    if (input.method === 'github-app' && input.tokenMode !== 'existing') {
      const saved = repo.settings.githubApp;
      const sameApp = saved && saved.appId === input.appId && saved.owner === input.owner && saved.repo === input.repo;
      if (input.rememberApp || (sameApp && !saved.installationId)) {
        patch.githubApp = { appId: input.appId, owner: input.owner, repo: input.repo, installationId: resolved.detectedInstallationId ?? input.installationId };
      }
    }
    if (Object.keys(patch).length) ctx.repos.updateSettings(repo.id, patch);
    // Every GitHub App installation token is revoked once the operation is over — record the outcome.
    if (resolved.revocation) {
      const revoke = resolved.cleanup;
      resolved.cleanup = async () => {
        await revoke();
        const ok = resolved.revocation!.revoked;
        if (ok === true) ctx.recordOperation(repo, 'Revoke installation token', 'SUCCESS', `Token used for ${purpose} revoked on GitHub`);
        else if (ok === false) {
          ctx.recordOperation(repo, 'Revoke installation token', 'FAILED', `GitHub could not be reached to revoke the token used for ${purpose}; it expires automatically within 1 hour`);
        }
      };
    }
    return resolved;
  }

  function matchResult(pub: { type: string; fingerprint: string; comment: string }, keyPath: string | null): SshKeyMatch {
    const searched = path.join(os.homedir(), '.ssh');
    if (!keyPath) return { ...pub, match: null, searched };
    const details = inspectSshKey(keyPath);
    // Only the path is kept (in memory, for this session); the key itself is read by ssh when used.
    const { handle } = ctx.vault.put('ssh-key-path', keyPath, 8 * 60 * 60_000);
    return { ...pub, match: { handle, path: keyPath, fileName: path.basename(keyPath), ...details, fingerprint: details.fingerprint ?? pub.fingerprint }, searched };
  }

  function savedSshKey(repo: RepoRecord): SavedSshKey | null {
    if (!repo.settings.sshKeyPath) return null;
    try {
      const d = inspectSshKey(repo.settings.sshKeyPath);
      return { fileName: path.basename(repo.settings.sshKeyPath), path: repo.settings.sshKeyPath, encrypted: d.encrypted, fingerprint: d.fingerprint };
    } catch {
      return null;
    }
  }

  function authStatusText(repo: RepoRecord, remoteUrl: string | null, saved: { pat: boolean; githubAppKey: boolean }): string {
    if (!remoteUrl) return 'No remote configured';
    const parsed = parseRemoteUrl(remoteUrl);
    if (parsed.protocol === 'local') return 'Local remote';
    if (parsed.protocol === 'ssh') {
      const parts = [repo.settings.sshKeyPath ? `SSH key ${path.basename(repo.settings.sshKeyPath)}` : 'SSH'];
      if (repo.settings.githubApp) parts.push('GitHub App configured');
      return parts.join(' · ');
    }
    const parts: string[] = [parsed.protocol.toUpperCase()];
    if (repo.settings.githubApp) parts.push('GitHub App configured');
    if (repo.settings.allowSavedCredentials && saved.pat) parts.push('PAT saved');
    if (repo.settings.allowSavedCredentials && saved.githubAppKey) parts.push('App key saved');
    if (parts.length === 1) parts.push('asks every time');
    return parts.join(' · ');
  }

  async function summarize(repo: RepoRecord): Promise<RepoSummary> {
    const exists = fs.existsSync(repo.path);
    let branch: string | null = null;
    let changeCount = 0;
    let hasConflicts = false;
    let remoteUrl: string | null = null;
    if (exists) {
      try {
        const git = new GitService(repo.path);
        const st = await git.status();
        branch = st.branch ?? (st.detached ? 'detached HEAD' : null);
        changeCount = countChanges([st.staged, st.unstaged, st.untracked, st.conflicted]);
        hasConflicts = st.conflicted.length > 0;
        remoteUrl = (await primaryRemote(git, st.upstream))?.url ?? null;
      } catch {
        // Folder exists but is not readable as a repository; show as-is.
      }
    }
    const savedSecrets = ctx.secrets.status(repo.id);
    const parsed = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
    return {
      ...repo,
      github: parsed?.isGitHub && parsed.owner && parsed.repo ? { owner: parsed.owner, repo: parsed.repo } : null,
      ...repoIdentity(repo, parsed),
      exists,
      branch,
      changeCount,
      hasConflicts,
      remoteUrl: remoteUrl ? redactSecrets(remoteUrl) : null,
      authStatus: authStatusText(repo, remoteUrl, savedSecrets),
      savedSecrets,
    };
  }

  async function addRepoAt(dir: string): Promise<RepoSummary> {
    const top = await GitService.findTopLevel(dir);
    if (!top) throw new AppError({ code: 'not-a-repo', title: 'Not a Git Repository', message: `${dir} is not inside a Git repository. Use "Create Repository" to initialise one.` });
    const real = fs.realpathSync.native(top);
    return summarize(ctx.repos.add(real));
  }

  async function buildCommitPreview(repo: RepoRecord, git: GitService, kind: 'commit' | 'continue'): Promise<CommitPreview> {
    const status = await git.status();
    if (kind === 'commit') {
      if (status.operation === 'rebase') {
        throw new AppError({ code: 'rebase-in-progress', title: 'Rebase in Progress', message: 'Finish the rebase from the Conflicts view instead of creating a new commit.', actions: ['resolve-conflicts'] });
      }
      if (status.conflicted.length) {
        throw new AppError({ code: 'conflict', title: 'Unresolved Conflicts', message: 'Resolve all conflicts before committing.', actions: ['resolve-conflicts'] });
      }
      if (status.staged.length === 0 && status.operation !== 'merge') {
        throw new AppError({ code: 'nothing-to-commit', title: 'Nothing to Commit', message: 'Stage at least one file before committing.' });
      }
    }
    const identity = await git.identity();
    const signingOptions = git.signingOptions(identity);
    const defaultSigning = identity.commitGpgSign && signingOptions.length > 1 ? signingOptions[1].method : 'none';
    const review: CommitReview = {
      fingerprint: await git.stagedFingerprint(),
      headOid: status.headOid,
      fileCount: status.staged.length,
      signingAllowed: signingOptions.map((o) => o.method),
    };
    const confirmationId = ctx.confirmations.create(kind, repo.id, review);
    return {
      confirmationId,
      repoName: repo.name,
      branch: status.branch,
      files: status.staged,
      identity,
      signingOptions,
      defaultSigning,
      hooksEnabled: repo.settings.runHooks,
      operation: status.operation,
      savedSshKey: savedSshKey(repo),
    };
  }

  async function verifyCommitReview(repoId: string, git: GitService, kind: 'commit' | 'continue', confirmationId: unknown, signing: string): Promise<CommitReview> {
    const review = ctx.confirmations.consume<CommitReview>(asId(confirmationId, 'confirmationId'), kind, repoId);
    const status = await git.status();
    if ((await git.stagedFingerprint()) !== review.fingerprint || status.headOid !== review.headOid) {
      throw new AppError({
        code: 'changed-since-review',
        title: 'Changes Modified Since Review',
        message: 'The staged files changed after you reviewed them. Review the commit again so you confirm exactly what will be committed.',
      });
    }
    if (!review.signingAllowed.includes(signing)) throw new ValidationError('That signing method is not available for this repository');
    return review;
  }

  function presetPermissions(preset: TokenPermissionPreset): Record<string, 'read' | 'write'> {
    switch (preset) {
      case 'contents-read':
        return { contents: 'read' };
      case 'contents-write':
        return { contents: 'write' };
      case 'pull-requests-write':
        return { pull_requests: 'write', contents: 'read' };
    }
  }

  function loadKey(p: Record<string, unknown>): { key: ReturnType<typeof parsePrivateKey>; fromHandle: string | null } {
    if (p.useSavedKey === true) {
      // The key saved (encrypted) for one repository can only be used for that repository.
      const repo = ctx.repo(p.repoId);
      if (!repo.settings.allowSavedCredentials) throw new AppError({ code: 'auth-input', title: 'Saved Key Unavailable', message: 'Saved credentials are disabled for this repository.' });
      const pem = ctx.secrets.getGitHubAppKey(repo.id);
      if (!pem) throw new AppError({ code: 'auth-input', title: 'No Saved Key', message: 'No GitHub App private key is saved for this repository.' });
      const g = repo.settings.githubApp;
      if (g && (asGitHubName(p.owner, 'Owner').toLowerCase() !== g.owner.toLowerCase() || asGitHubName(p.repo, 'Repository').toLowerCase() !== g.repo.toLowerCase())) {
        throw new AppError({ code: 'repo-mismatch', title: 'Repository Mismatch', message: 'The saved key can only generate tokens for the repository it is saved for.' });
      }
      return { key: parsePrivateKey(pem), fromHandle: null };
    }
    const handle = asOptionalString(p.keyHandle, 'keyHandle', { max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
    if (handle) {
      // Not consumed here: the token page may validate, then generate, with the same loaded key.
      const pem = ctx.vault.get(handle, 'private-key');
      if (!pem) throw new AppError({ code: 'key-expired', title: 'Private Key Expired', message: 'The loaded private key was cleared from memory. Load the .pem file again.', actions: ['review-auth'] });
      return { key: parsePrivateKey(pem), fromHandle: handle };
    }
    const pem = asString(p.privateKey, 'Private key', { max: 16_384, trim: false });
    return { key: parsePrivateKey(pem), fromHandle: null };
  }

  function apiBaseFrom(p: Record<string, unknown>): string {
    const raw = asOptionalString(p.apiBaseUrl, 'API URL', { max: 300 });
    return raw ? validateApiBaseUrl(raw) : apiBaseForHost(null);
  }

  // -------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------

  const core: Omit<Handlers, ExtraChannels | GitHubChannels | BranchChannels | HistoryChannels> = {
    'app:info': async () => {
      let gitVersion: string | null = null;
      try {
        gitVersion = (await runGit({ cwd: process.cwd(), args: ['--version'] })).stdout.trim();
      } catch {
        gitVersion = null;
      }
      return { version: appVersion, platform: process.platform, gitVersion, encryptionAvailable: ctx.secrets.encryptionAvailable() };
    },

    'dialog:pickDirectory': async (payload) => {
      const p = asObject(payload);
      const purpose = asEnum(p.purpose, 'purpose', ['open', 'create', 'clone-parent'] as const);
      const win = getWindow();
      const titles = { open: 'Open existing repository', create: 'Choose or create a project folder', 'clone-parent': 'Choose where to clone the repository' };
      const opts: Electron.OpenDialogOptions = {
        title: titles[purpose],
        properties: ['openDirectory', 'createDirectory', 'promptToCreate', 'dontAddToRecent'],
      };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || res.filePaths.length === 0) return null;
      const chosen = path.resolve(res.filePaths[0]);
      return { selectionId: ctx.registerPick(chosen, purpose), path: chosen };
    },

    // ---------------- repositories ----------------

    'repo:list': async () => Promise.all(ctx.repos.list().map(summarize)),

    'repo:summary': async (payload) => summarize(ctx.repo(asObject(payload).repoId)),

    'repo:addExisting': async (payload) => {
      const dir = ctx.consumePick(asObject(payload).selectionId, ['open']);
      const summary = await addRepoAt(dir);
      ctx.recordOperation(ctx.repos.get(summary.id) ?? null, 'Add repository', 'SUCCESS', summary.path);
      return summary;
    },

    'repo:create': async (payload) => {
      const p = asObject(payload);
      const parent = ctx.consumePick(p.selectionId, ['create', 'open']);
      const folderName = p.folderName ? asFolderName(p.folderName) : undefined;
      const initialBranch = asBranchName(p.initialBranch, 'initial branch');
      const dir = folderName ? path.join(parent, folderName) : parent;
      if (fs.existsSync(path.join(dir, '.git'))) {
        throw new AppError({ code: 'already-repo', title: 'Already a Repository', message: `${dir} already contains a Git repository. Use "Open Existing" instead.` });
      }
      await GitService.init(dir, initialBranch);
      const summary = await addRepoAt(dir);
      ctx.recordOperation(ctx.repos.get(summary.id) ?? null, 'Init', 'SUCCESS', `git init (${initialBranch}) in ${dir}`);
      return summary;
    },

    'repo:remove': async (payload) => {
      const p = asObject(payload);
      const repo = ctx.repo(p.repoId);
      let remoteMissing = false;
      // A repository with a network remote can only be removed after the user proves access to it,
      // exactly like before a push. The credential is used once for a read-only ls-remote.
      if (fs.existsSync(repo.path)) {
        const git = new GitService(repo.path);
        const st = await git.status().catch(() => null);
        const remote = st ? await primaryRemote(git, st.upstream).catch(() => null) : null;
        if (remote && parseRemoteUrl(remote.url).protocol !== 'local') {
          if (p.auth === undefined) {
            throw new AppError({ code: 'auth-required', title: 'Authentication Required', message: `Verify your credentials for ${repo.name} before removing it.`, actions: ['review-auth'] });
          }
          const resolved = await authFor(repo, remote.url, parseAuthInput(p.auth), 'fetch');
          try {
            await git.lsRemoteBranch(remote.name, st?.branch ?? 'main', resolved.git, resolved.transportUrl);
          } catch (err) {
            const friendly = toFriendlyError(err, 'Verify credentials', resolved.secrets);
            // The remote was deleted (or renamed away): there is nothing left to protect, so let the
            // repository go instead of trapping it in the app. Local files are never touched.
            if (friendly.code === 'repo-not-found') remoteMissing = true;
            else {
              ctx.recordOperation(repo, 'Remove repository', 'FAILED', `Credential check failed using ${resolved.description}`);
              throw new AppError(friendly);
            }
          } finally {
            await resolved.cleanup();
          }
        }
      }
      ctx.secrets.forget(repo.id);
      ctx.repos.remove(repo.id);
      ctx.recordOperation(null, 'Remove repository', 'SUCCESS', `${repo.name} removed from the app (files untouched)${remoteMissing ? ' — its remote no longer exists' : ''}`);
      return { remoteMissing };
    },

    'repo:setFavorite': async (payload) => {
      const p = asObject(payload);
      const repo = ctx.repo(p.repoId);
      return summarize(ctx.repos.setFavorite(repo.id, asBoolean(p.favorite, 'favorite')));
    },

    'repo:duplicate': async (payload) => {
      const p = asObject(payload);
      const repo = ctx.repo(p.repoId);
      const name = asFolderName(p.name);
      const parent = path.dirname(repo.path);
      const target = path.join(parent, name);
      if (fs.existsSync(target)) throw new AppError({ code: 'folder-exists', title: 'Folder Already Exists', message: `${target} already exists. Choose another name.` });
      const git = new GitService(repo.path);
      const st = await git.status();
      const remote = await primaryRemote(git, st.upstream);
      // Local clone: full history and branches, no network, no hooks, independent object store.
      await runGit({ cwd: parent, args: ['clone', '--no-hardlinks', '--no-recurse-submodules', '--', repo.path, name], timeoutMs: 10 * 60_000 });
      if (remote) await runGit({ cwd: target, args: ['remote', 'set-url', '--', 'origin', remote.url] });
      else await runGit({ cwd: target, args: ['remote', 'remove', 'origin'] });
      const summary = await addRepoAt(target);
      if (repo.settings.accountId) ctx.repos.updateSettings(summary.id, { accountId: repo.settings.accountId });
      ctx.recordOperation(ctx.repos.get(summary.id) ?? null, 'Duplicate repository', 'SUCCESS', `${repo.name} → ${target}`);
      return summarize(ctx.repo(summary.id));
    },

    'repo:contributors': async (payload) => ctx.git(asObject(payload).repoId).git.contributors(),

    'repo:updateSettings': async (payload) => {
      const p = asObject(payload);
      const repo = ctx.repo(p.repoId);
      const s = asObject(p.settings, 'settings');
      const patch: Partial<RepoSettings> = {};
      if (s.runHooks !== undefined) patch.runHooks = asBoolean(s.runHooks, 'runHooks');
      if (s.allowSystemCredentials !== undefined) patch.allowSystemCredentials = asBoolean(s.allowSystemCredentials, 'allowSystemCredentials');
      if (s.allowSavedCredentials !== undefined) patch.allowSavedCredentials = asBoolean(s.allowSavedCredentials, 'allowSavedCredentials');
      if (s.patUsername !== undefined) patch.patUsername = s.patUsername ? asLine(s.patUsername, 'username', { max: 100 }) : undefined;
      if (s.sshKeyPath !== undefined) {
        // Key paths only ever come from the native file dialog; the UI may only clear them.
        if (s.sshKeyPath !== null) throw new ValidationError('The SSH key can only be chosen with the file dialog');
        patch.sshKeyPath = undefined;
      }
      if (s.apiBaseUrl !== undefined) patch.apiBaseUrl = s.apiBaseUrl ? validateApiBaseUrl(asLine(s.apiBaseUrl, 'API URL', { max: 300 })) : undefined;
      if (s.githubApp !== undefined) {
        if (s.githubApp === null) patch.githubApp = undefined;
        else {
          const g = asObject(s.githubApp, 'githubApp');
          patch.githubApp = {
            appId: asNumericId(g.appId, 'App ID'),
            owner: asGitHubName(g.owner, 'Owner'),
            repo: asGitHubName(g.repo, 'Repository'),
            installationId: asOptionalNumericId(g.installationId, 'Installation ID'),
          };
        }
      }
      const updated = ctx.repos.updateSettings(repo.id, patch);
      if (patch.allowSavedCredentials === false) ctx.secrets.forget(repo.id);
      return summarize(updated);
    },

    'repo:forgetSecrets': async (payload) => {
      const p = asObject(payload);
      const repo = ctx.repo(p.repoId);
      const kind = p.kind === undefined ? undefined : asEnum(p.kind, 'kind', ['pat', 'githubAppKey'] as const);
      ctx.secrets.forget(repo.id, kind);
      ctx.recordOperation(repo, 'Forget credentials', 'SUCCESS', kind ? `Removed saved ${kind}` : 'Removed all saved credentials');
      return summarize(repo);
    },

    'repo:authOptions': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const purpose = asEnum(p.purpose, 'purpose', ['push', 'fetch', 'pr'] as const);
      const st = await git.status();
      const remote = await primaryRemote(git, st.upstream);
      const saved = ctx.secrets.status(repo.id);
      return {
        authOptions: describeAuthOptions(repo, remote?.url ?? null, purpose, saved),
        remoteUrl: remote ? redactSecrets(remote.url) : null,
        githubApp: repo.settings.githubApp,
        savedSshKey: savedSshKey(repo),
        account: repoAccount(repo, remote?.url ?? null),
      };
    },

    'repo:cloneAuthOptions': async (payload) => {
      const url = asLine(asObject(payload).url, 'Remote URL', { max: 2048 });
      const placeholder: RepoRecord = { id: 'pending-clone', name: '', path: '', addedAt: '', settings: { runHooks: false, allowSystemCredentials: true, allowSavedCredentials: false } };
      return describeAuthOptions(placeholder, url, 'clone', { pat: false, githubAppKey: false });
    },

    // ---------------- status, staging, diffs ----------------

    'git:status': async (payload) => ctx.git(asObject(payload).repoId).git.status(),

    'git:diffFile': async (payload) => {
      const p = asObject(payload);
      const { git } = ctx.git(p.repoId);
      const area = asEnum(p.area, 'area', ['staged', 'unstaged', 'untracked', 'conflicted'] as const);
      return git.diffFile(asString(p.path, 'path', { trim: false }), area);
    },

    'git:stage': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      await ctx.withLock(repo.id, () => git.stage(asStringArray(p.paths, 'paths')));
    },

    'git:applySelection': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const action = asEnum(p.action, 'action', ['stage', 'unstage', 'discard'] as const);
      if (action === 'discard') asConfirmed(p.confirmed);
      if (!Array.isArray(p.selection) || p.selection.length === 0 || p.selection.length > 2000) throw new ValidationError('Invalid selection');
      const selection = p.selection.map((x) => {
        const o = asObject(x, 'selection');
        return { hunk: asInt(o.hunk, 'hunk', 0, 100_000), lines: o.lines === undefined ? undefined : (Array.isArray(o.lines) ? o.lines : []).slice(0, 200_000).map((n) => asInt(n, 'line', 0, 10_000_000)) };
      });
      const file = asString(p.path, 'path', { trim: false });
      const backupFile = action === 'discard' ? path.join(ctx.backupRoot, repo.id, `${new Date().toISOString().replace(/[:.]/g, '-')}-partial.patch`) : null;
      const r = await ctx.withLock(repo.id, () => git.applySelection(file, action, selection, backupFile ?? undefined));
      if (action === 'discard') ctx.recordOperation(repo, 'Discard lines', 'SUCCESS', `${r.lines} line(s) of ${file}; patch saved to ${backupFile}`);
      return { lines: r.lines, backupFile };
    },
    'git:transplantPreview': async (payload) => {
      const p = asObject(payload);
      const ref = (v: unknown, n: string) => asString(v, n, { max: 255 });
      return ctx.git(p.repoId).git.transplantPreview(ref(p.source, 'source'), ref(p.base, 'base'), ref(p.target, 'target'));
    },
    'git:transplant': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const into = asEnum(p.into, 'into', ['new-branch', 'target'] as const);
      const r = await ctx.withLock(repo.id, () =>
        git.transplant({
          target: asString(p.target, 'target', { max: 255 }),
          commits: asStringArray(p.commits, 'commits', 500),
          into,
          newBranch: p.newBranch === undefined ? undefined : asString(p.newBranch, 'branch', { max: 200 }),
          expectedTarget: asString(p.expectedTarget, 'target commit', { max: 64 }),
          returnToCurrent: p.returnToCurrent === true,
        }),
      );
      ctx.recordOperation(repo, 'Transplant commits', r.outcome === 'done' ? 'SUCCESS' : 'WARNING', `${r.applied} commit(s) → ${r.branch}${r.backupRef ? ` · backup ${r.backupRef}` : ''}`);
      return r;
    },
    'git:transplantPick': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      if (!Array.isArray(p.selection) || p.selection.length === 0 || p.selection.length > 5000) throw new ValidationError('Invalid selection');
      const selection = p.selection.map((x) => {
        const o = asObject(x, 'selection');
        return {
          path: asString(o.path, 'path', { max: 4096, trim: false }),
          oldPath: o.oldPath === undefined ? undefined : asString(o.oldPath, 'path', { max: 4096, trim: false }),
          hunks:
            o.hunks === undefined
              ? undefined
              : (Array.isArray(o.hunks) ? o.hunks : []).slice(0, 10_000).map((h) => {
                  const hh = asObject(h, 'hunk');
                  return { hunk: asInt(hh.hunk, 'hunk', 0, 100_000), lines: hh.lines === undefined ? undefined : (Array.isArray(hh.lines) ? hh.lines : []).slice(0, 200_000).map((n) => asInt(n, 'line', 0, 10_000_000)) };
                }),
        };
      });
      const r = await ctx.withLock(repo.id, () =>
        git.transplantPick({
          source: asString(p.source, 'source', { max: 255 }),
          base: asString(p.base, 'base', { max: 255 }),
          target: asString(p.target, 'target', { max: 255 }),
          into: asEnum(p.into, 'into', ['new-branch', 'target'] as const),
          newBranch: p.newBranch === undefined ? undefined : asString(p.newBranch, 'branch', { max: 200 }),
          expectedTarget: asString(p.expectedTarget, 'target commit', { max: 64 }),
          returnToCurrent: p.returnToCurrent === true,
          message: asString(p.message, 'message', { max: 5000 }),
          selection,
        }),
      );
      ctx.recordOperation(repo, 'Pick changes', r.outcome === 'done' ? 'SUCCESS' : 'WARNING', `${selection.length} file(s) → ${r.branch}${r.backupRef ? ` · backup ${r.backupRef}` : ''}`);
      return r;
    },
    'git:changeStats': async (payload) => ctx.git(asObject(payload).repoId).git.changeStats(),

    'git:stageAll': async (payload) => {
      const { repo, git } = ctx.git(asObject(payload).repoId);
      await ctx.withLock(repo.id, () => git.stageAll());
    },

    'git:unstage': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      await ctx.withLock(repo.id, () => git.unstage(asStringArray(p.paths, 'paths')));
    },

    'git:unstageAll': async (payload) => {
      const { repo, git } = ctx.git(asObject(payload).repoId);
      await ctx.withLock(repo.id, () => git.unstageAll());
    },

    'git:discard': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const paths = asStringArray(p.paths, 'paths');
      if (paths.length === 0) throw new ValidationError('No files selected');
      const backupDir = path.join(ctx.backupRoot, repo.id, new Date().toISOString().replace(/[:.]/g, '-'));
      const res = await ctx.withLock(repo.id, () => git.discard(paths, backupDir));
      ctx.recordOperation(repo, 'Discard changes', 'SUCCESS', `${paths.length} file(s) discarded; ${res.backedUp} backed up`);
      return { backedUp: res.backedUp, backupDir };
    },

    // ---------------- identity & remotes ----------------

    'git:identity': async (payload) => ctx.git(asObject(payload).repoId).git.identity(),

    'git:setIdentity': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const name = asLine(p.name, 'Name', { max: 200 });
      const email = asLine(p.email, 'Email', { max: 254 });
      if (!isValidEmail(email)) throw new ValidationError('Enter a valid email address');
      await git.setIdentity(name, email);
      ctx.recordOperation(repo, 'Configure identity', 'SUCCESS', `user.name / user.email set for this repository`);
      return git.identity();
    },

    'git:remotes': async (payload) => {
      const remotes = await ctx.git(asObject(payload).repoId).git.remotes();
      return remotes.map((r) => ({ ...r, fetchUrl: redactSecrets(r.fetchUrl), pushUrl: redactSecrets(r.pushUrl) }));
    },

    'git:setRemote': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const name = asRemoteName(p.name);
      const url = asLine(p.url, 'Remote URL', { max: 2048 });
      await git.setRemote(name, url);
      ctx.recordOperation(repo, 'Configure remote', 'SUCCESS', `${name} → ${redactSecrets(url)}`);
      return (await git.remotes()).map((r) => ({ ...r, fetchUrl: redactSecrets(r.fetchUrl), pushUrl: redactSecrets(r.pushUrl) }));
    },

    'git:removeRemote': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const name = asRemoteName(p.name);
      await git.removeRemote(name);
      ctx.recordOperation(repo, 'Remove remote', 'SUCCESS', name);
      return (await git.remotes()).map((r) => ({ ...r, fetchUrl: redactSecrets(r.fetchUrl), pushUrl: redactSecrets(r.pushUrl) }));
    },

    // ---------------- branches, log, stash ----------------

    'git:branches': async (payload) => ctx.git(asObject(payload).repoId).git.branches(),
    'git:branchOrigins': async (payload) => ctx.git(asObject(payload).repoId).git.branchOrigins(),

    'git:renameBranch': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const name = asBranchName(p.name);
      const newName = asBranchName(p.newName, 'new name');
      await ctx.withLock(repo.id, () => git.renameBranch(name, newName));
      ctx.recordOperation(repo, 'Rename branch', 'SUCCESS', `${name} → ${newName}`);
    },
    'git:createBranch': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const name = asBranchName(p.name);
      const startPoint = p.startPoint ? asBranchName(p.startPoint, 'start point') : null;
      const switchTo = asBoolean(p.switchTo, 'switchTo');
      await ctx.withLock(repo.id, () => git.createBranch(name, startPoint, switchTo));
      ctx.recordOperation(repo, 'Create branch', 'SUCCESS', `${name}${startPoint ? ` from ${startPoint}` : ''}`);
    },

    'git:switchBranch': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const name = asBranchName(p.name);
      await ctx.withLock(repo.id, () => git.switchBranch(name));
      ctx.recordOperation(repo, 'Switch branch', 'SUCCESS', name);
    },

    'git:deleteBranch': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const name = asBranchName(p.name);
      const force = asBoolean(p.force, 'force');
      await ctx.withLock(repo.id, () => git.deleteBranch(name, force));
      ctx.recordOperation(repo, force ? 'Force delete branch' : 'Delete branch', 'SUCCESS', name);
    },

    'git:log': async (payload) => {
      const p = asObject(payload);
      const limit = p.limit === undefined ? 200 : asInt(p.limit, 'limit', 1, 2000);
      return ctx.git(p.repoId).git.log({ limit });
    },

    'git:stashList': async (payload) => ctx.git(asObject(payload).repoId).git.stashList(),

    'git:stashPush': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const message = p.message ? asLine(p.message, 'message', { max: 200 }) : '';
      await ctx.withLock(repo.id, () => git.stashPush(message, asBoolean(p.includeUntracked, 'includeUntracked')));
      ctx.recordOperation(repo, 'Stash', 'SUCCESS', message || 'Changes stashed');
    },

    'git:stashApply': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const index = asInt(p.index, 'index', 0, 10_000);
      const pop = asBoolean(p.pop, 'pop');
      await ctx.withLock(repo.id, () => git.stashApply(index, pop));
      ctx.recordOperation(repo, pop ? 'Stash pop' : 'Stash apply', 'SUCCESS', `stash@{${index}}`);
    },

    'git:stashDrop': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const index = asInt(p.index, 'index', 0, 10_000);
      await ctx.withLock(repo.id, () => git.stashDrop(index));
      ctx.recordOperation(repo, 'Stash drop', 'SUCCESS', `stash@{${index}}`);
    },

    'git:fetch': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const auth = parseAuthInput(p.auth);
      const st = await git.status();
      const remote = await primaryRemote(git, st.upstream);
      if (!remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'Add a remote in Repository Settings first.', actions: ['open-settings'] });
      const resolved = await authFor(repo, remote.url, auth, 'fetch');
      try {
        await ctx.withLock(repo.id, () => git.fetch(remote.name, resolved.git, resolved.transportUrl));
        ctx.recordOperation(repo, 'Fetch', 'SUCCESS', `${remote.name} using ${resolved.description}`);
      } catch (err) {
        ctx.recordOperation(repo, 'Fetch', 'FAILED', `${remote.name} using ${resolved.description}`);
        throw err;
      } finally {
        await resolved.cleanup();
      }
      return { remote: remote.name };
    },

    // ---------------- commit ----------------

    'commit:prepare': async (payload) => {
      const { repo, git } = ctx.git(asObject(payload).repoId);
      await guardAccount(repo, git, 'commit');
      return buildCommitPreview(repo, git, 'commit');
    },

    'commit:execute': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const message = asString(p.message, 'Commit message', { max: 20_000 });
      const signing = asEnum(p.signing, 'signing', ['none', 'gpg', 'ssh', 'x509'] as const);
      await guardAccount(repo, git, 'commit');
      return ctx.withLock(repo.id, async () => {
        const review = await verifyCommitReview(repo.id, git, 'commit', p.confirmationId, signing);
        const identity = await git.identity();
        if (!identity.name || !identity.email) {
          throw new AppError({ code: 'identity-missing', title: 'Git Identity Not Configured', message: 'Set your name and email before committing.', actions: ['set-identity'] });
        }
        try {
          const commit = await git.commit(message, signing);
          ctx.recordOperation(repo, 'Commit', 'SUCCESS', `${commit.shortHash} "${commit.subject}" (${review.fileCount} file(s), ${signing === 'none' ? 'unsigned' : `${signing} signed`})`);
          return commit;
        } catch (err) {
          ctx.recordOperation(repo, 'Commit', 'FAILED', `${review.fileCount} file(s)`);
          throw err;
        }
      });
    },

    // ---------------- push ----------------

    'push:prepare': async (payload) => {
      const { repo, git } = ctx.git(asObject(payload).repoId);
      await guardAccount(repo, git, 'push');
      const st = await git.status();
      if (st.detached || !st.branch) throw new AppError({ code: 'detached', title: 'Not on a Branch', message: 'Switch to a branch before pushing.' });
      if (st.operation) throw new AppError({ code: 'operation-in-progress', title: `${st.operation} in progress`, message: 'Finish or abort the current operation before pushing.', actions: ['resolve-conflicts'] });
      if (!st.headOid) throw new AppError({ code: 'no-commits', title: 'No Commits Yet', message: 'Create a commit before pushing.' });
      const remote = await primaryRemote(git, st.upstream);
      if (!remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'Add a remote in Repository Settings before pushing.', actions: ['open-settings'] });

      // Like push.default=simple: push to the tracked branch only when it has the same name, so a
      // branch started from origin/main never updates main by accident (unless push.default=upstream).
      let remoteBranch = st.branch;
      let tracksOther = false;
      if (st.upstream) {
        const merge = await git.getConfig(`branch.${st.branch}.merge`);
        const tracked = merge?.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : null;
        if (tracked && tracked !== st.branch) {
          if ((await git.getConfig('push.default')) === 'upstream') remoteBranch = tracked;
          else tracksOther = true;
        }
      }
      const remoteRef = `${remote.name}/${remoteBranch}`;
      let remoteOid: string | null = null;
      try {
        remoteOid = await git.revParse(`refs/remotes/${remoteRef}`);
      } catch {
        remoteOid = null;
      }
      const isNew = !remoteOid;
      let commits;
      let files;
      if (remoteOid) {
        commits = await git.log({ range: `${remoteOid}..${st.headOid}`, limit: 500 });
        files = await git.nameStatus(remoteOid, st.headOid);
      } else {
        commits = await git.commitsNotOnRemote(st.headOid, remote.name, 500);
        const oldest = commits[commits.length - 1];
        const base = (oldest && (await git.parentOf(oldest.hash))) ?? EMPTY_TREE;
        files = commits.length ? await git.nameStatus(base, st.headOid) : [];
      }
      // Push only sends commits; uncommitted edits are a very common source of "my change wasn't pushed".
      const uncommitted = [...new Set([...st.staged, ...st.unstaged, ...st.untracked].map((f) => f.path))];
      if (remoteOid && commits.length === 0) {
        throw new AppError({
          code: 'nothing-to-push',
          title: 'Nothing to Push',
          message: uncommitted.length
            ? `${st.branch} has no new commits — it is already up to date with ${remoteRef}. You have ${uncommitted.length} uncommitted change(s) (${uncommitted.slice(0, 3).join(', ')}${uncommitted.length > 3 ? ', …' : ''}). Push only sends commits: stage and commit these changes first, then push.`
            : st.behind > 0
              ? `${st.branch} has no new commits to send, and ${remoteRef} has ${st.behind} newer commit(s). Pull to bring them in.`
              : `${st.branch} is already up to date with ${remoteRef}. There is nothing new to send.`,
          reasons: [],
          actions: st.behind > 0 && !uncommitted.length ? ['pull'] : [],
        });
      }
      const review: PushReview = {
        headOid: st.headOid,
        branch: st.branch,
        remote: remote.name,
        remoteBranch,
        remoteUrl: remote.url,
        setUpstream: !st.upstream || tracksOther,
        commitCount: commits.length,
        fileCount: files.length,
      };
      const confirmationId = ctx.confirmations.create('push', repo.id, review);
      const preview: PushPreview = {
        confirmationId,
        repoName: repo.name,
        branch: st.branch,
        remote: remote.name,
        remoteUrl: redactSecrets(remote.url),
        remoteBranch,
        headOid: st.headOid,
        commits,
        files,
        isNewRemoteBranch: isNew,
        uncommittedFiles: uncommitted,
        authOptions: describeAuthOptions(repo, remote.url, 'push', ctx.secrets.status(repo.id)),
        githubApp: repo.settings.githubApp,
        savedSshKey: savedSshKey(repo),
        account: repoAccount(repo, remote.url),
        hooksEnabled: repo.settings.runHooks,
      };
      return preview;
    },

    'push:execute': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const auth = parseAuthInput(p.auth);
      await guardAccount(repo, git, 'push');
      return ctx.withLock(repo.id, async () => {
        const review = ctx.confirmations.consume<PushReview>(asId(p.confirmationId, 'confirmationId'), 'push', repo.id);
        const st = await git.status();
        if (st.headOid !== review.headOid || st.branch !== review.branch) {
          throw new AppError({ code: 'changed-since-review', title: 'Branch Changed Since Review', message: 'New commits were made or the branch changed after you reviewed the push. Review it again.' });
        }
        const resolved = await authFor(repo, review.remoteUrl, auth, 'push');
        try {
          const out = await git.push(review.remote, review.headOid, review.remoteBranch, resolved.git, { setUpstreamFor: review.setUpstream ? review.branch : undefined, transportUrl: resolved.transportUrl });
          const summary = `${review.branch} → ${review.remote}/${review.remoteBranch} (${review.commitCount} commit(s), ${review.fileCount} file(s)) using ${resolved.description}`;
          ctx.recordOperation(repo, 'Push', 'SUCCESS', summary);
          const result = { summary: redactSecrets(out, resolved.secrets) || summary, authDescription: resolved.description };
          // Revoke now (not only in finally) so the result can tell the user whether it worked.
          await resolved.cleanup();
          resolved.cleanup = async () => {};
          return { ...result, tokenRevoked: resolved.revocation ? resolved.revocation.revoked : null };
        } catch (err) {
          ctx.recordOperation(repo, 'Push', 'FAILED', `${review.branch} → ${review.remote}/${review.remoteBranch} using ${resolved.description}`);
          // Rejected by repository rules / protection: explain exactly what blocked it and how to fix it.
          const f = toFriendlyError(err, 'Push', resolved.secrets);
          const parsed = parsePushRejection(f.technical ?? '');
          if (parsed) {
            const report = await analyzeReport(git, parsed, {
              branch: review.branch,
              remote: review.remote,
              remoteBranch: review.remoteBranch,
              head: review.headOid,
              canRewrite: !(await git.operationInProgress()),
            }).catch(() => ({ ...parsed, branch: review.branch, remote: review.remote, remoteBranch: review.remoteBranch }));
            ctx.recordOperation(repo, 'Push blocked by rules', 'FAILED', report.violations.map((v) => v.title).join('; '));
            throw new AppError({
              ...f,
              code: 'push-rules',
              title: 'Push Blocked by Repository Rules',
              message: `GitHub refused the push to ${review.remoteBranch}: ${report.violations.length} rule(s) were not met. Nothing was changed on GitHub.`,
              reasons: [],
              actions: [],
              pushRules: report,
            });
          }
          throw err;
        } finally {
          await resolved.cleanup();
        }
      });
    },

    'push:dropFilePreview': async (payload) => {
      const p = asObject(payload);
      const { git } = ctx.git(p.repoId);
      const file = asString(p.path, 'path', { trim: false, max: 4096 });
      const st = await git.status();
      if (!st.branch || !st.headOid) throw new AppError({ code: 'detached', title: 'Not on a Branch', message: 'Switch to the branch you were pushing.' });
      const remote = await primaryRemote(git, st.upstream);
      if (!remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'There is no remote.' });
      const commits = await git.unpushedCommits(st.headOid, remote.name);
      const touching: DropFilePreview['commits'] = [];
      const emptied: string[] = [];
      let signed = 0;
      for (const c of commits) {
        const parentEntry = c.parents[0] ? await git.treeEntry(c.parents[0], file) : null;
        const entry = await git.treeEntry(c.hash, file);
        if ((parentEntry?.blob ?? null) === (entry?.blob ?? null)) continue;
        const meta = await git.commitMeta(c.hash);
        if (meta.signed) signed++;
        touching.push({ hash: c.hash, shortHash: c.hash.slice(0, 8), subject: meta.subject, change: !parentEntry ? 'added' : !entry ? 'deleted' : 'modified' });
        const files = c.parents[0] ? await git.nameStatus(c.parents[0], c.hash) : [];
        if (c.parents.length <= 1 && files.length === 1 && files[0].path === file) emptied.push(c.hash);
      }
      const base = commits.length && commits[0].parents[0] ? await git.treeEntry(commits[0].parents[0], file) : null;
      let workingCopyExists = true;
      try {
        fs.accessSync(path.join(git.root, file));
      } catch {
        workingCopyExists = false;
      }
      const preview: DropFilePreview = { path: file, commits: touching, emptied, totalUnpushed: commits.length, restoredTo: base ? 'remote-version' : 'absent', workingCopyExists, signedCommits: signed };
      return preview;
    },

    'push:dropFile': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const file = asString(p.path, 'path', { trim: false, max: 4096 });
      return ctx.withLock(repo.id, async (): Promise<DropFileResult> => {
        const st = await git.status();
        if (st.operation || st.conflicted.length) throw new AppError({ code: 'operation-in-progress', title: 'Operation in Progress', message: 'Finish or abort the current merge/rebase first.' });
        if (!st.branch || !st.headOid) throw new AppError({ code: 'detached', title: 'Not on a Branch', message: 'Switch to the branch you were pushing.' });
        const remote = await primaryRemote(git, st.upstream);
        if (!remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'There is no remote.' });
        const commits = await git.unpushedCommits(st.headOid, remote.name);
        if (!commits.length) throw new AppError({ code: 'nothing-to-push', title: 'No Unpushed Commits', message: 'There are no unpushed commits to change.' });
        const r = await git.dropPathFromCommits(file, st.branch, commits);
        ctx.recordOperation(repo, 'Remove file from unpushed commits', 'SUCCESS', `${file}: ${r.rewritten} commit(s) recreated, ${r.dropped} empty commit(s) dropped; backup ${r.backupRef}`);
        return { path: file, ...r };
      });
    },

    'push:undoDropFile': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const file = asString(p.path, 'path', { trim: false, max: 4096 });
      const backupRef = asString(p.backupRef, 'backup', { max: 300 });
      await ctx.withLock(repo.id, async () => {
        const st = await git.status();
        if (!st.branch) throw new AppError({ code: 'detached', title: 'Not on a Branch', message: 'Switch to the branch first.' });
        await git.restoreBackup(st.branch, backupRef, file);
      });
      ctx.recordOperation(repo, 'Undo remove file from commits', 'SUCCESS', `${file}: original commits restored`);
    },

    'push:recheck': async (payload) => {
      const p = asObject(payload);
      const { git } = ctx.git(p.repoId);
      const report = asObject(p.report, 'report') as unknown as PushRuleReport;
      if (!Array.isArray(report.violations) || typeof report.remote !== 'string') throw new ValidationError('Invalid report');
      const st = await git.status();
      if (!st.headOid) throw new AppError({ code: 'no-commits', title: 'No Commits', message: 'Nothing to check.' });
      return recheckReport(git, report, st.headOid);
    },

    // ---------------- pull with security review ----------------

    'pull:prepare': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      await guardAccount(repo, git, 'pull');
      const auth = parseAuthInput(p.auth);
      let st = await git.status();
      if (st.detached || !st.branch) throw new AppError({ code: 'detached', title: 'Not on a Branch', message: 'Switch to a branch before pulling.' });
      const branch = st.branch;
      if (st.operation || st.conflicted.length) throw new AppError({ code: 'operation-in-progress', title: 'Operation in Progress', message: 'Finish or abort the current merge/rebase first.', actions: ['resolve-conflicts'] });
      const remote = await primaryRemote(git, st.upstream);
      if (!remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'Add a remote in Repository Settings first.', actions: ['open-settings'] });

      // 1. Fetch (does not touch your files).
      const resolved = await authFor(repo, remote.url, auth, 'fetch');
      try {
        await ctx.withLock(repo.id, () => git.fetch(remote.name, resolved.git, resolved.transportUrl));
      } finally {
        await resolved.cleanup();
      }
      st = await git.status();
      let upstream = st.upstreamGone ? null : st.upstream;
      if (!upstream) {
        const candidate = st.upstream ?? `${remote.name}/${branch}`;
        try {
          await git.revParse(`refs/remotes/${candidate}`);
          upstream = candidate;
        } catch {
          throw new AppError({
            code: 'no-upstream',
            title: 'No Remote Branch',
            message: st.upstreamGone
              ? `${candidate} does not exist on the remote${st.headOid ? '' : ' yet'} — the repository may be empty, or the branch was deleted there. Push (publish) ${branch} to create it.`
              : `There is no ${candidate} branch to pull from. Push this branch first.`,
          });
        }
      }
      // 2. Pin the exact commit that was fetched; only this commit can be integrated later.
      const targetOid = await git.revParse(`refs/remotes/${upstream}`);
      const hasHead = !!st.headOid;
      const upToDate = hasHead ? await git.isAncestor(targetOid, st.headOid!) : false;
      const commits = upToDate ? [] : await git.log({ range: hasHead ? `${st.headOid}..${targetOid}` : targetOid, limit: 500 });
      // 3. Inspect and scan incoming changes.
      const scan = upToDate ? { files: [], report: ctx.scanner.generateSecurityReport([], 0) } : await ctx.scanner.scanIncomingChanges(git, targetOid);
      const canFastForward = !hasHead || (await git.isAncestor(st.headOid!, targetOid));
      const unrelated = hasHead && !upToDate && !canFastForward && !(await git.mergeBase(st.headOid!, targetOid));
      const review: PullReview = { targetOid, headOid: st.headOid, upstream, branch, status: scan.report.status, flagged: scan.report.flaggedFiles, unrelated };
      const reviewId = ctx.confirmations.create('pull', repo.id, review);
      ctx.recordOperation(repo, 'Fetch for pull', scan.report.status === 'NO_ISSUES_DETECTED' ? 'SUCCESS' : 'WARNING', `${commits.length} incoming commit(s); security: ${scan.report.status}`);
      const preview: PullPreview = {
        reviewId,
        repoName: repo.name,
        branch,
        upstream,
        targetOid,
        commits,
        files: scan.files,
        report: scan.report,
        localChangeCount: countChanges([st.staged, st.unstaged, st.untracked]),
        canFastForward,
        upToDate,
        unrelated,
      };
      return preview;
    },

    'pull:execute': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const strategy = asEnum(p.strategy, 'strategy', ['ff-only', 'merge', 'rebase'] as const);
      const acknowledged = asBoolean(p.acknowledgedRisk, 'acknowledgedRisk');
      return ctx.withLock(repo.id, async () => {
        const review = ctx.confirmations.consume<PullReview>(asId(p.reviewId, 'reviewId'), 'pull', repo.id);
        if (review.status !== 'NO_ISSUES_DETECTED' && !acknowledged) {
          throw new AppError({ code: 'not-acknowledged', title: 'Confirmation Required', message: 'You must confirm that you reviewed the flagged changes before pulling.' });
        }
        const st = await git.status();
        if (st.headOid !== review.headOid || st.branch !== review.branch) {
          throw new AppError({ code: 'changed-since-review', title: 'Branch Changed Since Review', message: 'Your branch changed after the security review. Run the review again.' });
        }
        const status = review.status === 'NO_ISSUES_DETECTED' ? 'SUCCESS' : 'WARNING';
        const short = review.targetOid.slice(0, 8);
        if (review.headOid && (await git.isAncestor(review.targetOid, review.headOid))) {
          ctx.recordOperation(repo, 'Pull', 'SUCCESS', 'Already up to date');
          return { outcome: 'up-to-date', message: 'Already up to date.' };
        }
        try {
          if (strategy === 'ff-only' || !review.headOid) {
            await git.mergeFastForwardOnly(review.targetOid);
            ctx.recordOperation(repo, 'Pull', status, `Fast-forwarded to ${review.upstream} (${short}); security: ${review.status}`);
            return { outcome: 'fast-forward', message: `Fast-forwarded ${review.branch} to ${review.upstream} (${short}).` };
          }
          if (strategy === 'merge') {
            const conflicts = await git.merge(review.targetOid, { message: `Merge ${review.upstream} into ${review.branch}`, allowUnrelated: review.unrelated });
            if (conflicts) {
              ctx.recordOperation(repo, 'Pull', 'WARNING', `Merge of ${review.upstream} stopped with conflicts`);
              return { outcome: 'conflicts', message: 'The merge stopped because of conflicts. Resolve them to continue, or abort.' };
            }
            ctx.recordOperation(repo, 'Pull', status, `Merged ${review.upstream} (${short}); security: ${review.status}`);
            return { outcome: 'merged', message: `Merged ${review.upstream} (${short}) into ${review.branch}.` };
          }
          const conflicts = await git.rebase(review.targetOid);
          if (conflicts) {
            ctx.recordOperation(repo, 'Pull', 'WARNING', `Rebase onto ${review.upstream} stopped with conflicts`);
            return { outcome: 'conflicts', message: 'The rebase stopped because of conflicts. Resolve them to continue, or abort.' };
          }
          ctx.recordOperation(repo, 'Pull', status, `Rebased onto ${review.upstream} (${short}); security: ${review.status}`);
          return { outcome: 'rebased', message: `Rebased ${review.branch} onto ${review.upstream} (${short}).` };
        } catch (err) {
          ctx.recordOperation(repo, 'Pull', 'FAILED', `${strategy} with ${review.upstream}`);
          throw err;
        }
      });
    },

    'pull:cancel': async (payload) => {
      const p = asObject(payload);
      const repo = ctx.repo(p.repoId);
      try {
        ctx.confirmations.consume(asId(p.reviewId, 'reviewId'), 'pull', repo.id);
      } catch {
        // already expired; still record the cancellation
      }
      ctx.recordOperation(repo, 'Pull', 'CANCELLED', 'Pull cancelled after security review');
    },

    // ---------------- conflicts ----------------

    'conflict:get': async (payload) => {
      const p = asObject(payload);
      return ctx.git(p.repoId).git.conflictFile(asString(p.path, 'path', { trim: false }));
    },

    'conflict:write': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const content = asString(p.content, 'content', { min: 0, max: 20 * 1024 * 1024, trim: false });
      const file = asString(p.path, 'path', { trim: false });
      await ctx.withLock(repo.id, async () => {
        await git.snapshotConflict(file);
        await git.writeResolution(file, content);
      });
    },

    'conflict:takeSide': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const side = asEnum(p.side, 'side', ['ours', 'theirs'] as const);
      const file = asString(p.path, 'path', { trim: false });
      await ctx.withLock(repo.id, async () => {
        await git.snapshotConflict(file);
        await git.takeSide(file, side);
      });
    },

    'conflict:markResolved': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const file = asString(p.path, 'path', { trim: false });
      await ctx.withLock(repo.id, async () => {
        await git.snapshotConflict(file);
        await git.markResolved(file);
      });
    },

    'conflict:overview': async (payload) => {
      const { git } = ctx.git(asObject(payload).repoId);
      const [sides, st, snaps] = await Promise.all([git.conflictSides(), git.status(), git.readConflictSnapshots()]);
      const files: ConflictOverview['files'] = [];
      for (const c of st.conflicted) {
        const snap = snaps[c.path];
        const f = await git.conflictFile(c.path).catch(() => null);
        files.push({ path: c.path, state: 'conflicted', conflictCode: c.conflictCode ?? null, changed: snap ? await git.conflictChanged(c.path, snap) : false, hasMarkers: !!f?.hasMarkers, canUndo: !!snap });
      }
      // Files resolved in this session (snapshot exists, no longer unmerged).
      const unmerged = new Set(st.conflicted.map((c) => c.path));
      for (const p2 of Object.keys(snaps).sort()) {
        if (!unmerged.has(p2)) files.push({ path: p2, state: 'resolved', conflictCode: null, changed: true, hasMarkers: false, canUndo: true });
      }
      return { ...sides, files };
    },

    'conflict:takeSideAll': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const side = asEnum(p.side, 'side', ['ours', 'theirs'] as const);
      const markResolved = asBoolean(p.markResolved, 'markResolved');
      return ctx.withLock(repo.id, async () => {
        const st = await git.status();
        const changedFiles: string[] = [];
        const resolved: string[] = [];
        const skipped: { path: string; reason: string }[] = [];
        for (const c of st.conflicted) {
          try {
            await git.snapshotConflict(c.path);
            await git.takeSide(c.path, side);
            changedFiles.push(c.path);
            if (markResolved) {
              await git.markResolved(c.path);
              resolved.push(c.path);
            }
          } catch (err) {
            skipped.push({ path: c.path, reason: toFriendlyError(err, 'Resolve conflict').message });
          }
        }
        const sides = await git.conflictSides();
        ctx.recordOperation(repo, 'Resolve conflicts', skipped.length ? 'WARNING' : 'SUCCESS', `Accepted ${side === 'theirs' ? `incoming (${sides.incoming})` : `current (${sides.current})`} for ${changedFiles.length} file(s)${markResolved ? `, ${resolved.length} marked resolved` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}`);
        return { changed: changedFiles, resolved, skipped };
      });
    },

    'conflict:markAllResolved': async (payload) => {
      const { repo, git } = ctx.git(asObject(payload).repoId);
      return ctx.withLock(repo.id, async () => {
        const st = await git.status();
        const resolved: string[] = [];
        const remaining: string[] = [];
        for (const c of st.conflicted) {
          try {
            await git.snapshotConflict(c.path);
            await git.markResolved(c.path);
            resolved.push(c.path);
          } catch {
            remaining.push(c.path); // still has conflict markers
          }
        }
        return { resolved, remaining };
      });
    },

    'conflict:undo': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const file = asString(p.path, 'path', { trim: false });
      await ctx.withLock(repo.id, () => git.restoreConflict(file));
      ctx.recordOperation(repo, 'Undo conflict resolution', 'SUCCESS', `${file} is conflicted again`);
    },

    'conflict:prepareContinue': async (payload) => {
      const { repo, git } = ctx.git(asObject(payload).repoId);
      const st = await git.status();
      if (!st.operation) throw new AppError({ code: 'no-operation', title: 'Nothing to Continue', message: 'No merge or rebase is in progress.' });
      if (st.conflicted.length) {
        throw new AppError({ code: 'unresolved', title: 'Unresolved Conflicts Remain', message: `${st.conflicted.length} file(s) still have conflicts.`, actions: ['resolve-conflicts'] });
      }
      return buildCommitPreview(repo, git, 'continue');
    },

    'conflict:continue': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const signing = asEnum(p.signing, 'signing', ['none', 'gpg', 'ssh', 'x509'] as const);
      await ctx.withLock(repo.id, async () => {
        await verifyCommitReview(repo.id, git, 'continue', p.confirmationId, signing);
        const op = await git.operationInProgress();
        await git.continueOperation(signing);
        await git.clearConflictSnapshots();
        ctx.recordOperation(repo, `Continue ${op ?? 'operation'}`, 'SUCCESS', 'Conflicts resolved and operation completed');
      });
    },

    'conflict:abort': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const op = await git.operationInProgress();
      await ctx.withLock(repo.id, async () => {
        await git.abortOperation();
        await git.clearConflictSnapshots();
      });
      ctx.recordOperation(repo, `Abort ${op ?? 'operation'}`, 'CANCELLED', 'Repository restored to the state before the operation');
    },

    // ---------------- pull requests ----------------

    'pr:prepare': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const source = asBranchName(p.source, 'source branch');
      const target = asBranchName(p.target, 'target branch');
      const st = await git.status();
      const remote = await primaryRemote(git, st.upstream);
      if (!remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'Add a GitHub remote first.', actions: ['open-settings'] });
      const parsed = parseRemoteUrl(remote.url);
      if (!parsed.isGitHub || !parsed.owner || !parsed.repo) {
        throw new AppError({ code: 'not-github', title: 'Not a GitHub Repository', message: 'Pull requests can only be created for repositories hosted on GitHub.' });
      }
      const warnings: string[] = [];
      const blockers: string[] = [];
      if (source === target) blockers.push('Source and target branch must be different.');
      const resolveRef = async (ref: string) => {
        try {
          return await git.revParse(ref);
        } catch {
          return null;
        }
      };
      const localSource = await resolveRef(`refs/heads/${source}`);
      const remoteSource = await resolveRef(`refs/remotes/${remote.name}/${source}`);
      const remoteTarget = await resolveRef(`refs/remotes/${remote.name}/${target}`);
      if (!remoteTarget) blockers.push(`Target branch "${target}" was not found on ${remote.name}. Fetch first or choose another branch.`);
      if (!remoteSource) blockers.push(`Source branch "${source}" has not been pushed to ${remote.name}. Push it first.`);
      else if (localSource && localSource !== remoteSource) {
        if (await git.isAncestor(remoteSource, localSource)) warnings.push(`Your local "${source}" has commits that are not pushed yet. They will not be part of the pull request until you push.`);
        else warnings.push(`Local and remote "${source}" have diverged. The pull request uses the remote version.`);
      }
      if (st.unstaged.length + st.staged.length + st.untracked.length > 0) warnings.push('You have uncommitted changes. They are not included in the pull request.');
      let commits: PrPreview['commits'] = [];
      let files: PrPreview['files'] = [];
      if (remoteSource && remoteTarget && source !== target) {
        commits = await git.log({ range: `${remoteTarget}..${remoteSource}`, limit: 500 });
        files = await git.diffRange(remoteTarget, remoteSource, { threeDot: true });
        if (commits.length === 0) blockers.push(`There are no commits on "${source}" that are not already in "${target}".`);
      }
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        source,
        target,
        commits,
        files,
        warnings,
        blockers,
        authOptions: describeAuthOptions(repo, remote.url, 'pr', ctx.secrets.status(repo.id)),
        githubApp: repo.settings.githubApp,
        savedSshKey: savedSshKey(repo),
        account: repoAccount(repo, remote.url),
      };
    },

    'pr:create': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const source = asBranchName(p.source, 'source branch');
      const target = asBranchName(p.target, 'target branch');
      const title = asLine(p.title, 'Title', { max: 256 });
      const body = asString(p.body ?? '', 'Description', { min: 0, max: 65_000, trim: false });
      const draft = asBoolean(p.draft, 'draft');
      const auth = parseAuthInput(p.auth);
      const st = await git.status();
      const remote = await primaryRemote(git, st.upstream);
      if (!remote) throw new AppError({ code: 'no-remote', title: 'No Remote Configured', message: 'Add a GitHub remote first.' });
      const parsed = parseRemoteUrl(remote.url);
      if (!parsed.isGitHub || !parsed.owner || !parsed.repo) throw new AppError({ code: 'not-github', title: 'Not a GitHub Repository', message: 'Pull requests require a GitHub remote.' });
      const resolved = await authFor(repo, remote.url, auth, 'pr');
      try {
        const apiBase = repo.settings.apiBaseUrl ? validateApiBaseUrl(repo.settings.apiBaseUrl) : apiBaseForHost(parsed.host);
        const gh = ctx.githubFor(apiBase);
        const pr = await gh.createPullRequest(resolved.apiToken!, { owner: parsed.owner, repo: parsed.repo, title, body, head: source, base: target, draft });
        ctx.recordOperation(repo, 'PR Created', 'SUCCESS', `#${pr.number} ${source} → ${target}: ${pr.url}`);
        return pr;
      } catch (err) {
        ctx.recordOperation(repo, 'PR Created', 'FAILED', `${source} → ${target}`);
        throw err;
      } finally {
        await resolved.cleanup();
      }
    },

    // ---------------- GitHub App tokens ----------------

    'github:loadKeyFile': async () => {
      const win = getWindow();
      const opts: Electron.OpenDialogOptions = {
        title: 'Select GitHub App private key (.pem)',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [{ name: 'PEM private key', extensions: ['pem', 'key'] }],
      };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths[0]) return null;
      const file = res.filePaths[0];
      const stat = fs.statSync(file);
      if (stat.size > 16_384) throw new AppError({ code: 'invalid-private-key', title: 'Invalid Private Key', message: 'That file is too large to be a GitHub App private key.' });
      let pem = fs.readFileSync(file, 'utf8');
      const key = parsePrivateKey(pem);
      const { handle } = ctx.vault.put('private-key', pem, 15 * 60_000);
      pem = '';
      return { handle, fingerprint: privateKeyFingerprint(key), fileName: path.basename(file) };
    },

    'github:discardKey': async (payload) => {
      ctx.vault.delete(asString(asObject(payload).handle, 'handle', { max: 64 }));
    },

    'github:validateApp': async (payload) => {
      const p = asObject(payload);
      const appId = asNumericId(p.appId, 'App ID');
      const { key } = loadKey(p);
      const gh = ctx.githubFor(apiBaseFrom(p));
      const app = await gh.authenticate(appId, key);
      const owner = p.owner ? asGitHubName(p.owner, 'Owner') : undefined;
      const repoName = p.repo ? asGitHubName(p.repo, 'Repository') : undefined;
      if (owner && repoName) {
        const inst = await gh.getRepoInstallation(appId, key, owner, repoName);
        return { appName: app.name, appSlug: app.slug, installationId: inst.id, installationAccount: inst.account, permissions: inst.permissions };
      }
      return { appName: app.name, appSlug: app.slug };
    },

    'github:generateToken': async (payload) => {
      const p = asObject(payload);
      const appId = asNumericId(p.appId, 'App ID');
      const owner = asGitHubName(p.owner, 'Owner');
      const repoName = asGitHubName(p.repo, 'Repository');
      const installationId = asOptionalNumericId(p.installationId, 'Installation ID');
      const preset = asEnum(p.preset, 'permissions', ['contents-read', 'contents-write', 'pull-requests-write'] as const);
      const clearAfter = asInt(p.clearAfterSeconds, 'clearAfterSeconds', 15, 3600);
      const { key } = loadKey(p);
      const gh = ctx.githubFor(apiBaseFrom(p));
      const tok = await gh.generateInstallationToken({ appId, key, owner, repo: repoName, installationId, permissions: presetPermissions(preset) });
      // The token lives only in the main process; when the timer fires it is dropped and revoked.
      const { handle, expiresAt } = ctx.vault.put('installation-token', tok.token, clearAfter * 1000, {
        onExpire: (value) => {
          void revokeWithRetry(gh, value).then((ok) => ctx.tokens.setResult(value, ok));
        },
      });
      ctx.tokens.track(tok.token, {
        source: p.repoId ? 'dialog' : 'token-page',
        apiBase: apiBaseFrom(p),
        appId: String(appId),
        repositories: tok.repositories,
        permissions: tok.permissions,
        expiresAt: tok.expiresAt,
        vaultHandle: handle,
      });
      ctx.recordOperation(null, 'Generate App token', 'SUCCESS', `App ${appId} for ${owner}/${repoName} (${Object.entries(tok.permissions).map(([k, v]) => `${k}:${v}`).join(', ')})`);
      return {
        handle,
        maskedToken: maskToken(tok.token),
        expiresAt: tok.expiresAt,
        clearsAt: new Date(expiresAt).toISOString(),
        installationId: tok.installationId,
        permissions: tok.permissions,
        repositories: tok.repositories,
      };
    },

    'github:revealToken': async (payload) => {
      const handle = asString(asObject(payload).handle, 'handle', { max: 64 });
      const token = ctx.vault.get(handle, 'installation-token');
      if (!token) throw new AppError({ code: 'token-cleared', title: 'Token Cleared', message: 'The token was cleared from memory. Generate a new one.' });
      return { token };
    },

    'github:copyToken': async (payload) => {
      const p = asObject(payload);
      const handle = asString(p.handle, 'handle', { max: 64 });
      const seconds = asInt(p.clearClipboardAfterSeconds, 'clearClipboardAfterSeconds', 5, 600);
      const token = ctx.vault.get(handle, 'installation-token');
      if (!token) throw new AppError({ code: 'token-cleared', title: 'Token Cleared', message: 'The token was cleared from memory. Generate a new one.' });
      await clipboard.writeText(token);
      setTimeout(() => {
        // Only clear if the clipboard still holds our token (don't wipe something the user copied since).
        void clipboard.readText().then(async (current) => {
          if (current === token) await clipboard.clear();
        });
      }, seconds * 1000).unref?.();
    },

    'github:revokeToken': async (payload) => {
      const handle = asString(asObject(payload).handle, 'handle', { max: 64 });
      const token = ctx.vault.take(handle, 'installation-token');
      if (!token) return { revoked: false };
      const revoked = await revokeWithRetry(ctx.githubFor(apiBaseForHost(null)), token);
      ctx.tokens.setResult(token, revoked);
      ctx.recordOperation(null, 'Revoke App token', revoked ? 'SUCCESS' : 'WARNING', revoked ? 'Installation token revoked' : 'Token removed from memory; revocation request failed');
      return { revoked };
    },

    'github:discardToken': async (payload) => {
      // Dropping the handle also revokes the token via the vault's expiry hook.
      ctx.vault.delete(asString(asObject(payload).handle, 'handle', { max: 64 }));
    },

    'github:tokenList': async () => ctx.tokens.list(),

    'github:tokenRevoke': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const id = asString(p.id, 'token id', { max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
      const r = ctx.tokens.revocable(id);
      if (!r) throw new AppError({ code: 'token-not-active', title: 'Nothing to Revoke', message: 'This token is already revoked or expired.' });
      // Drop the copy held for copy/reveal without triggering the expiry hook (we revoke here).
      if (r.vaultHandle) ctx.vault.delete(r.vaultHandle, false);
      const ok = await revokeWithRetry(ctx.githubFor(r.apiBase), r.token);
      ctx.tokens.record(id, ok);
      ctx.recordOperation(null, 'Revoke installation token', ok ? 'SUCCESS' : 'FAILED', ok ? 'Revoked from the token page' : 'GitHub could not be reached; the token expires within 1 hour');
      const rec = ctx.tokens.list().find((t) => t.id === id);
      if (!rec) throw new AppError({ code: 'token-not-found', title: 'Token Not Found', message: 'The token is no longer listed.' });
      return rec;
    },

    'github:tokenRevokeAll': async (payload) => {
      asConfirmed(asObject(payload).confirmed);
      let revoked = 0;
      let failed = 0;
      for (const id of ctx.tokens.activeIds()) {
        const r = ctx.tokens.revocable(id);
        if (!r) continue;
        if (r.vaultHandle) ctx.vault.delete(r.vaultHandle, false);
        const ok = await revokeWithRetry(ctx.githubFor(r.apiBase), r.token);
        ctx.tokens.record(id, ok);
        if (ok) revoked++;
        else failed++;
      }
      ctx.recordOperation(null, 'Revoke all installation tokens', failed ? 'WARNING' : 'SUCCESS', `${revoked} revoked${failed ? `, ${failed} could not be revoked (expire within 1 hour)` : ''}`);
      return { revoked, failed, tokens: ctx.tokens.list() };
    },

    'github:tokenClearFinished': async () => {
      ctx.tokens.clearFinished();
      return ctx.tokens.list();
    },

    // ---------------- misc ----------------

    'ssh:matchPublicKey': async (payload) => {
      const text = asString(asObject(payload).publicKey, 'Public key', { max: 16_384 });
      const pub = parsePublicKey(text);
      return matchResult(pub, findPrivateKeyFor(pub.fingerprint));
    },

    'ssh:loadPublicKeyFile': async () => {
      const win = getWindow();
      const opts: Electron.OpenDialogOptions = {
        title: 'Select your SSH public key (.pub)',
        defaultPath: path.join(os.homedir(), '.ssh'),
        properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
        filters: [{ name: 'SSH public key', extensions: ['pub'] }, { name: 'All files', extensions: ['*'] }],
      };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths[0]) return null;
      const file = path.resolve(res.filePaths[0]);
      if (fs.statSync(file).size > 16_384) throw new AppError({ code: 'ssh-public-key-invalid', title: 'Invalid Public Key', message: 'That file is too large to be an SSH public key.' });
      const pub = parsePublicKey(fs.readFileSync(file, 'utf8'));
      return matchResult(pub, findPrivateKeyFor(pub.fingerprint, { pubFilePath: file }));
    },

    'ssh:pickKeyFile': async (payload) => {
      const expected = payload && typeof payload === 'object' ? asOptionalString((payload as Record<string, unknown>).fingerprint, 'fingerprint', { max: 100 }) : undefined;
      const win = getWindow();
      const opts: Electron.OpenDialogOptions = {
        title: 'Select your SSH private key (not the .pub file)',
        defaultPath: path.join(os.homedir(), '.ssh'),
        properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
      };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths[0]) return null;
      const file = path.resolve(res.filePaths[0]);
      if (file.endsWith('.pub')) {
        throw new AppError({ code: 'ssh-key-invalid', title: 'Public Key Selected', message: 'You selected the public key (.pub). Choose the matching private key file without .pub.' });
      }
      const details = inspectSshKey(file);
      if (expected && details.fingerprint && details.fingerprint !== expected) {
        throw new AppError({ code: 'ssh-key-mismatch', title: 'Key Does Not Match', message: 'This private key does not belong to the public key you provided. Choose the matching private key.' });
      }
      // Only the path is kept (in memory, for this session); the key itself is read by ssh when used.
      const { handle } = ctx.vault.put('ssh-key-path', file, 8 * 60 * 60_000);
      return { handle, path: file, fileName: path.basename(file), ...details };
    },

    'repo:setupGitHubApp': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const st = await git.status();
      const remote = await primaryRemote(git, st.upstream);
      const parsed = remote ? parseRemoteUrl(remote.url) : null;
      if (!parsed?.isGitHub || !parsed.owner || !parsed.repo) {
        throw new AppError({ code: 'not-github', title: 'Not a GitHub Repository', message: 'Add a GitHub remote first. The App is linked to the repository that remote points to.' });
      }
      const appId = asNumericId(p.appId, 'App ID');
      let installationId = asOptionalNumericId(p.installationId, 'Installation ID');
      const saveKey = asBoolean(p.saveKey, 'saveKey');
      const validate = asBoolean(p.validate, 'validate');
      const result: { appName?: string; installationId?: string; permissions?: Record<string, string> } = {};
      let pem: string | null = null;
      const keyHandle = asOptionalString(p.keyHandle, 'keyHandle', { max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
      if (keyHandle) pem = ctx.vault.take(keyHandle, 'private-key');
      else if (p.privateKey) pem = asString(p.privateKey, 'Private key', { max: 16_384, trim: false });
      if ((validate || saveKey) && !pem) throw new AppError({ code: 'auth-input', title: 'Private Key Required', message: 'Load or paste the private key to validate or save it.' });
      if (pem) {
        const key = parsePrivateKey(pem);
        if (validate) {
          const apiBase = repo.settings.apiBaseUrl ? validateApiBaseUrl(repo.settings.apiBaseUrl) : apiBaseForHost(parsed.host);
          const gh = ctx.githubFor(apiBase);
          const app = await gh.authenticate(appId, key);
          const inst = await gh.getRepoInstallation(appId, key, parsed.owner, parsed.repo);
          installationId = inst.id;
          Object.assign(result, { appName: app.name, installationId: inst.id, permissions: inst.permissions });
        }
        if (saveKey) {
          if (!ctx.secrets.encryptionAvailable()) throw new AppError({ code: 'no-encryption', title: 'Secure Storage Unavailable', message: 'No OS keychain is available, so the key cannot be saved.' });
          ctx.repos.updateSettings(repo.id, { allowSavedCredentials: true });
          ctx.secrets.saveGitHubAppKey(repo.id, pem);
        }
        pem = null;
      }
      const updated = ctx.repos.updateSettings(repo.id, { githubApp: { appId, owner: parsed.owner, repo: parsed.repo, installationId } });
      ctx.recordOperation(updated, 'GitHub App setup', 'SUCCESS', `App ${appId} linked to ${parsed.owner}/${parsed.repo}${installationId ? ` (installation ${installationId})` : ''}${saveKey ? '; key saved encrypted' : ''}`);
      return { summary: await summarize(updated), ...result };
    },

    'history:list': async () => ctx.history.list(),
    'history:clear': async () => ctx.history.clear(),

    'shell:openExternal': async (payload) => {
      const url = asLine(asObject(payload).url, 'url', { max: 2048 });
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new ValidationError('Invalid URL');
      }
      const allowedHosts = ['github.com', 'docs.github.com', 'git-scm.com'];
      const extra = ctx.repos
        .list()
        .map((r) => r.settings.apiBaseUrl)
        .filter((x): x is string => !!x)
        .map((x) => new URL(x).hostname);
      if (u.protocol !== 'https:' || ![...allowedHosts, ...extra].includes(u.hostname)) {
        throw new ValidationError('Only https links to GitHub and Git documentation can be opened');
      }
      await shell.openExternal(u.toString());
    },
  };

  const placeholderRepo: RepoRecord = { id: 'pending-clone', name: '', path: '', addedAt: '', settings: { runHooks: false, allowSystemCredentials: true, allowSavedCredentials: false } };
  return {
    ...core,
    ...createGitHubHandlers(ctx),
    ...createHistoryHandlers(ctx, getWindow),
    ...createBranchHandlers(ctx, { authFor, primaryRemote, savedSshKey, repoAccount, matchResult }),
    ...createExtraHandlers(ctx, {
      summarize,
      resolveCloneAuth: (url, auth) => resolveAuth(authDeps, placeholderRepo, url, auth, 'clone'),
    }),
  };
}

export { ConfirmationError };
