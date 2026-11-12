import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { requestQuickMerge } from '../../services/quickMerge';

export type RefKind = 'local' | 'remote' | 'tag' | 'made-on';

export interface RefActions {
  /** Show only this ref's history. */
  filter: (ref: string) => void;
  /** Switch to (or check out) a branch. */
  switchTo: (name: string, kind: 'local' | 'remote') => void;
  copy: (text: string, what: string) => void;
  current: string | null;
}

export const RefActionsContext = createContext<RefActions | null>(null);

interface Props {
  name: string;
  kind: RefKind;
  color: string;
  /** Checked-out branch. */
  head?: boolean;
  /** Remotes that have a branch of the same name ("origin" → origin/name). */
  remotes?: string[];
  title?: string;
}

const ICON: Record<RefKind, string> = { local: '⎇', remote: '☁', tag: '🏷', 'made-on': '⎇' };
const LABEL: Record<RefKind, string> = { local: 'Local branch', remote: 'Remote branch', tag: 'Tag', 'made-on': 'Made on branch' };

/**
 * A branch / tag chip you can act on (GitLens-style): it lights up on hover, expands to the full name,
 * and a click opens a card with what the ref is and what you can do with it.
 */
export function RefChip({ name, kind, color, head, remotes = [], title }: Props) {
  const actions = useContext(RefActionsContext);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const short = kind === 'remote' ? name.slice(name.indexOf('/') + 1) : name;

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), top: r.bottom + 6 > window.innerHeight - 220 ? r.top - 6 : r.bottom + 6 });
  }, [open]);
  useLayoutEffect(() => {
    // Flip above the chip when there is no room below.
    const el = pop.current;
    if (!el || !pos || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    if (pos.top < r.top) el.style.top = `${r.top - el.offsetHeight - 6}px`;
  }, [pos]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false));
    const scroll = () => setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key, true);
    document.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const branchName = kind === 'remote' ? name : name;
  const isCurrent = !!actions?.current && (kind === 'local' || kind === 'made-on') && actions.current === name;

  return (
    <>
      <span
        ref={btn}
        className={`rchip ${kind} ${head ? 'head' : ''} ${open ? 'open' : ''}`}
        style={{ ['--lc' as string]: color }}
        title={title ?? `${LABEL[kind]} ${name}${remotes.length ? `\n☁ also on ${remotes.map((r) => `${r}/${name}`).join(', ')}` : ''} — click for actions`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          actions?.filter(kind === 'tag' ? name : branchName);
        }}
      >
        <span className="rchip-ico">{head ? '✓' : ICON[kind]}</span>
        <span className="rchip-name">{kind === 'remote' ? <><span className="rchip-remote">{name.slice(0, name.indexOf('/') + 1)}</span>{short}</> : name}</span>
        {remotes.length > 0 && <span className="rchip-cloud" title={remotes.map((r) => `${r}/${name}`).join(', ')}>☁</span>}
      </span>
      {open &&
        actions &&
        pos &&
        createPortal(
          <div ref={pop} className="rchip-pop" style={{ left: pos.left, top: pos.top, ['--lc' as string]: color }} onClick={(e) => e.stopPropagation()}>
            <div className="rchip-pop-head">
              <span className="rchip-pop-ico">{head ? '✓' : ICON[kind]}</span>
              <div style={{ minWidth: 0 }}>
                <div className="mono rchip-pop-name">{name}</div>
                <div className="small muted">
                  {head ? 'Checked out · ' : ''}
                  {LABEL[kind]}
                  {remotes.length ? ` · on ${remotes.join(', ')}` : kind === 'local' ? ' · not published' : ''}
                </div>
              </div>
            </div>
            <button onClick={run(() => actions.filter(name))}>
              <span>◎</span> Show only {kind === 'tag' ? 'history up to this tag' : 'this branch’s history'} <kbd>dbl-click</kbd>
            </button>
            {(kind === 'local' || kind === 'made-on') && !isCurrent && !name.includes(' ') && (
              <button onClick={run(() => actions.switchTo(name, 'local'))}>
                <span>⇆</span> Switch to this branch…
              </button>
            )}
            {kind === 'remote' && (
              <button onClick={run(() => actions.switchTo(name, 'remote'))}>
                <span>⤓</span> Check out locally…
              </button>
            )}
            {remotes.length > 0 && (
              <button onClick={run(() => actions.filter(`${remotes[0]}/${name}`))}>
                <span>☁</span> Show {remotes[0]}/{name}
              </button>
            )}
            {kind !== 'tag' && (
              <button onClick={run(() => requestQuickMerge(isCurrent || !actions.current ? { source: name } : { source: name, target: actions.current }))}>
                <span>⤵</span> {isCurrent || !actions.current ? 'Merge this branch…' : `Merge into ${actions.current}…`}
              </button>
            )}
            <button onClick={run(() => actions.copy(name, kind === 'tag' ? 'Tag' : 'Branch name'))}>
              <span>⧉</span> Copy {kind === 'tag' ? 'tag' : 'name'}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
