import { shell } from 'electron';
import * as fs from 'node:fs';
import type { ApiMap } from '../../shared/api';
import type { RepoRecord, RepoSummary } from '../../shared/types';
import type { AppContext } from '../context';
import { Worktrees } from '../git/worktrees';
import { asBoolean, asBranchName, asLine, asObject } from '../util/validate';
import { asConfirmed } from './authInput';

export type WorktreeChannels = 'git:worktrees' | 'git:worktreeAdd' | 'git:worktreeRemove' | 'git:worktreeLock' | 'git:worktreePrune' | 'git:worktreeOpen' | 'git:worktreeReveal';

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

  return {
    'git:worktrees': async (payload) => withRepoIds(await wt(asObject(payload).repoId).trees.list()),

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
      return withRepoIds(await trees.list());
    },

    'git:worktreeLock': async (payload) => {
      const p = asObject(payload);
      const { trees } = wt(p.repoId);
      const reason = p.reason ? asLine(p.reason, 'Reason', { max: 200 }) : undefined;
      await trees.lock(asLine(p.path, 'Worktree', { max: 1024 }), asBoolean(p.lock, 'lock'), reason);
      return withRepoIds(await trees.list());
    },

    'git:worktreePrune': async (payload) => {
      const { repo, trees } = wt(asObject(payload).repoId);
      const n = await trees.prune();
      ctx.recordOperation(repo, 'Prune worktrees', 'SUCCESS', `${n} stale worktree(s)`);
      return withRepoIds(await trees.list());
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

    'git:worktreeReveal': async (payload) => {
      const p = asObject(payload);
      const target = await wt(p.repoId).trees.get(asLine(p.path, 'Worktree', { max: 1024 }));
      const err = await shell.openPath(target.path);
      if (err) throw new Error(err);
    },
  };
}
