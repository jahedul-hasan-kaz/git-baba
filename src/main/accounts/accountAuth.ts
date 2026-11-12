import type { AccountCredentialInput, GitHubAccount, VerifiedAccount } from '../../shared/types';
import { AppError } from '../git/errors';
import { DEFAULT_API_BASE, GitHubService } from '../github/GitHubService';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { ghAuthToken } from '../github/ghCli';
import type { AccountSecretStore, AccountStore } from './AccountStore';

/** Web host for an API base: https://api.github.com → github.com; https://ghe.example.com/api/v3 → ghe.example.com. */
export function hostForApiBase(apiBase: string | undefined): string {
  const h = new URL(apiBase ?? DEFAULT_API_BASE).host;
  return h === 'api.github.com' ? 'github.com' : h.replace(/^api\./, '');
}

export interface AccountAuthDeps {
  accounts: AccountStore;
  accountSecrets: AccountSecretStore;
  githubFor: (apiBase: string) => GitHubService;
}

export interface AuthenticatedAccount {
  account: GitHubAccount;
  token: string;
  verified: VerifiedAccount;
  gh: GitHubService;
  /** Drops the token reference. Always call when the operation ends. */
  release: () => void;
}

function credentialError(message: string): AppError {
  return new AppError({ code: 'auth-input', title: 'Authentication Required', message, actions: ['review-auth'] });
}

/**
 * A token Git on this PC already holds for `login` (Git Credential Manager / the OS credential store),
 * read without any prompt. MAIN PROCESS ONLY — never sent to the renderer or logged. Null when none.
 */
export function gitCredentialToken(host: string, login: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('git', ['-c', 'credential.interactive=never', 'credential', 'fill'], {
      cwd: os.homedir(),
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const user = /^username=(.*)$/m.exec(out)?.[1]?.trim();
      const pass = /^password=(.*)$/m.exec(out)?.[1]?.trim();
      resolve(code === 0 && pass && !/\s/.test(pass) && pass.length <= 512 && (!user || user.toLowerCase() === login.toLowerCase()) ? pass : null);
    });
    child.stdin.end(`protocol=https
host=${host}
username=${login}

`);
  });
}

/** A token already on this PC for `login`: the GitHub CLI's, else Git's credential store. */
export async function machineToken(host: string, login: string): Promise<string | null> {
  return (await ghAuthToken(os.homedir(), host, login)) ?? (await gitCredentialToken(host, login));
}

/** Verifies a token with GitHub and returns the identity it belongs to. */
export async function verifyToken(gh: GitHubService, token: string): Promise<VerifiedAccount> {
  if (!token || /\s/.test(token) || token.length > 512) throw credentialError('Enter a valid GitHub token.');
  const user = await gh.getAuthenticatedUser(token);
  const orgs = await gh.getUserOrgs(token);
  return { login: user.login, name: user.name, orgs, scopes: user.scopes };
}

/**
 * Authenticates ONE operation as a specific GitHub account. The token is either entered
 * now or — only if the user explicitly chose "Remember this credential" earlier — read from
 * the OS keychain. The token must belong to the selected account: a token of another
 * account is refused, so an unrelated account can never be used by accident.
 */
export async function authenticateAccount(deps: AccountAuthDeps, input: AccountCredentialInput): Promise<AuthenticatedAccount> {
  const account = deps.accounts.get(input.accountId);
  if (!account) throw new AppError({ code: 'unknown-account', title: 'Account Not Found', message: 'This GitHub account is no longer in the app. Add it again.' });
  let token = input.useRemembered
    ? deps.accountSecrets.get(account.id)
    : input.useMachine
      ? await machineToken(hostForApiBase(account.apiBaseUrl), account.login)
      : input.useCli
        ? await ghAuthToken(os.homedir(), hostForApiBase(account.apiBaseUrl), account.login)
        : (input.token ?? '').trim();
  if (!token) {
    throw credentialError(
      input.useRemembered
        ? `No credential is remembered for ${account.login}. Enter a token.`
        : input.useMachine
          ? `No saved GitHub sign-in for ${account.login} was found on this PC.`
          : input.useCli
          ? `The GitHub CLI is not signed in to ${account.login}. Use “Sign in with browser” again, or enter a token.`
          : `Enter a token for ${account.login}.`,
    );
  }

  const gh = deps.githubFor(account.apiBaseUrl ?? DEFAULT_API_BASE);
  const verified = await verifyToken(gh, token);
  if (verified.login.toLowerCase() !== account.login.toLowerCase()) {
    token = '';
    throw new AppError({
      code: 'account-mismatch',
      title: 'Token Belongs to Another Account',
      message: `This token belongs to "${verified.login}", but the selected account is "${account.login}". Use a token of ${account.login}, or switch the account.`,
      actions: ['review-auth'],
    });
  }
  // Keep the (non-secret) organisation list fresh for repository detection.
  const refreshed = deps.accounts.upsert(verified.login, verified.name, verified.orgs.length ? verified.orgs : account.orgs, account.apiBaseUrl, input.useCli || input.useMachine ? 'browser' : account.method === 'ssh' ? 'token' : (account.method ?? 'token'));
  // Stay signed in: the verified token is kept encrypted in the OS keychain (when one exists).
  if (!input.useRemembered && deps.accountSecrets.available()) deps.accountSecrets.save(account.id, token);
  return {
    account: refreshed,
    token,
    verified,
    gh,
    release: () => {
      token = '';
    },
  };
}

/** Human-readable token kind, from the scopes header. */
export function describeScopes(scopes: string[] | null): string {
  if (scopes === null) return 'fine-grained token (permissions are checked by GitHub when used)';
  return scopes.length ? `classic token — scopes: ${scopes.join(', ')}` : 'classic token without scopes';
}
