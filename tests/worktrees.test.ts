import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mainWorktreeOf, parseWorktreeList, Worktrees } from '../src/main/git/worktrees';

describe('parseWorktreeList', () => {
  it('reads branches, detached heads, locks and prunable entries', () => {
    const out = [
      'worktree /r',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /r-x',
      'HEAD bbb',
      'detached',
      'locked on a USB drive',
      '',
      'worktree /gone',
      'HEAD ccc',
      'branch refs/heads/feature/a',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    expect(parseWorktreeList(out)).toEqual([
      { path: '/r', head: 'aaa', branch: 'main', bare: false, locked: false, prunable: false },
      { path: '/r-x', head: 'bbb', branch: null, bare: false, locked: true, lockReason: 'on a USB drive', prunable: false },
      { path: '/gone', head: 'ccc', branch: 'feature/a', bare: false, locked: false, prunable: true },
    ]);
  });
});

describe('Worktrees (real git)', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  const setup = () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-wt-')));
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'branch', 'side');
    return { base, repo, trees: new Worktrees(repo) };
  };

  it('adds, lists, locks and removes worktrees', async () => {
    const { base, repo, trees } = setup();
    const dir = path.join(base, 'repo-side');
    const added = await trees.add(dir, { branch: 'side', create: false });
    expect(added).toMatchObject({ branch: 'side', main: false, current: false, changes: 0, subject: 'first' });

    const fresh = await trees.add(path.join(base, 'repo-new'), { branch: 'feature/new', create: true, base: 'main' });
    expect(fresh.branch).toBe('feature/new');

    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    const list = await trees.list();
    expect(list[0]).toMatchObject({ branch: 'main', main: true, current: true });
    expect(list.map((w) => w.branch).sort()).toEqual(['feature/new', 'main', 'side']);
    expect(list.find((w) => w.branch === 'side')?.changes).toBe(1);

    await trees.lock(dir, true, 'testing');
    expect((await trees.get(dir)).locked).toBe(true);
    await expect(trees.remove(dir, true)).rejects.toThrow(/Unlock/);
    await trees.lock(dir, false);
    await expect(trees.remove(dir, false)).rejects.toThrow();
    await trees.remove(dir, true);
    expect(fs.existsSync(dir)).toBe(false);
    await expect(trees.remove(repo, true)).rejects.toThrow(/main working tree/);
  });

  it('refuses a non-empty folder and paths that are not its worktrees', async () => {
    const { base, trees } = setup();
    const busy = path.join(base, 'busy');
    fs.mkdirSync(busy);
    fs.writeFileSync(path.join(busy, 'x'), 'x');
    await expect(trees.add(busy, { branch: 'side', create: false })).rejects.toThrow(/not empty/);
    await expect(trees.get(base)).rejects.toThrow(/not a worktree/);
  });

  it('finds the main folder of a linked worktree', async () => {
    const { base, repo, trees } = setup();
    const dir = path.join(base, 'repo-side');
    await trees.add(dir, { branch: 'side', create: false });
    expect(path.resolve(mainWorktreeOf(dir) ?? '').toLowerCase()).toBe(path.resolve(repo).toLowerCase());
    expect(mainWorktreeOf(repo)).toBeNull();
    expect(mainWorktreeOf(base)).toBeNull();
  });

  it('cleans up worktrees whose folder is gone', async () => {
    const { base, trees } = setup();
    const dir = path.join(base, 'repo-side');
    await trees.add(dir, { branch: 'side', create: false });
    fs.rmSync(dir, { recursive: true, force: true });
    expect((await trees.list())[1].prunable).toBe(true);
    expect(await trees.prune()).toBe(1);
    expect(await trees.list()).toHaveLength(1);
  });
  it('keeps worktrees started from develop up to date with it, safely', async () => {
    const { base, repo, trees } = setup();
    git(repo, 'branch', 'develop');
    const dev = path.join(base, 'dev');
    const u1 = path.join(base, 'u1');
    const u2 = path.join(base, 'u2');
    await trees.add(dev, { branch: 'develop', create: false });
    await trees.add(u1, { branch: 'feature/u1', create: true, base: 'develop' });
    await trees.add(u2, { branch: 'feature/u2', create: true, base: 'develop' });
    expect(git(repo, 'config', '--get', 'branch.feature/u1.gbBase').trim()).toBe('develop');

    // Someone commits to develop in another worktree.
    fs.writeFileSync(path.join(dev, 'shared.txt'), 'from develop');
    git(dev, 'add', '.');
    git(dev, 'commit', '-q', '-m', 'develop moves on');
    const list = await trees.list(true);
    const w2 = list.find((w) => w.branch === 'feature/u2');
    expect(w2?.drift?.base).toMatchObject({ name: 'develop', ref: 'develop', behind: 1, ahead: 0 });
    expect(w2?.drift?.base?.authors[0]).toMatchObject({ name: 'T', count: 1 });

    // Uncommitted work is set aside and put back.
    fs.writeFileSync(path.join(u2, 'mine.txt'), 'wip');
    const r2 = await trees.sync(u2, { source: 'base', mode: 'merge', onConflict: 'abort' });
    expect(r2).toMatchObject({ status: 'synced', commits: 1, conflicts: [] });
    expect(fs.readFileSync(path.join(u2, 'shared.txt'), 'utf8')).toBe('from develop');
    expect(fs.readFileSync(path.join(u2, 'mine.txt'), 'utf8')).toBe('wip');
    expect((await trees.sync(u2, { source: 'base', mode: 'merge', onConflict: 'abort' })).status).toBe('up-to-date');

    // A clash rolls back by default, or stays to be resolved.
    fs.writeFileSync(path.join(u1, 'shared.txt'), 'mine');
    git(u1, 'add', '.');
    git(u1, 'commit', '-q', '-m', 'u1 work');
    const head = git(u1, 'rev-parse', 'HEAD');
    const rolled = await trees.sync(u1, { source: 'base', mode: 'rebase', onConflict: 'abort' });
    expect(rolled).toMatchObject({ status: 'conflict', kept: false, conflicts: ['shared.txt'] });
    expect(git(u1, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(u1, 'status', '--porcelain')).toBe('');
    const kept = await trees.sync(u1, { source: 'base', mode: 'merge', onConflict: 'keep' });
    expect(kept).toMatchObject({ status: 'conflict', kept: true });
    expect(git(u1, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('shared.txt');
    git(u1, 'merge', '--abort');

    // The base can be changed or reset per branch.
    await trees.setBase(u1, 'main');
    expect((await trees.list(true)).find((w) => w.branch === 'feature/u1')?.drift).toMatchObject({ baseChosen: true, base: { name: 'main' } });
    await trees.setBase(u1, null);
    expect((await trees.list(true)).find((w) => w.branch === 'feature/u1')?.drift?.baseChosen).toBe(false);
  });
});
