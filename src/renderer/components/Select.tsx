import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { branchColor } from './BranchPicker';

/**
 * Drop-in replacement for a native <select>: same `value`, `onChange={(e) => e.target.value}` and
 * <option>/<optgroup> children, rendered as the app's interactive picker (search, groups, keyboard).
 *
 * `kind` styles the rows for what they are: branches get their colour dot, tags a tag icon,
 * accounts an avatar initial, commits a monospace hash. Options may carry `data-icon` and
 * `data-desc` for a leading icon and a second line.
 */
export type SelectKind = 'plain' | 'branch' | 'tag' | 'account' | 'commit' | 'ref';

interface Opt {
  value: string;
  label: string;
  desc?: string;
  icon?: string;
  group?: string;
  disabled?: boolean;
}

interface Props {
  value: string | number | undefined | null;
  onChange?: (e: { target: { value: string } }) => void;
  children?: ReactNode;
  kind?: SelectKind;
  disabled?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  /** Show the search box (default: when there are more than 7 options). */
  searchable?: boolean;
  'aria-label'?: string;
}

const text = (n: ReactNode): string =>
  n === null || n === undefined || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(text).join('') : isValidElement(n) ? text((n.props as { children?: ReactNode }).children) : '';

function collect(children: ReactNode, group: string | undefined, out: Opt[]) {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const p = c.props as Record<string, unknown> & { children?: ReactNode };
    if (c.type === Fragment) return collect(p.children, group, out);
    if (c.type === 'optgroup') return collect(p.children, String(p.label ?? ''), out);
    if (c.type === 'option') {
      const label = text(p.children);
      out.push({
        value: p.value === undefined ? label : String(p.value),
        label,
        desc: (p['data-desc'] as string | undefined) ?? undefined,
        icon: (p['data-icon'] as string | undefined) ?? undefined,
        group,
        disabled: !!p.disabled,
      });
    }
  });
}

function fuzzy(t: string, q: string): number[] | null {
  if (!q) return [];
  const s = t.toLowerCase();
  const d = s.indexOf(q);
  if (d !== -1) return [...q].map((_, i) => d + i);
  const hits: number[] = [];
  for (let i = 0, j = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) (hits.push(i), j++);
  return hits.length === q.length ? hits : null;
}

function Hl({ s, hits }: { s: string; hits: number[] }) {
  if (!hits.length) return <>{s}</>;
  const set = new Set(hits);
  return (
    <>
      {[...s].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : <Fragment key={i}>{ch}</Fragment>))}
    </>
  );
}

/** Values that mean "no filter / default" read as a neutral entry rather than a branch. */
const isNeutral = (o: Opt) => o.value === '' || /^(all|any|none)\b/i.test(o.label);

function Lead({ o, kind }: { o: Opt; kind: SelectKind }) {
  if (o.icon) return <span className="bp-ico">{o.icon}</span>;
  if (isNeutral(o) && kind !== 'plain') return <span className="bp-ico">◎</span>;
  if (kind === 'branch' || kind === 'ref') return <span className="bp-dot" style={{ ['--bc' as string]: branchColor(o.value) }} />;
  if (kind === 'tag') return <span className="bp-ico sel-tag">🏷</span>;
  if (kind === 'commit') return <span className="bp-ico">●</span>;
  if (kind === 'account')
    return (
      <span className="sel-avatar" style={{ background: branchColor(o.label) }}>
        {(o.label.replace(/^@/, '')[0] ?? '?').toUpperCase()}
      </span>
    );
  return null;
}

export function Select({ value, onChange, children, kind = 'plain', disabled, title, className = '', style, placeholder = 'Choose…', searchable, 'aria-label': ariaLabel }: Props) {
  const opts = useMemo(() => {
    const out: Opt[] = [];
    collect(children, undefined, out);
    return out;
  }, [children]);
  const v = value === null || value === undefined ? '' : String(value);
  const selected = opts.find((o) => o.value === v) ?? null;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean; maxH: number } | null>(null);
  const trig = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const showSearch = searchable ?? opts.length > 7;
  const mono = kind === 'branch' || kind === 'commit' || kind === 'ref' || kind === 'tag';

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    type Row = { kind: 'head'; label: string } | { kind: 'opt'; o: Opt; hits: number[]; dhits: number[] };
    const out: Row[] = [];
    let last: string | undefined = '\u0000';
    for (const o of opts) {
      const hits = fuzzy(o.label, query);
      const dh = !hits && o.desc ? fuzzy(o.desc, query) : null;
      if (!hits && !dh) continue;
      if (o.group !== last) {
        if (o.group) out.push({ kind: 'head', label: o.group });
        last = o.group;
      }
      out.push({ kind: 'opt', o, hits: hits ?? [], dhits: dh ?? [] });
    }
    return out;
  }, [opts, q]);
  const pickable = rows.map((r, i) => (r.kind === 'opt' && !r.o.disabled ? i : -1)).filter((i) => i >= 0);

  const place = () => {
    const t = trig.current?.getBoundingClientRect();
    if (!t) return;
    const below = window.innerHeight - t.bottom - 12;
    const above = t.top - 12;
    const up = below < 240 && above > below;
    const width = Math.min(Math.max(t.width, showSearch ? 300 : 200), window.innerWidth - 16);
    setPos({ left: Math.max(8, Math.min(t.left, window.innerWidth - width - 8)), top: up ? t.top - 6 : t.bottom + 6, width, up, maxH: Math.min(400, (up ? above : below) - 6) });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const f = () => place();
    window.addEventListener('resize', f);
    document.addEventListener('scroll', f, true);
    return () => {
      window.removeEventListener('resize', f);
      document.removeEventListener('scroll', f, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!pop.current?.contains(n) && !trig.current?.contains(n)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setQ('');
    setTimeout(() => (showSearch ? input.current : pop.current)?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const sel = rows.findIndex((r) => r.kind === 'opt' && r.o.value === v);
    setActive(q || sel === -1 ? pickable[0] ?? 0 : sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q]);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (o: Opt) => {
    if (o.disabled) return;
    setOpen(false);
    trig.current?.focus();
    if (o.value !== v) onChange?.({ target: { value: o.value } });
  };
  const step = (d: number) => {
    if (!pickable.length) return;
    const i = pickable.indexOf(active);
    setActive(pickable[(i + d + pickable.length) % pickable.length]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), step(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), step(-1));
    else if (e.key === 'Home') (e.preventDefault(), setActive(pickable[0] ?? 0));
    else if (e.key === 'End') (e.preventDefault(), setActive(pickable[pickable.length - 1] ?? 0));
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r?.kind === 'opt') choose(r.o);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation());
      setOpen(false);
      trig.current?.focus();
    } else if (!showSearch && e.key.length === 1) {
      // Type-ahead without a search box: jump to the next option starting with the letter.
      const k = e.key.toLowerCase();
      const start = pickable.indexOf(active);
      for (let n = 1; n <= pickable.length; n++) {
        const i = pickable[(start + n) % pickable.length];
        const r = rows[i];
        if (r.kind === 'opt' && r.o.label.toLowerCase().startsWith(k)) return setActive(i);
      }
    }
  };
  const bc = selected && (kind === 'branch' || kind === 'ref') && !isNeutral(selected) ? branchColor(selected.value) : 'var(--accent)';

  return (
    <>
      <button
        type="button"
        ref={trig}
        className={`bp-trigger sel ${open ? 'open' : ''} ${selected ? '' : 'empty'} ${className}`}
        style={{ ['--bc' as string]: bc, ...style }}
        disabled={disabled}
        title={title ?? selected?.label}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          } else if (showSearch && e.key.length === 1 && /\S/.test(e.key)) setOpen(true);
        }}
      >
        {selected ? (
          <>
            <Lead o={selected} kind={kind} />
            <span className={`bp-val ellipsis ${mono && !isNeutral(selected) ? 'mono' : ''}`}>{selected.label}</span>
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
            ref={pop}
            tabIndex={-1}
            role="listbox"
            className={`bp-pop sel-pop ${pos.up ? 'up' : ''}`}
            style={{ left: pos.left, width: pos.width, maxHeight: pos.maxH, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
            onKeyDown={onKey}
          >
            {showSearch && (
              <div className="bp-search">
                <span className="bp-search-ico">⌕</span>
                <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${opts.length} options…`} spellCheck={false} />
                {q && (
                  <button className="bp-clear" onClick={() => setQ('')} title="Clear search">
                    ✕
                  </button>
                )}
              </div>
            )}
            <div className="bp-list" ref={list}>
              {rows.length === 0 && <div className="bp-none">Nothing matches “{q}”</div>}
              {rows.map((r, i) =>
                r.kind === 'head' ? (
                  <div key={`h${i}`} className="bp-head">
                    {r.label}
                  </div>
                ) : (
                  <div
                    key={`${r.o.group ?? ''}:${r.o.value}:${i}`}
                    data-row={i}
                    role="option"
                    aria-selected={r.o.value === v}
                    className={`bp-row ${i === active ? 'active' : ''} ${r.o.value === v ? 'sel' : ''} ${r.o.disabled ? 'disabled' : ''}`}
                    style={{ ['--bc' as string]: (kind === 'branch' || kind === 'ref') && !isNeutral(r.o) ? branchColor(r.o.value) : 'var(--accent)' }}
                    onMouseEnter={() => !r.o.disabled && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(r.o)}
                  >
                    <Lead o={r.o} kind={kind} />
                    <div className="bp-main">
                      <div className={`bp-name ellipsis ${mono && !isNeutral(r.o) ? 'mono' : ''}`}>
                        <Hl s={r.o.label} hits={r.hits} />
                      </div>
                      {r.o.desc && (
                        <div className="bp-sub">
                          <Hl s={r.o.desc} hits={r.dhits} />
                        </div>
                      )}
                    </div>
                    {r.o.value === v && <span className="bp-check">✓</span>}
                  </div>
                ),
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
