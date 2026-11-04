import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommitStatFile, FileDiff } from '../../../shared/types';
import { DiffViewer } from '../../components/DiffViewer';
import { fileIcon } from './CommitFilesExplorer';

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
  const [prefs, setPrefs] = useState<{ size: number; wrap: boolean }>(() => {
    try {
      return { size: 13, wrap: true, ...(JSON.parse(localStorage.getItem(PREF) ?? '{}') as object) };
    } catch {
      return { size: 13, wrap: true };
    }
  });
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
  const i = files.findIndex((f) => f.path === path);
  const file = files[i] ?? null;
  const diff = file ? diffs.get(file.path) ?? null : null;
  const max = useMemo(() => Math.max(1, ...files.map((f) => f.additions + f.deletions)), [files]);
  const totals = useMemo(() => files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }), [files]);

  const go = (d: number) => {
    if (!files.length) return;
    const n = files[(i + d + files.length) % files.length];
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

  return createPortal(
    <div className="dt" role="dialog" aria-modal="true">
      <header className="dt-head">
        <button className="btn sm ghost" onClick={onClose} title="Close (Esc)">
          ✕
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
            {i + 1}/{files.length}
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
          <div className="dt-rail-list" ref={rail}>
            {shown.map((f) => {
              const t = f.additions + f.deletions;
              return (
                <button key={f.path} data-p={f.path} className={`dt-file ${f.path === path ? 'on' : ''}`} onClick={() => setPath(f.path)} title={f.path}>
                  <span className={`fx-st ${f.status}`}>{STATUS_LETTER[f.status]}</span>
                  <span className="fx-ico">{fileIcon(f.path)}</span>
                  <span className="dt-file-text">
                    <span className="ellipsis">{f.path.split('/').pop()}</span>
                    {f.path.includes('/') && <span className="dt-file-dir ellipsis">{f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
                  </span>
                  <span className="dt-heat" title={`+${f.additions} −${f.deletions}`}>
                    <i className="a" style={{ width: `${(f.additions / max) * 100}%` }} />
                    <i className="d" style={{ width: `${(f.deletions / max) * 100}%` }} />
                  </span>
                  {t > 0 && <span className="dt-n">{t}</span>}
                </button>
              );
            })}
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
