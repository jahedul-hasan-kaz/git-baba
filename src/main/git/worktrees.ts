import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorktreeInfo } from '../../shared/types';
import { isValidBranchName } from '../util/validate';
import { AppError } from './errors';
import { runGit } from './runner';

/** `git worktree list --porcelain` as records (without status details). */
export function parseWorktreeList(out: string): Omit<WorktreeInfo, 'current' | 'changes' | 'main'>[] {
  const list: Omit<WorktreeInfo, 'current' | 'changes' | 'main'>[] = [];
  let cur: Omit<WorktreeInfo, 'current' | 'changes' | 'main'> | null = null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, head: '', bare: false, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
      if (line.length > 7) cur.lockReason = line.slice(7);
    } else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return list;
}

const same = (a: string, b: string) => {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Git worktrees of the repository at `root` (the folder this window shows). */
export class Worktrees {
  constructor(private readonly root: string) {}

  private git(args: string[], cwd = this.root) {
    return runGit({ cwd, args, timeoutMs: 60_000 });
  }

  async list(): Promise<WorktreeInfo[]> {
    const out = await this.git(['worktree', 'list', '--porcelain']);
    const raw = parseWorktreeList(out.stdout);
    return Promise.all(
      raw.map(async (w, i) => {
        const exists = !w.bare && fs.existsSync(w.path);
        let changes: number | null = null;
        let subject: string | undefined;
        let date: string | undefined;
        if (exists && !w.prunable) {
          const [st, log] = await Promise.all([
            this.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], w.path).catch(() => null),
            w.head ? this.git(['log', '-1', '--format=%s%x00%cI', w.head], w.path).catch(() => null) : Promise.resolve(null),
          ]);
          // -z: entries are NUL-separated; a rename carries a second (original) path.
          if (st) changes = st.stdout.split('\0').filter((e) => /^[ MADRCU?!]{2} /.test(e)).length;
          if (log) [subject, date] = log.stdout.trim().split('\0');
        }
        return { ...w, prunable: w.prunable || (!w.bare && !exists), main: i === 0, current: same(w.path, this.root), changes, subject, date };
      }),
    );
  }

  /** Finds a worktree of this repository by path (only those paths are ever acted on). */
  async get(p: string): Promise<WorktreeInfo> {
    const w = (await this.list()).find((x) => same(x.path, p));
    if (!w) throw new AppError({ code: 'worktree-not-found', title: 'Worktree Not Found', message: `${p} is not a worktree of this repository.` });
    return w;
  }

  /**
   * Adds a worktree at `dir` with `branch` checked out — an existing local branch, or a new one from `base`.
   * The folder must not exist yet (or be empty).
   */
  async add(dir: string, opts: { branch: string; create: boolean; base?: string }): Promise<WorktreeInfo> {
    if (!path.isAbsolute(dir)) throw new AppError({ code: 'invalid-path', title: 'Invalid Folder', message: 'Choose a full folder path for the worktree.' });
    if (!isValidBranchName(opts.branch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${opts.branch}" is not a valid branch name.` });
    if (opts.base && (opts.base.startsWith('-') || /\s/.test(opts.base))) throw new AppError({ code: 'invalid-ref', title: 'Invalid Starting Point', message: `"${opts.base}" is not a valid branch or commit.` });
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      throw new AppError({ code: 'folder-not-empty', title: 'Folder Not Empty', message: `${dir} already exists and is not empty. Choose a new folder for the worktree.` });
    }
    const args = opts.create ? ['worktree', 'add', '-b', opts.branch, '--', dir, ...(opts.base ? [opts.base] : [])] : ['worktree', 'add', '--', dir, opts.branch];
    await this.git(args);
    return this.get(dir);
  }

  async remove(p: string, force: boolean): Promise<void> {
    const w = await this.get(p);
    if (w.main) throw new AppError({ code: 'main-worktree', title: 'Main Worktree', message: 'The main working tree cannot be removed — it is the repository itself.' });
    if (w.current) throw new AppError({ code: 'current-worktree', title: 'Worktree Is Open', message: 'Switch this window to another worktree before removing this one.' });
    if (w.locked) throw new AppError({ code: 'worktree-locked', title: 'Worktree Is Locked', message: `Unlock it first${w.lockReason ? ` (locked: ${w.lockReason})` : ''}.` });
    if (w.prunable) {
      await this.git(['worktree', 'prune']);
      return;
    }
    await this.git(['worktree', 'remove', ...(force ? ['--force'] : []), '--', w.path]);
  }

  async lock(p: string, lock: boolean, reason?: string): Promise<void> {
    const w = await this.get(p);
    if (w.main) throw new AppError({ code: 'main-worktree', title: 'Main Worktree', message: 'The main working tree cannot be locked.' });
    await this.git(lock ? ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), '--', w.path] : ['worktree', 'unlock', '--', w.path]);
  }

  async prune(): Promise<number> {
    const before = (await this.list()).filter((w) => w.prunable).length;
    await this.git(['worktree', 'prune']);
    return before;
  }
}
