import type {
  AuthContext,
  CommitSigningPreference,
  NotificationFeed,
  NotificationKind,
  AppNotification,
  WorktreeInfo,
  WorktreeRestoreInfo,
  WorktreeSyncMode,
  WorktreeSyncResult,
  NotificationPrefs,
  RemoteAuthPreference,
  RepoAccessOverview,
  RemoteChangeCheck,
  AuthInput,
  AuthOption,
  BranchInfo,
  BranchOrigin,
  CommitInfo,
  CommitPreview,
  ConflictFile,
  ConflictOverview,
  DropFilePreview,
  DropFileResult,
  PushRuleReport,
  DirectorySelection,
  FileDiff,
  GeneratedTokenInfo,
  InstallationTokenRecord,
  GitHubAppConfig,
  GitIdentity,
  HistoryEntry,
  KeyHandleInfo,
  PrPreview,
  PrResult,
  PullPreview,
  PullResult,
  PullStrategy,
  PushPreview,
  RemoteInfo,
  RepoSettings,
  RepoStatus,
  RepoSummary,
  SigningMethod,
  SshKeyInfo,
  SshKeyMatch,
  StashEntry,
  AccountCredentialInput,
  AccountsState,
  CliAccountsStatus,
  SshWhoAmI,
  AccountSummary,
  CloneRepoInput,
  CloneState,
  TagInfo,
  DirectoryCheck,
  RemoteRepoEntry,
  CommitDetails,
  CompareResult,
  CreateRepoInput,
  CreateRepoState,
  FileAtCommit,
  GraphCommit,
  HistoryQuery,
  VerifiedAccount,
  BranchDeletePreview,
  BranchDeleteResult,
  BranchMergePreview,
  BranchMergeResult,
  BranchPublishPreview,
  BranchPublishResult,
  SshKeyType,
  SshLocalKey,
  SshTestResult,
  SigningConfig,
  BranchSwitchPreview,
  BranchSwitchResult,
  SwitchSession,
  SwitchStrategy,
  MergeConflictStrategy,
  BranchChanges,
  MergeForecast,
  TransplantPreview,
  TransplantResult,
  HistoryActionResult,
  RebasePreview,
  ResetMode,
  ResetPreview,
  ResetResult,
  CodeEntry,
  CodeInfo,
  CodeLastCommit,
  CodeSearchHit,
  RepoContributor,
} from './types';
import type {
  CodeScanningAlert,
  DependabotAlert,
  DispatchInput,
  DraftReviewComment,
  GhRepoContext,
  MergeAuthInput,
  MergeMethod,
  MergeResult,
  PreMergeReport,
  PrCheck,
  PrCommit,
  PrDetails,
  PrFilesResult,
  PrListQuery,
  PrListResult,
  RepoMetadata,
  RepoOverview,
  PrAccessDiagnosis,
  PrCliAction,
  RefChecks,
  ReviewEvent,
  SecurityList,
  SecurityOverview,
  SessionStatus,
  LabelGate,
  AccountProfile,
  AccountRepo,
  AppInstallationInfo,
  CredentialOverview,
  DeployKey,
  GhGpgKey,
  KeyListAccess,
  GhSshKey,
  LocalGpgKey,
  PublicProfilePatch,
  RegisteredApp,
  RemoteBranch,
  RemoteCommit,
  RemoteTag,
  SecretScope,
  SecretsOverview,
  ApiAuthInput,
  MarketplaceAction,
  RepoTag,
  StarterWorkflow,
  Workflow,
  WorkflowJob,
  WorkflowProposal,
  WorkflowRun,
  WorkflowTemplate,
} from './github';

type R = { repoId: string };

/** `null` clears an optional setting. */
export type RepoSettingsPatch = Partial<Omit<RepoSettings, 'githubApp' | 'apiBaseUrl' | 'sshKeyPath' | 'remoteAuth' | 'commitSigning'>> & {
  /** null returns to automatic (detected) behaviour. */
  remoteAuth?: RemoteAuthPreference | null;
  commitSigning?: CommitSigningPreference | null;
  githubApp?: GitHubAppConfig | null;
  apiBaseUrl?: string | null;
  /** Can only be cleared from the UI; key paths are set from the native file dialog. */
  sshKeyPath?: null;
};

export type TokenPermissionPreset = 'contents-read' | 'contents-write' | 'pull-requests-write';

export interface GitHubAppCredentialInput {
  appId: string;
  privateKey?: string;
  keyHandle?: string;
  apiBaseUrl?: string;
}

/** Every IPC channel with its request and response type. */
export interface ApiMap {
  'app:info': { req: void; res: { version: string; platform: string; gitVersion: string | null; encryptionAvailable: boolean } };
  'dialog:pickDirectory': { req: { purpose: 'open' | 'create' | 'clone-parent' }; res: DirectorySelection | null };

  'repo:list': { req: void; res: RepoSummary[] };
  'repo:summary': { req: R; res: RepoSummary };
  'repo:addExisting': { req: { selectionId: string }; res: RepoSummary };
  'repo:create': { req: { selectionId: string; folderName?: string; initialBranch: string }; res: RepoSummary };
  'repo:remove': { req: R & { auth?: AuthInput }; res: { remoteMissing: boolean } };
  'repo:setFavorite': { req: R & { favorite: boolean }; res: RepoSummary };
  'repo:duplicate': { req: R & { name: string }; res: RepoSummary };
  'repo:contributors': { req: R; res: RepoContributor[] };
  'repo:updateSettings': { req: R & { settings: RepoSettingsPatch }; res: RepoSummary };
  'repo:forgetSecrets': { req: R & { kind?: 'pat' | 'githubAppKey' }; res: RepoSummary };
  'repo:authOptions': { req: R & { purpose: 'push' | 'fetch' | 'pr' }; res: AuthContext & { remoteUrl: string | null } };
  'repo:setupGitHubApp': {
    req: R & { appId: string; installationId?: string; keyHandle?: string; privateKey?: string; saveKey: boolean; validate: boolean };
    res: { summary: RepoSummary; appName?: string; installationId?: string; permissions?: Record<string, string> };
  };
  'repo:cloneAuthOptions': { req: { url: string }; res: AuthOption[] };

  'git:status': { req: R; res: RepoStatus };
  'git:diffFile': { req: R & { path: string; area: 'staged' | 'unstaged' | 'untracked' | 'conflicted' }; res: FileDiff | null };
  'git:stage': { req: R & { paths: string[] }; res: void };
  'git:applySelection': { req: R & { path: string; action: 'stage' | 'unstage' | 'discard'; selection: { hunk: number; lines?: number[] }[]; confirmed?: true }; res: { lines: number; backupFile: string | null } };
  'git:changeStats': { req: R; res: { staged: Record<string, [number, number]>; unstaged: Record<string, [number, number]> } };
  'git:stageAll': { req: R; res: void };
  'git:unstage': { req: R & { paths: string[] }; res: void };
  'git:unstageAll': { req: R; res: void };
  'git:discard': { req: R & { paths: string[]; confirmed: true }; res: { backedUp: number; backupDir: string } };
  'git:identity': { req: R; res: GitIdentity };
  'git:setIdentity': { req: R & { name: string; email: string }; res: GitIdentity };
  'git:remotes': { req: R; res: RemoteInfo[] };
  'git:setRemote': { req: R & { name: string; url: string }; res: RemoteInfo[] };
  'notify:feed': { req: void; res: NotificationFeed };
  'notify:page': { req: { kinds?: NotificationKind[]; offset: number; limit: number }; res: { items: AppNotification[]; total: number } };
  'notify:markAllRead': { req: void; res: NotificationFeed };
  'notify:clear': { req: void; res: NotificationFeed };
  'notify:refresh': { req: void; res: NotificationFeed };
  'notify:setPrefs': { req: Partial<NotificationPrefs>; res: NotificationFeed };
  'git:worktrees': { req: R; res: WorktreeInfo[] };
  'git:worktreeAdd': { req: R & { path: string; branch: string; create: boolean; base?: string }; res: WorktreeInfo };
  'git:worktreeRemove': { req: R & { path: string; force?: boolean; confirmed: true }; res: WorktreeInfo[] };
  'git:worktreeLock': { req: R & { path: string; lock: boolean; reason?: string }; res: WorktreeInfo[] };
  'git:worktreePrune': { req: R; res: WorktreeInfo[] };
  'git:worktreeOpen': { req: R & { path: string }; res: RepoSummary };
  'git:worktreeReveal': { req: R & { path: string }; res: void };
  'git:worktreeSync': { req: R & { path: string; source: 'base' | 'upstream'; mode: WorktreeSyncMode; onConflict: 'abort' | 'keep'; confirmed: true }; res: WorktreeSyncResult };
  'git:worktreeSetBase': { req: R & { path: string; base: string | null }; res: WorktreeInfo[] };
  /** Recreates the deleted folder of a worktree that is open in the app (repoId), with `branch` checked out. */
  'git:worktreeRestore': { req: R & { branch: string; confirmed: true; switchHolderTo?: string }; res: RepoSummary };
  /** Where `branch` is checked out now (if anywhere), and what that folder could switch to so the worktree can have it back. */
  'git:worktreeRestoreInfo': { req: R & { branch: string }; res: WorktreeRestoreInfo };
  'git:checkRemoteChange': { req: R & { name: string; url: string; probe?: boolean }; res: RemoteChangeCheck };
  'repo:accessOverview': { req: R; res: RepoAccessOverview };
  'git:removeRemote': { req: R & { name: string; confirmed: true }; res: RemoteInfo[] };
  'git:branches': { req: R; res: BranchInfo[] };
  'git:branchOrigins': { req: R; res: Record<string, BranchOrigin> };
  'git:renameBranch': { req: R & { name: string; newName: string }; res: void };
  'git:createBranch': { req: R & { name: string; startPoint?: string; switchTo: boolean }; res: void };
  'git:switchBranch': { req: R & { name: string }; res: void };
  'git:deleteBranch': { req: R & { name: string; force: boolean; confirmed: true }; res: void };
  'git:switchPreview': { req: R & { target: string; kind: 'local' | 'remote' }; res: BranchSwitchPreview };
  'git:switchExecute': { req: R & { confirmationId: string; strategy: SwitchStrategy }; res: BranchSwitchResult };
  'git:switchSession': { req: R; res: SwitchSession | null };
  'git:switchFinish': { req: R & { dropBackup: boolean }; res: { droppedBackup: boolean } };
  'git:switchUndo': { req: R & { returnToSource: boolean; confirmed: true }; res: { branch: string | null; restored: boolean; message: string } };
  'git:mergePreview': { req: R & { source: string; target: string }; res: BranchMergePreview };
  'git:mergeExecute': {
    req: R & {
      confirmationId: string;
      auth: AuthInput;
      push: boolean;
      returnToCurrent: boolean;
      /** Required (true) to combine branches without common history. */
      allowUnrelated?: boolean;
      conflictStrategy?: MergeConflictStrategy;
      /** Merge into a new branch (created from the target) to open a pull request, instead of into the target. */
      bridge?: string;
      /** merge commit (default), squash into one commit, or rebase (replay the commits linearly). */
      method?: 'merge' | 'squash' | 'rebase';
      /** Commit message for a merge commit or squash commit. */
      message?: string;
    };
    res: BranchMergeResult;
  };
  /** Local-only fix: move a branch forward to its remote-tracking branch when that is a pure fast-forward. */
  'git:fastForwardBranch': { req: R & { branch: string }; res: { from: string; to: string } };
  'git:publishPreview': { req: R & { name: string; base?: string }; res: BranchPublishPreview };
  'git:publishExecute': { req: R & { confirmationId: string; auth: AuthInput; switchTo: boolean; commitMessage?: string }; res: BranchPublishResult };
  'git:deletePreview': { req: R & { branch: string; kind: 'local' | 'remote' }; res: BranchDeletePreview };
  'git:deleteExecute': { req: R & { confirmationId: string; auth: AuthInput; deleteLocal: boolean; deleteRemote: boolean; force: boolean; confirmed: true }; res: BranchDeleteResult };
  'git:log': { req: R & { limit?: number }; res: CommitInfo[] };
  'git:stashList': { req: R; res: StashEntry[] };
  'git:stashPush': { req: R & { message: string; includeUntracked: boolean }; res: void };
  'git:stashApply': { req: R & { index: number; pop: boolean }; res: void };
  'git:stashDrop': { req: R & { index: number; confirmed: true }; res: void };
  'git:fetch': { req: R & { auth: AuthInput }; res: { remote: string } };

  'commit:prepare': { req: R; res: CommitPreview };
  'commit:execute': { req: R & { confirmationId: string; message: string; signing: SigningMethod; authorAccount?: boolean }; res: CommitInfo };

  'push:prepare': { req: R; res: PushPreview };
  'push:execute': { req: R & { confirmationId: string; auth: AuthInput }; res: { summary: string; authDescription: string; tokenRevoked: boolean | null } };
  /** Which unpushed commits change a file, before removing that file's changes from them. */
  'push:dropFilePreview': { req: R & { path: string }; res: DropFilePreview };
  /** Removes one file's changes from the unpushed commits (working copy kept, backup ref created). */
  'push:dropFile': { req: R & { path: string; confirmed: true }; res: DropFileResult };
  'push:undoDropFile': { req: R & { path: string; backupRef: string }; res: void };
  /** Re-validates a rule report locally after a fix (GitHub stays authoritative). */
  'push:recheck': { req: R & { report: PushRuleReport }; res: PushRuleReport };

  'pull:prepare': { req: R & { auth: AuthInput }; res: PullPreview };
  'pull:execute': { req: R & { reviewId: string; strategy: PullStrategy; acknowledgedRisk: boolean }; res: PullResult };
  'pull:cancel': { req: R & { reviewId: string }; res: void };

  'conflict:get': { req: R & { path: string }; res: ConflictFile };
  'conflict:write': { req: R & { path: string; content: string }; res: void };
  'conflict:takeSide': { req: R & { path: string; side: 'ours' | 'theirs' }; res: void };
  'conflict:markResolved': { req: R & { path: string }; res: void };
  'conflict:prepareContinue': { req: R; res: CommitPreview };
  'conflict:continue': { req: R & { confirmationId: string; signing: SigningMethod }; res: void };
  'conflict:abort': { req: R & { confirmed: true }; res: void };
  /** Branch names for both sides and the state of every conflicted / resolved file. */
  'conflict:overview': { req: R; res: ConflictOverview };
  /** Accept one side for every still-conflicted file; optionally mark them resolved. */
  'conflict:takeSideAll': { req: R & { side: 'ours' | 'theirs'; markResolved: boolean; confirmed: true }; res: { changed: string[]; resolved: string[]; skipped: { path: string; reason: string }[] } };
  /** Mark every conflicted file without markers as resolved. */
  'conflict:markAllResolved': { req: R; res: { resolved: string[]; remaining: string[] } };
  /** Restore the original conflict of a file (undo accept / edit / mark resolved). */
  'conflict:undo': { req: R & { path: string }; res: void };

  'pr:prepare': { req: R & { source: string; target: string }; res: PrPreview };
  'pr:create': { req: R & { source: string; target: string; title: string; body: string; draft: boolean; auth: AuthInput }; res: PrResult };

  'github:loadKeyFile': { req: void; res: KeyHandleInfo | null };
  'github:discardKey': { req: { handle: string }; res: void };
  'github:validateApp': {
    req: GitHubAppCredentialInput & { owner?: string; repo?: string };
    res: { appName: string; appSlug: string; installationId?: string; installationAccount?: string; permissions?: Record<string, string> };
  };
  'github:generateToken': {
    req: GitHubAppCredentialInput & {
      owner: string;
      repo: string;
      installationId?: string;
      preset: TokenPermissionPreset;
      clearAfterSeconds: number;
      /** Use the key saved (encrypted) for this repository. */
      repoId?: string;
      useSavedKey?: boolean;
    };
    res: GeneratedTokenInfo;
  };
  'github:revealToken': { req: { handle: string }; res: { token: string } };
  'github:copyToken': { req: { handle: string; clearClipboardAfterSeconds: number }; res: void };
  'github:revokeToken': { req: { handle: string }; res: { revoked: boolean } };
  'github:discardToken': { req: { handle: string }; res: void };
  'github:tokenList': { req: void; res: InstallationTokenRecord[] };
  'github:tokenRevoke': { req: { id: string; confirmed: true }; res: InstallationTokenRecord };
  'github:tokenRevokeAll': { req: { confirmed: true }; res: { revoked: number; failed: number; tokens: InstallationTokenRecord[] } };
  'github:tokenClearFinished': { req: void; res: InstallationTokenRecord[] };

  /** Choose the private key manually; when `fingerprint` is given it must match that public key. */
  'ssh:pickKeyFile': { req: { fingerprint?: string } | void; res: SshKeyInfo | null };
  'ssh:matchPublicKey': { req: { publicKey: string }; res: SshKeyMatch };
  'ssh:loadPublicKeyFile': { req: void; res: SshKeyMatch | null };
  'ssh:listKeys': { req: void; res: { directory: string; keys: SshLocalKey[] } };
  'ssh:generateKey': { req: { type: SshKeyType; fileName: string; comment: string; passphrase: string }; res: SshLocalKey };
  /** `ssh -T git@<host>` with exactly this key (a .pub listed by ssh:listKeys). The passphrase is used for this one test only. */
  'ssh:testConnection': { req: { pubPath: string; passphrase?: string }; res: SshTestResult };
  /** Global commit-signing settings. */
  'ssh:signingConfig': { req: void; res: SigningConfig };
  /** Writes global git config so commits are signed with this SSH key (pubPath) or GPG key (keyId). */
  'ssh:useForSigning': { req: { kind: 'ssh'; pubPath: string; signAll: boolean; confirmed: true } | { kind: 'gpg'; keyId: string; signAll: boolean; confirmed: true }; res: SigningConfig };

  // ---- GitHub accounts (identity only; tokens are never returned) ----
  'accounts:list': { req: void; res: AccountsState };
  'accounts:add': { req: { token: string; remember: boolean; apiBaseUrl?: string; signIn?: boolean }; res: { state: AccountsState; account: AccountSummary; scopes: string } };
  'accounts:authenticate': { req: { credential: AccountCredentialInput }; res: { state: AccountsState; verified: VerifiedAccount; scopes: string } };
  'accounts:setActive': { req: { accountId: string | null }; res: AccountsState };
  'accounts:remove': { req: { accountId: string; confirmed: true }; res: AccountsState };
  /** Signs out: ends the session, forgets the saved sign-in and takes the account out of the account menu. */
  'accounts:signOut': { req: { accountId: string }; res: AccountsState };
  'accounts:forgetCredential': { req: { accountId: string }; res: AccountsState };
  /** GitHub CLI availability and its signed-in logins for a host (no tokens). */
  'accounts:cliStatus': { req: { apiBaseUrl?: string } | void; res: CliAccountsStatus };
  /** "Sign in with browser": starts the GitHub device flow through the GitHub CLI and returns the one-time code. */
  'accounts:browserLoginStart': { req: { apiBaseUrl?: string } | void; res: { loginId: string; code: string; url: string } };
  /**
   * Waits for the browser sign-in, reads the resulting token in main only, verifies it, adds/refreshes the account
   * (or checks it is `accountId`), starts an in-memory session and remembers the token only when asked.
   */
  'accounts:browserLoginFinish': {
    req: { loginId: string; remember: boolean; apiBaseUrl?: string; accountId?: string };
    res: { state: AccountsState; account: AccountSummary; scopes: string };
  };
  'accounts:browserLoginCancel': { req: { loginId: string }; res: void };
  /** Adds / signs in an account the GitHub CLI is already signed in to (token read and verified in main only). */
  'accounts:addFromCli': {
    req: { login: string; remember: boolean; apiBaseUrl?: string; accountId?: string };
    res: { state: AccountsState; account: AccountSummary; scopes: string };
  };
  /** `ssh -T git@host` with the default keys / agent or one chosen key: who does it authenticate as? */
  'accounts:sshWhoAmI': { req: { apiBaseUrl?: string; keyHandle?: string } | void; res: SshWhoAmI };
  /** Adds an "SSH only" account after main re-checks the SSH identity itself. */
  'accounts:addSsh': { req: { apiBaseUrl?: string; keyHandle?: string }; res: { state: AccountsState; account: AccountSummary } };
  /** Puts a registered GitHub App's saved private key into the in-memory vault (15 min) and returns its handle. */
  'accounts:appKeyHandle': { req: { id: string }; res: KeyHandleInfo };
  'repo:setAccount': { req: R & { accountId: string | null }; res: RepoSummary };

  // ---- Create repository (state machine) ----
  'create:start': { req: { input: CreateRepoInput }; res: CreateRepoState };
  'create:authenticate': { req: { workflowId: string; credential: AccountCredentialInput }; res: CreateRepoState };
  'create:retry': { req: { workflowId: string }; res: CreateRepoState };
  'create:fix': { req: { workflowId: string; fixId: string }; res: CreateRepoState };
  'create:cancel': { req: { workflowId: string }; res: CreateRepoState };

  // ---- Clone repository (state machine) ----
  'clone:listRepos': { req: { credential: AccountCredentialInput }; res: { login: string; repos: RemoteRepoEntry[] } };
  'clone:resolveFolder': { req: { path?: string; register?: boolean; create?: boolean }; res: DirectoryCheck };
  'clone:start': { req: { input: CloneRepoInput }; res: CloneState };
  'clone:authenticate': { req: { workflowId: string; credential?: AccountCredentialInput; auth?: AuthInput }; res: CloneState };
  'clone:cancel': { req: { workflowId: string }; res: CloneState };
  'clone:removeLeftover': { req: { workflowId: string; confirmed: true }; res: CloneState };

  // ---- Git History (graph) ----
  'graph:log': { req: R & { query: HistoryQuery }; res: { commits: GraphCommit[]; hasMore: boolean; mainRef: string | null } };
  /** Commits and combined diff a branch adds on top of a base branch (default: the main branch). */
  'git:transplantPreview': { req: R & { source: string; base: string; target: string }; res: TransplantPreview };
  'git:transplant': { req: R & { target: string; commits: string[]; into: 'new-branch' | 'target'; newBranch?: string; expectedTarget: string; returnToCurrent: boolean; confirmed: true }; res: TransplantResult };
  'git:transplantPick': {
    req: R & {
      source: string;
      base: string;
      target: string;
      into: 'new-branch' | 'target';
      newBranch?: string;
      expectedTarget: string;
      returnToCurrent: boolean;
      message: string;
      selection: { path: string; oldPath?: string; hunks?: { hunk: number; lines?: number[] }[] }[];
      confirmed: true;
    };
    res: TransplantResult;
  };
  'graph:mergeForecast': { req: R & { branch: string; base: string }; res: MergeForecast };
  'graph:branchChanges': { req: R & { branch: string; base?: string }; res: BranchChanges };
  'graph:recentTags': { req: R & { limit?: number }; res: TagInfo[] };
  'graph:refs': { req: R; res: { current: string | null; branches: string[]; remotes: string[]; tags: string[] } };
  'graph:authors': { req: R; res: { name: string; email: string; commits: number }[] };
  'graph:commit': { req: R & { hash: string }; res: CommitDetails };
  'graph:compare': { req: R & { from: string; to: string }; res: CompareResult };
  'graph:fileAt': { req: R & { hash: string; path: string }; res: FileAtCommit };
  'graph:reveal': { req: R & { path: string }; res: void };
  'app:copyText': { req: { text: string }; res: void };
  'app:quit': { req: void; res: void };
  /** Opens a title-bar menu as a native pop-up at (x, y) in window coordinates; resolves when it closes. */
  'app:menuPopup': { req: { menu: AppMenuId; x: number; y: number }; res: void };
  /** Paints the window-button area of the title bar to match the theme (Windows / Linux). */
  'app:titleBar': { req: { color: string; symbolColor: string }; res: void };
  'app:menus': { req: void; res: AppMenuId[] };
  'app:checkUpdate': { req: void; res: UpdateCheck };

  // ---- Code browser ----
  'code:info': { req: R & { ref?: string }; res: CodeInfo };
  'code:tree': { req: R & { ref: string; path: string }; res: CodeEntry[] };
  'code:lastCommits': { req: R & { ref: string; paths: string[] }; res: Record<string, CodeLastCommit | null> };
  'code:file': { req: R & { ref: string; path: string }; res: FileAtCommit };
  'code:search': { req: R & { ref: string; query: string }; res: { files: string[]; hits: CodeSearchHit[]; truncated: boolean } };
  /** Writes a file in the working copy (current branch only) and stages it. */
  'code:writeFile': { req: R & { path: string; content: string; create: boolean }; res: void };
  /** Deletes a file from the working copy (current branch only) and stages the deletion. */
  'code:deleteFile': { req: R & { path: string; confirmed: true }; res: void };
  'gh:repoOverview': { req: R; res: RepoOverview };

  // ---- GitHub account sessions (token in main-process memory only) ----
  'session:status': { req: { accountId?: string }; res: SessionStatus | null };
  'session:signIn': { req: { credential: AccountCredentialInput }; res: SessionStatus };
  'session:signOut': { req: { accountId: string }; res: SessionStatus };

  // ---- Pull requests ----
  'gh:context': { req: R; res: GhRepoContext };
  'gh:remoteAhead': { req: R; res: { upstream: string | null; incoming: number | null } };
  'gh:prList': { req: R & { query: PrListQuery }; res: PrListResult };
  'gh:prMetadata': { req: R & { refresh?: boolean }; res: RepoMetadata };
  'gh:prDetails': { req: R & { number: number }; res: PrDetails };
  'gh:prCommits': { req: R & { number: number; after?: string | null }; res: { commits: PrCommit[]; endCursor: string | null; hasNextPage: boolean; total: number } };
  'gh:prChecks': { req: R & { number: number }; res: PrCheck[] };
  'gh:prFiles': { req: R & { number: number }; res: PrFilesResult };
  'gh:prCompare': {
    req: R & { base: string; head: string };
    res: {
      status: string;
      aheadBy: number;
      behindBy: number;
      totalCommits: number;
      files: number;
      commits: { sha: string; message: string; author: string; date: string }[];
      existingPr: { number: number; title: string; url: string } | null;
      /** Set when GitHub could not compare the branches, with the diagnosed reason. */
      problem: { code: 'no-access' | 'head-missing' | 'base-missing' | 'unrelated'; title: string; message: string } | null;
      /** What the local clone knows: whether the compare branch exists locally (so it can be published). */
      local: { headExists: boolean; baseExists: boolean };
    };
  };
  'gh:prCreate': {
    req: R & { title: string; body: string; base: string; head: string; draft: boolean; reviewers: string[]; assignees: string[]; labels: string[]; milestone: number | null };
    res: { number: number; url: string; warnings: string[] };
  };
  /** Fallback when the account token may not create pull requests: runs the user's own `gh pr create`. */
  'gh:prCreateCli': {
    req: R & { title: string; body: string; base: string; head: string; draft: boolean; reviewers: string[]; assignees: string[]; labels: string[] };
    res: { number: number; url: string };
  };
  /** Checks of a commit sha or branch name (any ref, not only the pull request head). */
  'gh:refChecks': { req: R & { ref: string; prNumber?: number }; res: RefChecks };
  /** Runs one allow-listed `gh pr …` command with the user's own GitHub CLI login. */
  'gh:prCli': {
    req: R & { number: number; action: PrCliAction; body?: string; title?: string; method?: 'merge' | 'squash' | 'rebase'; deleteBranch?: boolean; confirmed: true };
    res: { output: string };
  };
  /** GitHub CLI status for this repository's host. */
  'gh:cliStatus': { req: R; res: { installed: boolean; loggedIn: boolean; login: string | null; version: string | null; host: string } };
  /** Browser sign-in (device code): password and 2FA are entered on github.com, never in Git Baba. */
  'gh:browserLoginStart': { req: R; res: { loginId: string; code: string; url: string } };
  'gh:browserLoginWait': { req: { loginId: string }; res: { ok: boolean; message: string; login: string | null } };
  'gh:browserLoginCancel': { req: { loginId: string }; res: void };
  'gh:prAccessDiagnose': { req: R; res: PrAccessDiagnosis };
  'gh:prEdit': { req: R & { number: number; title?: string; body?: string; base?: string }; res: void };
  'gh:prState': { req: R & { number: number; state: 'open' | 'closed'; confirmed: true }; res: void };
  'gh:prComment': { req: R & { number: number; body: string }; res: void };
  'gh:prEditComment': { req: R & { kind: 'issue' | 'review'; databaseId: number; body: string }; res: void };
  'gh:prReply': { req: R & { number: number; commentId: number; body: string }; res: void };
  'gh:prResolveThread': { req: R & { threadId: string; resolved: boolean }; res: void };
  'gh:prReviewComment': { req: R & { number: number; commitId: string; comment: DraftReviewComment }; res: void };
  'gh:prSubmitReview': { req: R & { number: number; commitId: string; event: ReviewEvent; body: string; comments: DraftReviewComment[]; confirmed: true }; res: { id: number; state: string; url: string } };
  'gh:prReviewers': { req: R & { number: number; add: string[]; remove: string[] }; res: void };
  'gh:prAssignees': { req: R & { number: number; add: string[]; remove: string[] }; res: void };
  'gh:prLabels': { req: R & { number: number; labels: string[] }; res: void };
  'gh:labelCreate': { req: R & { name: string; color: string; description?: string }; res: void };
  'gh:prMilestone': { req: R & { number: number; milestone: number | null }; res: void };
  'gh:jobLogs': {
    req: R & { jobId: number; runId?: number; jobName?: string };
    res: { text: string; truncated: boolean; steps: { number: number | null; name: string; text: string }[] | null; source: 'job' | 'archive' | 'gh-cli'; note: string | null };
  };
  'gh:jobAnnotations': { req: R & { jobId: number }; res: { level: 'failure' | 'warning' | 'notice'; title: string | null; message: string; path: string | null; line: number | null }[] };
  'gh:rerunJob': { req: R & { jobId: number; confirmed: true }; res: void };

  // ---- Merge ----
  'gh:preMerge': { req: R & { number: number }; res: PreMergeReport };
  'gh:merge': { req: R & { number: number; method: MergeMethod; sha: string; title?: string; message?: string; auth: MergeAuthInput; confirmed: true }; res: MergeResult };

  // ---- Security & quality ----
  'gh:secOverview': { req: R; res: SecurityOverview };
  'gh:codeScanning': { req: R & { state?: string; severity?: string; tool?: string; ref?: string }; res: SecurityList<CodeScanningAlert> };
  'gh:codeScanningAlert': { req: R & { number: number }; res: { alert: CodeScanningAlert; help: string | null; instances: { ref: string; state: string; path: string | null; line: number | null; commit: string | null }[] } };
  'gh:codeScanningUpdate': { req: R & { number: number; state: 'open' | 'dismissed'; reason?: string; comment?: string; confirmed: true }; res: void };
  'gh:dependabot': { req: R & { state?: string; severity?: string; ecosystem?: string }; res: SecurityList<DependabotAlert> };
  'gh:dependabotUpdate': { req: R & { number: number; state: 'open' | 'dismissed'; reason?: string; comment?: string; confirmed: true }; res: void };
  'gh:dependabotPrs': { req: R; res: { number: number; title: string; state: string; url: string; package: string | null }[] };
  'gh:dependabotCommand': { req: R & { number: number; command: 'rebase' | 'recreate'; confirmed: true }; res: void };
  'gh:secSetting': { req: R & { setting: 'vulnerability-alerts' | 'automated-security-fixes'; enabled: boolean; confirmed: true }; res: SecurityOverview };
  'gh:readLocalFile': { req: R & { path: string }; res: { path: string; content: string; truncated: boolean } };

  // ---- Actions ----
  'gh:workflows': { req: R; res: Workflow[] };
  'gh:runs': { req: R & { workflowId?: number; branch?: string; status?: string; page?: number }; res: { runs: WorkflowRun[]; total: number; page: number; hasMore: boolean } };
  'gh:runJobs': { req: R & { runId: number }; res: { run: WorkflowRun; jobs: WorkflowJob[] } };
  'gh:labelGates': { req: R & { ref: string }; res: LabelGate[] };
  'gh:runAction': { req: R & { runId: number; action: 'rerun' | 'rerun-failed' | 'cancel'; confirmed: true }; res: void };
  'gh:dispatchInfo': { req: R & { path: string; ref: string }; res: { dispatchable: boolean; inputs: DispatchInput[]; source: string | null } };
  'gh:dispatch': { req: R & { workflowId: number; ref: string; inputs: Record<string, string>; auth: ApiAuthInput; confirmed: true }; res: { runId: number | null; authDescription: string } };
  'gh:repoTags': { req: R; res: RepoTag[] };

  // ---- Account centre (active account) ----
  'gh:acctProfile': { req: { year?: number }; res: AccountProfile };
  'gh:acctRepos': { req: { after?: string | null }; res: { repos: AccountRepo[]; endCursor: string | null; hasNextPage: boolean; total: number } };
  'gh:acctUpdateProfile': { req: { patch: PublicProfilePatch }; res: void };
  'gh:acctEmails': { req: void; res: { email: string; verified: boolean; primary: boolean }[] };
  'gh:acctSshKeys': { req: void; res: { authentication: GhSshKey[]; signing: GhSshKey[]; signingError: string | null; access: KeyListAccess } };
  'gh:acctAddSshKey': { req: { kind: GhSshKey['kind']; title: string; key: string; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:acctDeleteSshKey': { req: { kind: GhSshKey['kind']; id: number; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:acctGpgKeys': { req: void; res: GhGpgKey[] };
  /** Like gh:acctGpgKeys, but a token without the GPG permission yields `access.ok = false` instead of an error. */
  'gh:acctGpgKeyList': { req: void; res: { keys: GhGpgKey[]; access: KeyListAccess } };
  'gh:acctAddGpgKey': { req: { name: string; armored: string; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:acctDeleteGpgKey': { req: { id: number; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:acctCredentials': { req: void; res: CredentialOverview };
  'gh:localGpg': { req: void; res: { available: boolean; version: string | null; binary: string | null; keys: LocalGpgKey[] } };
  'gh:localGpgGenerate': { req: { name: string; email: string; passphrase: string; expiry: '1y' | '2y' | 'never' }; res: { key: LocalGpgKey; publicKey: string } };
  'gh:localGpgExport': { req: { keyId: string }; res: { publicKey: string } };
  'gh:appsList': { req: void; res: RegisteredApp[] };
  'gh:appsAdd': { req: { appId: string; keyHandle?: string; privateKey?: string; apiBaseUrl?: string }; res: RegisteredApp };
  'gh:appsRemove': { req: { id: string; confirmed: true }; res: { unlinked: number } };
  'gh:appsInstallations': { req: { id: string }; res: AppInstallationInfo[] };
  'gh:appsInstallationRepos': { req: { id: string; installationId: number }; res: string[] };

  // ---- Repository administration (permission-gated) ----
  'gh:adminSecrets': { req: R; res: SecretsOverview };
  'gh:adminSecretUsage': { req: R; res: Record<string, string[]> };
  'gh:adminPutSecret': { req: R & { scope: SecretScope; env?: string; name: string; value: string; orgVisibility?: 'all' | 'private' | 'selected'; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:adminDeleteSecret': { req: R & { scope: SecretScope; env?: string; name: string; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:adminCreateEnv': { req: R & { name: string }; res: void };
  'gh:adminDeployKeys': { req: R; res: DeployKey[] };
  'gh:adminAddDeployKey': { req: R & { title: string; key: string; readOnly: boolean; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:adminDeleteDeployKey': { req: R & { id: number; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:adminBranches': { req: R; res: RemoteBranch[] };
  'gh:adminTags': { req: R; res: RemoteTag[] };
  'gh:adminCommits': { req: R & { ref: string; page?: number }; res: { commits: RemoteCommit[]; hasMore: boolean } };
  'gh:adminDeleteRepo': { req: R & { typedName: string; auth: ApiAuthInput; confirmed: true }; res: void };
  'gh:adminAppStatus': { req: R; res: { linked: (RegisteredApp & { installed: { id: number; account: string } | null }) | null; apps: RegisteredApp[] } };
  'gh:adminLinkApp': { req: R & { registryId: string }; res: { installed: boolean; installationId: number | null } };
  'gh:adminUnlinkApp': { req: R; res: void };
  'gh:starterWorkflows': { req: R; res: StarterWorkflow[] };
  'gh:starterWorkflow': { req: R & { category: string; id: string }; res: { content: string; name: string } };
  'gh:marketplaceSearch': { req: R & { query: string }; res: MarketplaceAction[] };
  'gh:actionLatest': { req: R & { fullName: string }; res: { ref: string | null } };
  'gh:workflowFile': { req: R & { path: string; ref: string }; res: { content: string; sha: string } | null };
  'gh:workflowWrite': {
    req: R & { path: string; content: string; branch: string; mode: 'direct' | 'pull-request'; message: string; existingSha: string | null; auth: ApiAuthInput; confirmed: true };
    res: { url: string; mode: 'direct' | 'pull-request'; branch: string; authDescription: string };
  };
  'gh:templates': { req: void; res: WorkflowTemplate[] };
  'gh:templatePropose': { req: R & { templateId: string }; res: WorkflowProposal };
  'gh:templateApply': { req: R & { path: string; content: string; mode: 'pull-request' | 'direct'; overwrite: boolean; existingSha: string | null; templateName: string; confirmed: true }; res: { url: string; mode: 'pull-request' | 'direct' } };

  // ---- Commit graph actions ----
  'history:cherryPick': { req: R & { hash: string; noCommit?: boolean; mainline?: 1 | 2; confirmed: true }; res: HistoryActionResult };
  'history:revert': { req: R & { hash: string; noCommit?: boolean; mainline?: 1 | 2; confirmed: true }; res: HistoryActionResult };
  'history:resetPreview': { req: R & { hash: string }; res: ResetPreview };
  'history:reset': { req: R & { hash: string; mode: ResetMode; expectedHead: string; confirmed: true }; res: ResetResult };
  'history:undoReset': { req: R & { previousOid: string; mode: ResetMode; wipRef: string | null; confirmed: true }; res: void };
  'history:rebasePreview': { req: R & { onto: string }; res: RebasePreview };
  'history:rebase': { req: R & { onto: string; expectedHead: string; confirmed: true }; res: HistoryActionResult };
  'history:checkout': { req: R & { hash: string; confirmed: true }; res: void };
  'history:copyPatch': { req: R & { hash: string }; res: { bytes: number } };
  'history:savePatch': { req: R & { hash: string }; res: { path: string } | null };
  'history:createTag': { req: R & { hash: string; name: string; message?: string }; res: void };
  'history:pickWorktreeDir': { req: R; res: string | null };
  'history:addWorktree': { req: R & { hash: string; path: string; branch?: string }; res: { path: string } };
  'history:worktrees': { req: R; res: { path: string; head: string | null; branch: string | null }[] };
  'history:remoteUrl': { req: R & { hash: string }; res: { url: string | null; remote: string | null; onRemote: boolean } };
  'history:list': { req: void; res: HistoryEntry[] };
  'history:clear': { req: void; res: void };
  'shell:openExternal': { req: { url: string }; res: void };
}

export type AppMenuId = 'file' | 'view' | 'help';

/** Result of comparing this build with the newest published release. */
export interface UpdateCheck {
  current: string;
  latest: string | null;
  /** Release page of the newest version, when there is one. */
  url: string | null;
  notes: string | null;
  publishedAt: string | null;
  status: 'up-to-date' | 'available' | 'unknown';
  message?: string;
}

export type Channel = keyof ApiMap;

export const CHANNEL_PATTERN = /^(app|dialog|repo|git|commit|push|pull|conflict|pr|github|ssh|history|shell|accounts|create|clone|graph|session|gh|code|notify):[A-Za-z]+$/;
