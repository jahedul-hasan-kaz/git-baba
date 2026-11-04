import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { clipboard, dialog, type BrowserWindow } from 'electron';
import type { ApiMap } from '../../shared/api';
import type { ResetMode } from '../../shared/types';
import type { AppContext } from '../context';
import { AppError } from '../git/errors';
import { asEnum, asObject, asOptionalString, asString } from '../util/validate';
import { asConfirmed } from './authInput';

export type HistoryChannels =
  | 'history:cherryPick'
  | 'history:revert'
  | 'history:resetPreview'
  | 'history:reset'
  | 'history:undoReset'
  | 'history:rebasePreview'
  | 'history:rebase'
  | 'history:checkout'
  | 'history:copyPatch'
  | 'history:savePatch'
  | 'history:createTag'
  | 'history:pickWorktreeDir'
  | 'history:addWorktree'
  | 'history:worktrees'
  | 'history:remoteUrl';

type Handler<C extends HistoryChannels> = (payload: unknown) => Promise<ApiMap[C]['res']>;
type HandlerMap = { [C in HistoryChannels]: Handler<C> };

const RESET_MODES = ['soft', 'mixed', 'keep', 'hard'] as const;
const short = (h: string) => h.slice(0, 8);

/** Commit-graph actions. Everything that rewrites history or creates commits needs an explicit confirmation. */
export function createHistoryHandlers(ctx: AppContext, getWindow: () => BrowserWindow | null): HandlerMap {
  const asHash = (v: unknown, name = 'commit') => asString(v, name, { pattern: /^[0-9a-f]{40}([0-9a-f]{24})?$/, max: 64 });
  const mainline = (v: unknown) => (v === 1 || v === 2 ? v : undefined);

  return {
    'history:cherryPick': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const hash = asHash(p.hash);
      const r = await ctx.withLock(repo.id, () => git.historyCherryPick(hash, { noCommit: p.noCommit === true, mainline: mainline(p.mainline) }));
      ctx.recordOperation(repo, 'Cherry-pick', r.outcome === 'done' ? 'SUCCESS' : 'WARNING', `${short(hash)} — ${r.message}`);
      return r;
    },
    'history:revert': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const hash = asHash(p.hash);
      const r = await ctx.withLock(repo.id, () => git.historyRevert(hash, { noCommit: p.noCommit === true, mainline: mainline(p.mainline) }));
      ctx.recordOperation(repo, 'Revert', r.outcome === 'done' ? 'SUCCESS' : 'WARNING', `${short(hash)} — ${r.message}`);
      return r;
    },
    'history:resetPreview': async (payload) => {
      const p = asObject(payload);
      return ctx.git(p.repoId).git.resetPreview(asHash(p.hash));
    },
    'history:reset': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const hash = asHash(p.hash);
      const mode = asEnum(p.mode, 'mode', RESET_MODES) as ResetMode;
      const r = await ctx.withLock(repo.id, () => git.historyReset(hash, mode, asHash(p.expectedHead, 'expected HEAD')));
      ctx.recordOperation(repo, `Reset (${mode})`, 'SUCCESS', `${short(r.previousOid)} → ${short(hash)} · backup ${r.backupRef}`);
      return r;
    },
    'history:undoReset': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const prev = asHash(p.previousOid, 'previous commit');
      const mode = asEnum(p.mode, 'mode', RESET_MODES) as ResetMode;
      const wip = p.wipRef === null || p.wipRef === undefined ? null : asString(p.wipRef, 'backup', { max: 80 });
      await ctx.withLock(repo.id, () => git.undoReset(prev, mode, wip));
      ctx.recordOperation(repo, 'Undo reset', 'SUCCESS', `Back to ${short(prev)}`);
    },
    'history:rebasePreview': async (payload) => {
      const p = asObject(payload);
      return ctx.git(p.repoId).git.rebasePreview(asHash(p.onto, 'onto'));
    },
    'history:rebase': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const onto = asHash(p.onto, 'onto');
      const r = await ctx.withLock(repo.id, () => git.historyRebase(onto, asHash(p.expectedHead, 'expected HEAD')));
      ctx.recordOperation(repo, 'Rebase', r.outcome === 'done' ? 'SUCCESS' : 'WARNING', `onto ${short(onto)} — ${r.message}`);
      return r;
    },
    'history:checkout': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const hash = asHash(p.hash);
      await ctx.withLock(repo.id, () => git.checkoutCommit(hash));
      ctx.recordOperation(repo, 'Checkout commit', 'SUCCESS', `Detached HEAD at ${short(hash)}`);
    },
    'history:copyPatch': async (payload) => {
      const p = asObject(payload);
      const { patch } = await ctx.git(p.repoId).git.commitPatch(asHash(p.hash));
      if (patch.length > 20 * 1024 * 1024) throw new AppError({ code: 'too-large', title: 'Patch Too Large', message: 'This patch is too large for the clipboard. Save it as a file instead.' });
      if (/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|PRIVATE KEY-----/.test(patch)) throw new AppError({ code: 'refused', title: 'Not Copied', message: 'The patch appears to contain credentials, so it was not copied.' });
      clipboard.writeText(patch);
      return { bytes: patch.length };
    },
    'history:savePatch': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const { fileName, patch } = await git.commitPatch(asHash(p.hash));
      const win = getWindow();
      const opts: Electron.SaveDialogOptions = { title: 'Save patch', defaultPath: nodePath.join(repo.path, '..', fileName), filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }] };
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return null;
      await fs.writeFile(res.filePath, patch, 'utf8');
      ctx.recordOperation(repo, 'Create patch', 'SUCCESS', res.filePath);
      return { path: res.filePath };
    },
    'history:createTag': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const hash = asHash(p.hash);
      const name = asString(p.name, 'tag name', { max: 200 });
      const message = asOptionalString(p.message, 'message', { max: 5000 });
      await ctx.withLock(repo.id, () => git.createTagAt(hash, name, message));
      ctx.recordOperation(repo, 'Create tag', 'SUCCESS', `${name} at ${short(hash)}`);
    },
    'history:pickWorktreeDir': async (payload) => {
      const p = asObject(payload);
      const { repo } = ctx.git(p.repoId);
      const win = getWindow();
      const opts: Electron.OpenDialogOptions = { title: 'Choose an empty folder for the new worktree', defaultPath: nodePath.dirname(repo.path), properties: ['openDirectory', 'createDirectory', 'promptToCreate', 'dontAddToRecent'] };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    },
    'history:addWorktree': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const hash = asHash(p.hash);
      const dir = nodePath.resolve(asString(p.path, 'folder', { max: 1024 }));
      const entries = await fs.readdir(dir).catch(() => null);
      if (entries && entries.length) throw new AppError({ code: 'folder-not-empty', title: 'Folder Not Empty', message: 'Choose an empty (or new) folder for the worktree.' });
      const branch = asOptionalString(p.branch, 'branch', { max: 200 });
      const r = await ctx.withLock(repo.id, () => git.addWorktree(dir, hash, branch || undefined));
      ctx.recordOperation(repo, 'Create worktree', 'SUCCESS', `${dir}${branch ? ` on ${branch}` : ` at ${short(hash)}`}`);
      return r;
    },
    'history:worktrees': async (payload) => ctx.git(asObject(payload).repoId).git.worktrees(),
    'history:remoteUrl': async (payload) => {
      const p = asObject(payload);
      return ctx.git(p.repoId).git.remoteCommitUrl(asHash(p.hash));
    },
  };
}
