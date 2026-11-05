import * as os from 'node:os';
import type { ApiMap } from '../../shared/api';
import type { AccountsState, GitHubAccount } from '../../shared/types';
import { describeScopes, hostForApiBase, verifyToken } from '../accounts/accountAuth';
import { sshWhoAmI } from '../accounts/sshIdentity';
import type { AppContext } from '../context';
import { AppError } from '../git/errors';
import { cancelBrowserLogin, cliAccounts, ghAuthToken, startBrowserLogin, waitBrowserLogin } from '../github/ghCli';
import { DEFAULT_API_BASE, parsePrivateKey, privateKeyFingerprint, validateApiBaseUrl } from '../github/GitHubService';
import { asId, asLine, asObject, asOptionalString, asString } from '../util/validate';

export type AccountSignInChannels =
  | 'accounts:cliStatus'
  | 'accounts:browserLoginStart'
  | 'accounts:browserLoginFinish'
  | 'accounts:browserLoginCancel'
  | 'accounts:addFromCli'
  | 'accounts:sshWhoAmI'
  | 'accounts:addSsh'
  | 'accounts:appKeyHandle';

type Handler<C extends keyof ApiMap> = (payload: unknown) => Promise<ApiMap[C]['res']>;

const LOGIN_ID = /^login-[a-z0-9-]+$/;

/**
 * Flexible sign-in for application accounts:
 *  - Browser (GitHub device flow run by the GitHub CLI): the user types username / password / 2FA on github.com;
 *    the resulting token is read here, in main, and never crosses to the renderer.
 *  - SSH key: `ssh -T git@host` proves which login a key belongs to ("SSH only" account: git works, API needs a token).
 */
export function createAccountSignInHandlers(ctx: AppContext, accountsState: () => AccountsState): { [C in AccountSignInChannels]: Handler<C> } {
  const apiBaseOf = (p: Record<string, unknown>): string | undefined => (p.apiBaseUrl ? validateApiBaseUrl(asLine(p.apiBaseUrl, 'API URL', { max: 300 })) : undefined);
  const keyPathOf = (p: Record<string, unknown>): string | undefined => {
    const handle = asOptionalString(p.keyHandle, 'keyHandle', { max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
    if (!handle) return undefined;
    const keyPath = ctx.vault.get(handle, 'ssh-key-path');
    if (!keyPath) throw new AppError({ code: 'key-expired', title: 'Key No Longer Loaded', message: 'Choose the SSH key again.' });
    return keyPath;
  };

  const adoptArgs = (p: Record<string, unknown>) => {
    // Sign-ins are always remembered (OS keychain) so the account stays signed in.
    void p.remember;
    const remember = ctx.accountSecrets.available();
    const target = p.accountId === undefined || p.accountId === null ? undefined : ctx.accounts.get(asId(p.accountId, 'accountId'));
    if (p.accountId && !target) throw new AppError({ code: 'unknown-account', title: 'Account Not Found', message: 'This account is no longer in the app. Add it again.' });
    return { remember, target, apiBase: apiBaseOf(p) ?? target?.apiBaseUrl };
  };

  /**
   * Reads the token the GitHub CLI holds (main process only), verifies it with GitHub, adds or refreshes the account,
   * remembers it only on request and starts the in-memory session. The token never leaves this function.
   */
  const adoptCliToken = async (apiBase: string | undefined, login: string | undefined, target: GitHubAccount | undefined, remember: boolean, what: string) => {
    let token = (await ghAuthToken(os.homedir(), hostForApiBase(apiBase), login)) ?? '';
    if (!token) throw new AppError({ code: 'browser-login', title: 'No Token Received', message: 'The GitHub CLI did not provide a token. Run "gh auth status" to check it, or use a personal access token.' });
    try {
      const verified = await verifyToken(ctx.githubFor(apiBase ?? DEFAULT_API_BASE), token);
      const expected = target?.login ?? login;
      if (expected && verified.login.toLowerCase() !== expected.toLowerCase()) {
        throw new AppError({
          code: 'account-mismatch',
          title: 'Signed In as Another Account',
          message: `GitHub says this sign-in is "${verified.login}", not "${expected}". Sign out on github.com (or use a private window) and sign in as ${expected}.`,
          actions: ['review-auth'],
        });
      }
      // Adding a NEW account: the browser was still signed in to an account that is already added.
      const existing = !target && !login ? ctx.accounts.list().find((a) => a.login.toLowerCase() === verified.login.toLowerCase() && (a.apiBaseUrl ?? undefined) === apiBase) : undefined;
      if (existing && existing.method !== 'ssh') {
        throw new AppError({
          code: 'account-exists',
          title: `${verified.login} Is Already Added`,
          message: `${hostForApiBase(apiBase)} approved the code as ${verified.login}, which is already in Git Baba. To add another account, sign in to it on ${hostForApiBase(apiBase)} first (use GitHub's “Switch account” menu or a private browser window), then try again — or add it with a personal access token.`,
          actions: ['review-auth'],
        });
      }
      const account = ctx.accounts.upsert(verified.login, verified.name, verified.orgs, apiBase, 'browser');
      if (remember) ctx.accountSecrets.save(account.id, token);
      // Start the in-memory session right away so GitHub features work without asking again.
      await ctx.sessions.signIn({ accountId: account.id, token, remember: false }).catch(() => undefined);
      ctx.recordOperation(null, what, 'SUCCESS', `${account.login}${remember ? ' (credential remembered in OS keychain)' : ' (session in memory only)'}`);
      const state = accountsState();
      return { state, account: state.accounts.find((a) => a.id === account.id)!, scopes: describeScopes(verified.scopes) };
    } finally {
      token = '';
    }
  };

  return {
    'accounts:cliStatus': async (payload) => {
      const apiBase = apiBaseOf(payload ? asObject(payload) : {});
      const host = hostForApiBase(apiBase);
      return { host, ...(await cliAccounts(os.homedir(), host)) };
    },

    'accounts:browserLoginStart': async (payload) => {
      const apiBase = apiBaseOf(payload ? asObject(payload) : {});
      return startBrowserLogin(os.homedir(), hostForApiBase(apiBase));
    },

    'accounts:browserLoginFinish': async (payload) => {
      const p = asObject(payload);
      const loginId = asString(p.loginId, 'loginId', { max: 80, pattern: LOGIN_ID });
      const { remember, target, apiBase } = adoptArgs(p);
      const r = await waitBrowserLogin(loginId);
      if (!r.ok) {
        throw new AppError({ code: 'browser-login', title: 'Browser Sign-In Did Not Finish', message: r.message || 'The sign-in was cancelled or timed out. Start again.', actions: ['review-auth'] });
      }
      // gh just made the new sign-in its active account for the host.
      return adoptCliToken(apiBase, undefined, target, remember, 'Sign in with browser');
    },

    'accounts:addFromCli': async (payload) => {
      const p = asObject(payload);
      const login = asString(p.login, 'login', { max: 39, pattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/ });
      const { remember, target, apiBase } = adoptArgs(p);
      return adoptCliToken(apiBase, login, target, remember, 'Sign in with GitHub CLI');
    },

    'accounts:browserLoginCancel': async (payload) => {
      cancelBrowserLogin(asString(asObject(payload).loginId, 'loginId', { max: 80, pattern: LOGIN_ID }));
    },

    'accounts:sshWhoAmI': async (payload) => {
      const p = payload ? asObject(payload) : {};
      const host = hostForApiBase(apiBaseOf(p));
      const r = await sshWhoAmI(host, keyPathOf(p));
      return { ...r, host, accountId: r.login ? (ctx.accounts.findByLogin(r.login)?.id ?? null) : null };
    },

    'accounts:addSsh': async (payload) => {
      const p = asObject(payload);
      const apiBase = apiBaseOf(p);
      const host = hostForApiBase(apiBase);
      // Re-checked here: the login is never taken from the renderer.
      const r = await sshWhoAmI(host, keyPathOf(p));
      if (!r.ok || !r.login) throw new AppError({ code: 'ssh-identity', title: 'SSH Key Not Accepted', message: r.message, actions: ['review-auth'] });
      const account = ctx.accounts.upsert(r.login, null, [], apiBase, 'ssh');
      ctx.recordOperation(null, 'Add GitHub account (SSH)', 'SUCCESS', `${account.login} verified with an SSH key${account.method === 'ssh' ? ' (SSH only)' : ''}`);
      const state = accountsState();
      return { state, account: state.accounts.find((a) => a.id === account.id)! };
    },

    /** Loads a registered App's saved key into the short-lived vault (like choosing its .pem file) for the token page. */
    'accounts:appKeyHandle': async (payload) => {
      const id = asId(asObject(payload).id, 'id');
      const app = ctx.appRegistry?.get(id);
      let pem = app ? ctx.appRegistry!.getKey(id) : null;
      if (!app || !pem) throw new AppError({ code: 'auth-input', title: 'Key Not Available', message: 'This App has no saved private key on this computer. Load its .pem file instead.' });
      const fingerprint = privateKeyFingerprint(parsePrivateKey(pem));
      const { handle } = ctx.vault.put('private-key', pem, 15 * 60_000);
      pem = '';
      return { handle, fingerprint, fileName: `${app.name || `App ${app.appId}`} (saved key)` };
    },
  };
}
