/**
 * A small, dependency-free syntax colouring for the code viewer: keywords, strings, comments, numbers,
 * function calls, types and decorators — enough to read code comfortably, IDE style. Not a parser:
 * it works line by line and only carries block comments / triple-quoted strings across lines.
 */

export type TokKind = 'kw' | 'str' | 'com' | 'num' | 'fn' | 'type' | 'deco' | 'const' | 'tag' | 'attr' | 'punc' | 'plain';
export interface Tok {
  k: TokKind;
  t: string;
}

interface Lang {
  name: string;
  line?: string[];
  block?: [string, string];
  /** Triple-quoted strings (Python). */
  triple?: boolean;
  keywords: Set<string>;
  consts?: Set<string>;
  markup?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE = words(
  'abstract as async await break case catch class const continue default delete do else enum export extends final finally for from function get if implements import in instanceof interface is let new of override package private protected public readonly return set static super switch this throw try type typeof var void while with yield namespace using struct fn impl mod pub use match mut ref where trait loop crate self Self func go defer select chan map range fallthrough val fun when object companion data sealed inline internal lateinit operator suspend virtual sealed partial record init required event delegate unsafe fixed lock sizeof checked unchecked goto out params base foreach implicit explicit extern volatile',
);
const C_CONSTS = words('true false null undefined nil None NaN Infinity');

const LANGS: Record<string, Lang> = {
  py: { name: 'Python', line: ['#'], triple: true, keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print self cls'), consts: words('True False None') },
  js: { name: 'JavaScript', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  ts: { name: 'TypeScript', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  cs: { name: 'C#', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  java: { name: 'Java', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  kt: { name: 'Kotlin', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  go: { name: 'Go', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  rs: { name: 'Rust', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  c: { name: 'C/C++', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  swift: { name: 'Swift', line: ['//'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  php: { name: 'PHP', line: ['//', '#'], block: ['/*', '*/'], keywords: C_LIKE, consts: C_CONSTS },
  css: { name: 'CSS', block: ['/*', '*/'], keywords: words('important media import supports keyframes font-face root'), consts: C_CONSTS },
  sh: { name: 'Shell', line: ['#'], keywords: words('if then else elif fi for while do done case esac in function return export local echo exit set unset source alias'), consts: words('true false') },
  yml: { name: 'YAML', line: ['#'], keywords: words(''), consts: words('true false null yes no on off') },
  toml: { name: 'TOML', line: ['#'], keywords: words(''), consts: words('true false') },
  sql: { name: 'SQL', line: ['--'], block: ['/*', '*/'], keywords: words('select from where and or not insert into values update set delete create table alter drop index primary key foreign references join left right inner outer on group by order having limit offset as distinct union all case when then else end begin commit rollback returns return function language declare if exists default null is in like between view trigger schema grant'), consts: words('true false null') },
  rb: { name: 'Ruby', line: ['#'], keywords: words('def end class module if elsif else unless while until for in do return yield begin rescue ensure raise require include extend self nil and or not then case when attr_accessor'), consts: words('true false nil') },
  json: { name: 'JSON', keywords: words(''), consts: words('true false null') },
  html: { name: 'HTML', block: ['<!--', '-->'], keywords: words(''), markup: true },
  md: { name: 'Markdown', keywords: words('') },
  txt: { name: 'Plain text', keywords: words('') },
};

const EXT: Record<string, string> = {
  py: 'py', pyi: 'py', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', cs: 'cs', java: 'java', kt: 'kt', kts: 'kt', go: 'go', rs: 'rs',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', swift: 'swift', php: 'php', css: 'css', scss: 'css', less: 'css', sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh',
  yml: 'yml', yaml: 'yml', toml: 'toml', ini: 'toml', cfg: 'toml', env: 'sh', sql: 'sql', rb: 'rb', json: 'json', jsonc: 'js', html: 'html', htm: 'html', xml: 'html', svg: 'html',
  vue: 'html', md: 'md', markdown: 'md', txt: 'txt', dockerfile: 'sh', gradle: 'kt', csproj: 'html', sln: 'txt', props: 'html',
};

export function langFor(path: string): { key: string; name: string } {
  const base = path.split('/').pop()!.toLowerCase();
  const ext = base === 'dockerfile' ? 'dockerfile' : base === 'makefile' ? 'sh' : (base.includes('.') ? base.split('.').pop()! : '');
  const key = EXT[ext] ?? 'txt';
  return { key, name: LANGS[key].name };
}

const NUM = /^(0x[\da-f_]+|\d[\d_]*(\.\d[\d_]*)?(e[+-]?\d+)?[a-z]*)/i;
const IDENT = /^[A-Za-z_$][\w$]*/;

/** Tokenises a whole file; returns tokens per line. */
export function tokenize(lines: string[], langKey: string): Tok[][] {
  const L = LANGS[langKey] ?? LANGS.txt;
  if (langKey === 'txt' || langKey === 'md') return lines.map((l) => [{ k: 'plain', t: l }]);
  const out: Tok[][] = [];
  let open: null | { end: string; k: TokKind } = null; // carried block comment / triple string

  for (const line of lines) {
    const toks: Tok[] = [];
    const push = (k: TokKind, t: string) => {
      if (!t) return;
      const last = toks[toks.length - 1];
      if (last && last.k === k) last.t += t;
      else toks.push({ k, t });
    };
    let i = 0;
    if (open) {
      const at = line.indexOf(open.end);
      if (at === -1) {
        push(open.k, line);
        out.push(toks);
        continue;
      }
      push(open.k, line.slice(0, at + open.end.length));
      i = at + open.end.length;
      open = null;
    }
    while (i < line.length) {
      const rest = line.slice(i);
      const ch = line[i];
      // comments
      if (L.line?.some((c) => rest.startsWith(c)) && !(langKey === 'sh' && ch === '#' && i > 0 && /[\w$]/.test(line[i - 1]))) {
        push('com', rest);
        break;
      }
      if (L.block && rest.startsWith(L.block[0])) {
        const end = rest.indexOf(L.block[1], L.block[0].length);
        if (end === -1) {
          push('com', rest);
          open = { end: L.block[1], k: 'com' };
          break;
        }
        push('com', rest.slice(0, end + L.block[1].length));
        i += end + L.block[1].length;
        continue;
      }
      // strings
      if (L.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
        const q = rest.slice(0, 3);
        const end = rest.indexOf(q, 3);
        if (end === -1) {
          push('str', rest);
          open = { end: q, k: 'str' };
          break;
        }
        push('str', rest.slice(0, end + 3));
        i += end + 3;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
        const s = line.slice(i, Math.min(line.length, j + 1));
        // JSON / YAML keys read as attributes.
        const isKey = (langKey === 'json' || langKey === 'yml') && /^\s*:/.test(line.slice(j + 1));
        push(isKey ? 'attr' : 'str', s);
        i += s.length;
        continue;
      }
      if (L.markup && ch === '<') {
        const m = /^<\/?[\w:-]+/.exec(rest);
        if (m) {
          push('tag', m[0]);
          i += m[0].length;
          continue;
        }
      }
      // decorators / annotations
      if (ch === '@' && /[A-Za-z_]/.test(line[i + 1] ?? '')) {
        const m = /^@[\w.]+/.exec(rest)!;
        push('deco', m[0]);
        i += m[0].length;
        continue;
      }
      // numbers
      if (/\d/.test(ch) && !/[\w$]/.test(line[i - 1] ?? '')) {
        const m = NUM.exec(rest);
        if (m) {
          push('num', m[0]);
          i += m[0].length;
          continue;
        }
      }
      // identifiers
      const id = IDENT.exec(rest);
      if (id) {
        const w = id[0];
        const after = line.slice(i + w.length);
        const lw = langKey === 'sql' ? w.toLowerCase() : w;
        let k: TokKind = 'plain';
        if (L.keywords.has(lw)) k = 'kw';
        else if (L.consts?.has(w)) k = 'const';
        else if (L.markup && /^\s*=/.test(after)) k = 'attr';
        else if (/^\s*\(/.test(after)) k = 'fn';
        else if (langKey === 'yml' && /^\s*:/.test(after) && !toks.some((t) => t.k !== 'plain' || t.t.trim())) k = 'attr';
        else if (/^[A-Z][a-z0-9]+[A-Za-z0-9]*$/.test(w) && langKey !== 'sql') k = 'type';
        else if (/^[A-Z][A-Z0-9_]{2,}$/.test(w)) k = 'const';
        push(k, w);
        i += w.length;
        continue;
      }
      push(/[{}()[\];,.:]/.test(ch) ? 'punc' : 'plain', ch);
      i++;
    }
    out.push(toks);
  }
  return out;
}
