import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/GitService';
import { runGit } from '../src/main/git/runner';

let git: GitService;
const read = (f: string) => fs.readFileSync(path.join(git.root, f), 'utf8').replace(/\r\n/g, '\n');
const write = (f: string, c: string) => fs.writeFileSync(path.join(git.root, f), c);

async function commit(msg: string) {
  await git.stageAll();
  return git.commit(msg, 'none');
}

/** main and qa both edit a.txt and b.txt; merging qa into main conflicts on both. */
beforeEach(async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-cu-')));
  git = await GitService.init(path.join(tmp, 'w'), 'main');
  await git.setIdentity('T', 't@example.com');
  write('a.txt', 'base a\n');
  write('b.txt', 'base b\n');
  await commit('base');
  await git.createBranch('qa', null, true);
  write('a.txt', 'qa a\n');
  write('b.txt', 'qa b\n');
  await commit('qa edits');
  await git.switchBranch('main');
  write('a.txt', 'main a\n');
  write('b.txt', 'main b\n');
  const head = await commit('main edits');
  expect(await git.merge(await git.revParse('refs/heads/qa'), { message: "Merge branch 'qa' into main" })).toBe(true);
  void head;
});

describe('conflict sides and undo', () => {
  it('names the current and incoming branches', async () => {
    const s = await git.conflictSides();
    expect(s).toMatchObject({ operation: 'merge', current: 'main', incoming: 'qa' });
  });

  it('undo after "accept incoming" restores the original conflict', async () => {
    const original = read('a.txt');
    expect(original).toContain('<<<<<<<');
    await git.snapshotConflict('a.txt');
    await git.takeSide('a.txt', 'theirs');
    expect(read('a.txt')).toBe('qa a\n');
    const snaps = await git.readConflictSnapshots();
    expect(await git.conflictChanged('a.txt', snaps['a.txt'])).toBe(true);

    await git.restoreConflict('a.txt');
    expect(read('a.txt')).toBe(original);
    expect((await git.status()).conflicted.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
    // ours/theirs still work after the undo, proving the index stages are back.
    await git.takeSide('a.txt', 'ours');
    expect(read('a.txt')).toBe('main a\n');
  });

  it('undo after "mark as resolved" reopens the conflict', async () => {
    const original = read('b.txt');
    await git.snapshotConflict('b.txt');
    await git.takeSide('b.txt', 'theirs');
    await git.markResolved('b.txt');
    expect((await git.status()).conflicted.map((c) => c.path)).toEqual(['a.txt']);

    await git.restoreConflict('b.txt');
    expect((await git.status()).conflicted.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(read('b.txt')).toBe(original);
  });

  it('accepting all incoming then continuing works, and snapshots are cleared', async () => {
    for (const f of ['a.txt', 'b.txt']) {
      await git.snapshotConflict(f);
      await git.takeSide(f, 'theirs');
      await git.markResolved(f);
    }
    expect((await git.status()).conflicted).toEqual([]);
    await git.continueOperation('none');
    await git.clearConflictSnapshots();
    expect(read('a.txt')).toBe('qa a\n');
    expect(await git.readConflictSnapshots()).toEqual({});
    expect((await runGit({ cwd: git.root, args: ['log', '-1', '--format=%s'] })).stdout.trim()).toBe("Merge branch 'qa' into main");
  });
});
