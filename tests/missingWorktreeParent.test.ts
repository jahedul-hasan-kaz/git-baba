import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parentOfMissingWorktree } from '../src/main/git/worktrees';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-wt-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('parentOfMissingWorktree', () => {
  it('finds the repository from its worktree records', () => {
    const root = tmp();
    const repo = path.join(root, 'app');
    const gone = path.join(root, 'elsewhere', 'feature-x');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'feature-x'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'feature-x', 'gitdir'), path.join(gone, '.git') + '\n');
    expect(parentOfMissingWorktree(gone, [{ id: 'a', path: repo }, { id: 'w', path: gone }])?.id).toBe('a');
  });

  it('falls back to the folder name, preferring the longest repository name', () => {
    const root = tmp();
    const web = path.join(root, 'inride-agent-web-ui');
    const short = path.join(root, 'inride-agent');
    fs.mkdirSync(path.join(web, '.git'), { recursive: true });
    fs.mkdirSync(path.join(short, '.git'), { recursive: true });
    const gone = path.join(root, 'worktrees', 'inride-agent-web-ui-include-rules');
    expect(parentOfMissingWorktree(gone, [{ id: 's', path: short }, { id: 'w', path: web }])?.id).toBe('w');
  });

  it('returns null when nothing matches', () => {
    const root = tmp();
    expect(parentOfMissingWorktree(path.join(root, 'lonely'), [{ id: 'a', path: path.join(root, 'other') }])).toBeNull();
  });
});
