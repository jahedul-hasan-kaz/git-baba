import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppNotification, NotificationFeed, NotificationKind } from '../../shared/types';
import { call, onNotify } from '../services/api';
import { Avatar, relTime } from './github/common';

type Filter = 'all' | 'code' | 'prs' | 'comments' | 'actions' | 'branches';

const FILTERS: { id: Filter; label: string; kinds: NotificationKind[] }[] = [
  { id: 'all', label: 'All', kinds: [] },
  { id: 'code', label: 'Pushes', kinds: ['push', 'worktree'] },
  { id: 'prs', label: 'Pull requests', kinds: ['pr', 'review'] },
  { id: 'comments', label: 'Comments', kinds: ['comment', 'issue'] },
  { id: 'actions', label: 'Actions', kinds: ['workflow'] },
  { id: 'branches', label: 'Branches & tags', kinds: ['branch-create', 'branch-delete', 'tag', 'release', 'repo'] },
];

const KIND_ICON: Record<NotificationKind, string> = {
  push: '⬆',
  'branch-create': '⎇',
  'branch-delete': '⎇',
  tag: '🏷',
  pr: '⇄',
  review: '✓',
  comment: '💬',
  issue: '◎',
  workflow: '▶',
  release: '🚀',
  worktree: '🗂',
  repo: '📦',
};

/**
 * The bell in the header: a live count of new activity on the active account's repositories, and a panel
 * that lists it. Opening the panel marks everything as read; items opened as new keep a "new" marker until
 * the panel closes, so nothing disappears while you read. Items are for reading — not links.
 */
export function NotificationBell() {
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [ring, setRing] = useState(0);
  const [showPrefs, setShowPrefs] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lastUnread = useRef(0);
  const ref = useRef<HTMLDivElement>(null);

  const apply = useCallback((f: NotificationFeed) => {
    if (f.unread > lastUnread.current) setRing((r) => r + 1);
    lastUnread.current = f.unread;
    setFeed(f);
  }, []);

  useEffect(() => {
    void call('notify:feed').then(apply).catch(() => undefined);
    return onNotify((e) => {
      if (e.type === 'feed') apply(e.feed);
      else if (e.type === 'open') openPanel();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply]);

  const openPanel = async () => {
    setOpen(true);
    setShowPrefs(false);
    const current = feed ?? (await call('notify:feed').catch(() => null));
    if (current?.unread) {
      setFresh(new Set(current.items.filter((n) => !n.read).map((n) => n.id)));
      lastUnread.current = 0;
      void call('notify:markAllRead').then(setFeed).catch(() => undefined);
    }
    setRefreshing(true);
    void call('notify:refresh')
      .then(apply)
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  const close = useCallback(() => {
    setOpen(false);
    setFresh(new Set());
    // Anything that arrived while the panel was open has been seen.
    if (lastUnread.current) void call('notify:markAllRead').then(setFeed).catch(() => undefined);
    lastUnread.current = 0;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // New items arriving while the panel is open are shown as new, too.
  useEffect(() => {
    if (!open || !feed) return;
    const unread = feed.items.filter((n) => !n.read);
    if (unread.length) setFresh((s) => new Set([...s, ...unread.map((n) => n.id)]));
  }, [open, feed]);

  const items = feed?.items ?? [];
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, f.kinds.length ? items.filter((n) => f.kinds.includes(n.kind)).length : items.length])), [items]);
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    return f.kinds.length ? items.filter((n) => f.kinds.includes(n.kind)) : items;
  }, [items, filter]);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const unread = open ? 0 : (feed?.unread ?? 0);

  const setPrefs = (p: Parameters<typeof call<'notify:setPrefs'>>[1]) => void call('notify:setPrefs', p).then(setFeed).catch(() => undefined);
  const snoozed = feed?.status === 'snoozed';

  return (
    <div className="pop-anchor nb" ref={ref}>
      <button
        className={`nb-btn ${open ? 'on' : ''} ${unread ? 'has' : ''} ${snoozed ? 'snoozed' : ''}`}
        onClick={() => (open ? close() : void openPanel())}
        aria-label={unread ? `${unread} new notifications` : 'Notifications'}
        aria-expanded={open}
        title={snoozed ? 'Notifications paused' : unread ? `${unread} new` : 'Notifications'}
      >
        <span key={ring} className={`nb-bell ${ring ? 'ring' : ''}`}>
          <BellIcon muted={snoozed} />
        </span>
        {unread > 0 && <span className="nb-count">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="dropdown nb-pop pop-in" role="dialog" aria-label="Notifications">
          <div className="nb-head">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="nb-title">Notifications</div>
              <div className="nb-sub">
                {feed?.account ? (
                  <>
                    <Avatar login={feed.account.login} size={14} /> {feed.account.login} · {feed.watching.length} {feed.watching.length === 1 ? 'repository' : 'repositories'}
                    {feed.status === 'ok' ? feed.checkedAt && <> · checked {relTime(feed.checkedAt)}</> : <span className="nb-status"> · {feed.status === 'snoozed' ? 'paused' : (feed.message ?? feed.status)}</span>}
                  </>
                ) : (
                  'No active account'
                )}
              </div>
            </div>
            <button
              className={`nb-icon-btn ${refreshing ? 'spin' : ''}`}
              title="Check now"
              aria-label="Check now"
              onClick={() => {
                setRefreshing(true);
                void call('notify:refresh')
                  .then(apply)
                  .finally(() => setRefreshing(false));
              }}
            >
              ⟳
            </button>
            <button className={`nb-icon-btn ${showPrefs ? 'on' : ''}`} title="Notification settings" aria-label="Notification settings" onClick={() => setShowPrefs((v) => !v)}>
              ⚙
            </button>
          </div>

          {showPrefs && feed && (
            <div className="nb-prefs">
              <label className="nb-pref">
                <span className="grow">
                  <strong>Desktop notifications</strong>
                  <span className="small muted">{feed.desktopSupported ? 'A system banner when the app is in the background' : 'Not supported on this system'}</span>
                </span>
                <input type="checkbox" role="switch" checked={feed.prefs.desktop} disabled={!feed.desktopSupported} onChange={(e) => setPrefs({ desktop: e.target.checked })} />
                <span className="nb-switch" />
              </label>
              <div className="nb-pref">
                <span className="grow">
                  <strong>Pause</strong>
                  <span className="small muted">{snoozed && feed.prefs.snoozeUntil ? `Paused until ${new Date(feed.prefs.snoozeUntil).toLocaleString()}` : 'Stop checking for a while'}</span>
                </span>
                {snoozed ? (
                  <button className="btn sm" onClick={() => setPrefs({ snoozeUntil: null })}>
                    Resume
                  </button>
                ) : (
                  <>
                    <button className="btn sm ghost" onClick={() => setPrefs({ snoozeUntil: new Date(Date.now() + 3600_000).toISOString() })}>
                      1 hour
                    </button>
                    <button className="btn sm ghost" onClick={() => setPrefs({ snoozeUntil: tomorrowMorning() })}>
                      Until tomorrow
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {items.length > 0 && (
            <div className="nb-filters" role="tablist">
              {FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0).map((f) => (
                <button key={f.id} role="tab" aria-selected={filter === f.id} className={`nb-chip ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
                  {f.label} <span className="nb-chip-n">{counts[f.id]}</span>
                </button>
              ))}
            </div>
          )}

          <div className="nb-list">
            {items.length === 0 ? (
              <EmptyState feed={feed} />
            ) : (
              groups.map(([day, list]) => (
                <section key={day} className="nb-day">
                  <div className="nb-day-title">{day}</div>
                  {list.map((n, i) => (
                    <Item key={n.id} n={n} isNew={fresh.has(n.id)} delay={i} />
                  ))}
                </section>
              ))
            )}
          </div>

          {items.length > 0 && (
            <div className="nb-foot">
              <span className="small muted grow">{fresh.size ? `${fresh.size} new · marked as read` : 'All caught up'}</span>
              <button className="btn sm ghost" onClick={() => void call('notify:clear').then(setFeed)}>
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ n, isNew, delay }: { n: AppNotification; isNew: boolean; delay: number }) {
  const quote = n.kind === 'comment' || n.kind === 'review';
  return (
    <article className={`nb-item tone-${n.tone} ${isNew ? 'new' : ''}`} style={{ animationDelay: `${Math.min(delay, 8) * 25}ms` }}>
      <div className="nb-ico">
        <span className="nb-kind">{KIND_ICON[n.kind]}</span>
        {n.actor && (
          <span className="nb-actor">
            <Avatar login={n.actor} size={18} />
          </span>
        )}
      </div>
      <div className="nb-body">
        <div className="nb-line">
          <strong>{n.actor ?? (n.kind === 'worktree' ? 'This computer' : 'Someone')}</strong>
          <span className="nb-action">{n.action}</span> <strong className="nb-subject">{n.subject}</strong>
          {n.number ? <span className="nb-num"> #{n.number}</span> : null}
        </div>
        {n.detail && <div className={`nb-detail ${quote ? 'quote' : ''} ${n.kind === 'push' ? 'commit' : ''}`}>{n.detail}</div>}
        <div className="nb-meta">
          <span className="nb-tag repo" title="Repository">
            ▣ {n.repo}
          </span>
          {n.ref && n.kind !== 'branch-create' && n.kind !== 'branch-delete' && n.kind !== 'tag' && (
            <span className="nb-tag ref" title="Branch">
              ⎇ {n.ref}
            </span>
          )}
          <span className="nb-tag acct" title="Account">
            👤 {n.accountLogin}
          </span>
          <span className="nb-time" title={new Date(n.at).toLocaleString()}>
            {relTime(n.at)}
          </span>
        </div>
      </div>
      {isNew && <span className="nb-dot" aria-label="new" />}
    </article>
  );
}

function EmptyState({ feed }: { feed: NotificationFeed | null }) {
  const s = feed?.status;
  const [icon, title, text] =
    s === 'signed-out'
      ? ['🔐', 'Sign in to get notifications', feed?.message ?? '']
      : s === 'no-repos'
        ? ['📭', 'Nothing to watch yet', feed?.message ?? '']
        : s === 'snoozed'
          ? ['🌙', 'Notifications are paused', 'Resume them from the settings above.']
          : s === 'error'
            ? ['⚠', 'Could not reach GitHub', feed?.message ?? '']
            : ['✨', 'All quiet', `Other people’s pushes, pull requests, comments, workflow runs and branch changes on ${feed?.watching.length ?? 0} ${feed?.watching.length === 1 ? 'repository' : 'repositories'} appear here.`];
  return (
    <div className="nb-empty">
      <div className="nb-empty-ico">{icon}</div>
      <strong>{title}</strong>
      <div className="small muted">{text}</div>
    </div>
  );
}

function BellIcon({ muted }: { muted?: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      {muted && <path d="M3 3l18 18" />}
    </svg>
  );
}

function groupByDay(list: AppNotification[]): [string, AppNotification[]][] {
  const today = new Date();
  const key = (d: Date) => d.toDateString();
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  const m = new Map<string, AppNotification[]>();
  for (const n of list) {
    const d = new Date(n.at);
    const label = key(d) === key(today) ? 'Today' : key(d) === key(yest) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    m.set(label, [...(m.get(label) ?? []), n]);
  }
  return [...m.entries()];
}

function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}
