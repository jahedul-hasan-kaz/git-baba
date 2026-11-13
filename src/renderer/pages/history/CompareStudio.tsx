import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { BranchChanges, CommitStatFile, CompareResult, FileDiff, FriendlyError } from '../../../shared/types';
import { BranchPicker, type PickerItem } from '../../components/BranchPicker';
import { DiffViewer } from '../../components/DiffViewer';
import { call, toFriendly } from '../../services/api';

const COLORS = ['#5b8cff', '#3ecf8e', '#f5b84a', '#ff6b6b', '#b18cff', '#6cc4ff', '#ff9f6b', '#9fd36b'];
const colorOf = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
const isSha = (s: string) => /^[0-9a-f]{7,40}$/i.test(s);
const label = (s: string) => (isSha(s) ? s.slice(0, 8) : s);

type Res<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; error: FriendlyError };
type Lens = 'adds' | 'direct';
type Tab = 'changes' | 'commits';

function readNum(key: string, def: number, min: number, max: number) {
  try {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  } catch {
    return def;
  }
}
function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* convenience */
  }
}

interface Props {
  repoId: string;
  /** Pre-filled sources (e.g. the selected commit) and target (e.g. the current branch). */
  initialSources?: string[];
  initialTarget?: string | null;
  onClose: () => void;
}

/**
 * Compare several sources (branches, tags or commits) with one target.
 * - "What it adds": the source's own changes since it split from the target (what a merge would bring).
 * - "Direct difference": the two as they are right now, side by side (target on the left, source on the right).
 * Files changed by several sources are flagged as likely conflicts. The panes are resizable.
 */
export function CompareStudio({ repoId, initialSources = [], initialTarget = null, onClose }: Props) {
  const [refs, setRefs] = useState<{ current: string | null; branches: string[]; remotes: string[]; tags: string[] } | null>(null);
  const [sources, setSources] = useState<string[]>(initialSources);
  const [target, setTarget] = useState<string>(initialTarget ?? '');
  const [focus, setFocus] = useState<string | null>(initialSources[0] ?? null);
  const [adds, setAdds] = useState<Record<string, Res<BranchChanges>>>({});
  const [direct, setDirect] = useState<Record<string, Res<CompareResult>>>({});
  const [tab, setTab] = useState<Tab>('changes');
  const [lens, setLens] = useState<Lens>(() => {
    try {
      return localStorage.getItem('gb.compare.lens') === 'direct' ? 'direct' : 'adds';
    } catch {
      return 'adds';
    }
  });
  const [sha, setSha] = useState('');
  const [hotFile, setHotFile] = useState<string | null>(null);
  const [split, setSplit] = useState(() => readNum('gb.compare.split', 26, 16, 60));
  const [dragging, setDragging] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => save('gb.compare.lens', lens), [lens]);

  useEffect(() => {
    call('graph:refs', { repoId })
      .then((r) => {
        setRefs(r);
        setTarget((t) => t || r.current || r.branches[0] || '');
      })
      .catch(() => setRefs({ current: null, branches: [], remotes: [], tags: [] }));
  }, [repoId]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  const keyOf = (s: string) => `${s}\u0000${target}`;

  // "What it adds" for every source (drives the cards, totals and overlaps), in parallel and cached.
  useEffect(() => {
    if (!target) return;
    for (const s of sources) {
      const key = keyOf(s);
      if (adds[key]) continue;
      setAdds((r) => ({ ...r, [key]: { status: 'loading' } }));
      call('graph:branchChanges', { repoId, branch: s, base: target })
        .then((data) => setAdds((r) => ({ ...r, [key]: { status: 'ok', data } })))
        .catch((err) => setAdds((r) => ({ ...r, [key]: { status: 'error', error: toFriendly(err) } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, target, repoId]);

  const focused = focus && sources.includes(focus) ? focus : (sources[0] ?? null);

  // "Direct difference" only for the source being looked at, when that lens is on.
  useEffect(() => {
    if (!target || !focused || lens !== 'direct' || tab !== 'changes') return;
    const key = keyOf(focused);
    if (direct[key]) return;
    setDirect((r) => ({ ...r, [key]: { status: 'loading' } }));
    call('graph:compare', { repoId, from: target, to: focused })
      .then((data) => setDirect((r) => ({ ...r, [key]: { status: 'ok', data } })))
      .catch((err) => setDirect((r) => ({ ...r, [key]: { status: 'error', error: toFriendly(err) } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, target, lens, tab, repoId]);

  const items: PickerItem[] = useMemo(() => {
    if (!refs) return [];
    return [
      ...refs.branches.map((n) => ({ name: n, current: n === refs.current })),
      ...refs.remotes.filter((n) => !n.endsWith('/HEAD')).map((n) => ({ name: n, remote: true })),
      ...refs.tags.map((n) => ({ name: n, subject: 'tag' })),
    ];
  }, [refs]);

  const add = (name: string) => {
    const n = name.trim();
    if (!n || n === target) return;
    setSources((s) => (s.includes(n) ? s : [...s, n]));
    setFocus(n);
  };
  const remove = (name: string) => {
    setSources((s) => s.filter((x) => x !== name));
    setFocus((f) => (f === name ? (sources.find((x) => x !== name) ?? null) : f));
  };
  const chooseTarget = (name: string) => {
    if (!name) return;
    setSources((s) => s.filter((x) => x !== name));
    setTarget(name);
  };
  const swapWith = (name: string) => {
    const old = target;
    setSources((s) => [...s.filter((x) => x !== name), ...(old ? [old] : [])]);
    setTarget(name);
    setFocus(old || null);
  };

  const ok = (s: string) => {
    const r = adds[keyOf(s)];
    return r?.status === 'ok' ? r.data : null;
  };
  const hotspots = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const s of sources) ok(s)?.files.forEach((f) => by.set(f.path, [...(by.get(f.path) ?? []), s]));
    return [...by.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, adds, target]);
  const totals = useMemo(() => {
    const files = new Set<string>();
    let commits = 0;
    for (const s of sources) {
      const d = ok(s);
      if (!d) continue;
      commits += d.ahead;
      d.files.forEach((f) => files.add(f.path));
    }
    return { commits, files: files.size };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, adds, target]);

  // Resizable split between the sources and the comparison (kept between sessions).
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const box = body.current?.getBoundingClientRect();
      if (box) setSplit(Math.min(60, Math.max(16, ((e.clientX - box.left) / box.width) * 100)));
    };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging]);
  useEffect(() => save('gb.compare.split', String(Math.round(split))), [split]);

  const fa = focused ? adds[keyOf(focused)] : undefined;
  const fd = focused ? direct[keyOf(focused)] : undefined;
  const view: Res<{ files: CommitStatFile[]; diffs: FileDiff[] }> | undefined = lens === 'adds' ? fa : fd;

  return createPortal(
    <div className="cx-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`cx ${dragging ? 'resizing' : ''}`} role="dialog" aria-label="Compare">
        <header className="cx-head">
          <span className="cx-logo">⇄</span>
          <div className="cx-headline">
            <h2>Compare</h2>
            <div className="cx-hint">Pick sources on the left and one target; see exactly what differs</div>
          </div>
          <span className="grow" />
          {sources.length > 0 && target && (
            <div className="cx-totals">
              <span>
                <strong>{sources.length}</strong> source{sources.length === 1 ? '' : 's'}
              </span>
              <span>
                <strong>{totals.commits}</strong> commits
              </span>
              <span>
                <strong>{totals.files}</strong> files
              </span>
              {hotspots.length > 0 && (
                <span className="warn" title="Files changed by more than one source">
                  ⚡ <strong>{hotspots.length}</strong> overlap{hotspots.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}
          <button className="sp-close" onClick={onClose} aria-label="Close compare" title="Close (Esc)">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="cx-body" ref={body} style={{ gridTemplateColumns: `${split}% 10px minmax(0, 1fr)` }}>
          {/* ---------------- Sources ---------------- */}
          <section className="cx-pane cx-sources">
            <div className="cx-pane-head">
              <span className="cx-pill src">Sources</span>
              <span className="cx-hint">{sources.length || 'none yet'}</span>
            </div>
            <div className="cx-add">
              <BranchPicker value="" onChange={add} items={items.filter((x) => x.name !== target && !sources.includes(x.name))} placeholder="＋ Add a branch or tag…" recentKey="compare-source" />
              <form
                className="cx-sha"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (isSha(sha.trim())) {
                    add(sha.trim().toLowerCase());
                    setSha('');
                  }
                }}
              >
                <input value={sha} onChange={(e) => setSha(e.target.value)} placeholder="or a commit id…" spellCheck={false} />
                <button className="btn sm" disabled={!isSha(sha.trim())}>
                  Add
                </button>
              </form>
            </div>
            <div className="cx-src-list">
              {sources.length === 0 && (
                <div className="cx-empty">
                  <div className="cx-empty-ico">＋</div>
                  <span>Add branches, tags or commits above to compare with {target ? <strong>{target}</strong> : 'the target'}.</span>
                </div>
              )}
              {sources.map((s, i) => {
                const r = adds[keyOf(s)];
                const d = r?.status === 'ok' ? r.data : null;
                const hot = hotFile ? hotspots.find(([f]) => f === hotFile)?.[1].includes(s) : false;
                return (
                  <div
                    key={s}
                    className={`cx-src ${focused === s ? 'on' : ''} ${hot ? 'hot' : ''}`}
                    style={{ ['--c' as string]: colorOf(s), ['--d' as string]: `${i * 40}ms` }}
                    onClick={() => setFocus(s)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setFocus(s)}
                  >
                    <span className="cx-dot" />
                    <div className="cx-src-main">
                      <div className="cx-src-name mono" title={s}>
                        {isSha(s) ? '◉ ' : ''}
                        {label(s)}
                      </div>
                      <div className="cx-src-meta">
                        {!target && <span className="muted">choose a target</span>}
                        {r?.status === 'loading' && <span className="cx-shimmer">comparing…</span>}
                        {r?.status === 'error' && <span className="text-danger">{r.error.title}</span>}
                        {d && (
                          <>
                            {d.ahead === 0 ? <span className="text-ok">✓ already in target</span> : <span>↑ {d.ahead} new</span>}
                            {d.behind > 0 && <span className="muted">↓ {d.behind} behind</span>}
                            {d.files.length > 0 && (
                              <span>
                                <span className="text-ok">+{d.additions}</span> <span className="text-danger">−{d.deletions}</span>
                              </span>
                            )}
                            {!d.mergeBase && <span className="text-warn">no shared history</span>}
                          </>
                        )}
                      </div>
                      {d && d.files.length > 0 && (
                        <div className="cx-bar">
                          <i style={{ flex: d.additions || 0.0001 }} className="add" />
                          <i style={{ flex: d.deletions || 0.0001 }} className="del" />
                        </div>
                      )}
                    </div>
                    <div className="cx-src-acts">
                      <button
                        className="cx-icon"
                        title={`Make ${label(s)} the target`}
                        onClick={(e) => {
                          e.stopPropagation();
                          swapWith(s);
                        }}
                      >
                        ⇆
                      </button>
                      <button
                        className="cx-icon"
                        title="Remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(s);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
              {hotspots.length > 0 && (
                <div className="cx-hot">
                  <div className="cx-hot-title">⚡ Changed by several sources</div>
                  {hotspots.slice(0, 8).map(([f, by]) => (
                    <div key={f} className={`cx-hot-row ${hotFile === f ? 'on' : ''}`} onMouseEnter={() => setHotFile(f)} onMouseLeave={() => setHotFile(null)} title={`${f}\n${by.join(', ')}`}>
                      <span className="mono ellipsis grow">{f.split('/').pop()}</span>
                      {by.map((b) => (
                        <i key={b} className="cx-mini-dot" style={{ background: colorOf(b) }} />
                      ))}
                    </div>
                  ))}
                  {hotspots.length > 8 && <div className="cx-hint">+{hotspots.length - 8} more</div>}
                </div>
              )}
            </div>
          </section>

          <div className="cx-handle" onPointerDown={(e) => (e.preventDefault(), setDragging(true))} onDoubleClick={() => setSplit(26)} title="Drag to resize · double-click to reset" role="separator" aria-orientation="vertical">
            <span />
          </div>

          {/* ---------------- Comparison ---------------- */}
          <section className="cx-pane cx-main">
            <div className="cx-route" style={{ ['--c' as string]: focused ? colorOf(focused) : 'var(--accent)' }}>
              <div className="cx-end src">
                <span className="cx-pill src">Source</span>
                <span className="mono ellipsis" title={focused ?? ''}>
                  {focused ? label(focused) : 'add a source'}
                </span>
              </div>
              <span className="cx-route-line">
                <i />
              </span>
              <div className="cx-end tgt">
                <span className="cx-pill tgt">Target</span>
                <div className="cx-target-pick">
                  <BranchPicker value={target} onChange={chooseTarget} items={items.filter((x) => !sources.includes(x.name))} placeholder="Choose the target…" recentKey="compare-target" compact />
                </div>
              </div>
            </div>

            {!focused || !target ? (
              <div className="cx-empty big">
                <div className="cx-empty-ico">⇄</div>
                {!target ? 'Choose the branch to compare against.' : 'Add a source on the left to see how it differs.'}
              </div>
            ) : (
              <>
                <div className="cx-toolbar">
                  <div className="cx-tabs">
                    <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
                      Changes
                    </button>
                    <button className={tab === 'commits' ? 'on' : ''} onClick={() => setTab('commits')}>
                      Commits {fa?.status === 'ok' && <span>{fa.data.commits.length}</span>}
                    </button>
                  </div>
                  {tab === 'changes' && (
                    <div className="cx-lens" role="radiogroup" aria-label="What to compare">
                      <button className={lens === 'adds' ? 'on' : ''} onClick={() => setLens('adds')} title={`Only the changes made on ${label(focused)} since it split from ${label(target)}: what a merge would bring`}>
                        What it adds
                      </button>
                      <button className={lens === 'direct' ? 'on' : ''} onClick={() => setLens('direct')} title={`${label(target)} and ${label(focused)} as they are right now, side by side`}>
                        Direct difference
                      </button>
                    </div>
                  )}
                </div>

                {tab === 'commits' ? (
                  <div className="cx-detail">
                    {fa?.status === 'loading' && <Skel />}
                    {fa?.status === 'error' && <div className="banner danger small">{fa.error.message}</div>}
                    {fa?.status === 'ok' &&
                      (fa.data.commits.length === 0 ? (
                        <div className="cx-empty">
                          <div className="cx-empty-ico ok">✓</div>
                          {label(target)} already has every commit of {label(focused)}.
                        </div>
                      ) : (
                        <div className="cx-commits">
                          {fa.data.commits.map((c, i) => (
                            <div key={c.hash} className="cx-commit" style={{ ['--d' as string]: `${Math.min(i, 15) * 20}ms` }}>
                              <i className="cx-commit-dot" />
                              <div className="grow" style={{ minWidth: 0 }}>
                                <div className="ellipsis">{c.subject}</div>
                                <div className="cx-hint">
                                  <span className="mono">{c.shortHash}</span> · {c.author} · {new Date(c.date).toLocaleDateString()}
                                </div>
                              </div>
                            </div>
                          ))}
                          {fa.data.ahead > fa.data.commits.length && <div className="cx-hint">Showing the newest {fa.data.commits.length} of {fa.data.ahead}.</div>}
                        </div>
                      ))}
                  </div>
                ) : (
                  <>
                    {(!view || view.status === 'loading') && <Skel />}
                    {view?.status === 'error' && <div className="banner danger small cx-pad">{view.error.message}</div>}
                    {view?.status === 'ok' && (
                      <ChangesView
                        key={`${focused}|${target}|${lens}`}
                        files={view.data.files}
                        diffs={view.data.diffs}
                        left={lens === 'adds' ? 'Before (where it split off)' : label(target)}
                        right={label(focused)}
                        leftIsTarget={lens === 'direct'}
                        hot={new Set(hotspots.filter(([, by]) => by.includes(focused)).map(([f]) => f))}
                        emptyText={lens === 'adds' ? `${label(focused)} adds nothing that ${label(target)} lacks.` : `${label(target)} and ${label(focused)} are identical.`}
                      />
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Skel() {
  return (
    <div className="cx-skel">
      {[0, 1, 2, 3, 4].map((k) => (
        <i key={k} style={{ ['--d' as string]: `${k * 80}ms` }} />
      ))}
    </div>
  );
}

const STATUS: Record<CommitStatFile['status'], { l: string; c: string; t: string }> = {
  added: { l: 'A', c: 'add', t: 'Only in source' },
  deleted: { l: 'D', c: 'del', t: 'Only in target' },
  modified: { l: 'M', c: 'mod', t: 'Different' },
  renamed: { l: 'R', c: 'mod', t: 'Renamed' },
  copied: { l: 'C', c: 'mod', t: 'Copied' },
  typechange: { l: 'T', c: 'mod', t: 'Type changed' },
};

/** File rail + one large diff with both sides labelled; ↑/↓ (or j/k) move between files. */
function ChangesView({ files, diffs, left, right, leftIsTarget, hot, emptyText }: { files: CommitStatFile[]; diffs: FileDiff[]; left: string; right: string; leftIsTarget: boolean; hot: Set<string>; emptyText: string }) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'split' | 'unified'>(() => {
    try {
      return localStorage.getItem('gb.compare.diffMode') === 'unified' ? 'unified' : 'split';
    } catch {
      return 'split';
    }
  });
  const [rail, setRail] = useState(() => readNum('gb.compare.rail', 280, 180, 520));
  const [railDrag, setRailDrag] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const l = q.trim().toLowerCase();
    // Tree order: at every level folders first, then files, alphabetically.
    const cmp = (a: string, b: string) => {
      const x = a.split('/');
      const y = b.split('/');
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] === y[i]) continue;
        const xd = i < x.length - 1;
        const yd = i < y.length - 1;
        if (xd !== yd) return xd ? -1 : 1;
        return x[i].localeCompare(y[i]);
      }
      return x.length - y.length;
    };
    return [...files].filter((f) => !l || f.path.toLowerCase().includes(l)).sort((a, b) => cmp(a.path, b.path));
  }, [files, q]);
  // Folders start collapsed, except the ones leading to the first changed file (opened by default).
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'));
  const toggleDir = (d: string) =>
    setOpenDirs((o) => {
      const n = new Set(o);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });
  const filtering = !!q.trim();
  const isOpen = (d: string) => filtering || openDirs.has(d);
  const dirCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of shown) for (const d of ancestors(f.path)) m.set(d, (m.get(d) ?? 0) + 1);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  const [sel, setSel] = useState<string | null>(null);
  const current = shown.find((f) => f.path === sel) ?? shown[0] ?? null;
  const idx = current ? shown.indexOf(current) : -1;
  const diff = current ? (diffs.find((d) => d.newPath === current.path || d.oldPath === current.path) ?? null) : null;

  useEffect(() => save('gb.compare.diffMode', mode), [mode]);
  useEffect(() => save('gb.compare.rail', String(Math.round(rail))), [rail]);
  useEffect(() => {
    if (!railDrag) return;
    const move = (e: PointerEvent) => {
      const b = box.current?.getBoundingClientRect();
      if (b) setRail(Math.min(520, Math.max(180, e.clientX - b.left)));
    };
    const up = () => setRailDrag(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [railDrag]);

  const pick = (path: string) => {
    setSel(path);
    setOpenDirs((o) => new Set([...o, ...ancestors(path)]));
  };
  const go = (d: number) => {
    const n = shown[Math.min(shown.length - 1, Math.max(0, idx + d))];
    if (n) pick(n.path);
  };
  useEffect(() => {
    if (shown[0] && !sel) setOpenDirs((o) => new Set([...o, ...ancestors(shown[0].path)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowDown' || e.key === 'j') (e.preventDefault(), go(1));
    if (e.key === 'ArrowUp' || e.key === 'k') (e.preventDefault(), go(-1));
  };
  useEffect(() => {
    box.current?.querySelector('.cx-file.on')?.scrollIntoView({ block: 'nearest' });
  }, [current?.path]);

  if (files.length === 0)
    return (
      <div className="cx-empty big">
        <div className="cx-empty-ico ok">✓</div>
        {emptyText}
      </div>
    );

  return (
    <div className={`cx-changes ${railDrag ? 'resizing' : ''}`} ref={box} tabIndex={0} onKeyDown={onKey} style={{ gridTemplateColumns: `${rail}px 8px minmax(0, 1fr)` }}>
      <div className="cx-rail">
        <input className="cx-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${files.length} files…`} spellCheck={false} />
        <div className="cx-files">
          {(() => {
            const rows: ReactElement[] = [];
            const emitted = new Set<string>();
            for (const f of shown) {
              const dirs = ancestors(f.path);
              let visible = true;
              for (const d of dirs) {
                if (!visible) break;
                if (!emitted.has(d)) {
                  emitted.add(d);
                  const depth = d.split('/').length - 1;
                  const open = isOpen(d);
                  rows.push(
                    <div key={`d:${d}`} className="cx-dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggleDir(d)} title={d}>
                      <span className={`cx-chev ${open ? 'open' : ''}`}>▸</span>
                      <span className="cx-folder">{open ? '📂' : '📁'}</span>
                      <span className="ellipsis grow">{d.split('/').pop()}</span>
                      <span className="cx-count">{dirCount.get(d)}</span>
                    </div>,
                  );
                }
                visible = isOpen(d);
              }
              if (!visible) continue;
              const st = STATUS[f.status];
              const name = f.path.split('/').pop()!;
              rows.push(
                <div key={f.path} className={`cx-file ${current?.path === f.path ? 'on' : ''}`} style={{ paddingLeft: 8 + dirs.length * 14 }} onClick={() => pick(f.path)} title={`${f.path}
${leftIsTarget ? st.t : f.status}`}>
                  <span className={`cx-st ${st.c}`}>{st.l}</span>
                  <span className="ellipsis mono grow">{name}</span>
                  {hot.has(f.path) && (
                    <span className="cx-hotmark" title="Also changed by another source">
                      ⚡
                    </span>
                  )}
                  <span className="cx-num">
                    <span className="text-ok">+{f.additions}</span>
                    <span className="text-danger">−{f.deletions}</span>
                  </span>
                </div>,
              );
            }
            return rows;
          })()}
          {shown.length === 0 && <div className="cx-hint cx-pad">No file matches.</div>}
        </div>
      </div>
      <div className="cx-rail-handle" onPointerDown={(e) => (e.preventDefault(), setRailDrag(true))} onDoubleClick={() => setRail(280)} title="Drag to resize" />
      <div className="cx-diff">
        {current && (
          <div className="cx-diff-head">
            <span className={`cx-st ${STATUS[current.status].c}`}>{STATUS[current.status].l}</span>
            <strong className="mono ellipsis grow" title={current.path}>
              {current.oldPath && current.oldPath !== current.path ? `${current.oldPath} → ` : ''}
              {current.path}
            </strong>
            <span className="cx-num">
              <span className="text-ok">+{current.additions}</span>
              <span className="text-danger">−{current.deletions}</span>
            </span>
            <div className="cx-seg">
              <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')} title="Side by side">
                ◫ Side by side
              </button>
              <button className={mode === 'unified' ? 'on' : ''} onClick={() => setMode('unified')} title="One column">
                ☰ Unified
              </button>
            </div>
            <div className="cx-nav">
              <button disabled={idx <= 0} onClick={() => go(-1)} title="Previous file (↑ or k)">
                ‹
              </button>
              <span>
                {idx + 1}/{shown.length}
              </span>
              <button disabled={idx >= shown.length - 1} onClick={() => go(1)} title="Next file (↓ or j)">
                ›
              </button>
            </div>
          </div>
        )}
        {mode === 'split' && (
          <div className="cx-sides">
            <span className={`cx-side ${leftIsTarget ? 'tgt' : 'base'}`}>◀ {left}</span>
            <span className="cx-side src">{right} ▶</span>
          </div>
        )}
        <div className="cx-diff-body">
          {current && current.binary ? <div className="cx-empty">Binary file: no text to compare.</div> : <DiffViewer diff={diff} hideHeader forceMode={mode} emptyText="No line changes for this file." />}
        </div>
      </div>
    </div>
  );
}
