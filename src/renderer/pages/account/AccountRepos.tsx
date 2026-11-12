import { useEffect, useMemo, useState } from 'react';
import type { AccountRepo } from '../../../shared/github';
import type { FriendlyError } from '../../../shared/types';
import { ErrorPanel } from '../../components/ErrorPanel';
import { relTime, Skeleton } from '../../components/github/common';
import { openExternal } from '../../components/github/SecureActionDialog';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';

import { Select } from '../../components/Select';
type Sort = 'pushed' | 'size' | 'commits' | 'stars' | 'collaborators' | 'tags' | 'name';

export function formatSize(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
}

/** Every repository the account owns or works on, with size, commits, tags and collaborators at a glance. */
export function AccountRepos() {
  const { repos: local } = useApp();
  const [list, setList] = useState<AccountRepo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('pushed');
  const [scope, setScope] = useState<'all' | 'owner' | 'private' | 'public' | 'archived' | 'local'>('all');
  const [view, setView] = useState<'cards' | 'table'>('cards');

  const load = async (after: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const r = await call('gh:acctRepos', { after });
      setList((cur) => (after ? [...cur, ...r.repos] : r.repos));
      setCursor(r.endCursor);
      setHasMore(r.hasNextPage);
      setTotal(r.total);
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(null);
  }, []);

  const localSet = useMemo(() => new Set(local.filter((r) => r.github).map((r) => `${r.github!.owner}/${r.github!.repo}`.toLowerCase())), [local]);
  const login = list[0]?.owner;
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    const f = list.filter((r) => {
      if (query && !`${r.fullName} ${r.description ?? ''} ${r.language ?? ''}`.toLowerCase().includes(query)) return false;
      if (scope === 'private') return r.isPrivate;
      if (scope === 'public') return !r.isPrivate;
      if (scope === 'archived') return r.isArchived;
      if (scope === 'owner') return r.permission === 'ADMIN' && r.owner === login;
      if (scope === 'local') return localSet.has(r.fullName.toLowerCase());
      return true;
    });
    const num = (v: number | null) => v ?? -1;
    return [...f].sort((a, b) => {
      switch (sort) {
        case 'size':
          return b.sizeKb - a.sizeKb;
        case 'commits':
          return num(b.commits) - num(a.commits);
        case 'stars':
          return b.stars - a.stars;
        case 'collaborators':
          return num(b.collaborators) - num(a.collaborators);
        case 'tags':
          return num(b.tags) - num(a.tags);
        case 'name':
          return a.fullName.localeCompare(b.fullName);
        default:
          return (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '');
      }
    });
  }, [list, q, sort, scope, localSet, login]);
  const maxSize = Math.max(1, ...list.map((r) => r.sizeKb));
  const totals = useMemo(() => ({ size: list.reduce((s, r) => s + r.sizeKb, 0), commits: list.reduce((s, r) => s + (r.commits ?? 0), 0), tags: list.reduce((s, r) => s + (r.tags ?? 0), 0) }), [list]);

  return (
    <div>
      <div className="stat-tiles small-tiles">
        <div className="stat-tile">
          <span className="stat-ico">📦</span>
          <div>
            <div className="stat-value">{total}</div>
            <div className="small muted">repositories{hasMore ? ` (${list.length} loaded)` : ''}</div>
          </div>
        </div>
        <div className="stat-tile">
          <span className="stat-ico">💾</span>
          <div>
            <div className="stat-value">{formatSize(totals.size)}</div>
            <div className="small muted">total size</div>
          </div>
        </div>
        <div className="stat-tile">
          <span className="stat-ico">◉</span>
          <div>
            <div className="stat-value">{totals.commits.toLocaleString()}</div>
            <div className="small muted">commits on default branches</div>
          </div>
        </div>
        <div className="stat-tile">
          <span className="stat-ico">🏷</span>
          <div>
            <div className="stat-value">{totals.tags.toLocaleString()}</div>
            <div className="small muted">tags</div>
          </div>
        </div>
      </div>

      <div className="actions-filters">
        <div className="actions-search">
          <span>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a repository, description or language…" spellCheck={false} />
        </div>
        <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} style={{ width: 'auto' }}>
          <option value="all">All</option>
          <option value="owner">Owned by me</option>
          <option value="private" data-icon="🔒" data-desc="Only you and people you invite">Private</option>
          <option value="public" data-icon="🌐" data-desc="Anyone on the internet can see it">Public</option>
          <option value="archived">Archived</option>
          <option value="local">In Git Baba</option>
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} style={{ width: 'auto' }}>
          <option value="pushed">Recently pushed</option>
          <option value="size">Largest</option>
          <option value="commits">Most commits</option>
          <option value="collaborators">Most collaborators</option>
          <option value="tags">Most tags</option>
          <option value="stars">Most stars</option>
          <option value="name">Name</option>
        </Select>
        <div className="segmented sm">
          <button className={view === 'cards' ? 'on' : ''} onClick={() => setView('cards')}>
            ▦ Cards
          </button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>
            ☰ Table
          </button>
        </div>
      </div>

      {error && <ErrorPanel error={error} />}
      {loading && list.length === 0 && <Skeleton rows={6} />}
      {!loading && shown.length === 0 && <div className="empty">No repository matches.</div>}

      {view === 'cards' ? (
        <div className="repo-cards">
          {shown.map((r) => (
            <div key={r.fullName} className={`repo-card ${r.isArchived ? 'archived' : ''}`} onClick={() => openExternal(r.url)} title="Open on GitHub">
              <div className="row" style={{ gap: 6 }}>
                <strong className="ellipsis grow">{r.fullName}</strong>
                {r.isPrivate ? <span className="badge warn">private</span> : <span className="badge">public</span>}
                {r.isFork && <span className="badge">fork</span>}
                {r.isArchived && <span className="badge">archived</span>}
                {localSet.has(r.fullName.toLowerCase()) && <span className="badge ok" title="Cloned in Git Baba">local</span>}
              </div>
              <div className="small muted repo-card-desc">{r.description || 'No description'}</div>
              <div className="repo-metrics">
                <Metric icon="💾" label="Size" value={formatSize(r.sizeKb)} />
                <Metric icon="◉" label="Commits" value={r.commits?.toLocaleString() ?? '—'} />
                <Metric icon="🏷" label="Tags" value={r.tags?.toLocaleString() ?? '—'} />
                <Metric icon="👥" label="Collaborators" value={r.collaborators?.toLocaleString() ?? '—'} hint={r.collaborators === null ? 'Needs push access to see collaborators' : undefined} />
              </div>
              <div className="size-bar" title={`${formatSize(r.sizeKb)} of your largest repository's ${formatSize(maxSize)}`}>
                <i style={{ width: `${Math.max(2, (r.sizeKb / maxSize) * 100)}%` }} />
              </div>
              <div className="row small muted" style={{ gap: 10 }}>
                {r.language && (
                  <span className="row" style={{ gap: 4 }}>
                    <span className="lang-dot" style={{ background: r.languageColor ?? 'var(--text-3)' }} />
                    {r.language}
                  </span>
                )}
                <span>★ {r.stars}</span>
                <span>⑂ {r.forks}</span>
                <span className="spacer" />
                <span>{r.pushedAt ? `pushed ${relTime(r.pushedAt)}` : 'never pushed'}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table className="list repo-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Visibility</th>
              <th style={{ textAlign: 'right' }}>Size</th>
              <th style={{ textAlign: 'right' }}>Commits</th>
              <th style={{ textAlign: 'right' }}>Tags</th>
              <th style={{ textAlign: 'right' }}>Collaborators</th>
              <th>Role</th>
              <th>Pushed</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.fullName} onClick={() => openExternal(r.url)} style={{ cursor: 'pointer' }}>
                <td className="mono small">{r.fullName}</td>
                <td>{r.isPrivate ? <span className="badge warn">private</span> : <span className="badge">public</span>}</td>
                <td style={{ textAlign: 'right' }}>{formatSize(r.sizeKb)}</td>
                <td style={{ textAlign: 'right' }}>{r.commits?.toLocaleString() ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>{r.tags ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>{r.collaborators ?? '—'}</td>
                <td className="small">{r.permission?.toLowerCase() ?? '—'}</td>
                <td className="small muted">{relTime(r.pushedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hasMore && (
        <div className="row mt">
          <button className="btn" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? 'Loading…' : `Load more (${total - list.length} left)`}
          </button>
        </div>
      )}
    </div>
  );
}

function Metric({ icon, label, value, hint }: { icon: string; label: string; value: string; hint?: string }) {
  return (
    <div className="metric" title={hint}>
      <span className="metric-ico">{icon}</span>
      <div>
        <div className="metric-val">{value}</div>
        <div className="metric-lbl">{label}</div>
      </div>
    </div>
  );
}
