import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountSecretStore, AccountStore } from '../src/main/accounts/AccountStore';
import { AppContext } from '../src/main/context';
import { GitService } from '../src/main/git/GitService';
import { runGit } from '../src/main/git/runner';
import { generateSshKey, inspectSshKey, listLocalPublicKeys, sshKeygenBinary, verifySshPassphrase } from '../src/main/git/sshKeys';
import { resolveAuth } from '../src/main/github/authResolver';
import { createBranchHandlers } from '../src/main/ipc/branchHandlers';
import { HistoryStore } from '../src/main/repositories/HistoryStore';
import { RepoStore } from '../src/main/repositories/RepoStore';
import { SecretStore, type Encryptor } from '../src/main/repositories/SecretStore';
import type { RepoRecord } from '../src/shared/types';

const enc: Encryptor = { isAvailable: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() };

let tmp: string;
let ctx: AppContext;
let repo: RepoRecord;
let git: GitService;
let bare: string;
let handlers: ReturnType<typeof createBranchHandlers>;

const remoteOid = async (branch: string) => {
  const r = await runGit({ cwd: bare, args: ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], okExitCodes: [1] });
  return r.exitCode === 0 ? r.stdout.trim() : null;
};

async function commitFile(name: string, content: string, msg: string) {
  fs.writeFileSync(path.join(git.root, name), content);
  await git.stageAll();
  return git.commit(msg, 'none');
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-branch-')));
  ctx = new AppContext(
    new RepoStore(path.join(tmp, 'repos.json')),
    new SecretStore(path.join(tmp, 'secrets'), enc),
    new HistoryStore(path.join(tmp, 'history.json')),
    path.join(tmp, 'backups'),
    new AccountStore(path.join(tmp, 'accounts.json')),
    new AccountSecretStore(path.join(tmp, 'secrets', 'accounts'), enc),
  );
  bare = path.join(tmp, 'remote.git');
  await runGit({ cwd: tmp, args: ['init', '--bare', '--initial-branch=main', bare] });
  git = await GitService.init(path.join(tmp, 'work'), 'main');
  await git.setIdentity('T', 't@example.com');
  await git.setRemote('origin', bare);
  const c = await commitFile('a.txt', 'one\n', 'init');
  await git.push('origin', c.hash, 'main', { kind: 'none' }, { setUpstreamFor: 'main' });
  repo = ctx.repos.add(git.root);
  const authDeps = { secrets: ctx.secrets, vault: ctx.vault, githubFor: (b: string) => ctx.githubFor(b) };
  handlers = createBranchHandlers(ctx, {
    authFor: (r, url, input, purpose) => resolveAuth(authDeps, r, url, input, purpose),
    primaryRemote: async (g) => {
      const r = (await g.remotes())[0];
      return r ? { name: r.name, url: r.pushUrl } : null;
    },
    savedSshKey: () => null,
    repoAccount: () => null,
    matchResult: (pub, keyPath) => ({ ...pub, match: keyPath ? { handle: 'h', path: keyPath, fileName: path.basename(keyPath), encrypted: false, fingerprint: pub.fingerprint } : null, searched: '' }),
  });
});

const NONE = { method: 'none' as const };

describe('create & publish branch', () => {
  it('creates the branch, pushes it and verifies it on the remote', async () => {
    const p = await handlers['git:publishPreview']({ repoId: repo.id, name: 'feature/a' });
    expect(p.authOptions.map((o) => o.method)).toEqual(['none']);
    expect(p.localExists).toBe(false);
    const r = await handlers['git:publishExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, switchTo: true });
    expect(r.verifiedRemoteOid).toBe(p.baseOid);
    expect(await remoteOid('feature/a')).toBe(p.baseOid);
    expect((await git.status()).branch).toBe('feature/a');
    expect((await git.status()).upstream).toBe('origin/feature/a');
  });

  it('commits pending changes on the new branch when asked', async () => {
    fs.writeFileSync(path.join(git.root, 'new.txt'), 'pending\n');
    const p = await handlers['git:publishPreview']({ repoId: repo.id, name: 'wip' });
    expect(p.pendingFiles).toEqual(['new.txt']);
    expect(p.canCommitPending).toBe(true);
    const r = await handlers['git:publishExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, switchTo: true, commitMessage: 'Add new file' });
    expect(r.committed?.subject).toBe('Add new file');
    expect(await remoteOid('wip')).toBe(r.oid);
    expect(r.oid).not.toBe(p.baseOid);
  });

  it('does not report success when the push fails, and reuses the local branch on retry', async () => {
    const p = await handlers['git:publishPreview']({ repoId: repo.id, name: 'retry-me' });
    fs.renameSync(bare, `${bare}.gone`);
    await expect(handlers['git:publishExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, switchTo: false })).rejects.toThrow(/NOT published/);
    fs.renameSync(`${bare}.gone`, bare);
    const p2 = await handlers['git:publishPreview']({ repoId: repo.id, name: 'retry-me' });
    expect(p2.localExists).toBe(true);
    const r = await handlers['git:publishExecute']({ repoId: repo.id, confirmationId: p2.confirmationId, auth: NONE, switchTo: false });
    expect(await remoteOid('retry-me')).toBe(r.oid);
  });
});

describe('merge branch into branch', () => {
  it('merges source into target, publishes the target and returns to the original branch', async () => {
    await git.createBranch('feature', null, true);
    await commitFile('b.txt', 'b\n', 'feature work');
    await git.switchBranch('main');
    await commitFile('c.txt', 'c\n', 'main work');
    await git.createBranch('other', null, true);
    const p = await handlers['git:mergePreview']({ repoId: repo.id, source: 'feature', target: 'main' });
    expect(p.state).toBe('merge');
    expect(p.predictedConflicts).toEqual([]);
    expect(p.commits.map((c) => c.subject)).toEqual(['feature work']);
    const r = await handlers['git:mergeExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, push: true, returnToCurrent: true });
    expect(r.outcome).toBe('merged');
    expect(r.pushed).toBe(true);
    expect(await remoteOid('main')).toBe(r.newOid);
    expect(r.returnedTo).toBe('other');
    expect((await git.status()).branch).toBe('other');
  });

  it('predicts and reports conflicts without pushing', async () => {
    await git.createBranch('feature', null, true);
    await commitFile('a.txt', 'feature\n', 'feature edit');
    await git.switchBranch('main');
    const before = await commitFile('a.txt', 'main\n', 'main edit');
    const p = await handlers['git:mergePreview']({ repoId: repo.id, source: 'feature', target: 'main' });
    expect(p.predictedConflicts).toEqual(['a.txt']);
    const r = await handlers['git:mergeExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, push: true, returnToCurrent: true });
    expect(r.outcome).toBe('conflicts');
    expect(r.conflicted).toEqual(['a.txt']);
    expect(r.pushed).toBe(false);
    expect(await remoteOid('main')).not.toBe(before.hash);
  });

  it('refuses to switch branches over uncommitted changes', async () => {
    await git.createBranch('feature', null, false);
    await git.createBranch('target', null, false);
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'dirty\n');
    const p = await handlers['git:mergePreview']({ repoId: repo.id, source: 'feature', target: 'target' });
    expect(p.dirtyFiles).toEqual(['a.txt']);
    await expect(handlers['git:mergeExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, push: false, returnToCurrent: true })).rejects.toThrow(/clean working tree/);
  });
});

describe('delete branch', () => {
  it('deletes the remote branch first, verifies it, then the local branch', async () => {
    const p = await handlers['git:publishPreview']({ repoId: repo.id, name: 'old' });
    await handlers['git:publishExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, switchTo: false });
    const d = await handlers['git:deletePreview']({ repoId: repo.id, branch: 'old', kind: 'local' });
    expect(d.local?.merged).toBe(true);
    expect(d.remote?.branch).toBe('old');
    expect(d.remote?.uniqueCommits).toBe(0);
    const r = await handlers['git:deleteExecute']({ repoId: repo.id, confirmationId: d.confirmationId, auth: NONE, deleteLocal: true, deleteRemote: true, force: false, confirmed: true });
    expect(r.remoteDeleted && r.localDeleted).toBe(true);
    expect(await remoteOid('old')).toBeNull();
    expect(await git.tryRevParse('refs/heads/old')).toBeNull();
  });

  it('refuses the default branch and unmerged branches without force', async () => {
    await runGit({ cwd: git.root, args: ['remote', 'set-head', 'origin', 'main'] });
    const d = await handlers['git:deletePreview']({ repoId: repo.id, branch: 'origin/main', kind: 'remote' });
    expect(d.remote?.isDefault).toBe(true);
    await expect(handlers['git:deleteExecute']({ repoId: repo.id, confirmationId: d.confirmationId, auth: NONE, deleteLocal: false, deleteRemote: true, force: false, confirmed: true })).rejects.toThrow(/default branch/);

    await git.createBranch('unmerged', null, true);
    await commitFile('u.txt', 'u\n', 'unmerged work');
    await git.switchBranch('main');
    const u = await handlers['git:deletePreview']({ repoId: repo.id, branch: 'unmerged', kind: 'local' });
    expect(u.local?.merged).toBe(false);
    await expect(handlers['git:deleteExecute']({ repoId: repo.id, confirmationId: u.confirmationId, auth: NONE, deleteLocal: true, deleteRemote: false, force: false, confirmed: true })).rejects.toThrow(/not merged/);
    const u2 = await handlers['git:deletePreview']({ repoId: repo.id, branch: 'unmerged', kind: 'local' });
    const r = await handlers['git:deleteExecute']({ repoId: repo.id, confirmationId: u2.confirmationId, auth: NONE, deleteLocal: true, deleteRemote: false, force: true, confirmed: true });
    expect(r.localDeleted).toBe(true);
  });

  it('treats an already-deleted remote branch as gone and cleans the stale ref', async () => {
    const p = await handlers['git:publishPreview']({ repoId: repo.id, name: 'stale' });
    await handlers['git:publishExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, switchTo: false });
    await runGit({ cwd: bare, args: ['branch', '-D', 'stale'] });
    const d = await handlers['git:deletePreview']({ repoId: repo.id, branch: 'origin/stale', kind: 'remote' });
    const r = await handlers['git:deleteExecute']({ repoId: repo.id, confirmationId: d.confirmationId, auth: NONE, deleteLocal: false, deleteRemote: true, force: false, confirmed: true });
    expect(r.remoteMissing).toBe(true);
    expect(await git.tryRevParse('refs/remotes/origin/stale')).toBeNull();
    expect(await git.tryRevParse('refs/heads/stale')).not.toBeNull();
  });
});

describe('merge recovery: unrelated histories, auto-resolution, merge branch for PR, fast-forward fix', () => {
  async function unrelatedQa() {
    // qa: an orphan branch (no common history with main) that also has a different a.txt.
    await runGit({ cwd: git.root, args: ['switch', '--orphan', 'qa'] });
    await runGit({ cwd: git.root, args: ['rm', '-rf', '--quiet', '.'], okExitCodes: [0, 128] });
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'qa version\n');
    fs.writeFileSync(path.join(git.root, 'qa.txt'), 'only on qa\n');
    await git.stageAll();
    await git.commit('qa start', 'none');
    await git.switchBranch('main');
  }

  it('diagnoses unrelated histories instead of failing (the "no merge base" case)', async () => {
    await unrelatedQa();
    const p = await handlers['git:mergePreview']({ repoId: repo.id, source: 'qa', target: 'main' });
    expect(p.state).toBe('unrelated');
    expect(p.mergeBase).toBeNull();
    expect(p.files.map((f) => f.path).sort()).toEqual(['a.txt', 'qa.txt']);
    expect(p.predictedConflicts).toEqual(['a.txt']);
    expect(p.issues.find((i) => i.id === 'unrelated')).toMatchObject({ severity: 'blocker', category: 'history', fix: 'merge-anyway' });
    expect(p.issues.find((i) => i.id === 'conflicts')?.category).toBe('git-conflict');
    // Without explicit consent nothing is merged.
    await expect(handlers['git:mergeExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, push: false, returnToCurrent: false })).rejects.toThrow(/share no history/);
  });

  it('"merge anyway" with automatic conflict resolution combines both histories', async () => {
    await unrelatedQa();
    const p = await handlers['git:mergePreview']({ repoId: repo.id, source: 'qa', target: 'main' });
    const r = await handlers['git:mergeExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, push: true, returnToCurrent: false, allowUnrelated: true, conflictStrategy: 'prefer-source' });
    expect(r.outcome).toBe('merged');
    expect(fs.readFileSync(path.join(git.root, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('qa version\n');
    expect(fs.existsSync(path.join(git.root, 'qa.txt'))).toBe(true);
    expect(r.pushed).toBe(true);
  });

  it('merges into a new branch for a pull request, leaving the target untouched', async () => {
    await unrelatedQa();
    const before = await git.revParse('refs/heads/main');
    const p = await handlers['git:mergePreview']({ repoId: repo.id, source: 'qa', target: 'main' });
    expect(p.suggestedBridge).toBe('merge/qa-into-main');
    const r = await handlers['git:mergeExecute']({ repoId: repo.id, confirmationId: p.confirmationId, auth: NONE, push: false, returnToCurrent: true, allowUnrelated: true, conflictStrategy: 'prefer-target', bridge: 'merge/qa-into-main' });
    expect(r.bridge).toBe('merge/qa-into-main');
    expect(r.pushed).toBe(true);
    expect(await remoteOid('merge/qa-into-main')).toBe(r.newOid);
    expect(await git.revParse('refs/heads/main')).toBe(before);
    expect((await git.status()).branch).toBe('main');
  });

  it('offers and applies a safe fast-forward when the target is behind its remote', async () => {
    // Someone else pushed to main: simulate with a second clone.
    const other = path.join(tmp, 'other');
    await runGit({ cwd: tmp, args: ['clone', '-q', bare, other] });
    fs.writeFileSync(path.join(other, 'remote.txt'), 'r\n');
    await runGit({ cwd: other, args: ['-c', 'user.name=O', '-c', 'user.email=o@x', 'add', '.'] });
    await runGit({ cwd: other, args: ['-c', 'user.name=O', '-c', 'user.email=o@x', 'commit', '-qm', 'remote work'] });
    await runGit({ cwd: other, args: ['push', '-q', 'origin', 'main'] });
    await git.fetch('origin', { kind: 'none' });
    await git.createBranch('feature', null, true);
    await commitFile('f.txt', 'f\n', 'feature');
    await git.switchBranch('main');
    const p = await handlers['git:mergePreview']({ repoId: repo.id, source: 'feature', target: 'main' });
    expect(p.issues.find((i) => i.id === 'target-behind')).toMatchObject({ fix: 'fast-forward-target' });
    const ff = await handlers['git:fastForwardBranch']({ repoId: repo.id, branch: 'main' });
    expect(ff.to).toBe(await git.revParse('refs/remotes/origin/main'));
    const p2 = await handlers['git:mergePreview']({ repoId: repo.id, source: 'feature', target: 'main' });
    expect(p2.issues.find((i) => i.id === 'target-behind')).toBeUndefined();
  });
});

describe('switching branches with uncommitted changes', () => {
  async function setup() {
    // main: a.txt=one, b.txt=b ; other: a.txt changed, b.txt same, t.txt tracked
    await commitFile('b.txt', 'b\n', 'add b');
    await git.createBranch('other', null, true);
    fs.writeFileSync(path.join(git.root, 't.txt'), 'theirs\n');
    await commitFile('a.txt', 'line1\nother\n', 'other edits');
    await git.switchBranch('main');
  }
  const read = (f: string) => fs.readFileSync(path.join(git.root, f), 'utf8').replace(/\r\n/g, '\n');

  it('switches directly when there are no changes', async () => {
    await setup();
    const p = await handlers['git:switchPreview']({ repoId: repo.id, target: 'other', kind: 'local' });
    expect(p.files).toEqual([]);
    const r = await handlers['git:switchExecute']({ repoId: repo.id, confirmationId: p.confirmationId, strategy: 'carry' });
    expect(r.outcome).toBe('switched');
  });

  it('classifies files and carries safe changes along', async () => {
    await setup();
    fs.writeFileSync(path.join(git.root, 'b.txt'), 'b edited\n');
    fs.writeFileSync(path.join(git.root, 'new.txt'), 'n\n');
    const p = await handlers['git:switchPreview']({ repoId: repo.id, target: 'other', kind: 'local' });
    expect(p.files.map((f) => [f.path, f.state])).toEqual([
      ['b.txt', 'safe'],
      ['new.txt', 'safe'],
    ]);
    expect(p.canCarry).toBe(true);
    const r = await handlers['git:switchExecute']({ repoId: repo.id, confirmationId: p.confirmationId, strategy: 'carry' });
    expect(r.outcome).toBe('carried');
    expect(read('b.txt')).toBe('b edited\n');
  });

  it('predicts conflicts and blocked untracked files without changing anything', async () => {
    await setup();
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'mine\n');
    fs.writeFileSync(path.join(git.root, 't.txt'), 'mine too\n');
    const before = await git.status();
    const p = await handlers['git:switchPreview']({ repoId: repo.id, target: 'other', kind: 'local' });
    expect(Object.fromEntries(p.files.map((f) => [f.path, f.state]))).toEqual({ 'a.txt': 'conflict', 't.txt': 'blocked' });
    expect(p.canCarry).toBe(false);
    expect(p.canReapply).toBe(false);
    expect(p.recommended).toBe('stash');
    expect(await git.status()).toEqual(before);
    expect(await git.tryRevParse('refs/stash')).toBeNull();
  });

  it('stash & switch keeps the changes in a named stash', async () => {
    await setup();
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'mine\n');
    const p = await handlers['git:switchPreview']({ repoId: repo.id, target: 'other', kind: 'local' });
    const r = await handlers['git:switchExecute']({ repoId: repo.id, confirmationId: p.confirmationId, strategy: 'stash' });
    expect(r.outcome).toBe('stashed');
    expect((await git.status()).branch).toBe('other');
    expect(read('a.txt')).toBe('line1\nother\n');
    expect((await git.stashList())[0].message).toContain('before switching to other');
  });

  it('re-applies cleanly-merging changes', async () => {
    await setup();
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'one\nappended by me\n');
    // other changed line 1 of a different file layout; make a mergeable case instead:
    await git.unstageAllKeepFiles();
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(git.root, 'b.txt'), 'b mine\n');
    const p = await handlers['git:switchPreview']({ repoId: repo.id, target: 'other', kind: 'local' });
    const r = await handlers['git:switchExecute']({ repoId: repo.id, confirmationId: p.confirmationId, strategy: 'stash-apply' });
    expect(r.outcome).toBe('reapplied');
    expect(read('b.txt')).toBe('b mine\n');
    expect(await git.stashList()).toEqual([]);
  });

  it('re-apply with conflicts opens a session that can be finished', async () => {
    await setup();
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'mine\n');
    const p = await handlers['git:switchPreview']({ repoId: repo.id, target: 'other', kind: 'local' });
    expect(p.canReapply).toBe(true);
    const r = await handlers['git:switchExecute']({ repoId: repo.id, confirmationId: p.confirmationId, strategy: 'stash-apply' });
    expect(r.outcome).toBe('conflicts');
    expect(r.conflicted).toEqual(['a.txt']);
    const s = await handlers['git:switchSession']({ repoId: repo.id });
    expect(s).toMatchObject({ from: 'main', to: 'other', stashExists: true });
    await expect(handlers['git:switchFinish']({ repoId: repo.id, dropBackup: true })).rejects.toThrow(/still have conflicts/);
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'resolved\n');
    await git.markResolved('a.txt');
    const f = await handlers['git:switchFinish']({ repoId: repo.id, dropBackup: true });
    expect(f.droppedBackup).toBe(true);
    expect(await handlers['git:switchSession']({ repoId: repo.id })).toBeNull();
    const st = await git.status();
    expect(st.staged).toEqual([]);
    expect(st.unstaged.map((x) => x.path)).toEqual(['a.txt']);
    expect(await git.stashList()).toEqual([]);
  });

  it('undo returns to the source branch with the original changes', async () => {
    await setup();
    fs.writeFileSync(path.join(git.root, 'a.txt'), 'mine\n');
    fs.writeFileSync(path.join(git.root, 'extra.txt'), 'untracked of mine\n');
    const p = await handlers['git:switchPreview']({ repoId: repo.id, target: 'other', kind: 'local' });
    await handlers['git:switchExecute']({ repoId: repo.id, confirmationId: p.confirmationId, strategy: 'stash-apply' });
    const u = await handlers['git:switchUndo']({ repoId: repo.id, returnToSource: true, confirmed: true });
    expect(u.restored).toBe(true);
    expect((await git.status()).branch).toBe('main');
    expect(read('a.txt')).toBe('mine\n');
    expect(read('extra.txt')).toBe('untracked of mine\n');
    expect(await git.stashList()).toEqual([]);
    expect(await handlers['git:switchSession']({ repoId: repo.id })).toBeNull();
  });

  it('checks out a remote branch as a new tracking branch', async () => {
    const p0 = await handlers['git:publishPreview']({ repoId: repo.id, name: 'remote-only' });
    await handlers['git:publishExecute']({ repoId: repo.id, confirmationId: p0.confirmationId, auth: NONE, switchTo: false });
    await git.deleteBranch('remote-only', true);
    const p = await handlers['git:switchPreview']({ repoId: repo.id, target: 'origin/remote-only', kind: 'remote' });
    expect(p.createsLocalFrom).toBe('origin/remote-only');
    await handlers['git:switchExecute']({ repoId: repo.id, confirmationId: p.confirmationId, strategy: 'carry' });
    const st = await git.status();
    expect(st.branch).toBe('remote-only');
    expect(st.upstream).toBe('origin/remote-only');
  });
});

function hasKeygen(): string | null {
  try {
    return sshKeygenBinary(execFileSync('git', ['--exec-path']).toString().trim());
  } catch {
    return null;
  }
}
const keygen = hasKeygen();

describe.skipIf(!keygen)('SSH key generation', () => {
  it('generates an ed25519 key with a passphrase (via askpass, never on the command line) and never overwrites', async () => {
    const dir = path.join(tmp, 'ssh');
    const file = path.join(dir, 'id_ed25519');
    const pass = "s3cret 'pass' $phrase";
    await generateSshKey({ type: 'ed25519', file, comment: 'me@example.com', passphrase: pass }, keygen!);
    const info = inspectSshKey(file);
    expect(info.encrypted).toBe(true);
    expect(await verifySshPassphrase(file, pass, keygen!)).toBe(true);
    const keys = listLocalPublicKeys(dir);
    expect(keys).toHaveLength(1);
    expect(keys[0].privatePath).toBe(file);
    expect(keys[0].parsed.fingerprint).toBe(info.fingerprint);
    expect(keys[0].publicKey).toMatch(/^ssh-ed25519 \S+ me@example\.com$/);
    await expect(generateSshKey({ type: 'ed25519', file, comment: '', passphrase: '' }, keygen!)).rejects.toThrow(/already exists/);
  });

  it('generates an unencrypted key when no passphrase is given', async () => {
    const file = path.join(tmp, 'ssh2', 'id_plain');
    await generateSshKey({ type: 'ed25519', file, comment: '', passphrase: '' }, keygen!);
    expect(inspectSshKey(file).encrypted).toBe(false);
  });
});
