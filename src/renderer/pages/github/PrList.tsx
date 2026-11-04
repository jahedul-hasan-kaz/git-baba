import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GhRepoContext, PrListItem, PrListSource, RepoMetadata } from '../../../shared/github';
import { getQualifier, QUALIFIERS, setQualifier, setState, stateOf, tokenize } from '../../../shared/prQuery';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Avatar, LabelChip, relTime, Skeleton, useGh } from '../../components/github/common';
import { call } from '../../services/api';

const DEFAULT_QUERY = 'is:pr is:open';

const SORTS: [string, string][] = [
  ['created-desc', 'Newest'],
  ['created-asc', 'Oldest'],
  ['updated-desc', 'Recently updated'],
  ['updated-asc', 'Least recently updated'],
  ['comments-desc', 'Most commented'],
  ['comments-asc', 'Least commented'],
  ['reactions-+1-desc', 'Most 👍 reactions'],
];

const REVIEW_STATUS: [string, string, string][] = [
  ['review:none', 'No reviews', '○'],
  ['review:required', 'Review required', '●'],
  ['review:approved', 'Approved', '✓'],
  ['review:changes_requested', 'Changes requested', '✕'],
];

/** One-click filters, each a qualifier that toggles in the query. */
const QUICK: { label: string; key: string; value: string }[] = [
  { label: '👤 Mine', key: 'author', value: '@me' },
  { label: '👀 Needs my review', key: 'review-requested', value: '@me' },
  { label: '✓ Approved', key: 'review', value: 'approved' },
  { label: '✕ Failing checks', key: 'status', value: 'failure' },
  { label: '✎ Drafts', key: 'draft', value: 'true' },
];

type Density = 'comfortable' | 'compact';
function readDensity(): Density {
  try {
    return localStorage.getItem('gg-pr-density') === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

interface Props {
  repoId: string;
  ctx: GhRepoContext;
  metadata: RepoMetadata | null;
  onOpen: (n: number) => void;
  onCreate: () => void;
}

export function PrList({ repoId, ctx, metadata, onOpen, onCreate }: Props) {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [input, setInput] = useState(`${DEFAULT_QUERY} `);
  const [density, setDensity] = useState<Density>(readDensity);
  const [extra, setExtra] = useState<PrListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  // People seen in results, so bots like dependabot can be picked as authors too.
  const [seen, setSeen] = useState<Map<string, boolean>>(new Map());

  const apply = (q: string) => {
    const clean = q.replace(/\s+/g, ' ').trim() || DEFAULT_QUERY;
    setQuery(clean);
    setInput(`${clean} `);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      const clean = input.replace(/\s+/g, ' ').trim();
      if (clean && clean !== query && !/(^|\s)-?[a-z-]+:$/i.test(clean)) setQuery(clean);
    }, 450);
    return () => clearTimeout(t);
  }, [input, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        box.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const list = useGh(() => call('gh:prList', { repoId, query: { state: 'all', sort: 'best-match', raw: query } }), [repoId, query]);

  useEffect(() => {
    setExtra([]);
    setCursor(list.data?.endCursor ?? null);
    setHasMore(!!list.data?.hasNextPage);
    if (list.data)
      setSeen((m) => {
        const n = new Map(m);
        for (const p of list.data!.items) if (p.author?.login) n.set(p.author.login, !!p.authorIsBot);
        return n;
      });
  }, [list.data]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await call('gh:prList', { repoId, query: { state: 'all', sort: 'best-match', raw: query, after: cursor, source: (list.data?.source ?? 'search') as PrListSource } });
      setExtra((e) => [...e, ...r.items]);
      setCursor(r.endCursor);
      setHasMore(r.hasNextPage);
    } finally {
      setLoadingMore(false);
    }
  };

  const setDens = (d: Density) => {
    setDensity(d);
    try {
      localStorage.setItem('gg-pr-density', d);
    } catch {
      // per-viewer convenience only
    }
  };

  // ---- people for Author / Reviews ----
  const people = useMemo(() => {
    const m = new Map<string, boolean>(seen);
    for (const u of metadata?.assignableUsers ?? []) if (!m.has(u.login)) m.set(u.login, false);
    if (ctx.account && !m.has(ctx.account)) m.set(ctx.account, false);
    return [...m.entries()].sort((a, b) => Number(a[1]) - Number(b[1]) || a[0].localeCompare(b[0]));
  }, [seen, metadata, ctx.account]);
  const asAuthor = (login: string, bot: boolean) => (bot ? `app/${login.replace(/\[bot\]$/, '')}` : login);

  // ---- search autocomplete ----
  const valuesFor = (key: string): string[] => {
    if (key === 'author') return ['@me', ...people.map(([l, b]) => asAuthor(l, b))];
    if (['assignee', 'review-requested', 'reviewed-by', 'mentions', 'commenter', 'involves'].includes(key)) return ['@me', ...people.filter(([, b]) => !b).map(([l]) => l)];
    if (key === 'label') return (metadata?.labels ?? []).map((l) => l.name);
    if (key === 'milestone') return (metadata?.milestones ?? []).map((m) => m.title);
    if (key === 'base' || key === 'head') return metadata?.branches ?? [];
    return QUALIFIERS.find((q) => q.key === key)?.values ?? [];
  };
  const before = input.slice(0, caret);
  const segStart = before.search(/\S*$/);
  const segment = before.slice(segStart);
  const suggestions = useMemo((): { insert: string; label: string; hint?: string }[] => {
    if (!focused) return [];
    const neg = segment.startsWith('-') ? '-' : '';
    const seg = segment.slice(neg.length);
    const colon = seg.indexOf(':');
    if (colon > 0) {
      const key = seg.slice(0, colon).toLowerCase();
      const partial = seg.slice(colon + 1).replace(/^"/, '').toLowerCase();
      return valuesFor(key)
        .filter((v) => v.toLowerCase().includes(partial))
        .slice(0, 8)
        .map((v) => ({ insert: `${neg}${key}:${/\s/.test(v) ? `"${v}"` : v} `, label: `${key}:${v}` }));
    }
    if (!seg) return [];
    return QUALIFIERS.filter((q) => q.key.startsWith(seg.toLowerCase()))
      .slice(0, 8)
      .map((q) => ({ insert: `${neg}${q.key}:`, label: `${q.key}:`, hint: q.hint }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, focused, people, metadata]);
  useEffect(() => setActive(0), [segment]);

  const accept = (insert: string) => {
    const next = input.slice(0, segStart) + insert + input.slice(caret).replace(/^\S*/, '');
    setInput(next);
    const pos = segStart + insert.length;
    requestAnimationFrame(() => {
      box.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
    if (insert.endsWith(' ')) apply(next);
  };

  // ---- filters (all stored as qualifiers in the query) ----
  const state = stateOf(query);
  const author = getQualifier(query, 'author');
  const reviewQ = getQualifier(query, 'review');
  const reviewedBy = getQualifier(query, 'reviewed-by');
  const requested = getQualifier(query, 'review-requested');
  const reviewLabel = reviewQ
    ? REVIEW_STATUS.find(([v]) => v === `review:${reviewQ}`)?.[1] ?? reviewQ
    : reviewedBy
      ? `Reviewed by ${reviewedBy === '@me' ? 'you' : reviewedBy}`
      : requested
        ? `Waiting on ${requested === '@me' ? 'you' : requested}`
        : null;
  const setReview = (key: string | null, value?: string) => {
    let q = setQualifier(setQualifier(setQualifier(query, 'review', null), 'reviewed-by', null), 'review-requested', null);
    if (key && value) q = setQualifier(q, key, value);
    apply(q);
  };
  const sort = getQualifier(query, 'sort');
  const items = [...(list.data?.items ?? []), ...extra];
  const counts = list.data?.counts ?? null;
  const filtered = tokenize(query).some((t) => !(t.key === 'is' && ['pr', 'open', 'closed', 'merged'].includes(t.value.toLowerCase())));
  const humans = people.filter(([, b]) => !b).map(([l]) => l);

  return (
    <div className="content pr-page">
      <div className="pr-toolbar">
        <div className="pr-search">
          <span className="muted">⌕</span>
          <input
            ref={box}
            value={input}
            spellCheck={false}
            onChange={(e) => {
              setInput(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onKeyDown={(e) => {
              if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
              } else if (suggestions.length && (e.key === 'Tab' || (e.key === 'Enter' && segment))) {
                e.preventDefault();
                accept(suggestions[active].insert);
              } else if (e.key === 'Enter') apply(input);
              else if (e.key === 'Escape') box.current?.blur();
            }}
            placeholder="Search all pull requests — e.g. author:@me review:required fix"
          />
          {query !== DEFAULT_QUERY && (
            <button className="btn sm ghost" title="Reset to open pull requests" onClick={() => apply(DEFAULT_QUERY)}>
              ✕
            </button>
          )}
          <kbd title="Press / to search">/</kbd>
          {suggestions.length > 0 && (
            <div className="qs-menu pop-in">
              {suggestions.map((s, i) => (
                <div key={s.label} className={`qs-item ${i === active ? 'on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => accept(s.insert)} onMouseEnter={() => setActive(i)}>
                  <span className="mono">{s.label}</span>
                  {s.hint && <span className="small muted">{s.hint}</span>}
                </div>
              ))}
              <div className="qs-foot small muted">Tab or Enter to insert · same syntax as github.com</div>
            </div>
          )}
        </div>
        <button className="btn primary" onClick={onCreate} disabled={!ctx.permissions.canTriage && ctx.permissions.level === 'NONE'}>
          ＋ New pull request
        </button>
      </div>

      <div className="quick-filters">
        {QUICK.map((f) => {
          const on = getQualifier(query, f.key) === f.value;
          return (
            <button key={f.label} className={`quick-chip ${on ? 'on' : ''}`} onClick={() => apply(setQualifier(query, f.key, on ? null : f.value))}>
              {f.label}
            </button>
          );
        })}
        {filtered && (
          <button className="quick-chip clear" onClick={() => apply(setState(DEFAULT_QUERY, state))}>
            ✕ Clear filters
          </button>
        )}
      </div>

      <div className="pr-board">
        <div className="pr-board-head">
          <div className="state-tabs">
            {(
              [
                ['open', '⇄', 'Open', counts?.open],
                ['closed', '✕', 'Closed', counts?.closed],
                ['merged', '⇋', 'Merged', counts?.merged],
                ['all', '◎', 'All', counts ? counts.open + counts.closed + counts.merged : undefined],
              ] as const
            ).map(([s, icon, label, n]) => (
              <button key={s} className={`state-tab ${s} ${state === s ? 'on' : ''}`} onClick={() => apply(setState(query, s))}>
                <span className="st-icon">{icon}</span> {label} {n !== undefined && <span className="st-count">{n}</span>}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <Menu label="Author" value={author ? (author === '@me' ? 'you' : author.replace(/^app\//, '')) : null} onClear={() => apply(setQualifier(query, 'author', null))} searchable>
            {(filter, close) => (
              <>
                <MenuItem on={author === '@me'} onClick={() => (apply(setQualifier(query, 'author', '@me')), close())}>
                  <Avatar login={ctx.account} size={18} /> You <span className="muted small">@me</span>
                </MenuItem>
                {people
                  .filter(([l]) => l.toLowerCase().includes(filter))
                  .map(([l, bot]) => (
                    <MenuItem key={l} on={author === asAuthor(l, bot)} onClick={() => (apply(setQualifier(query, 'author', asAuthor(l, bot))), close())}>
                      <Avatar login={l} size={18} /> {l} {bot && <span className="bot-tag">bot</span>}
                    </MenuItem>
                  ))}
              </>
            )}
          </Menu>
          <Menu label="Reviews" value={reviewLabel} onClear={() => setReview(null)} searchable>
            {(filter, close) => (
              <>
                <MenuGroup>Status</MenuGroup>
                {REVIEW_STATUS.filter(([, l]) => l.toLowerCase().includes(filter)).map(([v, l, icon]) => (
                  <MenuItem key={v} on={`review:${reviewQ}` === v} onClick={() => (setReview('review', v.split(':')[1]), close())}>
                    <span className={`rv-icon ${v.split(':')[1]}`}>{icon}</span> {l}
                  </MenuItem>
                ))}
                <MenuGroup>You</MenuGroup>
                <MenuItem on={requested === '@me'} onClick={() => (setReview('review-requested', '@me'), close())}>
                  👀 Awaiting review from you
                </MenuItem>
                <MenuItem on={reviewedBy === '@me'} onClick={() => (setReview('reviewed-by', '@me'), close())}>
                  ✍ Reviewed by you
                </MenuItem>
                {humans.filter((l) => l.toLowerCase().includes(filter)).length > 0 && <MenuGroup>Reviewed by</MenuGroup>}
                {humans
                  .filter((l) => l.toLowerCase().includes(filter))
                  .map((l) => (
                    <MenuItem key={`rb-${l}`} on={reviewedBy === l} onClick={() => (setReview('reviewed-by', l), close())}>
                      <Avatar login={l} size={18} /> {l}
                    </MenuItem>
                  ))}
                {humans.filter((l) => l.toLowerCase().includes(filter)).length > 0 && <MenuGroup>Review requested from</MenuGroup>}
                {humans
                  .filter((l) => l.toLowerCase().includes(filter))
                  .map((l) => (
                    <MenuItem key={`rr-${l}`} on={requested === l} onClick={() => (setReview('review-requested', l), close())}>
                      <Avatar login={l} size={18} /> {l}
                    </MenuItem>
                  ))}
              </>
            )}
          </Menu>
          <Menu label="Sort" value={sort ? SORTS.find(([v]) => v === sort)?.[1] ?? sort : 'Newest'} onClear={sort ? () => apply(setQualifier(query, 'sort', null)) : undefined} alignRight>
            {(_, close) =>
              SORTS.map(([v, l]) => (
                <MenuItem key={v} on={(sort ?? 'created-desc') === v} onClick={() => (apply(setQualifier(query, 'sort', v === 'created-desc' ? null : v)), close())}>
                  {l}
                </MenuItem>
              ))
            }
          </Menu>
          <div className="segmented sm density" title="Row density">
            <button className={density === 'comfortable' ? 'on' : ''} onClick={() => setDens('comfortable')} title="Comfortable">
              ▤
            </button>
            <button className={density === 'compact' ? 'on' : ''} onClick={() => setDens('compact')} title="Compact">
              ☰
            </button>
          </div>
        </div>

        {list.error && (
          <div style={{ padding: 12 }}>
            <ErrorPanel error={list.error} onAction={() => void list.reload()} available={['retry']} />
          </div>
        )}
        {list.loading && <div className="pr-progress" />}

        <div className={`pr-rows ${density}`}>
          {list.loading && !list.data && <Skeleton rows={6} />}
          {!list.loading && list.data && items.length === 0 && (
            <div className="empty">
              <div className="empty-art">⇄</div>
              <h3>{filtered ? 'Nothing matches these filters' : `No ${state === 'all' ? '' : state} pull requests`}</h3>
              {list.data.notice && <p className="small muted">{list.data.notice}</p>}
              <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
                {filtered && (
                  <button className="btn sm" onClick={() => apply(setState(DEFAULT_QUERY, state))}>
                    Clear filters
                  </button>
                )}
                {counts &&
                  (['open', 'closed', 'merged'] as const)
                    .filter((s) => s !== state && counts[s] > 0)
                    .map((s) => (
                      <button key={s} className="btn sm" onClick={() => apply(setState(query, s))}>
                        Show {counts[s]} {s}
                      </button>
                    ))}
              </div>
            </div>
          )}
          {items.map((pr, idx) => (
            <PrRow key={pr.id} pr={pr} density={density} delay={Math.min(idx, 20) * 14} onOpen={() => onOpen(pr.number)} onAuthor={(l, bot) => apply(setQualifier(query, 'author', asAuthor(l, bot)))} />
          ))}
          {hasMore && (
            <div style={{ padding: 12 }}>
              <button className="btn block" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      </div>
      {list.data && items.length > 0 && (
        <div className="small muted pr-foot">
          Showing {items.length} of {list.data.total.toLocaleString()} · <span className="mono">{query}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const CHECK_PILL: Record<string, [string, string, string]> = {
  SUCCESS: ['ok', '✓', 'Checks passed'],
  FAILURE: ['danger', '✕', 'Checks failed'],
  ERROR: ['danger', '✕', 'Checks errored'],
  PENDING: ['warn', '●', 'Checks running'],
  EXPECTED: ['warn', '○', 'Waiting for checks'],
};
const REVIEW_PILL: Record<string, [string, string]> = {
  APPROVED: ['ok', '✓ Approved'],
  CHANGES_REQUESTED: ['danger', '✕ Changes'],
  REVIEW_REQUIRED: ['warn', '● Review'],
};

function StateIcon({ pr }: { pr: PrListItem }) {
  const [cls, icon, title] = pr.state === 'MERGED' ? ['merged', '⇋', 'Merged'] : pr.state === 'CLOSED' ? ['closed', '✕', 'Closed'] : pr.isDraft ? ['draft', '✎', 'Draft'] : ['open', '⇄', 'Open'];
  return (
    <span className={`pr-state-icon ${cls}`} title={title}>
      {icon}
    </span>
  );
}

function PrRow({ pr, density, delay, onOpen, onAuthor }: { pr: PrListItem; density: Density; delay: number; onOpen: () => void; onAuthor: (login: string, bot: boolean) => void }) {
  const check = pr.checks ? CHECK_PILL[pr.checks] : null;
  const review = pr.reviewDecision ? REVIEW_PILL[pr.reviewDecision] : null;
  const who = pr.author?.login ?? 'ghost';
  const authorBtn = (
    <a
      className="pr-author"
      onClick={(e) => {
        e.stopPropagation();
        onAuthor(who, !!pr.authorIsBot);
      }}
      title={`Show pull requests by ${who}`}
    >
      {who}
    </a>
  );

  if (density === 'compact') {
    return (
      <div className="pr-r compact" style={{ animationDelay: `${delay}ms` }} onClick={onOpen}>
        <StateIcon pr={pr} />
        <span className="pr-r-title ellipsis">
          <strong>{pr.title}</strong>
          <span className="muted small"> #{pr.number}</span>
        </span>
        <span className="pr-r-who small muted ellipsis">
          {authorBtn}
          {pr.authorIsBot && <span className="bot-tag">bot</span>}
        </span>
        <span className="pr-r-col">{check && <span className={`mini-pill ${check[0]}`} title={check[2]}>{check[1]}</span>}</span>
        <span className="pr-r-col wide">{review && <span className={`mini-pill ${review[0]}`}>{review[1]}</span>}</span>
        <span className="pr-r-col small muted">{pr.comments > 0 ? `💬 ${pr.comments}` : ''}</span>
        <span className="pr-r-time small muted">{relTime(pr.updatedAt)}</span>
      </div>
    );
  }

  return (
    <div className="pr-r comfortable" style={{ animationDelay: `${delay}ms` }} onClick={onOpen}>
      <StateIcon pr={pr} />
      <div className="pr-r-main">
        <div className="pr-r-title">
          <strong>{pr.title}</strong>
          {pr.labels.map((l) => (
            <LabelChip key={l.name} label={l} />
          ))}
        </div>
        <div className="pr-r-meta small muted">
          <span>#{pr.number}</span>
          <span>
            opened {relTime(pr.createdAt)} by {authorBtn}
            {pr.authorIsBot && <span className="bot-tag">bot</span>}
          </span>
          <span className="pr-r-branches" title={`${pr.headRefName} → ${pr.baseRefName}`}>
            <span className="branch-pill">{pr.headRefName}</span> → <span className="branch-pill">{pr.baseRefName}</span>
          </span>
          {pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING' && <span className="text-danger">⚠ conflicts</span>}
        </div>
      </div>
      <div className="pr-r-side">
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {check && (
            <span className={`mini-pill ${check[0]}`} title={check[2]}>
              {check[1]} checks
            </span>
          )}
          {review && <span className={`mini-pill ${review[0]}`}>{review[1]}</span>}
        </div>
        <div className="row small muted" style={{ gap: 8, justifyContent: 'flex-end' }}>
          {pr.reviewers.length > 0 && (
            <span className="face-stack" title={pr.reviewers.map((r) => `${r.login}: ${r.state.toLowerCase().replace('_', ' ')}`).join('\n')}>
              {pr.reviewers.slice(0, 4).map((r) => (
                <span key={r.login} className={`face ${r.state === 'APPROVED' ? 'ok' : r.state === 'CHANGES_REQUESTED' ? 'danger' : ''}`}>
                  <Avatar login={r.login} size={18} />
                </span>
              ))}
            </span>
          )}
          {pr.comments > 0 && <span>💬 {pr.comments}</span>}
          <span>updated {relTime(pr.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter menus
// ---------------------------------------------------------------------------

function Menu({ label, value, onClear, children, searchable, alignRight }: { label: string; value: string | null; onClear?: () => void; children: (filter: string, close: () => void) => ReactNode; searchable?: boolean; alignRight?: boolean }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    setFilter('');
  };
  return (
    <div className="fmenu" ref={ref}>
      <button className={`fmenu-btn ${value ? 'set' : ''} ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className="muted">{label}</span>
        {value && <strong className="ellipsis">{value}</strong>}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className={`fmenu-pop pop-in ${alignRight ? 'right' : ''}`}>
          <div className="fmenu-title">
            Filter by {label.toLowerCase()}
            {value && onClear && (
              <a
                onClick={() => {
                  onClear();
                  close();
                }}
              >
                Clear
              </a>
            )}
          </div>
          {searchable && <input autoFocus className="fmenu-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${label.toLowerCase()}…`} />}
          <div className="fmenu-list">{children(filter.trim().toLowerCase(), close)}</div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ on, onClick, children }: { on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className={`fmenu-item ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="fmenu-check">{on ? '✓' : ''}</span>
      {children}
    </div>
  );
}

function MenuGroup({ children }: { children: ReactNode }) {
  return <div className="fmenu-group">{children}</div>;
}
