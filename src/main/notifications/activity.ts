import type { AppNotification, NotificationKind, NotificationTone } from '../../shared/types';

/** What a notification is built from, before it gets an id, account and read state. */
export type ActivityDraft = Omit<AppNotification, 'id' | 'accountId' | 'accountLogin' | 'repoId' | 'repo' | 'read' | 'own'> & { key: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const short = (s: unknown, n = 140): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const line = s.replace(/\r/g, '').split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : undefined;
};
const branchOf = (ref: unknown) => (typeof ref === 'string' ? ref.replace(/^refs\/(heads|tags)\//, '') : undefined);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function draft(e: Json, kind: NotificationKind, tone: NotificationTone, action: string, subject: string, extra: Partial<ActivityDraft> = {}): ActivityDraft {
  return { key: `ev:${e.id}`, kind, tone, action, subject, actor: e.actor?.display_login ?? e.actor?.login, at: e.created_at ?? new Date().toISOString(), ...extra };
}

/**
 * One GitHub repository event (GET /repos/{owner}/{repo}/events) as a notification draft.
 * Unknown or uninteresting events (stars from strangers count, forks too) return null.
 */
export function eventToActivity(e: Json): ActivityDraft | null {
  const p = e?.payload ?? {};
  switch (e?.type) {
    case 'PushEvent': {
      const commits: Json[] = Array.isArray(p.commits) ? p.commits : [];
      const n = typeof p.size === 'number' ? p.size : commits.length || (typeof p.distinct_size === 'number' ? p.distinct_size : 0);
      const ref = branchOf(p.ref);
      const last = commits[commits.length - 1];
      return draft(e, 'push', 'info', n ? `pushed ${plural(n, 'commit')} to` : 'pushed to', ref ?? 'a branch', { ref, detail: short(last?.message) });
    }
    case 'CreateEvent': {
      if (p.ref_type === 'repository') return draft(e, 'repo', 'success', 'created the repository', e.repo?.name ?? '');
      const kind = p.ref_type === 'tag' ? 'tag' : 'branch-create';
      return draft(e, kind, 'success', `created ${p.ref_type === 'tag' ? 'tag' : 'branch'}`, p.ref ?? '', { ref: p.ref });
    }
    case 'DeleteEvent':
      return draft(e, p.ref_type === 'tag' ? 'tag' : 'branch-delete', 'warning', `deleted ${p.ref_type === 'tag' ? 'tag' : 'branch'}`, p.ref ?? '', { ref: p.ref });
    case 'PullRequestEvent': {
      const pr = p.pull_request ?? {};
      const merged = p.action === 'closed' && pr.merged;
      const action = merged ? 'merged pull request' : `${p.action ?? 'updated'} pull request`;
      const tone: NotificationTone = merged ? 'success' : p.action === 'closed' ? 'neutral' : 'info';
      if (!['opened', 'closed', 'reopened', 'ready_for_review', 'review_requested'].includes(p.action) && !merged) return null;
      return draft(e, 'pr', tone, action.replace('_', ' '), pr.title ?? `#${pr.number}`, { number: pr.number ?? p.number, ref: pr.head?.ref, detail: pr.head?.ref && pr.base?.ref ? `${pr.head.ref} → ${pr.base.ref}` : undefined });
    }
    case 'PullRequestReviewEvent': {
      const st = String(p.review?.state ?? '').toLowerCase();
      const verb = st === 'approved' ? 'approved' : st === 'changes_requested' ? 'requested changes on' : 'reviewed';
      const tone: NotificationTone = st === 'approved' ? 'success' : st === 'changes_requested' ? 'failure' : 'info';
      return draft(e, 'review', tone, verb, p.pull_request?.title ?? `#${p.pull_request?.number}`, { number: p.pull_request?.number, detail: short(p.review?.body) });
    }
    case 'PullRequestReviewCommentEvent':
      if (p.action && p.action !== 'created') return null;
      return draft(e, 'comment', 'info', 'commented on a change in', p.pull_request?.title ?? `#${p.pull_request?.number}`, {
        number: p.pull_request?.number,
        detail: short(p.comment?.body),
      });
    case 'IssueCommentEvent': {
      if (p.action && p.action !== 'created') return null;
      const isPr = !!p.issue?.pull_request;
      return draft(e, 'comment', 'info', `commented on ${isPr ? 'pull request' : 'issue'}`, p.issue?.title ?? `#${p.issue?.number}`, { number: p.issue?.number, detail: short(p.comment?.body) });
    }
    case 'CommitCommentEvent':
      return draft(e, 'comment', 'info', 'commented on commit', String(p.comment?.commit_id ?? '').slice(0, 7), { detail: short(p.comment?.body) });
    case 'IssuesEvent':
      if (!['opened', 'closed', 'reopened'].includes(p.action)) return null;
      return draft(e, 'issue', p.action === 'closed' ? 'neutral' : 'info', `${p.action} issue`, p.issue?.title ?? `#${p.issue?.number}`, { number: p.issue?.number });
    case 'ReleaseEvent':
      if (p.action !== 'published') return null;
      return draft(e, 'release', 'success', 'published release', p.release?.name || p.release?.tag_name || '', { ref: p.release?.tag_name });
    case 'MemberEvent':
      return draft(e, 'repo', 'info', `${p.action ?? 'added'} collaborator`, p.member?.login ?? '');
    case 'PublicEvent':
      return draft(e, 'repo', 'warning', 'made the repository', 'public');
    default:
      return null;
  }
}

/** Last-seen state of a workflow run: notifications fire when a run finishes. */
export interface RunState {
  status: string;
  conclusion: string | null;
}

/**
 * Workflow runs that finished since the last check (GET /repos/{o}/{r}/actions/runs).
 * A run seen for the first time already completed is reported only when it finished after `since`.
 */
export function runsToActivity(runs: Json[], seen: Record<string, RunState>, since: string): { drafts: ActivityDraft[]; next: Record<string, RunState> } {
  const next: Record<string, RunState> = {};
  const drafts: ActivityDraft[] = [];
  for (const r of runs) {
    const id = String(r.id);
    const state: RunState = { status: String(r.status ?? ''), conclusion: r.conclusion ?? null };
    next[id] = state;
    const before = seen[id];
    if (state.status !== 'completed') continue;
    const finishedAt = r.updated_at ?? r.run_started_at ?? r.created_at;
    const fresh = before ? before.status !== 'completed' : !!finishedAt && finishedAt > since;
    if (!fresh) continue;
    const c = String(state.conclusion ?? 'completed');
    const tone: NotificationTone = c === 'success' ? 'success' : c === 'failure' || c === 'timed_out' || c === 'startup_failure' ? 'failure' : c === 'cancelled' ? 'neutral' : 'warning';
    const verb = c === 'success' ? 'succeeded' : c === 'failure' ? 'failed' : c === 'cancelled' ? 'was cancelled' : c.replace(/_/g, ' ');
    drafts.push({
      key: `run:${id}:${c}`,
      kind: 'workflow',
      tone,
      action: `workflow ${verb}`,
      subject: r.name ?? r.display_title ?? 'Workflow',
      detail: [r.display_title && r.display_title !== r.name ? short(r.display_title, 90) : null, r.event ? `on ${r.event}` : null].filter(Boolean).join(' · ') || undefined,
      ref: r.head_branch ?? undefined,
      actor: r.triggering_actor?.login ?? r.actor?.login,
      at: finishedAt ?? new Date().toISOString(),
    });
  }
  return { drafts, next };
}

/** `git worktree list --porcelain` → worktree path → branch. */
export function parseWorktrees(out: string): Record<string, string> {
  const map: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = line.slice(9).trim();
      map[cur] = '(detached)';
    } else if (cur && line.startsWith('branch ')) map[cur] = branchOf(line.slice(7).trim()) ?? '';
  }
  return map;
}

/** Worktrees added, removed or switched to another branch since the last check. */
export function worktreeChanges(before: Record<string, string>, after: Record<string, string>, at: string): ActivityDraft[] {
  const out: ActivityDraft[] = [];
  const name = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
  for (const [p, b] of Object.entries(after)) {
    if (!(p in before)) out.push({ key: `wt:add:${p}:${at}`, kind: 'worktree', tone: 'success', action: 'added worktree', subject: name(p), ref: b, detail: p, at });
    else if (before[p] !== b) out.push({ key: `wt:sw:${p}:${at}`, kind: 'worktree', tone: 'info', action: `switched worktree to ${b}`, subject: name(p), ref: b, detail: p, at });
  }
  for (const p of Object.keys(before)) {
    if (!(p in after)) out.push({ key: `wt:rm:${p}:${at}`, kind: 'worktree', tone: 'warning', action: 'removed worktree', subject: name(p), detail: p, at });
  }
  return out;
}
