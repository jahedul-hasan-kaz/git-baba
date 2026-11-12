import type { AccountCredentialInput } from '../../shared/types';
import type { SessionStatus } from '../../shared/github';
import { AppError } from '../git/errors';
import { DEFAULT_API_BASE } from '../github/GitHubService';
import { GitHubClient } from '../github/client/GitHubClient';
import type { FetchLike } from '../github/GitHubService';
import { authenticateAccount, type AccountAuthDeps } from './accountAuth';

/** Errors meaning GitHub refused the credential itself (HTTP 401), not a network problem. */
export function isRejectedCredential(err: unknown): boolean {
  const code = err instanceof AppError ? err.friendly.code : (err as { code?: string } | null)?.code;
  return code === 'session-expired' || code === 'github-auth-failed';
}

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
 * and ends on sign-out, account removal, app exit, or after 12 hours. The token itself is
 * saved encrypted in the OS keychain at sign-in, and `ensure` restores the session from it.
 */
export class AccountSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly restoring = new Map<string, Promise<void>>();
  /** Accounts with no sign-in found on this PC, and when that was checked (avoids spawning git/gh on every call). */
  private readonly machineMiss = new Map<string, number>();

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

  /**
   * Makes sure the account has a live session: when there is none (app restart, 12-hour expiry)
   * it signs in again with the credential saved in the OS keychain, so the user stays signed in.
   * If GitHub rejects that credential (password changed, token revoked or expired), it is
   * forgotten and an actionable "sign in again" error is thrown.
   */
  async ensure(accountId: string | null): Promise<void> {
    if (!accountId) return;
    const s = this.sessions.get(accountId);
    if (s && s.expiresAt > Date.now()) return;
    const deps = this.deps();
    const pending = this.restoring.get(accountId);
    if (pending) return pending;
    if (!deps.accountSecrets.has(accountId)) {
      // Nothing saved by Git Baba yet (e.g. an account detected from this PC): adopt a sign-in this PC
      // already has — the GitHub CLI's or Git's credential store — so the user is never asked again.
      const missed = this.machineMiss.get(accountId);
      if (missed && Date.now() - missed < 2 * 60_000) return;
      const run = this.signIn({ accountId, useMachine: true })
        .then(() => void this.machineMiss.delete(accountId))
        .catch(() => void this.machineMiss.set(accountId, Date.now()))
        .finally(() => this.restoring.delete(accountId));
      this.restoring.set(accountId, run);
      return run;
    }
    const run = this.signIn({ accountId, useRemembered: true })
      .then(() => undefined)
      .catch((err: unknown) => {
        if (isRejectedCredential(err)) throw this.invalidate(accountId);
        throw err; // network etc.: keep the saved credential, try again next time
      })
      .finally(() => this.restoring.delete(accountId));
    this.restoring.set(accountId, run);
    return run;
  }

  /**
   * GitHub rejected the account's token: end the session, forget the saved credential and
   * return the error that asks the user to sign in again.
   */
  invalidate(accountId: string): AppError {
    this.end(accountId);
    const deps = this.deps();
    try {
      deps.accountSecrets.forget(accountId);
    } catch {
      // nothing saved
    }
    const login = deps.accounts.get(accountId)?.login ?? 'your account';
    return new AppError({
      code: 'session-expired',
      title: 'Sign In Again',
      message: `GitHub no longer accepts the saved sign-in for ${login}. This happens when the password is changed, the token is revoked or it expires. Sign in again to continue.`,
      actions: ['review-auth'],
    });
  }

  /** Re-checks the session token with GitHub: false = rejected (401), null = no session or could not tell. */
  async stillValid(accountId: string): Promise<boolean | null> {
    const s = this.sessions.get(accountId);
    if (!s) return null;
    try {
      await this.deps().githubFor(s.apiBase).getAuthenticatedUser(s.token);
      return true;
    } catch (err) {
      return isRejectedCredential(err) ? false : null;
    }
  }

  /** The live session token (main process only), restoring a saved sign-in if needed. */
  async token(accountId: string): Promise<{ token: string; login: string } | null> {
    await this.ensure(accountId);
    const s = this.sessions.get(accountId);
    return s && s.expiresAt > Date.now() ? { token: s.token, login: s.login } : null;
  }

  /** Forget a "nothing found on this PC" result, e.g. right after the user signed in to the GitHub CLI. */
  retryMachine(accountId?: string): void {
    if (accountId) this.machineMiss.delete(accountId);
    else this.machineMiss.clear();
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
      throw new AppError({ code: 'session-required', title: 'Sign In Required', message: `Sign in to ${login} to load GitHub data. You stay signed in until you sign out.`, actions: ['review-auth'] });
    }
    return { client: new GitHubClient(s.apiBase, s.token, this.fetchImpl), login: s.login, accountId };
  }
}
