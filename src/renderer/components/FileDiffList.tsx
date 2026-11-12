import { useEffect, useMemo, useState } from 'react';
import type { CommitStatFile, FileAtCommit, FileDiff } from '../../shared/types';
import { call } from '../services/api';
import { useApp } from '../state/AppState';
import { DiffViewer } from './DiffViewer';
import { Modal } from './Modal';

export function relative(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 172800) return 'yesterday';
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_LETTER: Record<CommitStatFile['status'], string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C', typechange: 'T' };

/** Expandable per-file diffs with search, copy path, view-at-commit and reveal. */
export function FileDiffList({ repoId, files, diffs, atCommit, search }: { repoId: string; files: CommitStatFile[]; diffs: FileDiff[]; atCommit: string | null; search: string }) {
  const { toast, showError } = useApp();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<FileAtCommit | null>(null);
  const byPath = useMemo(() => new Map(diffs.map((d) => [d.status === 'deleted' ? d.oldPath : d.newPath, d])), [diffs]);
  const term = search.trim().toLowerCase();
  const matches = (d: FileDiff | undefined) => !term || (d?.hunks.some((h) => h.lines.some((l) => l.content.toLowerCase().includes(term))) ?? false);
  const shown = files.filter((f) => matches(byPath.get(f.path)) || (term && f.path.toLowerCase().includes(term)));

  useEffect(() => {
    // Expand everything that matches a search; otherwise expand the first few files.
    setOpen(new Set(term ? shown.map((f) => f.path) : files.slice(0, 3).map((f) => f.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, term]);

  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const copy = async (text: string, what: string) => {
    try {
      await call('app:copyText', { text });
      toast(`${what} copied`);
    } catch (err) {
      showError(err);
    }
  };

  return (
    <div>
      <div className="row mb small muted">
        <span className="grow">
          {shown.length} of {files.length} file(s){term ? ` containing “${search}”` : ''}
        </span>
        <button className="btn sm ghost" onClick={() => setOpen(new Set(shown.map((f) => f.path)))}>
          Expand all
        </button>
        <button className="btn sm ghost" onClick={() => setOpen(new Set())}>
          Collapse all
        </button>
      </div>
      {shown.map((f) => {
        const d = byPath.get(f.path);
        const isOpen = open.has(f.path);
        return (
          <div key={f.path} className="file-card">
            <div className="file-card-header" onClick={() => toggle(f.path)}>
              <span className="muted">{isOpen ? '▾' : '▸'}</span>
              <span className={`kind ${f.status}`}>{STATUS_LETTER[f.status]}</span>
              <span className="mono grow ellipsis" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                {f.oldPath ? `${f.oldPath} → ` : ''}
                {f.path}
              </span>
              {f.binary ? <span className="badge">binary</span> : <><span className="badge ok">+{f.additions}</span><span className="badge danger">−{f.deletions}</span></>}
              <span className="row" onClick={(e) => e.stopPropagation()}>
                <button className="btn sm ghost" title="Copy file path" onClick={() => copy(f.path, 'File path')}>
                  ⧉
                </button>
                {atCommit && f.status !== 'deleted' && (
                  <button
                    className="btn sm ghost"
                    title="View file at this commit"
                    onClick={() =>
                      call('graph:fileAt', { repoId, hash: atCommit, path: f.path })
                        .then(setViewing)
                        .catch(showError)
                    }
                  >
                    👁
                  </button>
                )}
                <button className="btn sm ghost" title="Show the file in its folder (does not open or run it)" onClick={() => call('graph:reveal', { repoId, path: f.path }).catch(showError)}>
                  📂
                </button>
              </span>
            </div>
            {isOpen && <div className="file-card-body">{d ? <DiffViewer diff={d} highlight={term} /> : <div className="empty small">No textual changes.</div>}</div>}
          </div>
        );
      })}
      {viewing && (
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
          {viewing.truncated && <div className="banner warn small">Only the first 1 MB is shown.</div>}
        </Modal>
      )}
    </div>
  );
}
