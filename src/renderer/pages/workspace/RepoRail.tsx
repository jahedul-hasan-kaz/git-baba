import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BranchInfo, RepoStatus, StashEntry, TagInfo } from '../../../shared/types';
import { BranchPicker, toPickerItems } from '../../components/BranchPicker';
import { relative } from '../../components/FileDiffList';
import { fitMenu, markScroll } from '../../components/menuFit';
import { Modal } from '../../components/Modal';
import { MultiMergeCard } from '../../components/MultiMergeCard';
import { BranchChangesDialog } from '../../dialogs/BranchChangesDialog';
import { DeleteBranchDialog, MergeBranchesDialog, PublishBranchDialog, SwitchBranchDialog } from '../../dialogs/BranchDialogs';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { useAsync } from '../../hooks/useAsync';
import { call } from '../../services/api';
import { requestMergeStudio } from '../../services/mergeStudio';
import { requestQuickMerge } from '../../services/quickMerge';
import { useApp } from '../../state/AppState';
import type { GraphFocus } from '../GitHistoryPage';
import { WorktreePanel, type AddRequest } from './WorktreePanel';
import { Hourglass } from '../../components/Hourglass';

const COLORS = ['#5b8cff', '#3ecf8e', '#f5b84a', '#ff6b6b', '#b18cff', '#6cc4ff', '#ff9f6b', '#9fd36b'];
/** Same stable colour per branch name as the graph and the Merge Studio. */
const branchColor = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
const DRAG_MIME = 'application/x-gitbaba-rail-branch';
type SectionId = 'local' | 'remote' | 'stash' | 'tags';

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* per-viewer convenience */
  }
}

/** Highlights the part of `text` that matches the filter. */
function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  leaf: BranchInfo | null;
}
function buildTree(list: BranchInfo[], strip: (b: BranchInfo) => string): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), leaf: null };
  for (const b of list) {
    const parts = strip(b).split('/');
    let node = root;
    parts.forEach((part, k) => {
      const path = parts.slice(0, k + 1).join('/');
      let next = node.children.get(part + (k === parts.length - 1 ? '\u0000' : ''));
      if (!next) {
        next = { name: part, path, children: new Map(), leaf: null };
        node.children.set(part + (k === parts.length - 1 ? '\u0000' : ''), next);
      }
      if (k === parts.length - 1) next.leaf = b;
      node = next;
    });
  }
  return root;
}
const countLeaves = (n: TreeNode): number => (n.leaf ? 1 : 0) + [...n.children.values()].reduce((a, c) => a + countLeaves(c), 0);

type Menu =
  | { kind: 'branch'; x: number; y: number; branch: BranchInfo }
  | { kind: 'stash'; x: number; y: number; stash: StashEntry }
  | { kind: 'tag'; x: number; y: number; tag: TagInfo };

interface Props {
  repoId: string;
  status: RepoStatus | null;
  onFocus: (f: Omit<GraphFocus, 'n'>) => void;
}

/**
 * The workspace's left rail: every local and remote branch, stash and tag in one compact, filterable
 * tree. Click to find it in the graph, double-click to switch, drag one branch onto another to merge,
 * right-click for everything else. Collapses to an icon strip (Ctrl+Shift+B) and can be resized.
 */
export function RepoRail({ repoId, status, onFocus }: Props) {
  const { revision, bump, showError, toast, refreshRepos } = useApp();
  const branches = useAsync(() => call('git:branches', { repoId }), [repoId, revision]);
  const stashes = useAsync(() => call('git:stashList', { repoId }), [repoId, revision]);
  const tags = useAsync(() => call('graph:recentTags', { repoId, limit: 100 }), [repoId, revision]);
  const worktrees = useAsync(() => call('git:worktrees', { repoId }), [repoId, revision]);
  const { activeRepo } = useApp();
  const [mode, setMode] = useState<'branches' | 'worktrees'>(() => readPref('gb.ws.railMode', 'branches'));
  useEffect(() => writePref('gb.ws.railMode', mode), [mode]);
  const [addWorktree, setAddWorktree] = useState<AddRequest | null>(null);
  /** Branch → folder name of the other worktree it is checked out in. */
  const inWorktree = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of worktrees.data ?? []) if (w.branch && !w.current) m.set(w.branch, w.path.replace(/[\/]+$/, '').split(/[\/]/).pop() ?? w.path);
    return m;
  }, [worktrees.data]);
  const worktreeCount = worktrees.data?.length ?? 0;

  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const [width, setWidth] = useState(() => readPref('gb.ws.railW', 256));
  const [collapsed, setCollapsed] = useState(() => readPref('gb.ws.railCollapsed', false));
  const [closed, setClosed] = useState<Set<SectionId>>(() => new Set(readPref<SectionId[]>('gb.ws.railClosed', ['tags'])));
  const [folded, setFolded] = useState<Set<string>>(() => new Set(readPref<string[]>(`gb.ws.folded:${repoId}`, [])));
  useEffect(() => writePref('gb.ws.railW', Math.round(width)), [width]);
  useEffect(() => writePref('gb.ws.railCollapsed', collapsed), [collapsed]);
  useEffect(() => writePref('gb.ws.railClosed', [...closed]), [closed]);
  useEffect(() => writePref(`gb.ws.folded:${repoId}`, [...folded]), [folded, repoId]);

  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState<{ name: string; from: string; switchTo: boolean } | null>(null);
  const [publish, setPublish] = useState<{ name: string; base: string } | null>(null);
  const [stashing, setStashing] = useState<{ message: string; untracked: boolean } | null>(null);
  const [toDrop, setToDrop] = useState<StashEntry | null>(null);
  const [renaming, setRenaming] = useState<{ branch: BranchInfo; name: string } | null>(null);
  const [toDelete, setToDelete] = useState<{ branch: string; kind: 'local' | 'remote' } | null>(null);
  const [merging, setMerging] = useState<{ source: string; target: string } | null>(null);
  const [switching, setSwitching] = useState<{ target: string; kind: 'local' | 'remote' } | null>(null);
  const [viewing, setViewing] = useState<{ branch: string; kind: 'local' | 'remote' } | null>(null);
  const [mergeSources, setMergeSources] = useState<string[]>([]);
  const [mergeTarget, setMergeTarget] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const local = useMemo(() => branches.data?.filter((b) => !b.remote) ?? [], [branches.data]);
  const remote = useMemo(() => branches.data?.filter((b) => b.remote && !b.name.endsWith('/HEAD')) ?? [], [branches.data]);
  const localNames = useMemo(() => new Set(local.map((b) => b.name)), [local]);
  const current = local.find((b) => b.current) ?? null;
  const currentName = current?.name ?? null;
  const dirty = status ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length : 0;
  /** A local branch is published when it tracks a remote branch or a remote has a branch of the same name. */
  const publishedOn = (b: BranchInfo): string | null => (b.upstreamGone ? null : b.upstream) ?? remote.find((r) => r.name.slice(r.name.indexOf('/') + 1) === b.name)?.name ?? null;

  // Other screens (the clean Changes screen, keyboard) open the New Branch window.
  useEffect(() => {
    const on = (e: Event) => setNewBranch({ name: '', from: (e as CustomEvent<string>).detail || '', switchTo: true });
    window.addEventListener('gb:new-branch', on);
    return () => window.removeEventListener('gb:new-branch', on);
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop, .dt')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && k === 'b') {
        e.preventDefault();
        setCollapsed((c) => !c);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'n') {
        e.preventDefault();
        setNewBranch({ name: '', from: '', switchTo: true });
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'f') {
        e.preventDefault();
        setCollapsed(false);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) toast(success);
    } catch (err) {
      showError(err);
    }
    bump();
  };
  const copy = (text: string, what: string) => void call('app:copyText', { text }).then(() => toast(`${what} copied`), showError);
  const toggleSection = (id: SectionId) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleFolder = (key: string) =>
    setFolded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const openSwitch = (b: BranchInfo) => {
    if (b.remote) {
      const short = b.name.slice(b.name.indexOf('/') + 1);
      if (localNames.has(short)) {
        if (short !== currentName) setSwitching({ target: short, kind: 'local' });
      } else setSwitching({ target: b.name, kind: 'remote' });
    } else if (!b.current) setSwitching({ target: b.name, kind: 'local' });
  };
  const openStudio = (sources?: string[], target?: string) => {
    if (sources) setMergeSources(sources);
    if (target !== undefined) setMergeTarget(target);
    requestMergeStudio();
  };

  // ---------- rows ----------
  const branchRow = (b: BranchInfo, label: string, depth: number) => {
    const isRemote = b.remote;
    const pub = !isRemote && publishedOn(b);
    const canDrop = !isRemote && dragging && dragging !== b.name;
    return (
      <div
        key={b.name}
        className={`wr-row ${b.current ? 'current' : ''} ${menu?.kind === 'branch' && menu.branch.name === b.name ? 'menu' : ''} ${dropOn === b.name ? 'drop' : ''} ${dragging === b.name ? 'drag-src' : ''}`}
        style={{ ['--d' as string]: depth, ['--bc' as string]: branchColor(b.name) }}
        onClick={() => onFocus({ oid: b.oid, ref: b.name })}
        onDoubleClick={() => openSwitch(b)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ kind: 'branch', x: e.clientX, y: e.clientY, branch: b });
        }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, b.name);
          e.dataTransfer.setData('text/plain', b.name);
          e.dataTransfer.effectAllowed = 'link';
          setDragging(b.name);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropOn(null);
        }}
        onDragOver={(e) => {
          if (!canDrop) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'link';
          if (dropOn !== b.name) setDropOn(b.name);
        }}
        onDragLeave={() => dropOn === b.name && setDropOn(null)}
        onDrop={(e) => {
          e.preventDefault();
          const src = e.dataTransfer.getData(DRAG_MIME);
          setDropOn(null);
          setDragging(null);
          if (src && src !== b.name && !isRemote) setMerging({ source: src, target: b.name });
        }}
        title={`${b.name}\n${b.subject}${b.date ? `\n${relative(b.date)}` : ''}\n\nClick: show in graph · Double-click: ${b.current ? 'you are here' : 'switch'} · Drag onto a branch: merge · Right-click: more`}
      >
        <span className="wr-dot" />
        <span className="wr-name ellipsis">
          <Hl text={label} q={query} />
        </span>
        {b.current && <span className="wr-head">HEAD</span>}
        {!isRemote && inWorktree.has(b.name) && (
          <span className="wr-wt" title={`Checked out in the worktree ${inWorktree.get(b.name)}`} onClick={(e) => { e.stopPropagation(); setMode('worktrees'); }}>
            🗂
          </span>
        )}
        {!isRemote && !pub && <span className="wr-flag" title="Not published — exists only on this computer">local</span>}
        {!!b.ahead && <span className="wr-ab up" title={`${b.ahead} to push`}>↑{b.ahead}</span>}
        {!!b.behind && <span className="wr-ab down" title={`${b.behind} to pull`}>↓{b.behind}</span>}
        {!b.ahead && !b.behind && b.date && <span className="wr-age">{relative(b.date).replace(/ ago$/, '')}</span>}
      </div>
    );
  };

  const latestCommit = (n: TreeNode): number => {
    let t = n.leaf?.date ? Date.parse(n.leaf.date) || 0 : 0;
    for (const c of n.children.values()) t = Math.max(t, latestCommit(c));
    return t;
  };
  const renderTree = (node: TreeNode, scopeKey: string, depth: number): ReactNode[] => {
    // Most recently committed first; a folder ranks by its newest branch. The current branch stays on top.
    const entries = [...node.children.values()].sort((a, b) => {
      if (a.leaf?.current) return -1;
      if (b.leaf?.current) return 1;
      return latestCommit(b) - latestCommit(a) || a.name.localeCompare(b.name);
    });
    return entries.flatMap((n): ReactNode[] => {
      if (n.leaf && n.children.size === 0) return [branchRow(n.leaf, n.name, depth)];
      const key = `${scopeKey}:${n.path}`;
      const open = !!query || !folded.has(key);
      const out: ReactNode[] = [
        <div key={`f:${key}`} className="wr-folder" style={{ ['--d' as string]: depth }} onClick={() => toggleFolder(key)}>
          <span className="wr-caret">{open ? '▾' : '▸'}</span>
          <span className="wr-folder-ico">{open ? '📂' : '📁'}</span>
          <span className="ellipsis grow">{n.name}</span>
          <span className="wr-count">{countLeaves(n)}</span>
        </div>,
      ];
      if (n.leaf) out.push(branchRow(n.leaf, n.name, depth + 1));
      if (open) out.push(...renderTree(n, scopeKey, depth + 1));
      return out;
    });
  };

  const match = (s: string) => !query || s.toLowerCase().includes(query);
  const localShown = local.filter((b) => match(b.name));
  const remoteShown = remote.filter((b) => match(b.name));
  const stashShown = (stashes.data ?? []).filter((s) => match(`${s.ref} ${s.message}`));
  const tagShown = (tags.data ?? []).filter((t) => match(t.name));
  const remotesByName = useMemo(() => {
    const m = new Map<string, BranchInfo[]>();
    for (const b of remoteShown) {
      const r = b.name.slice(0, b.name.indexOf('/'));
      m.set(r, [...(m.get(r) ?? []), b]);
    }
    return m;
  }, [remoteShown]);

  const section = (id: SectionId, icon: string, title: string, count: number, body: ReactNode, extra?: ReactNode) => {
    const open = !closed.has(id) || (!!query && count > 0);
    return (
      <section className={`wr-sec ${open ? 'open' : ''}`}>
        <div className="wr-sec-head" onClick={() => toggleSection(id)}>
          <span className="wr-caret">{open ? '▾' : '▸'}</span>
          <span className="wr-sec-ico">{icon}</span>
          <span className="wr-sec-title">{title}</span>
          <span className="wr-count">{count}</span>
          <span className="spacer" />
          <span onClick={(e) => e.stopPropagation()} className="wr-sec-extra">
            {extra}
          </span>
        </div>
        {open && <div className="wr-sec-body">{body}</div>}
      </section>
    );
  };

  // ---------- collapsed strip ----------
  if (collapsed) {
    const expand = (id?: SectionId) => {
      setCollapsed(false);
      if (id) setClosed((s) => new Set([...s].filter((x) => x !== id)));
    };
    return (
      <aside className="ws-rail mini">
        <button className="wr-mini" onClick={() => expand()} title="Expand the sidebar (Ctrl+Shift+B)">
          »
        </button>
        {mode === 'worktrees' ? (
        <button
          className="wr-mini on"
          onClick={() => {
            setMode('worktrees');
            expand();
          }}
          title={`${worktreeCount} worktrees`}
        >
          🗂<span>{worktreeCount}</span>
        </button>
        ) : (
          <>
        <button className="wr-mini" onClick={() => expand('local')} title={`${local.length} local branches`}>
          ⎇<span>{local.length}</span>
        </button>
        <button className="wr-mini" onClick={() => expand('remote')} title={`${remote.length} remote branches`}>
          ☁<span>{remote.length}</span>
        </button>
        <button className="wr-mini" onClick={() => expand('stash')} title={`${stashes.data?.length ?? 0} stashes`}>
          📦<span>{stashes.data?.length ?? 0}</span>
        </button>
        <button className="wr-mini" onClick={() => expand('tags')} title={`${tags.data?.length ?? 0} tags`}>
          🏷<span>{tags.data?.length ?? 0}</span>
        </button>
          </>
        )}
        <span className="spacer" />
        {mode === 'worktrees' ? (
          <button
            className="wr-mini"
            onClick={() => {
              setAddWorktree({});
              expand();
            }}
            title="New worktree"
          >
            ＋
          </button>
        ) : (
          <>
        <button className="wr-mini" onClick={() => setNewBranch({ name: '', from: '', switchTo: true })} title="New branch (Ctrl+Shift+N)">
          ＋
        </button>
        <button className="wr-mini" onClick={() => openStudio()} title="Merge Studio">
          ✨
        </button>
          </>
        )}
        {dialogs()}
      </aside>
    );
  }

  return (
    <aside className="ws-rail" style={{ width }}>
      <div className={`wr-mode ${mode}`} role="tablist" aria-label="Sidebar view">
        <span className="wr-mode-pill" aria-hidden />
        <button role="tab" aria-selected={mode === 'branches'} className={mode === 'branches' ? 'on' : ''} onClick={() => setMode('branches')} title="Branches, stashes and tags">
          ⎇ Branches <span className="wr-mode-n">{local.length}</span>
        </button>
        <button role="tab" aria-selected={mode === 'worktrees'} className={mode === 'worktrees' ? 'on' : ''} onClick={() => setMode('worktrees')} title="Working folders of this repository">
          🗂 Worktrees <span className="wr-mode-n">{worktreeCount}</span>
        </button>
      </div>
      <div className="wr-top">
        <div className="wr-search">
          <span className="muted">⌕</span>
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} placeholder={mode === 'worktrees' ? 'Filter worktrees' : 'Filter branches, stashes, tags'} spellCheck={false} />
          {q && (
            <button className="wr-x" onClick={() => setQ('')} title="Clear">
              ✕
            </button>
          )}
        </div>
        <button className="wr-tool" onClick={() => setCollapsed(true)} title="Collapse the sidebar (Ctrl+Shift+B)">
          «
        </button>
      </div>

      {mode === 'worktrees' ? (
        <WorktreePanel
          repoId={repoId}
          repoPath={activeRepo?.path ?? ''}
          repoName={activeRepo?.name ?? 'repo'}
          worktrees={worktrees.data ?? null}
          loading={worktrees.loading}
          branches={branches.data ?? []}
          query={q}
          reload={() => void worktrees.reload()}
          addRequest={addWorktree}
          clearAddRequest={() => setAddWorktree(null)}
        />
      ) : (
        <>
      {/* Where you are: the current branch, its sync state and the two most common next steps. */}
      <div className="wr-here" style={{ ['--bc' as string]: branchColor(currentName ?? 'HEAD') }}>
        <button className="wr-here-main" onClick={() => current && onFocus({ oid: current.oid, ref: current.name })} title="Show the current commit in the graph">
          <span className="wr-here-pulse" />
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="wr-here-label">You are on</span>
            <strong className="ellipsis wr-here-name">{currentName ?? (status?.detached ? 'detached HEAD' : '…')}</strong>
          </span>
          {status?.ahead ? <span className="wr-ab up">↑{status.ahead}</span> : null}
          {status?.behind ? <span className="wr-ab down">↓{status.behind}</span> : null}
          {dirty > 0 && <span className="wr-dirty" title={`${dirty} uncommitted change(s)`}>✎{dirty}</span>}
        </button>
        <div className="wr-here-actions">
          <button onClick={() => setNewBranch({ name: '', from: '', switchTo: true })} title="New branch from here (Ctrl+Shift+N)">
            ＋ Branch
          </button>
          <button onClick={() => requestQuickMerge({ source: currentName ?? undefined })} title="Merge this branch into another — or open a pull request">
            ⤵ Merge
          </button>
          <button disabled={dirty === 0} onClick={() => setStashing({ message: '', untracked: true })} title={dirty ? 'Shelve your uncommitted changes' : 'Nothing to stash'}>
            📦 Stash
          </button>
        </div>
      </div>

      <div className="wr-scroll">
        {section(
          'local',
          '⎇',
          'Local',
          localShown.length,
          branches.loading && !branches.data ? <div className="wr-empty mm-shimmer">Loading…</div> : localShown.length ? renderTree(buildTree(localShown, (b) => b.name), 'local', 0) : <div className="wr-empty">{query ? 'No match' : 'No local branches'}</div>,
          <button className="wr-tool sm" onClick={() => setNewBranch({ name: '', from: '', switchTo: true })} title="New branch (Ctrl+Shift+N)">
            ＋
          </button>,
        )}
        {section(
          'remote',
          '☁',
          'Remote',
          remoteShown.length,
          remoteShown.length ? (
            [...remotesByName.entries()].map(([r, list]) => {
              const key = `remote:${r}`;
              const open = !!query || !folded.has(key);
              return (
                <div key={r}>
                  <div className="wr-folder wr-remote" style={{ ['--d' as string]: 0 }} onClick={() => toggleFolder(key)}>
                    <span className="wr-caret">{open ? '▾' : '▸'}</span>
                    <span className="wr-folder-ico">🌐</span>
                    <span className="ellipsis grow">{r}</span>
                    <span className="wr-count">{list.length}</span>
                  </div>
                  {open && renderTree(buildTree(list, (b) => b.name.slice(r.length + 1)), key, 1)}
                </div>
              );
            })
          ) : (
            <div className="wr-empty">{query ? 'No match' : 'None yet — fetch to see remote branches'}</div>
          ),
          <button className="wr-tool sm" onClick={() => window.dispatchEvent(new CustomEvent('gb:repo-dialog', { detail: 'fetch' }))} title="Fetch from the remote">
            <Hourglass />
          </button>,
        )}
        {section(
          'stash',
          '📦',
          'Stashes',
          stashShown.length,
          stashShown.length ? (
            stashShown.map((s) => (
              <div
                key={s.ref}
                className={`wr-row stash ${menu?.kind === 'stash' && menu.stash.ref === s.ref ? 'menu' : ''}`}
                style={{ ['--d' as string]: 0 }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ kind: 'stash', x: e.clientX, y: e.clientY, stash: s });
                }}
                onClick={(e) => setMenu({ kind: 'stash', x: e.clientX, y: e.clientY, stash: s })}
                title={`${s.ref}\n${s.message}\n\nClick: apply, pop or drop`}
              >
                <span className="wr-stash-ico">≡</span>
                <span className="wr-name ellipsis">
                  <Hl text={s.message.replace(/^On [^:]+: /, '')} q={query} />
                </span>
                <span className="wr-age mono">{s.index}</span>
              </div>
            ))
          ) : (
            <div className="wr-empty">{query ? 'No match' : 'No stashes — shelve work in progress with 📦 Stash'}</div>
          ),
          <button className="wr-tool sm" disabled={dirty === 0} onClick={() => setStashing({ message: '', untracked: true })} title={dirty ? 'Stash your changes' : 'Nothing to stash'}>
            ＋
          </button>,
        )}
        {section(
          'tags',
          '🏷',
          'Tags',
          tagShown.length,
          tagShown.length ? (
            tagShown.map((t) => (
              <div
                key={t.name}
                className={`wr-row tag ${menu?.kind === 'tag' && menu.tag.name === t.name ? 'menu' : ''}`}
                style={{ ['--d' as string]: 0 }}
                onClick={() => onFocus({ oid: t.commit, ref: t.name })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ kind: 'tag', x: e.clientX, y: e.clientY, tag: t });
                }}
                title={`${t.name}${t.message ? `\n${t.message}` : ''}${t.date ? `\n${relative(t.date)}` : ''}\n\nClick: show in graph · Right-click: more`}
              >
                <span className="wr-tag-ico">🏷</span>
                <span className="wr-name ellipsis">
                  <Hl text={t.name} q={query} />
                </span>
                {t.date && <span className="wr-age">{relative(t.date).replace(/ ago$/, '')}</span>}
              </div>
            ))
          ) : (
            <div className="wr-empty">{query ? 'No match' : 'No tags'}</div>
          ),
        )}
      </div>

        </>
      )}

      {dragging && (
        <div className="wr-drag-hint">
          Drop <strong>{dragging}</strong> on a local branch to merge it there
        </div>
      )}

      <div
        className="wr-resizer"
        title="Drag to resize · double-click to reset"
        onDoubleClick={() => setWidth(256)}
        onMouseDown={(e) => {
          e.preventDefault();
          const start = e.clientX;
          const w0 = width;
          const move = (ev: MouseEvent) => setWidth(Math.max(200, Math.min(440, w0 + ev.clientX - start)));
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            document.body.classList.remove('resizing');
          };
          document.body.classList.add('resizing');
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
      />
      {dialogs()}
    </aside>
  );

  // ---------- menus & dialogs (shared by both rail sizes) ----------
  function dialogs() {
    return (
      <>
        {menu && <RailMenu menu={menu} onClose={() => setMenu(null)}>{menuItems(menu)}</RailMenu>}
        <MultiMergeCard
          repoId={repoId}
          local={local}
          remote={remote}
          currentName={currentName}
          sources={mergeSources}
          setSources={setMergeSources}
          target={mergeTarget}
          setTarget={setMergeTarget}
          onChanged={bump}
          headless
        />
        {newBranch && newBranchDialog()}
        {stashing && (
          <Modal
            title="Stash Changes"
            icon="📦"
            size="narrow"
            onClose={() => setStashing(null)}
            footer={
              <>
                <button className="btn cancel" onClick={() => setStashing(null)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    const s = stashing;
                    setStashing(null);
                    void act(() => call('git:stashPush', { repoId, message: s.message.trim(), includeUntracked: s.untracked }), 'Changes stashed');
                  }}
                >
                  Stash {dirty} change{dirty === 1 ? '' : 's'}
                </button>
              </>
            }
          >
            <p className="small muted">Shelves your uncommitted changes so the working folder is clean — handy before switching branches or pulling. Bring them back any time from the Stashes list.</p>
            <div className="field">
              <label>Message (optional)</label>
              <input autoFocus value={stashing.message} onChange={(e) => setStashing({ ...stashing, message: e.target.value })} placeholder="e.g. half-done login form" />
            </div>
            <label className="check">
              <input type="checkbox" checked={stashing.untracked} onChange={(e) => setStashing({ ...stashing, untracked: e.target.checked })} /> Include new (untracked) files
            </label>
          </Modal>
        )}
        {toDrop && (
          <ConfirmDialog
            title="Drop Stash"
            danger
            explanation={
              <>
                Permanently deletes <code>{toDrop.ref}</code> ({toDrop.message}).
              </>
            }
            impact="The stashed changes will be lost."
            confirmLabel="Drop stash"
            onCancel={() => setToDrop(null)}
            onConfirm={async () => {
              const s = toDrop;
              setToDrop(null);
              await act(() => call('git:stashDrop', { repoId, index: s.index, confirmed: true }), 'Stash dropped');
            }}
          />
        )}
        {renaming && renameDialog()}
        {toDelete && (
          <DeleteBranchDialog
            repoId={repoId}
            branch={toDelete.branch}
            kind={toDelete.kind}
            onClose={() => {
              setToDelete(null);
              bump();
            }}
            onDone={() => {
              setToDelete(null);
              bump();
            }}
          />
        )}
        {publish && (
          <PublishBranchDialog
            repoId={repoId}
            name={publish.name}
            base={publish.base}
            onClose={() => {
              setPublish(null);
              bump();
            }}
            onDone={() => {
              setPublish(null);
              bump();
            }}
          />
        )}
        {switching && (
          <SwitchBranchDialog
            repoId={repoId}
            target={switching.target}
            kind={switching.kind}
            onClose={() => {
              setSwitching(null);
              bump();
            }}
            onDone={() => {
              setSwitching(null);
              bump();
              void refreshRepos();
            }}
          />
        )}
        {merging && (
          <MergeBranchesDialog
            repoId={repoId}
            source={merging.source}
            target={merging.target}
            onClose={() => {
              setMerging(null);
              bump();
            }}
            onDone={() => {
              setMerging(null);
              bump();
            }}
          />
        )}
        {viewing && (
          <BranchChangesDialog
            repoId={repoId}
            branch={viewing.branch}
            candidates={[...local, ...remote].map((b) => b.name)}
            branchInfo={[...local, ...remote]}
            onClose={() => setViewing(null)}
          />
        )}
      </>
    );
  }

  function menuItems(m: Menu): ReactNode {
    const item = (ico: string, label: ReactNode, run: () => void, opts?: { danger?: boolean; disabled?: boolean; title?: string }) => (
      <div
        className={`dropdown-item ${opts?.danger ? 'danger' : ''} ${opts?.disabled ? 'disabled' : ''}`}
        title={opts?.title}
        onClick={
          opts?.disabled
            ? undefined
            : () => {
                setMenu(null);
                run();
              }
        }
      >
        <span className="ctx-ico">{ico}</span> {label}
      </div>
    );
    if (m.kind === 'stash') {
      const s = m.stash;
      return (
        <>
          <div className="ctx-head">
            <strong className="ellipsis">{s.message}</strong>
            <span className="small muted mono">{s.ref}</span>
          </div>
          {item('⤓', 'Apply (keep the stash)', () => act(() => call('git:stashApply', { repoId, index: s.index, pop: false }), 'Stash applied'))}
          {item('⇣', 'Pop (apply and remove)', () => act(() => call('git:stashApply', { repoId, index: s.index, pop: true }), 'Stash popped'))}
          {item('⧉', 'Copy message', () => copy(s.message, 'Stash message'))}
          <div className="dropdown-sep" />
          {item('✕', 'Drop…', () => setToDrop(s), { danger: true })}
        </>
      );
    }
    if (m.kind === 'tag') {
      const t = m.tag;
      return (
        <>
          <div className="ctx-head">
            <strong className="ellipsis mono">{t.name}</strong>
            <span className="small muted">{t.annotated ? 'annotated tag' : 'tag'}</span>
          </div>
          {item('◉', 'Show in graph', () => onFocus({ oid: t.commit, ref: t.name }))}
          {item('＋', 'New branch from this tag…', () => setNewBranch({ name: '', from: t.name, switchTo: true }))}
          {item('⧉', 'Copy tag name', () => copy(t.name, 'Tag name'))}
          {item('#', 'Copy commit SHA', () => copy(t.commit, 'Commit SHA'))}
        </>
      );
    }
    const b = m.branch;
    const isLocal = !b.remote;
    const short = isLocal ? b.name : b.name.slice(b.name.indexOf('/') + 1);
    const hasLocal = !isLocal && localNames.has(short);
    const isCurrent = isLocal && b.current;
    const pub = isLocal ? publishedOn(b) : null;
    return (
      <>
        <div className="ctx-head">
          <strong className="ellipsis mono">{b.name}</strong>
          <span className="small muted ellipsis">{isCurrent ? 'current branch' : isLocal ? (pub ? `local · tracks ${pub}` : 'local · not published') : 'remote branch'}</span>
        </div>
        {item('◉', 'Show in graph', () => onFocus({ oid: b.oid, ref: b.name }))}
        {isLocal && !isCurrent && item('⇄', `Switch to ${b.name}`, () => setSwitching({ target: b.name, kind: 'local' }))}
        {!isLocal && !hasLocal && item('⤓', `Check out locally as ${short}`, () => setSwitching({ target: b.name, kind: 'remote' }))}
        {hasLocal && short !== currentName && item('⇄', `Switch to local ${short}`, () => setSwitching({ target: short, kind: 'local' }))}
        {item('≋', 'View changes vs. main…', () => setViewing({ branch: b.name, kind: isLocal ? 'local' : 'remote' }))}
        <div className="dropdown-sep" />
        <div className="dropdown-title">Merge</div>
        {currentName && !isCurrent && item('⤵', <>Merge into <strong className="mono">{currentName}</strong>…</>, () => requestQuickMerge({ source: b.name, target: currentName }))}
        {isLocal && currentName && !isCurrent && item('⤴', <>Merge <span className="mono">{currentName}</span> into this…</>, () => requestQuickMerge({ source: currentName, target: b.name }))}
        {isCurrent && item('⤵', 'Merge this branch…', () => requestQuickMerge({ source: b.name }))}
        {item('✨', 'Merge Studio with this as source…', () => openStudio([...mergeSources.filter((x) => x !== b.name), b.name], mergeTarget === b.name ? '' : undefined))}
        {isLocal && item('◎', 'Merge Studio with this as target…', () => openStudio(mergeSources.filter((x) => x !== b.name), b.name))}
        <div className="dropdown-sep" />
        {item('＋', 'New branch from here…', () => setNewBranch({ name: '', from: b.name, switchTo: true }))}
        {isLocal && !isCurrent && !inWorktree.has(b.name) &&
          item('🗂', 'Open in a new worktree…', () => {
            setMode('worktrees');
            setAddWorktree({ branch: b.name });
          })}
        {!isLocal && !hasLocal &&
          item('🗂', `Check out ${short} in a new worktree…`, () => {
            setMode('worktrees');
            setAddWorktree({ branch: b.name });
          })}
        {isLocal && inWorktree.has(b.name) && item('🗂', `In worktree ${inWorktree.get(b.name)} — show`, () => setMode('worktrees'))}
        {isLocal &&
          item('✎', `Rename…${pub ? ' (published)' : ''}`, () => setRenaming({ branch: b, name: b.name }), {
            disabled: !!pub,
            title: pub ? `Published as ${pub} — only unpublished branches can be renamed` : 'Rename this branch',
          })}
        {isLocal && !pub && item('⬆', 'Publish…', () => setPublish({ name: b.name, base: b.name }))}
        {item('⧉', 'Copy branch name', () => copy(b.name, 'Branch name'))}
        {!isCurrent && (
          <>
            <div className="dropdown-sep" />
            {item('✕', `Delete${isLocal ? '' : ' from remote'}…`, () => setToDelete({ branch: b.name, kind: isLocal ? 'local' : 'remote' }), { danger: true })}
          </>
        )}
      </>
    );
  }

  function newBranchDialog() {
    const nb = newBranch!;
    const name = nb.name.trim();
    const valid = /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('/') && !name.endsWith('/') && !name.includes('..') && !name.endsWith('.lock') && !name.startsWith('-');
    const taken = localNames.has(name);
    const ok = !!name && valid && !taken;
    const create = () =>
      act(async () => {
        await call('git:createBranch', { repoId, name, startPoint: nb.from || undefined, switchTo: nb.switchTo });
        setNewBranch(null);
      }, `Created ${name}`);
    return (
      <Modal
        title="New Branch"
        icon="⎇"
        size="narrow"
        onClose={() => setNewBranch(null)}
        footer={
          <>
            <button className="btn cancel" onClick={() => setNewBranch(null)}>
              Cancel
            </button>
            <button className="btn" disabled={!ok} onClick={create} title="Create the branch on this computer only (nothing is pushed)">
              Create locally
            </button>
            <button
              className="btn primary"
              disabled={!ok}
              onClick={() => {
                setPublish({ name, base: nb.from });
                setNewBranch(null);
              }}
              title="Create the branch, push it with the authentication you choose, and verify it on the remote"
            >
              Create & Publish…
            </button>
          </>
        }
      >
        <div className="field">
          <label>Branch name</label>
          <input
            className="mono"
            autoFocus
            value={nb.name}
            onChange={(e) => setNewBranch({ ...nb, name: e.target.value.replace(/\s+/g, '-') })}
            onKeyDown={(e) => e.key === 'Enter' && ok && create()}
            placeholder="feature/my-change"
            spellCheck={false}
          />
          {taken && <div className="small text-danger">A branch with this name already exists.</div>}
          {!valid && name && <div className="small text-danger">Use letters, digits, “.”, “_”, “-” and “/” (no “..” or trailing “/”).</div>}
          <div className="wr-presets">
            {['feature/', 'fix/', 'chore/', 'release/'].map((p) => (
              <button key={p} type="button" className="mm-chip static" onClick={() => setNewBranch({ ...nb, name: p + nb.name.replace(/^(feature|fix|chore|release)\//, '') })}>
                {p}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Start from</label>
          <BranchPicker
            value={nb.from}
            onChange={(from) => setNewBranch({ ...nb, from })}
            items={toPickerItems([...local, ...remote])}
            special={[{ name: '', label: `Current branch (HEAD)${currentName ? ` · ${currentName}` : ''}`, icon: '◉', subject: 'Start from where you are now' }]}
            recentKey="branch-start"
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={nb.switchTo} onChange={(e) => setNewBranch({ ...nb, switchTo: e.target.checked })} /> Switch to the new branch
        </label>
        {nb.switchTo && dirty > 0 && <p className="small muted">Your {dirty} uncommitted change(s) come along to the new branch.</p>}
      </Modal>
    );
  }

  function renameDialog() {
    const r = renaming!;
    const name = r.name.trim();
    const taken = local.some((x) => x.name === name && x.name !== r.branch.name);
    const valid = /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('/') && !name.endsWith('/') && !name.includes('..') && !name.endsWith('.lock') && !name.startsWith('-');
    const same = name === r.branch.name;
    const ok = !!name && valid && !taken && !same;
    const go = () =>
      act(async () => {
        await call('git:renameBranch', { repoId, name: r.branch.name, newName: name });
        setRenaming(null);
      }, `Renamed ${r.branch.name} → ${name}`);
    return (
      <Modal
        title="Rename Branch"
        icon="✎"
        size="narrow"
        onClose={() => setRenaming(null)}
        footer={
          <>
            <button className="btn cancel" onClick={() => setRenaming(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!ok} onClick={go}>
              Rename
            </button>
          </>
        }
      >
        <div className="field">
          <label>
            New name for <span className="mono">{r.branch.name}</span>
          </label>
          <input className="mono" value={r.name} autoFocus spellCheck={false} onChange={(e) => setRenaming({ ...r, name: e.target.value })} onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => e.key === 'Enter' && ok && go()} />
          {taken && <div className="small text-danger">A branch with this name already exists.</div>}
          {!valid && name && <div className="small text-danger">Use letters, digits, “.”, “_”, “-” and “/” (no “..” or trailing “/”).</div>}
        </div>
        <p className="small muted">
          Only this computer is affected{r.branch.current ? ' — you are on this branch, and stay on it under the new name' : ''}. The branch has not been published, so nothing on a remote changes.
        </p>
      </Modal>
    );
  }
}

/** A context menu that stays inside the window and closes on outside click, Esc, scroll or resize. */
function RailMenu({ menu, onClose, children }: { menu: Menu; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    const onScroll = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fitMenu(el, menu.x, menu.y);
  }, [menu]);
  return (
    <div ref={ref} className="ctx-menu" style={{ left: menu.x, top: menu.y }} onScroll={(e) => markScroll(e.currentTarget)} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  );
}
