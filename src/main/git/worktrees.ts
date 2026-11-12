import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorktreeDrift, WorktreeInfo, WorktreeLine, WorktreeSyncMode, WorktreeSyncResult } from '../../shared/types';
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

/**
 * For a linked worktree (its `.git` is a file pointing into another repository's `.git/worktrees/<name>`),
 * the folder of that repository's main working tree; null for an ordinary repository or a bare one.
 */
export function mainWorktreeOf(dir: string): string | null {
  try {
    const dotGit = path.join(dir, '.git');
    if (!fs.statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(dir, m[1].trim());
    let common = path.resolve(gitdir, '..', '..');
    try {
      common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    } catch {
      // Older layouts without a commondir file: <common>/worktrees/<name>.
    }
    return path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : null;
  } catch {
    return null;
  }
}

/**
 * For a worktree whose folder is gone: which of `repos` it belonged to. First from the repositories' own
 * worktree records (`.git/worktrees/<name>/gitdir` still points at the folder until it is pruned), then by
 * name — a worktree folder is usually named after its repository (`<repo>-<branch>`).
 */
export function parentOfMissingWorktree<T extends { id: string; path: string }>(dir: string, repos: T[]): T | null {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  const target = norm(dir);
  const others = repos.filter((r) => norm(r.path) !== target);
  for (const r of others) {
    const root = path.join(r.path, '.git', 'worktrees');
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const gitFile = fs.readFileSync(path.join(root, n, 'gitdir'), 'utf8').trim();
        if (norm(path.dirname(gitFile)) === target) return r;
      } catch {
        // Not a worktree record.
      }
    }
  }
  const base = path.basename(target);
  let best: T | null = null;
  for (const r of others) {
    const name = path.basename(norm(r.path));
    if (name && base.startsWith(`${name}-`) && fs.existsSync(path.join(r.path, '.git')) && (!best || name.length > path.basename(best.path).length)) best = r;
  }
  return best;
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

  /** Every worktree; with `drift`, also how far each one is behind its upstream and its base branch. */
  async list(withDrift = false): Promise<WorktreeInfo[]> {
    const out = await this.git(['worktree', 'list', '--porcelain']);
    const raw = parseWorktreeList(out.stdout);
    let ctx: { remotes: string[]; defaultBranch: string | null } | null = null;
    if (withDrift) {
      const remotes = await this.remotes();
      ctx = { remotes, defaultBranch: await this.defaultBranch(remotes) };
    }
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
        const drift = ctx && w.branch && exists && !w.prunable ? await this.drift(w.branch, ctx).catch(() => undefined) : undefined;
        return { ...w, prunable: w.prunable || (!w.bare && !exists), main: i === 0, current: same(w.path, this.root), changes, subject, date, drift };
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
    // Remember what a new branch was started from, so the worktree can keep up with it (e.g. develop).
    if (opts.create && opts.base) {
      const name = this.stripRemote(opts.base, await this.remotes());
      if (name !== opts.branch && isValidBranchName(name)) await this.git(['config', `branch.${opts.branch}.gbBase`, name]).catch(() => undefined);
    }
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

  // ---------- drift: how each worktree's branch relates to the lines it follows ----------

  /** Remote names, longest first (so "origin-2/x" is not read as "origin"). */
  private async remotes(): Promise<string[]> {
    const out = await this.git(['remote']).catch(() => null);
    return (out?.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  }

  /** "origin/develop" → "develop" when it names a remote branch; otherwise unchanged. */
  private stripRemote(ref: string, remotes: string[]): string {
    const r = remotes.find((x) => ref.startsWith(`${x}/`));
    return r ? ref.slice(r.length + 1) : ref;
  }

  private async exists(ref: string): Promise<boolean> {
    const r = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => null);
    return !!r?.stdout.trim();
  }

  /** The repository's default branch name (origin/HEAD), else main/master when present. */
  private async defaultBranch(remotes: string[]): Promise<string | null> {
    const head = await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => null);
    if (head?.stdout.trim()) return this.stripRemote(head.stdout.trim(), remotes);
    for (const b of ['main', 'master', 'develop']) if ((await this.exists(b)) || (await this.exists(`origin/${b}`))) return b;
    return null;
  }

  /**
   * Of the local branch and its remote copies, the newest one: the one that contains the others. When they
   * have diverged, the remote copy wins (it is what everybody else sees).
   */
  private async freshest(name: string, remotes: string[]): Promise<string | null> {
    const cands: string[] = [];
    if (await this.exists(name)) cands.push(name);
    for (const r of remotes.includes('origin') ? ['origin', ...remotes.filter((x) => x !== 'origin')] : remotes) {
      if (await this.exists(`${r}/${name}`)) cands.push(`${r}/${name}`);
    }
    if (cands.length === 0) return null;
    let best = cands[0];
    for (const c of cands.slice(1)) {
      const r = await this.git(['merge-base', '--is-ancestor', best, c]).then(() => true).catch(() => false);
      if (r) best = c;
      else {
        const back = await this.git(['merge-base', '--is-ancestor', c, best]).then(() => true).catch(() => false);
        if (!back) best = c; // diverged: prefer the remote copy
      }
    }
    return best;
  }

  private async line(branch: string, name: string, ref: string): Promise<WorktreeLine> {
    const counts = await this.git(['rev-list', '--left-right', '--count', `${branch}...${ref}`]).catch(() => null);
    const [ahead, behind] = (counts?.stdout.trim() ?? '0 0').split(/\s+/).map((n) => Number(n) || 0);
    let authors: WorktreeLine['authors'] = [];
    let latest: WorktreeLine['latest'];
    if (behind > 0) {
      const log = await this.git(['log', '--no-merges', '-n', '200', '--format=%an%x00%s%x00%cI', `${branch}..${ref}`]).catch(() => null);
      const rows = (log?.stdout ?? '').split(/\r?\n/).filter(Boolean).map((l) => l.split('\0'));
      const m = new Map<string, number>();
      for (const [a] of rows) m.set(a, (m.get(a) ?? 0) + 1);
      authors = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, count]) => ({ name: n, count }));
      if (rows[0]) latest = { author: rows[0][0], subject: rows[0][1], date: rows[0][2] };
    }
    return { name, ref, ahead, behind, authors, latest };
  }

  /** Drift of one branch: its upstream and its base (saved as branch.<name>.gbBase, else the default branch). */
  async drift(branch: string, ctx?: { remotes: string[]; defaultBranch: string | null }): Promise<WorktreeDrift> {
    const remotes = ctx?.remotes ?? (await this.remotes());
    const def = ctx ? ctx.defaultBranch : await this.defaultBranch(remotes);
    const drift: WorktreeDrift = { baseChosen: false };
    const up = await this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]).catch(() => null);
    const upRef = up?.stdout.trim();
    if (upRef) drift.upstream = await this.line(branch, upRef, upRef);
    const chosen = await this.git(['config', '--get', `branch.${branch}.gbBase`]).catch(() => null);
    const baseName = chosen?.stdout.trim() || def;
    drift.baseChosen = !!chosen?.stdout.trim();
    if (baseName && baseName !== branch) {
      const ref = await this.freshest(baseName, remotes);
      // Following its own upstream is already covered above.
      if (ref && ref !== upRef) drift.base = await this.line(branch, baseName, ref);
    }
    return drift;
  }

  /** Remembers which branch `branch` follows (null forgets it, so the default branch is used). */
  async setBase(p: string, base: string | null): Promise<void> {
    const w = await this.get(p);
    if (!w.branch) throw new AppError({ code: 'detached', title: 'No Branch', message: 'This worktree is on a detached commit; check out a branch first.' });
    if (base === null) {
      await this.git(['config', '--unset', `branch.${w.branch}.gbBase`]).catch(() => undefined);
      return;
    }
    const name = this.stripRemote(base.trim(), await this.remotes());
    if (!isValidBranchName(name)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${base}" is not a valid branch name.` });
    if (name === w.branch) throw new AppError({ code: 'same-branch', title: 'Same Branch', message: 'A branch cannot follow itself.' });
    await this.git(['config', `branch.${w.branch}.gbBase`, name]);
  }

  /**
   * Brings the newest commits of the worktree's upstream or base into it, inside that worktree's own folder.
   * Uncommitted changes are stashed and put back automatically. On a conflict everything is rolled back
   * (nothing changes) unless `onConflict` is 'keep', which leaves the conflict in that worktree to resolve.
   */
  async sync(p: string, opts: { source: 'base' | 'upstream'; mode: WorktreeSyncMode; onConflict: 'abort' | 'keep' }): Promise<WorktreeSyncResult> {
    const w = await this.get(p);
    const res = (status: WorktreeSyncResult['status'], message: string, extra: Partial<WorktreeSyncResult> = {}): WorktreeSyncResult => ({
      path: w.path,
      branch: w.branch,
      status,
      commits: 0,
      conflicts: [],
      kept: false,
      message,
      ...extra,
    });
    if (w.prunable) return res('skipped', 'The worktree folder is missing.');
    if (!w.branch) return res('skipped', 'Detached commit — nothing to follow.');
    const gitDir = (await this.git(['rev-parse', '--git-dir'], w.path)).stdout.trim();
    const abs = path.resolve(w.path, gitDir);
    if (['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((f) => fs.existsSync(path.join(abs, f)))) {
      return res('skipped', 'Another merge or rebase is in progress there — finish it first.');
    }
    const drift = await this.drift(w.branch);
    const line = opts.source === 'upstream' ? drift.upstream : drift.base;
    if (!line) return res('skipped', opts.source === 'upstream' ? 'This branch has no remote branch to follow.' : 'This branch does not follow another branch.');
    if (line.behind === 0) return res('up-to-date', `Already has everything from ${line.ref}.`);

    const before = (await this.git(['rev-parse', 'HEAD'], w.path)).stdout.trim();
    // Nothing of its own on top: a fast-forward is the cleanest result for both modes.
    const ff = line.ahead === 0;
    const args = ff
      ? ['merge', '--ff-only', '--autostash', line.ref]
      : opts.mode === 'rebase'
        ? ['rebase', '--autostash', line.ref]
        : ['merge', '--no-edit', '--autostash', line.ref];
    try {
      await this.git(args, w.path);
    } catch (err) {
      const u = await this.git(['diff', '--name-only', '--diff-filter=U'], w.path).catch(() => null);
      const conflicts = (u?.stdout ?? '').split(/\r?\n/).filter(Boolean);
      if (!conflicts.length) throw err;
      const rebasing = !ff && opts.mode === 'rebase';
      if (opts.onConflict === 'abort') {
        await this.git(rebasing ? ['rebase', '--abort'] : ['merge', '--abort'], w.path).catch(() => undefined);
        return res('conflict', `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} conflict with ${line.ref} — nothing was changed.`, { conflicts });
      }
      return res('conflict', `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} need resolving in this worktree.`, { conflicts, kept: true });
    }
    const after = (await this.git(['rev-parse', 'HEAD'], w.path)).stdout.trim();
    const n = await this.git(['rev-list', '--count', `${before}..${line.ref}`], w.path).catch(() => null);
    const commits = Math.min(Number(n?.stdout.trim()) || line.behind, line.behind);
    // A stash that could not be re-applied cleanly shows up as conflicts in the working tree.
    const u = await this.git(['diff', '--name-only', '--diff-filter=U'], w.path).catch(() => null);
    const conflicts = (u?.stdout ?? '').split(/\r?\n/).filter(Boolean);
    if (conflicts.length) return res('conflict', `Updated, but your uncommitted changes clash in ${conflicts.length} file(s) — resolve them there.`, { commits, conflicts, kept: true });
    return res(after === before ? 'up-to-date' : 'synced', `${ff ? 'Fast-forwarded' : opts.mode === 'rebase' ? 'Rebased onto' : 'Merged'} ${commits} commit${commits === 1 ? '' : 's'} from ${line.ref}.`, { commits });
  }
}
