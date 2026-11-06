import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fitSubmenu, markScroll, useMenuFit } from '../../components/menuFit';
import type { GraphCommit } from '../../../shared/types';
import { relative } from '../../components/FileDiffList';
import { requestQuickMerge } from '../../services/quickMerge';
import type { CommitAction } from './CommitActions';
import { authorColor, initials } from './graphStyle';

export type CompareKind = 'A' | 'B' | 'selected' | 'head' | 'parent';

interface Item {
  id: string;
  label: string;
  icon: string;
  hint?: string;
  disabled?: string | false;
  danger?: boolean;
  sub?: Item[];
  run?: () => void;
}
type Entry = Item | { sep: string };

interface Props {
  x: number;
  y: number;
  commit: GraphCommit;
  current: string | null;
  headHash: string | null;
  selected: string | null;
  onAction: (a: CommitAction, opts?: { mode?: string }) => void;
  onCompare: (k: CompareKind) => void;
  onClose: () => void;
}

/** Commit context menu: grouped actions, submenus, a quick-action strip and full keyboard control. */
export function CommitMenu({ x, y, commit, current, headHash, selected, onAction, onCompare, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [subOpen, setSubOpen] = useState<string | null>(null);
  const [subActive, setSubActive] = useState(0);
  const subRef = useRef<HTMLDivElement>(null);
  const isHead = commit.hash === headHash;
  const tags = commit.refs.filter((r) => r.startsWith('tag: '));
  const on = current ?? 'HEAD';
  const act = (a: CommitAction, opts?: { mode?: string }) => () => onAction(a, opts);
  const cmp = (k: CompareKind) => () => onCompare(k);
  // The branch this commit belongs to: a branch ref sitting on it, else the branch it was made on.
  const mergeFrom = commit.refs.map((r) => r.replace(/^HEAD -> /, '')).find((r) => !r.startsWith('tag: ') && r !== 'HEAD' && !r.endsWith('/HEAD')) ?? commit.branch ?? null;

  const entries: Entry[] = [
    { sep: 'Branch & HEAD' },
    { id: 'checkout', label: 'Check out this commit…', icon: '⎋', run: act('checkout'), disabled: isHead && 'Already checked out' },
    { id: 'branch', label: 'Create branch here…', icon: '⎇', hint: 'B', run: act('branch') },
    { id: 'worktree', label: 'Create worktree…', icon: '🌲', run: act('worktree') },
    { sep: `Apply to ${on}` },
    { id: 'cherry', label: `Cherry-pick onto ${on}…`, icon: '🍒', hint: 'P', run: act('cherry-pick'), disabled: isHead && 'This is the current commit' },
    { id: 'revert', label: 'Revert this commit…', icon: '↶', run: act('revert') },
    { sep: 'Merge' },
    {
      id: 'merge',
      label: mergeFrom && mergeFrom !== current ? `Merge ${mergeFrom} into ${on}…` : 'Merge…',
      icon: '⤵',
      run: () => requestQuickMerge(mergeFrom && mergeFrom !== current ? { source: mergeFrom, target: current ?? undefined } : { source: mergeFrom ?? current ?? undefined }),
    },
    { sep: 'Rewrite' },
    { id: 'rebase', label: `Rebase ${on} onto this…`, icon: '⤴', run: act('rebase'), disabled: isHead && 'This is the current commit' },
    {
      id: 'reset',
      label: `Reset ${on} to this`,
      icon: '⟲',
      disabled: isHead && 'The branch is already here',
      sub: [
        { id: 'reset-soft', label: 'Soft — keep changes staged', icon: '◔', run: act('reset', { mode: 'soft' }) },
        { id: 'reset-mixed', label: 'Mixed — keep changes unstaged', icon: '◑', run: act('reset', { mode: 'mixed' }) },
        { id: 'reset-keep', label: 'Keep — update files, keep my edits', icon: '◕', run: act('reset', { mode: 'keep' }) },
        { id: 'reset-hard', label: 'Hard — discard everything (undoable)', icon: '●', danger: true, run: act('reset', { mode: 'hard' }) },
      ],
    },
    { sep: 'Compare' },
    {
      id: 'compare',
      label: 'Compare',
      icon: '⇄',
      sub: [
        { id: 'cmp-sel', label: 'With the selected commit', icon: '◎', run: cmp('selected'), disabled: (!selected || selected === commit.hash) && 'Select another commit first' },
        { id: 'cmp-head', label: `With ${on} (HEAD)`, icon: '●', run: cmp('head'), disabled: isHead && 'This is HEAD' },
        { id: 'cmp-parent', label: 'With its parent', icon: '↧', run: cmp('parent'), disabled: !commit.parents.length && 'First commit has no parent' },
        { id: 'cmp-a', label: 'Set as A (base)', icon: 'A', run: cmp('A') },
        { id: 'cmp-b', label: 'Set as B', icon: 'B', run: cmp('B') },
      ],
    },
    { sep: 'Share' },
    { id: 'tag', label: 'Create tag here…', icon: '🏷', hint: 'T', run: act('tag') },
    {
      id: 'patch',
      label: 'Create patch',
      icon: '🩹',
      sub: [
        { id: 'patch-save', label: 'Save as .patch file…', icon: '💾', run: act('save-patch') },
        { id: 'patch-copy', label: 'Copy patch to clipboard', icon: '⧉', run: act('copy-patch') },
      ],
    },
    { id: 'remote', label: 'Open commit on remote', icon: '↗', run: act('open-remote') },
    {
      id: 'copy',
      label: 'Copy',
      icon: '⧉',
      sub: [
        { id: 'copy-sha', label: 'SHA', icon: '#', hint: 'C', run: act('copy-sha') },
        { id: 'copy-short', label: `Short SHA · ${commit.shortHash}`, icon: '#', run: act('copy-short') },
        { id: 'copy-msg', label: 'Message', icon: '✉', run: act('copy-message') },
        { id: 'copy-patch2', label: 'Changes (patch)', icon: '🩹', run: act('copy-patch') },
        { id: 'copy-tags', label: tags.length > 1 ? `Tags (${tags.length})` : tags.length ? `Tag · ${tags[0].slice(5)}` : 'Tag', icon: '🏷', run: act('copy-tags'), disabled: !tags.length && 'No tag on this commit' },
      ],
    },
  ];
  const items = entries.filter((e): e is Item => 'id' in e);
  const subOf = (id: string | null) => items.find((i) => i.id === id)?.sub ?? null;

  // Keep the menu, and any submenu, entirely inside the window (scrolling when the window is short).
  useMenuFit(ref, x, y);
  useLayoutEffect(() => {
    const menu = ref.current;
    const sub = subRef.current;
    const row = menu?.querySelector<HTMLElement>('.cm-item.open');
    if (menu && sub && row) fitSubmenu(sub, row, menu);
  }, [subOpen]);

  useEffect(() => {
    ref.current?.focus();
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !subRef.current?.contains(e.target as Node) && onClose();
    const blur = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [onClose]);

  const fire = (it: Item) => {
    if (it.disabled) return;
    if (it.sub) {
      setSubOpen(it.id);
      setSubActive(0);
      return;
    }
    it.run?.();
    onClose();
  };
  const moveTo = (d: number) => {
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + d + items.length) % items.length;
      if (!items[i].disabled) break;
    }
    setActive(i);
    setSubOpen(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const sub = subOf(subOpen);
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (sub) setSubOpen(null);
      else onClose();
    } else if (sub && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setSubActive((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + sub.length) % sub.length);
    } else if (sub && e.key === 'ArrowLeft') {
      e.preventDefault();
      setSubOpen(null);
    } else if (sub && e.key === 'Enter') {
      e.preventDefault();
      fire(sub[subActive]);
    } else if (e.key === 'ArrowDown') (e.preventDefault(), moveTo(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), moveTo(-1));
    else if ((e.key === 'ArrowRight' || e.key === 'Enter') && items[active]) (e.preventDefault(), fire(items[active]));
  };

  let idx = -1;
  return (
    <div
      ref={ref}
      className="cm"
      tabIndex={-1}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      onScroll={(e) => {
        markScroll(e.currentTarget);
        setSubOpen(null);
      }}
      style={{ left: x, top: y }}
      role="menu"
    >
      <div className="cm-head">
        <span className="cm-avatar" style={{ background: authorColor(commit.email || commit.author) }}>
          {initials(commit.author)}
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ellipsis cm-subject">{commit.subject}</div>
          <div className="small muted">
            <span className="mono">{commit.shortHash}</span> · {commit.author} · {relative(commit.date)}
          </div>
        </div>
      </div>
      <div className="cm-quick">
        {(
          [
            ['⧉', 'Copy SHA', act('copy-sha'), false],
            ['🍒', 'Cherry-pick', act('cherry-pick'), isHead],
            ['⎇', 'Branch here', act('branch'), false],
            ['🏷', 'Tag here', act('tag'), false],
            ['⇄', 'Compare with HEAD', cmp('head'), isHead],
            ['↗', 'Open on remote', act('open-remote'), false],
          ] as [string, string, () => void, boolean][]
        ).map(([ico, t, fn, dis]) => (
          <button
            key={t}
            title={t}
            disabled={dis}
            onClick={() => {
              fn();
              onClose();
            }}
          >
            {ico}
          </button>
        ))}
      </div>
      {entries.map((e, n) => {
        if ('sep' in e)
          return (
            <div key={`s${n}`} className="cm-sep">
              {e.sep}
            </div>
          );
        idx++;
        const i = idx;
        const sub = e.sub && subOpen === e.id;
        return (
          <div
            key={e.id}
            role="menuitem"
            aria-disabled={!!e.disabled}
            className={`cm-item ${i === active ? 'active' : ''} ${e.disabled ? 'disabled' : ''} ${e.danger ? 'danger' : ''} ${sub ? 'open' : ''}`}
            title={e.disabled || undefined}
            onMouseEnter={() => {
              setActive(i);
              setSubOpen(e.sub && !e.disabled ? e.id : null);
              setSubActive(-1);
            }}
            onClick={() => fire(e)}
          >
            <span className="cm-ico">{e.icon}</span>
            <span className="grow ellipsis">{e.label}</span>
            {e.hint && <kbd>{e.hint}</kbd>}
            {e.sub && <span className="cm-chev">▸</span>}
            {sub &&
              createPortal(
              <div
                ref={subRef}
                className="cm-sub"
                role="menu"
                onClick={(ev) => ev.stopPropagation()}
                onMouseDown={(ev) => ev.stopPropagation()}
                onContextMenu={(ev) => ev.preventDefault()}
                onScroll={(ev) => markScroll(ev.currentTarget)}
                onKeyDown={onKey}
              >
                {e.sub!.map((s, k) => (
                  <div
                    key={s.id}
                    role="menuitem"
                    aria-disabled={!!s.disabled}
                    className={`cm-item ${k === subActive ? 'active' : ''} ${s.disabled ? 'disabled' : ''} ${s.danger ? 'danger' : ''}`}
                    title={s.disabled || undefined}
                    onMouseEnter={() => setSubActive(k)}
                    onClick={() => fire(s)}
                  >
                    <span className="cm-ico">{s.icon}</span>
                    <span className="grow ellipsis">{s.label}</span>
                    {s.hint && <kbd>{s.hint}</kbd>}
                  </div>
                ))}
              </div>,
              document.body,
            )}
          </div>
        );
      })}
    </div>
  );
}
