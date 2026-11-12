import type { NotificationTone } from '../../shared/types';
import type { ActivityDraft } from './activity';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/**
 * One GraphQL request per repository: branch heads, tags, releases, recent pull requests and issues with
 * their latest reviews and comments. Comparing two snapshots tells exactly what changed — within a minute,
 * unlike GitHub's events feed, which can lag by minutes to hours.
 */
export const SNAPSHOT_QUERY = `query($o: String!, $n: String!) {
  repository(owner: $o, name: $n) {
    branches: refs(refPrefix: "refs/heads/", first: 60, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      totalCount
      nodes { name target { ... on Commit { oid committedDate messageHeadline history(first: 0) { totalCount } author { name user { login } } } } }
    }
    tags: refs(refPrefix: "refs/tags/", first: 30, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }
    releases(first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName name isDraft publishedAt author { login } } }
    pullRequests(first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title state createdAt closedAt mergedAt headRefName baseRefName
        author { login } mergedBy { login }
        reviews(last: 5) { nodes { id state body submittedAt author { login } } }
        comments(last: 5) { nodes { id body createdAt author { login } } }
        reviewThreads(last: 5) { nodes { comments(last: 3) { nodes { id body createdAt path author { login } } } } }
      }
    }
    issues(first: 15, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title state createdAt closedAt author { login } comments(last: 5) { nodes { id body createdAt author { login } } } }
    }
  }
}`;

export interface RepoSnapshot {
  branches: Record<string, { oid: string; count: number }>;
  /** More branches exist than were listed: a missing branch may just be beyond the list. */
  truncated: boolean;
  tags: string[];
  releases: string[];
  prs: Record<string, 'OPEN' | 'CLOSED' | 'MERGED'>;
  issues: Record<string, 'OPEN' | 'CLOSED'>;
  /** Ids of reviews and comments already reported (or present at baseline). */
  seen: string[];
}

interface Discussion {
  id: string;
  kind: 'comment' | 'review';
  at: string;
  author?: string;
  body?: string;
  state?: string;
  number: number;
  title: string;
  where: 'pull request' | 'issue' | 'change';
}

interface Parsed {
  snap: RepoSnapshot;
  heads: Record<string, { author?: string; message?: string; at?: string }>;
  prs: Json[];
  issues: Json[];
  releases: Json[];
  discussions: Discussion[];
}

const login = (a: Json): string | undefined => a?.user?.login ?? a?.login ?? a?.name ?? undefined;
const excerpt = (s: unknown, n = 140): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\r/g, '').split('\n').find((l) => l.trim())?.trim() ?? '';
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : undefined;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function parseSnapshot(data: Json, prevSeen: string[] = []): Parsed {
  const r = data?.repository ?? {};
  const branches: RepoSnapshot['branches'] = {};
  const heads: Parsed['heads'] = {};
  for (const b of r.branches?.nodes ?? []) {
    const t = b?.target;
    if (!b?.name || !t?.oid) continue;
    branches[b.name] = { oid: t.oid, count: t.history?.totalCount ?? 0 };
    heads[b.name] = { author: login(t.author), message: t.messageHeadline, at: t.committedDate };
  }
  const discussions: Discussion[] = [];
  for (const pr of r.pullRequests?.nodes ?? []) {
    for (const v of pr.reviews?.nodes ?? []) {
      if (v?.id && v.state !== 'PENDING') discussions.push({ id: v.id, kind: 'review', at: v.submittedAt, author: login(v.author), body: v.body, state: v.state, number: pr.number, title: pr.title, where: 'pull request' });
    }
    for (const c of pr.comments?.nodes ?? []) if (c?.id) discussions.push({ id: c.id, kind: 'comment', at: c.createdAt, author: login(c.author), body: c.body, number: pr.number, title: pr.title, where: 'pull request' });
    for (const th of pr.reviewThreads?.nodes ?? [])
      for (const c of th?.comments?.nodes ?? []) if (c?.id) discussions.push({ id: c.id, kind: 'comment', at: c.createdAt, author: login(c.author), body: c.body, number: pr.number, title: pr.title, where: 'change' });
  }
  for (const is of r.issues?.nodes ?? []) {
    for (const c of is.comments?.nodes ?? []) if (c?.id) discussions.push({ id: c.id, kind: 'comment', at: c.createdAt, author: login(c.author), body: c.body, number: is.number, title: is.title, where: 'issue' });
  }
  const prs: RepoSnapshot['prs'] = {};
  for (const pr of r.pullRequests?.nodes ?? []) if (pr?.number) prs[pr.number] = pr.state;
  const issues: RepoSnapshot['issues'] = {};
  for (const is of r.issues?.nodes ?? []) if (is?.number) issues[is.number] = is.state;
  const releases = (r.releases?.nodes ?? []).filter((x: Json) => x && !x.isDraft).map((x: Json) => x.tagName as string);
  return {
    snap: {
      branches,
      truncated: (r.branches?.totalCount ?? 0) > Object.keys(branches).length,
      tags: (r.tags?.nodes ?? []).map((t: Json) => t.name as string),
      releases,
      prs,
      issues,
      seen: [...new Set([...discussions.map((d) => d.id), ...prevSeen])].slice(0, 600),
    },
    heads,
    prs: r.pullRequests?.nodes ?? [],
    issues: r.issues?.nodes ?? [],
    releases: r.releases?.nodes ?? [],
    discussions,
  };
}

/**
 * What changed between two snapshots. `since` (the baseline time) keeps old comments that merely scroll
 * into the "latest" window from being reported as new.
 */
export function diffSnapshot(prev: RepoSnapshot, p: Parsed, since: string, now: string): ActivityDraft[] {
  const out: ActivityDraft[] = [];
  const next = p.snap;

  for (const [name, b] of Object.entries(next.branches)) {
    const old = prev.branches[name];
    const h = p.heads[name] ?? {};
    if (!old) {
      out.push({ key: `bc:${name}:${b.oid}`, kind: 'branch-create', tone: 'success', action: 'created branch', subject: name, ref: name, actor: h.author, detail: excerpt(h.message), at: h.at && h.at > since ? h.at : now });
    } else if (old.oid !== b.oid) {
      const n = b.count - old.count;
      out.push({
        key: `push:${name}:${b.oid}`,
        kind: 'push',
        tone: n < 0 ? 'warning' : 'info',
        action: n > 0 ? `pushed ${plural(n, 'commit')} to` : n < 0 ? 'force-pushed' : 'updated',
        subject: name,
        ref: name,
        actor: h.author,
        detail: excerpt(h.message),
        at: h.at && h.at > since ? h.at : now,
      });
    }
  }
  if (!next.truncated) {
    for (const [name, b] of Object.entries(prev.branches)) {
      if (!next.branches[name]) out.push({ key: `bd:${name}:${b.oid}`, kind: 'branch-delete', tone: 'warning', action: 'deleted branch', subject: name, ref: name, at: now });
    }
  }
  for (const t of next.tags) if (!prev.tags.includes(t) && !next.releases.includes(t)) out.push({ key: `tag:${t}`, kind: 'tag', tone: 'success', action: 'created tag', subject: t, ref: t, at: now });
  for (const rel of p.releases) {
    if (!rel || rel.isDraft || prev.releases.includes(rel.tagName)) continue;
    out.push({ key: `rel:${rel.tagName}`, kind: 'release', tone: 'success', action: 'published release', subject: rel.name || rel.tagName, ref: rel.tagName, actor: login(rel.author), at: rel.publishedAt ?? now });
  }

  for (const pr of p.prs) {
    const before = prev.prs[pr.number];
    const state = pr.state as 'OPEN' | 'CLOSED' | 'MERGED';
    if (before === state) continue;
    if (!before && !(pr.createdAt > since)) continue; // an old PR that was just updated (its comments are handled below)
    const merged = state === 'MERGED';
    const action = !before ? 'opened pull request' : merged ? 'merged pull request' : state === 'CLOSED' ? 'closed pull request' : 'reopened pull request';
    const tone: NotificationTone = merged ? 'success' : state === 'CLOSED' ? 'neutral' : 'info';
    out.push({
      key: `pr:${pr.number}:${state}:${before ?? 'new'}`,
      kind: 'pr',
      tone,
      action,
      subject: pr.title,
      number: pr.number,
      ref: pr.headRefName,
      detail: pr.headRefName && pr.baseRefName ? `${pr.headRefName} → ${pr.baseRefName}` : undefined,
      actor: merged ? (login(pr.mergedBy) ?? login(pr.author)) : !before ? login(pr.author) : undefined,
      at: (merged ? pr.mergedAt : state === 'CLOSED' ? pr.closedAt : pr.createdAt) ?? now,
    });
  }
  for (const is of p.issues) {
    const before = prev.issues[is.number];
    if (before === is.state || (!before && !(is.createdAt > since))) continue;
    out.push({
      key: `issue:${is.number}:${is.state}:${before ?? 'new'}`,
      kind: 'issue',
      tone: is.state === 'CLOSED' ? 'neutral' : 'info',
      action: !before ? 'opened issue' : is.state === 'CLOSED' ? 'closed issue' : 'reopened issue',
      subject: is.title,
      number: is.number,
      actor: !before ? login(is.author) : undefined,
      at: (is.state === 'CLOSED' ? is.closedAt : is.createdAt) ?? now,
    });
  }

  const seen = new Set(prev.seen);
  for (const d of p.discussions) {
    if (seen.has(d.id) || !d.at || d.at <= since) continue;
    if (d.kind === 'review') {
      const st = String(d.state ?? '').toUpperCase();
      // A review that is only a container for line comments is reported through those comments.
      if (st === 'COMMENTED' && !d.body?.trim()) continue;
      out.push({
        key: `rv:${d.id}`,
        kind: 'review',
        tone: st === 'APPROVED' ? 'success' : st === 'CHANGES_REQUESTED' ? 'failure' : 'info',
        action: st === 'APPROVED' ? 'approved' : st === 'CHANGES_REQUESTED' ? 'requested changes on' : st === 'DISMISSED' ? 'dismissed a review on' : 'reviewed',
        subject: d.title,
        number: d.number,
        actor: d.author,
        detail: excerpt(d.body),
        at: d.at,
      });
    } else {
      out.push({
        key: `c:${d.id}`,
        kind: 'comment',
        tone: 'info',
        action: d.where === 'change' ? 'commented on a change in' : `commented on ${d.where}`,
        subject: d.title,
        number: d.number,
        actor: d.author,
        detail: excerpt(d.body),
        at: d.at,
      });
    }
  }
  return out;
}
