import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommitStatFile, FileDiff } from '../../../shared/types';
import { DiffViewer } from '../../components/DiffViewer';
import { fileIcon } from './CommitFilesExplorer';

interface Folder {
  /** Full path of the folder ('' for the root). */
  path: string;
  /** Shown name; single-child folders are joined ("app/services/email"). */
  name: string;
  folders: Folder[];
  files: CommitStatFile[];
  add: number;
  del: number;
  count: number;
}

/** Folder tree of the changed files: folders first, then files, alphabetically; chains of single folders merged. */
function buildTree(files: CommitStatFile[]): Folder {
  const root: Folder = { path: '', name: '', folders: [], files: [], add: 0, del: 0, count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    node.add += f.additions;
    node.del += f.deletions;
    node.count++;
    for (let k = 0; k < parts.length - 1; k++) {
      const fp = parts.slice(0, k + 1).join('/');
      let next = node.folders.find((x) => x.path === fp);
      if (!next) {
        next = { path: fp, name: parts[k], folders: [], files: [], add: 0, del: 0, count: 0 };
        node.folders.push(next);
      }
      next.add += f.additions;
      next.del += f.deletions;
      next.count++;
      node = next;
    }
    node.files.push(f);
  }
  const tidy = (n: Folder): Folder => {
    n.folders = n.folders.map(tidy);
    // Merge a folder that only holds one folder: "app" › "services" → "app/services".
    while (n.path && n.files.length === 0 && n.folders.length === 1) {
      const c = n.folders[0];
      n = { ...c, name: `${n.name}/${c.name}` };
    }
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.path.localeCompare(b.path));
    return n;
  };
  return tidy(root);
}

/** Files in the order the tree shows them (so [ and ] walk the tree). */
function treeOrder(n: Folder): CommitStatFile[] {
  return [...n.folders.flatMap(treeOrder), ...n.files];
}

const STATUS_LETTER: Record<CommitStatFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T' };
const PREF = 'gb.diffTheater';

interface Props {
  files: CommitStatFile[];
  diffs: Map<string, FileDiff>;
  start: string;
  /** Shown in the header, e.g. "a1b2c3d · Fix login". */
  context?: string;
  highlight?: string;
  onClose: () => void;
  onViewFile?: (f: CommitStatFile) => void;
}

/**
 * Full-window diff workspace: a file rail with change bars, the diff large and readable, jumping
 * hunk by hunk, adjustable text size and wrapping, and keyboard control ([ ] files, n / p hunks, Esc).
 */
export function DiffTheater({ files, diffs, start, context, highlight, onClose, onViewFile }: Props) {
  const [path, setPath] = useState(start);
  const [q, setQ] = useState('');
  const [prefs, setPrefs] = useState<{ size: number; wrap: boolean; tree: boolean }>(() => {
    try {
      return { size: 13, wrap: true, tree: true, ...(JSON.parse(localStorage.getItem(PREF) ?? '{}') as object) };
    } catch {
      return { size: 13, wrap: true, tree: true };
    }
  });
  // Collapsed folders (all open by default).
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [hunk, setHunk] = useState(0);
  const main = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREF, JSON.stringify(prefs));
    } catch {
      /* per-viewer convenience */
    }
  }, [prefs]);

  const shown = useMemo(() => files.filter((f) => !q.trim() || f.path.toLowerCase().includes(q.trim().toLowerCase())), [files, q]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  const fullTree = useMemo(() => buildTree(files), [files]);
  // [ and ] follow what the rail shows: tree order in tree view, the original order in the list.
  const order = useMemo(() => (prefs.tree ? treeOrder(fullTree) : files), [prefs.tree, fullTree, files]);
  const i = order.findIndex((f) => f.path === path);
  const file = order[i] ?? null;
  const filtering = !!q.trim();
  const folderPaths = useMemo(() => {
    const out: string[] = [];
    const walk = (n: Folder) => n.folders.forEach((c) => (out.push(c.path), walk(c)));
    walk(fullTree);
    return out;
  }, [fullTree]);
  const toggle = (fp: string) => setClosed((c) => {
    const n = new Set(c);
    if (n.has(fp)) n.delete(fp);
    else n.add(fp);
    return n;
  });
  const diff = file ? diffs.get(file.path) ?? null : null;
  const max = useMemo(() => Math.max(1, ...files.map((f) => f.additions + f.deletions)), [files]);
  const totals = useMemo(() => files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }), [files]);

  const go = (d: number) => {
    if (!files.length) return;
    const n = order[(i + d + order.length) % order.length];
    setPath(n.path);
  };
  const hunks = () => Array.from(main.current?.querySelectorAll<HTMLElement>('tr.hunk') ?? []);
  const jumpHunk = (d: number) => {
    const list = hunks();
    if (!list.length) return;
    const next = Math.max(0, Math.min(list.length - 1, hunk + d));
    setHunk(next);
    list[next].scrollIntoView({ behavior: 'smooth', block: 'start' });
    list.forEach((el, k) => el.classList.toggle('dt-current', k === next));
  };

  useEffect(() => {
    setClosed((c) => {
      const open = [...c].filter((fp) => path.startsWith(`${fp}/`));
      if (!open.length) return c;
      const n = new Set(c);
      open.forEach((fp) => n.delete(fp));
      return n;
    });
  }, [path]);

  useEffect(() => {
    setHunk(0);
    main.current?.scrollTo({ top: 0 });
    rail.current?.querySelector(`[data-p="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [path]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // A window opened on top (e.g. the full file) handles its own keys first.
      if (document.querySelector('.over-theater')) return;
      const typing = (e.target as HTMLElement).tagName === 'INPUT';
      // The theater owns the keyboard while open: nothing reaches the page underneath.
      if (!typing) e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (typing) return;
      else if (e.key === ']' || (e.altKey && e.key === 'ArrowDown')) (e.preventDefault(), go(1));
      else if (e.key === '[' || (e.altKey && e.key === 'ArrowUp')) (e.preventDefault(), go(-1));
      else if (e.key === 'n') (e.preventDefault(), jumpHunk(1));
      else if (e.key === 'p') (e.preventDefault(), jumpHunk(-1));
      else if (e.key === '+' || e.key === '=') setPrefs((x) => ({ ...x, size: Math.min(18, x.size + 1) }));
      else if (e.key === '-') setPrefs((x) => ({ ...x, size: Math.max(10, x.size - 1) }));
      else if (e.key === 'w') setPrefs((x) => ({ ...x, wrap: !x.wrap }));
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  });

  const nHunks = diff?.hunks.length ?? 0;

  const fileRow = (f: CommitStatFile, depth: number, inTree: boolean) => {
    const t = f.additions + f.deletions;
    return (
      <button
        key={f.path}
        data-p={f.path}
        className={`dt-file ${f.path === path ? 'on' : ''} ${inTree ? 'in-tree' : ''}`}
        style={inTree ? { paddingLeft: 8 + depth * 14 } : undefined}
        onClick={() => setPath(f.path)}
        title={f.oldPath ? `${f.path}\n← ${f.oldPath}` : f.path}
      >
        <span className={`fx-st ${f.status}`}>{STATUS_LETTER[f.status]}</span>
        <span className="fx-ico">{fileIcon(f.path)}</span>
        <span className="dt-file-text">
          <span className="ellipsis">{f.path.split('/').pop()}</span>
          {!inTree && f.path.includes('/') && <span className="dt-file-dir ellipsis">{f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
        </span>
        <span className="dt-heat" title={`+${f.additions} −${f.deletions}`}>
          <i className="a" style={{ width: `${(f.additions / max) * 100}%` }} />
          <i className="d" style={{ width: `${(f.deletions / max) * 100}%` }} />
        </span>
        {t > 0 && <span className="dt-n">{t}</span>}
      </button>
    );
  };

  const renderFolder = (n: Folder, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const c of n.folders) {
      // While filtering, every matching folder stays open.
      const isOpen = filtering || !closed.has(c.path);
      const here = path.startsWith(`${c.path}/`);
      out.push(
        <button
          key={`d:${c.path}`}
          className={`dt-folder ${isOpen ? 'open' : ''} ${here ? 'here' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => toggle(c.path)}
          title={`${c.path} — ${c.count} file${c.count === 1 ? '' : 's'}`}
          aria-expanded={isOpen}
        >
          <span className="dt-caret" aria-hidden>
            ›
          </span>
          <span className="dt-folder-ico" aria-hidden>
            {isOpen ? '📂' : '📁'}
          </span>
          <span className="ellipsis grow">{c.name}</span>
          {!isOpen && (
            <span className="dt-folder-delta">
              <span className="text-ok">+{c.add}</span> <span className="text-danger">−{c.del}</span>
            </span>
          )}
          <span className="dt-folder-n">{c.count}</span>
        </button>,
      );
      if (isOpen) out.push(<div key={`g:${c.path}`} className="dt-group-kids" style={{ ['--dt-guide' as string]: `${13 + depth * 14}px` }}>{renderFolder(c, depth + 1)}</div>);
    }
    for (const f of n.files) out.push(fileRow(f, depth, true));
    return out;
  };

  return createPortal(
    <div className="dt" role="dialog" aria-modal="true">
      <header className="dt-head">
        <button className="dt-back" onClick={onClose} title="Back (Esc)">
          <span aria-hidden>←</span> Back
        </button>
        <div className="dt-title">
          {context && <div className="small muted ellipsis">{context}</div>}
          <div className="dt-path">
            {file ? (
              <>
                <span className={`fx-st ${file.status}`}>{STATUS_LETTER[file.status]}</span>
                {file.path.includes('/') && <span className="dt-dir">{file.path.slice(0, file.path.lastIndexOf('/') + 1)}</span>}
                <strong>{file.path.split('/').pop()}</strong>
                {file.oldPath && <span className="dt-dir"> ← {file.oldPath}</span>}
              </>
            ) : (
              'No file'
            )}
          </div>
        </div>
        {file && (
          <span className="dt-stat">
            <span className="text-ok">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
          </span>
        )}
        <div className="dt-group" title="Files ( [ and ] )">
          <button onClick={() => go(-1)}>‹</button>
          <span>
            {i + 1}/{order.length}
          </span>
          <button onClick={() => go(1)}>›</button>
        </div>
        <div className="dt-group" title="Changes in this file ( p and n )">
          <button onClick={() => jumpHunk(-1)} disabled={!nHunks}>
            ▲
          </button>
          <span>
            {nHunks ? Math.min(hunk + 1, nHunks) : 0}/{nHunks} hunks
          </span>
          <button onClick={() => jumpHunk(1)} disabled={!nHunks}>
            ▼
          </button>
        </div>
        <div className="dt-group" title="Text size ( - and + )">
          <button onClick={() => setPrefs((x) => ({ ...x, size: Math.max(10, x.size - 1) }))}>A−</button>
          <button onClick={() => setPrefs((x) => ({ ...x, size: Math.min(18, x.size + 1) }))}>A+</button>
        </div>
        <button className={`dt-toggle ${prefs.wrap ? 'on' : ''}`} onClick={() => setPrefs((x) => ({ ...x, wrap: !x.wrap }))} title="Wrap long lines ( w )">
          ↩ Wrap
        </button>
        {file && onViewFile && file.status !== 'deleted' && (
          <button className="btn sm" onClick={() => onViewFile(file)} title="Whole file at this commit">
            👁 Full file
          </button>
        )}
      </header>

      <div className="dt-body">
        <aside className="dt-rail">
          <div className="dt-rail-head">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${files.length} files…`} spellCheck={false} />
            <div className="small muted">
              {files.length} files · <span className="text-ok">+{totals.add}</span> <span className="text-danger">−{totals.del}</span>
            </div>
          </div>
          <div className="dt-rail-tools">
            <div className="dt-seg" role="radiogroup" aria-label="File view">
              <button role="radio" aria-checked={prefs.tree} className={prefs.tree ? 'on' : ''} onClick={() => setPrefs((x) => ({ ...x, tree: true }))} title="Folders">
                ▤ Tree
              </button>
              <button role="radio" aria-checked={!prefs.tree} className={!prefs.tree ? 'on' : ''} onClick={() => setPrefs((x) => ({ ...x, tree: false }))} title="Flat list">
                ☰ List
              </button>
            </div>
            {prefs.tree && folderPaths.length > 0 && (
              <>
                <span className="spacer" />
                <button className="dt-mini" onClick={() => setClosed(new Set())} title="Expand all folders">
                  ⊞
                </button>
                <button className="dt-mini" onClick={() => setClosed(new Set(folderPaths))} title="Collapse all folders">
                  ⊟
                </button>
              </>
            )}
          </div>
          <div className="dt-rail-list" ref={rail}>
            {shown.length === 0 && <div className="small muted dt-none">No file matches “{q}”.</div>}
            {prefs.tree ? renderFolder(tree, 0) : shown.map((f) => fileRow(f, 0, false))}
          </div>
        </aside>
        <main className={`dt-main ${prefs.wrap ? '' : 'nowrap'}`} ref={main} style={{ ['--dt-fs' as string]: `${prefs.size}px` }}>
          {diff ? <DiffViewer key={path} diff={diff} highlight={highlight} /> : <div className="empty">No textual changes for this file.</div>}
        </main>
      </div>
      <footer className="dt-foot small muted">
        <kbd>[</kbd>
        <kbd>]</kbd> file · <kbd>p</kbd>
        <kbd>n</kbd> hunk · <kbd>−</kbd>
        <kbd>+</kbd> size · <kbd>w</kbd> wrap · <kbd>Esc</kbd> close
      </footer>
    </div>,
    document.body,
  );
}
