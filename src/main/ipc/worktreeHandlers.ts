import { shell } from 'electron';
import * as fs from 'node:fs';
import type { ApiMap } from '../../shared/api';
import type { RepoRecord, RepoSummary } from '../../shared/types';
import type { AppContext } from '../context';
import * as path from 'node:path';
import { AppError } from '../git/errors';
import { GitService } from '../git/GitService';
import { countChanges } from '../git/parsers';
import { runGit } from '../git/runner';
import { Worktrees } from '../git/worktrees';
import { asBoolean, asBranchName, asLine, asObject } from '../util/validate';
import { asConfirmed } from './authInput';

export type WorktreeChannels = 'git:worktrees' | 'git:worktreeAdd' | 'git:worktreeRemove' | 'git:worktreeLock' | 'git:worktreePrune' | 'git:worktreeOpen' | 'git:worktreeReveal' | 'git:worktreeSync' | 'git:worktreeSetBase' | 'git:worktreeRestore' | 'git:worktreeRestoreInfo';

type Handlers = { [C in WorktreeChannels]: (payload: unknown) => Promise<ApiMap[C]['res']> };

/**
 * Git worktrees of the open repository. Paths sent back by the renderer are only acted on when they are
 * one of the repository's own worktrees (re-read from `git worktree list`), never as arbitrary folders.
 */
export function createWorktreeHandlers(ctx: AppContext, helpers: { summarize: (repo: RepoRecord) => Promise<RepoSummary> }): Handlers {
  const wt = (repoId: unknown) => {
    const { repo } = ctx.git(repoId);
    return { repo, trees: new Worktrees(repo.path) };
  };
  const withRepoIds = <T extends { path: string }>(list: T[]) => list.map((w) => ({ ...w, repoId: ctx.repos.findByPath(w.path)?.id }));

  /** The main repository a deleted worktree (open in the app as `repoId`) belonged to. */
  const parentOf = (repoId: unknown) => {
    const rec = ctx.repo(repoId);
    const parent = rec.worktreeParent ? ctx.repos.get(rec.worktreeParent) : undefined;
    if (!parent || !fs.existsSync(parent.path)) {
      throw new AppError({ code: 'no-main-repo', title: 'Main Repository Not Found', message: `Git Baba does not know which repository ${rec.name} was a worktree of. Remove it from Git Baba instead.` });
    }
    return { rec, parent, trees: new Worktrees(parent.path) };
  };
  const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  /** The live folder (other than `except`) that has `branch` checked out. */
  const holderOf = async (trees: Worktrees, branch: string, except: string) =>
    (await trees.list()).find((w) => w.branch === branch && !w.prunable && !samePath(w.path, except));

  return {
    'git:worktreeRestoreInfo': async (payload) => {
      const p = asObject(payload);
      const { rec, trees } = parentOf(p.repoId);
      const branch = asBranchName(p.branch);
      const h = await holderOf(trees, branch, rec.path);
      if (!h) return { holder: null };
      const st = await new GitService(h.path).status().catch(() => null);
      const changes = st ? countChanges([st.staged, st.unstaged, st.untracked, st.conflicted]) : 0;
      // The branch that folder was on before (`@{-1}`): the natural one to go back to.
      const prev = await runGit({ cwd: h.path, args: ['rev-parse', '--abbrev-ref', '@{-1}'] })
        .then((r) => r.stdout.trim())
        .catch(() => '');
      const all = await runGit({ cwd: h.path, args: ['for-each-ref', '--format=%(refname:short)', 'refs/heads'] })
        .then((r) => r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))
        .catch(() => [] as string[]);
      const busy = new Set((await trees.list()).filter((w) => w.branch && !w.prunable).map((w) => w.branch as string));
      const branches = all.filter((b) => !busy.has(b));
      return {
        holder: {
          path: h.path,
          name: path.basename(h.path),
          repoId: ctx.repos.findByPath(h.path)?.id,
          main: h.main,
          changes,
          previous: prev && prev !== branch && branches.includes(prev) ? prev : null,
          branches,
        },
      };
    },

    'git:worktrees': async (payload) => withRepoIds(await wt(asObject(payload).repoId).trees.list(true)),

    'git:worktreeAdd': async (payload) => {
      const p = asObject(payload);
      const { repo, trees } = wt(p.repoId);
      const dir = asLine(p.path, 'Folder', { max: 1024 }).trim();
      const create = asBoolean(p.create, 'create');
      const branch = asBranchName(p.branch);
      const base = p.base ? asLine(p.base, 'Starting point', { max: 255 }).trim() : undefined;
      const added = await ctx.withLock(repo.id, () => trees.add(dir, { branch, create, base }));
      ctx.recordOperation(repo, 'Add worktree', 'SUCCESS', `${branch} → ${added.path}`);
      return withRepoIds([added])[0];
    },

    'git:worktreeRemove': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, trees } = wt(p.repoId);
      const target = await trees.get(asLine(p.path, 'Worktree', { max: 1024 }));
      await ctx.withLock(repo.id, () => trees.remove(target.path, p.force === true));
      // A worktree that was also open as a repository leaves the sidebar with its folder.
      const open = ctx.repos.findByPath(target.path);
      if (open && !fs.existsSync(target.path)) ctx.repos.remove(open.id);
      ctx.recordOperation(repo, 'Remove worktree', 'SUCCESS', target.path);
      return withRepoIds(await trees.list(true));
    },

    'git:worktreeLock': async (payload) => {
      const p = asObject(payload);
      const { trees } = wt(p.repoId);
      const reason = p.reason ? asLine(p.reason, 'Reason', { max: 200 }) : undefined;
      await trees.lock(asLine(p.path, 'Worktree', { max: 1024 }), asBoolean(p.lock, 'lock'), reason);
      return withRepoIds(await trees.list(true));
    },

    'git:worktreePrune': async (payload) => {
      const { repo, trees } = wt(asObject(payload).repoId);
      const n = await trees.prune();
      // Worktrees of this repository that were open in the app and whose folders are gone leave the sidebar too.
      for (const r of ctx.repos.list()) if (r.worktreeParent === repo.id && !fs.existsSync(r.path)) ctx.repos.remove(r.id);
      ctx.recordOperation(repo, 'Prune worktrees', 'SUCCESS', `${n} stale worktree(s)`);
      return withRepoIds(await trees.list(true));
    },

    /** Opens a worktree as its own repository in the app, carrying over the repository's settings. */
    'git:worktreeOpen': async (payload) => {
      const p = asObject(payload);
      const { repo, trees } = wt(p.repoId);
      const target = await trees.get(asLine(p.path, 'Worktree', { max: 1024 }));
      if (target.prunable) throw new Error('This worktree folder no longer exists.');
      const existed = ctx.repos.findByPath(target.path);
      const real = fs.realpathSync.native(target.path);
      const rec = existed ?? ctx.repos.add(real);
      if (rec.id !== repo.id) ctx.repos.setWorktreeParent(rec.id, repo.id);
      if (!existed) {
        const s = repo.settings;
        ctx.repos.updateSettings(rec.id, {
          accountId: s.accountId,
          remoteAuth: s.remoteAuth,
          commitSigning: s.commitSigning,
          githubApp: s.githubApp,
          sshKeyPath: s.sshKeyPath,
          apiBaseUrl: s.apiBaseUrl,
          runHooks: s.runHooks,
        });
      }
      return helpers.summarize(ctx.repos.get(rec.id) ?? rec);
    },

    /**
     * Recreates a worktree whose folder was deleted outside the app, at the same place, from its main
     * repository: forgets the stale record (`git worktree prune`), then adds the folder back with `branch`.
     */
    'git:worktreeRestore': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { rec, parent, trees } = parentOf(p.repoId);
      const branch = asBranchName(p.branch);
      const switchTo = typeof p.switchHolderTo === 'string' && p.switchHolderTo ? asBranchName(p.switchHolderTo, 'switchHolderTo') : null;
      if (fs.existsSync(rec.path) && fs.readdirSync(rec.path).length > 0) {
        throw new AppError({ code: 'folder-not-empty', title: 'Folder Already There', message: `${rec.path} exists again. Refresh to open it.` });
      }
      await ctx.withLock(parent.id, async () => {
        await trees.prune();
        const taken = await holderOf(trees, branch, rec.path);
        if (taken && switchTo) {
          // Hands the branch over: the folder that has it moves to another branch first. Plain `git switch`,
          // so Git refuses rather than lose anything; uncommitted changes are checked up front for a clear message.
          const git = new GitService(taken.path);
          const st = await git.status();
          if (countChanges([st.staged, st.unstaged, st.untracked, st.conflicted]) > 0) {
            throw new AppError({ code: 'holder-dirty', title: 'Uncommitted Changes', message: `${path.basename(taken.path)} has uncommitted changes. Commit or stash them there first, then try again.` });
          }
          await git.switchBranch(switchTo);
          ctx.recordOperation(ctx.repos.findByPath(taken.path) ?? parent, 'Switch branch', 'SUCCESS', `${branch} → ${switchTo} (to recreate worktree ${rec.name})`);
        } else if (taken) {
          throw new AppError({
            code: 'branch-in-use',
            title: 'Branch Is Checked Out Elsewhere',
            message: `${branch} is checked out in ${taken.path}. A branch can be checked out in one folder at a time — pick another branch, or switch that folder to a different branch first.`,
          });
        }
        await trees.add(rec.path, { branch, create: false });
      });
      ctx.repos.setWorktreeParent(rec.id, parent.id, branch);
      ctx.recordOperation(parent, 'Restore worktree', 'SUCCESS', `${rec.path} (${branch})`);
      return helpers.summarize(ctx.repos.get(rec.id) ?? rec);
    },

    /** Brings the newest commits of a worktree's base branch or upstream into that worktree. */
    'git:worktreeSync': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, trees } = wt(p.repoId);
      const source = p.source === 'upstream' ? 'upstream' : 'base';
      const mode = p.mode === 'rebase' ? 'rebase' : 'merge';
      const onConflict = p.onConflict === 'keep' ? 'keep' : 'abort';
      const target = await trees.get(asLine(p.path, 'Worktree', { max: 1024 }));
      const r = await ctx.withLock(repo.id, () => trees.sync(target.path, { source, mode, onConflict }));
      ctx.recordOperation(repo, `Sync worktree (${source}, ${mode})`, r.status === 'conflict' ? 'WARNING' : 'SUCCESS', `${target.path}: ${r.message}`);
      return r;
    },

    'git:worktreeSetBase': async (payload) => {
      const p = asObject(payload);
      const { trees } = wt(p.repoId);
      const base = p.base === null || p.base === undefined || p.base === '' ? null : asLine(p.base, 'Base branch', { max: 255 });
      await trees.setBase(asLine(p.path, 'Worktree', { max: 1024 }), base);
      return withRepoIds(await trees.list(true));
    },

    'git:worktreeReveal': async (payload) => {
      const p = asObject(payload);
      const target = await wt(p.repoId).trees.get(asLine(p.path, 'Worktree', { max: 1024 }));
      const err = await shell.openPath(target.path);
      if (err) throw new Error(err);
    },
  };
}
