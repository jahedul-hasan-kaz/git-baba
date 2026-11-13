import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CodeSearchHit, GraphCommit, TagInfo } from '../../../shared/types';
import { call } from '../../services/api';
import { requestJump } from '../../services/jump';
import { useApp } from '../../state/AppState';

type Scope = 'all' | 'id' | 'message' | 'code' | 'tag';
const SCOPES: { id: Scope; label: string; icon: string; hint: string }[] = [
  { id: 'all', label: 'All', icon: '✦', hint: 'commits, code and tags' },
  { id: 'id', label: 'Commit ID', icon: '#', hint: 'a commit id or its first characters' },
  { id: 'message', label: 'Message', icon: '✎', hint: 'words in commit messages' },
  { id: 'code', label: 'Code', icon: '</>', hint: 'text in files and file names' },
  { id: 'tag', label: 'Tag', icon: '🏷', hint: 'tag names and messages' },
];

type Item =
  | { key: string; kind: 'commit'; commit: GraphCommit; via: 'id' | 'message' }
  | { key: string; kind: 'tag'; tag: TagInfo }
  | { key: string; kind: 'file'; path: string }
  | { key: string; kind: 'hit'; hit: CodeSearchHit };

const SHA = /^[0-9a-f]{4,40}$/i;

function rel(iso: string | null | undefined) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  const units: [number, string][] = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [n, l] of units) if (s >= n) return `${Math.floor(s / n)}${l} ago`;
  return '';
}

/** Wraps every case-insensitive occurrence of `q` in <mark>. */
function Hi({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts: ReactNode[] = [];
  const low = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  let at = low.indexOf(ql);
  while (at !== -1 && parts.length < 40) {
    if (at > i) parts.push(text.slice(i, at));
    parts.push(<mark key={at}>{text.slice(at, at + q.length)}</mark>);
    i = at + q.length;
    at = low.indexOf(ql, i);
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

/**
 * Spotlight-style search for the active repository: commit ids, commit messages, code and tags,
 * all queried in parallel as you type. Tags are filtered locally (instant); the Git searches run after
 * a short pause and stale answers are dropped, so only the latest keystroke's results ever show.
 */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { activeRepo, setRepoTab } = useApp();
  const repoId = activeRepo!.id;
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>(() => {
    try {
      const s = localStorage.getItem('gb.search.scope') as Scope | null;
      return s && SCOPES.some((x) => x.id === s) ? s : 'all';
    } catch {
      return 'all';
    }
  });
  const [tags, setTags] = useState<TagInfo[] | null>(null);
  const [ref, setRef] = useState('HEAD');
  const [commits, setCommits] = useState<{ list: GraphCommit[]; via: 'id' | 'message' } | null>(null);
  const [code, setCode] = useState<{ files: string[]; hits: CodeSearchHit[]; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState({ commits: false, code: false });
  const [active, setActive] = useState(0);
  const [ms, setMs] = useState<number | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem('gb.search.scope', scope);
    } catch {
      /* convenience */
    }
  }, [scope]);

  // Tags once (then filtered locally on every keystroke) and the branch whose code is searched.
  useEffect(() => {
    call('graph:recentTags', { repoId, limit: 1000 })
      .then(setTags)
      .catch(() => setTags([]));
    call('graph:refs', { repoId })
      .then((r) => setRef(r.current ?? 'HEAD'))
      .catch(() => undefined);
  }, [repoId]);

  const term = q.trim();
  const wantCommits = scope === 'all' || scope === 'message' || (scope === 'id' && SHA.test(term));
  const wantCode = (scope === 'all' || scope === 'code') && term.length >= 2;

  // Git-backed searches: short debounce, run in parallel, stale answers ignored.
  useEffect(() => {
    const n = ++seq.current;
    setActive(0);
    if (!term) {
      setCommits(null);
      setCode(null);
      setLoading({ commits: false, code: false });
      setMs(null);
      return;
    }
    if (!wantCommits) setCommits(null);
    if (!wantCode) setCode(null);
    const t0 = performance.now();
    const t = window.setTimeout(() => {
      const jobs: Promise<unknown>[] = [];
      if (wantCommits) {
        setLoading((l) => ({ ...l, commits: true }));
        jobs.push(
          call('graph:log', { repoId, query: { scope: 'all', search: term, limit: 30 } })
            .then((r) => {
              if (n !== seq.current) return;
              const low = term.toLowerCase();
              const byId = SHA.test(term) && r.commits.some((c) => c.hash.startsWith(low));
              const list = scope === 'id' ? r.commits.filter((c) => c.hash.startsWith(low)) : scope === 'message' && byId ? [] : r.commits;
              setCommits({ list, via: byId ? 'id' : 'message' });
            })
            .catch(() => {
              if (n === seq.current) setCommits({ list: [], via: 'message' });
            })
            .finally(() => {
              if (n === seq.current) setLoading((l) => ({ ...l, commits: false }));
            }),
        );
      }
      if (wantCode) {
        setLoading((l) => ({ ...l, code: true }));
        jobs.push(
          call('code:search', { repoId, ref, query: term })
            .then((r) => {
              if (n === seq.current) setCode(r);
            })
            .catch(() => {
              if (n === seq.current) setCode({ files: [], hits: [], truncated: false });
            })
            .finally(() => {
              if (n === seq.current) setLoading((l) => ({ ...l, code: false }));
            }),
        );
      }
      void Promise.all(jobs).then(() => {
        if (n === seq.current) setMs(Math.round(performance.now() - t0));
      });
    }, 140);
    return () => window.clearTimeout(t);
  }, [term, scope, repoId, ref, wantCommits, wantCode]);

  const tagHits = useMemo(() => {
    if (!tags || !term || !(scope === 'all' || scope === 'tag')) return [];
    const l = term.toLowerCase();
    return tags.filter((t) => t.name.toLowerCase().includes(l) || (t.message ?? '').toLowerCase().includes(l) || t.commit.startsWith(l)).slice(0, scope === 'tag' ? 50 : 6);
  }, [tags, term, scope]);

  // Result groups in display order; `items` is the flat keyboard order.
  const sections = useMemo(() => {
    const out: { id: 'commits' | 'tags' | 'files' | 'code'; title: string; icon: string; items: Item[]; more: number }[] = [];
    const cap = scope === 'all' ? 6 : 50;
    if (commits?.list.length) {
      const list = commits.list.slice(0, cap);
      out.push({
        id: 'commits',
        title: commits.via === 'id' ? 'Commit ID' : 'Commit messages',
        icon: commits.via === 'id' ? '#' : '✎',
        items: list.map((c) => ({ key: `c:${c.hash}`, kind: 'commit' as const, commit: c, via: commits.via })),
        more: commits.list.length - list.length,
      });
    }
    if (tagHits.length) out.push({ id: 'tags', title: 'Tags', icon: '🏷', items: tagHits.map((t) => ({ key: `t:${t.name}`, kind: 'tag' as const, tag: t })), more: 0 });
    if (code?.files.length) {
      const list = code.files.slice(0, cap);
      out.push({ id: 'files', title: 'Files', icon: '📄', items: list.map((f) => ({ key: `f:${f}`, kind: 'file' as const, path: f })), more: code.files.length - list.length });
    }
    if (code?.hits.length) {
      const list = code.hits.slice(0, scope === 'all' ? 8 : 100);
      out.push({ id: 'code', title: 'Code', icon: '</>', items: list.map((h, i) => ({ key: `h:${h.path}:${h.line}:${i}`, kind: 'hit' as const, hit: h })), more: code.hits.length - list.length });
    }
    return out;
  }, [commits, tagHits, code, scope]);
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const current = items[Math.min(active, items.length - 1)] ?? null;
  const busy = loading.commits || loading.code;

  useEffect(() => {
    listRef.current?.querySelector('.sp-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const open = useCallback(
    (it: Item | null) => {
      if (!it) return;
      if (it.kind === 'commit' || it.kind === 'tag') {
        requestJump({ kind: 'commit', repoId, hash: it.kind === 'commit' ? it.commit.hash : it.tag.commit });
        setRepoTab('changes');
      } else {
        requestJump({ kind: 'file', repoId, ref, path: it.kind === 'file' ? it.path : it.hit.path, line: it.kind === 'hit' ? it.hit.line : null });
        setRepoTab('code');
      }
      onClose();
    },
    [repoId, ref, setRepoTab, onClose],
  );

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(current);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const i = SCOPES.findIndex((s) => s.id === scope);
      setScope(SCOPES[(i + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length].id);
    }
  };

  const copy = (text: string) => void call('app:copyText', { text }).catch(() => undefined);
  const scopeFor = (id: string): Scope => (id === 'commits' ? (commits?.via === 'id' ? 'id' : 'message') : id === 'tags' ? 'tag' : 'code');
  let idx = -1;

  return createPortal(
    <div className="sp-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sp ${term ? 'has-q' : ''}`} role="dialog" aria-label="Search" onKeyDown={onKey}>
        <div className="sp-bar">
          <svg className={`sp-glass ${busy ? 'busy' : ''}`} viewBox="0 0 24 24" width="22" height="22" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5 21 21" />
          </svg>
          <input ref={inputRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${activeRepo!.name}: ${SCOPES.find((s) => s.id === scope)!.hint}`} spellCheck={false} />
          {q && (
            <button
              className="sp-clear"
              onClick={() => {
                setQ('');
                inputRef.current?.focus();
              }}
              aria-label="Clear search text"
              title="Clear the search text"
            >
              Clear
            </button>
          )}
          <button className="sp-close" onClick={onClose} aria-label="Close search" title="Close (Esc)">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="sp-scopes" role="tablist">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={scope === s.id}
              className={`sp-scope ${scope === s.id ? 'on' : ''}`}
              onClick={() => {
                setScope(s.id);
                inputRef.current?.focus();
              }}
              title={`Search ${s.hint}`}
            >
              <span className="sp-scope-ico">{s.icon}</span>
              {s.label}
            </button>
          ))}
          <span className="sp-meta">
            {busy ? (
              <span className="sp-dots">
                <i />
                <i />
                <i />
              </span>
            ) : ms !== null && term ? (
              `${items.length} result${items.length === 1 ? '' : 's'} · ${ms} ms`
            ) : null}
          </span>
        </div>

        {term ? (
          <div className="sp-body">
            <div className="sp-list" ref={listRef}>
              {sections.length === 0 && !busy && (
                <div className="sp-empty">
                  <div className="sp-empty-ico">⌕</div>
                  <div>
                    No matches for <strong>“{term}”</strong>
                  </div>
                  {scope !== 'all' && (
                    <button className="btn sm ghost" onClick={() => setScope('all')}>
                      Search everything instead
                    </button>
                  )}
                </div>
              )}
              {sections.map((sec) => (
                <div key={sec.id} className="sp-sec">
                  <div className="sp-sec-title">
                    <span className="sp-sec-ico">{sec.icon}</span>
                    {sec.title}
                    {sec.more > 0 && <span className="sp-more">+{sec.more}</span>}
                    {sec.more > 0 && scope === 'all' && (
                      <button className="sp-showall" onClick={() => setScope(scopeFor(sec.id))}>
                        Show all ›
                      </button>
                    )}
                  </div>
                  {sec.items.map((it) => {
                    idx++;
                    const i = idx;
                    const on = current?.key === it.key;
                    return (
                      <div key={it.key} className={`sp-item ${on ? 'on' : ''}`} style={{ ['--d' as string]: `${Math.min(i, 12) * 18}ms` }} onMouseMove={() => i !== active && setActive(i)} onClick={() => open(it)}>
                        {it.kind === 'commit' && (
                          <>
                            <span className="sp-ico c">{it.commit.author.slice(0, 2).toUpperCase()}</span>
                            <span className="sp-main">
                              <span className="sp-title ellipsis">{it.via === 'message' ? <Hi text={it.commit.subject} q={term} /> : it.commit.subject}</span>
                              <span className="sp-sub ellipsis">
                                <span className="mono">{it.via === 'id' ? <Hi text={it.commit.shortHash} q={term} /> : it.commit.shortHash}</span> · {it.commit.author} · {rel(it.commit.date)}
                              </span>
                            </span>
                          </>
                        )}
                        {it.kind === 'tag' && (
                          <>
                            <span className="sp-ico t">🏷</span>
                            <span className="sp-main">
                              <span className="sp-title ellipsis">
                                <Hi text={it.tag.name} q={term} />
                              </span>
                              <span className="sp-sub ellipsis">
                                {it.tag.message ? <Hi text={it.tag.message} q={term} /> : it.tag.annotated ? 'annotated tag' : 'tag'} · <span className="mono">{it.tag.commit.slice(0, 7)}</span>
                              </span>
                            </span>
                          </>
                        )}
                        {it.kind === 'file' && (
                          <>
                            <span className="sp-ico f">📄</span>
                            <span className="sp-main">
                              <span className="sp-title ellipsis">
                                <Hi text={it.path.split('/').pop() ?? it.path} q={term} />
                              </span>
                              <span className="sp-sub ellipsis mono">{it.path}</span>
                            </span>
                          </>
                        )}
                        {it.kind === 'hit' && (
                          <>
                            <span className="sp-ico h">{'</>'}</span>
                            <span className="sp-main">
                              <span className="sp-title ellipsis mono sp-code">
                                <Hi text={it.hit.text.trim()} q={term} />
                              </span>
                              <span className="sp-sub ellipsis mono">
                                {it.hit.path}
                                {it.hit.line ? `:${it.hit.line}` : ''}
                              </span>
                            </span>
                          </>
                        )}
                        {on && <kbd className="sp-enter">↵</kbd>}
                      </div>
                    );
                  })}
                </div>
              ))}
              {busy && sections.length === 0 && (
                <div className="sp-skel">
                  {[0, 1, 2, 3].map((k) => (
                    <i key={k} style={{ ['--d' as string]: `${k * 90}ms` }} />
                  ))}
                </div>
              )}
              {code?.truncated && scope === 'code' && <div className="sp-note">Showing the first matches only. Type more to narrow it down.</div>}
            </div>
            <Preview item={current} q={term} repoId={repoId} onOpen={() => open(current)} onCopy={copy} />
          </div>
        ) : (
          <div className="sp-tips">
            {SCOPES.slice(1).map((s) => (
              <button
                key={s.id}
                className="sp-tip"
                onClick={() => {
                  setScope(s.id);
                  inputRef.current?.focus();
                }}
              >
                <span className="sp-tip-ico">{s.icon}</span>
                <span>
                  <strong>{s.label}</strong>
                  <span className="sp-sub">Find {s.hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="sp-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>tab</kbd> scope
          </span>
          <span className="grow" />
          <span>
            Code on <span className="mono">{ref}</span>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Right-hand preview of the highlighted result; commit details load lazily. */
function Preview({ item, q, repoId, onOpen, onCopy }: { item: Item | null; q: string; repoId: string; onOpen: () => void; onCopy: (t: string) => void }) {
  const hash = item?.kind === 'commit' ? item.commit.hash : item?.kind === 'tag' ? item.tag.commit : null;
  const [detail, setDetail] = useState<{ hash: string; body: string; files: number; add: number; del: number } | null>(null);
  useEffect(() => {
    if (!hash) return;
    let live = true;
    const t = window.setTimeout(() => {
      call('graph:commit', { repoId, hash })
        .then((d) => {
          if (live) setDetail({ hash, body: d.body ?? '', files: d.files.length, add: d.additions, del: d.deletions });
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [hash, repoId]);

  if (!item) return <div className="sp-preview empty">Use ↑ ↓ to look through the results</div>;
  const d = detail && detail.hash === hash ? detail : null;
  const stat = d && (
    <>
      {d.files} file{d.files === 1 ? '' : 's'} <span className="text-ok">+{d.add}</span> <span className="text-danger">−{d.del}</span>
    </>
  );
  return (
    <div className="sp-preview" key={item.key}>
      {item.kind === 'commit' && (
        <>
          <div className="sp-pv-kind">Commit</div>
          <div className="sp-pv-title">{item.commit.subject}</div>
          {d?.body.trim() && <pre className="sp-pv-body">{d.body.trim().slice(0, 600)}</pre>}
          <dl className="sp-pv-facts">
            <dt>Author</dt>
            <dd>{item.commit.author}</dd>
            <dt>Date</dt>
            <dd>{new Date(item.commit.date).toLocaleString()}</dd>
            <dt>ID</dt>
            <dd className="mono">{item.commit.hash.slice(0, 12)}</dd>
            {d && (
              <>
                <dt>Changes</dt>
                <dd>{stat}</dd>
              </>
            )}
            {item.commit.refs.length > 0 && (
              <>
                <dt>Refs</dt>
                <dd>{item.commit.refs.slice(0, 4).join(', ')}</dd>
              </>
            )}
          </dl>
          <div className="sp-pv-acts">
            <button className="btn sm primary" onClick={onOpen}>
              Open in history
            </button>
            <button className="btn sm ghost" onClick={() => onCopy(item.commit.hash)}>
              Copy ID
            </button>
          </div>
        </>
      )}
      {item.kind === 'tag' && (
        <>
          <div className="sp-pv-kind">Tag</div>
          <div className="sp-pv-title">🏷 {item.tag.name}</div>
          {item.tag.message && <pre className="sp-pv-body">{item.tag.message}</pre>}
          <dl className="sp-pv-facts">
            <dt>Points to</dt>
            <dd className="mono">{item.tag.commit.slice(0, 12)}</dd>
            {item.tag.tagger && (
              <>
                <dt>Tagger</dt>
                <dd>{item.tag.tagger}</dd>
              </>
            )}
            {item.tag.date && (
              <>
                <dt>Date</dt>
                <dd>{new Date(item.tag.date).toLocaleString()}</dd>
              </>
            )}
            {d && (
              <>
                <dt>Commit</dt>
                <dd>{stat}</dd>
              </>
            )}
          </dl>
          <div className="sp-pv-acts">
            <button className="btn sm primary" onClick={onOpen}>
              Open its commit
            </button>
            <button className="btn sm ghost" onClick={() => onCopy(item.tag.name)}>
              Copy name
            </button>
          </div>
        </>
      )}
      {(item.kind === 'file' || item.kind === 'hit') && (
        <>
          <div className="sp-pv-kind">{item.kind === 'file' ? 'File' : `Line ${item.hit.line ?? ''}`}</div>
          <div className="sp-pv-title mono">{(item.kind === 'file' ? item.path : item.hit.path).split('/').pop()}</div>
          <div className="sp-sub mono" style={{ wordBreak: 'break-all' }}>
            {item.kind === 'file' ? item.path : item.hit.path}
          </div>
          {item.kind === 'hit' && (
            <pre className="sp-pv-code">
              {item.hit.line !== null && <span className="sp-ln">{item.hit.line}</span>}
              <Hi text={item.hit.text} q={q} />
            </pre>
          )}
          <div className="sp-pv-acts">
            <button className="btn sm primary" onClick={onOpen}>
              Open in Code
            </button>
            <button className="btn sm ghost" onClick={() => onCopy(item.kind === 'file' ? item.path : item.hit.path)}>
              Copy path
            </button>
          </div>
        </>
      )}
    </div>
  );
}
