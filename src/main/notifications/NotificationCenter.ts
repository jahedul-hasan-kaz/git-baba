import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppNotification, NotificationFeed, NotificationPrefs, RepoRecord } from '../../shared/types';
import type { GitHubClient } from '../github/client/GitHubClient';
import { eventToActivity, parseWorktrees, runsToActivity, worktreeChanges, type ActivityDraft, type RunState } from './activity';

interface WatchState {
  /** Ids of events already turned into notifications (or seen at baseline). */
  eventIds: string[];
  /** Events and runs before this moment are history, not news. */
  since: string;
  runs: Record<string, RunState>;
  worktrees?: Record<string, string>;
}

interface Persisted {
  version: 1;
  items: AppNotification[];
  watch: Record<string, WatchState>;
  prefs: NotificationPrefs;
}

export interface WatchedRepo {
  repo: RepoRecord;
  accountId: string;
  owner: string;
  name: string;
}

export interface NotificationDeps {
  file: string;
  activeAccount: () => { id: string; login: string } | null;
  /** A GitHub client for the account, or null when it is not signed in. */
  client: (accountId: string) => Promise<GitHubClient | null>;
  /** Repositories that belong to the account (remote owner/name resolved). */
  reposFor: (accountId: string) => Promise<WatchedRepo[]>;
  /** `git worktree list --porcelain` for a repository folder (null when it fails). */
  worktrees: (repoPath: string) => Promise<string | null>;
  /** Show desktop notifications (already filtered). */
  desktop: (items: AppNotification[]) => void;
  /** The feed changed (new items, read state, prefs). */
  emit: (feed: NotificationFeed) => void;
  desktopSupported: boolean;
  now?: () => Date;
}

const MAX_ITEMS_PER_ACCOUNT = 300;
const MAX_REPOS = 25;
const POLL_MS = 60_000;
const DEFAULT_PREFS: NotificationPrefs = { desktop: true, includeOwn: false, snoozeUntil: null };

/**
 * Watches the active account's repositories for new activity — pushes, branches and tags, pull requests,
 * reviews and comments, issues, releases, finished workflow runs, and local worktree changes — and keeps
 * a per-account notification list. Only the active account is polled; switching accounts switches the feed.
 * The first look at a repository is a silent baseline, so adding a repository never floods the list.
 */
export class NotificationCenter {
  private data: Persisted;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private status: NotificationFeed['status'] = 'ok';
  private message: string | undefined;
  private checkedAt: string | null = null;
  private watching: string[] = [];

  constructor(private readonly deps: NotificationDeps) {
    this.data = this.load();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private load(): Persisted {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.file, 'utf8')) as Partial<Persisted>;
      return { version: 1, items: Array.isArray(raw.items) ? raw.items : [], watch: raw.watch ?? {}, prefs: { ...DEFAULT_PREFS, ...raw.prefs } };
    } catch {
      return { version: 1, items: [], watch: {}, prefs: { ...DEFAULT_PREFS } };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.deps.file);
    } catch {
      /* notifications are best-effort */
    }
  }

  start(): void {
    this.schedule(8_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms = POLL_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll().finally(() => this.schedule()), ms);
    this.timer.unref?.();
  }

  feed(): NotificationFeed {
    const acct = this.deps.activeAccount();
    const items = acct ? this.data.items.filter((n) => n.accountId === acct.id).sort((a, b) => b.at.localeCompare(a.at)) : [];
    return {
      account: acct,
      items,
      unread: items.filter((n) => !n.read).length,
      prefs: this.data.prefs,
      watching: this.watching,
      checkedAt: this.checkedAt,
      status: this.snoozed() ? 'snoozed' : this.status,
      message: this.message,
      desktopSupported: this.deps.desktopSupported,
    };
  }

  markAllRead(): NotificationFeed {
    const acct = this.deps.activeAccount();
    if (acct) for (const n of this.data.items) if (n.accountId === acct.id) n.read = true;
    this.save();
    return this.changed();
  }

  clear(): NotificationFeed {
    const acct = this.deps.activeAccount();
    if (acct) this.data.items = this.data.items.filter((n) => n.accountId !== acct.id);
    this.save();
    return this.changed();
  }

  setPrefs(p: Partial<NotificationPrefs>): NotificationFeed {
    this.data.prefs = { ...this.data.prefs, ...p };
    this.save();
    if (!this.snoozed()) this.schedule(500);
    return this.changed();
  }

  /** Checks now (e.g. the bell was opened, or the account changed). */
  async refresh(): Promise<NotificationFeed> {
    await this.poll();
    return this.feed();
  }

  private changed(): NotificationFeed {
    const f = this.feed();
    this.deps.emit(f);
    return f;
  }

  private snoozed(): boolean {
    const until = this.data.prefs.snoozeUntil;
    return !!until && until > this.now().toISOString();
  }

  private poll(): Promise<void> {
    if (!this.running) this.running = this.pollOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async pollOnce(): Promise<void> {
    if (this.snoozed()) return void this.changed();
    const acct = this.deps.activeAccount();
    if (!acct) {
      this.status = 'signed-out';
      this.message = 'Add a GitHub account to get notifications.';
      this.watching = [];
      return void this.changed();
    }
    const client = await this.deps.client(acct.id).catch(() => null);
    if (!client) {
      this.status = 'signed-out';
      this.message = `Sign in to ${acct.login} to get notifications.`;
      return void this.changed();
    }
    const repos = (await this.deps.reposFor(acct.id).catch(() => [] as WatchedRepo[])).slice(0, MAX_REPOS);
    this.watching = repos.map((r) => `${r.owner}/${r.name}`);
    if (repos.length === 0) {
      this.status = 'no-repos';
      this.message = `None of your repositories belong to ${acct.login} yet.`;
      return void this.changed();
    }

    const fresh: AppNotification[] = [];
    let failures = 0;
    for (const w of repos) {
      try {
        fresh.push(...(await this.checkRepo(client, acct, w)));
      } catch {
        failures++;
      }
    }
    this.checkedAt = this.now().toISOString();
    this.status = failures === repos.length ? 'error' : 'ok';
    this.message = this.status === 'error' ? 'GitHub could not be reached. Retrying in a minute.' : undefined;

    if (fresh.length) {
      const ids = new Set(this.data.items.map((n) => n.id));
      const added = fresh.filter((n) => !ids.has(n.id));
      this.data.items.push(...added);
      this.trim(acct.id);
      const toDesktop = added.filter((n) => !n.own || this.data.prefs.includeOwn);
      if (this.data.prefs.desktop && toDesktop.length) this.deps.desktop(toDesktop);
    }
    this.save();
    this.changed();
  }

  private trim(accountId: string): void {
    const mine = this.data.items.filter((n) => n.accountId === accountId).sort((a, b) => b.at.localeCompare(a.at));
    if (mine.length <= MAX_ITEMS_PER_ACCOUNT) return;
    const drop = new Set(mine.slice(MAX_ITEMS_PER_ACCOUNT).map((n) => n.id));
    this.data.items = this.data.items.filter((n) => !drop.has(n.id));
  }

  private async checkRepo(client: GitHubClient, acct: { id: string; login: string }, w: WatchedRepo): Promise<AppNotification[]> {
    const key = `${acct.id}:${w.repo.id}`;
    const nowIso = this.now().toISOString();
    const first = !this.data.watch[key];
    const st: WatchState = this.data.watch[key] ?? { eventIds: [], since: nowIso, runs: {} };
    const drafts: ActivityDraft[] = [];
    const base = `/repos/${encodeURIComponent(w.owner)}/${encodeURIComponent(w.name)}`;

    const events = await client.get<unknown[]>(`${base}/events`, { query: { per_page: 30 }, action: 'read repository activity' });
    const seen = new Set(st.eventIds);
    for (const e of (events ?? []) as { id: string; created_at?: string }[]) {
      const id = String(e.id);
      if (seen.has(id)) continue;
      seen.add(id);
      st.eventIds.unshift(id);
      if (first || (e.created_at ?? '') <= st.since) continue;
      const d = eventToActivity(e);
      if (d) drafts.push(d);
    }
    st.eventIds = st.eventIds.slice(0, 200);

    try {
      const runs = await client.get<{ workflow_runs?: unknown[] }>(`${base}/actions/runs`, { query: { per_page: 15 }, action: 'read workflow runs' });
      const r = runsToActivity((runs?.workflow_runs ?? []) as never[], st.runs, first ? '9999' : st.since);
      st.runs = r.next;
      drafts.push(...r.drafts);
    } catch {
      /* Actions may be disabled or not visible to this token */
    }

    const wt = await this.deps.worktrees(w.repo.path).catch(() => null);
    if (wt !== null) {
      const now = parseWorktrees(wt);
      if (st.worktrees && !first) drafts.push(...worktreeChanges(st.worktrees, now, nowIso));
      st.worktrees = now;
    }

    // `since` stays at the baseline: event ids (not times) decide what is new, because GitHub can deliver events late.
    this.data.watch[key] = st;
    return drafts.map((d) => {
      const { key: k, ...rest } = d;
      return {
        ...rest,
        id: `${acct.id}:${w.repo.id}:${k}`,
        accountId: acct.id,
        accountLogin: acct.login,
        repoId: w.repo.id,
        repo: `${w.owner}/${w.name}`,
        read: false,
        own: !!d.actor && d.actor.toLowerCase() === acct.login.toLowerCase(),
        actor: d.kind === 'worktree' ? undefined : d.actor,
      };
    });
  }
}

export { POLL_MS };
