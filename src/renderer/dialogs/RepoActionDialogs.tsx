import { useEffect, useMemo, useState } from 'react';
import type { AuthContext, CommitDetails, FriendlyError, RepoContributor, RepoSummary, TagInfo } from '../../shared/types';
import { AuthMethodPicker, type AuthSelection } from '../components/AuthMethodPicker';
import { ErrorPanel } from '../components/ErrorPanel';
import { FileDiffList } from '../components/FileDiffList';
import { Modal, Spinner } from '../components/Modal';
import { call, toFriendly } from '../services/api';
import { ownerRepoFromUrl, shortDate, timeAgo } from '../services/format';
import { useApp } from '../state/AppState';

import { Select } from '../components/Select';
function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Stable hue per name so the same person always gets the same avatar colour. */
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const hue = hueOf(name);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${hue} 55% 32%)`, color: `hsl(${hue} 90% 88%)` }}>
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------- duplicate

export function DuplicateRepoDialog({ repo, onClose, onDone }: { repo: RepoSummary; onClose: () => void; onDone: (r: RepoSummary) => void }) {
  const [name, setName] = useState(`${repo.name}-copy`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const parent = repo.path.replace(/[\\/][^\\/]+$/, '');
  const valid = /^[^<>:"/\\|?*]+$/.test(name) && !/[. ]$/.test(name) && name !== repo.name;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await call('repo:duplicate', { repoId: repo.id, name: name.trim() }));
    } catch (err) {
      setError(toFriendly(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Duplicate Repository"
      icon="⧉"
      size="narrow"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={run} disabled={!valid || busy}>
            {busy ? 'Duplicating…' : 'Duplicate'}
          </button>
        </>
      }
    >
      <p>
        Creates an independent local copy of <strong>{repo.name}</strong> with its full history and branches. The copy keeps the same remote, and nothing is sent to the network.
      </p>
      <label className="field">
        <span>New name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && valid && !busy && run()} />
      </label>
      <div className="small muted ellipsis" title={`${parent}\\${name}`}>
        📁 {parent}\{name || '…'}
      </div>
      {error && <ErrorPanel error={error} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- contributors

type ContributorFilter = 'all' | 'joined' | 'active' | 'left';

export function ContributorsDialog({ repo, onClose }: { repo: RepoSummary; onClose: () => void }) {
  const [list, setList] = useState<RepoContributor[] | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [filter, setFilter] = useState<ContributorFilter>('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    call('repo:contributors', { repoId: repo.id })
      .then(setList)
      .catch((err) => setError(toFriendly(err)));
  }, [repo.id]);

  const counts = useMemo(() => {
    const c = { all: 0, joined: 0, active: 0, left: 0 };
    for (const x of list ?? []) {
      c.all++;
      c[x.status]++;
    }
    return c;
  }, [list]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (list ?? []).filter((c) => (filter === 'all' || c.status === filter) && (!term || `${c.name} ${c.email}`.toLowerCase().includes(term)));
  }, [list, filter, q]);
  const max = Math.max(1, ...(list ?? []).map((c) => c.commits));

  const label: Record<ContributorFilter, string> = { all: 'All', joined: 'Joined', active: 'Active', left: 'Removed' };

  return (
    <Modal title={`Contributors · ${repo.name}`} icon="👥" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="segmented sm">
          {(Object.keys(label) as ContributorFilter[]).map((k) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {label[k]} <span className="muted">{counts[k]}</span>
            </button>
          ))}
        </div>
        <input className="grow" style={{ minWidth: 140 }} placeholder="Filter by name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        From local history (all branches). <b>Joined</b>: first commit in the last 30 days · <b>Removed</b>: no commits for 90+ days.
      </div>
      {error && <ErrorPanel error={error} />}
      {!list && !error && <Spinner label="Reading history…" />}
      {list && shown.length === 0 && <div className="muted small">No contributors match.</div>}
      <div className="contrib-list">
        {shown.map((c) => (
          <div key={c.email} className="contrib-row">
            <Avatar name={c.name} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <strong className="ellipsis">{c.name}</strong>
                <span className={`badge ${c.status === 'joined' ? 'ok' : c.status === 'left' ? 'danger' : 'info'}`}>{c.status === 'left' ? 'removed' : c.status}</span>
              </div>
              <div className="small muted ellipsis">
                {c.email} · since {shortDate(c.firstCommit)} · last {timeAgo(c.lastCommit)}
              </div>
              <div className="contrib-bar">
                <span style={{ width: `${(c.commits / max) * 100}%` }} />
              </div>
            </div>
            <div className="contrib-count">
              {c.commits}
              <span className="small muted"> commits</span>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- last commit

function CommitView({ repoId, hash, banner }: { repoId: string; hash: string; banner?: React.ReactNode }) {
  const [commit, setCommit] = useState<CommitDetails | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);

  useEffect(() => {
    let live = true;
    setCommit(null);
    setError(null);
    call('graph:commit', { repoId, hash })
      .then((c) => live && setCommit(c))
      .catch((err) => live && setError(toFriendly(err)));
    return () => {
      live = false;
    };
  }, [repoId, hash]);

  if (error) return <ErrorPanel error={error} />;
  if (!commit) return <Spinner label="Loading commit…" />;
  return (
    <>
      {banner}
      <div className="last-commit-hero">
        <Avatar name={commit.author} size={40} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{commit.subject}</div>
          <div className="small muted">
            <strong style={{ color: 'var(--text-2)' }}>{commit.author}</strong> &lt;{commit.email}&gt; committed {timeAgo(commit.date)} · {shortDate(commit.date)}
          </div>
          {commit.body && <pre className="last-commit-body">{commit.body}</pre>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <code className="pill">{commit.shortHash}</code>
          <span className="small">
            <span style={{ color: 'var(--ok)' }}>+{commit.additions}</span> <span style={{ color: 'var(--danger)' }}>−{commit.deletions}</span> · {commit.files.length} file(s)
          </span>
        </div>
      </div>
      <FileDiffList repoId={repoId} files={commit.files} diffs={commit.diffs} atCommit={commit.hash} search="" />
    </>
  );
}

/** "Last commit & tag": two tabs — the commit at HEAD, and the most recently created tag (others selectable). */
export function LastCommitDialog({ repo, onClose }: { repo: RepoSummary; onClose: () => void }) {
  const [tab, setTab] = useState<'commit' | 'tag'>('commit');
  const [head, setHead] = useState<string | null | undefined>(undefined); // undefined = loading, null = no commits
  const [tags, setTags] = useState<TagInfo[] | null>(null);
  const [tagName, setTagName] = useState<string | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);

  useEffect(() => {
    call('git:status', { repoId: repo.id })
      .then((st) => setHead(st.headOid ?? null))
      .catch((err) => setError(toFriendly(err)));
    call('graph:recentTags', { repoId: repo.id, limit: 30 })
      .then((t) => {
        setTags(t);
        setTagName(t[0]?.name ?? null);
      })
      .catch(() => setTags([]));
  }, [repo.id]);

  const tag = tags?.find((t) => t.name === tagName) ?? null;

  return (
    <Modal title={`Last Commit & Tag · ${repo.name}`} icon="◉" size="wide" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="segmented mb" role="tablist">
        <button className={tab === 'commit' ? 'on' : ''} onClick={() => setTab('commit')}>
          ◉ Last commit
        </button>
        <button className={tab === 'tag' ? 'on' : ''} onClick={() => setTab('tag')}>
          🏷 Last tag{tags && tags.length > 0 ? ` · ${tags[0].name}` : ''}
        </button>
      </div>

      {error && <ErrorPanel error={error} />}

      {tab === 'commit' && (
        <>
          {head === undefined && !error && <Spinner label="Loading commit…" />}
          {head === null && <div className="empty small">This repository has no commits yet.</div>}
          {head && <CommitView repoId={repo.id} hash={head} />}
        </>
      )}

      {tab === 'tag' && (
        <>
          {tags === null && <Spinner label="Loading tags…" />}
          {tags && tags.length === 0 && <div className="empty small">This repository has no tags yet.</div>}
          {tags && tag && (
            <CommitView
              repoId={repo.id}
              hash={tag.commit}
              banner={
                <div className="tag-banner">
                  <span className="ref-badge tag">🏷 {tag.name}</span>
                  <div className="grow small" style={{ minWidth: 0 }}>
                    {tag.annotated ? 'Annotated tag' : 'Lightweight tag'}
                    {tag.tagger ? ` by ${tag.tagger}` : ''}
                    {tag.date ? ` · ${timeAgo(tag.date)} (${shortDate(tag.date)})` : ''}
                    {tag.message && <div className="muted ellipsis">{tag.message}</div>}
                  </div>
                  {tags.length > 1 && (
                    <Select kind="tag" value={tag.name} onChange={(e) => setTagName(e.target.value)} aria-label="Choose a tag" style={{ width: 'auto', maxWidth: 220 }}>
                      {tags.map((t, i) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                          {i === 0 ? ' (latest)' : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              }
            />
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- remove

export function RemoveRepoDialog({ repo, onClose, onRemoved }: { repo: RepoSummary; onClose: () => void; onRemoved: (remoteMissing: boolean) => void }) {
  const { info } = useApp();
  const [options, setOptions] = useState<(AuthContext & { remoteUrl: string | null }) | null>(null);
  const [auth, setAuth] = useState<AuthSelection>({ input: null, summary: '' });
  const [authKey, setAuthKey] = useState(0);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const needsAuth = !!options?.remoteUrl && !/^(file:|[a-z]:[\\/]|\/|\.)/i.test(options.remoteUrl);

  useEffect(() => {
    if (!repo.exists) {
      setOptions({ authOptions: [], remoteUrl: null } as unknown as AuthContext & { remoteUrl: string | null });
      return;
    }
    call('repo:authOptions', { repoId: repo.id, purpose: 'fetch' })
      .then(setOptions)
      .catch(() => setOptions({ authOptions: [], remoteUrl: null } as unknown as AuthContext & { remoteUrl: string | null }));
  }, [repo.id, repo.exists]);

  const ready = typed === repo.name && (!needsAuth || !!auth.input) && !busy;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('repo:remove', { repoId: repo.id, auth: needsAuth ? auth.input ?? undefined : undefined });
      onRemoved(!!r?.remoteMissing);
    } catch (err) {
      setError(toFriendly(err));
      setAuthKey((k) => k + 1);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Remove Repository"
      icon="⚠"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" onClick={run} disabled={!ready}>
            {busy ? (needsAuth ? 'Verifying…' : 'Removing…') : needsAuth ? 'Verify & remove' : 'Remove'}
          </button>
        </>
      }
    >
      <p>
        Removes <strong>{repo.name}</strong> from Git Baba and forgets credentials saved for it. The folder <code>{repo.path}</code>, its files and history are <strong>not deleted</strong>.
      </p>
      {error && <ErrorPanel error={error} onAction={() => setAuthKey((k) => k + 1)} available={['review-auth']} />}
      {!options ? (
        <Spinner />
      ) : (
        needsAuth && (
          <div className="card" style={{ marginTop: 8 }}>
            <h3 style={{ marginTop: 0 }}>🔐 Verify your access</h3>
            <p className="small muted">Like before a push, confirm the credentials for {options.remoteUrl}. They are checked once with a read-only request and not stored.</p>
            <AuthMethodPicker
              key={authKey}
              options={options.authOptions}
              githubApp={options.githubApp}
              savedSshKey={options.savedSshKey}
              repoId={repo.id}
              purpose="fetch"
              remoteOwnerRepo={ownerRepoFromUrl(options.remoteUrl)}
              canSave={!!repo.settings.allowSavedCredentials && !!info?.encryptionAvailable}
              onChange={setAuth}
            />
          </div>
        )
      )}
      <label className="field">
        <span>
          Type <strong>{repo.name}</strong> to confirm
        </span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
    </Modal>
  );
}
