import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GhRepoContext, PrListItem, PrListSource, RepoMetadata } from '../../../shared/github';
import { getQualifier, QUALIFIERS, setQualifier, setState, stateOf, tokenize } from '../../../shared/prQuery';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Avatar, relTime, Skeleton, useGh } from '../../components/github/common';
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

type View = 'lanes' | 'stream' | 'compact';
function readView(): View {
  try {
    const v = localStorage.getItem('gg-pr-view');
    return v === 'stream' || v === 'compact' ? v : 'lanes';
  } catch {
    return 'lanes';
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
  const [view, setView] = useState<View>(readView);
  const [sel, setSel] = useState(-1);
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

  const setV = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('gg-pr-view', v);
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

  const lanes = useMemo(() => {
    const m = new Map<LaneKey, PrListItem[]>();
    for (const p of items) {
      const k = laneOf(p, ctx.account);
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return LANES.filter((l) => m.has(l.key)).map((l) => ({ ...l, items: m.get(l.key)! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, extra, ctx.account]);
  // Rows in the order they are drawn, for j/k navigation.
  const ordered = view === 'lanes' ? lanes.flatMap((l) => l.items) : items;
  const pulse = useMemo(() => {
    const open = items.filter((p) => p.state === 'OPEN');
    return {
      yours: open.filter((p) => laneOf(p, ctx.account) === 'yours').length,
      ready: open.filter((p) => laneOf(p, ctx.account) === 'ready').length,
      blocked: open.filter((p) => laneOf(p, ctx.account) === 'blocked').length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, extra, ctx.account]);

  useEffect(() => setSel(-1), [query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setSel((s) => Math.max(0, Math.min(ordered.length - 1, s + (e.key === 'j' ? 1 : -1))));
      } else if (e.key === 'Enter' && sel >= 0 && ordered[sel]) onOpen(ordered[sel].number);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ordered, sel, onOpen]);
  useEffect(() => {
    if (sel >= 0) document.querySelector(`[data-pr-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const idxOf = new Map(ordered.map((p, i) => [p.id, i]));

  const card = (pr: PrListItem, i: number) => (
    <PrCard
      key={pr.id}
      pr={pr}
      idx={idxOf.get(pr.id) ?? i}
      selected={idxOf.get(pr.id) === sel}
      compact={view === 'compact'}
      account={ctx.account}
      delay={Math.min(i, 20) * 14}
      onOpen={() => onOpen(pr.number)}
      onAuthor={(l, bot) => apply(setQualifier(query, 'author', asAuthor(l, bot)))}
    />
  );

  return (
    <div className="content pr-page prx">
      <header className="prx-head">
        <div className="prx-title">
          <h1>Pull requests</h1>
          <div className="prx-pulse">
            {counts && <span><strong>{counts.open}</strong> open</span>}
            {pulse.yours > 0 && (
              <button className="prx-pulse-chip you" onClick={() => apply(setQualifier(setState(DEFAULT_QUERY, 'open'), 'review-requested', '@me'))}>
                <i /> {pulse.yours} waiting on you
              </button>
            )}
            {pulse.ready > 0 && (
              <span className="prx-pulse-chip ok">
                <i /> {pulse.ready} ready to ship
              </span>
            )}
            {pulse.blocked > 0 && (
              <span className="prx-pulse-chip danger">
                <i /> {pulse.blocked} blocked
              </span>
            )}
          </div>
        </div>
        <button className="btn primary prx-new" onClick={onCreate} disabled={!ctx.permissions.canTriage && ctx.permissions.level === 'NONE'}>
          ＋ New pull request
        </button>
      </header>

      <div className="prx-command">
        <div className="pr-search prx-search">
          <span className="prx-search-ico">⌕</span>
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
        <div className="prx-states" role="tablist">
          {(
            [
              ['open', 'Open', counts?.open],
              ['merged', 'Merged', counts?.merged],
              ['closed', 'Closed', counts?.closed],
              ['all', 'All', counts ? counts.open + counts.closed + counts.merged : undefined],
            ] as const
          ).map(([s, label, n]) => (
            <button key={s} role="tab" className={`prx-state ${s} ${state === s ? 'on' : ''}`} onClick={() => apply(setState(query, s))}>
              <i className="prx-dot" />
              {label}
              {n !== undefined && <span className="prx-count">{n}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="prx-bar">
        <div className="prx-lenses">
          {QUICK.map((f) => {
            const on = getQualifier(query, f.key) === f.value;
            return (
              <button key={f.label} className={`prx-lens ${on ? 'on' : ''}`} onClick={() => apply(setQualifier(query, f.key, on ? null : f.value))}>
                {f.label}
              </button>
            );
          })}
          {filtered && (
            <button className="prx-lens clear" onClick={() => apply(setState(DEFAULT_QUERY, state))}>
              ✕ Clear
            </button>
          )}
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
        <div className="segmented sm prx-views" title="Layout">
          {(
            [
              ['lanes', '▦', 'Lanes — grouped by what each pull request needs next'],
              ['stream', '▤', 'Stream — one list in sort order'],
              ['compact', '☰', 'Compact — dense one-line rows'],
            ] as [View, string, string][]
          ).map(([v, icon, tip]) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setV(v)} title={tip}>
              {icon}
            </button>
          ))}
        </div>
      </div>

      {list.error && (
        <div style={{ padding: 12 }}>
          <ErrorPanel error={list.error} onAction={() => void list.reload()} available={['retry']} />
        </div>
      )}
      {list.loading && <div className="pr-progress" />}
      {list.data?.notice && items.length > 0 && <div className="small muted prx-notice">{list.data.notice}</div>}

      <div className={`prx-body ${view}`}>
        {list.loading && !list.data && <Skeleton rows={6} />}
        {!list.loading && list.data && items.length === 0 && (
          <div className="empty prx-empty">
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
        {view === 'lanes'
          ? lanes.map((l) => (
              <section key={l.key} className={`prx-lane ${l.key}`}>
                <div className="prx-lane-head">
                  <i className="prx-lane-dot" />
                  <strong>{l.title}</strong>
                  <span className="prx-count">{l.items.length}</span>
                  <span className="small muted">{l.hint}</span>
                </div>
                <div className="prx-cards">{l.items.map(card)}</div>
              </section>
            ))
          : <div className="prx-cards">{items.map(card)}</div>}
        {hasMore && (
          <button className="btn block prx-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : `Load more · ${items.length} of ${list.data?.total.toLocaleString()}`}
          </button>
        )}
      </div>
      {list.data && items.length > 0 && (
        <div className="small muted pr-foot">
          Showing {items.length} of {list.data.total.toLocaleString()} · <span className="mono">{query}</span> · <kbd>j</kbd>/<kbd>k</kbd> to move, <kbd>Enter</kbd> to open
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lanes and cards
// ---------------------------------------------------------------------------

type LaneKey = 'yours' | 'blocked' | 'ready' | 'review' | 'draft' | 'merged' | 'closed';
const LANES: { key: LaneKey; title: string; hint: string }[] = [
  { key: 'yours', title: 'Your turn', hint: 'your review was requested' },
  { key: 'blocked', title: 'Needs attention', hint: 'failing checks, conflicts or requested changes' },
  { key: 'ready', title: 'Ready to ship', hint: 'approved and green' },
  { key: 'review', title: 'In review', hint: 'waiting on reviewers or checks' },
  { key: 'draft', title: 'Drafts', hint: 'still being written' },
  { key: 'merged', title: 'Merged', hint: '' },
  { key: 'closed', title: 'Closed', hint: 'closed without merging' },
];

const failing = (c: string | null | undefined) => c === 'FAILURE' || c === 'ERROR';

function laneOf(p: PrListItem, me: string | null | undefined): LaneKey {
  if (p.state === 'MERGED') return 'merged';
  if (p.state === 'CLOSED') return 'closed';
  if (p.isDraft) return 'draft';
  if (me && p.reviewers.some((r) => r.login === me && r.state === 'REQUESTED')) return 'yours';
  if (p.mergeable === 'CONFLICTING' || failing(p.checks) || p.reviewDecision === 'CHANGES_REQUESTED') return 'blocked';
  if (p.reviewDecision === 'APPROVED' && !p.checks?.match(/PENDING|EXPECTED/)) return 'ready';
  return 'review';
}

/** Three signals (checks, review, merge) drawn as a segmented strip. */
function signals(pr: PrListItem): { key: string; tone: string; label: string }[] {
  const checks = !pr.checks ? ['idle', 'No checks'] : failing(pr.checks) ? ['danger', 'Checks failing'] : pr.checks === 'SUCCESS' ? ['ok', 'Checks passed'] : ['warn', 'Checks running'];
  const review =
    pr.reviewDecision === 'APPROVED' ? ['ok', 'Approved'] : pr.reviewDecision === 'CHANGES_REQUESTED' ? ['danger', 'Changes requested'] : pr.reviewDecision === 'REVIEW_REQUIRED' ? ['warn', 'Review required'] : ['idle', 'No review rule'];
  const merge =
    pr.state === 'MERGED' ? ['merged', 'Merged'] : pr.state === 'CLOSED' ? ['idle', 'Closed'] : pr.mergeable === 'CONFLICTING' ? ['danger', 'Conflicts'] : pr.mergeable === 'MERGEABLE' ? ['ok', 'No conflicts'] : ['idle', 'Mergeability unknown'];
  return [
    { key: 'checks', tone: checks[0], label: checks[1] },
    { key: 'review', tone: review[0], label: review[1] },
    { key: 'merge', tone: merge[0], label: merge[1] },
  ];
}

/** Older open pull requests warm up: fresh → aging → stale. */
function ageTone(pr: PrListItem): string {
  if (pr.state !== 'OPEN') return '';
  const days = (Date.now() - new Date(pr.updatedAt).getTime()) / 864e5;
  return days > 30 ? 'stale' : days > 7 ? 'aging' : 'fresh';
}

function PrCard({
  pr,
  idx,
  selected,
  compact,
  account,
  delay,
  onOpen,
  onAuthor,
}: {
  pr: PrListItem;
  idx: number;
  selected: boolean;
  compact: boolean;
  account: string | null | undefined;
  delay: number;
  onOpen: () => void;
  onAuthor: (login: string, bot: boolean) => void;
}) {
  const who = pr.author?.login ?? 'ghost';
  const kind = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
  const sig = signals(pr);
  const mine = account && who === account;
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
  const strip = (
    <span className="prx-signal" title={sig.map((s) => s.label).join(' · ')}>
      {sig.map((s) => (
        <i key={s.key} className={s.tone} />
      ))}
    </span>
  );
  const faces = pr.reviewers.length > 0 && (
    <span className="prx-faces" title={pr.reviewers.map((r) => `${r.login}: ${r.state.toLowerCase().replace('_', ' ')}`).join('\n')}>
      {pr.reviewers.slice(0, 4).map((r) => (
        <span key={r.login} className={`prx-face ${r.state.toLowerCase()}`}>
          <Avatar login={r.login} size={20} />
        </span>
      ))}
      {pr.reviewers.length > 4 && <span className="prx-face more">+{pr.reviewers.length - 4}</span>}
    </span>
  );

  if (compact) {
    return (
      <div className={`prx-card compact ${kind} ${selected ? 'sel' : ''}`} data-pr-idx={idx} style={{ animationDelay: `${delay}ms` }} onClick={onOpen}>
        <i className="prx-kind" title={kind} />
        <span className="prx-num mono">#{pr.number}</span>
        <span className="prx-t ellipsis">{pr.title}</span>
        <span className="small muted ellipsis prx-who">
          {authorBtn}
          {pr.authorIsBot && <span className="bot-tag">bot</span>}
        </span>
        {strip}
        <span className="small muted prx-cm">{pr.comments > 0 ? `💬 ${pr.comments}` : ''}</span>
        <span className={`small muted prx-age ${ageTone(pr)}`}>{relTime(pr.updatedAt)}</span>
      </div>
    );
  }

  return (
    <div className={`prx-card ${kind} ${selected ? 'sel' : ''} ${mine ? 'mine' : ''}`} data-pr-idx={idx} style={{ animationDelay: `${delay}ms` }} onClick={onOpen}>
      <i className="prx-kind" title={kind} />
      <div className="prx-avatar">
        <Avatar login={who} size={32} />
      </div>
      <div className="prx-main">
        <div className="prx-t">
          {pr.title}
          {kind === 'draft' && <span className="prx-tag draft">draft</span>}
          {pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING' && <span className="prx-tag danger">conflicts</span>}
        </div>
        <div className="prx-meta small muted">
          <span className="mono">#{pr.number}</span>
          <span>
            {authorBtn}
            {pr.authorIsBot && <span className="bot-tag">bot</span>} · opened {relTime(pr.createdAt)}
          </span>
          <span className="prx-flow" title={`${pr.headRefName} → ${pr.baseRefName}`}>
            <span className="prx-ref">{pr.headRefName}</span>
            <span className="prx-arrow">➜</span>
            <span className="prx-ref base">{pr.baseRefName}</span>
          </span>
        </div>
      </div>
      <div className="prx-side">
        {strip}
        <div className="prx-side-row small muted">
          {faces}
          {pr.comments > 0 && <span>💬 {pr.comments}</span>}
          <span className={`prx-age ${ageTone(pr)}`} title={`Updated ${new Date(pr.updatedAt).toLocaleString()}`}>
            {relTime(pr.updatedAt)}
          </span>
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
