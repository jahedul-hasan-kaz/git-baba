import type { PrCommit, PrDetails } from '../../../../shared/github';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { Avatar, relTime, Skeleton, useGh } from '../../../components/github/common';
import { call } from '../../../services/api';
import { useApp } from '../../../state/AppState';
import { DiffStat } from './PrHero';

export const CHECK_STATE: Record<string, { cls: string; icon: string; label: string }> = {
  SUCCESS: { cls: 'ok', icon: '✓', label: 'All checks passed' },
  FAILURE: { cls: 'danger', icon: '✕', label: 'Some checks failed' },
  ERROR: { cls: 'danger', icon: '✕', label: 'Checks errored' },
  PENDING: { cls: 'warn', icon: '●', label: 'Checks running' },
  EXPECTED: { cls: 'warn', icon: '○', label: 'Waiting for checks' },
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

/** Commits of the pull request, oldest first and grouped by day, each with its check result. */
export function CommitsTimeline({ repoId, pr, onOpen, onChecks }: { repoId: string; pr: PrDetails; onOpen: (c: PrCommit) => void; onChecks: (oid: string) => void }) {
  const { toast, showError } = useApp();
  const commits = useGh(() => call('gh:prCommits', { repoId, number: pr.number }), [repoId, pr.number, pr.headRefOid]);
  if (commits.error) return <ErrorPanel error={commits.error} />;
  if (!commits.data) return <Skeleton rows={5} />;

  const groups: [string, PrCommit[]][] = [];
  for (const c of commits.data.commits) {
    const d = day(c.date);
    const last = groups[groups.length - 1];
    if (last && last[0] === d) last[1].push(c);
    else groups.push([d, [c]]);
  }
  const authors = new Set(commits.data.commits.map((c) => c.authorLogin ?? c.author));

  return (
    <div className="fade-in">
      <div className="row mb small muted">
        <span className="grow">
          {commits.data.total} commit{commits.data.total === 1 ? '' : 's'} by {authors.size} author{authors.size === 1 ? '' : 's'} · newest at the bottom, like GitHub
        </span>
        <button className="btn sm ghost" onClick={() => void commits.reload()}>
          ⟳ Refresh
        </button>
      </div>
      {commits.data.hasNextPage && <div className="banner info small">Showing the first 100 of {commits.data.total} commits.</div>}
      <div className="ctl">
        {groups.map(([d, list]) => (
          <div key={d} className="ctl-day">
            <div className="ctl-date">
              <span className="ctl-dot-day" />
              Commits on {d}
            </div>
            <div className="ctl-items">
              {list.map((c) => {
                const st = c.checkState ? CHECK_STATE[c.checkState] : null;
                const head = c.oid === pr.headRefOid;
                return (
                  <div key={c.oid} className={`ctl-item ${head ? 'head' : ''}`} onClick={() => onOpen(c)}>
                    <Avatar login={c.authorLogin ?? c.author} size={26} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="ellipsis">
                        <strong>{c.headline}</strong> {head && <span className="badge info">latest</span>}
                      </div>
                      <div className="small muted">
                        {c.authorLogin ?? c.author} committed {relTime(c.date)}
                        {c.changedFiles !== null ? ` · ${c.changedFiles} file${c.changedFiles === 1 ? '' : 's'}` : ''}
                      </div>
                    </div>
                    <DiffStat add={c.additions} del={c.deletions} />
                    <button
                      className={`check-dot ${st?.cls ?? 'muted'}`}
                      title={st ? `${st.label} — show checks of this commit` : 'No checks ran — show details'}
                      onClick={(e) => {
                        e.stopPropagation();
                        onChecks(c.oid);
                      }}
                    >
                      {st?.icon ?? '–'}
                    </button>
                    <button
                      className="btn sm ghost mono"
                      title="Copy full SHA"
                      onClick={(e) => {
                        e.stopPropagation();
                        void call('app:copyText', { text: c.oid }).then(() => toast('SHA copied'), showError);
                      }}
                    >
                      {c.shortOid}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
