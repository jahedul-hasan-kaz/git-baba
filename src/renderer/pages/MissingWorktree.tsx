import { useEffect, useMemo, useState } from 'react';
import type { RepoSummary } from '../../shared/types';
import { Spinner } from '../components/Modal';
import { useAsync } from '../hooks/useAsync';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
/** Branches a folder usually goes back to, best first. */
const HOME_BRANCHES = ['develop', 'dev', 'qa', 'main', 'master'];

/**
 * A worktree that is open in Git Baba but whose folder was deleted outside the app (for example by
 * `git worktree remove`, or by deleting the folder to check its branch out in the main repository).
 * Explains what happened and offers the ways out: recreate the folder (handing its branch back from
 * whichever folder has it now), go to the main repository, or take the entry off the sidebar.
 */
export function MissingWorktree({ repo }: { repo: RepoSummary }) {
  const { repos, selectRepo, refreshRepos, toast, bump, showError } = useApp();
  const parent = repos.find((r) => r.id === repo.worktreeOf) ?? null;
  const parentId = parent?.exists ? parent.id : null;
  const branches = useAsync(() => (parentId ? call('git:branches', { repoId: parentId }) : Promise.resolve([])), [parentId]);
  const trees = useAsync(() => (parentId ? call('git:worktrees', { repoId: parentId }) : Promise.resolve([])), [parentId]);
  const [branch, setBranch] = useState('');
  const [switchTo, setSwitchTo] = useState('');
  const [busy, setBusy] = useState<'restore' | 'remove' | 'removeAll' | null>(null);

  const loaded = !!branches.data && !!trees.data;
  const local = useMemo(() => (branches.data ?? []).filter((b) => !b.remote), [branches.data]);
  // Branch → folder it is checked out in (stale records of deleted folders do not count; they get pruned).
  const taken = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of trees.data ?? []) if (w.branch && !w.prunable && norm(w.path) !== norm(repo.path)) m.set(w.branch, w.path);
    return m;
  }, [trees.data, repo.path]);
  const stale = (trees.data ?? []).some((w) => norm(w.path) === norm(repo.path));

  // The branch the worktree had: remembered, or guessed from the folder name (<repo>-<suffix> → a branch ending in <suffix>).
  const guess = useMemo(() => {
    if (repo.worktreeBranch) return repo.worktreeBranch;
    const base = folderName(repo.path).toLowerCase();
    const prefix = parent ? `${parent.name.toLowerCase()}-` : '';
    const suffix = prefix && base.startsWith(prefix) ? base.slice(prefix.length) : base;
    const hit = local.filter((b) => b.name.toLowerCase().endsWith(suffix)).sort((a, b) => a.name.length - b.name.length)[0];
    return hit?.name ?? null;
  }, [repo.worktreeBranch, repo.path, parent, local]);

  // Pick the worktree's own branch once everything is loaded — even when another folder has it, since it can be handed back.
  useEffect(() => {
    if (branch || !loaded || !local.length) return;
    setBranch(guess ?? local.find((b) => !taken.has(b.name))?.name ?? '');
  }, [loaded, local, taken, guess, branch]);

  // Where the chosen branch is checked out now, and what that folder could switch to instead.
  const info = useAsync(() => (branch && taken.has(branch) ? call('git:worktreeRestoreInfo', { repoId: repo.id, branch }) : Promise.resolve({ holder: null })), [repo.id, branch, taken]);
  const holder = branch && taken.has(branch) ? (info.data?.holder ?? null) : null;
  useEffect(() => {
    if (!holder) return;
    const pick = holder.previous ?? HOME_BRANCHES.find((b) => holder.branches.includes(b)) ?? holder.branches[0] ?? '';
    setSwitchTo((cur) => (cur && holder.branches.includes(cur) ? cur : pick));
  }, [holder]);

  const guessHome = guess ? taken.get(guess) : undefined;
  const guessInParent = !!(guess && parent && guessHome && norm(guessHome) === norm(parent.path));
  const deletedSiblings = parent ? repos.filter((r) => r.worktreeOf === parent.id && !r.exists) : [repo];
  const holderRepo = holder?.repoId ? repos.find((r) => r.id === holder.repoId) : undefined;

  const restore = async () => {
    setBusy('restore');
    try {
      await call('git:worktreeRestore', { repoId: repo.id, branch, confirmed: true, ...(holder ? { switchHolderTo: switchTo } : {}) });
      await refreshRepos();
      bump();
      toast(holder ? `${holder.name} is on ${switchTo} now; recreated ${repo.name} with ${branch}` : `Recreated ${repo.name} with ${branch} checked out`, 'success');
    } catch (err) {
      showError(err);
      // Something may have changed on disk (e.g. the switch happened); show the latest state.
      void branches.reload();
      void trees.reload();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (list: RepoSummary[], kind: 'remove' | 'removeAll') => {
    setBusy(kind);
    try {
      for (const r of list) await call('repo:remove', { repoId: r.id });
      // Removing them all also clears Git's stale records of the deleted folders, so the main repository's
      // worktree list is clean (a prune also takes every other deleted worktree of it off the sidebar).
      if (kind === 'removeAll' && parentId) await call('git:worktreePrune', { repoId: parentId }).catch(() => undefined);
      await refreshRepos();
      if (parent) selectRepo(parent.id);
      toast(list.length === 1 ? `Removed ${list[0].name} from Git Baba` : `Removed ${list.length} deleted worktrees from Git Baba`, 'success');
    } catch (err) {
      showError(err);
      setBusy(null);
    }
  };

  const canRestore = !!branch && !busy && (!holder || (!!switchTo && holder.changes === 0)) && !info.loading;

  return (
    <div className="content mw">
      <div className="banner warn">
        <span className="icon">⚠</span>
        <div>
          <strong>This worktree's folder was deleted</strong>
          <div>
            <span className="mono">{repo.path}</span> no longer exists.{' '}
            {parent
              ? stale
                ? `Git still keeps a stale record of it in ${parent.name}, which is cleaned up when you recreate or remove it.`
                : `It was removed outside Git Baba, and Git no longer lists it as a worktree of ${parent.name}.`
              : 'It was removed outside Git Baba.'}{' '}
            Committed work is safe in the repository; only changes that were never committed in that folder are gone.
          </div>
          {guessInParent && parent && (
            <div className="mw-note">
              Its branch <span className="mono">{guess}</span> is now checked out in <strong>{parent.name}</strong>. You can keep working there, or hand the branch back to this worktree below.
            </div>
          )}
        </div>
      </div>

      <div className="mw-cards">
        <div className="mw-card is-pick">
          <div className="mw-ic">⎇</div>
          <div className="grow">
            <strong>Recreate the worktree</strong>
            <div className="small muted">Adds the folder back at the same place with a branch checked out.</div>
            {!parent?.exists ? (
              <div className="small text-danger mt">The main repository is not in Git Baba, so the worktree can't be recreated from here.</div>
            ) : !loaded ? (
              <div className="mt">
                <Spinner />
              </div>
            ) : (
              <>
                <label className="mw-label mt">Branch for the worktree</label>
                <select className="mw-select" value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!!busy}>
                  {!branch && <option value="">Choose a branch…</option>}
                  {local.map((b) => {
                    const home = taken.get(b.name);
                    return (
                      <option key={b.name} value={b.name}>
                        {b.name}
                        {b.name === guess ? '  (this worktree’s branch)' : ''}
                        {home ? `  — now in ${folderName(home)}` : ''}
                      </option>
                    );
                  })}
                </select>

                {branch && taken.has(branch) && (
                  <div className="mw-handover">
                    {info.loading || !holder ? (
                      <Spinner />
                    ) : (
                      <>
                        <div className="mw-step">
                          <span className="mw-num">1</span>
                          <div className="grow">
                            <span className="mono">{branch}</span> is checked out in <strong>{holder.name}</strong>. A branch can be in one folder at a time, so {holder.name} moves to another branch first:
                            {holder.changes > 0 ? (
                              <div className="mw-block">
                                {holder.name} has {holder.changes} uncommitted change{holder.changes === 1 ? '' : 's'}. Commit or stash {holder.changes === 1 ? 'it' : 'them'} there first, then come back.
                                {holderRepo && (
                                  <button className="btn sm" onClick={() => selectRepo(holderRepo.id)}>
                                    Open {holder.name}
                                  </button>
                                )}
                                <button className="btn sm" onClick={() => void info.reload()}>
                                  Check again
                                </button>
                              </div>
                            ) : holder.branches.length === 0 ? (
                              <div className="mw-block">{holder.name} has no other free branch to switch to. Create one there first.</div>
                            ) : (
                              <select className="mw-select mt-sm" value={switchTo} onChange={(e) => setSwitchTo(e.target.value)} disabled={!!busy}>
                                {holder.branches.map((b) => (
                                  <option key={b} value={b}>
                                    {b}
                                    {b === holder.previous ? '  (where it was before)' : ''}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>
                        <div className="mw-step">
                          <span className="mw-num">2</span>
                          <div className="grow">
                            The worktree is recreated at <span className="mono">{folderName(repo.path)}</span> with <span className="mono">{branch}</span>. Nothing is lost: Git refuses the switch if it would overwrite anything.
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="mw-row mt">
                  <button className="btn primary" disabled={!canRestore} onClick={() => void restore()}>
                    {busy === 'restore' ? 'Working…' : holder ? `Switch ${holder.name} to ${switchTo || '…'} & recreate` : 'Recreate worktree'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {parent && (
          <div className="mw-card">
            <div className="mw-ic">↩</div>
            <div className="grow">
              <strong>Keep working in {parent.name}</strong>
              <div className="small muted">The main repository{parent.branch ? `, on ${parent.branch}` : ''}. Nothing changes.</div>
            </div>
            <button className="btn" onClick={() => selectRepo(parent.id)}>
              Open {parent.name}
            </button>
          </div>
        )}

        <div className="mw-card is-danger">
          <div className="mw-ic">✕</div>
          <div className="grow">
            <strong>Remove from Git Baba</strong>
            <div className="small muted">Takes it off the sidebar. Nothing on disk is touched.</div>
          </div>
          <div className="mw-actions">
            <button className="btn danger" disabled={!!busy} onClick={() => void remove([repo], 'remove')}>
              {busy === 'remove' ? 'Removing…' : 'Remove'}
            </button>
            {deletedSiblings.length > 1 && (
              <button className="btn" disabled={!!busy} onClick={() => void remove(deletedSiblings, 'removeAll')} title={deletedSiblings.map((r) => r.name).join('\n')}>
                {busy === 'removeAll' ? 'Removing…' : `Remove all ${deletedSiblings.length} deleted worktrees of ${parent?.name}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
