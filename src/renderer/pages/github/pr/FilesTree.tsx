import { memo, useEffect, useMemo, useRef } from 'react';
import type { PrFile } from '../../../../shared/github';

interface Node {
  name: string;
  path: string;
  dirs: Map<string, Node>;
  files: PrFile[];
  adds: number;
  dels: number;
  count: number;
}

type Row =
  | { kind: 'dir'; key: string; label: string; depth: number; open: boolean; count: number; adds: number; dels: number }
  | { kind: 'file'; key: string; name: string; depth: number; file: PrFile };

const newNode = (name: string, path: string): Node => ({ name, path, dirs: new Map(), files: [], adds: 0, dels: 0, count: 0 });

function build(files: PrFile[]): Node {
  const root = newNode('', '');
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    node.adds += f.additions;
    node.dels += f.deletions;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = newNode(parts[i], parts.slice(0, i + 1).join('/'));
        node.dirs.set(parts[i], child);
      }
      node = child;
      node.adds += f.additions;
      node.dels += f.deletions;
      node.count++;
    }
    node.files.push(f);
  }
  return root;
}

function allDirPaths(n: Node, out: string[] = []): string[] {
  for (const d of n.dirs.values()) {
    out.push(d.path);
    allDirPaths(d, out);
  }
  return out;
}

/** Flat, depth-annotated rows. Chains of folders that only contain one folder are shown as "a/b/c". */
function flatten(root: Node, collapsed: Set<string>, forceOpen: boolean): Row[] {
  const rows: Row[] = [];
  const walk = (node: Node, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      let cur = d;
      let label = d.name;
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        cur = [...cur.dirs.values()][0];
        label += `/${cur.name}`;
      }
      const open = forceOpen || !collapsed.has(cur.path);
      rows.push({ kind: 'dir', key: cur.path, label, depth, open, count: cur.count, adds: cur.adds, dels: cur.dels });
      if (open) walk(cur, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', key: f.path, name: f.path.split('/').pop() ?? f.path, depth, file: f });
    }
  };
  walk(root, 0);
  return rows;
}

const STATUS: Record<string, [string, string, string]> = {
  added: ['A', 'added', 'Added'],
  removed: ['D', 'deleted', 'Deleted'],
  modified: ['M', 'modified', 'Modified'],
  renamed: ['R', 'renamed', 'Renamed'],
  copied: ['C', 'copied', 'Copied'],
  changed: ['M', 'modified', 'Changed'],
  unchanged: ['·', '', 'Unchanged'],
};

const Stats = memo(function Stats({ adds, dels }: { adds: number; dels: number }) {
  if (!adds && !dels) return null;
  return (
    <span className="ft-stats">
      {adds > 0 && <span className="add">+{adds}</span>}
      {dels > 0 && <span className="del">−{dels}</span>}
    </span>
  );
});

const FileRow = memo(function FileRow({ row, active, comments, onPick }: { row: Extract<Row, { kind: 'file' }>; active: boolean; comments: number; onPick: (p: string) => void }) {
  const f = row.file;
  const [letter, cls, label] = STATUS[f.status] ?? ['?', '', f.status];
  return (
    <div
      className={`ft-row file ${active ? 'active' : ''}`}
      style={{ paddingLeft: 10 + row.depth * 14 }}
      data-path={f.path}
      role="treeitem"
      aria-selected={active}
      tabIndex={0}
      title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
      onClick={() => onPick(f.path)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(f.path))}
    >
      <span className={`ft-kind kind ${cls}`} title={label}>
        {letter}
      </span>
      <span className="ft-name ellipsis">{row.name}</span>
      {comments > 0 && (
        <span className="ft-comments" title={`${comments} review thread(s)`}>
          💬{comments}
        </span>
      )}
      <Stats adds={f.additions} dels={f.deletions} />
    </div>
  );
});

const DirRow = memo(function DirRow({ row, onToggle }: { row: Extract<Row, { kind: 'dir' }>; onToggle: (p: string) => void }) {
  return (
    <div
      className="ft-row dir"
      style={{ paddingLeft: 6 + row.depth * 14 }}
      role="treeitem"
      aria-expanded={row.open}
      tabIndex={0}
      title={row.key}
      onClick={() => onToggle(row.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(row.key);
        }
      }}
    >
      <span className={`ft-caret ${row.open ? 'open' : ''}`}>▸</span>
      <span className="ft-name ellipsis">{row.label}</span>
      <span className="ft-count">{row.count}</span>
    </div>
  );
});

interface Props {
  files: PrFile[];
  filter: string;
  onFilter: (v: string) => void;
  collapsed: Set<string>;
  setCollapsed: (next: Set<string>) => void;
  active: string | null;
  threadCounts: Map<string, number>;
  truncated: boolean;
  onPick: (path: string) => void;
}

/**
 * The changed-files navigator of a pull request: compact folder chains, status badges, per-file and
 * per-folder change counts, review-thread markers, a "you are here" highlight that follows scrolling,
 * and expand / collapse all. Rows are memoised so large pull requests stay responsive.
 */
export function FilesTree({ files, filter, onFilter, collapsed, setCollapsed, active, threadCounts, truncated, onPick }: Props) {
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => (q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files), [files, q]);
  const root = useMemo(() => build(shown), [shown]);
  const rows = useMemo(() => flatten(root, collapsed, !!q), [root, collapsed, q]);
  const totals = useMemo(() => ({ adds: root.adds, dels: root.dels }), [root]);
  const listRef = useRef<HTMLDivElement>(null);

  const toggle = useMemo(
    () => (p: string) => {
      const n = new Set(collapsed);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      setCollapsed(n);
    },
    [collapsed, setCollapsed],
  );

  // Keep the highlighted file visible inside the tree (without scrolling the page).
  useEffect(() => {
    const box = listRef.current;
    if (!box || !active) return;
    const el = [...box.querySelectorAll<HTMLElement>('.ft-row.file')].find((x) => x.dataset.path === active);
    if (!el) return;
    const top = el.offsetTop; // .ft-list is the offset parent
    if (top < box.scrollTop + 4) box.scrollTop = Math.max(0, top - 40);
    else if (top + el.offsetHeight > box.scrollTop + box.clientHeight - 4) box.scrollTop = top - box.clientHeight + el.offsetHeight + 40;
  }, [active]);

  return (
    <div className="ft">
      <div className="ft-search">
        <input value={filter} onChange={(e) => onFilter(e.target.value)} placeholder="Filter changed files…" spellCheck={false} />
        {filter && (
          <button className="ft-clear" onClick={() => onFilter('')} aria-label="Clear filter">
            ×
          </button>
        )}
      </div>
      <div className="ft-summary">
        <span>
          <strong>{shown.length}</strong>
          {q ? ` of ${files.length}` : ''} file{shown.length === 1 ? '' : 's'}
        </span>
        <Stats adds={totals.adds} dels={totals.dels} />
        <span className="spacer" />
        {!q && (
          <>
            <button className="ft-ico" title="Expand all folders" onClick={() => setCollapsed(new Set())}>
              ⊞
            </button>
            <button className="ft-ico" title="Collapse all folders" onClick={() => setCollapsed(new Set(allDirPaths(build(files))))}>
              ⊟
            </button>
          </>
        )}
      </div>
      {truncated && <div className="small muted ft-note">GitHub lists at most 3000 files.</div>}
      <div className="ft-list" ref={listRef} role="tree">
        {rows.length === 0 && <div className="small muted" style={{ padding: 12 }}>No files match “{filter}”.</div>}
        {rows.map((r) =>
          r.kind === 'dir' ? <DirRow key={`d:${r.key}`} row={r} onToggle={toggle} /> : <FileRow key={`f:${r.key}`} row={r} active={active === r.file.path} comments={threadCounts.get(r.file.path) ?? 0} onPick={onPick} />,
        )}
      </div>
    </div>
  );
}
