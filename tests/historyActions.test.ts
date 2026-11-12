import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/GitService';
import { runGit } from '../src/main/git/runner';

let dir: string;
let git: GitService;
const g = async (...args: string[]) => (await runGit({ cwd: dir, args })).stdout.trim();

async function commit(name: string, content: string, msg: string): Promise<string> {
  fs.writeFileSync(path.join(dir, name), content);
  await g('add', '-A');
  await g('-c', 'commit.gpgSign=false', 'commit', '-q', '-m', msg);
  return g('rev-parse', 'HEAD');
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hist-')));
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'Test');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'commit.gpgSign', 'false');
  git = new GitService(dir);
});

describe('history actions', () => {
  it('hard reset saves uncommitted work and the old tip, and undo restores both', async () => {
    const a = await commit('a.txt', 'one\n', 'first');
    const b = await commit('a.txt', 'two\n', 'second');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');

    const preview = await git.resetPreview(a);
    expect(preview.leaving.map((c) => c.hash)).toEqual([b]);
    expect(preview.unpushed).toEqual([b]);
    expect(preview.working.unstaged).toBe(1);

    const r = await git.historyReset(a, 'hard', b);
    expect(await g('rev-parse', 'HEAD')).toBe(a);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n');
    expect(await g('rev-parse', r.backupRef)).toBe(b);
    expect(r.wipRef).toBeTruthy();

    await git.undoReset(r.previousOid, 'hard', r.wipRef);
    expect(await g('rev-parse', 'HEAD')).toBe(b);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('dirty\n');
  });

  it('refuses a reset when HEAD moved since the preview', async () => {
    const a = await commit('a.txt', '1\n', 'first');
    await commit('a.txt', '2\n', 'second');
    await expect(git.historyReset(a, 'soft', a)).rejects.toThrow(/HEAD changed/);
  });

  it('soft reset keeps changes staged and undo moves the branch back', async () => {
    const a = await commit('a.txt', '1\n', 'first');
    const b = await commit('a.txt', '2\n', 'second');
    const r = await git.historyReset(a, 'soft', b);
    expect((await git.status()).staged.length).toBe(1);
    await git.undoReset(r.previousOid, 'soft', null);
    expect(await g('rev-parse', 'HEAD')).toBe(b);
    expect((await git.status()).staged.length).toBe(0);
  });

  it('cherry-picks a commit from another branch and reports conflicts', async () => {
    await commit('a.txt', 'base\n', 'base');
    await g('switch', '-q', '-c', 'feature');
    const f = await commit('b.txt', 'feature\n', 'add b');
    const clash = await commit('a.txt', 'feature side\n', 'change a');
    await g('switch', '-q', 'main');
    await commit('a.txt', 'main side\n', 'main change');

    const ok = await git.historyCherryPick(f, {});
    expect(ok.outcome).toBe('done');
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(true);

    const bad = await git.historyCherryPick(clash, {});
    expect(bad.outcome).toBe('conflicts');
    expect(bad.conflicted).toEqual(['a.txt']);
    await git.abortOperation();
  });

  it('previews and runs a rebase onto another commit', async () => {
    await commit('a.txt', 'base\n', 'base');
    await g('switch', '-q', '-c', 'feature');
    await commit('f.txt', 'f\n', 'feature work');
    await g('switch', '-q', 'main');
    const m = await commit('m.txt', 'm\n', 'main work');
    await g('switch', '-q', 'feature');
    const head = await g('rev-parse', 'HEAD');

    const p = await git.rebasePreview(m);
    expect(p.replay.map((c) => c.subject)).toEqual(['feature work']);
    expect(p.fastForward).toBe(false);

    const r = await git.historyRebase(m, head);
    expect(r.outcome).toBe('done');
    expect(await g('rev-parse', 'HEAD~1')).toBe(m);
  });

  it('creates tags, patches and detached checkouts', async () => {
    const a = await commit('a.txt', '1\n', 'first');
    await commit('a.txt', '2\n', 'second: tweak');
    await git.createTagAt(a, 'v1.0', 'Release 1');
    expect(await g('rev-parse', 'v1.0^{commit}')).toBe(a);
    await expect(git.createTagAt(a, 'v1.0')).rejects.toThrow(/exists/i);
    await expect(git.createTagAt(a, 'bad name')).rejects.toThrow(/valid/i);

    const p = await git.commitPatch(a);
    expect(p.patch).toContain('Subject: [PATCH] first');
    expect(p.fileName).toMatch(/^[0-9a-f]{8}-first\.patch$/);

    await git.checkoutCommit(a);
    expect((await git.status()).detached).toBe(true);
  });
});

describe('rename branch', () => {
  it('renames an unpublished branch, refuses clashes and published branches', async () => {
    await commit('a.txt', '1\n', 'first');
    await g('branch', 'feature-x');
    await g('branch', 'taken');
    await git.renameBranch('feature-x', 'feature-y');
    expect((await g('branch', '--list', 'feature-y')).includes('feature-y')).toBe(true);
    await expect(git.renameBranch('feature-y', 'taken')).rejects.toThrow(/already exists/);
    await expect(git.renameBranch('feature-y', 'bad name')).rejects.toThrow(/valid/);
    await g('update-ref', 'refs/remotes/origin/feature-y', 'HEAD');
    await expect(git.renameBranch('feature-y', 'feature-z')).rejects.toThrow(/published|remote/i);
  });
});
