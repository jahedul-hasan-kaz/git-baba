import { Fragment, useMemo, type ReactNode } from 'react';

/**
 * A small, safe Markdown renderer for README files. It builds React elements only — raw HTML in
 * the document is never injected (tags are stripped to their text), and links are handed to
 * `onLink` instead of navigating the app window.
 */
export function Markdown({ source, onLink }: { source: string; onLink: (href: string) => void }) {
  const blocks = useMemo(() => parseBlocks(source.replace(/\r\n?/g, '\n')), [source]);
  return <div className="markdown">{blocks.map((b, i) => renderBlock(b, i, onLink))}</div>;
}

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: { text: string; checked: boolean | null; children: Block[] }[] }
  | { t: 'table'; head: string[]; align: ('left' | 'center' | 'right' | null)[]; rows: string[][] }
  | { t: 'hr' };

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const splitRow = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

/** Text content of an HTML fragment (tags dropped; <img alt> and <br> kept as text). */
function stripHtml(s: string): string {
  return s
    .replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, (_, alt: string) => (alt ? `![${alt}]()` : ''))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => `[${text}](${href})`)
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;
  const isBlank = (l: string | undefined) => l === undefined || !l.trim();
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const close = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      out.push({ t: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    // Setext headings
    if (i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1]) && !LIST_RE.test(line) && !line.trim().startsWith('>')) {
      out.push({ t: 'h', level: lines[i + 1].trim().startsWith('=') ? 1 : 2, text: line.trim() });
      i += 2;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (/^\s*>/.test(lines[i]) || body.length)) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      out.push({ t: 'table', head, align, rows });
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      const indent = li[1].length;
      const ordered = /\d/.test(li[2]);
      const items: { text: string; checked: boolean | null; children: Block[] }[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m || m[1].length !== indent) break;
        const text: string[] = [m[3]];
        const nested: string[] = [];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          const sub = LIST_RE.exec(l);
          if (sub && sub[1].length === indent) break;
          if (isBlank(l)) {
            if (isBlank(lines[i + 1]) || !/^\s+/.test(lines[i + 1] ?? '')) break;
            i++;
            continue;
          }
          if (sub || (/^\s+/.test(l) && nested.length)) nested.push(l.slice(Math.min(indent + 2, l.length - l.trimStart().length)));
          else if (/^\s+/.test(l) || !/^\s*(#|>|```)/.test(l)) text.push(l.trim());
          else break;
          i++;
        }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text[0]);
        items.push({ text: task ? [task[2], ...text.slice(1)].join(' ') : text.join(' '), checked: task ? task[1] !== ' ' : null, children: nested.length ? parseBlocks(nested.join('\n')) : [] });
        if (isBlank(lines[i]) && LIST_RE.exec(lines[i + 1] ?? '')?.[1].length === indent) i++;
      }
      out.push({ t: 'list', ordered, start: ordered ? parseInt(li[2], 10) : 1, items });
      continue;
    }
    // HTML block: keep its text content only.
    if (/^\s*<\/?[A-Za-z]/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]);
      const text = stripHtml(body.join('\n')).trim();
      if (text) out.push({ t: 'p', text });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !(para.length && LIST_RE.test(lines[i]))) para.push(lines[i++]);
    out.push({ t: 'p', text: para.join('\n') });
  }
  return out;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function renderBlock(b: Block, key: number, onLink: (href: string) => void): ReactNode {
  switch (b.t) {
    case 'h': {
      const Tag = `h${Math.min(b.level, 6)}` as 'h1';
      return (
        <Tag key={key} id={`md-${slug(b.text)}`}>
          {inline(stripHtml(b.text), onLink)}
        </Tag>
      );
    }
    case 'p':
      return <p key={key}>{inline(stripHtml(b.text), onLink)}</p>;
    case 'code':
      return (
        <pre key={key} className="md-code" data-lang={b.lang || undefined}>
          <code>{b.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={key}>{b.blocks.map((x, i) => renderBlock(x, i, onLink))}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={{ textAlign: b.align[i] ?? undefined }}>
                    {inline(stripHtml(c), onLink)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {b.head.map((_, ci) => (
                    <td key={ci} style={{ textAlign: b.align[ci] ?? undefined }}>
                      {inline(stripHtml(r[ci] ?? ''), onLink)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list': {
      const items = b.items.map((it, i) => (
        <li key={i} className={it.checked !== null ? 'task' : undefined}>
          {it.checked !== null && <input type="checkbox" checked={it.checked} readOnly disabled />}
          {inline(stripHtml(it.text), onLink)}
          {it.children.map((c, ci) => renderBlock(c, ci, onLink))}
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
  }
}

const INLINE_RE =
  /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[((?:[^\]\\]|\\.|\[[^\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\8|(\*|_)(?=\S)([\s\S]+?)(?<=\S)\10(?![A-Za-z0-9])|~~(?=\S)([\s\S]+?)(?<=\S)~~|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\\([\\`*_{}[\]()#+\-.!|~])|( {2,}|\\)\n/;

function inline(text: string, onLink: (href: string) => void, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest) {
    const m = depth > 6 ? null : INLINE_RE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = k++;
    if (m[1]) out.push(<code key={key}>{m[2].trim()}</code>);
    else if (m[3] !== undefined && m[0].startsWith('!'))
      out.push(
        <span key={key} className="md-img" title={m[4] ? `Image: ${m[4]}` : 'Image'}>
          🖼 {m[3] || 'image'}
        </span>,
      );
    else if (m[6])
      out.push(
        <a key={key} onClick={() => onLink(m[6])} title={m[6]}>
          {inline(m[5], onLink, depth + 1)}
        </a>,
      );
    else if (m[7])
      out.push(
        <a key={key} onClick={() => onLink(m[7])}>
          {m[7]}
        </a>,
      );
    else if (m[8]) out.push(<strong key={key}>{inline(m[9], onLink, depth + 1)}</strong>);
    else if (m[10]) out.push(<em key={key}>{inline(m[11], onLink, depth + 1)}</em>);
    else if (m[12]) out.push(<del key={key}>{inline(m[12], onLink, depth + 1)}</del>);
    else if (m[13])
      out.push(
        <a key={key} onClick={() => onLink(m[13])}>
          {m[13]}
        </a>,
      );
    else if (m[14]) out.push(m[14]);
    else if (m[15]) out.push(<br key={key} />);
    else out.push(<Fragment key={key}>{m[0]}</Fragment>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
