import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/GitService';
import { runGit } from '../src/main/git/runner';

let dir: string;
let git: GitService;
const g = async (...args: string[]) => (await runGit({ cwd: dir, args: args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-color', ...args.slice(1)] : args })).stdout;
const write = (name: string, s: string) => fs.writeFileSync(path.join(dir, name), s);
const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-partial-')));
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'T');
  await g('config', 'user.email', 't@e.x');
  await g('config', 'core.autocrlf', 'false');
  write('a.txt', lines(30));
  await g('add', '-A');
  await g('-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'init');
  git = new GitService(dir);
});

/** Two separate hunks: line 2 and line 25 changed. */
const twoHunks = () => write('a.txt', lines(30, (i) => (i === 2 ? 'TWO' : i === 25 ? 'TWENTY-FIVE' : `line ${i}`)));

describe('partial staging', () => {
  it('stages one hunk of two', async () => {
    twoHunks();
    const d = (await git.diffFile('a.txt', 'unstaged'))!;
    expect(d.hunks.length).toBe(2);
    await git.applySelection('a.txt', 'stage', [{ hunk: 1 }]);
    const staged = await g('diff', '--cached');
    expect(staged).toContain('+TWENTY-FIVE');
    expect(staged).not.toContain('+TWO');
    expect(await g('diff')).toContain('+TWO');
  });

  it('stages only the selected line of a hunk', async () => {
    write('a.txt', lines(30, (i) => (i === 10 ? 'TEN' : i === 11 ? 'ELEVEN' : `line ${i}`)));
    const d = (await git.diffFile('a.txt', 'unstaged'))!;
    const h = d.hunks[0];
    // Pick the "-line 10" and "+TEN" lines only.
    const pick = h.lines.map((l, k) => ((l.type === 'del' && l.content === 'line 10') || (l.type === 'add' && l.content === 'TEN') ? k : -1)).filter((k) => k >= 0);
    await git.applySelection('a.txt', 'stage', [{ hunk: 0, lines: pick }]);
    const staged = await g('diff', '--cached');
    expect(staged).toContain('+TEN');
    expect(staged).not.toContain('ELEVEN');
    expect(read('a.txt')).toContain('ELEVEN'); // working file untouched
  });

  it('unstages one hunk', async () => {
    twoHunks();
    await g('add', 'a.txt');
    await git.applySelection('a.txt', 'unstage', [{ hunk: 0 }]);
    const staged = await g('diff', '--cached');
    expect(staged).not.toContain('+TWO');
    expect(staged).toContain('+TWENTY-FIVE');
  });

  it('discards selected lines from the working file and keeps a patch backup', async () => {
    twoHunks();
    const backup = path.join(dir, '..', `gb-backup-${Date.now()}.patch`);
    await git.applySelection('a.txt', 'discard', [{ hunk: 0 }], backup);
    expect(read('a.txt')).toContain('line 2\n');
    expect(read('a.txt')).toContain('TWENTY-FIVE');
    expect(fs.readFileSync(backup, 'utf8')).toContain('+TWO');
  });

  it('keeps CRLF line endings and files without a final newline intact', async () => {
    write('c.txt', 'one\r\ntwo\r\nthree');
    await g('add', 'c.txt');
    await g('-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'crlf');
    write('c.txt', 'ONE\r\ntwo\r\nTHREE');
    const d = (await git.diffFile('c.txt', 'unstaged'))!;
    const pick = d.hunks[0].lines.map((l, k) => (l.content.startsWith('THREE') || l.content.startsWith('three') ? k : -1)).filter((k) => k >= 0);
    await git.applySelection('c.txt', 'stage', [{ hunk: 0, lines: pick }]);
    const blob = await g('show', ':c.txt');
    expect(blob).toBe('one\r\ntwo\r\nTHREE');
  });

  it('reports line counts per file', async () => {
    twoHunks();
    const s = await git.changeStats();
    expect(s.unstaged['a.txt']).toEqual([2, 2]);
  });
});
