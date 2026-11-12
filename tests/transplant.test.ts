import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/GitService';
import { runGit } from '../src/main/git/runner';

let dir: string;
let git: GitService;
const g = async (...args: string[]) => (await runGit({ cwd: dir, args })).stdout.trim();
async function commit(file: string, content: string, msg: string) {
  fs.writeFileSync(path.join(dir, file), content);
  await g('add', '-A');
  await g('-c', 'commit.gpgSign=false', 'commit', '-q', '-m', msg);
}
const exists = (f: string) => fs.existsSync(path.join(dir, f));

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-tp-')));
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'T');
  await g('config', 'user.email', 't@e.x');
  await g('config', 'commit.gpgSign', 'false');
  await commit('title.txt', 'Old title\n', 'base');
  // QA has a lot of changes main does not have yet.
  await g('switch', '-q', '-c', 'qa');
  for (let i = 1; i <= 5; i++) await commit(`qa-${i}.txt`, `qa ${i}\n`, `qa work ${i}`);
  // title-change is made from QA and changes one file.
  await g('switch', '-q', '-c', 'title-change');
  await commit('title.txt', 'New title\n', 'Change the title');
  await g('switch', '-q', 'main');
  git = new GitService(dir);
});

describe('transplant: only a branch’s own changes', () => {
  it('previews just the one commit and what is left behind', async () => {
    const p = await git.transplantPreview('title-change', 'qa', 'main');
    expect(p.commits.map((c) => c.subject)).toEqual(['Change the title']);
    expect(p.files).toEqual(['title.txt']);
    expect(p.leftBehind).toBe(5);
    expect(p.commits[0].alreadyInTarget).toBe(false);
  });

  it('brings only title-change’s commit into a new branch from main', async () => {
    const p = await git.transplantPreview('title-change', 'qa', 'main');
    const r = await git.transplant({ target: 'main', commits: p.commits.map((c) => c.hash), into: 'new-branch', newBranch: 'title-change-to-main', expectedTarget: p.targetOid, returnToCurrent: true });
    expect(r.outcome).toBe('done');
    expect(r.returnedTo).toBe('main');
    const files = await g('ls-tree', '--name-only', 'title-change-to-main');
    expect(files.split('\n')).toEqual(['title.txt']); // no qa-*.txt
    expect(await g('show', 'title-change-to-main:title.txt')).toBe('New title');
    expect(await g('rev-parse', 'title-change-to-main~1')).toBe(await g('rev-parse', 'main'));
  });

  it('applies directly onto main with a backup, and flags commits already there', async () => {
    let p = await git.transplantPreview('title-change', 'qa', 'main');
    const r = await git.transplant({ target: 'main', commits: [p.commits[0].hash], into: 'target', expectedTarget: p.targetOid, returnToCurrent: true });
    expect(r.outcome).toBe('done');
    expect(exists('qa-1.txt')).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'title.txt'), 'utf8').trim()).toBe('New title');
    expect(await g('rev-parse', r.backupRef!)).toBe(p.targetOid);
    p = await git.transplantPreview('title-change', 'qa', 'main');
    expect(p.commits[0].alreadyInTarget).toBe(true);
  });

  it('refuses when the target moved since the preview', async () => {
    const p = await git.transplantPreview('title-change', 'qa', 'main');
    await commit('other.txt', 'x\n', 'main moved');
    await expect(git.transplant({ target: 'main', commits: [p.commits[0].hash], into: 'new-branch', newBranch: 'x', expectedTarget: p.targetOid, returnToCurrent: true })).rejects.toThrow(/changed since/);
  });
});

describe('transplant: only selected files and lines', () => {
  it('brings one file of two, and only the chosen line of it', async () => {
    await g('switch', '-q', 'title-change');
    fs.writeFileSync(path.join(dir, 'title.txt'), 'New title\nSecond line\n');
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'do not bring me\n');
    await g('add', '-A');
    await g('-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'more title work');
    await g('switch', '-q', 'main');
    const p = await git.transplantPreview('title-change', 'qa', 'main');
    const changes = await git.branchChanges('title-change', 'qa');
    const d = changes.diffs.find((x) => x.newPath === 'title.txt')!;
    // Pick "-Old title" and "+New title" only (not "+Second line").
    const lines = d.hunks[0].lines.map((l, k) => ((l.type === 'del' && l.content === 'Old title') || (l.type === 'add' && l.content === 'New title') ? k : -1)).filter((k) => k >= 0);
    const r = await git.transplantPick({ source: 'title-change', base: 'qa', target: 'main', into: 'new-branch', newBranch: 'pick', expectedTarget: p.targetOid, returnToCurrent: true, message: 'Bring the title', selection: [{ path: 'title.txt', hunks: [{ hunk: 0, lines }] }] });
    expect(r.outcome).toBe('done');
    expect((await g('ls-tree', '--name-only', 'pick')).split('\n')).toEqual(['title.txt']);
    expect(await g('show', 'pick:title.txt')).toBe('New title');
    expect(await g('rev-parse', 'pick~1')).toBe(await g('rev-parse', 'main'));
  });
});

describe('Merge Studio selection in "Everything" mode', () => {
  it('merges only the ticked file even though the branch also carries all of QA', async () => {
    const p = await git.transplantPreview('title-change', 'main', 'main');
    const all = await git.branchChanges('title-change', 'main');
    expect(all.files.map((f) => f.path).sort()).toEqual(['qa-1.txt', 'qa-2.txt', 'qa-3.txt', 'qa-4.txt', 'qa-5.txt', 'title.txt']);
    const r = await git.transplantPick({ source: 'title-change', base: 'main', target: 'main', into: 'new-branch', newBranch: 'only-title', expectedTarget: p.targetOid, returnToCurrent: true, message: 'Only the title', selection: [{ path: 'title.txt' }] });
    expect(r.outcome).toBe('done');
    expect((await g('ls-tree', '--name-only', 'only-title')).split('\n')).toEqual(['title.txt']);
    expect(await g('diff', '--no-ext-diff', '--name-only', 'main', 'only-title')).toBe('title.txt');
  });
});

describe('Merge Studio selection by commit', () => {
  it('merges only the ticked commit although the branch also carries five QA commits', async () => {
    const p = await git.transplantPreview('title-change', 'main', 'main');
    expect(p.commits.length).toBe(6);
    const title = p.commits.find((c) => c.subject === 'Change the title')!;
    const r = await git.transplant({ target: 'main', commits: [title.hash], into: 'new-branch', newBranch: 'only-that-commit', expectedTarget: p.targetOid, returnToCurrent: true });
    expect(r.outcome).toBe('done');
    expect(await g('diff', '--no-ext-diff', '--name-only', 'main', 'only-that-commit')).toBe('title.txt');
    expect(await g('rev-list', '--count', 'main..only-that-commit')).toBe('1');
  });
});
