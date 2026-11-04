import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileAtCommit } from '../../../shared/types';
import { Markdown } from '../../components/Markdown';

export const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function highlight(line: string, term: string): ReactNode {
  if (!term) return line || ' ';
  const lower = line.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, at)) {
    out.push(line.slice(at, i), <mark key={i}>{line.slice(i, i + term.length)}</mark>);
    at = i + term.length;
  }
  out.push(line.slice(at));
  return out;
}

/** Read-only file view: line numbers (click to highlight), search highlighting and Markdown preview. */
export function FileView({ file, line, term, onLink, toolbar }: { file: FileAtCommit; line: number | null; term: string; onLink: (href: string) => void; toolbar: ReactNode }) {
  const md = isMarkdown(file.path);
  const [mode, setMode] = useState<'preview' | 'code'>(md ? 'preview' : 'code');
  const [active, setActive] = useState<number | null>(line);
  const body = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const l = file.content.replace(/\r\n/g, '\n').split('\n');
    if (l.length > 1 && l[l.length - 1] === '') l.pop();
    return l;
  }, [file.content]);

  useEffect(() => {
    setMode(md && !line ? 'preview' : 'code');
    setActive(line);
  }, [file.path, file.hash, line, md]);

  useEffect(() => {
    if (mode !== 'code' || !active) return;
    body.current?.querySelector(`[data-ln="${active}"]`)?.scrollIntoView({ block: 'center' });
  }, [mode, active, file.path]);

  const t = term.trim().toLowerCase();

  return (
    <div className="file-panel fade-in">
      <div className="file-panel-head">
        {md && (
          <div className="segmented">
            <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
              Preview
            </button>
            <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>
              Code
            </button>
          </div>
        )}
        <span className="small muted">
          {file.binary ? 'binary file' : `${lines.length} line${lines.length === 1 ? '' : 's'} · ${formatBytes(new Blob([file.content]).size)}`}
          {file.truncated ? ' · first 1 MB shown' : ''}
        </span>
        <span className="spacer" />
        {toolbar}
      </div>
      {file.binary ? (
        <div className="empty">This is a binary file and cannot be displayed.</div>
      ) : mode === 'preview' ? (
        <div className="file-panel-md">
          <Markdown source={file.content} onLink={onLink} />
        </div>
      ) : (
        <div className="code-lines" ref={body}>
          <table>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} data-ln={i + 1} className={active === i + 1 ? 'active' : t && l.toLowerCase().includes(t) ? 'hit' : undefined}>
                  <td className="ln" onClick={() => setActive(active === i + 1 ? null : i + 1)}>
                    {i + 1}
                  </td>
                  <td className="lc">{highlight(l, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Plain-text editor with a line-number gutter, Tab indentation and Ctrl+S to save. */
export function CodeEditor({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const count = value.split('\n').length;

  useEffect(() => {
    area.current?.focus();
    area.current?.setSelectionRange(0, 0);
  }, []);

  return (
    <div className="editor">
      <div className="editor-gutter" ref={gutter} aria-hidden>
        {Array.from({ length: count }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={area}
        className="editor-area"
        value={value}
        spellCheck={false}
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            onSave();
            return;
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: end } = el;
            const next = `${value.slice(0, s)}  ${value.slice(end)}`;
            onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
        }}
      />
    </div>
  );
}
