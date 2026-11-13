import { useMemo, useState, type ReactNode } from 'react';
import type { DiffHunk, DiffLine, FileDiff } from '../../shared/types';

const RENDER_LIMIT = 3000;

function statusLabel(d: FileDiff): string {
  switch (d.status) {
    case 'renamed':
      return `Renamed from ${d.oldPath}${d.similarity !== undefined ? ` (${d.similarity}% similar)` : ''}`;
    case 'copied':
      return `Copied from ${d.oldPath}`;
    case 'added':
      return 'New file';
    case 'deleted':
      return 'Deleted file';
    default:
      return 'Modified';
  }
}

interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/** Pairs deletions with additions so both sides line up in split view. */
function toSplitRows(h: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const l of h.lines) {
    if (l.type === 'del') dels.push(l);
    else if (l.type === 'add') adds.push(l);
    else {
      flush();
      rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

/** Wraps case-insensitive matches of `term` in <mark>. */
function highlightText(text: string, term?: string): ReactNode {
  if (!term) return text || ' ';
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (let at = lower.indexOf(t); at !== -1; at = lower.indexOf(t, i)) {
    if (at > i) out.push(text.slice(i, at));
    out.push(<mark key={k++}>{text.slice(at, at + t.length)}</mark>);
    i = at + t.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out.length ? out : text || ' ';
}

export function DiffViewer({ diff, emptyText = 'Select a file to see its changes.', highlight, hideHeader, forceMode }: { diff: FileDiff | null; emptyText?: string; highlight?: string; hideHeader?: boolean; /** Controlled layout (the caller shows its own toggle). */ forceMode?: 'unified' | 'split' }) {
  const [ownMode, setMode] = useState<'unified' | 'split'>('unified');
  const mode = forceMode ?? ownMode;
  const [showAll, setShowAll] = useState(false);
  const totalLines = useMemo(() => diff?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0, [diff]);

  if (!diff) return <div className="empty">{emptyText}</div>;
  const path = diff.status === 'deleted' ? diff.oldPath : diff.newPath;
  const modeChange = diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode ? `Mode ${diff.oldMode} → ${diff.newMode}` : null;
  let budget = showAll ? Infinity : RENDER_LIMIT;

  return (
    <div>
      <div className="diff-header" style={hideHeader ? { display: 'none' } : undefined}>
        <strong className="ellipsis grow mono">{path}</strong>
        <span className="muted small">{statusLabel(diff)}</span>
        {modeChange && <span className="badge warn">{modeChange}</span>}
        <span className="badge ok">+{diff.additions}</span>
        <span className="badge danger">−{diff.deletions}</span>
        <div className="row">
          <button className={`btn sm ${mode === 'unified' ? 'primary' : ''}`} onClick={() => setMode('unified')}>
            Unified
          </button>
          <button className={`btn sm ${mode === 'split' ? 'primary' : ''}`} onClick={() => setMode('split')}>
            Side-by-side
          </button>
        </div>
      </div>
      {diff.binary && <div className="empty">Binary file — contents cannot be shown as text.</div>}
      {!diff.binary && diff.hunks.length === 0 && <div className="empty">{diff.truncated ? 'File is too large to display.' : modeChange ? 'Only the file mode changed.' : 'No content changes.'}</div>}
      {diff.truncated && diff.hunks.length > 0 && <div className="banner warn" style={{ margin: 10 }}>This diff is very large and was truncated.</div>}
      <table className="diff">
        {mode === 'split' ? (
          <colgroup>
            <col style={{ width: 52 }} />
            <col />
            <col style={{ width: 52 }} />
            <col />
          </colgroup>
        ) : (
          <colgroup>
            <col style={{ width: 52 }} />
            <col style={{ width: 52 }} />
            <col style={{ width: 18 }} />
            <col />
          </colgroup>
        )}
        <tbody>
          {diff.hunks.map((h, hi) => {
            if (budget <= 0) return null;
            const header = (
              <tr className="hunk" key={`h${hi}`}>
                <td colSpan={mode === 'split' ? 4 : 4}>{h.header}</td>
              </tr>
            );
            if (mode === 'unified') {
              const lines = h.lines.slice(0, Math.max(0, budget));
              budget -= lines.length;
              return [
                header,
                ...lines.map((l, li) => (
                  <tr key={`${hi}-${li}`} className={l.type}>
                    <td className="ln">{l.oldLine ?? ''}</td>
                    <td className="ln">{l.newLine ?? ''}</td>
                    <td className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
                    <td>{highlightText(l.content, highlight)}</td>
                  </tr>
                )),
              ];
            }
            const rows = toSplitRows(h).slice(0, Math.max(0, budget));
            budget -= rows.length;
            return [
              header,
              ...rows.map((r, ri) => {
                const lt = r.left?.type === 'del' ? 'del' : r.left ? '' : 'empty';
                const rt = r.right?.type === 'add' ? 'add' : r.right ? '' : 'empty';
                return (
                  <tr key={`${hi}-s${ri}`} className={r.left?.type === 'meta' ? 'meta' : ''}>
                    <td className={`ln ${lt}`}>{r.left?.oldLine ?? ''}</td>
                    <td className={`half ${lt}`}>{r.left ? highlightText(r.left.content, highlight) : ''}</td>
                    <td className={`ln ${rt}`}>{r.right?.newLine ?? ''}</td>
                    <td className={`half ${rt}`}>{r.right ? highlightText(r.right.content, highlight) : ''}</td>
                  </tr>
                );
              }),
            ];
          })}
        </tbody>
      </table>
      {!showAll && totalLines > RENDER_LIMIT && (
        <div className="empty">
          Showing the first {RENDER_LIMIT} of {totalLines} lines.{' '}
          <button className="btn sm" onClick={() => setShowAll(true)}>
            Show all
          </button>
        </div>
      )}
    </div>
  );
}
