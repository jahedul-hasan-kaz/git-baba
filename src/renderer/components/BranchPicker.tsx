import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { relative } from './FileDiffList';

const COLORS = ['#5b8cff', '#3ecf8e', '#f5b84a', '#ff6b6b', '#b18cff', '#6cc4ff', '#ff9f6b', '#9fd36b'];
/** Stable colour per branch name (same palette as Git History and the Merge Studio). */
export const branchColor = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};

export interface PickerItem {
  name: string;
  current?: boolean;
  remote?: boolean;
  ahead?: number;
  behind?: number;
  subject?: string;
  date?: string;
  oid?: string;
  /** Shown instead of the name (e.g. "Current branch (HEAD)"). */
  label?: string;
  /** Icon for special entries. */
  icon?: string;
  /** Why the entry cannot be picked; the row is shown but disabled. */
  disabled?: string;
}

interface Props {
  value: string;
  onChange: (name: string) => void;
  items: PickerItem[];
  /** Entries pinned above everything (e.g. "Current branch (HEAD)" with name ""). */
  special?: PickerItem[];
  placeholder?: string;
  disabled?: boolean;
  /** Key for remembering recently picked branches (per purpose). */
  recentKey?: string;
  compact?: boolean;
  title?: string;
}

type Tab = 'all' | 'local' | 'remote';

/** Subsequence fuzzy match: score (higher is better) and the matched character positions. */
function fuzzy(text: string, q: string): { score: number; hits: number[] } | null {
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) return { score: 1000 - direct + (direct === 0 || '/-_'.includes(t[direct - 1]) ? 200 : 0), hits: [...q].map((_, i) => direct + i) };
  const hits: number[] = [];
  let score = 0;
  let last = -2;
  for (let i = 0, j = 0; i < t.length && j < q.length; i++) {
    if (t[i] !== q[j]) continue;
    score += i === last + 1 ? 8 : 1;
    if (i === 0 || '/-_.'.includes(t[i - 1])) score += 5;
    hits.push(i);
    last = i;
    j++;
  }
  return hits.length === q.length ? { score, hits } : null;
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let buf = '';
  let on = false;
  const flush = (k: number) => {
    if (buf) out.push(on ? <mark key={k}>{buf}</mark> : <span key={k}>{buf}</span>);
    buf = '';
  };
  [...text].forEach((ch, i) => {
    const h = set.has(i);
    if (h !== on) {
      flush(i);
      on = h;
    }
    buf += ch;
  });
  flush(text.length);
  return <>{out}</>;
}

/** "feature/inride/x" → folder "feature/inride/" + leaf "x", so the leaf reads first. */
function splitName(name: string) {
  const i = name.lastIndexOf('/');
  return i === -1 ? { folder: '', leaf: name } : { folder: name.slice(0, i + 1), leaf: name.slice(i + 1) };
}

const readRecent = (key?: string): string[] => {
  if (!key) return [];
  try {
    return JSON.parse(localStorage.getItem(`gb.recent.${key}`) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const pushRecent = (key: string | undefined, name: string) => {
  if (!key || !name) return;
  try {
    localStorage.setItem(`gb.recent.${key}`, JSON.stringify([name, ...readRecent(key).filter((n) => n !== name)].slice(0, 5)));
  } catch {
    /* storage unavailable: recents are a convenience */
  }
};

/** Searchable branch picker: fuzzy search, Local/Remote tabs, recents, rich rows and full keyboard control. */
export function BranchPicker({ value, onChange, items, special = [], placeholder = 'Choose a branch…', disabled, recentKey, compact, title }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean; maxH: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => [...special, ...items], [special, items]);
  const selected = all.find((i) => i.name === value) ?? null;
  const hasRemote = items.some((i) => i.remote);
  const hasLocal = items.some((i) => !i.remote);

  // Rows: specials, recents (no query), then local / remote groups, filtered and ranked.
  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    type Row = { kind: 'head'; label: string } | { kind: 'item'; item: PickerItem; hits: number[]; key: string };
    const out: Row[] = [];
    const match = (it: PickerItem) => fuzzy(it.label ?? it.name, query);
    const inTab = (it: PickerItem) => tab === 'all' || (tab === 'remote' ? !!it.remote : !it.remote);
    const sp = special.filter((s) => !query || match(s));
    if (sp.length && tab === 'all') sp.forEach((it) => out.push({ kind: 'item', item: it, hits: match(it)?.hits ?? [], key: `s:${it.name}` }));
    if (!query && tab === 'all') {
      const rec = readRecent(recentKey)
        .map((n) => items.find((i) => i.name === n))
        .filter((i): i is PickerItem => !!i);
      if (rec.length) {
        out.push({ kind: 'head', label: 'Recent' });
        rec.forEach((it) => out.push({ kind: 'item', item: it, hits: [], key: `r:${it.name}` }));
      }
    }
    const group = (label: string, list: PickerItem[]) => {
      const scored = list
        .filter(inTab)
        .map((it) => ({ it, m: match(it) }))
        .filter((x): x is { it: PickerItem; m: { score: number; hits: number[] } } => !!x.m);
      if (query) scored.sort((a, b) => b.m.score - a.m.score);
      else scored.sort((a, b) => Number(!!b.it.current) - Number(!!a.it.current) || (b.it.date ?? '').localeCompare(a.it.date ?? ''));
      if (!scored.length) return;
      out.push({ kind: 'head', label: `${label} · ${scored.length}` });
      scored.forEach(({ it, m }) => out.push({ kind: 'item', item: it, hits: m.hits, key: `${label}:${it.name}` }));
    };
    group('Local', items.filter((i) => !i.remote));
    group('Remote', items.filter((i) => i.remote));
    return out;
  }, [q, tab, items, special, recentKey]);
  const pickable = rows.map((r, i) => (r.kind === 'item' && !r.item.disabled ? i : -1)).filter((i) => i !== -1);

  const place = () => {
    const t = triggerRef.current?.getBoundingClientRect();
    if (!t) return;
    const below = window.innerHeight - t.bottom - 12;
    const above = t.top - 12;
    const up = below < 280 && above > below;
    const width = Math.max(t.width, 360);
    setPos({ left: Math.max(8, Math.min(t.left, window.innerWidth - width - 8)), top: up ? t.top - 6 : t.bottom + 6, width, up, maxH: Math.min(440, (up ? above : below) - 6) });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onWin = () => place();
    window.addEventListener('resize', onWin);
    document.addEventListener('scroll', onWin, true);
    return () => {
      window.removeEventListener('resize', onWin);
      document.removeEventListener('scroll', onWin, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!popRef.current?.contains(n) && !triggerRef.current?.contains(n)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setQ('');
    setTab('all');
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  // Keep the highlighted row on the selected branch (or the first pickable one).
  useEffect(() => {
    if (!open) return;
    const sel = rows.findIndex((r) => r.kind === 'item' && r.item.name === value && !r.item.disabled);
    setActive(q || sel === -1 ? pickable[0] ?? 0 : sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, tab]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (it: PickerItem) => {
    if (it.disabled) return;
    pushRecent(recentKey, it.name);
    onChange(it.name);
    setOpen(false);
    triggerRef.current?.focus();
  };
  const step = (d: number) => {
    if (!pickable.length) return;
    const i = pickable.indexOf(active);
    setActive(pickable[(i + d + pickable.length) % pickable.length]);
  };
  const tabs: Tab[] = hasLocal && hasRemote ? ['all', 'local', 'remote'] : [];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), step(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), step(-1));
    else if (e.key === 'PageDown') (e.preventDefault(), step(8));
    else if (e.key === 'PageUp') (e.preventDefault(), step(-8));
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r?.kind === 'item') choose(r.item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'Tab' && tabs.length) {
      e.preventDefault();
      setTab((t) => tabs[(tabs.indexOf(t) + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length]);
    }
  };
  const activeItem = rows[active]?.kind === 'item' ? (rows[active] as { item: PickerItem }).item : null;

  const shown = selected ?? null;
  const c = shown && shown.name ? branchColor(shown.name) : 'var(--text-3)';

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`bp-trigger ${open ? 'open' : ''} ${compact ? 'compact' : ''} ${shown ? '' : 'empty'}`}
        style={{ ['--bc' as string]: c }}
        disabled={disabled}
        title={title ?? shown?.name}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          } else if (!open && e.key.length === 1 && /\S/.test(e.key)) {
            setOpen(true); // start typing to search
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {shown ? (
          <>
            {shown.icon ? <span className="bp-ico">{shown.icon}</span> : <span className="bp-dot" />}
            <span className={`bp-val ellipsis ${shown.label ? '' : 'mono'}`}>{shown.label ?? shown.name}</span>
            {shown.current && <span className="bp-badge cur">HEAD</span>}
            {shown.remote && <span className="bp-badge">remote</span>}
            {!compact && !!shown.ahead && <span className="bp-ab up">↑{shown.ahead}</span>}
            {!compact && !!shown.behind && <span className="bp-ab down">↓{shown.behind}</span>}
          </>
        ) : (
          <span className="bp-val muted">{placeholder}</span>
        )}
        <span className="bp-chev">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className={`bp-pop ${pos.up ? 'up' : ''}`}
            style={{ left: pos.left, width: pos.width, maxHeight: pos.maxH, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
            onKeyDown={onKey}
            role="listbox"
          >
            <div className="bp-search">
              <span className="bp-search-ico">⌕</span>
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search branches…" spellCheck={false} />
              {q && (
                <button className="bp-clear" onClick={() => setQ('')} title="Clear search">
                  ✕
                </button>
              )}
            </div>
            {tabs.length > 0 && (
              <div className="bp-tabs">
                {tabs.map((t) => (
                  <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                    {t === 'all' ? 'All' : t === 'local' ? `⎇ Local ${items.filter((i) => !i.remote).length}` : `☁ Remote ${items.filter((i) => i.remote).length}`}
                  </button>
                ))}
              </div>
            )}
            <div className="bp-list" ref={listRef}>
              {rows.length === 0 && <div className="bp-none">No branch matches “{q}”</div>}
              {rows.map((r, i) =>
                r.kind === 'head' ? (
                  <div key={`h${i}`} className="bp-head">
                    {r.label}
                  </div>
                ) : (
                  (() => {
                    const it = r.item;
                    const { folder, leaf } = splitName(it.label ?? it.name);
                    const off = folder.length;
                    return (
                      <div
                        key={r.key}
                        data-row={i}
                        role="option"
                        aria-selected={it.name === value}
                        className={`bp-row ${i === active ? 'active' : ''} ${it.name === value ? 'sel' : ''} ${it.disabled ? 'disabled' : ''}`}
                        style={{ ['--bc' as string]: it.icon ? 'var(--accent)' : branchColor(it.name) }}
                        onMouseEnter={() => !it.disabled && setActive(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(it)}
                        title={it.disabled ?? it.name}
                      >
                        {it.icon ? <span className="bp-ico">{it.icon}</span> : <span className="bp-dot" />}
                        <div className="bp-main">
                          <div className="bp-name ellipsis">
                            {folder && (
                              <span className="bp-folder">
                                <Highlight text={folder} hits={r.hits.filter((h) => h < off)} />
                              </span>
                            )}
                            <span className={it.label ? '' : 'mono'}>
                              <Highlight text={leaf} hits={r.hits.filter((h) => h >= off).map((h) => h - off)} />
                            </span>
                          </div>
                          {(it.subject || it.disabled) && <div className="bp-sub ellipsis">{it.disabled ?? it.subject}</div>}
                        </div>
                        <div className="bp-meta">
                          {it.current && <span className="bp-badge cur">HEAD</span>}
                          {!!it.ahead && <span className="bp-ab up">↑{it.ahead}</span>}
                          {!!it.behind && <span className="bp-ab down">↓{it.behind}</span>}
                          {it.date && <span className="bp-when">{relative(it.date)}</span>}
                          {it.name === value && <span className="bp-check">✓</span>}
                        </div>
                      </div>
                    );
                  })()
                ),
              )}
            </div>
            <div className="bp-foot">
              {activeItem?.oid ? (
                <span className="mono ellipsis">
                  {activeItem.oid.slice(0, 8)} <span className="muted">{activeItem.subject}</span>
                </span>
              ) : (
                <span className="muted">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> move · <kbd>Enter</kbd> pick {tabs.length ? <>· <kbd>Tab</kbd> local/remote</> : null} · <kbd>Esc</kbd> close
                </span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Converts branch info from the API into picker rows. */
export function toPickerItems(list: { name: string; current?: boolean; remote?: boolean; ahead?: number; behind?: number; subject?: string; date?: string; oid?: string }[]): PickerItem[] {
  return list.filter((b) => !b.name.endsWith('/HEAD')).map((b) => ({ name: b.name, current: b.current, remote: b.remote, ahead: b.ahead, behind: b.behind, subject: b.subject, date: b.date, oid: b.oid }));
}
