import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommitStatFile, FileAtCommit, FileDiff } from '../../../shared/types';
import { DiffViewer } from '../../components/DiffViewer';
import { FileDiffList } from '../../components/FileDiffList';
import { Modal } from '../../components/Modal';
import { DiffTheater } from './DiffTheater';
import { createPortal } from 'react-dom';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';

type View = 'tree' | 'list' | 'stack';
type Status = CommitStatFile['status'];

const STATUS: Record<Status, { letter: string; label: string }> = {
  added: { letter: 'A', label: 'Added' },
  modified: { letter: 'M', label: 'Modified' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
  copied: { letter: 'C', label: 'Copied' },
  typechange: { letter: 'T', label: 'Type changed' },
};

const EXT_ICON: [RegExp, string][] = [
  [/\.(tsx?|jsx?|mjs|cjs)$/, '🟦'],
  [/\.(css|scss|less)$/, '🎨'],
  [/\.(json|ya?ml|toml|ini|env)$/, '⚙'],
  [/\.(md|mdx|txt|rst)$/, '📝'],
  [/\.(png|jpe?g|gif|svg|webp|ico)$/, '🖼'],
  [/\.(py|rb|go|rs|java|kt|cs|php|c|cpp|h|swift)$/, '📜'],
  [/(^|\/)(package(-lock)?\.json|Dockerfile|Makefile|\.gitignore)$/, '📦'],
  [/\.(html?|xml)$/, '🌐'],
  [/\.(sh|ps1|bat|cmd)$/, '⌨'],
];
export const fileIcon = (p: string) => EXT_ICON.find(([re]) => re.test(p))?.[1] ?? '📄';
const VIEW_KEY = 'gb.history.filesView';

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: CommitStatFile[];
  add: number;
  del: number;
  count: number;
}

function buildTree(files: CommitStatFile[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [], add: 0, del: 0, count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    node.add += f.additions;
    node.del += f.deletions;
    node.count++;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.get(part);
      if (!next) node.folders.set(part, (next = { name: part, path, folders: new Map(), files: [], add: 0, del: 0, count: 0 }));
      next.add += f.additions;
      next.del += f.deletions;
      next.count++;
      node = next;
    }
    node.files.push(f);
  }
  // Collapse single-child folder chains ("src/renderer/pages" instead of three levels).
  const squash = (n: Folder): Folder => {
    for (const [k, c] of n.folders) n.folders.set(k, squash(c));
    if (n.path && n.files.length === 0 && n.folders.size === 1) {
      const only = [...n.folders.values()][0];
      return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return squash(root);
}

function ChangeBar({ add, del, max }: { add: number; del: number; max: number }) {
  const total = add + del;
  const w = Math.max(6, Math.round((Math.min(total, max) / Math.max(max, 1)) * 48));
  return (
    <span className="fx-bar" style={{ width: w }} title={`+${add} −${del}`}>
      <span className="fx-bar-add" style={{ width: `${total ? (add / total) * 100 : 0}%` }} />
      <span className="fx-bar-del" style={{ width: `${total ? (del / total) * 100 : 0}%` }} />
    </span>
  );
}

/** Commit file changes, GitKraken-style: tree/list of files with filters and a focused diff, or every diff stacked. */
/**
 * `dockHost`: where a clicked file's diff opens (the centre pane, over the graph). Without it a click
 * only focuses the file and the diff opens inline or in the focus view.
 */
export function CommitFilesExplorer({ repoId, files, diffs, atCommit, context, dockHost }: { repoId: string; files: CommitStatFile[]; diffs: FileDiff[]; atCommit: string | null; context?: string; dockHost?: HTMLElement | null }) {
  const { toast, showError } = useApp();
  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem(VIEW_KEY) as View) || 'tree';
    } catch {
      return 'tree';
    }
  });
  const [only, setOnly] = useState<Set<Status>>(new Set());
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<FileAtCommit | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [theater, setTheater] = useState<string | null>(null);
  const [docked, setDocked] = useState(false);
  // Another commit (or comparison): close the centre diff.
  useEffect(() => setDocked(false), [files]);
  const [openMode, setOpenMode] = useState<'focus' | 'inline'>(() => {
    try {
      return localStorage.getItem('gb.history.diffOpen') === 'inline' ? 'inline' : 'focus';
    } catch {
      return 'focus';
    }
  });
  const pickOpenMode = (m: 'focus' | 'inline') => {
    setOpenMode(m);
    try {
      localStorage.setItem('gb.history.diffOpen', m);
    } catch {
      /* per-viewer convenience */
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* per-viewer convenience only */
    }
  }, [view]);

  const byPath = useMemo(() => new Map(diffs.map((d) => [d.status === 'deleted' ? d.oldPath : d.newPath, d])), [diffs]);
  const term = search.trim().toLowerCase();
  const counts = useMemo(() => {
    const c = new Map<Status, number>();
    files.forEach((f) => c.set(f.status, (c.get(f.status) ?? 0) + 1));
    return c;
  }, [files]);
  const shown = useMemo(
    () =>
      files.filter((f) => {
        if (only.size && !only.has(f.status)) return false;
        if (term) {
          const d = byPath.get(f.path);
          return f.path.toLowerCase().includes(term) || !!d?.hunks.some((h) => h.lines.some((l) => l.content.toLowerCase().includes(term)));
        }
        return true;
      }),
    [files, only, term, byPath],
  );
  const maxChange = useMemo(() => Math.max(1, ...files.map((f) => f.additions + f.deletions)), [files]);
  const tree = useMemo(() => buildTree(shown), [shown]);

  // Order used for keyboard / prev-next: the visual order of the current view.
  const ordered = useMemo(() => {
    if (view !== 'tree') return shown;
    const out: CommitStatFile[] = [];
    const walk = (n: Folder) => {
      [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => !collapsed.has(c.path) && walk(c));
      [...n.files].sort((a, b) => a.path.localeCompare(b.path)).forEach((f) => out.push(f));
    };
    walk(tree);
    return out;
  }, [view, shown, tree, collapsed]);

  useEffect(() => {
    if (!ordered.length) return setFocus(null);
    if (!focus || !ordered.some((f) => f.path === focus)) setFocus(ordered[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-file="${CSS.escape(focus ?? '')}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const fi = ordered.findIndex((f) => f.path === focus);
  const step = (d: number) => ordered.length && setFocus(ordered[(fi + d + ordered.length) % ordered.length].path);
  const focused = fi >= 0 ? ordered[fi] : null;
  const dock = !!dockHost;

  useEffect(() => {
    if (!docked) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || document.querySelector('.modal-backdrop')) return;
      if (e.key === 'Escape') (e.preventDefault(), setDocked(false));
      if (e.key === ']') (e.preventDefault(), step(1));
      if (e.key === '[') (e.preventDefault(), step(-1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const copy = async (text: string, what: string) => {
    try {
      await call('app:copyText', { text });
      toast(`${what} copied`);
    } catch (err) {
      showError(err);
    }
  };
  const openAt = (f: CommitStatFile) =>
    atCommit &&
    call('graph:fileAt', { repoId, hash: atCommit, path: f.path })
      .then(setViewing)
      .catch(showError);

  const toggleStatus = (s: Status) =>
    setOnly((o) => {
      const n = new Set(o);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  const fileRow = (f: CommitStatFile, depth: number, label: string) => (
    <div
      key={f.path}
      data-file={f.path}
      className={`fx-file ${focus === f.path ? 'on' : ''} ${docked && focus === f.path ? 'docked' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => {
        setFocus(f.path);
        if (dock) setDocked(true);
      }}
      onDoubleClick={() => setTheater(f.path)}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
    >
      <span className={`fx-st ${f.status}`}>{STATUS[f.status].letter}</span>
      <span className="fx-ico">{fileIcon(f.path)}</span>
      <span className="fx-name ellipsis grow">
        {view === 'list' && label.includes('/') ? (
          <>
            <span className="fx-dir">{label.slice(0, label.lastIndexOf('/') + 1)}</span>
            {label.slice(label.lastIndexOf('/') + 1)}
          </>
        ) : (
          label
        )}
        {f.oldPath && <span className="fx-dir"> ← {f.oldPath.split('/').pop()}</span>}
      </span>
      {f.binary ? (
        <span className="badge">bin</span>
      ) : (
        <>
          <span className="fx-num add">+{f.additions}</span>
          <span className="fx-num del">−{f.deletions}</span>
          <ChangeBar add={f.additions} del={f.deletions} max={maxChange} />
        </>
      )}
    </div>
  );

  const folderRows = (n: Folder, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    [...n.folders.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const closed = collapsed.has(c.path);
        out.push(
          <div
            key={`d:${c.path}`}
            className="fx-folder"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() =>
              setCollapsed((s) => {
                const x = new Set(s);
                if (x.has(c.path)) x.delete(c.path);
                else x.add(c.path);
                return x;
              })
            }
          >
            <span className="fx-caret">{closed ? '▸' : '▾'}</span>
            <span className="fx-ico">{closed ? '📁' : '📂'}</span>
            <span className="ellipsis grow">{c.name}</span>
            <span className="fx-count">{c.count}</span>
            <ChangeBar add={c.add} del={c.del} max={maxChange * 2} />
          </div>,
        );
        if (!closed) out.push(...folderRows(c, depth + 1));
      });
    [...n.files].sort((a, b) => a.path.localeCompare(b.path)).forEach((f) => out.push(fileRow(f, depth, f.path.split('/').pop()!)));
    return out;
  };

  return (
    <div className="fx" onKeyDown={(e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ']' || (e.altKey && e.key === 'ArrowDown')) (e.preventDefault(), step(1));
      if (e.key === '[' || (e.altKey && e.key === 'ArrowUp')) (e.preventDefault(), step(-1));
    }}>
      <div className="fx-toolbar">
        <div className="seg">
          {(
            [
              ['tree', '🗂 Tree', 'Folders'],
              ['list', '☰ Path', 'Flat list with full paths'],
              ['stack', '▤ All diffs', 'Every file diff stacked (classic view)'],
            ] as [View, string, string][]
          ).map(([v, l, t]) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={t}>
              {l}
            </button>
          ))}
        </div>
        <div className="fx-chips">
          {(Object.keys(STATUS) as Status[])
            .filter((s) => counts.get(s))
            .map((s) => (
              <button key={s} className={`fx-chip ${s} ${only.has(s) ? 'on' : ''}`} onClick={() => toggleStatus(s)} title={`Show only ${STATUS[s].label.toLowerCase()} files`}>
                {STATUS[s].letter} {counts.get(s)}
              </button>
            ))}
          {only.size > 0 && (
            <button className="fx-chip clear" onClick={() => setOnly(new Set())}>
              ✕
            </button>
          )}
        </div>
        {view !== 'stack' && !dock && (
          <div className="seg" title="How a file's diff opens">
            <button className={openMode === 'focus' ? 'on' : ''} onClick={() => pickOpenMode('focus')} title="Open diffs in the focus view (button below, double-click or ⤢)">
              ⤢ Focus view
            </button>
            <button className={openMode === 'inline' ? 'on' : ''} onClick={() => pickOpenMode('inline')} title="Show the diff below the file list">
              ▭ Inline
            </button>
          </div>
        )}
        <label className={`fx-search ${search ? 'on' : ''}`} title="Search file names and changed lines">
          <span className="fx-search-ico">⌕</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && search && (e.stopPropagation(), setSearch(''))} placeholder="Search files & changes" spellCheck={false} />
          {search && (
            <button className="fx-search-x" onClick={() => setSearch('')} title="Clear">
              ✕
            </button>
          )}
        </label>
      </div>

      {view === 'stack' ? (
        <FileDiffList repoId={repoId} files={shown} diffs={diffs} atCommit={atCommit} search={search} />
      ) : (
        <>
          <div className="fx-list" ref={listRef} tabIndex={0}>
            {shown.length === 0 && <div className="empty small">No files match.</div>}
            {view === 'tree' ? folderRows(tree, 0) : shown.map((f) => fileRow(f, 0, f.path))}
          </div>
          {(dock || openMode === 'focus') && shown.length > 0 && (
            <button className="fx-focus-cta" onClick={() => setTheater(focused?.path ?? ordered[0]?.path ?? null)}>
              <span className="fx-focus-ico">⤢</span>
              <span>
                <strong>Open the changes in focus view</strong>
                <span className="small muted"> — big, readable diff with file rail{focused ? ` · starts at ${focused.path.split('/').pop()}` : ''}</span>
              </span>
            </button>
          )}
          {!dock && openMode === 'inline' && focused && (
            <div className="fx-diff">
              <div className="fx-diff-head">
                <span className={`fx-st ${focused.status}`}>{STATUS[focused.status].letter}</span>
                <span className="mono ellipsis grow" title={focused.path}>
                  {focused.oldPath ? `${focused.oldPath} → ` : ''}
                  {focused.path}
                </span>
                <span className="small muted">
                  {fi + 1}/{ordered.length}
                </span>
                <button className="btn sm ghost" onClick={() => step(-1)} title="Previous file ( [ )">
                  ↑
                </button>
                <button className="btn sm ghost" onClick={() => step(1)} title="Next file ( ] )">
                  ↓
                </button>
                <button className="btn sm ghost" title="Open in focus view" onClick={() => setTheater(focused.path)}>
                  ⤢
                </button>
                <button className="btn sm ghost" title="Copy file path" onClick={() => copy(focused.path, 'File path')}>
                  ⧉
                </button>
                {atCommit && focused.status !== 'deleted' && (
                  <button className="btn sm ghost" title="View the whole file at this commit (double-click a file)" onClick={() => openAt(focused)}>
                    👁
                  </button>
                )}
                <button className="btn sm ghost" title="Show the file in its folder" onClick={() => call('graph:reveal', { repoId, path: focused.path }).catch(showError)}>
                  📂
                </button>
              </div>
              {byPath.get(focused.path) ? <DiffViewer diff={byPath.get(focused.path)!} highlight={term} /> : <div className="empty small">No textual changes.</div>}
            </div>
          )}
        </>
      )}

      {dock &&
        docked &&
        focused &&
        createPortal(
          <div className="ws-diff">
            <div className="ws-diff-bar">
              <button className="btn sm ghost" onClick={() => setDocked(false)} title="Close the diff and show the graph (Esc)">
                ✕
              </button>
              <span className={`fx-st ${focused.status}`}>{STATUS[focused.status].letter}</span>
              <span className="mono ellipsis grow" title={focused.oldPath ? `${focused.oldPath} → ${focused.path}` : focused.path}>
                {focused.path.includes('/') && <span className="muted">{focused.path.slice(0, focused.path.lastIndexOf('/') + 1)}</span>}
                <strong>{focused.path.split('/').pop()}</strong>
                {focused.oldPath && <span className="muted"> ← {focused.oldPath}</span>}
              </span>
              {!focused.binary && (
                <span className="small mono">
                  <span className="text-ok">+{focused.additions}</span> <span className="text-danger">−{focused.deletions}</span>
                </span>
              )}
              <span className="small muted">
                {fi + 1}/{ordered.length}
              </span>
              <button className="btn sm ghost" onClick={() => step(-1)} title="Previous file ( [ )">
                ↑
              </button>
              <button className="btn sm ghost" onClick={() => step(1)} title="Next file ( ] )">
                ↓
              </button>
              <button className="btn sm ghost" title="Open in focus view" onClick={() => setTheater(focused.path)}>
                ⤢
              </button>
              <button className="btn sm ghost" title="Copy file path" onClick={() => copy(focused.path, 'File path')}>
                ⧉
              </button>
              {atCommit && focused.status !== 'deleted' && (
                <button className="btn sm ghost" title="View the whole file at this commit" onClick={() => openAt(focused)}>
                  👁
                </button>
              )}
            </div>
            <div className="ws-diff-body">{byPath.get(focused.path) ? <DiffViewer diff={byPath.get(focused.path)!} highlight={term} /> : <div className="empty">No textual changes for this file.</div>}</div>
          </div>,
          dockHost!,
        )}
      {theater && (
        <DiffTheater
          files={ordered.length ? ordered : shown}
          diffs={byPath}
          start={theater}
          context={context ?? (atCommit ? `Commit ${atCommit.slice(0, 7)}` : undefined)}
          highlight={term}
          onClose={() => setTheater(null)}
          onViewFile={atCommit ? (f) => void openAt(f) : undefined}
        />
      )}
      {viewing &&
        createPortal(
          <div className="over-theater">
        <Modal title={`${viewing.path} @ ${viewing.hash.slice(0, 8)}`} size="wide" onClose={() => setViewing(null)} footer={<button className="btn" onClick={() => setViewing(null)}>Close</button>}>
          {viewing.binary ? (
            <div className="empty">Binary file.</div>
          ) : (
            <pre className="file-view">
              {viewing.content.split('\n').map((l, i) => (
                <div key={i}>
                  <span className="ln-view">{i + 1}</span>
                  {l}
                </div>
              ))}
            </pre>
          )}
        </Modal>
          </div>,
          document.body,
        )}
    </div>
  );
}
