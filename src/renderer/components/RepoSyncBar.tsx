import { useCallback, useEffect, useRef, useState } from 'react';
import type { BranchInfo, RepoStatus } from '../../shared/types';
import { SwitchBranchDialog } from '../dialogs/BranchDialogs';
import { call } from '../services/api';
import { useApp } from '../state/AppState';
import { requestQuickMerge } from '../services/quickMerge';
import { isPublished } from '../../shared/publish';

const REMOTE_CHECK_MS = 3 * 60 * 1000;

interface Props {
  repoId: string;
  isGitHub: boolean;
  /** False for a repository without any remote (e.g. just created locally): there is nowhere to sync with. */
  hasRemote: boolean;
  status: RepoStatus | null;
  loading: boolean;
  inOperation: boolean;
  disabled: boolean;
  onRefresh: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
}

/** Closes a popover on outside click / Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}

/**
 * Branch picker, ahead/behind indicator and the sync controls of a repository: one Fetch/Pull button that
 * turns into "Pull ↓N" when there is something to bring in (counted locally and, for GitHub repositories,
 * checked against the remote in the background), and a Push button that shows what is waiting to go out.
 */
export function RepoSyncBar({ repoId, isGitHub, hasRemote, status: st, loading, inOperation, disabled, onRefresh, onFetch, onPull, onPush }: Props) {
  const { revision, setRepoTab, bump, refreshRepos } = useApp();
  const [incoming, setIncoming] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [syncMenu, setSyncMenu] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [filter, setFilter] = useState('');
  const [switching, setSwitching] = useState<{ target: string; kind: 'local' | 'remote' } | null>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<HTMLDivElement>(null);
  useDismiss(branchOpen, branchRef, useCallback(() => setBranchOpen(false), []));
  useDismiss(syncMenu, syncRef, useCallback(() => setSyncMenu(false), []));

  // Background, read-only check for commits on the remote that have not been fetched yet.
  const checkRemote = useCallback(async () => {
    if (!isGitHub || disabled) return;
    setChecking(true);
    try {
      const r = await call('gh:remoteAhead', { repoId });
      setIncoming(r.incoming);
      setLastCheck(new Date());
    } catch {
      setIncoming(null);
    } finally {
      setChecking(false);
    }
  }, [repoId, isGitHub, disabled]);

  useEffect(() => {
    setIncoming(null);
  }, [repoId]);

  useEffect(() => {
    void checkRemote();
    const t = window.setInterval(() => void checkRemote(), REMOTE_CHECK_MS);
    const onFocus = () => void checkRemote();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [checkRemote, revision]);

  useEffect(() => {
    if (!branchOpen) return;
    setFilter('');
    call('git:branches', { repoId })
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [branchOpen, repoId]);

  const branch = st?.branch ?? (st?.detached ? 'detached HEAD' : '—');
  const ahead = st?.ahead ?? 0;
  const behind = (st?.behind ?? 0) + (incoming ?? 0);
  const hasUpstream = isPublished(st);
  const busy = loading || checking;
  const canSync = !disabled && !inOperation;
  const canPush = canSync && !!st?.branch && !!st.headOid && (!hasUpstream || ahead > 0);

  const q = filter.trim().toLowerCase();
  const local = (branches ?? []).filter((b) => !b.remote);
  const localNames = new Set(local.map((b) => b.name));
  const remoteOnly = (branches ?? []).filter((b) => b.remote && !b.name.endsWith('/HEAD') && !localNames.has(b.name.split('/').slice(1).join('/')));
  const match = (b: BranchInfo) => !q || b.name.toLowerCase().includes(q);

  const pickBranch = (target: string, kind: 'local' | 'remote') => {
    setBranchOpen(false);
    setSwitching({ target, kind });
  };

  const syncTitle = st?.upstreamGone
    ? `${st.upstream} does not exist on the remote (empty repository, or deleted there). Publish to create it.`
    : !hasUpstream && st?.upstream
    ? `${st.branch} tracks ${st.upstream}. Publish creates ${st.branch} on the remote (it never updates ${st.upstream}).`
    : !hasUpstream
    ? 'This branch is not published yet'
    : `${ahead} commit(s) to push · ${st?.behind ?? 0} fetched commit(s) to pull${incoming ? ` · ${incoming} new on the remote (not fetched yet)` : ''}${lastCheck ? `\nRemote checked ${lastCheck.toLocaleTimeString()}` : ''}`;

  return (
    <>
      <div className="row sync-bar">
        {/* Branch picker */}
        <div className="pop-anchor" ref={branchRef}>
          <button className={`pill pill-btn ${branchOpen ? 'open' : ''}`} onClick={() => setBranchOpen((o) => !o)} disabled={disabled} title="Switch branch">
            <span className="sb-dot" />⎇ <strong className="ellipsis">{branch}</strong> <span className="caret">▾</span>
          </button>
          {branchOpen && (
            <div className="branch-pop pop-in">
              <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a branch…" spellCheck={false} />
              <div className="branch-pop-list">
                {!branches ? (
                  <div className="small muted pad">Loading…</div>
                ) : (
                  <>
                    <div className="dropdown-title">Local</div>
                    {local.filter(match).map((b) => (
                      <div key={b.name} className={`dropdown-item ${b.current ? 'active' : ''}`} onClick={() => !b.current && pickBranch(b.name, 'local')} title={b.subject}>
                        <span className="ctx-ico">{b.current ? '✓' : '⎇'}</span>
                        <span className="grow ellipsis mono">{b.name}</span>
                        {(b.ahead || b.behind) && (
                          <span className="small muted">
                            {b.ahead ? `↑${b.ahead}` : ''} {b.behind ? `↓${b.behind}` : ''}
                          </span>
                        )}
                      </div>
                    ))}
                    {remoteOnly.filter(match).length > 0 && <div className="dropdown-title">Remote only</div>}
                    {remoteOnly.filter(match).map((b) => (
                      <div key={b.name} className="dropdown-item" onClick={() => pickBranch(b.name, 'remote')} title={`Check out ${b.name} locally`}>
                        <span className="ctx-ico">☁</span>
                        <span className="grow ellipsis mono">{b.name}</span>
                      </div>
                    ))}
                    {local.filter(match).length + remoteOnly.filter(match).length === 0 && <div className="small muted pad">No branches match.</div>}
                  </>
                )}
              </div>
              <div className="dropdown-sep" />
              <div
                className="dropdown-item"
                onClick={() => {
                  setBranchOpen(false);
                  requestQuickMerge({ source: st?.branch ?? undefined });
                }}
                title="Merge one branch into another — or open a pull request"
              >
                <span className="ctx-ico">⤵</span> Merge…
              </div>
            </div>
          )}
        </div>

        {/* Ahead / behind */}
        {st?.branch && !hasRemote && (
          <button className="pill pill-btn sync-pill" onClick={() => setRepoTab('settings')} title="This repository has no remote yet. Add one (for example a new empty GitHub repository) in Settings to push and pull.">
            <span className="zero">no remote</span>
          </button>
        )}
        {st?.branch && hasRemote && (
          <button
            className={`pill pill-btn sync-pill ${ahead ? 'has-out' : ''} ${behind ? 'has-in' : ''}`}
            disabled={!canSync}
            title={`${syncTitle}\nClick to ${behind ? 'pull' : ahead || !hasUpstream ? 'push' : 'fetch'}`}
            onClick={() => (behind ? onPull() : ahead || !hasUpstream ? onPush() : onFetch())}
          >
            {hasUpstream ? (
              <>
                <span className={ahead ? 'out' : 'zero'}>↑{ahead}</span>
                <span className={behind ? 'in' : 'zero'}>↓{behind}</span>
              </>
            ) : (
              <span className="out">not published</span>
            )}
          </button>
        )}
      </div>

      <div className="row">
        <button
          className={`btn icon-btn ${busy ? 'busy' : ''}`}
          onClick={() => {
            onRefresh();
            void checkRemote();
          }}
          title={`Refresh status${isGitHub ? ' and check the remote for new commits' : ''}`}
        >
          <span className="spin-ico">⟳</span>
        </button>

        {/* Fetch / Pull */}
        <div className="split-btn pop-anchor" ref={syncRef}>
          {behind > 0 ? (
            <button className="btn attention" onClick={onPull} disabled={!canSync} title={syncTitle}>
              ⬇ Pull <span className="btn-count">{behind}</span>
              {incoming ? <span className="pulse-dot" title="New commits on the remote" /> : null}
            </button>
          ) : (
            <button className="btn" onClick={onFetch} disabled={disabled || !hasRemote} title={!hasRemote ? 'No remote to fetch from yet' : `Fetch from the remote (your files are not changed)${lastCheck ? `\nRemote checked ${lastCheck.toLocaleTimeString()}: up to date` : ''}`}>
              ⬇ Fetch
            </button>
          )}
          <button className={`btn caret-btn ${behind > 0 ? 'attention' : ''}`} onClick={() => setSyncMenu((o) => !o)} disabled={disabled || !hasRemote} aria-label="More sync options">
            ▾
          </button>
          {syncMenu && (
            <div className="dropdown pop-in" onClick={() => setSyncMenu(false)}>
              <div className="dropdown-item" onClick={onFetch}>
                <span className="ctx-ico">⬇</span>
                <div>
                  <div>Fetch</div>
                  <div className="small muted">Download new commits; your files are not changed</div>
                </div>
              </div>
              <div className={`dropdown-item ${canSync ? '' : 'disabled'}`} onClick={canSync ? onPull : undefined}>
                <span className="ctx-ico">🛡</span>
                <div>
                  <div>Pull (review)</div>
                  <div className="small muted">Fetch, review incoming changes, then update your branch</div>
                </div>
              </div>
              {isGitHub && (
                <>
                  <div className="dropdown-sep" />
                  <div className="dropdown-item" onClick={() => void checkRemote()}>
                    <span className="ctx-ico">☁</span>
                    <div>
                      <div>Check remote now</div>
                      <div className="small muted">{lastCheck ? `Last checked ${lastCheck.toLocaleTimeString()}` : 'Not checked yet'}</div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Push */}
        {!hasRemote ? (
          <button className="btn push-btn" onClick={() => setRepoTab('settings')} disabled={disabled} title="Add a remote in Settings, then publish this branch to it">
            ＋ Add remote
          </button>
        ) : (
        <button
          className={`btn ${canPush ? 'primary' : ''} push-btn`}
          onClick={onPush}
          disabled={!canPush}
          title={
            !st?.branch
              ? 'No branch checked out'
              : !st.headOid
              ? 'Make a first commit, then publish it'
              : !hasUpstream
              ? syncTitle
              : ahead
              ? `${ahead} commit(s) waiting to be pushed`
              : 'Nothing to push — everything is on the remote'
          }
        >
          ⬆ {hasUpstream ? 'Push' : 'Publish'}
          {ahead > 0 && <span className="btn-count">{ahead}</span>}
        </button>
        )}
      </div>

      {switching && (
        <SwitchBranchDialog
          repoId={repoId}
          target={switching.target}
          kind={switching.kind}
          onClose={() => {
            setSwitching(null);
            bump();
          }}
          onDone={() => {
            setSwitching(null);
            bump();
            void refreshRepos();
          }}
        />
      )}
    </>
  );
}
