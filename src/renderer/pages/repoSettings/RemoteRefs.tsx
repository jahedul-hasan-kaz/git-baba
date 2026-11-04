import { useEffect, useMemo, useState } from 'react';
import type { GhRepoContext, RemoteCommit } from '../../../shared/github';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Avatar, relTime, Skeleton, useGh } from '../../components/github/common';
import { openExternal } from '../../components/github/SecureActionDialog';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';

import { Select } from '../../components/Select';
/** Branches, tags and commit history as they are on GitHub (not just what was fetched locally). */
export function RemoteRefs({ repoId, ctx }: { repoId: string; ctx: GhRepoContext }) {
  const [tab, setTab] = useState<'branches' | 'tags' | 'commits'>('branches');
  const branches = useGh(() => call('gh:adminBranches', { repoId }), [repoId]);
  const tags = useGh(() => call('gh:adminTags', { repoId }), [repoId]);
  const [ref, setRef] = useState(ctx.defaultBranch);
  const [q, setQ] = useState('');
  const { toast } = useApp();
  const copy = (t: string, what: string) => void call('app:copyText', { text: t }).then(() => toast(`${what} copied`));
  const query = q.trim().toLowerCase();

  const tagBySha = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tags.data ?? []) m.set(t.sha, [...(m.get(t.sha) ?? []), t.name]);
    return m;
  }, [tags.data]);

  return (
    <div>
      <div className="row mb">
        <div className="segmented">
          <button className={tab === 'branches' ? 'on' : ''} onClick={() => setTab('branches')}>
            ⎇ Branches {branches.data && <span className="badge">{branches.data.length}</span>}
          </button>
          <button className={tab === 'tags' ? 'on' : ''} onClick={() => setTab('tags')}>
            🏷 Tags {tags.data && <span className="badge">{tags.data.length}</span>}
          </button>
          <button className={tab === 'commits' ? 'on' : ''} onClick={() => setTab('commits')}>
            ◉ Commits
          </button>
        </div>
        {tab !== 'commits' && (
          <div className="actions-search" style={{ minWidth: 200 }}>
            <span>⌕</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${tab}…`} spellCheck={false} />
          </div>
        )}
        {tab === 'commits' && (
          <Select kind="ref" value={ref} onChange={(e) => setRef(e.target.value)} style={{ width: 'auto', maxWidth: 260 }}>
            <optgroup label="Branches">
              {(branches.data ?? [{ name: ctx.defaultBranch }]).map((b) => (
                <option key={`b:${b.name}`} value={b.name}>
                  ⎇ {b.name}
                </option>
              ))}
            </optgroup>
            {(tags.data?.length ?? 0) > 0 && (
              <optgroup label="Tags">
                {tags.data!.map((t) => (
                  <option key={`t:${t.name}`} value={t.name}>
                    🏷 {t.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        )}
      </div>

      {tab === 'branches' &&
        (branches.error ? (
          <ErrorPanel error={branches.error} />
        ) : !branches.data ? (
          <Skeleton rows={5} />
        ) : (
          <div className="key-list">
            {branches.data
              .filter((b) => !query || b.name.toLowerCase().includes(query))
              .sort((a, b) => Number(b.name === ctx.defaultBranch) - Number(a.name === ctx.defaultBranch) || Number(b.protected) - Number(a.protected) || a.name.localeCompare(b.name))
              .map((b) => (
                <div key={b.name} className="key-row">
                  <span className="key-ico">{b.protected ? '🛡' : '⎇'}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <strong className="mono ellipsis">{b.name}</strong>
                      {b.name === ctx.defaultBranch && <span className="badge info">default</span>}
                      {b.protected && <span className="badge ok">protected</span>}
                      {(tagBySha.get(b.sha) ?? []).map((t) => (
                        <span key={t} className="tag-chip">
                          🏷 {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button className="sha-chip" onClick={() => copy(b.sha, 'Commit id')} title="Copy the head commit id">
                    {b.sha.slice(0, 7)}
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => {
                      setRef(b.name);
                      setTab('commits');
                    }}
                  >
                    History
                  </button>
                </div>
              ))}
          </div>
        ))}

      {tab === 'tags' &&
        (tags.error ? (
          <ErrorPanel error={tags.error} />
        ) : !tags.data ? (
          <Skeleton rows={5} />
        ) : tags.data.length === 0 ? (
          <div className="empty small">No tags.</div>
        ) : (
          <div className="key-list">
            {tags.data
              .filter((t) => !query || t.name.toLowerCase().includes(query))
              .map((t) => (
                <div key={t.name} className="key-row">
                  <span className="key-ico">🏷</span>
                  <strong className="mono grow">{t.name}</strong>
                  <button className="btn sm ghost" onClick={() => copy(t.name, 'Tag')}>
                    ⧉ Copy
                  </button>
                  <button className="sha-chip" onClick={() => copy(t.sha, 'Commit id')}>
                    {t.sha.slice(0, 7)}
                  </button>
                  <button className="btn sm ghost" onClick={() => openExternal(`https://github.com/${ctx.owner}/${ctx.name}/releases/tag/${encodeURIComponent(t.name)}`)}>
                    ↗
                  </button>
                </div>
              ))}
          </div>
        ))}

      {tab === 'commits' && <CommitList repoId={repoId} refName={ref} tagBySha={tagBySha} />}
    </div>
  );
}

function CommitList({ repoId, refName, tagBySha }: { repoId: string; refName: string; tagBySha: Map<string, string[]> }) {
  const [commits, setCommits] = useState<RemoteCommit[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    call('gh:adminCommits', { repoId, ref: refName, page })
      .then((r) => {
        if (!live) return;
        setCommits((c) => (page === 1 ? r.commits : [...c, ...r.commits]));
        setHasMore(r.hasMore);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [repoId, refName, page]);
  useEffect(() => setPage(1), [refName]);

  // Group by day.
  const groups = useMemo(() => {
    const m = new Map<string, RemoteCommit[]>();
    for (const c of commits) {
      const d = c.date ? new Date(c.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown date';
      m.set(d, [...(m.get(d) ?? []), c]);
    }
    return [...m.entries()];
  }, [commits]);

  if (error) return <div className="small text-danger">{error}</div>;
  return (
    <div>
      {groups.map(([day, list]) => (
        <div key={day} className="commit-day">
          <div className="commit-day-title">◦ Commits on {day}</div>
          <div className="key-list">
            {list.map((c) => (
              <div key={c.sha} className="key-row clickable" onClick={() => openExternal(c.url)} title="Open on GitHub">
                <Avatar login={c.author} size={22} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <strong className="ellipsis">{c.message}</strong>
                    {c.verified && <span className="badge ok">✓ verified</span>}
                    {(tagBySha.get(c.sha) ?? []).map((t) => (
                      <span key={t} className="tag-chip">
                        🏷 {t}
                      </span>
                    ))}
                  </div>
                  <div className="small muted">
                    {c.author ?? 'unknown'} · {relTime(c.date)}
                  </div>
                </div>
                <span className="sha-chip">{c.sha.slice(0, 7)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {loading && <Skeleton rows={3} />}
      {!loading && commits.length === 0 && <div className="empty small">No commits.</div>}
      {hasMore && !loading && (
        <button className="btn mt" onClick={() => setPage((p) => p + 1)}>
          Load older commits
        </button>
      )}
    </div>
  );
}
