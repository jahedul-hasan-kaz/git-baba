/**
 * GitHub-style pull request search queries ("is:open author:octo label:\"good first issue\" fix").
 * Shared by the list UI (to keep tabs/dropdowns in sync with the text) and the main process
 * (to scope the query to one repository and to filter when search is unavailable).
 */

export interface QueryToken {
  /** Lower-case qualifier name, or null for a free-text word. */
  key: string | null;
  value: string;
  negated: boolean;
}

/** Splits a query into tokens, keeping quoted values together. */
export function tokenize(q: string): QueryToken[] {
  const out: QueryToken[] = [];
  const re = /(-?)(?:([A-Za-z-]+):)?("([^"]*)"?|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const [, neg, key, raw, quoted] = m;
    if (!key && !raw) continue;
    const value = quoted !== undefined ? quoted : raw;
    if (!key && raw.endsWith(':')) {
      // "author:" with nothing after it yet (still typing).
      out.push({ key: raw.slice(0, -1).toLowerCase(), value: '', negated: !!neg });
      continue;
    }
    out.push({ key: key ? key.toLowerCase() : null, value, negated: !!neg });
  }
  return out;
}

const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

export function stringify(tokens: QueryToken[]): string {
  return tokens.map((t) => `${t.negated ? '-' : ''}${t.key ? `${t.key}:` : ''}${t.key ? quote(t.value) : t.value}`).join(' ');
}

/** First value of a (non-negated) qualifier. */
export function getQualifier(q: string, key: string): string | null {
  return tokenize(q).find((t) => t.key === key && !t.negated)?.value ?? null;
}

/** Replaces every occurrence of a qualifier (null removes it). `match` limits which ones (e.g. only is:open/closed/merged). */
export function setQualifier(q: string, key: string, value: string | null, match?: (v: string) => boolean): string {
  const tokens = tokenize(q).filter((t) => !(t.key === key && !t.negated && (!match || match(t.value.toLowerCase()))));
  if (value !== null && value !== '') {
    // Keep qualifiers before free text, like GitHub does.
    const firstText = tokens.findIndex((t) => !t.key);
    const tok = { key, value, negated: false };
    if (firstText === -1) tokens.push(tok);
    else tokens.splice(firstText, 0, tok);
  }
  return stringify(tokens);
}

export const STATE_VALUES = ['open', 'closed', 'merged', 'unmerged'];

/** open | closed | merged | all, from is:/state: qualifiers. */
export function stateOf(q: string): 'open' | 'closed' | 'merged' | 'all' {
  const t = tokenize(q).filter((x) => !x.negated && (x.key === 'is' || x.key === 'state')).map((x) => x.value.toLowerCase());
  if (t.includes('merged')) return 'merged';
  if (t.includes('closed') || t.includes('unmerged')) return 'closed';
  if (t.includes('open')) return 'open';
  return 'all';
}

export function setState(q: string, s: 'open' | 'closed' | 'merged' | 'all'): string {
  let next = setQualifier(q, 'is', null, (v) => STATE_VALUES.includes(v));
  next = setQualifier(next, 'state', null);
  if (s === 'open') next = setQualifier(next, 'is', 'open');
  if (s === 'merged') next = setQualifier(next, 'is', 'merged');
  if (s === 'closed') next = setQualifier(next, 'is', 'closed');
  return ensurePr(next);
}

/** Every pull request query starts with is:pr, as on github.com. */
export function ensurePr(q: string): string {
  const tokens = tokenize(q);
  if (tokens.some((t) => t.key === 'is' && t.value.toLowerCase() === 'pr')) return stringify(tokens);
  return stringify([{ key: 'is', value: 'pr', negated: false }, ...tokens.filter((t) => !(t.key === 'is' && t.value.toLowerCase() === 'issue'))]);
}

/** Drops qualifiers that would widen the search beyond this repository. */
export function scopeToRepo(q: string): string {
  return stringify(tokenize(q).filter((t) => !t.key || !['repo', 'org', 'user', 'owner', 'type', 'in'].includes(t.key) || (t.key === 'in' && /^(title|body|comments)$/i.test(t.value))));
}

/** Qualifiers offered by the search box, with what they do. */
export const QUALIFIERS: { key: string; hint: string; values?: string[] }[] = [
  { key: 'is', hint: 'open, closed, merged, draft…', values: ['open', 'closed', 'merged', 'unmerged', 'draft', 'pr'] },
  { key: 'author', hint: 'who opened it (@me for you)' },
  { key: 'assignee', hint: 'assigned to (@me for you)' },
  { key: 'review-requested', hint: 'review requested from' },
  { key: 'reviewed-by', hint: 'reviewed by' },
  { key: 'review', hint: 'review status', values: ['none', 'required', 'approved', 'changes_requested'] },
  { key: 'label', hint: 'has label' },
  { key: 'milestone', hint: 'in milestone' },
  { key: 'base', hint: 'base (target) branch' },
  { key: 'head', hint: 'compare (source) branch' },
  { key: 'status', hint: 'checks status', values: ['success', 'failure', 'pending'] },
  { key: 'draft', hint: 'draft or not', values: ['true', 'false'] },
  { key: 'no', hint: 'missing field', values: ['label', 'assignee', 'milestone', 'reviewer'] },
  { key: 'mentions', hint: 'mentions a user' },
  { key: 'commenter', hint: 'commented by' },
  { key: 'involves', hint: 'author, assignee, commenter or mentioned' },
  { key: 'created', hint: 'date, e.g. >2026-01-01' },
  { key: 'updated', hint: 'date, e.g. <2026-06-01' },
  { key: 'closed', hint: 'date closed' },
  { key: 'merged', hint: 'date merged' },
  { key: 'comments', hint: 'number, e.g. >5' },
  { key: 'in', hint: 'where text matches', values: ['title', 'body', 'comments'] },
  { key: 'linked', hint: 'linked to an issue', values: ['issue'] },
  {
    key: 'sort',
    hint: 'order',
    values: ['created-desc', 'created-asc', 'updated-desc', 'updated-asc', 'comments-desc', 'comments-asc', 'reactions-+1-desc', 'interactions-desc'],
  },
];
