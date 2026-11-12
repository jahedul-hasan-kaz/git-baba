// Types for the GitHub (API-backed) features: pull requests, reviews, merge,
// security & quality and actions. No credentials ever appear here.

import type { FileDiff } from './types';

export interface RepoRef {
  repoId: string;
}

export interface GhUser {
  login: string;
  avatarUrl?: string;
  name?: string | null;
}

export interface GhLabel {
  id?: string;
  name: string;
  color: string;
  description?: string | null;
}

export interface GhMilestone {
  number: number;
  title: string;
  state: 'open' | 'closed';
  dueOn?: string | null;
}

/** What the signed-in account may do in this repository (GitHub stays authoritative). */
export interface RepoPermissions {
  /** ADMIN | MAINTAIN | WRITE | TRIAGE | READ | NONE */
  level: string;
  canTriage: boolean;
  canWrite: boolean;
  canAdmin: boolean;
}

export interface GhRepoContext {
  owner: string;
  name: string;
  account: string;
  defaultBranch: string;
  isPrivate: boolean;
  ownerType: 'User' | 'Organization';
  permissions: RepoPermissions;
  mergeMethods: { merge: boolean; squash: boolean; rebase: boolean };
  /** True when the repository's associated account differs from the signed-in account. */
  accountMismatch: string | null;
  /** How Git Baba reaches GitHub for this repository: the account token, or the user's GitHub CLI login. */
  via?: 'token' | 'gh';
}

// ---------------- Sessions ----------------

/** Why the signed-in token may not create pull requests here, and what the GitHub CLI can do instead. */
export interface PrAccessDiagnosis {
  login: string;
  host: string;
  owner: string;
  name: string;
  ownerType: 'User' | 'Organization' | null;
  tokenKind: 'fine-grained' | 'classic';
  /** HTTP status of reading the repository with this token (200 = the token can see it). */
  repoStatus: number;
  repoMessage: string | null;
  /** Your role in the repository, as GitHub reports it to this token. */
  role: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | null;
  pullsReadable: boolean;
  cli: { installed: boolean; loggedIn: boolean; login: string | null; version: string | null };
}

export interface SessionStatus {
  accountId: string;
  login: string;
  active: boolean;
  expiresAt: string | null;
  scopes: string[] | null;
}

// ---------------- Pull request list ----------------

export type PrState = 'open' | 'closed' | 'merged' | 'all';
export type PrSort = 'best-match' | 'newest' | 'oldest' | 'recently-updated' | 'least-recently-updated' | 'most-comments' | 'least-comments';
export type ReviewFilter = '' | 'none' | 'required' | 'approved' | 'changes_requested' | 'reviewed-by-me' | 'review-requested-me';

export interface PrListQuery {
  state: PrState;
  sort: PrSort;
  author?: string;
  label?: string;
  milestone?: string;
  assignee?: string;
  review?: ReviewFilter;
  text?: string;
  after?: string | null;
  /** GitHub search syntax typed by the user ("is:open author:@me label:bug"); replaces the fields above. */
  raw?: string;
  /** Continue paging from the same source as the first page. */
  source?: PrListSource;
}

export type PrListSource = 'search' | 'repository' | 'gh';

export type CheckState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null;

export interface PrListItem {
  id: string;
  /** Author is a GitHub App (dependabot, renovate…); search needs "author:app/<name>". */
  authorIsBot?: boolean;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: GhUser | null;
  assignees: GhUser[];
  reviewers: { login: string; state: string }[];
  labels: GhLabel[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  commits: number;
  changedFiles: number;
  reviewDecision: string | null;
  checks: CheckState;
  mergeable: string;
  mergeStateStatus: string;
  baseRefName: string;
  headRefName: string;
}

export interface PrListResult {
  items: PrListItem[];
  total: number;
  endCursor: string | null;
  hasNextPage: boolean;
  /** Where the list came from: GitHub search, the repository directly, or the user's GitHub CLI. */
  source?: PrListSource;
  /** Why a fallback source was used, shown above the list. */
  notice?: string | null;
  /** The query as GitHub received it. */
  query?: string;
  /** Totals per state, when the token can read the repository. */
  counts?: { open: number; closed: number; merged: number } | null;
}

// ---------------- Repository metadata (for pickers) ----------------

export interface RepoMetadata {
  labels: GhLabel[];
  milestones: GhMilestone[];
  assignableUsers: GhUser[];
  branches: string[];
}

// ---------------- Pull request details ----------------

export interface GhComment {
  id: string;
  databaseId: number;
  author: GhUser | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  viewerCanUpdate: boolean;
  url: string;
}

export interface ReviewThreadComment extends GhComment {
  path: string;
  line: number | null;
  originalLine: number | null;
  diffHunk: string;
  replyToId: number | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  path: string;
  line: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  comments: ReviewThreadComment[];
}

export type TimelineEvent =
  | { type: 'comment'; at: string; comment: GhComment }
  | { type: 'review'; at: string; id: string; author: GhUser | null; state: string; body: string; url: string }
  | { type: 'commit'; at: string; oid: string; message: string; author: string }
  | { type: 'event'; at: string; actor: string | null; text: string };

export interface PrCheck {
  id: string;
  kind: 'check-run' | 'status';
  name: string;
  workflow: string | null;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped' | 'neutral';
  rawStatus: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  /** Actions job id (logs / re-run) when this check is a GitHub Actions job. */
  jobId: number | null;
  runId: number | null;
  isRequired: boolean;
}

export interface PrDetails extends PrListItem {
  body: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  headRepository: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  mergeCommitOid: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  viewerCanUpdate: boolean;
  viewerDidAuthor: boolean;
  linkedIssues: { number: number; title: string; url: string; state: string }[];
  timeline: TimelineEvent[];
  reviewThreads: ReviewThread[];
  latestReviews: { author: string; state: string; submittedAt: string | null }[];
  requestedReviewers: string[];
  checksSummary: { total: number; passed: number; failed: number; pending: number };
  permissions: RepoPermissions;
}

export interface PrCommit {
  oid: string;
  shortOid: string;
  headline: string;
  message: string;
  author: string;
  authorLogin: string | null;
  date: string;
  additions: number;
  deletions: number;
  changedFiles: number | null;
  /** Combined check state of this commit (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED), null when none ran. */
  checkState: string | null;
}

/** Checks of any commit or branch, for the "Checks & security" view. */
export interface RefChecks {
  ref: string;
  oid: string;
  headline: string;
  date: string | null;
  state: string | null;
  checks: PrCheck[];
}

/** Pull request actions that can run through the user's own GitHub CLI login. */
export type PrCliAction = 'checkout' | 'comment' | 'approve' | 'request-changes' | 'review-comment' | 'merge' | 'ready' | 'draft' | 'close' | 'reopen' | 'edit-title';

export interface PrFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  binary: boolean;
  /** Patch omitted by GitHub (too large) — show "load diff" / view on GitHub. */
  tooLarge: boolean;
  diff: FileDiff | null;
}

export interface PrFilesResult {
  files: PrFile[];
  truncated: boolean;
  headOid: string;
}

// ---------------- Reviews ----------------

export interface DraftReviewComment {
  path: string;
  /** null = file-level comment */
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

// ---------------- Merge ----------------

export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type RequirementState = 'passed' | 'failed' | 'pending' | 'warning' | 'info';

export interface MergeRequirement {
  id: string;
  label: string;
  state: RequirementState;
  detail: string;
}

export interface MergeRule {
  source: string;
  type: string;
  description: string;
}

export interface PreMergeReport {
  prNumber: number;
  title: string;
  headOid: string;
  baseRefName: string;
  headRefName: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  requirements: MergeRequirement[];
  rules: MergeRule[];
  rulesReadable: boolean;
  mergeMethods: { merge: boolean; squash: boolean; rebase: boolean };
  defaultMethod: MergeMethod;
  /** Overall summary; informational only — the merge button is never disabled by it. */
  summary: RequirementState;
  authOptions: MergeAuthOption[];
  account: string;
  githubApp: { appId: string; owner: string; repo: string } | null;
}

export interface MergeAuthOption {
  id: 'session' | 'github-app' | 'ssh';
  label: string;
  description: string;
  available: boolean;
  reason?: string;
}

export interface MergeAuthInput {
  method: 'session' | 'github-app';
  /** GitHub App inputs (same as the existing App token workflow). */
  appId?: string;
  keyHandle?: string;
  privateKey?: string;
  useSavedKey?: boolean;
  installationId?: string;
}

/**
 * Authentication for one sensitive GitHub API operation (running a workflow, committing a workflow file):
 * re-confirm the signed-in account with its token, a personal access token, or a GitHub App installation token.
 */
export interface ApiAuthInput {
  method: 'session' | 'pat' | 'github-app';
  /** session: the account's token (or its remembered credential) to re-verify who is acting. */
  credential?: import('./types').AccountCredentialInput;
  /** pat */
  token?: string;
  /** github-app */
  appId?: string;
  keyHandle?: string;
  privateKey?: string;
  useSavedKey?: boolean;
  installationId?: string;
}

export interface StarterWorkflow {
  id: string;
  category: 'deployments' | 'ci' | 'automation' | 'code-scanning' | 'pages';
  name: string;
  description: string;
  creator: string | null;
  /** Languages / frameworks the template targets (from its properties file). */
  tags: string[];
  /** Matches a language of this repository. */
  suggested: boolean;
}

export interface MarketplaceAction {
  fullName: string;
  description: string | null;
  stars: number;
  url: string;
  owner: string;
  verifiedOwner: boolean;
}

export interface RepoTag {
  name: string;
  sha: string;
}

export interface MergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
  authDescription: string;
}

// ---------------- Security & Quality ----------------

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'warning' | 'note' | 'error' | 'none' | string;

export interface CodeScanningAlert {
  number: number;
  state: 'open' | 'dismissed' | 'fixed' | string;
  severity: AlertSeverity;
  securitySeverity: string | null;
  rule: { id: string; name: string; description: string; tags: string[] };
  tool: string;
  toolVersion: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  message: string;
  ref: string | null;
  createdAt: string;
  updatedAt: string;
  dismissedReason: string | null;
  url: string;
  isQuality: boolean;
}

export interface DependabotAlert {
  number: number;
  state: 'open' | 'dismissed' | 'fixed' | 'auto_dismissed' | string;
  package: string;
  ecosystem: string;
  manifest: string;
  scope: string | null;
  severity: AlertSeverity;
  ghsaId: string;
  cveId: string | null;
  summary: string;
  description: string;
  vulnerableRange: string;
  patchedVersion: string | null;
  cvss: number | null;
  createdAt: string;
  updatedAt: string;
  dismissedReason: string | null;
  url: string;
  references: string[];
}

export interface SecurityOverview {
  vulnerabilityAlertsEnabled: boolean | null;
  automatedSecurityFixes: boolean | null;
  dependabotConfig: boolean | null;
  secretScanning: string | null;
  codeScanningConfigured: boolean | null;
  advancedSecurity: string | null;
  notes: string[];
}

export interface SecurityList<T> {
  items: T[];
  page: number;
  hasMore: boolean;
  /** Feature unavailable (disabled / not licensed / no permission) — shown instead of an error. */
  unavailable: string | null;
}

// ---------------- Actions ----------------

/** A workflow that looks at pull request labels (e.g. a "guard" that needs a label before it passes). */
export interface LabelGate {
  workflowId: number;
  name: string;
  path: string;
  /** Labels the workflow looks for (any one of them satisfies a "contains" check). */
  requiredLabels: string[];
  /** Labels whose presence makes the workflow fail or skip (negated checks). */
  blockingLabels: string[];
  /** The workflow lists `labeled` / `unlabeled` among its pull_request types: GitHub starts it by itself when a label changes. */
  reactsToLabeling: boolean;
  onPullRequest: boolean;
}

export interface Workflow {
  id: number;
  name: string;
  path: string;
  state: string;
  url: string;
  lastRun: WorkflowRun | null;
  dispatchable: boolean | null;
}

export interface WorkflowRun {
  id: number;
  name: string;
  workflowId: number;
  runNumber: number;
  attempt: number;
  event: string;
  branch: string | null;
  sha: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  durationMs: number | null;
  actor: string | null;
  title: string;
  url: string;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: { name: string; status: string; conclusion: string | null; number: number; startedAt?: string | null; completedAt?: string | null }[];
  runnerName?: string | null;
  labels?: string[];
  url?: string | null;
}

export interface DispatchInput {
  name: string;
  description: string;
  required: boolean;
  default: string | null;
  type: string;
  options: string[];
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  path: string;
  /** How it can be enabled: as a workflow file, a config file, or only through GitHub settings. */
  kind: 'workflow' | 'config' | 'guided';
  marketplaceUrl: string;
}

export interface WorkflowProposal {
  template: WorkflowTemplate;
  path: string;
  content: string;
  existing: string | null;
  existingSha: string | null;
  defaultBranch: string;
  /** Guided templates explain steps instead of writing files. */
  guidance: string[];
}

/** "About" panel of the Code tab: repository stats, contributors, languages and deployments. */
export interface RepoOverview {
  fullName: string;
  description: string | null;
  homepage: string | null;
  topics: string[];
  license: string | null;
  htmlUrl: string;
  isPrivate: boolean;
  isFork: boolean;
  parent: string | null;
  defaultBranch: string;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  viewerStarred: boolean | null;
  contributors: { login: string; avatarUrl: string; contributions: number; url: string }[];
  contributorsTotal: number | null;
  languages: Record<string, number>;
  deployments: { id: number; environment: string; ref: string; sha: string; createdAt: string; creator: string | null; state: string; url: string | null }[];
  releases: { name: string; tag: string; publishedAt: string | null; url: string; prerelease: boolean }[];
}

// ---------------- Account centre ----------------

export interface ContributionDay {
  date: string;
  count: number;
  /** 0 (none) … 4 (most), GitHub's quartiles. */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface AccountProfile {
  login: string;
  name: string | null;
  avatarUrl: string;
  url: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  twitter: string | null;
  email: string | null;
  hireable: boolean;
  createdAt: string;
  followers: number;
  following: number;
  ownedRepos: number;
  starred: number;
  organizations: { login: string; avatarUrl: string }[];
  contributions: {
    year: number;
    total: number;
    commits: number;
    pullRequests: number;
    reviews: number;
    issues: number;
    reposContributed: number;
    weeks: ContributionDay[][];
    topRepos: { name: string; count: number }[];
    currentStreak: number;
    longestStreak: number;
    busiestDay: ContributionDay | null;
  };
  /** Years with contributions, newest first. */
  years: number[];
}

export interface AccountRepo {
  fullName: string;
  owner: string;
  name: string;
  url: string;
  description: string | null;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  sizeKb: number;
  stars: number;
  forks: number;
  language: string | null;
  languageColor: string | null;
  pushedAt: string | null;
  permission: string | null;
  defaultBranch: string | null;
  commits: number | null;
  tags: number | null;
  /** null when the account cannot see collaborators (needs push access). */
  collaborators: number | null;
}

export interface PublicProfilePatch {
  name?: string;
  blog?: string;
  company?: string;
  location?: string;
  bio?: string;
  twitter_username?: string;
  hireable?: boolean;
}

export interface GhSshKey {
  id: number;
  title: string;
  key: string;
  createdAt: string | null;
  kind: 'authentication' | 'signing';
  verified?: boolean;
  readOnly?: boolean;
}

export interface GhGpgKey {
  id: number;
  keyId: string;
  emails: { email: string; verified: boolean }[];
  createdAt: string | null;
  expiresAt: string | null;
  canSign: boolean;
  revoked: boolean;
  subkeys: number;
}

/** A GitHub token permission the account-level key endpoints need. */
export interface KeyPermissionNeed {
  /** What it unlocks, e.g. "SSH authentication keys". */
  label: string;
  /** Fine-grained token → Account permissions → this name (Read and write). */
  fineGrained: string;
  /** Classic token scope. */
  classic: string;
}

/** Whether the signed-in token may read the account's keys; when not, which permissions to add. */
export interface KeyListAccess {
  ok: boolean;
  tokenKind: 'fine-grained' | 'classic';
  missing: KeyPermissionNeed[];
  /** https://github.com (or the GHES web host) for settings links. */
  webBase: string;
}

export interface LocalGpgKey {
  keyId: string;
  fingerprint: string;
  uid: string;
  algorithm: string;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface RegisteredApp {
  id: string;
  appId: string;
  name: string;
  slug: string;
  owner: string;
  apiBase: string;
  htmlUrl: string;
  permissions: Record<string, string>;
  events: string[];
  addedAt: string;
  hasKey: boolean;
}

export interface AppInstallationInfo {
  id: number;
  account: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
  repositories: string[] | null;
  htmlUrl: string;
  suspended: boolean;
  createdAt: string | null;
}

export interface CredentialOverview {
  accounts: { login: string; remembered: boolean; signedIn: boolean; scopes: string[] | null; host: string }[];
  repoPats: { repo: string; username: string }[];
  repoAppKeys: { repo: string; appId: string | null }[];
  repoSshKeys: { repo: string; keyFile: string }[];
  apps: RegisteredApp[];
  installationTokens: { active: number; revoked: number; total: number };
  encryptionAvailable: boolean;
}

// ---------------- Repository administration ----------------

export type SecretScope = 'repo' | 'env' | 'org' | 'copilot';

export interface GhSecret {
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Organisation secrets: who can use them. */
  visibility?: 'all' | 'private' | 'selected';
}

export interface SecretsOverview {
  repo: GhSecret[] | null;
  repoError: string | null;
  environments: { name: string; protected: boolean; secrets: GhSecret[] | null; error: string | null }[];
  org: { name: string; secrets: GhSecret[] | null; manageable: boolean; error: string | null } | null;
  copilot: { exists: boolean; secrets: GhSecret[] | null; error: string | null };
}

export interface DeployKey {
  id: number;
  title: string;
  key: string;
  readOnly: boolean;
  verified: boolean;
  createdAt: string | null;
  lastUsed: string | null;
  addedBy: string | null;
}

/** Head commit of a branch or tag (best effort; null when GitHub did not return it). */
export interface RefCommitInfo {
  date: string | null;
  author: string | null;
  message: string | null;
}

export interface RemoteBranch extends Partial<RefCommitInfo> {
  name: string;
  sha: string;
  protected: boolean;
}

export interface RemoteTag extends Partial<RefCommitInfo> {
  name: string;
  sha: string;
}

export interface RemoteCommit {
  sha: string;
  message: string;
  author: string | null;
  avatarUrl: string | null;
  date: string | null;
  url: string;
  verified: boolean;
}
