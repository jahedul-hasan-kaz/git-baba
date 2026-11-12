import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  const [sort, setSort] = useState<SortKey>('recent');
  const [commitOrder, setCommitOrder] = useState<'newest' | 'oldest'>('newest');
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
        <span className="spacer" />
        {tab !== 'commits' && (
          <Select kind="plain" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ width: 'auto' }} aria-label="Sort">
            <option value="recent">Newest commit first</option>
            <option value="oldest">Oldest commit first</option>
            <option value="name">Name A → Z</option>
            <option value="name-desc">Name Z → A</option>
            {tab === 'tags' && <option value="order">Tag order (as on GitHub)</option>}
          </Select>
        )}
        {tab === 'commits' && (
          <Select kind="plain" value={commitOrder} onChange={(e) => setCommitOrder(e.target.value as 'newest' | 'oldest')} style={{ width: 'auto' }} aria-label="Commit order">
            <option value="newest">Newest commits first</option>
            <option value="oldest">Oldest commits first</option>
          </Select>
        )}
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
          <div className="ref-grid">
            {sortRefs(
              branches.data.filter((b) => !query || b.name.toLowerCase().includes(query)),
              sort === 'order' ? 'recent' : sort,
              (b) => Number(b.name === ctx.defaultBranch) * 2 + Number(b.protected),
            ).map((b) => (
              <RefCard
                key={b.name}
                icon={b.protected ? '🛡' : '⎇'}
                name={b.name}
                info={b}
                badges={
                  (b.name === ctx.defaultBranch || b.protected || tagBySha.has(b.sha)) && (
                    <>
                      {b.name === ctx.defaultBranch && <span className="badge info">default</span>}
                      {b.protected && <span className="badge ok">protected</span>}
                      {(tagBySha.get(b.sha) ?? []).map((t) => (
                        <span key={t} className="tag-chip">
                          🏷 {t}
                        </span>
                      ))}
                    </>
                  )
                }
                sha={b.sha}
                onCopySha={() => copy(b.sha, 'Commit id')}
                actions={
                  <button
                    className="btn sm ghost"
                    onClick={() => {
                      setRef(b.name);
                      setTab('commits');
                    }}
                  >
                    History →
                  </button>
                }
              />
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
          <div className="ref-grid">
            {sortRefs(
              tags.data.filter((t) => !query || t.name.toLowerCase().includes(query)),
              sort,
              () => 0,
            ).map((t) => (
              <RefCard
                key={t.name}
                icon="🏷"
                name={t.name}
                info={t}
                sha={t.sha}
                onCopySha={() => copy(t.sha, 'Commit id')}
                actions={
                  <>
                    <button className="btn sm ghost" onClick={() => copy(t.name, 'Tag')}>
                      ⧉ Copy
                    </button>
                    <button className="btn sm ghost" onClick={() => openExternal(`https://github.com/${ctx.owner}/${ctx.name}/releases/tag/${encodeURIComponent(t.name)}`)}>
                      Release ↗
                    </button>
                  </>
                }
              />
            ))}
          </div>
        ))}

      {tab === 'commits' && <CommitList repoId={repoId} refName={ref} tagBySha={tagBySha} order={commitOrder} />}
    </div>
  );
}

function CommitList({ repoId, refName, tagBySha, order }: { repoId: string; refName: string; tagBySha: Map<string, string[]>; order: 'newest' | 'oldest' }) {
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
    const sorted = order === 'newest' ? commits : [...commits].reverse();
    for (const c of sorted) {
      const d = c.date ? new Date(c.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown date';
      m.set(d, [...(m.get(d) ?? []), c]);
    }
    return [...m.entries()];
  }, [commits, order]);

  if (error) return <div className="small text-danger">{error}</div>;
  return (
    <div>
      {groups.map(([day, list]) => (
        <div key={day} className="commit-day">
          <div className="commit-day-title">◦ Commits on {day}</div>
          <div className="ref-grid">
            {list.map((c) => (
              <div key={c.sha} className="ref-card clickable" onClick={() => openExternal(c.url)} title="Open on GitHub">
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

type SortKey = 'recent' | 'oldest' | 'name' | 'name-desc' | 'order';

/** Sorts branches or tags; `pin` keeps important refs (default, protected) first. "order" keeps GitHub's order. */
function sortRefs<T extends { name: string; date?: string | null }>(list: T[], sort: SortKey, pin: (x: T) => number): T[] {
  if (sort === 'order') return list;
  const time = (x: T) => (x.date ? Date.parse(x.date) : 0);
  return [...list].sort((a, b) => {
    const p = pin(b) - pin(a);
    if (p) return p;
    if (sort === 'recent') return time(b) - time(a) || a.name.localeCompare(b.name);
    if (sort === 'oldest') return (time(a) || Infinity) - (time(b) || Infinity) || a.name.localeCompare(b.name);
    return sort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : b.name.localeCompare(a.name, undefined, { numeric: true });
  });
}

function RefCard(props: {
  icon: string;
  name: string;
  info: { date?: string | null; author?: string | null; message?: string | null };
  badges?: ReactNode;
  sha: string;
  onCopySha: () => void;
  actions: ReactNode;
}) {
  const { icon, name, info, badges, sha, onCopySha, actions } = props;
  return (
    <div className="ref-card">
      <div className="ref-card-head">
        <span className="key-ico">{icon}</span>
        <strong className="mono ellipsis grow" title={name}>
          {name}
        </strong>
        <button className="sha-chip" onClick={onCopySha} title="Copy the head commit id">
          {sha.slice(0, 7)}
        </button>
      </div>
      {badges && (
        <div className="row wrap" style={{ gap: 4 }}>
          {badges}
        </div>
      )}
      <div className="ref-card-msg ellipsis" title={info.message ?? ''}>
        {info.message ?? <span className="muted">—</span>}
      </div>
      <div className="ref-card-foot">
        {info.author && <Avatar login={info.author} size={16} />}
        <span className="small muted grow ellipsis" title={info.date ? new Date(info.date).toLocaleString() : ''}>
          {info.author ?? 'unknown'}
          {info.date ? ` · ${relTime(info.date)}` : ''}
        </span>
        {actions}
      </div>
    </div>
  );
}
