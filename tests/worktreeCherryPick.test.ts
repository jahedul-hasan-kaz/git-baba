import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/GitService';
import { Worktrees } from '../src/main/git/worktrees';

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('worktree approach: pick commits into a branch checked out in another folder', () => {
  it('applies only the selected commit to qa, leaving the feature worktree untouched', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-wt-'));
    const main = path.join(root, 'main');
    fs.mkdirSync(main);
    g(main, 'init', '-q', '-b', 'qa');
    g(main, 'config', 'user.email', 't@t');
    g(main, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(main, 'a.txt'), 'a');
    g(main, 'add', '.');
    g(main, 'commit', '-qm', 'base');
    const feat = path.join(root, 'feat');
    g(main, 'worktree', 'add', '-q', '-b', 'feature/x', feat);
    fs.writeFileSync(path.join(feat, 'one.txt'), '1');
    g(feat, 'add', '.');
    g(feat, 'commit', '-qm', 'one');
    const one = g(feat, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(feat, 'two.txt'), '2');
    g(feat, 'add', '.');
    g(feat, 'commit', '-qm', 'two');
    const featHead = g(feat, 'rev-parse', 'HEAD');

    // Same routing as the handler: the folder holding qa does the work.
    const holder = (await new Worktrees(feat).list()).find((w) => w.branch === 'qa')!;
    expect(path.resolve(holder.path).toLowerCase()).toBe(path.resolve(main).toLowerCase());
    const r = await new GitService(holder.path).transplant({ target: 'qa', commits: [one], into: 'target', expectedTarget: g(main, 'rev-parse', 'qa'), returnToCurrent: true });

    expect(r.outcome).toBe('done');
    expect(fs.existsSync(path.join(main, 'one.txt'))).toBe(true);
    expect(fs.existsSync(path.join(main, 'two.txt'))).toBe(false);
    expect(g(feat, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x');
    expect(g(feat, 'rev-parse', 'HEAD')).toBe(featHead);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
