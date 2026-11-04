import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BranchInfo } from '../../../shared/types';
import { branchColor } from '../BranchPicker';
import { relative } from '../FileDiffList';

type Tab = 'all' | 'recent' | 'local' | 'remote';

interface Props {
  branches: BranchInfo[];
  /** Already used as a source or the target. */
  used: Set<string>;
  target: string;
  disabled: boolean;
  onAdd: (names: string[]) => void;
  onTarget: (name: string) => void;
  dragProps: (name: string) => { draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void };
}

const WEEK = 7 * 86400_000;

function hits(text: string, q: string): number[] | null {
  if (!q) return [];
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i !== -1) return [...q].map((_, k) => i + k);
  const out: number[] = [];
  for (let a = 0, b = 0; a < t.length && b < q.length; a++) if (t[a] === q[b]) (out.push(a), b++);
  return out.length === q.length ? out : null;
}

/**
 * Branch shelf: search, tabs (recent / local / remote) and rich rows with last commit and activity.
 * Rows are dragged onto the stage; everything else lives in the right-click menu (and keyboard:
 * Space / Ctrl+click to select several, Enter to add, T to make a local branch the target).
 */
export function BranchShelf({ branches, used, target, disabled, onAdd, onTarget, dragProps }: Props) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; b: BranchInfo } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setMenu(null));
    const off = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key, true);
    document.addEventListener('scroll', off, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', off, true);
    };
  }, [menu]);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - el.offsetHeight - 8))}px`;
  }, [menu]);
  const query = q.trim().toLowerCase();
  const now = Date.now();

  const rows = useMemo(() => {
    const avail = branches.filter((b) => !b.name.endsWith('/HEAD') && !used.has(b.name));
    return avail
      .filter((b) => (tab === 'local' ? !b.remote : tab === 'remote' ? b.remote : tab === 'recent' ? !!b.date && now - Date.parse(b.date) < WEEK : true))
      .map((b) => ({ b, h: hits(b.name, query) }))
      .filter((x): x is { b: BranchInfo; h: number[] } => !!x.h)
      .sort((x, y) => (query ? 0 : (y.b.date ?? '').localeCompare(x.b.date ?? '')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches, used, tab, query]);

  const counts = useMemo(() => {
    const avail = branches.filter((b) => !b.name.endsWith('/HEAD') && !used.has(b.name));
    return { all: avail.length, recent: avail.filter((b) => b.date && now - Date.parse(b.date) < WEEK).length, local: avail.filter((b) => !b.remote).length, remote: avail.filter((b) => b.remote).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches, used]);

  const toggle = (n: string) =>
    setChecked((s) => {
      const x = new Set(s);
      if (x.has(n)) x.delete(n);
      else x.add(n);
      return x;
    });
  const addChecked = () => {
    const names = rows.map((r) => r.b.name).filter((n) => checked.has(n));
    if (names.length) onAdd(names);
    setChecked(new Set());
  };
  const focus = (i: number) => {
    setActive(i);
    listRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const cur = rows[active]?.b;
    if (e.key === 'ArrowDown') (e.preventDefault(), focus(Math.min(rows.length - 1, active + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), focus(Math.max(0, active - 1)));
    else if (e.key === ' ' && cur && (e.target as HTMLElement).tagName !== 'INPUT') (e.preventDefault(), toggle(cur.name));
    else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      if (checked.size) addChecked();
      else onAdd([cur.name]);
    } else if ((e.key === 't' || e.key === 'T') && cur && !cur.remote && (e.target as HTMLElement).tagName !== 'INPUT') (e.preventDefault(), onTarget(cur.name));
  };

  const name = (b: BranchInfo, h: number[]) => {
    const i = b.name.lastIndexOf('/');
    const set = new Set(h);
    return [...b.name].map((ch, k) => (
      <span key={k} className={`${k <= i ? 'sh-dir' : ''} ${set.has(k) ? 'sh-hit' : ''}`}>
        {ch}
      </span>
    ));
  };

  return (
    <div className={`shelf ${disabled ? 'off' : ''}`} onKeyDown={onKey}>
      <div className="shelf-head">
        <div className="shelf-search">
          <span>⌕</span>
          <input value={q} onChange={(e) => (setQ(e.target.value), setActive(0))} placeholder="Find branches to merge…" spellCheck={false} disabled={disabled} />
        </div>
        <div className="seg">
          {(
            [
              ['all', 'All'],
              ['recent', '⏱ Recent'],
              ['local', '⎇ Local'],
              ['remote', '☁ Remote'],
            ] as [Tab, string][]
          ).map(([t, l]) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => (setTab(t), setActive(0))} title={t === 'recent' ? 'Last commit in the past 7 days' : undefined}>
              {l} <span className="shelf-n">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>
      {checked.size > 0 && (
        <div className="shelf-bulk">
          <strong>{checked.size}</strong> selected
          <span className="spacer" />
          <button className="btn sm primary" onClick={addChecked}>
            + Add as sources
          </button>
          <button className="btn sm ghost" onClick={() => setChecked(new Set())}>
            ✕
          </button>
        </div>
      )}
      <div className="shelf-list" ref={listRef} tabIndex={0}>
        {rows.length === 0 && <div className="small muted shelf-empty">{query ? `No branch matches “${q}”` : 'No more branches here.'}</div>}
        {rows.slice(0, 200).map(({ b, h }, i) => {
          const fresh = !!b.date && now - Date.parse(b.date) < 2 * 86400_000;
          return (
            <div
              key={b.name}
              data-i={i}
              className={`shelf-row ${i === active ? 'active' : ''} ${checked.has(b.name) ? 'checked' : ''}`}
              style={{ ['--bc' as string]: branchColor(b.name) }}
              onMouseEnter={() => setActive(i)}
              onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? toggle(b.name) : setActive(i))}
              onContextMenu={(e) => {
                e.preventDefault();
                setActive(i);
                setMenu({ x: e.clientX, y: e.clientY, b });
              }}
              {...dragProps(b.name)}
              title={`${b.name}\nDrag onto Sources or Target · right-click for options · Ctrl+click to select several`}
            >
              <span className="shelf-grip" aria-hidden>
                ⠿
              </span>
              <span className="shelf-dot" />
              <div className="shelf-main">
                <div className="mono shelf-name">
                  {name(b, h)}
                  {fresh && <span className="shelf-fresh" title="Active in the last 2 days" />}
                </div>
                <div className="small muted ellipsis">
                  {b.subject || 'no commit message'}
                  {b.date ? ` · ${relative(b.date)}` : ''}
                </div>
              </div>
              <div className="shelf-meta">
                {b.current && <span className="bp-badge cur">HEAD</span>}
                {b.remote ? <span className="bp-badge">remote</span> : null}
                {!!b.ahead && <span className="bp-ab up">↑{b.ahead}</span>}
                {!!b.behind && <span className="bp-ab down">↓{b.behind}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {menu &&
        createPortal(
          <div ref={menuRef} className="cm shelf-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
            <div className="cm-head">
              <span className="shelf-dot" style={{ ['--bc' as string]: branchColor(menu.b.name) }} />
              <div style={{ minWidth: 0 }}>
                <div className="mono cm-subject ellipsis">{menu.b.name}</div>
                <div className="small muted ellipsis">{menu.b.remote ? 'Remote branch' : 'Local branch'}{menu.b.date ? ` · ${relative(menu.b.date)}` : ''}</div>
              </div>
            </div>
            <div className="cm-item" onClick={() => (onAdd([menu.b.name]), setMenu(null))}>
              <span className="cm-ico">⤵</span>
              <span className="grow">Add as source</span>
              <kbd>Enter</kbd>
            </div>
            {!menu.b.remote && menu.b.name !== target && (
              <div className="cm-item" onClick={() => (onTarget(menu.b.name), setMenu(null))}>
                <span className="cm-ico">🎯</span>
                <span className="grow">Set as target</span>
                <kbd>T</kbd>
              </div>
            )}
            {checked.size > 1 && (
              <div className="cm-item" onClick={() => (addChecked(), setMenu(null))}>
                <span className="cm-ico">⇊</span>
                <span className="grow">Add {checked.size} selected as sources</span>
              </div>
            )}
            <div className="cm-item" onClick={() => (toggle(menu.b.name), setMenu(null))}>
              <span className="cm-ico">{checked.has(menu.b.name) ? '☑' : '☐'}</span>
              <span className="grow">{checked.has(menu.b.name) ? 'Unselect' : 'Select'}</span>
              <kbd>Space</kbd>
            </div>
          </div>,
          document.body,
        )}
      <div className="shelf-foot small muted">
        ⠿ Drag onto the stage · right-click for options · <kbd>Ctrl</kbd>+click to select several
      </div>
    </div>
  );
}
