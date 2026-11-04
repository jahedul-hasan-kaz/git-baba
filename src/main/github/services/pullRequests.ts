import { ensurePr, getQualifier, scopeToRepo, stateOf, tokenize } from '../../../shared/prQuery';
import type {
  CheckState,
  DraftReviewComment,
  GhComment,
  GhLabel,
  GhUser,
  PrCheck,
  PrCommit,
  PrDetails,
  PrFile,
  PrFilesResult,
  PrListItem,
  PrListQuery,
  PrListResult,
  RepoMetadata,
  RepoPermissions,
  ReviewEvent,
  ReviewThread,
  TimelineEvent, RefChecks } from '../../../shared/github';
import type { FileDiff } from '../../../shared/types';
import { AppError } from '../../git/errors';
import { parseUnifiedDiff } from '../../git/parsers';
import type { GitHubClient } from '../client/GitHubClient';

export interface RepoCoords {
  owner: string;
  name: string;
}

const enc = encodeURIComponent;
const repoPath = (r: RepoCoords) => `/repos/${enc(r.owner)}/${enc(r.name)}`;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export function permissionsFrom(level: string | null | undefined): RepoPermissions {
  const l = (level ?? 'NONE').toUpperCase();
  const rank = { NONE: 0, READ: 1, TRIAGE: 2, WRITE: 3, MAINTAIN: 4, ADMIN: 5 }[l] ?? 0;
  return { level: l, canTriage: rank >= 2, canWrite: rank >= 3, canAdmin: rank >= 5 };
}

// ---------------------------------------------------------------------------
// List (GitHub search, so filters and sorting combine exactly like on github.com)
// ---------------------------------------------------------------------------

const SORTS: Record<PrListQuery['sort'], string | null> = {
  'best-match': null,
  newest: 'sort:created-desc',
  oldest: 'sort:created-asc',
  'recently-updated': 'sort:updated-desc',
  'least-recently-updated': 'sort:updated-asc',
  'most-comments': 'sort:comments-desc',
  'least-comments': 'sort:comments-asc',
};

/** Quote a qualifier value when it contains spaces; strip characters that would break the query. */
function qv(v: string): string {
  const clean = v.replace(/["\\]/g, '').trim();
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

export function buildPrSearchQuery(r: RepoCoords, q: PrListQuery): string {
  const parts = [`repo:${r.owner}/${r.name}`, 'is:pr'];
  if (q.state === 'open') parts.push('is:open');
  if (q.state === 'closed') parts.push('is:closed', 'is:unmerged');
  if (q.state === 'merged') parts.push('is:merged');
  if (q.author) parts.push(`author:${qv(q.author)}`);
  if (q.label) parts.push(`label:${qv(q.label)}`);
  if (q.milestone) parts.push(`milestone:${qv(q.milestone)}`);
  if (q.assignee) parts.push(q.assignee === '__none__' ? 'no:assignee' : `assignee:${qv(q.assignee)}`);
  switch (q.review) {
    case 'none':
    case 'required':
    case 'approved':
    case 'changes_requested':
      parts.push(`review:${q.review}`);
      break;
    case 'reviewed-by-me':
      parts.push('reviewed-by:@me');
      break;
    case 'review-requested-me':
      parts.push('review-requested:@me');
      break;
  }
  const sort = SORTS[q.sort];
  if (sort) parts.push(sort);
  const text = q.text?.replace(/["\\]/g, ' ').trim();
  if (text) parts.push(text);
  return parts.join(' ');
}

const PR_LIST_FIELDS = `
  id number title state isDraft createdAt updatedAt baseRefName headRefName
  author { __typename login avatarUrl }
  assignees(first: 10) { nodes { login avatarUrl } }
  labels(first: 15) { nodes { name color } }
  milestone { title }
  comments { totalCount }
  commits { totalCount }
  changedFiles reviewDecision mergeable mergeStateStatus
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } } }
  latestReviews(first: 10) { nodes { author { login } state } }
  rollup: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

interface RawListPr {
  id: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  author: GhUser | null;
  assignees: { nodes: GhUser[] };
  labels: { nodes: GhLabel[] };
  milestone: { title: string } | null;
  comments: { totalCount: number };
  commits: { totalCount: number };
  changedFiles: number;
  reviewDecision: string | null;
  mergeable: string;
  mergeStateStatus: string;
  reviewRequests: { nodes: { requestedReviewer: { login?: string; name?: string } | null }[] };
  latestReviews: { nodes: { author: { login: string } | null; state: string }[] };
  rollup: { nodes: { commit: { statusCheckRollup: { state: CheckState } | null } }[] };
}

function toListItem(p: RawListPr): PrListItem {
  const reviewers = new Map<string, string>();
  for (const r of p.latestReviews.nodes) if (r.author) reviewers.set(r.author.login, r.state);
  for (const r of p.reviewRequests.nodes) {
    const who = r.requestedReviewer?.login ?? r.requestedReviewer?.name;
    if (who && !reviewers.has(who)) reviewers.set(who, 'REQUESTED');
  }
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    author: p.author ? { login: p.author.login, avatarUrl: p.author.avatarUrl } : null,
    authorIsBot: (p.author as { __typename?: string } | null)?.__typename === 'Bot',
    assignees: p.assignees.nodes,
    reviewers: [...reviewers].map(([login, state]) => ({ login, state })),
    labels: p.labels.nodes,
    milestone: p.milestone?.title ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    comments: p.comments.totalCount,
    commits: p.commits.totalCount,
    changedFiles: p.changedFiles,
    reviewDecision: p.reviewDecision,
    checks: p.rollup.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus,
    baseRefName: p.baseRefName,
    headRefName: p.headRefName,
  };
}

export async function listPullRequests(c: GitHubClient, r: RepoCoords, q: PrListQuery): Promise<PrListResult> {
  const data = await c.graphql<{ search: { issueCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; nodes: (RawListPr | Record<string, never>)[] } }>(
    `query($q: String!, $after: String) {
        search(query: $q, type: ISSUE, first: 25, after: $after) {
          issueCount
          pageInfo { endCursor hasNextPage }
          nodes { ... on PullRequest { ${PR_LIST_FIELDS} } }
        }
      }`,
    { q: effectiveSearch(r, q), after: q.after ?? null },
    'load pull requests',
  );
  return {
    items: data.search.nodes.filter((n): n is RawListPr => 'number' in n).map(toListItem),
    total: data.search.issueCount,
    endCursor: data.search.pageInfo.endCursor,
    hasNextPage: data.search.pageInfo.hasNextPage,
    source: 'search',
    notice: null,
    query: effectiveSearch(r, q),
  };
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

const CHECK_CONTEXTS = `
  contexts(first: 100) { nodes { __typename
    ... on CheckRun { id databaseId name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber: $number) checkSuite { workflowRun { databaseId workflow { name } } } }
    ... on StatusContext { id context state targetUrl createdAt description isRequired(pullRequestNumber: $number) }
  } }`;

const DETAILS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) {
      ${PR_LIST_FIELDS}
      body url merged mergedAt mergedBy { login } mergeCommit { oid } closedAt additions deletions
      headRefOid headRepository { nameWithOwner } viewerCanUpdate viewerDidAuthor
      allLabels: labels(first: 30) { nodes { id name color description } }
      latestReviews(first: 10) { nodes { submittedAt } }
      milestone { title number }
      closingIssuesReferences(first: 10) { nodes { number title url state } }
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated viewerCanResolve viewerCanUnresolve path line diffSide
        comments(first: 50) { nodes { id databaseId author { login avatarUrl } body createdAt updatedAt viewerCanUpdate url path line originalLine diffHunk replyTo { databaseId } } }
      } }
      timelineItems(first: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, RENAMED_TITLE_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, BASE_REF_CHANGED_EVENT]) {
        pageInfo { hasNextPage }
        nodes { __typename
          ... on IssueComment { id databaseId author { login avatarUrl } body createdAt updatedAt viewerCanUpdate url }
          ... on PullRequestReview { id author { login avatarUrl } state body submittedAt createdAt url }
          ... on PullRequestCommit { commit { oid messageHeadline committedDate author { name user { login } } } }
          ... on LabeledEvent { createdAt actor { login } label { name } }
          ... on UnlabeledEvent { createdAt actor { login } label { name } }
          ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } } }
          ... on UnassignedEvent { createdAt actor { login } assignee { ... on User { login } } }
          ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { name } } }
          ... on ReviewRequestRemovedEvent { createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { name } } }
          ... on MergedEvent { createdAt actor { login } commit { oid } mergeRefName }
          ... on ClosedEvent { createdAt actor { login } }
          ... on ReopenedEvent { createdAt actor { login } }
          ... on RenamedTitleEvent { createdAt actor { login } previousTitle currentTitle }
          ... on HeadRefForcePushedEvent { createdAt actor { login } }
          ... on MilestonedEvent { createdAt actor { login } milestoneTitle }
          ... on DemilestonedEvent { createdAt actor { login } milestoneTitle }
          ... on ReadyForReviewEvent { createdAt actor { login } }
          ... on ConvertToDraftEvent { createdAt actor { login } }
          ... on BaseRefChangedEvent { createdAt actor { login } previousRefName currentRefName }
        }
      }
      checks: commits(last: 1) { nodes { commit { statusCheckRollup { state ${CHECK_CONTEXTS} } } } }
    }
  }
}`;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function mapCheck(n: Json): PrCheck {
  if (n.__typename === 'StatusContext') {
    const s = String(n.state);
    return {
      id: n.id,
      kind: 'status',
      name: n.context,
      workflow: n.description ?? null,
      status: s === 'SUCCESS' ? 'passed' : s === 'FAILURE' || s === 'ERROR' ? 'failed' : 'pending',
      rawStatus: s,
      conclusion: s,
      startedAt: n.createdAt ?? null,
      completedAt: null,
      detailsUrl: n.targetUrl ?? null,
      jobId: null,
      runId: null,
      isRequired: !!n.isRequired,
    };
  }
  const status = String(n.status);
  const conclusion = n.conclusion ? String(n.conclusion) : null;
  let mapped: PrCheck['status'];
  if (status !== 'COMPLETED') mapped = status === 'IN_PROGRESS' ? 'running' : 'pending';
  else if (conclusion === 'SUCCESS') mapped = 'passed';
  else if (conclusion === 'CANCELLED') mapped = 'cancelled';
  else if (conclusion === 'SKIPPED' || conclusion === 'STALE') mapped = 'skipped';
  else if (conclusion === 'NEUTRAL') mapped = 'neutral';
  else mapped = 'failed';
  return {
    id: n.id,
    kind: 'check-run',
    name: n.name,
    workflow: n.checkSuite?.workflowRun?.workflow?.name ?? null,
    status: mapped,
    rawStatus: status,
    conclusion,
    startedAt: n.startedAt ?? null,
    completedAt: n.completedAt ?? null,
    detailsUrl: n.detailsUrl ?? null,
    jobId: n.checkSuite?.workflowRun ? (n.databaseId ?? null) : null,
    runId: n.checkSuite?.workflowRun?.databaseId ?? null,
    isRequired: !!n.isRequired,
  };
}

function toComment(n: Json): GhComment {
  return { id: n.id, databaseId: n.databaseId, author: n.author, body: n.body ?? '', createdAt: n.createdAt, updatedAt: n.updatedAt, viewerCanUpdate: !!n.viewerCanUpdate, url: n.url };
}

function timelineEvent(n: Json): TimelineEvent | null {
  const actor = n.actor?.login ?? null;
  switch (n.__typename) {
    case 'IssueComment':
      return { type: 'comment', at: n.createdAt, comment: toComment(n) };
    case 'PullRequestReview':
      return { type: 'review', at: n.submittedAt ?? n.createdAt, id: n.id, author: n.author, state: n.state, body: n.body ?? '', url: n.url };
    case 'PullRequestCommit':
      return { type: 'commit', at: n.commit.committedDate, oid: n.commit.oid, message: n.commit.messageHeadline, author: n.commit.author?.user?.login ?? n.commit.author?.name ?? '' };
    case 'LabeledEvent':
      return { type: 'event', at: n.createdAt, actor, text: `added the label “${n.label?.name}”` };
    case 'UnlabeledEvent':
      return { type: 'event', at: n.createdAt, actor, text: `removed the label “${n.label?.name}”` };
    case 'AssignedEvent':
      return { type: 'event', at: n.createdAt, actor, text: `assigned ${n.assignee?.login ?? 'someone'}` };
    case 'UnassignedEvent':
      return { type: 'event', at: n.createdAt, actor, text: `unassigned ${n.assignee?.login ?? 'someone'}` };
    case 'ReviewRequestedEvent':
      return { type: 'event', at: n.createdAt, actor, text: `requested a review from ${n.requestedReviewer?.login ?? n.requestedReviewer?.name ?? 'someone'}` };
    case 'ReviewRequestRemovedEvent':
      return { type: 'event', at: n.createdAt, actor, text: `removed the review request for ${n.requestedReviewer?.login ?? n.requestedReviewer?.name ?? 'someone'}` };
    case 'MergedEvent':
      return { type: 'event', at: n.createdAt, actor, text: `merged commit ${String(n.commit?.oid ?? '').slice(0, 7)} into ${n.mergeRefName}` };
    case 'ClosedEvent':
      return { type: 'event', at: n.createdAt, actor, text: 'closed this pull request' };
    case 'ReopenedEvent':
      return { type: 'event', at: n.createdAt, actor, text: 'reopened this pull request' };
    case 'RenamedTitleEvent':
      return { type: 'event', at: n.createdAt, actor, text: `changed the title “${n.previousTitle}” → “${n.currentTitle}”` };
    case 'HeadRefForcePushedEvent':
      return { type: 'event', at: n.createdAt, actor, text: 'force-pushed the branch' };
    case 'MilestonedEvent':
      return { type: 'event', at: n.createdAt, actor, text: `added this to the ${n.milestoneTitle} milestone` };
    case 'DemilestonedEvent':
      return { type: 'event', at: n.createdAt, actor, text: `removed this from the ${n.milestoneTitle} milestone` };
    case 'ReadyForReviewEvent':
      return { type: 'event', at: n.createdAt, actor, text: 'marked this pull request as ready for review' };
    case 'ConvertToDraftEvent':
      return { type: 'event', at: n.createdAt, actor, text: 'converted this pull request to a draft' };
    case 'BaseRefChangedEvent':
      return { type: 'event', at: n.createdAt, actor, text: `changed the base branch from ${n.previousRefName} to ${n.currentRefName}` };
    default:
      return null;
  }
}

export async function getPullRequest(c: GitHubClient, r: RepoCoords, number: number): Promise<PrDetails> {
  const data = await c.graphql<{ repository: { viewerPermission: string; pullRequest: Json | null } }>(DETAILS_QUERY, { owner: r.owner, name: r.name, number }, 'load the pull request');
  const p = data.repository?.pullRequest;
  if (!p) throw new AppError({ code: 'not-found', title: 'Pull Request Not Found', message: `#${number} does not exist in ${r.owner}/${r.name}, or you cannot see it.` });
  const base = toListItem(p as RawListPr);
  const checks: PrCheck[] = (p.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map(mapCheck);
  const threads: ReviewThread[] = (p.reviewThreads?.nodes ?? []).map((t: Json) => ({
    id: t.id,
    isResolved: t.isResolved,
    isOutdated: t.isOutdated,
    viewerCanResolve: t.viewerCanResolve,
    viewerCanUnresolve: t.viewerCanUnresolve,
    path: t.path,
    line: t.line ?? null,
    diffSide: t.diffSide,
    comments: (t.comments?.nodes ?? []).map((cm: Json) => ({ ...toComment(cm), path: cm.path, line: cm.line ?? null, originalLine: cm.originalLine ?? null, diffHunk: cm.diffHunk ?? '', replyToId: cm.replyTo?.databaseId ?? null })),
  }));
  return {
    ...base,
    labels: p.allLabels?.nodes ?? base.labels,
    milestone: p.milestone?.title ?? null,
    body: p.body ?? '',
    url: p.url,
    headRefOid: p.headRefOid,
    headRepository: p.headRepository?.nameWithOwner ?? null,
    merged: p.merged,
    mergedAt: p.mergedAt,
    mergedBy: p.mergedBy?.login ?? null,
    mergeCommitOid: p.mergeCommit?.oid ?? null,
    closedAt: p.closedAt,
    additions: p.additions,
    deletions: p.deletions,
    viewerCanUpdate: p.viewerCanUpdate,
    viewerDidAuthor: p.viewerDidAuthor,
    linkedIssues: p.closingIssuesReferences?.nodes ?? [],
    timeline: (p.timelineItems?.nodes ?? []).map(timelineEvent).filter((e: TimelineEvent | null): e is TimelineEvent => !!e),
    reviewThreads: threads,
    latestReviews: (p.latestReviews?.nodes ?? []).filter((n: Json) => n.author).map((n: Json) => ({ author: n.author.login, state: n.state, submittedAt: n.submittedAt ?? null })),
    requestedReviewers: (p.reviewRequests?.nodes ?? []).map((n: Json) => n.requestedReviewer?.login ?? n.requestedReviewer?.name).filter(Boolean),
    checksSummary: {
      total: checks.length,
      passed: checks.filter((x) => x.status === 'passed' || x.status === 'skipped' || x.status === 'neutral').length,
      failed: checks.filter((x) => x.status === 'failed' || x.status === 'cancelled').length,
      pending: checks.filter((x) => x.status === 'pending' || x.status === 'running').length,
    },
    permissions: permissionsFrom(data.repository.viewerPermission),
  };
}

export async function getPrChecks(c: GitHubClient, r: RepoCoords, number: number): Promise<PrCheck[]> {
  const data = await c.graphql<{ repository: { pullRequest: Json | null } }>(
    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      checks: commits(last: 1) { nodes { commit { statusCheckRollup { state ${CHECK_CONTEXTS} } } } } } } }`,
    { owner: r.owner, name: r.name, number },
    'load checks',
  );
  return (data.repository?.pullRequest?.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map(mapCheck);
}

/** Checks of any commit or branch. `prNumber` lets GitHub tell which checks are required for that pull request. */
export async function getRefChecks(c: GitHubClient, r: RepoCoords, ref: string, prNumber: number | null): Promise<RefChecks> {
  const data = await c.graphql<{ repository: { object: Json | null } }>(
    // "Required" only has a meaning relative to a pull request; without one, the field is left out.
    `query($owner: String!, $name: String!, $expr: String!${prNumber ? ', $number: Int!' : ''}) { repository(owner: $owner, name: $name) { object(expression: $expr) {
      ... on Commit { oid messageHeadline committedDate statusCheckRollup { state ${prNumber ? CHECK_CONTEXTS : CHECK_CONTEXTS.replace(/ isRequired\(pullRequestNumber: \$number\)/g, '')} } } } } }`,
    { owner: r.owner, name: r.name, expr: ref, ...(prNumber ? { number: prNumber } : {}) },
    'load checks',
  );
  const o = data.repository?.object;
  if (!o?.oid) throw new AppError({ code: 'not-found', title: 'Commit Not Found', message: `${ref} was not found on GitHub. Push it first.` });
  return { ref, oid: o.oid, headline: o.messageHeadline ?? '', date: o.committedDate ?? null, state: o.statusCheckRollup?.state ?? null, checks: (o.statusCheckRollup?.contexts?.nodes ?? []).map(mapCheck) };
}

// ---------------------------------------------------------------------------
// Commits & files
// ---------------------------------------------------------------------------

export async function getPrCommits(c: GitHubClient, r: RepoCoords, number: number, after: string | null): Promise<{ commits: PrCommit[]; endCursor: string | null; hasNextPage: boolean; total: number }> {
  const q = (withFiles: boolean) =>
    c.graphql<{ repository: { pullRequest: { commits: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; nodes: { commit: Json }[] } } | null } }>(
      `query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        commits(first: 100, after: $after) { totalCount pageInfo { endCursor hasNextPage } nodes { commit {
          oid abbreviatedOid messageHeadline message committedDate authoredDate additions deletions ${withFiles ? 'changedFilesIfAvailable' : ''} statusCheckRollup { state }
          author { name user { login } } } } } } } }`,
      { owner: r.owner, name: r.name, number, after },
      'load commits',
    );
  let data;
  try {
    data = await q(true);
  } catch (err) {
    if (err instanceof AppError && err.friendly.code === 'validation') data = await q(false);
    else throw err;
  }
  const commits = data.repository?.pullRequest?.commits;
  if (!commits) throw new AppError({ code: 'not-found', title: 'Pull Request Not Found', message: `#${number} could not be loaded.` });
  return {
    total: commits.totalCount,
    endCursor: commits.pageInfo.endCursor,
    hasNextPage: commits.pageInfo.hasNextPage,
    commits: commits.nodes.map(({ commit: m }) => ({
      oid: m.oid,
      shortOid: m.abbreviatedOid,
      headline: m.messageHeadline,
      message: m.message,
      author: m.author?.name ?? '',
      authorLogin: m.author?.user?.login ?? null,
      date: m.authoredDate ?? m.committedDate,
      additions: m.additions,
      deletions: m.deletions,
      changedFiles: m.changedFilesIfAvailable ?? null,
      checkState: m.statusCheckRollup?.state ?? null,
    })),
  };
}

/** Converts a GitHub per-file patch into the app's FileDiff (so the existing diff viewer is reused). */
export function patchToFileDiff(path: string, previousPath: string | null, status: string, patch: string | undefined): FileDiff | null {
  if (!patch) return null;
  const a = previousPath ?? path;
  const header = [`diff --git a/${a} b/${path}`];
  if (status === 'added') header.push('new file mode 100644', '--- /dev/null', `+++ b/${path}`);
  else if (status === 'removed') header.push('deleted file mode 100644', `--- a/${a}`, '+++ /dev/null');
  else {
    if (previousPath && previousPath !== path) header.push(`rename from ${previousPath}`, `rename to ${path}`);
    header.push(`--- a/${a}`, `+++ b/${path}`);
  }
  return parseUnifiedDiff(`${header.join('\n')}\n${patch}\n`, { maxLinesPerFile: 4000 })[0] ?? null;
}

export async function getPrFiles(c: GitHubClient, r: RepoCoords, number: number): Promise<PrFilesResult> {
  const [pr, files] = await Promise.all([
    c.get<{ head: { sha: string } }>(`${repoPath(r)}/pulls/${number}`, { action: 'load the pull request' }),
    // GitHub caps this list at 3000 files.
    c.paginate<{ filename: string; previous_filename?: string; status: string; additions: number; deletions: number; changes: number; patch?: string }>(`${repoPath(r)}/pulls/${number}/files`, {
      maxItems: 3000,
      action: 'load changed files',
    }),
  ]);
  return {
    headOid: pr.head.sha,
    truncated: files.hasMore,
    files: files.items.map((f) => {
      const binary = !f.patch && f.changes === 0 && f.status !== 'renamed';
      return {
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: f.status as PrFile['status'],
        additions: f.additions,
        deletions: f.deletions,
        binary,
        tooLarge: !f.patch && !binary && f.changes > 0,
        diff: patchToFileDiff(f.filename, f.previous_filename ?? null, f.status, f.patch),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Repository metadata for pickers (cached by the caller)
// ---------------------------------------------------------------------------

export async function getRepoMetadata(c: GitHubClient, r: RepoCoords): Promise<RepoMetadata> {
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [labels, milestones, users, branches] = await Promise.all([
    safe(c.paginate<{ id: number; name: string; color: string; description: string | null }>(`${repoPath(r)}/labels`, { maxItems: 300 }), { items: [], hasMore: false }),
    safe(c.paginate<{ number: number; title: string; state: 'open' | 'closed'; due_on: string | null }>(`${repoPath(r)}/milestones`, { query: { state: 'open' }, maxItems: 100 }), { items: [], hasMore: false }),
    safe(c.paginate<{ login: string; avatar_url: string }>(`${repoPath(r)}/assignees`, { maxItems: 300 }), { items: [], hasMore: false }),
    safe(c.paginate<{ name: string }>(`${repoPath(r)}/branches`, { maxItems: 500 }), { items: [], hasMore: false }),
  ]);
  return {
    labels: labels.items.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    milestones: milestones.items.map((m) => ({ number: m.number, title: m.title, state: m.state, dueOn: m.due_on })),
    assignableUsers: users.items.map((u) => ({ login: u.login, avatarUrl: u.avatar_url })),
    branches: branches.items.map((b) => b.name),
  };
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export type CompareProblem = { code: 'no-access' | 'head-missing' | 'base-missing' | 'unrelated'; title: string; message: string };

const isNotFound = (e: unknown) => e instanceof AppError && e.friendly.code === 'not-found';

/**
 * GitHub's compare endpoint answers a bare 404 for several different situations. Find out which
 * one it is: no access to the repository, a branch missing on GitHub, or no common history.
 */
export async function diagnoseCompare(c: GitHubClient, r: RepoCoords, base: string, head: string): Promise<CompareProblem> {
  const ok = (path: string, action: string) =>
    c.get(path, { action }).then(
      () => true,
      (e) => (isNotFound(e) ? false : Promise.reject(e)),
    );
  if (!(await ok(repoPath(r), 'open the repository'))) {
    return {
      code: 'no-access',
      title: 'Repository Not Visible to This Account',
      message: `${r.owner}/${r.name} cannot be seen with the signed-in account. Switch to the account that has access in the header, or ask for access to the repository.`,
    };
  }
  const [baseOk, headOk] = await Promise.all([ok(`${repoPath(r)}/branches/${enc(base)}`, 'check the base branch'), ok(`${repoPath(r)}/branches/${enc(head)}`, 'check the compare branch')]);
  if (!headOk) return { code: 'head-missing', title: `${head} Is Not on GitHub`, message: `The branch ${head} does not exist on GitHub yet. Publish (push) it first, then compare again.` };
  if (!baseOk) return { code: 'base-missing', title: `${base} Is Not on GitHub`, message: `The base branch ${base} does not exist on GitHub. Choose another base branch.` };
  return {
    code: 'unrelated',
    title: 'No Common History',
    message: `${head} and ${base} both exist on GitHub but share no commit history, so GitHub cannot compare them or open a pull request between them. Prepare a merge branch (based on ${base}, with ${head} merged in) and open the pull request from that branch.`,
  };
}

export async function compareBranches(c: GitHubClient, r: RepoCoords, base: string, head: string) {
  let res: { status: string; ahead_by: number; behind_by: number; total_commits: number; files?: unknown[]; commits: { sha: string; commit: { message: string; author: { name: string; date: string } } }[] };
  try {
    res = await c.get(`${repoPath(r)}/compare/${enc(base)}...${enc(head)}`, { action: 'compare the branches' });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const problem: CompareProblem | null = await diagnoseCompare(c, r, base, head);
    return { status: 'problem', aheadBy: 0, behindBy: 0, totalCommits: 0, files: 0, commits: [], existingPr: null, problem };
  }
  const existing = await c.get<{ number: number; title: string; html_url: string }[]>(`${repoPath(r)}/pulls`, { query: { head: `${r.owner}:${head}`, base, state: 'open' }, action: 'look for existing pull requests' }).catch(() => []);
  return {
    status: res.status,
    aheadBy: res.ahead_by,
    behindBy: res.behind_by,
    totalCommits: res.total_commits,
    files: res.files?.length ?? 0,
    commits: res.commits.slice(-20).map((x) => ({ sha: x.sha, message: x.commit.message.split('\n')[0], author: x.commit.author.name, date: x.commit.author.date })),
    existingPr: existing[0] ? { number: existing[0].number, title: existing[0].title, url: existing[0].html_url } : null,
    problem: null as CompareProblem | null,
  };
}

export async function createPullRequest(
  c: GitHubClient,
  r: RepoCoords,
  p: { title: string; body: string; head: string; base: string; draft: boolean },
): Promise<{ number: number; nodeId: string; url: string }> {
  try {
    const res = await c.rest<{ number: number; node_id: string; html_url: string }>('POST', `${repoPath(r)}/pulls`, { body: p, action: 'create the pull request' });
    return { number: res.data.number, nodeId: res.data.node_id, url: res.data.html_url };
  } catch (err) {
    throw await explainCreateFailure(c, r, p.base, p.head, err);
  }
}

/** Turns GitHub's terse pull-request errors into a specific explanation of what is wrong. */
async function explainCreateFailure(c: GitHubClient, r: RepoCoords, base: string, head: string, err: unknown): Promise<unknown> {
  if (!(err instanceof AppError)) return err;
  const f = err.friendly;
  const text = `${f.message} ${f.technical ?? ''}`;
  const make = (code: string, title: string, message: string) => new AppError({ ...f, code, title, message, reasons: [], actions: [] });
  if (f.code === 'validation') {
    if (/no history in common/i.test(text)) return make('unrelated-histories', 'No Common History', `${head} and ${base} share no commit history, so GitHub refuses the pull request. Prepare a merge branch based on ${base} with ${head} merged in, and open the pull request from it.`);
    if (/no commits between/i.test(text)) return make('nothing-to-merge', 'Nothing to Merge', `${base} already contains everything in ${head}. There is nothing for a pull request to merge.`);
    if (/already exists/i.test(text)) return make('pr-exists', 'Pull Request Already Exists', `An open pull request from ${head} into ${base} already exists. Open it from the pull request list.`);
    if (/head|base/i.test(text) && /invalid/i.test(text)) {
      const problem = await diagnoseCompare(c, r, base, head).catch(() => null);
      if (problem) return make(problem.code, problem.title, problem.message);
    }
  }
  if (f.code === 'not-found') {
    const problem = await diagnoseCompare(c, r, base, head).catch(() => null);
    if (problem) return make(problem.code, problem.title, problem.message);
  }
  return err;
}

export async function editPullRequest(c: GitHubClient, r: RepoCoords, number: number, patch: { title?: string; body?: string; base?: string }) {
  await c.rest('PATCH', `${repoPath(r)}/pulls/${number}`, { body: patch, action: 'edit the pull request' });
}

export async function setPrState(c: GitHubClient, r: RepoCoords, number: number, state: 'open' | 'closed') {
  await c.rest('PATCH', `${repoPath(r)}/pulls/${number}`, { body: { state }, action: state === 'closed' ? 'close the pull request' : 'reopen the pull request' });
}

// ---------------------------------------------------------------------------
// Comments & conversations
// ---------------------------------------------------------------------------

export async function addComment(c: GitHubClient, r: RepoCoords, number: number, body: string) {
  await c.rest('POST', `${repoPath(r)}/issues/${number}/comments`, { body: { body }, action: 'add the comment' });
}

export async function editComment(c: GitHubClient, r: RepoCoords, kind: 'issue' | 'review', databaseId: number, body: string) {
  const path = kind === 'issue' ? `${repoPath(r)}/issues/comments/${databaseId}` : `${repoPath(r)}/pulls/comments/${databaseId}`;
  await c.rest('PATCH', path, { body: { body }, action: 'edit the comment' });
}

export async function replyToReviewComment(c: GitHubClient, r: RepoCoords, number: number, commentDatabaseId: number, body: string) {
  await c.rest('POST', `${repoPath(r)}/pulls/${number}/comments/${commentDatabaseId}/replies`, { body: { body }, action: 'reply to the comment' });
}

export async function setThreadResolved(c: GitHubClient, threadId: string, resolved: boolean) {
  const m = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  await c.graphql(`mutation($id: ID!) { ${m}(input: { threadId: $id }) { thread { id isResolved } } }`, { id: threadId }, resolved ? 'resolve the conversation' : 'unresolve the conversation');
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function commentPayload(c: DraftReviewComment) {
  return c.line === null ? { path: c.path, body: c.body, subject_type: 'file' } : { path: c.path, body: c.body, line: c.line, side: c.side };
}

/** One review comment outside a review (immediately visible). */
export async function addReviewComment(c: GitHubClient, r: RepoCoords, number: number, commitId: string, comment: DraftReviewComment) {
  await c.rest('POST', `${repoPath(r)}/pulls/${number}/comments`, { body: { commit_id: commitId, ...commentPayload(comment) }, action: 'add the review comment' });
}

/** Submits a review with its pending comments in one request (nothing is posted until submit). */
export async function submitReview(c: GitHubClient, r: RepoCoords, number: number, p: { commitId: string; event: ReviewEvent; body: string; comments: DraftReviewComment[] }) {
  try {
    const res = await c.rest<{ id: number; state: string; html_url: string }>('POST', `${repoPath(r)}/pulls/${number}/reviews`, {
      body: { commit_id: p.commitId, event: p.event, body: p.body || undefined, comments: p.comments.map(commentPayload) },
      action: 'submit the review',
    });
    return { id: res.data.id, state: res.data.state, url: res.data.html_url };
  } catch (err) {
    if (err instanceof AppError && err.friendly.code === 'validation' && /own pull request/i.test(err.friendly.message)) {
      throw new AppError({ code: 'own-pr', title: 'Cannot Review Your Own Pull Request', message: 'GitHub does not allow approving or requesting changes on your own pull request. Submit a comment instead.', technical: err.friendly.technical });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sidebar: reviewers, assignees, labels, milestone
// ---------------------------------------------------------------------------

export async function updateReviewers(c: GitHubClient, r: RepoCoords, number: number, add: string[], remove: string[]) {
  if (add.length) await c.rest('POST', `${repoPath(r)}/pulls/${number}/requested_reviewers`, { body: { reviewers: add }, action: 'request reviewers' });
  if (remove.length) await c.rest('DELETE', `${repoPath(r)}/pulls/${number}/requested_reviewers`, { body: { reviewers: remove }, action: 'remove reviewers' });
}

export async function updateAssignees(c: GitHubClient, r: RepoCoords, number: number, add: string[], remove: string[]) {
  if (add.length) await c.rest('POST', `${repoPath(r)}/issues/${number}/assignees`, { body: { assignees: add }, action: 'assign users' });
  if (remove.length) await c.rest('DELETE', `${repoPath(r)}/issues/${number}/assignees`, { body: { assignees: remove }, action: 'remove assignees' });
}

export async function setLabels(c: GitHubClient, r: RepoCoords, number: number, labels: string[]) {
  await c.rest('PUT', `${repoPath(r)}/issues/${number}/labels`, { body: { labels }, action: 'change labels' });
}

export async function createLabel(c: GitHubClient, r: RepoCoords, label: { name: string; color: string; description?: string }) {
  await c.rest('POST', `${repoPath(r)}/labels`, { body: label, action: 'create the label' });
}

export async function setMilestone(c: GitHubClient, r: RepoCoords, number: number, milestone: number | null) {
  await c.rest('PATCH', `${repoPath(r)}/issues/${number}`, { body: { milestone }, action: 'change the milestone' });
}

// ---------------------------------------------------------------------------
// Checks: logs and re-runs
// ---------------------------------------------------------------------------

export async function getJobLogs(c: GitHubClient, r: RepoCoords, jobId: number) {
  return c.downloadText(`${repoPath(r)}/actions/jobs/${jobId}/logs`, 512 * 1024, 'download the logs');
}

export async function rerunJob(c: GitHubClient, r: RepoCoords, jobId: number) {
  await c.rest('POST', `${repoPath(r)}/actions/jobs/${jobId}/rerun`, { action: 're-run the job' });
}

// ---------------------------------------------------------------------------
// Layered listing: search → repository connection → (caller) GitHub CLI
// ---------------------------------------------------------------------------

/** The user's query scoped to this repository: "repo:o/n is:pr …". */
export function effectiveSearch(r: RepoCoords, q: PrListQuery): string {
  if (q.raw === undefined) return buildPrSearchQuery(r, q);
  return `repo:${r.owner}/${r.name} ${ensurePr(scopeToRepo(q.raw.replace(/\\/g, ' ')))}`.trim();
}

/** Open / closed / merged totals straight from the repository (null when the token cannot see it). */
export async function prCounts(c: GitHubClient, r: RepoCoords): Promise<{ open: number; closed: number; merged: number } | null> {
  const d = await c.graphql<{ repository: { open: { totalCount: number }; closed: { totalCount: number }; merged: { totalCount: number } } | null }>(
    `query($o: String!, $n: String!) { repository(owner: $o, name: $n) {
      open: pullRequests(states: OPEN) { totalCount } closed: pullRequests(states: CLOSED) { totalCount } merged: pullRequests(states: MERGED) { totalCount } } }`,
    { o: r.owner, n: r.name },
    'count pull requests',
  );
  const x = d.repository;
  return x ? { open: x.open.totalCount, closed: x.closed.totalCount, merged: x.merged.totalCount } : null;
}

/** Does a pull request match the simple qualifiers of a query? (Used when search is unavailable.) */
export function matchesQuery(p: PrListItem, raw: string): boolean {
  for (const t of tokenize(raw)) {
    const v = t.value.toLowerCase();
    let ok = true;
    switch (t.key) {
      case null:
        ok = p.title.toLowerCase().includes(v) || String(p.number) === v.replace(/^#/, '');
        break;
      case 'author':
        ok = (p.author?.login ?? '').toLowerCase() === v;
        break;
      case 'label':
        ok = p.labels.some((l) => l.name.toLowerCase() === v);
        break;
      case 'assignee':
        ok = p.assignees.some((a) => a.login.toLowerCase() === v);
        break;
      case 'base':
        ok = p.baseRefName.toLowerCase() === v;
        break;
      case 'head':
        ok = p.headRefName.toLowerCase() === v;
        break;
      case 'milestone':
        ok = (p.milestone ?? '').toLowerCase() === v;
        break;
      case 'draft':
        ok = p.isDraft === (v === 'true');
        break;
      case 'is':
        if (v !== 'draft') continue; // state is handled by the query itself
        ok = p.isDraft;
        break;
      case 'review':
        if (!['approved', 'changes_requested', 'required', 'none'].includes(v)) continue;
        ok = v === 'approved' ? p.reviewDecision === 'APPROVED' : v === 'changes_requested' ? p.reviewDecision === 'CHANGES_REQUESTED' : v === 'required' ? p.reviewDecision === 'REVIEW_REQUIRED' : !p.reviewDecision;
        break;
      case 'status':
        ok = (p.checks ?? '').toLowerCase() === (v === 'success' ? 'success' : v === 'failure' ? 'failure' : 'pending');
        break;
      case 'no':
        if (!['label', 'assignee', 'milestone'].includes(v)) continue;
        ok = v === 'label' ? !p.labels.length : v === 'assignee' ? !p.assignees.length : !p.milestone;
        break;
      default:
        continue; // Qualifiers that cannot be checked locally are ignored rather than hiding everything.
    }
    if (t.negated ? ok : !ok) return false;
  }
  return true;
}

/** Lists from repository.pullRequests — works even when the search index has nothing for this repository. */
export async function listFromRepository(c: GitHubClient, r: RepoCoords, raw: string, after: string | null): Promise<PrListResult> {
  const st = stateOf(raw);
  const states = st === 'all' ? ['OPEN', 'CLOSED', 'MERGED'] : [st.toUpperCase()];
  const sort = getQualifier(raw, 'sort') ?? 'created-desc';
  const field = sort.startsWith('updated') ? 'UPDATED_AT' : 'CREATED_AT';
  const direction = sort.endsWith('asc') ? 'ASC' : 'DESC';
  const d = await c.graphql<{ repository: { pullRequests: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; nodes: RawListPr[] } } | null }>(
    `query($o: String!, $n: String!, $after: String, $states: [PullRequestState!]) { repository(owner: $o, name: $n) {
      pullRequests(first: 50, after: $after, states: $states, orderBy: { field: ${field}, direction: ${direction} }) {
        totalCount pageInfo { endCursor hasNextPage } nodes { ${PR_LIST_FIELDS} } } } }`,
    { o: r.owner, n: r.name, after, states },
    'load pull requests',
  );
  const conn = d.repository?.pullRequests;
  if (!conn) throw new AppError({ code: 'not-found', title: 'Repository Not Visible', message: `The signed-in token cannot see ${r.owner}/${r.name}.` });
  const all = conn.nodes.map(toListItem);
  const items = all.filter((p) => matchesQuery(p, raw));
  const filtered = items.length !== all.length;
  return {
    items,
    total: filtered ? items.length : conn.totalCount,
    endCursor: conn.pageInfo.endCursor,
    hasNextPage: conn.pageInfo.hasNextPage,
    source: 'repository',
    notice: null,
    query: raw,
  };
}

/** Maps `gh pr list --json …` output to list items. */
export function fromGhJson(rows: Json[]): PrListItem[] {
  const rollup = (checks: Json[] | undefined): CheckState => {
    if (!checks?.length) return null;
    const states = checks.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
    if (states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(s))) return 'FAILURE';
    if (states.some((s) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', ''].includes(s))) return 'PENDING';
    return 'SUCCESS';
  };
  return rows.map((p) => {
    const reviewers = new Map<string, string>();
    for (const rv of p.latestReviews ?? []) if (rv.author?.login) reviewers.set(rv.author.login, rv.state);
    for (const rq of p.reviewRequests ?? []) {
      const who = rq.login ?? rq.name ?? rq.slug;
      if (who && !reviewers.has(who)) reviewers.set(who, 'REQUESTED');
    }
    return {
      id: p.id ?? `gh-${p.number}`,
      number: p.number,
      title: p.title ?? '',
      state: p.state === 'MERGED' ? 'MERGED' : p.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
      isDraft: !!p.isDraft,
      author: p.author?.login ? { login: String(p.author.login).replace(/^app\//, ''), avatarUrl: '' } : null,
      authorIsBot: !!p.author?.is_bot,
      assignees: (p.assignees ?? []).map((a: Json) => ({ login: a.login, avatarUrl: '' })),
      reviewers: [...reviewers].map(([login, state]) => ({ login, state })),
      labels: (p.labels ?? []).map((l: Json) => ({ name: l.name, color: l.color ?? '888888' })),
      milestone: p.milestone?.title ?? null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt ?? p.createdAt,
      comments: Array.isArray(p.comments) ? p.comments.length : 0,
      commits: Array.isArray(p.commits) ? p.commits.length : 0,
      changedFiles: p.changedFiles ?? 0,
      reviewDecision: p.reviewDecision || null,
      checks: rollup(p.statusCheckRollup),
      mergeable: p.mergeable ?? 'UNKNOWN',
      mergeStateStatus: p.mergeStateStatus ?? 'UNKNOWN',
      baseRefName: p.baseRefName ?? '',
      headRefName: p.headRefName ?? '',
    } as PrListItem;
  });
}

export const GH_LIST_FIELDS = 'id,number,title,state,isDraft,author,assignees,labels,milestone,createdAt,updatedAt,comments,changedFiles,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,baseRefName,headRefName,reviewRequests,latestReviews';
