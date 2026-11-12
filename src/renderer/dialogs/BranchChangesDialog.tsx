import { useEffect, useState } from 'react';
import type { BranchChanges, BranchInfo, CommitDetails, FriendlyError } from '../../shared/types';
import { BranchPicker, toPickerItems } from '../components/BranchPicker';
import { ErrorPanel } from '../components/ErrorPanel';
import { FileDiffList, relative } from '../components/FileDiffList';
import { Avatar, Skeleton } from '../components/github/common';
import { Modal, Spinner } from '../components/Modal';
import { call, toFriendly } from '../services/api';

interface Props {
  repoId: string;
  branch: string;
  /** Branches the user can compare against. */
  candidates: string[];
  /** Optional details (last commit, ahead/behind) for richer picker rows. */
  branchInfo?: BranchInfo[];
  onClose: () => void;
  /** Optional actions shown in the footer (switch, merge…). */
  actions?: React.ReactNode;
}

/**
 * What a branch changes compared with a base (main by default): its own commits and the combined
 * diff since the two diverged — the same view a pull request would show.
 */
export function BranchChangesDialog({ repoId, branch, candidates, branchInfo, onClose, actions }: Props) {
  const [base, setBase] = useState<string>('');
  const [data, setData] = useState<BranchChanges | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'files' | 'commits'>('files');
  const [search, setSearch] = useState('');
  const [openCommit, setOpenCommit] = useState<string | null>(null);
  const [commit, setCommit] = useState<CommitDetails | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    call('graph:branchChanges', { repoId, branch, base: base || undefined })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        if (!base) setBase(d.base);
      })
      .catch((err) => !cancelled && setError(toFriendly(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, branch, base]);

  useEffect(() => {
    if (!openCommit) return setCommit(null);
    let cancelled = false;
    call('graph:commit', { repoId, hash: openCommit })
      .then((d) => !cancelled && setCommit(d))
      .catch(() => !cancelled && setCommit(null));
    return () => {
      cancelled = true;
    };
  }, [repoId, openCommit]);

  const bases = [...new Set([base, ...candidates].filter((b) => b && b !== branch))];
  const identical = data && data.ahead === 0;

  return (
    <Modal
      size="wide"
      icon="⎇"
      title={
        <span className="row" style={{ gap: 8 }}>
          <span className="branch-pill mono">{branch}</span>
          <span className="muted small">compared with</span>
          <BranchPicker
            compact
            value={base}
            onChange={setBase}
            items={bases.map((b) => toPickerItems(branchInfo?.filter((x) => x.name === b) ?? [])[0] ?? { name: b })}
            placeholder="Choose a base…"
            recentKey="compare-base"
          />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {actions}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      {loading && !data && <Skeleton rows={6} />}
      {data && (
        <div className={`fade-in ${loading ? 'is-loading' : ''}`}>
          <div className="stat-strip mb">
            <div className="stat">
              <span className="stat-num text-ok">{data.ahead}</span>
              <span className="stat-label">commit{data.ahead === 1 ? '' : 's'} ahead</span>
            </div>
            <div className="stat">
              <span className="stat-num text-warn">{data.behind}</span>
              <span className="stat-label">behind {data.base}</span>
            </div>
            <div className="stat">
              <span className="stat-num">{data.files.length}</span>
              <span className="stat-label">files changed</span>
            </div>
            <div className="stat">
              <span className="stat-num">
                <span className="text-ok">+{data.additions}</span> <span className="text-danger">−{data.deletions}</span>
              </span>
              <span className="stat-label">lines</span>
            </div>
          </div>

          {identical ? (
            <div className="banner ok">
              <span className="icon">✓</span>
              <div>
                <strong>Nothing new on {data.branch}.</strong> Every commit of this branch is already in {data.base}
                {data.behind ? `, which is ${data.behind} commit(s) further ahead` : ''}.
              </div>
            </div>
          ) : (
            <>
              <div className="row mb">
                <div className="segmented">
                  <button className={view === 'files' ? 'on' : ''} onClick={() => setView('files')}>
                    Files changed <span className="badge">{data.files.length}</span>
                  </button>
                  <button className={view === 'commits' ? 'on' : ''} onClick={() => setView('commits')}>
                    Commits <span className="badge">{data.commits.length}</span>
                  </button>
                </div>
                <span className="spacer" />
                {view === 'files' && <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search within changes…" style={{ maxWidth: 280 }} />}
              </div>
              {view === 'files' ? (
                <FileDiffList repoId={repoId} files={data.files} diffs={data.diffs} atCommit={data.commits[0]?.hash ?? null} search={search} />
              ) : (
                <div className="commit-list">
                  {data.commits.map((c) => (
                    <div key={c.hash} className={`commit-item ${openCommit === c.hash ? 'open' : ''}`}>
                      <div className="commit-item-head" onClick={() => setOpenCommit(openCommit === c.hash ? null : c.hash)}>
                        <span className="muted">{openCommit === c.hash ? '▾' : '▸'}</span>
                        <Avatar login={c.author} size={22} />
                        <div className="grow">
                          <div className="ellipsis">{c.subject}</div>
                          <div className="small muted">
                            {c.author} · {relative(c.date)}
                          </div>
                        </div>
                        <span className="mono small muted">{c.shortHash}</span>
                      </div>
                      {openCommit === c.hash && (
                        <div className="commit-item-body">
                          {commit?.hash === c.hash ? <FileDiffList repoId={repoId} files={commit.files} diffs={commit.diffs} atCommit={commit.hash} search="" /> : <Spinner label="Loading commit…" />}
                        </div>
                      )}
                    </div>
                  ))}
                  {data.commits.length >= 500 && <div className="small muted mt">Showing the newest 500 commits.</div>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
