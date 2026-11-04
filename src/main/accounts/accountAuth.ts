import type { AccountCredentialInput, GitHubAccount, VerifiedAccount } from '../../shared/types';
import { AppError } from '../git/errors';
import { DEFAULT_API_BASE, GitHubService } from '../github/GitHubService';
import * as os from 'node:os';
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
    : input.useCli
      ? await ghAuthToken(os.homedir(), hostForApiBase(account.apiBaseUrl), account.login)
      : (input.token ?? '').trim();
  if (!token) {
    throw credentialError(
      input.useRemembered
        ? `No credential is remembered for ${account.login}. Enter a token.`
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
  const refreshed = deps.accounts.upsert(verified.login, verified.name, verified.orgs.length ? verified.orgs : account.orgs, account.apiBaseUrl, input.useCli ? 'browser' : account.method === 'ssh' ? 'token' : (account.method ?? 'token'));
  if (input.remember && !input.useRemembered) deps.accountSecrets.save(account.id, token);
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
