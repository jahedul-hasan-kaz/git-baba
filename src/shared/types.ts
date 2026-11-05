// Types shared by the main process and the renderer.
// Nothing in this file may carry a secret value back to the renderer except
// the explicit "reveal token" call, which is gated behind a user action.

export type AuthMethod = 'pat' | 'github-app' | 'ssh' | 'system' | 'none';

export interface GitHubAppConfig {
  appId: string;
  owner: string;
  repo: string;
  installationId?: string;
  /** Linked to an App registered at account level (its key comes from the account App registry). */
  registryId?: string;
}

export interface RepoSettings {
  /** Run the repository's Git hooks (pre-commit, pre-push…). Off by default: hooks are repository scripts. */
  runHooks: boolean;
  /** Allow the OS Git credential helper / ssh-agent to be offered as a push method. */
  allowSystemCredentials: boolean;
  /** Allow credentials saved (encrypted) for this repository to be offered in auth dialogs. */
  allowSavedCredentials: boolean;
  githubApp?: GitHubAppConfig;
  /** Override for GitHub Enterprise, e.g. https://ghe.example.com/api/v3 */
  apiBaseUrl?: string;
  patUsername?: string;
  /** Path of the SSH private key chosen for this repository (the path only — never the key or passphrase). */
  sshKeyPath?: string;
  /** GitHub account (app-level) associated with this repository. */
  accountId?: string;
  /**
   * How push, pull, fetch and merge authenticate by default. The dialogs preselect it; a linked
   * GitHub App still takes priority. Unset: whatever is already set up (remembered SSH key, saved
   * token), else the Git identity (system Git setup).
   */
  remoteAuth?: RemoteAuthPreference;
  /** Commit signing default: sign with the configured key, or commit unsigned. Unset: follow git config commit.gpgsign. */
  commitSigning?: CommitSigningPreference;
}

export type RemoteAuthPreference = 'ssh' | 'pat' | 'system';
export type CommitSigningPreference = 'signed' | 'unsigned';

export type OperationStatus = 'SUCCESS' | 'WARNING' | 'CANCELLED' | 'FAILED';

export interface LastOperation {
  operation: string;
  status: OperationStatus;
  at: string;
}

export interface RepoRecord {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  lastOperation?: LastOperation;
  /** Pinned to the top of the repository list. */
  favorite?: boolean;
  settings: RepoSettings;
}

/** One person who committed to the repository, derived from local history. */
export interface RepoContributor {
  name: string;
  email: string;
  commits: number;
  firstCommit: string;
  lastCommit: string;
  /** joined: first commit in the last 30 days; left: no commit in the last 90 days. */
  status: 'joined' | 'active' | 'left';
}

export interface SavedSecretsStatus {
  pat: boolean;
  githubAppKey: boolean;
  encryptionAvailable: boolean;
}

export interface RepoSummary extends RepoRecord {
  exists: boolean;
  branch: string | null;
  remoteUrl: string | null;
  changeCount: number;
  hasConflicts: boolean;
  authStatus: string;
  savedSecrets: SavedSecretsStatus;
  /** owner/repo when the primary remote is on GitHub (https or ssh). */
  github: { owner: string; repo: string } | null;
  /** Normalised identity, e.g. github.com/inride/agent (null for non-GitHub or no remote). */
  identity: string | null;
  /** Account associated with the repository (explicit or detected from the owner). */
  account: { id: string; login: string } | null;
  /** "personal" when the owner is the account itself, otherwise the organisation/owner name. */
  ownerLabel: string | null;
}

export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted';

export type ChangeArea = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

export interface FileChange {
  path: string;
  origPath?: string;
  kind: ChangeKind;
  area: ChangeArea;
  /** For conflicts: the two-letter porcelain code, e.g. UU, AA, DU. */
  conflictCode?: string;
}

export type InProgressOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;

export interface RepoStatus {
  branch: string | null;
  detached: boolean;
  headOid: string | null;
  upstream: string | null;
  /**
   * The branch tracks `upstream`, but that remote branch does not exist (yet): a clone of an empty
   * repository, or a remote branch that was deleted. Pushing creates it again.
   */
  upstreamGone?: boolean;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
  conflicted: FileChange[];
  operation: InProgressOperation;
}

export type DiffLineType = 'context' | 'add' | 'del' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface FileDiff {
  oldPath: string;
  newPath: string;
  status: DiffFileStatus;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  truncated?: boolean;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  /** The tracked remote branch no longer exists (deleted on the remote, or never pushed). */
  upstreamGone?: boolean;
  ahead?: number;
  behind?: number;
  oid: string;
  subject: string;
  /** Last commit date (ISO 8601). */
  date?: string;
}

/** Where a branch was started from. 'reflog' is recorded by Git; 'inferred' is the nearest other branch in its history. */
export interface BranchOrigin {
  from: string;
  source: 'reflog' | 'inferred';
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  protocol: RemoteProtocol;
  isGitHub: boolean;
  hasEmbeddedCredentials: boolean;
}

export type RemoteProtocol = 'https' | 'http' | 'ssh' | 'local' | 'unknown';

export interface GitIdentity {
  name: string | null;
  email: string | null;
  signingKey: string | null;
  gpgFormat: string | null;
  commitGpgSign: boolean;
}

export interface StashEntry {
  index: number;
  ref: string;
  message: string;
}

export type SigningMethod = 'none' | 'gpg' | 'ssh' | 'x509';

export interface AuthOption {
  method: AuthMethod;
  label: string;
  description: string;
  hasSaved?: boolean;
  /** For token methods on an SSH remote: the push/fetch goes over HTTPS to this URL for that one operation. */
  viaHttps?: string;
  /** For SSH on a GitHub HTTPS remote: the operation goes to this SSH URL. */
  viaSsh?: string;
}

/** Result of matching a public key to a private key file on this computer. */
export interface SshKeyMatch {
  type: string;
  fingerprint: string;
  comment: string;
  /** The private key found for it (null when none was found). */
  match: SshKeyInfo | null;
  searched: string;
}

/** An SSH private key file chosen through the native file dialog. */
export interface SshKeyInfo {
  /** Opaque id for this session; the renderer never sends raw paths. */
  handle: string;
  path: string;
  fileName: string;
  encrypted: boolean;
  fingerprint: string | null;
}

/** The SSH key file remembered for a repository (path only). */
export interface SavedSshKey {
  fileName: string;
  path: string;
  encrypted: boolean;
  fingerprint: string | null;
}

/** The SSH key + passphrase chosen for one push/fetch/clone. */
export interface SshKeyInput {
  keySource: 'agent' | 'file';
  /** Handle from ssh:pickKeyFile, or 'saved' for the path remembered in repo settings. */
  keyHandle?: string;
  passphrase?: string;
  rememberKeyPath?: boolean;
}

// ---- Auth input supplied by the user for one operation ----

export interface PatAuthInput {
  method: 'pat';
  username?: string;
  token?: string;
  useSaved?: boolean;
  saveForRepo?: boolean;
  /** Use the active GitHub account's sign-in (token stays in the main process). */
  useAccount?: boolean;
}

export interface GitHubAppAuthInput {
  method: 'github-app';
  appId: string;
  owner: string;
  repo: string;
  installationId?: string;
  privateKey?: string;
  keyHandle?: string;
  useSavedKey?: boolean;
  saveKeyForRepo?: boolean;
  /** 'generate' (default): create a scoped token for this operation. 'existing': use a token you already have. */
  tokenMode?: 'generate' | 'existing';
  /** A pasted installation token (tokenMode 'existing'). */
  existingToken?: string;
  /** Handle of a token generated instantly in the dialog (tokenMode 'existing'). */
  tokenHandle?: string;
  /** Save App ID / owner / repo (never the key) in the repository settings. */
  rememberApp?: boolean;
}

export type SshAuthInput = { method: 'ssh' } & SshKeyInput;

export type AuthInput =
  | PatAuthInput
  | GitHubAppAuthInput
  | SshAuthInput
  | { method: 'system' }
  | { method: 'none' };

// ---- Friendly errors ----

export type ErrorAction = 'review-auth' | 'retry' | 'pull' | 'resolve-conflicts' | 'set-identity' | 'open-settings' | 'switch-account';

export interface FriendlyError {
  code: string;
  title: string;
  message: string;
  reasons: string[];
  actions: ErrorAction[];
  technical?: string;
  /** Set when a push was rejected by repository rules / protection, with the parsed details. */
  pushRules?: PushRuleReport;
  /** Set when the repository belongs to another added account (code 'switch-account'). */
  switchAccount?: { accountId: string; login: string };
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: FriendlyError };

// ---- Push rejected by repository rules ----

export type PushRuleId =
  | 'secret'
  | 'file-size'
  | 'file-path'
  | 'file-extension'
  | 'path-length'
  | 'pull-request'
  | 'status-checks'
  | 'reviews'
  | 'signatures'
  | 'linear-history'
  | 'non-fast-forward'
  | 'restricted-ref'
  | 'commit-message'
  | 'email-pattern'
  | 'ref-name'
  | 'code-scanning'
  | 'deployments'
  | 'workflows'
  | 'unknown';

/** What the app can do (or explain) for a violation. */
export type PushRuleFix = 'drop-file' | 'push-to-branch' | 'unblock-secret' | 'sign-commits' | 'rebase' | 'reword' | 'pull-first' | 'admin';

export interface PushRuleViolation {
  id: PushRuleId;
  title: string;
  /** GitHub's own words for this rule. */
  githubMessage: string;
  explanation: string;
  /** What has to change for the push to be accepted. */
  needed: string;
  fixes: PushRuleFix[];
  locallyFixable: boolean;
  whoCanFix: string | null;
  files: { path: string; commit: string | null; line: number | null; sizeMb: number | null }[];
  commits: string[];
  /** Required status check names, when GitHub listed them. */
  checks: string[];
  unblockUrl: string | null;
  /** After a re-check: resolved locally, still present, or only GitHub can tell. */
  status: 'unchecked' | 'resolved' | 'still-present' | 'remote-only';
}

export interface PushRuleReport {
  kind: 'ruleset' | 'branch-protection' | 'push-protection' | 'file-size';
  ref: string | null;
  rulesUrl: string | null;
  violations: PushRuleViolation[];
  /** GitHub's message lines (redacted), for reference. */
  raw: string[];
  /** Unpushed commits that were part of the rejected push. */
  commits: { hash: string; shortHash: string; subject: string; author: string; email: string; isMerge: boolean }[];
  branch: string;
  remote: string;
  remoteBranch: string;
  /** Local fixes that rewrite unpushed commits are possible (branch checked out, no operation running). */
  canRewrite: boolean;
}

export interface DropFilePreview {
  path: string;
  /** Unpushed commits that change the file — these will be rewritten. */
  commits: { hash: string; shortHash: string; subject: string; change: string }[];
  /** Commits that would become empty and be dropped. */
  emptied: string[];
  totalUnpushed: number;
  /** What the file is reset to inside the commits (the version on the remote, or "absent"). */
  restoredTo: 'remote-version' | 'absent';
  workingCopyExists: boolean;
  signedCommits: number;
}

export interface DropFileResult {
  path: string;
  oldHead: string;
  newHead: string;
  rewritten: number;
  dropped: number;
  /** Backup ref pointing at the old history (undo). */
  backupRef: string;
}

// ---- Commit / push previews ----

export interface CommitPreview {
  confirmationId: string;
  repoName: string;
  branch: string | null;
  files: FileChange[];
  identity: GitIdentity;
  signingOptions: { method: SigningMethod; label: string; description: string }[];
  defaultSigning: SigningMethod;
  hooksEnabled: boolean;
  operation: InProgressOperation;
  savedSshKey: SavedSshKey | null;
  /** The active GitHub account the repository belongs to, offered as the commit author. */
  accountAuthor: { login: string; name: string; email: string } | null;
}

/** Everything an auth dialog needs to prefill itself for one repository. */
export interface AuthContext {
  authOptions: AuthOption[];
  githubApp?: GitHubAppConfig;
  savedSshKey: SavedSshKey | null;
  /** App-level GitHub account associated with the repository (shown before sensitive operations). */
  account: { id: string; login: string } | null;
}

export interface PushPreview extends AuthContext {
  confirmationId: string;
  repoName: string;
  branch: string;
  remote: string;
  remoteUrl: string;
  remoteBranch: string;
  headOid: string;
  commits: CommitInfo[];
  files: { path: string; status: string }[];
  isNewRemoteBranch: boolean;
  hooksEnabled: boolean;
  /** Changed files that are NOT committed and therefore NOT part of this push. */
  uncommittedFiles: string[];
}

// ---- SSH key management ----

/** A public key found in ~/.ssh (the public key text is not secret). */
export interface SshLocalKey extends SshKeyMatch {
  publicKey: string;
  pubPath: string;
}

export type SshKeyType = 'ed25519' | 'rsa' | 'ecdsa';

/** Result of `ssh -T git@github.com` with one specific key. */
export interface SshTestResult {
  ok: boolean;
  /** GitHub login (or owner/repo for a deploy key) the key authenticated as. */
  login: string | null;
  reason: 'ok' | 'denied' | 'passphrase-needed' | 'passphrase-wrong' | 'host-key' | 'network' | 'key-permissions' | 'no-ssh' | 'unknown';
  message: string;
  /** e.g. "ssh.github.com:443" when port 22 was blocked and the 443 fallback worked. */
  via: string | null;
  detail: string;
}

/** Global git commit-signing settings (read from `git config --global`). */
export interface SigningConfig {
  format: 'openpgp' | 'ssh' | 'x509' | null;
  signingKey: string | null;
  gpgProgram: string | null;
  commitGpgSign: boolean;
}

// ---- Branch operations (merge / create & publish / delete) ----

export interface BranchRemoteInfo {
  name: string;
  /** Redacted, for display. */
  url: string;
}

export interface BranchMergePreview extends AuthContext {
  confirmationId: string;
  source: string;
  target: string;
  sourceOid: string;
  targetOid: string;
  currentBranch: string | null;
  /**
   * up-to-date: target already contains source; fast-forward: target just moves; merge: a merge commit is created;
   * unrelated: the branches share no history (no merge base) — only possible with explicit "merge anyway".
   */
  state: 'up-to-date' | 'fast-forward' | 'merge' | 'unrelated';
  mergeBase: string | null;
  /** Commits only on the source / only on the target. */
  sourceOnly: number;
  targetOnly: number;
  commits: CommitInfo[];
  files: { path: string; status: string }[];
  /** Files predicted to conflict (null when the prediction is unavailable). */
  predictedConflicts: string[] | null;
  /** Uncommitted files (block switching to the target branch). */
  dirtyFiles: string[];
  remote: (BranchRemoteInfo & { remoteBranch: string; trackingExists: boolean; behindRemote: number; canFastForward: boolean }) | null;
  /** The source's own remote-tracking branch, when there is one. */
  sourceRemote: { ref: string; exists: boolean; localAhead: number; localBehind: number } | null;
  /** Everything found, explained in plain words, each with the fix the app can apply. */
  issues: MergeIssue[];
  /** Suggested name for a merge branch used to open a pull request. */
  suggestedBridge: string;
}

export type MergeIssueCategory = 'history' | 'git-conflict' | 'working-tree' | 'remote' | 'github-restriction' | 'auth';

export interface MergeIssue {
  id: string;
  category: MergeIssueCategory;
  severity: 'blocker' | 'warning' | 'info';
  title: string;
  explanation: string;
  /** Fix the dialog can offer for this issue. */
  fix: 'fetch' | 'fast-forward-target' | 'merge-anyway' | 'resolve-conflicts' | 'bridge-pr' | 'commit-or-stash' | null;
}

export type MergeConflictStrategy = 'stop' | 'prefer-target' | 'prefer-source';

export interface BranchMergeResult {
  outcome: 'merged' | 'fast-forward' | 'up-to-date' | 'conflicts';
  /** Set when the merge went into a new merge branch (for a pull request) instead of the target. */
  bridge: string | null;
  newOid: string | null;
  conflicted: string[];
  pushed: boolean;
  /** Set when the merge succeeded locally but publishing it failed. */
  pushError: FriendlyError | null;
  verifiedRemoteOid: string | null;
  returnedTo: string | null;
  authDescription: string;
  message: string;
}

export interface BranchPublishPreview extends AuthContext {
  confirmationId: string;
  name: string;
  base: string;
  baseOid: string;
  baseSubject: string;
  currentBranch: string | null;
  /** A local branch with this name already exists (e.g. from an earlier attempt). */
  localExists: boolean;
  localOid: string | null;
  remote: BranchRemoteInfo | null;
  /** Remote-tracking ref already exists (as of the last fetch). */
  remoteTrackingExists: boolean;
  pendingFiles: string[];
  /** Pending changes can only be committed when the branch starts from the current HEAD. */
  canCommitPending: boolean;
}

export interface BranchPublishResult {
  branch: string;
  oid: string;
  remote: string;
  verifiedRemoteOid: string;
  committed: CommitInfo | null;
  authDescription: string;
  summary: string;
}

export interface BranchDeletePreview extends AuthContext {
  confirmationId: string;
  local: { name: string; oid: string; current: boolean; merged: boolean; upstream: string | null } | null;
  remote:
    | (BranchRemoteInfo & {
        branch: string;
        oid: string | null;
        isDefault: boolean;
        /** Commits only on the remote branch (lost if it is deleted, even with the local branch kept). */
        uniqueCommits: number;
        /** Commits only on the remote and/or local branch (lost if both are deleted). */
        uniqueCommitsWithLocal: number;
      })
    | null;
}

// ---- Switching branches with uncommitted changes ----

/**
 * How an uncommitted file fares on the target branch:
 * safe – the target has the same version, it simply comes along;
 * merges – the target changed it too, but your changes merge cleanly;
 * conflict – your changes and the target's changes overlap;
 * blocked – an untracked file of yours exists on the target with other content.
 */
export type SwitchFileState = 'safe' | 'merges' | 'conflict' | 'blocked';

export type SwitchStrategy = 'carry' | 'stash' | 'stash-apply';

export interface BranchSwitchPreview {
  confirmationId: string;
  current: string | null;
  /** Local branch you end up on. */
  target: string;
  /** Ref switched to (refs/heads/… or a remote branch that will be checked out as a new local branch). */
  targetRef: string;
  targetOid: string;
  targetSubject: string;
  createsLocalFrom: string | null;
  files: { path: string; kind: ChangeKind; staged: boolean; state: SwitchFileState }[];
  /** Plain `git switch` would succeed and keep every change. */
  canCarry: boolean;
  /** Re-applying can be attempted (no untracked file collisions). */
  canReapply: boolean;
  predictionAvailable: boolean;
  recommended: SwitchStrategy;
}

export interface BranchSwitchResult {
  outcome: 'switched' | 'carried' | 'stashed' | 'reapplied' | 'conflicts';
  branch: string;
  stashRef: string | null;
  conflicted: string[];
  message: string;
}

/** A switch whose re-applied changes are waiting for conflict resolution. */
export interface SwitchSession {
  from: string | null;
  to: string;
  stashOid: string;
  stashExists: boolean;
  startedAt: string;
}

export interface BranchDeleteResult {
  localDeleted: boolean;
  remoteDeleted: boolean;
  /** Remote branch was already gone. */
  remoteMissing: boolean;
  authDescription: string | null;
  messages: string[];
}

// ---- Security scanning ----

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface SecurityFinding {
  file: string;
  ruleId: string;
  severity: Severity;
  title: string;
  reason: string;
  line?: number;
  excerpt?: string;
  occurrences: number;
}

export type SecurityStatus = 'NO_ISSUES_DETECTED' | 'REVIEW_RECOMMENDED' | 'REVIEW_REQUIRED';

export interface SecurityReport {
  status: SecurityStatus;
  headline: string;
  findings: SecurityFinding[];
  flaggedFiles: string[];
  scannedFiles: number;
  partial: boolean;
  disclaimer: string;
}

export interface PullPreview {
  reviewId: string;
  repoName: string;
  branch: string;
  upstream: string;
  targetOid: string;
  commits: CommitInfo[];
  files: FileDiff[];
  report: SecurityReport;
  localChangeCount: number;
  canFastForward: boolean;
  upToDate: boolean;
  /**
   * Your branch and the remote branch share no commit (for example a GitHub repository created with a
   * README, and a local repository with its own first commit). Merge combines them; rebase replays yours.
   */
  unrelated?: boolean;
}

export type PullStrategy = 'ff-only' | 'merge' | 'rebase';

export interface PullResult {
  outcome: 'up-to-date' | 'fast-forward' | 'merged' | 'rebased' | 'conflicts';
  message: string;
}

// ---- Pull requests ----

export interface PrPreview extends AuthContext {
  owner: string;
  repo: string;
  source: string;
  target: string;
  commits: CommitInfo[];
  files: FileDiff[];
  warnings: string[];
  blockers: string[];
}

export interface PrResult {
  number: number;
  url: string;
  title: string;
}

// ---- GitHub App tokens ----

export type TokenStatus = 'active' | 'revoked' | 'expired' | 'revoke-failed';
/** Where the token came from: generated on the token page, generated in an auth dialog, created for one operation, or pasted. */
export type TokenSource = 'token-page' | 'dialog' | 'operation' | 'pasted';

/** One installation token known to this session (never contains the token itself). */
export interface InstallationTokenRecord {
  id: string;
  masked: string;
  source: TokenSource;
  appId: string | null;
  repositories: string[];
  permissions: Record<string, string>;
  createdAt: string;
  /** GitHub's own expiry (1 hour after creation). */
  expiresAt: string;
  status: TokenStatus;
  revokedAt: string | null;
  lastError: string | null;
  /** Operations it was used for (push, fetch, …). */
  usedFor: string[];
}

export interface GeneratedTokenInfo {
  handle: string;
  maskedToken: string;
  expiresAt: string;
  clearsAt: string;
  installationId: string;
  permissions: Record<string, string>;
  repositories: string[];
}

export interface KeyHandleInfo {
  handle: string;
  fingerprint: string;
  fileName: string;
}

// ---- Conflicts ----

/** Original conflicted state of one file, kept so accepting / resolving can be undone. */
export interface ConflictSnapshot {
  stages: { mode: string; oid: string; stage: number }[];
  /** Git blob of the working file with conflict markers (null when the file did not exist). */
  working: string | null;
}

/** Names behind "current" and "incoming", plus every file's resolution state. */
export interface ConflictOverview {
  operation: InProgressOperation;
  /** e.g. "main" — what the working branch had. */
  current: string;
  /** e.g. "qa", "your commits from feature/x", "stashed changes". */
  incoming: string;
  currentRef: string | null;
  incomingRef: string | null;
  files: {
    path: string;
    /** conflicted: still unmerged; resolved: marked resolved (staged). */
    state: 'conflicted' | 'resolved';
    conflictCode: string | null;
    /** An accept / edit was applied since the conflict appeared. */
    changed: boolean;
    hasMarkers: boolean;
    /** The original conflict can be restored. */
    canUndo: boolean;
  }[];
}

export interface ConflictFile {
  path: string;
  content: string;
  hasMarkers: boolean;
  binary: boolean;
  conflictCode: string;
  explanation: string;
  oursLabel: string;
  theirsLabel: string;
}

// ---- History ----

export interface HistoryEntry {
  id: string;
  at: string;
  repoName: string | null;
  operation: string;
  status: OperationStatus;
  summary: string;
}

// ---- Directory selection ----

export interface DirectorySelection {
  selectionId: string;
  path: string;
}

// ---- Help ----

export interface GitCommandHelp {
  command: string;
  summary: string;
  what: string;
  useWhen: string;
  avoidWhen: string;
  example: string;
  risks: string;
  riskLevel: 'safe' | 'caution' | 'dangerous';
  modifiesLocalFiles: string;
  contactsRemote: boolean;
  inApp: string;
}

// ---- GitHub accounts ----

/** A GitHub account known to the app. Contains no secrets. */
export interface GitHubAccount {
  id: string;
  login: string;
  name: string | null;
  /** Organizations the account belongs to (as reported when it was last verified). */
  orgs: string[];
  addedAt: string;
  lastVerifiedAt: string | null;
  /** API base (github.com or GitHub Enterprise). */
  apiBaseUrl?: string;
  /**
   * How the account was added. 'ssh' = identity proven with an SSH key only: git push/pull work over SSH,
   * but GitHub API features (PRs, Actions, profile) need a token or browser sign-in ("upgrade").
   */
  method?: 'token' | 'browser' | 'ssh';
}

export interface AccountSummary extends GitHubAccount {
  active: boolean;
  /** A credential is remembered in the OS keychain (explicit user opt-in). */
  remembered: boolean;
}

export interface AccountsState {
  accounts: AccountSummary[];
  activeAccountId: string | null;
  encryptionAvailable: boolean;
}

/** Token for one GitHub-account operation: entered now or (if the user opted in earlier) remembered. */
export interface AccountCredentialInput {
  accountId: string;
  token?: string;
  useRemembered?: boolean;
  /** Explicit opt-in to store the token in the OS keychain. */
  remember?: boolean;
  /** Use the token the GitHub CLI holds for this account (after "Sign in with browser"). Read in main only. */
  useCli?: boolean;
}

/** What the local GitHub CLI knows for one host (never includes a token). */
export interface CliAccountsStatus {
  installed: boolean;
  version: string | null;
  host: string;
  /** Logins gh is signed in to on this host. */
  logins: string[];
  active: string | null;
}

/** Result of `ssh -T git@host`: who the SSH key authenticates as. */
export interface SshWhoAmI {
  ok: boolean;
  host: string;
  login: string | null;
  message: string;
  /** Account in Git Baba with this login (if any). */
  accountId: string | null;
}

export interface VerifiedAccount {
  login: string;
  name: string | null;
  orgs: string[];
  /** Classic token scopes (null for fine-grained tokens, which do not report scopes). */
  scopes: string[] | null;
}

// ---- Multi-step workflows ----

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface WorkflowStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  error?: FriendlyError;
}

export type WorkflowPhase = 'awaiting-auth' | 'running' | 'failed' | 'done' | 'cancelled';

export interface CreateRepoInput {
  /** Directory selection id (parent folder from the native dialog). */
  selectionId: string;
  folderName?: string;
  accountId: string | null;
  name: string;
  owner: string;
  visibility: 'private' | 'public';
  description?: string;
  /** Create a local repository only (no GitHub repository). */
  localOnly: boolean;
}

export interface CreateRepoState {
  workflowId: string;
  phase: WorkflowPhase;
  steps: WorkflowStep[];
  summary: {
    account: string | null;
    owner: string;
    name: string;
    visibility: 'private' | 'public';
    localPath: string;
    localOnly: boolean;
  };
  githubUrl: string | null;
  repoId: string | null;
  /** Shown when the workflow stopped half-way (e.g. GitHub repo created, local setup failed). */
  incomplete: string | null;
  /** Fixes the user can apply for the failed step. */
  fixes: { id: string; label: string }[];
}

/** A tag and the commit it points at. */
export interface TagInfo {
  name: string;
  annotated: boolean;
  /** Commit id the tag resolves to. */
  commit: string;
  date: string | null;
  tagger: string | null;
  /** Subject of an annotated tag's message. */
  message: string | null;
}

/** A repository the signed-in account can clone. */
export interface RemoteRepoEntry {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  updatedAt: string | null;
}

/** Result of checking a folder path typed by the user. */
export interface DirectoryCheck {
  /** The normalised absolute path. */
  path: string;
  exists: boolean;
  isDirectory: boolean;
  /** Set when asked to register the folder for use (it exists or was created). */
  selectionId: string | null;
}

export interface CloneRepoInput {
  selectionId: string;
  folderName: string;
  /** owner/repo or a full URL. */
  repository: string;
  accountId: string | null;
}

export interface CloneState {
  workflowId: string;
  phase: WorkflowPhase;
  steps: WorkflowStep[];
  progress: { text: string; percent: number | null } | null;
  summary: { repository: string; owner: string | null; account: string | null; destination: string; authentication: string };
  repo: RepoSummary | null;
  /** The destination folder exists from an interrupted clone; the user may remove it explicitly. */
  leftoverFolder: string | null;
}

/** Progress/state events pushed from main to the renderer for long operations. */
export type ProgressEvent =
  | { kind: 'create'; state: CreateRepoState }
  | { kind: 'clone'; state: CloneState };

// ---- Git History (graph) ----

export type HistoryScope = 'current' | 'all' | 'remotes' | 'tags' | 'ref';

export interface HistoryQuery {
  scope: HistoryScope;
  ref?: string;
  author?: string;
  sinceDays?: number;
  search?: string;
  skip?: number;
  limit?: number;
}

export interface GraphCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: string[];
  /** Branch the commit belongs to (nearest branch tip that contains it), when known. */
  branch?: string | null;
  /** True when the commit is already contained in the main (default) branch. */
  merged?: boolean;
  /** Nearest tag containing the commit; `exact` when the tag points at the commit itself. */
  releasedIn?: { tag: string; exact: boolean } | null;
}

export interface CommitStatFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'typechange';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CommitDetails extends GraphCommit {
  body: string;
  committer: string;
  committerDate: string;
  files: CommitStatFile[];
  additions: number;
  deletions: number;
  diffs: FileDiff[];
  isMerge: boolean;
}

export type ResetMode = 'soft' | 'mixed' | 'keep' | 'hard';

export interface WorkingCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface ResetPreview {
  branch: string | null;
  detached: boolean;
  headOid: string;
  target: string;
  /** True when the target is in the branch's history (a plain "go back"). */
  isAncestor: boolean;
  /** Commits that will no longer be on the branch. */
  leaving: GraphCommit[];
  /** Commits the branch gains (target is not an ancestor). */
  arriving: GraphCommit[];
  /** Hashes among `leaving` that exist on no remote. */
  unpushed: string[];
  upstream: string | null;
  working: WorkingCounts;
  operation: InProgressOperation;
}

export interface ResetResult {
  previousOid: string;
  newOid: string;
  mode: ResetMode;
  backupRef: string;
  wipRef: string | null;
  untrackedKept: number;
}

export interface RebasePreview {
  branch: string | null;
  detached: boolean;
  headOid: string;
  onto: string;
  replay: GraphCommit[];
  mergesDropped: number;
  /** Replayed commits that were already pushed (their ids will change). */
  publishedCount: number;
  fastForward: boolean;
  upToDate: boolean;
  working: WorkingCounts;
}

export interface HistoryActionResult {
  outcome: 'done' | 'conflicts';
  previousOid: string | null;
  newOid: string | null;
  conflicted: string[];
  message: string;
}

export interface TransplantPreview {
  source: string;
  base: string;
  target: string;
  sourceOid: string;
  targetOid: string;
  /** The source's own commits (on top of `base`), oldest first. */
  commits: (GraphCommit & { alreadyInTarget: boolean; files: string[] })[];
  /** Merge commits among the source's own commits (skipped: only regular commits are replayed). */
  mergesSkipped: number;
  /** Commits of `base` that a normal merge would also bring into the target, and that a transplant leaves out. */
  leftBehind: number;
  files: string[];
  suggestedBranch: string;
  currentBranch: string | null;
  dirty: number;
  operation: InProgressOperation;
}

export interface TransplantResult {
  outcome: 'done' | 'conflicts';
  branch: string;
  applied: number;
  conflicted: string[];
  newOid: string | null;
  returnedTo: string | null;
  backupRef: string | null;
  message: string;
}

export interface MergeForecast {
  branch: string;
  base: string;
  /** False when the two branches share no history. */
  related: boolean;
  ahead: number;
  behind: number;
  files: string[];
  additions: number;
  deletions: number;
  lastDate: string | null;
}

export interface CompareResult {
  from: GraphCommit;
  to: GraphCommit;
  files: CommitStatFile[];
  additions: number;
  deletions: number;
  diffs: FileDiff[];
}

export interface FileAtCommit {
  path: string;
  hash: string;
  content: string;
  binary: boolean;
  truncated: boolean;
}

/** What a branch adds compared with a base branch (commits since the merge base and the combined diff). */
export interface BranchChanges {
  branch: string;
  base: string;
  mergeBase: string | null;
  ahead: number;
  behind: number;
  commits: GraphCommit[];
  files: CommitStatFile[];
  additions: number;
  deletions: number;
  diffs: FileDiff[];
}

// ---- Code tab ----
export interface CodeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'submodule' | 'symlink';
  size: number | null;
}

export interface CodeLastCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface CodeInfo {
  ref: string;
  current: string | null;
  defaultBranch: string | null;
  branches: string[];
  remoteBranches: string[];
  tags: string[];
  commitCount: number;
  lastCommit: CodeLastCommit | null;
  /** Bytes per language, computed from file extensions in the tree. */
  languages: Record<string, number>;
  readme: string | null;
}

export interface CodeSearchHit {
  path: string;
  line: number | null;
  text: string;
}

/** What is set up for a repository's authentication and signing — in Git Baba and in Git itself. */
export interface RepoAccessOverview {
  remote: { name: string; url: string; protocol: string; host: string | null; owner: string | null; repo: string | null; isGitHub: boolean } | null;
  /** Methods the remote supports (as offered in push dialogs). */
  available: AuthMethod[];
  detected: {
    /** git config credential.helper (e.g. "manager"), set outside Git Baba. */
    credentialHelper: string | null;
    /** git config core.sshCommand, set outside Git Baba. */
    sshCommand: string | null;
    /** GIT_SSH / GIT_SSH_COMMAND in the environment (e.g. plink / Pageant). */
    sshEnv: string | null;
    /** SSH key remembered in Git Baba for this repository (path only). */
    sshKeyPath: string | null;
    /** Token saved (encrypted) in Git Baba for this repository. */
    patSaved: boolean;
    githubAppKeySaved: boolean;
  };
  signing: {
    name: string | null;
    email: string | null;
    signingKey: string | null;
    gpgFormat: string | null;
    commitGpgSign: boolean;
    /** Signing method matching gpg.format, offered in the commit dialog. */
    signedMethod: SigningMethod | null;
    signedLabel: string | null;
  };
  /** What the dialogs will preselect now, and why. */
  effective: {
    remote: { method: AuthMethod | null; source: 'github-app' | 'repo-setting' | 'remembered' | 'git-config' | 'default' };
    commit: { method: SigningMethod; source: 'github-app' | 'repo-setting' | 'remembered' | 'git-config' | 'default' };
  };
}

export interface RemoteChangeCheck {
  name: string;
  /** False when the change cannot be saved (invalid URL, credentials in it…). */
  ok: boolean;
  /** Nothing changes (same URL). */
  unchanged: boolean;
  isNew: boolean;
  from: { url: string; protocol: string; host: string | null; owner: string | null; repo: string | null } | null;
  to: { url: string; protocol: string; host: string | null; owner: string | null; repo: string | null; isGitHub: boolean };
  checks: { level: 'ok' | 'warn' | 'error' | 'info'; title: string; detail: string }[];
  reachable: 'yes' | 'no' | 'skipped';
  /** Default branch and branch count seen on the new remote, when reachable. */
  remoteHead: { branches: number; defaultBranch: string | null } | null;
}
