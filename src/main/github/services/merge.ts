import type { MergeMethod, MergeRequirement, MergeRule, PrCheck, RequirementState } from '../../../shared/github';
import { AppError } from '../../git/errors';
import type { GitHubClient } from '../client/GitHubClient';
import { mapCheck, type RepoCoords } from './pullRequests';

const enc = encodeURIComponent;

export interface MergeState {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  headRefOid: string;
  baseRefName: string;
  headRefName: string;
  mergeCommitOid: string | null;
  unresolvedThreads: number;
  checks: PrCheck[];
  viewerPermission: string;
  mergeMethods: { merge: boolean; squash: boolean; rebase: boolean };
  viewerDefaultMergeMethod: string | null;
}

export async function loadMergeState(c: GitHubClient, r: RepoCoords, number: number): Promise<MergeState> {
  const d = await c.graphql<{ repository: { viewerPermission: string; mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean; viewerDefaultMergeMethod: string | null; pullRequest: Record<string, any> | null } }>( // eslint-disable-line @typescript-eslint/no-explicit-any
    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
      pullRequest(number: $number) {
        number title state isDraft mergeable mergeStateStatus reviewDecision headRefOid baseRefName headRefName mergeCommit { oid }
        reviewThreads(first: 100) { nodes { isResolved } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename
          ... on CheckRun { id databaseId name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber: $number) checkSuite { workflowRun { databaseId workflow { name } } } }
          ... on StatusContext { id context state targetUrl createdAt description isRequired(pullRequestNumber: $number) }
        } } } } } }
      } } }`,
    { owner: r.owner, name: r.name, number },
    'check the merge requirements',
  );
  const p = d.repository?.pullRequest;
  if (!p) throw new AppError({ code: 'not-found', title: 'Pull Request Not Found', message: `#${number} no longer exists or is not visible.` });
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus,
    reviewDecision: p.reviewDecision,
    headRefOid: p.headRefOid,
    baseRefName: p.baseRefName,
    headRefName: p.headRefName,
    mergeCommitOid: p.mergeCommit?.oid ?? null,
    unresolvedThreads: (p.reviewThreads?.nodes ?? []).filter((t: { isResolved: boolean }) => !t.isResolved).length,
    checks: (p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map(mapCheck),
    viewerPermission: d.repository.viewerPermission,
    mergeMethods: { merge: d.repository.mergeCommitAllowed, squash: d.repository.squashMergeAllowed, rebase: d.repository.rebaseMergeAllowed },
    viewerDefaultMergeMethod: d.repository.viewerDefaultMergeMethod,
  };
}

/** Rules that apply to the base branch (rulesets are readable with read access). */
export async function loadBranchRules(c: GitHubClient, r: RepoCoords, branch: string): Promise<{ rules: MergeRule[]; readable: boolean; raw: { type: string; parameters?: Record<string, unknown> }[] }> {
  const rules: MergeRule[] = [];
  let readable = true;
  let raw: { type: string; parameters?: Record<string, unknown>; ruleset_source?: string }[] = [];
  try {
    raw = await c.get(`/repos/${enc(r.owner)}/${enc(r.name)}/rules/branches/${enc(branch)}`, { action: 'read the branch rules' });
    for (const rule of raw) rules.push({ source: `Ruleset${rule.ruleset_source ? ` (${rule.ruleset_source})` : ''}`, type: rule.type, description: describeRule(rule.type, rule.parameters ?? {}) });
  } catch {
    readable = false;
  }
  try {
    const b = await c.get<{ protected: boolean; protection?: { required_status_checks?: { contexts?: string[]; enforcement_level?: string } } }>(`/repos/${enc(r.owner)}/${enc(r.name)}/branches/${enc(branch)}`, { action: 'read the branch' });
    if (b.protected) {
      const contexts = b.protection?.required_status_checks?.contexts ?? [];
      rules.push({ source: 'Branch protection', type: 'branch_protection', description: `“${branch}” is a protected branch${contexts.length ? `; required status checks: ${contexts.join(', ')}` : ''}.` });
    }
  } catch {
    // branch details unavailable — rules above (if any) still apply
  }
  return { rules, readable, raw };
}

export function describeRule(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case 'pull_request': {
      const n = Number(p.required_approving_review_count ?? 0);
      const extras = [p.require_code_owner_review ? 'code owner review' : '', p.required_review_thread_resolution ? 'all conversations resolved' : '', p.dismiss_stale_reviews_on_push ? 'stale approvals dismissed on push' : ''].filter(Boolean);
      return `Changes must be made through a pull request with ${n} approving review${n === 1 ? '' : 's'}${extras.length ? `, ${extras.join(', ')}` : ''}.`;
    }
    case 'required_status_checks': {
      const checks = ((p.required_status_checks as { context: string }[]) ?? []).map((x) => x.context);
      return `Required status checks: ${checks.join(', ') || '(any)'}${p.strict_required_status_checks_policy ? ' — branch must be up to date' : ''}.`;
    }
    case 'required_linear_history':
      return 'Linear history required (merge commits are not allowed — use squash or rebase).';
    case 'required_signatures':
      return 'Commits must have verified signatures.';
    case 'merge_queue':
      return 'Merges go through a merge queue.';
    case 'required_deployments':
      return `Successful deployment required: ${((p.required_deployment_environments as string[]) ?? []).join(', ')}.`;
    case 'non_fast_forward':
      return 'Force pushes are blocked.';
    case 'deletion':
      return 'Branch deletion is restricted.';
    case 'update':
      return 'Updates to the branch are restricted.';
    case 'creation':
      return 'Branch creation is restricted.';
    case 'code_scanning':
      return 'Code scanning results must meet the configured thresholds.';
    default:
      return type.replace(/_/g, ' ');
  }
}

const ORDER: RequirementState[] = ['passed', 'info', 'pending', 'warning', 'failed'];
export const worst = (states: RequirementState[]) => states.reduce<RequirementState>((w, s) => (ORDER.indexOf(s) > ORDER.indexOf(w) ? s : w), 'passed');

/**
 * Turns the GitHub state into a checklist. Purely informational: the merge button stays
 * enabled, and GitHub's own merge response is the final word.
 */
export function evaluateMerge(s: MergeState, rawRules: { type: string; parameters?: Record<string, unknown> }[]): MergeRequirement[] {
  const req: MergeRequirement[] = [];
  if (s.state === 'MERGED') req.push({ id: 'state', label: 'Pull request state', state: 'info', detail: `Already merged${s.mergeCommitOid ? ` as ${s.mergeCommitOid.slice(0, 7)}` : ''}.` });
  else if (s.state === 'CLOSED') req.push({ id: 'state', label: 'Pull request state', state: 'failed', detail: 'The pull request is closed. Reopen it before merging.' });
  else req.push({ id: 'state', label: 'Pull request state', state: 'passed', detail: 'Open.' });
  if (s.isDraft) req.push({ id: 'draft', label: 'Draft', state: 'failed', detail: 'Draft pull requests cannot be merged. Mark it ready for review first.' });

  if (s.mergeable === 'CONFLICTING' || s.mergeStateStatus === 'DIRTY') req.push({ id: 'conflicts', label: 'Merge conflicts', state: 'failed', detail: `${s.headRefName} has conflicts with ${s.baseRefName} that must be resolved.` });
  else if (s.mergeable === 'UNKNOWN') req.push({ id: 'conflicts', label: 'Merge conflicts', state: 'pending', detail: 'GitHub is still checking for conflicts.' });
  else req.push({ id: 'conflicts', label: 'Merge conflicts', state: 'passed', detail: 'No conflicts with the base branch.' });

  const required = s.checks.filter((c) => c.isRequired);
  const failedReq = required.filter((c) => c.status === 'failed' || c.status === 'cancelled');
  const pendingReq = required.filter((c) => c.status === 'pending' || c.status === 'running');
  if (required.length) {
    req.push({
      id: 'required-checks',
      label: 'Required checks',
      state: failedReq.length ? 'failed' : pendingReq.length ? 'pending' : 'passed',
      detail: failedReq.length ? `Failing: ${failedReq.map((c) => c.name).join(', ')}` : pendingReq.length ? `Waiting for: ${pendingReq.map((c) => c.name).join(', ')}` : `${required.length} required check(s) passed.`,
    });
  }
  const optional = s.checks.filter((c) => !c.isRequired);
  const failedOpt = optional.filter((c) => c.status === 'failed' || c.status === 'cancelled');
  const pendingOpt = optional.filter((c) => c.status === 'pending' || c.status === 'running');
  if (optional.length) {
    req.push({
      id: 'checks',
      label: required.length ? 'Other checks' : 'Checks',
      state: failedOpt.length ? 'warning' : pendingOpt.length ? 'pending' : 'passed',
      detail: failedOpt.length ? `Failing: ${failedOpt.map((c) => c.name).join(', ')}` : pendingOpt.length ? `${pendingOpt.length} still running` : `${optional.length} check(s) passed.`,
    });
  }
  if (!s.checks.length) req.push({ id: 'checks', label: 'Checks', state: 'info', detail: 'No checks reported for the latest commit.' });

  const prRule = rawRules.find((r) => r.type === 'pull_request');
  const approvalsNeeded = Number(prRule?.parameters?.required_approving_review_count ?? 0);
  if (s.reviewDecision === 'APPROVED') req.push({ id: 'reviews', label: 'Reviews', state: 'passed', detail: 'Approved.' });
  else if (s.reviewDecision === 'CHANGES_REQUESTED') req.push({ id: 'reviews', label: 'Reviews', state: 'failed', detail: 'Changes were requested by a reviewer.' });
  else if (s.reviewDecision === 'REVIEW_REQUIRED') req.push({ id: 'reviews', label: 'Reviews', state: 'failed', detail: `Approval required${approvalsNeeded ? ` (${approvalsNeeded} approving review${approvalsNeeded === 1 ? '' : 's'})` : ''}.` });
  else req.push({ id: 'reviews', label: 'Reviews', state: 'info', detail: 'No review is required by the repository settings that GitHub reports.' });

  if (s.unresolvedThreads > 0) {
    const required = !!prRule?.parameters?.required_review_thread_resolution;
    req.push({ id: 'conversations', label: 'Conversations', state: required ? 'failed' : 'warning', detail: `${s.unresolvedThreads} unresolved conversation(s)${required ? ' — resolution is required' : ''}.` });
  } else req.push({ id: 'conversations', label: 'Conversations', state: 'passed', detail: 'All conversations resolved.' });

  if (s.mergeStateStatus === 'BEHIND') req.push({ id: 'up-to-date', label: 'Branch up to date', state: 'warning', detail: `${s.headRefName} is behind ${s.baseRefName}; the base branch requires it to be up to date.` });
  if (s.mergeStateStatus === 'BLOCKED') req.push({ id: 'blocked', label: 'Protection rules', state: 'warning', detail: 'GitHub reports the merge as blocked by branch protection or rulesets. You can still try — GitHub decides.' });
  if (rawRules.some((r) => r.type === 'required_signatures')) req.push({ id: 'signatures', label: 'Signed commits', state: 'info', detail: 'The base branch requires verified signatures.' });

  const rank = { NONE: 0, READ: 1, TRIAGE: 2, WRITE: 3, MAINTAIN: 4, ADMIN: 5 }[s.viewerPermission] ?? 0;
  if (rank < 3) req.push({ id: 'permission', label: 'Your permission', state: 'warning', detail: `Your role is ${s.viewerPermission.toLowerCase()}; merging usually needs write access.` });
  return req;
}

export function defaultMergeMethod(s: MergeState, rawRules: { type: string }[]): MergeMethod {
  const linear = rawRules.some((r) => r.type === 'required_linear_history');
  const preferred = (s.viewerDefaultMergeMethod ?? 'MERGE').toLowerCase() as MergeMethod;
  if (s.mergeMethods[preferred] && !(linear && preferred === 'merge')) return preferred;
  if (s.mergeMethods.squash) return 'squash';
  if (s.mergeMethods.rebase) return 'rebase';
  return 'merge';
}

/**
 * Performs the merge exactly for the reviewed head commit. GitHub's response is authoritative:
 * a rejection is shown with GitHub's own reason, never reported as success.
 */
export async function mergePullRequest(c: GitHubClient, r: RepoCoords, number: number, p: { method: MergeMethod; sha: string; title?: string; message?: string }): Promise<{ merged: boolean; sha: string | null; message: string }> {
  try {
    const res = await c.rest<{ merged: boolean; sha: string; message: string }>('PUT', `/repos/${enc(r.owner)}/${enc(r.name)}/pulls/${number}/merge`, {
      body: { merge_method: p.method, sha: p.sha, commit_title: p.title || undefined, commit_message: p.message || undefined },
      action: 'merge the pull request',
    });
    return { merged: res.data.merged, sha: res.data.sha ?? null, message: res.data.message };
  } catch (err) {
    if (err instanceof AppError && err.friendly.code === 'conflict') {
      const m = err.friendly.message;
      const headChanged = /head branch was modified|sha/i.test(m);
      throw new AppError({
        code: headChanged ? 'head-changed' : 'merge-rejected',
        title: headChanged ? 'Pull Request Changed' : 'GitHub Rejected the Merge',
        message: headChanged ? 'New commits were pushed after you reviewed the merge. Review it again.' : `GitHub's response: ${m}`,
        actions: ['retry'],
        technical: err.friendly.technical,
      });
    }
    throw err;
  }
}
