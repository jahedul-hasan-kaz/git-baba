import type { AccountCredentialInput } from '../../shared/types';
import type { SessionStatus } from '../../shared/github';
import { AppError } from '../git/errors';
import { DEFAULT_API_BASE } from '../github/GitHubService';
import { GitHubClient } from '../github/client/GitHubClient';
import type { FetchLike } from '../github/GitHubService';
import { authenticateAccount, type AccountAuthDeps } from './accountAuth';

const SESSION_TTL_MS = 12 * 60 * 60_000;

interface Session {
  accountId: string;
  login: string;
  apiBase: string;
  token: string;
  scopes: string[] | null;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

/**
 * Signed-in sessions for GitHub accounts, held ONLY in main-process memory.
 * A session starts when the user authenticates an account (token verified to belong to it),
 * and ends on sign-out, account removal, app exit, or after 12 hours. Nothing is persisted;
 * a remembered keychain credential is used only if the user opted into remembering it.
 */
export class AccountSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly deps: () => AccountAuthDeps,
    private readonly fetchImpl?: FetchLike,
  ) {}

  async signIn(credential: AccountCredentialInput): Promise<SessionStatus> {
    const auth = await authenticateAccount(this.deps(), credential);
    this.end(auth.account.id);
    const timer = setTimeout(() => this.end(auth.account.id), SESSION_TTL_MS);
    timer.unref?.();
    this.sessions.set(auth.account.id, {
      accountId: auth.account.id,
      login: auth.account.login,
      apiBase: auth.account.apiBaseUrl ?? DEFAULT_API_BASE,
      token: auth.token,
      scopes: auth.verified.scopes,
      expiresAt: Date.now() + SESSION_TTL_MS,
      timer,
    });
    return this.status(auth.account.id);
  }

  end(accountId: string): void {
    const s = this.sessions.get(accountId);
    if (!s) return;
    clearTimeout(s.timer);
    s.token = '';
    this.sessions.delete(accountId);
  }

  endAll(): void {
    for (const id of [...this.sessions.keys()]) this.end(id);
  }

  status(accountId: string): SessionStatus {
    const s = this.sessions.get(accountId);
    const account = this.deps().accounts.get(accountId);
    return {
      accountId,
      login: account?.login ?? s?.login ?? '',
      active: !!s && s.expiresAt > Date.now(),
      expiresAt: s ? new Date(s.expiresAt).toISOString() : null,
      scopes: s?.scopes ?? null,
    };
  }

  /** A client for the account's session, or an actionable "sign in" error. */
  client(accountId: string | null): { client: GitHubClient; login: string; accountId: string } {
    if (!accountId) {
      throw new AppError({ code: 'no-account', title: 'No GitHub Account', message: 'Add a GitHub account and sign in to use GitHub features.', actions: ['review-auth'] });
    }
    const s = this.sessions.get(accountId);
    if (!s || s.expiresAt <= Date.now()) {
      const login = this.deps().accounts.get(accountId)?.login ?? 'this account';
      throw new AppError({ code: 'session-required', title: 'Sign In Required', message: `Sign in to ${login} to load GitHub data. The session is kept in memory only.`, actions: ['review-auth'] });
    }
    return { client: new GitHubClient(s.apiBase, s.token, this.fetchImpl), login: s.login, accountId };
  }
}
