import type { FriendlyError } from '../../shared/types';
import { redactSecrets } from '../util/redact';
import { ValidationError } from '../util/validate';
import { GitCommandError } from './runner';

/** Errors raised deliberately by the app with a ready-made friendly message. */
export class AppError extends Error {
  readonly friendly: FriendlyError;
  constructor(friendly: Omit<FriendlyError, 'reasons' | 'actions'> & Partial<Pick<FriendlyError, 'reasons' | 'actions'>>) {
    super(friendly.message);
    this.name = 'AppError';
    this.friendly = { reasons: [], actions: [], ...friendly };
  }
}

interface Rule {
  test: RegExp;
  build: (operation: string) => Omit<FriendlyError, 'technical'>;
}

const RULES: Rule[] = [
  {
    test: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i,
    build: () => ({
      code: 'ssh-host-key',
      title: 'SSH Host Not Trusted',
      message: 'The SSH server could not be verified. Its host key is unknown or has changed.',
      reasons: [
        'You have never connected to this host from this computer (connect once from a terminal and verify the fingerprint)',
        'The server key changed — this can indicate a man-in-the-middle attack',
      ],
      actions: ['review-auth'],
    }),
  },
  {
    test: /Permission denied \(publickey|sign_and_send_pubkey|no such identity|Load key .*: (invalid format|bad permissions)/i,
    build: () => ({
      code: 'ssh-auth',
      title: 'SSH Authentication Failed',
      message: 'The SSH server rejected your key.',
      reasons: [
        'No SSH key is loaded in ssh-agent (keys with passphrases must be added with ssh-add)',
        'The public key is not registered with your account or deploy keys',
        'The key does not have write access to this repository',
      ],
      actions: ['review-auth'],
    }),
  },
  {
    test: /refusing to delete the current branch|deletion of the current branch prohibited/i,
    build: () => ({
      code: 'default-branch-delete',
      title: 'Cannot Delete the Default Branch',
      message: "The remote refused to delete this branch because it is the repository's default branch.",
      reasons: ['Change the default branch in the repository settings on GitHub first, if you really want to delete it'],
      actions: [],
    }),
  },
  {
    test: /remote ref does not exist|unable to delete '.*': remote ref does not exist/i,
    build: () => ({
      code: 'remote-branch-missing',
      title: 'Remote Branch Not Found',
      message: 'The branch does not exist on the remote (it may already have been deleted).',
      reasons: [],
      actions: [],
    }),
  },
  {
    test: /GH006|protected branch hook declined|protected branch/i,
    build: () => ({
      code: 'protected-branch',
      title: 'Branch Is Protected',
      message: 'The remote refused the change because the branch is protected.',
      reasons: ['Changes must go through a pull request', 'Required status checks or reviews have not passed'],
      actions: [],
    }),
  },
  {
    test: /GH013|push declined due to repository rule|push protection|secret scanning/i,
    build: () => ({
      code: 'repository-rules',
      title: 'Push Blocked by Repository Rules',
      message: 'GitHub declined the push because it violates a repository rule.',
      reasons: ['A commit may contain a secret detected by push protection', 'A ruleset restricts who can push to this branch'],
      actions: [],
    }),
  },
  {
    test: /Permission to .+ denied|The requested URL returned error: 403|error: 403|HTTP 403|denied to /i,
    build: () => ({
      code: 'permission-denied',
      title: 'Permission Denied',
      message: 'The credentials were accepted, but they do not allow this operation on the repository.',
      reasons: [
        'The token does not have write access to this repository',
        'The GitHub App installation does not have "Contents: Write" permission',
        'The GitHub App is not installed on this repository',
        'The fine-grained token does not include this repository',
      ],
      actions: ['review-auth'],
    }),
  },
  {
    test: /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or password|returned error: 401|HTTP Basic: Access denied|bad credentials/i,
    build: () => ({
      code: 'auth-failed',
      title: 'Authentication Failed',
      message: 'The remote rejected the provided credentials.',
      reasons: [
        'Token expired or was revoked',
        'Token does not have repository access',
        'GitHub App installation does not have Contents: Write permission',
        'No credentials were supplied for a private repository',
      ],
      actions: ['review-auth'],
    }),
  },
  {
    test: /Repository not found|does not appear to be a git repository|repository '.*' not found/i,
    build: () => ({
      code: 'repo-not-found',
      title: 'Repository Not Found',
      message: 'The remote repository does not exist, or the credentials cannot see it.',
      reasons: ['The remote URL is misspelled', 'The repository is private and the credentials have no access to it', 'The repository was renamed or deleted'],
      actions: ['review-auth', 'open-settings'],
    }),
  },
  {
    test: /Could not resolve host|Failed to connect|Connection timed out|Connection refused|Network is unreachable|unable to access .*: (Recv|Send) failure|SSL certificate problem|Operation timed out/i,
    build: () => ({
      code: 'network',
      title: 'Network Problem',
      message: 'The remote server could not be reached.',
      reasons: ['You are offline or behind a proxy', 'The server name is wrong', 'A firewall blocks the connection', 'A TLS certificate could not be verified'],
      actions: ['retry'],
    }),
  },
  {
    test: /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i,
    build: () => ({
      code: 'push-rejected',
      title: 'Push Rejected — Remote Has New Commits',
      message: 'The remote branch contains commits you do not have locally. Pull (with security review) first, then push again.',
      reasons: ['Someone else pushed to this branch', 'You pushed from another computer'],
      actions: ['pull'],
    }),
  },
  {
    test: /CONFLICT|Automatic merge failed|could not apply|Resolve all conflicts manually/i,
    build: () => ({
      code: 'conflict',
      title: 'Merge Conflicts',
      message: 'Git could not combine the changes automatically. Resolve the conflicted files to continue, or abort safely.',
      reasons: [],
      actions: ['resolve-conflicts'],
    }),
  },
  {
    test: /Your local changes to the following files would be overwritten|untracked working tree files would be overwritten|Please commit your changes or stash them|cannot (pull|rebase) with uncommitted changes|You have unstaged changes/i,
    build: () => ({
      code: 'local-changes',
      title: 'Local Changes Would Be Overwritten',
      message: 'Git stopped to protect your uncommitted changes. Commit or stash them first.',
      reasons: [],
      actions: [],
    }),
  },
  {
    test: /Not possible to fast-forward|Diverging branches|have diverged/i,
    build: () => ({
      code: 'diverged',
      title: 'Branches Have Diverged',
      message: 'Your branch and the remote branch both have new commits. Choose "Merge" or "Rebase" to combine them.',
      reasons: [],
      actions: [],
    }),
  },
  {
    test: /Please tell me who you are|empty ident name|unable to auto-detect email address/i,
    build: () => ({
      code: 'identity-missing',
      title: 'Git Identity Not Configured',
      message: 'Git needs your name and email address to create commits.',
      reasons: [],
      actions: ['set-identity'],
    }),
  },
  {
    test: /gpg failed to sign|cannot run gpg|error: Couldn't load public key|ssh-keygen.*sign|failed to write commit object/i,
    build: () => ({
      code: 'signing-failed',
      title: 'Commit Signing Failed',
      message: 'The commit could not be signed with the selected method.',
      reasons: ['GPG/SSH signing is not installed or configured', 'The signing key is locked or missing', 'user.signingkey points to a key that does not exist'],
      actions: [],
    }),
  },
  {
    test: /nothing to commit|no changes added to commit|nothing added to commit/i,
    build: () => ({ code: 'nothing-to-commit', title: 'Nothing to Commit', message: 'There are no staged changes. Stage files before committing.', reasons: [], actions: [] }),
  },
  {
    test: /src refspec .* does not match any|does not have any commits yet|bad default revision 'HEAD'|ambiguous argument 'HEAD'/i,
    build: () => ({ code: 'no-commits', title: 'No Commits Yet', message: 'This branch has no commits. Create a commit first.', reasons: [], actions: [] }),
  },
  {
    test: /has no upstream branch|no tracking information|no upstream configured/i,
    build: () => ({
      code: 'no-upstream',
      title: 'No Upstream Branch',
      message: 'This branch is not connected to a remote branch yet. Push it first to create the remote branch.',
      reasons: [],
      actions: [],
    }),
  },
  {
    test: /not fully merged/i,
    build: () => ({
      code: 'branch-not-merged',
      title: 'Branch Not Fully Merged',
      message: 'This branch has commits that are not merged anywhere. Deleting it may lose work.',
      reasons: [],
      actions: [],
    }),
  },
  {
    test: /index\.lock|Another git process seems to be running/i,
    build: () => ({
      code: 'locked',
      title: 'Repository Is Busy',
      message: 'Another Git process is using this repository. Wait for it to finish and try again.',
      reasons: ['A terminal or editor is running Git', 'A previous Git process crashed and left a lock file (.git/index.lock)'],
      actions: ['retry'],
    }),
  },
  {
    test: /detected dubious ownership|safe\.directory/i,
    build: () => ({
      code: 'dubious-ownership',
      title: 'Repository Ownership Not Trusted',
      message: 'Git refuses to work in this folder because it is owned by another user. Add it to safe.directory from a terminal only if you trust it.',
      reasons: [],
      actions: [],
    }),
  },
  {
    test: /not a git repository/i,
    build: () => ({ code: 'not-a-repo', title: 'Not a Git Repository', message: 'The selected folder is not a Git repository.', reasons: [], actions: [] }),
  },
  {
    test: /already exists and is not an empty directory|already exists/i,
    build: (op) => ({ code: 'already-exists', title: 'Already Exists', message: `${op} failed because the target already exists.`, reasons: [], actions: [] }),
  },
  {
    test: /no rebase in progress|There is no merge to abort|no merge in progress/i,
    build: () => ({ code: 'no-operation', title: 'Nothing to Continue or Abort', message: 'No merge or rebase is currently in progress.', reasons: [], actions: [] }),
  },
  {
    test: /Git is not installed or not on PATH/i,
    build: () => ({
      code: 'git-missing',
      title: 'Git Not Found',
      message: 'Git is not installed or is not on your PATH. Install Git from https://git-scm.com and restart the app.',
      reasons: [],
      actions: [],
    }),
  },
  {
    test: /timed out/i,
    build: () => ({ code: 'timeout', title: 'Operation Timed Out', message: 'The operation took too long and was stopped.', reasons: ['Slow or unstable network', 'The repository is very large'], actions: ['retry'] }),
  },
];

export function friendlyFromGitOutput(operation: string, text: string, technical: string): FriendlyError {
  // "remote: Permission to owner/repo.git denied to <login>." — name the account git actually used.
  const deniedTo = /Permission to (\S+?)(?:\.git)? denied to ([A-Za-z0-9-]+)/i.exec(text);
  if (deniedTo) {
    return {
      code: 'permission-denied',
      title: `Signed In as ${deniedTo[2]}`,
      message: `GitHub received ${deniedTo[2]}'s credentials, and ${deniedTo[2]} cannot write to ${deniedTo[1]}. They usually come from Git Credential Manager, which remembers one login per host. Choose the account that owns the repository under "Push as" (its sign-in is used directly), or use a token of that account.`,
      reasons: [`Git Credential Manager still holds ${deniedTo[2]}'s login for github.com`, `${deniedTo[2]} is not a collaborator on ${deniedTo[1]}`],
      actions: ['review-auth'],
      technical,
    };
  }
  for (const rule of RULES) {
    if (rule.test.test(text)) return { ...rule.build(operation), technical };
  }
  return {
    code: 'git-failed',
    title: `${operation} Failed`,
    message: 'Git reported an error. See Technical Details for the exact output.',
    reasons: [],
    actions: ['retry'],
    technical,
  };
}

/** Converts any thrown value into a FriendlyError that is safe to show. */
export function toFriendlyError(err: unknown, operation: string, secrets: string[] = []): FriendlyError {
  if (err instanceof AppError) {
    return { ...err.friendly, technical: err.friendly.technical ? redactSecrets(err.friendly.technical, secrets) : undefined };
  }
  if (err instanceof Error && err.name === 'ConfirmationError') {
    return { code: 'confirmation-expired', title: 'Please Review Again', message: err.message, reasons: [], actions: [] };
  }
  if (err instanceof ValidationError) {
    return { code: 'invalid-input', title: 'Invalid Input', message: err.message, reasons: [], actions: [] };
  }
  if (err instanceof GitCommandError) {
    const technical = redactSecrets(
      [`$ ${err.command}`, `exit code: ${err.exitCode ?? 'n/a'}`, err.stderr.trim(), err.stdout.trim()].filter(Boolean).join('\n'),
      secrets,
    );
    return friendlyFromGitOutput(operation, `${err.message}\n${err.stderr}\n${err.stdout}`, technical);
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'unexpected',
    title: `${operation} Failed`,
    message: 'Something unexpected went wrong.',
    reasons: [],
    actions: ['retry'],
    technical: redactSecrets(message, secrets),
  };
}
