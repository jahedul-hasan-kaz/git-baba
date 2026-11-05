import { revokeWithRetry } from '../github/authResolver';
import { authenticateAccount } from '../accounts/accountAuth';
import * as fs from 'node:fs/promises';
import type { ApiMap } from '../../shared/api';
import type { DraftReviewComment, GhRepoContext, MergeAuthOption, PreMergeReport } from '../../shared/github';
import type { AppContext } from '../context';
import { isRejectedCredential } from '../accounts/AccountSessions';
import { AppError } from '../git/errors';
import { looksBinary } from '../git/parsers';
import { parseRemoteUrl } from '../git/remoteUrl';
import { GitHubClient } from '../github/client/GitHubClient';
import { ghFetch } from '../github/client/ghTransport';
import { cancelBrowserLogin, cliStatus, createPrWithCli, prCliArgs, runGhChecked, startBrowserLogin, waitBrowserLogin } from '../github/ghCli';
import { scopeToRepo, ensurePr } from '../../shared/prQuery';
import { apiBaseForHost, DEFAULT_API_BASE, parsePrivateKey } from '../github/GitHubService';
import { defaultMergeMethod, evaluateMerge, loadBranchRules, loadMergeState, mergePullRequest, worst } from '../github/services/merge';
import * as prs from '../github/services/pullRequests';
import { permissionsFrom, type RepoCoords } from '../github/services/pullRequests';
import { getRepoOverview } from '../github/services/overview';
import * as sec from '../github/services/security';
import * as wf from '../github/services/workflows';
import * as acct from '../github/services/account';
import * as admin from '../github/services/repoAdmin';
import { exportGpgPublicKey, generateGpgKey, gpgStatus, listLocalGpgKeys } from '../git/gpg';
import { resolveInsideRepo } from '../util/paths';
import { redactSecrets } from '../util/redact';
import {
  asBoolean,
  asBranchName,
  asEnum,
  asGitHubName,
  asId,
  asInt,
  asLine,
  asNumericId,
  asObject,
  asOptionalBoolean,
  asOptionalString,
  asString,
  asStringArray,
  ValidationError,
} from '../util/validate';
import { asConfirmed } from './authInput';
import { parseAccountCredential } from './extraHandlers';

type Handler<C extends keyof ApiMap> = (payload: unknown) => Promise<ApiMap[C]['res']>;
export type GitHubChannels = Extract<keyof ApiMap, `gh:${string}` | `session:${string}`>;
type HandlerMap = { [C in GitHubChannels]: Handler<C> };

const METADATA_TTL_MS = 2 * 60_000;
const TRANSPORT_TTL_MS = 5 * 60_000;
// GitHub run / job / check ids have passed 2^31 — accept any safe integer.
const asNum = (v: unknown, name: string) => asInt(v, name, 1, Number.MAX_SAFE_INTEGER);
const asNodeId = (v: unknown, name: string) => asString(v, name, { max: 200, pattern: /^[A-Za-z0-9_=-]+$/ });
const asSha = (v: unknown) => asString(v, 'commit', { pattern: /^[0-9a-f]{40}([0-9a-f]{24})?$/ });
const asLogins = (v: unknown, name: string) => asStringArray(v ?? [], name, 100).map((s) => asGitHubName(s, name));
const asBody = (v: unknown, name = 'Comment') => asString(v, name, { min: 1, max: 65_000, trim: false });
const SSH_PUBLIC_KEY = /^\s*(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]*)?\s*$/;
/** GitHub secret names: letters, digits, underscores; not starting with a digit or GITHUB_. */
const asSecretName = (v: unknown) => {
  const n = asString(v, 'Secret name', { max: 100, pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ }).toUpperCase();
  if (n.startsWith('GITHUB_')) throw new ValidationError('Secret names cannot start with GITHUB_');
  return n;
};
const PLACEHOLDER_REPO: import('../../shared/types').RepoRecord = { id: 'account', name: '', path: '', addedAt: '', settings: { runHooks: false, allowSystemCredentials: false, allowSavedCredentials: false } };
const asWorkflowPath = (v: unknown) => asString(v, 'path', { max: 200, pattern: /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/ });

export function createGitHubHandlers(ctx: AppContext): HandlerMap {
  const metadataCache = new Map<string, { at: number; data: import('../../shared/github').RepoMetadata }>();

  /** Token kind (fine-grained tokens report no OAuth scopes) and web host, for key-permission hints. */
  function keyTokenInfo(account: { id: string; apiBaseUrl?: string | null }): { tokenKind: 'fine-grained' | 'classic'; webBase: string } {
    const api = new URL(account.apiBaseUrl ?? DEFAULT_API_BASE);
    const host = api.hostname === 'api.github.com' ? 'github.com' : api.hostname;
    return { tokenKind: ctx.sessions.status(account.id).scopes === null ? 'fine-grained' : 'classic', webBase: `https://${host}` };
  }

  /** The active account's session client. Every GitHub feature uses the account selected in the header. */
  async function session(apiBase?: string) {
    const accountId = ctx.accounts.activeId();
    await ctx.sessions.ensure(accountId);
    const s = ctx.sessions.client(accountId);
    const account = ctx.accounts.get(s.accountId)!;
    const accountBase = account.apiBaseUrl ?? DEFAULT_API_BASE;
    if (apiBase && apiBase !== accountBase) {
      throw new AppError({ code: 'host-mismatch', title: 'Different GitHub Server', message: `This repository is on ${new URL(apiBase).host}, but the signed-in account ${account.login} belongs to ${new URL(accountBase).host}. Switch to an account on that server.` });
    }
    return { ...s, account };
  }

  /**
   * A client for ONE sensitive operation, authenticated the way the user chose in the dialog — like a push:
   * the signed-in account re-confirmed with its token, a personal access token, or a GitHub App
   * installation token (scoped to this repository and revoked afterwards). Tokens live only for the call.
   */
  async function operationClient(
    repo: import('../../shared/types').RepoRecord,
    r: RepoCoords,
    apiBase: string,
    login: string,
    rawAuth: unknown,
    permissions: Record<string, 'read' | 'write'>,
    purpose: string,
  ): Promise<{ client: GitHubClient; description: string; cleanup: () => Promise<void> }> {
    const auth = asObject(rawAuth, 'authentication');
    const method = asEnum(auth.method, 'authentication', ['session', 'pat', 'github-app'] as const);
    const gh = ctx.githubFor(apiBase);
    if (method === 'session') {
      const credential = parseAccountCredential(auth.credential);
      const a = await authenticateAccount({ accounts: ctx.accounts, accountSecrets: ctx.accountSecrets, githubFor: (b) => ctx.githubFor(b) }, credential);
      if (a.account.login.toLowerCase() !== login.toLowerCase()) {
        a.release();
        throw new AppError({ code: 'account-mismatch', title: 'Different Account', message: `This repository is used with ${login}. Confirm with ${login}'s token, or switch the account in the header.`, actions: ['review-auth'] });
      }
      return { client: new GitHubClient(apiBase, a.token), description: `GitHub account ${a.account.login} (token re-verified)`, cleanup: async () => a.release() };
    }
    if (method === 'pat') {
      let token = asString(auth.token, 'Personal access token', { max: 512 });
      if (/\s/.test(token)) throw new AppError({ code: 'auth-input', title: 'Invalid Token', message: 'The token contains spaces.', actions: ['review-auth'] });
      const user = await gh.getAuthenticatedUser(token);
      return {
        client: new GitHubClient(apiBase, token),
        description: `personal access token of ${user.login}`,
        cleanup: async () => {
          token = '';
        },
      };
    }
    const appId = asNumericId(auth.appId, 'App ID');
    let pem: string | null = null;
    if (auth.keyHandle) pem = ctx.vault.take(asString(auth.keyHandle, 'keyHandle', { max: 64 }), 'private-key');
    else if (auth.privateKey) pem = asString(auth.privateKey, 'Private key', { max: 16_384, trim: false });
    else if (auth.useSavedKey === true) {
      if (!repo.settings.allowSavedCredentials) throw new AppError({ code: 'auth-input', title: 'Saved Key Unavailable', message: 'Saved credentials are disabled for this repository.' });
      pem = ctx.secrets.getGitHubAppKey(repo.id);
    }
    if (!pem) throw new AppError({ code: 'auth-input', title: 'Private Key Required', message: 'Load or paste the GitHub App private key.', actions: ['review-auth'] });
    const key = parsePrivateKey(pem);
    pem = null;
    const tok = await gh.generateInstallationToken({
      appId,
      key,
      owner: r.owner,
      repo: r.name,
      installationId: auth.installationId ? asNumericId(auth.installationId, 'Installation ID') : undefined,
      permissions,
    });
    let token = tok.token;
    ctx.tokens.track(token, { source: 'operation', apiBase, appId: String(appId), repositories: [`${r.owner}/${r.name}`], permissions: tok.permissions, expiresAt: tok.expiresAt, purpose });
    return {
      client: new GitHubClient(apiBase, token),
      description: `GitHub App ${appId} installation token (repository-scoped, revoked after use)`,
      cleanup: async () => {
        const ok = await revokeWithRetry(gh, token);
        ctx.tokens.setResult(token, ok);
        token = '';
      },
    };
  }

  /**
   * Account-wide operations (SSH / GPG keys) act on the user, so only user credentials apply:
   * the signed-in account re-confirmed with its token, or a personal access token.
   */
  async function userOperation(rawAuth: unknown, purpose: string) {
    const a = asObject(rawAuth, 'authentication');
    if (a.method === 'github-app') throw new AppError({ code: 'auth-not-applicable', title: 'Not Available for Apps', message: `GitHub Apps cannot ${purpose} on a personal account. Use your account's token or a personal access token.`, actions: ['review-auth'] });
    const s = await session();
    return operationClient(PLACEHOLDER_REPO, { owner: s.login, name: '' }, s.account.apiBaseUrl ?? DEFAULT_API_BASE, s.login, rawAuth, {}, purpose);
  }

  function registry() {
    if (!ctx.appRegistry) throw new AppError({ code: 'unavailable', title: 'Not Available', message: 'The GitHub App registry is not available.' });
    return ctx.appRegistry;
  }

  function registeredKey(rawId: unknown) {
    const app = registry().get(asId(rawId, 'app'));
    if (!app) throw new AppError({ code: 'not-found', title: 'App Not Found', message: 'This GitHub App is no longer registered.' });
    const pem = registry().getKey(app.id);
    if (!pem) throw new AppError({ code: 'auth-input', title: 'App Key Unavailable', message: 'The private key of this App could not be read (secure storage unavailable). Register the App again.' });
    return { app, key: parsePrivateKey(pem) };
  }

  /** Owner/name of the repository's GitHub remote, plus the session client for it. */
  async function repoCtx(payload: unknown) {
    const p = asObject(payload);
    const { repo, git } = ctx.git(p.repoId);
    const remotes = await git.remotes();
    const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const parsed = remote ? parseRemoteUrl(remote.fetchUrl) : null;
    if (!parsed?.isGitHub || !parsed.owner || !parsed.repo) {
      throw new AppError({ code: 'not-github', title: 'Not a GitHub Repository', message: `${repo.name} has no GitHub remote. Pull requests, security and actions need a GitHub repository.` });
    }
    const apiBase = repo.settings.apiBaseUrl ?? apiBaseForHost(parsed.host);
    const r: RepoCoords = { owner: parsed.owner, name: parsed.repo };
    const t = await transport(repo, r, apiBase);
    return { p, repo, r, client: t.client, login: t.login, account: t.account, apiBase, via: t.via };
  }

  /**
   * Which credential talks to GitHub for this repository: the signed-in account's token when it can
   * read the repository's pull requests, otherwise the user's own GitHub CLI login (gh adds its token
   * itself; Git Baba never sees it). Decided once and remembered for a few minutes.
   */
  const transports = new Map<string, { via: 'token' | 'gh'; login: string; at: number }>();
  async function transport(repo: import('../../shared/types').RepoRecord, r: RepoCoords, apiBase: string) {
    let s: Awaited<ReturnType<typeof session>> | null = null;
    let sessionError: unknown = null;
    try {
      s = await session(apiBase);
    } catch (err) {
      sessionError = err;
    }
    const apiHost = new URL(apiBase).host;
    const host = apiHost === 'api.github.com' ? 'github.com' : apiHost;
    const viaGh = (login: string) => {
      const client = new GitHubClient(apiBase, '', ghFetch(apiBase, repo.path));
      client.downloadFetch = (url, init) => fetch(url, init); // signed log URLs: plain HTTPS, no credentials
      return { client, login, account: null, via: 'gh' as const };
    };
    const viaToken = () => ({ client: s!.client, login: s!.login, account: s!.account, via: 'token' as const });

    const key = `${repo.id}|${s?.login ?? '-'}`;
    const known = transports.get(key);
    if (known && Date.now() - known.at < TRANSPORT_TTL_MS) return known.via === 'gh' ? viaGh(known.login) : viaToken();

    if (s) {
      const canRead = await s.client
        .graphql<{ repository: { pullRequests: { totalCount: number } | null } | null }>(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { pullRequests(first: 1) { totalCount } } }`, { o: r.owner, n: r.name }, 'check access')
        .then((d) => !!d.repository?.pullRequests)
        .catch(() => false);
      if (canRead) {
        transports.set(key, { via: 'token', login: s.login, at: Date.now() });
        return viaToken();
      }
    }
    const cli = await cliStatus(repo.path, host);
    if (cli.loggedIn) {
      const login = cli.login ?? 'GitHub CLI';
      transports.set(key, { via: 'gh', login, at: Date.now() });
      return viaGh(login);
    }
    if (s) return viaToken();
    throw sessionError;
  }

  /** Repository and GitHub host, without needing any GitHub session. */
  async function repoHost(payload: unknown) {
    const p = asObject(payload);
    const { repo, git } = ctx.git(p.repoId);
    const remotes = await git.remotes();
    const remote = remotes.find((x) => x.name === 'origin') ?? remotes[0];
    const parsed = remote ? parseRemoteUrl(remote.fetchUrl) : null;
    const apiBase = repo.settings.apiBaseUrl ?? (parsed?.isGitHub ? apiBaseForHost(parsed.host) : DEFAULT_API_BASE);
    const apiHost = new URL(apiBase).host;
    return { repo, host: apiHost === 'api.github.com' ? 'github.com' : apiHost };
  }

  const invalidate = (r: RepoCoords, login: string) => metadataCache.delete(`${login}:${r.owner}/${r.name}`.toLowerCase());

  function draftComment(v: unknown): DraftReviewComment {
    const o = asObject(v, 'comment');
    return {
      path: asString(o.path, 'path', { max: 4096, trim: false }),
      line: o.line === null || o.line === undefined ? null : asInt(o.line, 'line', 1, 10_000_000),
      side: asEnum(o.side ?? 'RIGHT', 'side', ['LEFT', 'RIGHT'] as const),
      body: asBody(o.body),
    };
  }

  const handlers: HandlerMap = {
    // ---------------- sessions ----------------
    'session:status': async (payload) => {
      const p = payload ? asObject(payload) : {};
      const id = p.accountId ? asId(p.accountId, 'accountId') : ctx.accounts.activeId();
      if (!id) return null;
      // Restore a saved sign-in; a rejected one (password changed) is dropped and reported as signed out.
      await ctx.sessions.ensure(id).catch(() => undefined);
      return ctx.sessions.status(id);
    },
    'session:signIn': async (payload) => {
      const credential = parseAccountCredential(asObject(payload).credential);
      const status = await ctx.sessions.signIn(credential);
      transports.clear();
      ctx.recordOperation(null, 'Sign in', 'SUCCESS', `${status.login} (session kept in memory only)`);
      return status;
    },
    'session:signOut': async (payload) => {
      const id = asId(asObject(payload).accountId, 'accountId');
      ctx.sessions.end(id);
      ctx.accountSecrets.forget(id); // signing out also forgets the saved sign-in
      for (const k of [...metadataCache.keys()]) if (k.startsWith(`${(ctx.accounts.get(id)?.login ?? '').toLowerCase()}:`)) metadataCache.delete(k);
      ctx.recordOperation(null, 'Sign out', 'SUCCESS', ctx.accounts.get(id)?.login ?? id);
      return ctx.sessions.status(id);
    },

    // ---------------- repository context ----------------
    /**
     * Read-only check for commits on the upstream branch that have not been fetched yet, through the
     * GitHub API (no Git credentials, nothing written). `incoming` is null when it cannot be counted.
     */
    'gh:remoteAhead': async (payload) => {
      const { git } = ctx.git(asObject(payload).repoId);
      const st = await git.status();
      if (!st.upstream || !st.upstream.includes('/')) return { upstream: null, incoming: null };
      const { r, client } = await repoCtx(payload);
      const branch = st.upstream.slice(st.upstream.indexOf('/') + 1);
      const tracked = await git.revParse(st.upstream).catch(() => '');
      const base = `/repos/${r.owner}/${r.name}`;
      const head = await client.rest<{ commit?: { sha?: string } }>('GET', `${base}/branches/${encodeURIComponent(branch)}`, { allowStatus: [404] });
      const remoteSha = head.status === 200 ? (head.data.commit?.sha ?? null) : null;
      if (!remoteSha) return { upstream: st.upstream, incoming: null };
      if (remoteSha === tracked) return { upstream: st.upstream, incoming: 0 };
      if (!tracked) return { upstream: st.upstream, incoming: null };
      const cmp = await client.rest<{ ahead_by?: number }>('GET', `${base}/compare/${tracked}...${remoteSha}`, { allowStatus: [404] });
      return { upstream: st.upstream, incoming: cmp.status === 200 && typeof cmp.data.ahead_by === 'number' ? cmp.data.ahead_by : null };
    },
    'gh:context': async (payload) => {
      const { repo, r, client, login, via } = await repoCtx(payload);
      const d = await client.graphql<{ repository: { defaultBranchRef: { name: string } | null; isPrivate: boolean; owner: { __typename: string }; viewerPermission: string; mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean } | null }>(
        `query($o: String!, $n: String!) { repository(owner: $o, name: $n) { defaultBranchRef { name } isPrivate owner { __typename } viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed } }`,
        { o: r.owner, n: r.name },
        'open the repository on GitHub',
      );
      if (!d.repository) throw new AppError({ code: 'not-found', title: 'Repository Not Found', message: `${r.owner}/${r.name} was not found on GitHub, or ${login} cannot see it. It may have been renamed or deleted.` });
      const assoc = repo.settings.accountId ? ctx.accounts.get(repo.settings.accountId) : ctx.accounts.matchOwner(r.owner)?.account;
      const ctxOut: GhRepoContext = {
        owner: r.owner,
        name: r.name,
        account: login,
        defaultBranch: d.repository.defaultBranchRef?.name ?? 'main',
        isPrivate: d.repository.isPrivate,
        ownerType: d.repository.owner.__typename === 'User' ? 'User' : 'Organization',
        permissions: permissionsFrom(d.repository.viewerPermission),
        mergeMethods: { merge: d.repository.mergeCommitAllowed, squash: d.repository.squashMergeAllowed, rebase: d.repository.rebaseMergeAllowed },
        accountMismatch: via === 'token' && assoc && assoc.login.toLowerCase() !== login.toLowerCase() ? assoc.login : null,
        via,
      };
      return ctxOut;
    },

    // ---------------- pull requests ----------------
    'gh:prList': async (payload) => {
      const { p, repo, r, client, apiBase, login } = await repoCtx(payload);
      const q = asObject(p.query, 'query');
      const query: import('../../shared/github').PrListQuery = {
        state: asEnum(q.state, 'state', ['open', 'closed', 'merged', 'all'] as const),
        sort: asEnum(q.sort, 'sort', ['best-match', 'newest', 'oldest', 'recently-updated', 'least-recently-updated', 'most-comments', 'least-comments'] as const),
        author: asOptionalString(q.author, 'author', { max: 100 }),
        label: asOptionalString(q.label, 'label', { max: 100 }),
        milestone: asOptionalString(q.milestone, 'milestone', { max: 200 }),
        assignee: asOptionalString(q.assignee, 'assignee', { max: 100 }),
        review: q.review ? asEnum(q.review, 'review', ['', 'none', 'required', 'approved', 'changes_requested', 'reviewed-by-me', 'review-requested-me'] as const) : '',
        text: asOptionalString(q.text, 'search', { max: 200 }),
        after: asOptionalString(q.after, 'cursor', { max: 200 }) ?? null,
        raw: q.raw === undefined || q.raw === null ? undefined : asString(q.raw, 'search', { min: 0, max: 500, trim: false }),
        source: q.source ? asEnum(q.source, 'source', ['search', 'repository', 'gh'] as const) : undefined,
      };
      const raw = query.raw ?? prs.effectiveSearch(r, query).replace(/^repo:\S+\s*/, '');
      if (query.after && query.source === 'repository') return prs.listFromRepository(client, r, raw, query.after);

      const counts = query.after ? undefined : await prs.prCounts(client, r).catch(() => null);
      let res: import('../../shared/github').PrListResult | null = null;
      let searchError: unknown = null;
      try {
        res = await prs.listPullRequests(client, r, query);
      } catch (err) {
        searchError = err;
      }
      // Search can be empty for repositories the token can read (fine-grained tokens, private orgs): list them directly.
      const known = counts ? counts.open + counts.closed + counts.merged : 0;
      if (!query.after && known > 0 && (!res || res.items.length === 0)) {
        res = await prs.listFromRepository(client, r, raw, null).catch(() => res);
      }
      // The token cannot see the repository at all: use the user's own GitHub CLI login if it is available.
      let ghProblem: string | null = null;
      if (!query.after && counts === null && (!res || res.items.length === 0)) {
        const apiHost = new URL(apiBase).host;
        const host = apiHost === 'api.github.com' ? 'github.com' : apiHost;
        try {
          const out = await runGhChecked(
            ['pr', 'list', '--repo', host === 'github.com' ? `${r.owner}/${r.name}` : `${host}/${r.owner}/${r.name}`, '--state', 'all', '--limit', '200', `--search=${ensurePr(scopeToRepo(raw))}`, '--json', prs.GH_LIST_FIELDS],
            repo.path,
            '',
          );
          const json = out.trim();
          const items = prs.fromGhJson(JSON.parse(json.startsWith('[') ? json : '[]'));
          return {
            items,
            total: items.length,
            endCursor: null,
            hasNextPage: false,
            source: 'gh',
            notice: null,
            query: raw,
            counts: null,
          };
        } catch (err) {
          ghProblem = err instanceof AppError ? err.friendly.message : err instanceof Error ? err.message : 'GitHub CLI failed';
        }
      }
      if (!res) throw searchError;
      // Say why the list may be incomplete instead of a bare "0 results".
      // Only a real dead end is worth a message: nothing can read this repository.
      const notice = counts === null && res.items.length === 0 ? `GitHub returned no pull requests for ${login}.${ghProblem ? ` ${ghProblem}` : ''}` : null;
      return { ...res, notice, counts: counts ?? res.counts ?? null };
    },
    'gh:prMetadata': async (payload) => {
      const { p, r, client, login } = await repoCtx(payload);
      const key = `${login}:${r.owner}/${r.name}`.toLowerCase();
      const cached = metadataCache.get(key);
      if (cached && !asOptionalBoolean(p.refresh, 'refresh') && Date.now() - cached.at < METADATA_TTL_MS) return cached.data;
      const data = await prs.getRepoMetadata(client, r);
      metadataCache.set(key, { at: Date.now(), data });
      return data;
    },
    'gh:prDetails': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return prs.getPullRequest(client, r, asNum(p.number, 'number'));
    },
    'gh:prCommits': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return prs.getPrCommits(client, r, asNum(p.number, 'number'), asOptionalString(p.after, 'cursor', { max: 200 }) ?? null);
    },
    'gh:prChecks': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return prs.getPrChecks(client, r, asNum(p.number, 'number'));
    },
    'gh:prFiles': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return prs.getPrFiles(client, r, asNum(p.number, 'number'));
    },
    'gh:prCompare': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      const base = asBranchName(p.base, 'base branch');
      const head = asBranchName(p.head, 'compare branch');
      const { git } = ctx.git(p.repoId);
      const local = { headExists: !!(await git.tryRevParse(`refs/heads/${head}`)), baseExists: !!(await git.tryRevParse(`refs/heads/${base}`)) };
      return { ...(await prs.compareBranches(client, r, base, head)), local };
    },
    'gh:prCreate': async (payload) => {
      const { p, repo, r, client, login } = await repoCtx(payload);
      const base = asBranchName(p.base, 'base branch');
      const head = asBranchName(p.head, 'compare branch');
      if (base === head) throw new ValidationError('The base and compare branches must be different');
      const created = await prs.createPullRequest(client, r, { title: asLine(p.title, 'Title', { max: 256 }), body: asString(p.body ?? '', 'Description', { min: 0, max: 65_000, trim: false }), base, head, draft: asBoolean(p.draft, 'draft') });
      // Metadata is applied afterwards; a failure there never hides the created pull request.
      const warnings: string[] = [];
      const attempt = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (err) {
          warnings.push(`${what}: ${err instanceof AppError ? err.friendly.message : 'failed'}`);
        }
      };
      const reviewers = asLogins(p.reviewers, 'reviewers');
      const assignees = asLogins(p.assignees, 'assignees');
      const labels = asStringArray(p.labels ?? [], 'labels', 100);
      if (reviewers.length) await attempt('Reviewers', () => prs.updateReviewers(client, r, created.number, reviewers, []));
      if (assignees.length) await attempt('Assignees', () => prs.updateAssignees(client, r, created.number, assignees, []));
      if (labels.length) await attempt('Labels', () => prs.setLabels(client, r, created.number, labels));
      if (p.milestone !== null && p.milestone !== undefined) await attempt('Milestone', () => prs.setMilestone(client, r, created.number, asNum(p.milestone, 'milestone')));
      ctx.recordOperation(repo, 'PR Created', warnings.length ? 'WARNING' : 'SUCCESS', `#${created.number} ${head} → ${base} as ${login}: ${created.url}`);
      return { number: created.number, url: created.url, warnings };
    },
    'gh:prCreateCli': async (payload) => {
      const { p, repo, r, apiBase } = await repoCtx(payload);
      const base = asBranchName(p.base, 'base branch');
      const head = asBranchName(p.head, 'compare branch');
      if (base === head) throw new ValidationError('The base and compare branches must be different');
      const apiHost = new URL(apiBase).host;
      const created = await createPrWithCli(repo.path, {
        host: apiHost === 'api.github.com' ? 'github.com' : apiHost,
        owner: r.owner,
        name: r.name,
        base,
        head,
        title: asLine(p.title, 'Title', { max: 256 }),
        body: asString(p.body ?? '', 'Description', { min: 0, max: 65_000, trim: false }),
        draft: asBoolean(p.draft, 'draft'),
        reviewers: asLogins(p.reviewers, 'reviewers'),
        assignees: asLogins(p.assignees, 'assignees'),
        labels: asStringArray(p.labels ?? [], 'labels', 100).map((l) => asLine(l, 'label', { max: 100 })),
      });
      ctx.recordOperation(repo, 'PR Created', 'SUCCESS', `#${created.number} ${head} → ${base} via GitHub CLI: ${created.url}`);
      return created;
    },
    'gh:refChecks': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      const ref = asString(p.ref, 'commit or branch', { max: 255, pattern: /^[^-\s~^:?*[\\][^\s~^:?*[\\]*$/ });
      return prs.getRefChecks(client, r, ref, p.prNumber ? asNum(p.prNumber, 'number') : null);
    },
    'gh:prCli': async (payload) => {
      const { p, repo, r, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const number = asNum(p.number, 'number');
      const action = asEnum(p.action, 'action', ['checkout', 'comment', 'approve', 'request-changes', 'review-comment', 'merge', 'ready', 'draft', 'close', 'reopen', 'edit-title'] as const);
      const body = p.body === undefined ? '' : asString(p.body, 'Comment', { min: 0, max: 65_000, trim: false });
      if (['comment', 'request-changes', 'review-comment'].includes(action) && !body.trim()) throw new ValidationError('Write a comment first');
      const apiHost = new URL(apiBase).host;
      const host = apiHost === 'api.github.com' ? 'github.com' : apiHost;
      const args = prCliArgs(host === 'github.com' ? `${r.owner}/${r.name}` : `${host}/${r.owner}/${r.name}`, number, {
        action,
        title: action === 'edit-title' ? asLine(p.title, 'Title', { max: 256 }) : undefined,
        method: p.method ? asEnum(p.method, 'method', ['merge', 'squash', 'rebase'] as const) : undefined,
        deleteBranch: p.deleteBranch === undefined ? false : asBoolean(p.deleteBranch, 'deleteBranch'),
        hasBody: !!body.trim(),
      });
      const run = () => runGhChecked(args, repo.path, body);
      // Checking out changes the working copy, so it is serialised with other Git operations.
      const output = redactSecrets(action === 'checkout' ? await ctx.withLock(repo.id, run) : await run()).slice(0, 4000);
      ctx.recordOperation(repo, `PR ${action} (GitHub CLI)`, 'SUCCESS', `#${number}`);
      return { output };
    },
    'gh:cliStatus': async (payload) => {
      const { repo, host } = await repoHost(payload);
      return { ...(await cliStatus(repo.path, host)), host };
    },
    'gh:browserLoginStart': async (payload) => {
      const { repo, host } = await repoHost(payload);
      return startBrowserLogin(repo.path, host);
    },
    'gh:browserLoginWait': async (payload) => {
      const loginId = asString(asObject(payload).loginId, 'loginId', { max: 80, pattern: /^login-[a-z0-9-]+$/ });
      const r = await waitBrowserLogin(loginId);
      transports.clear();
      let login: string | null = null;
      if (r.ok) {
        const out = await runGhChecked(['api', 'user', '--jq', '.login'], process.cwd(), '').catch(() => '');
        login = out.trim() || null;
      }
      return { ...r, login };
    },
    'gh:browserLoginCancel': async (payload) => {
      cancelBrowserLogin(asString(asObject(payload).loginId, 'loginId', { max: 80, pattern: /^login-[a-z0-9-]+$/ }));
    },
    'gh:prAccessDiagnose': async (payload) => {
      const { repo, r, client, login, account, apiBase } = await repoCtx(payload);
      const apiHost = new URL(apiBase).host;
      const host = apiHost === 'api.github.com' ? 'github.com' : apiHost;
      const base = `/repos/${r.owner}/${r.name}`;
      const [repoRes, pulls, cli] = await Promise.all([
        client
          .rest<{ owner?: { type?: string }; permissions?: Record<string, boolean>; message?: string }>('GET', base, { allowStatus: [401, 403, 404] })
          .catch(() => ({ status: 0, data: { message: 'GitHub could not be reached' } as { owner?: { type?: string }; permissions?: Record<string, boolean>; message?: string } })),
        client.rest<unknown>('GET', `${base}/pulls`, { query: { per_page: 1 }, allowStatus: [401, 403, 404] }).then((x) => x.status === 200).catch(() => false),
        cliStatus(repo.path, host),
      ]);
      const perms = repoRes.data?.permissions ?? {};
      const role = perms.admin ? 'admin' : perms.maintain ? 'maintain' : perms.push ? 'write' : perms.triage ? 'triage' : perms.pull ? 'read' : null;
      const ownerType = repoRes.data?.owner?.type;
      return {
        login,
        host,
        owner: r.owner,
        name: r.name,
        ownerType: ownerType === 'Organization' || ownerType === 'User' ? ownerType : null,
        tokenKind: account && ctx.sessions.status(account.id).scopes === null ? 'fine-grained' : 'classic',
        repoStatus: repoRes.status,
        repoMessage: repoRes.status === 200 ? null : (repoRes.data?.message ?? null),
        role,
        pullsReadable: pulls,
        cli,
      };
    },
    'gh:prEdit': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      const patch: { title?: string; body?: string; base?: string } = {};
      if (p.title !== undefined) patch.title = asLine(p.title, 'Title', { max: 256 });
      if (p.body !== undefined) patch.body = asString(p.body, 'Description', { min: 0, max: 65_000, trim: false });
      if (p.base !== undefined) patch.base = asBranchName(p.base, 'base branch');
      await prs.editPullRequest(client, r, asNum(p.number, 'number'), patch);
      ctx.recordOperation(repo, 'Edit PR', 'SUCCESS', `#${p.number} ${Object.keys(patch).join(', ')}`);
    },
    'gh:prState': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const state = asEnum(p.state, 'state', ['open', 'closed'] as const);
      await prs.setPrState(client, r, asNum(p.number, 'number'), state);
      ctx.recordOperation(repo, state === 'closed' ? 'Close PR' : 'Reopen PR', 'SUCCESS', `#${p.number}`);
    },
    'gh:prComment': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      await prs.addComment(client, r, asNum(p.number, 'number'), asBody(p.body));
    },
    'gh:prEditComment': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      await prs.editComment(client, r, asEnum(p.kind, 'kind', ['issue', 'review'] as const), asNum(p.databaseId, 'comment'), asBody(p.body));
    },
    'gh:prReply': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      await prs.replyToReviewComment(client, r, asNum(p.number, 'number'), asNum(p.commentId, 'comment'), asBody(p.body));
    },
    'gh:prResolveThread': async (payload) => {
      const { p, client } = await repoCtx(payload);
      await prs.setThreadResolved(client, asNodeId(p.threadId, 'thread'), asBoolean(p.resolved, 'resolved'));
    },
    'gh:prReviewComment': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      await prs.addReviewComment(client, r, asNum(p.number, 'number'), asSha(p.commitId), draftComment(p.comment));
    },
    'gh:prSubmitReview': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const comments = (Array.isArray(p.comments) ? p.comments : []).slice(0, 300).map(draftComment);
      const event = asEnum(p.event, 'review type', ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const);
      const body = asString(p.body ?? '', 'Review summary', { min: 0, max: 65_000, trim: false });
      if (event !== 'APPROVE' && !body.trim() && comments.length === 0) throw new ValidationError('Add a summary or at least one comment to submit this review');
      const res = await prs.submitReview(client, r, asNum(p.number, 'number'), { commitId: asSha(p.commitId), event, body, comments });
      ctx.recordOperation(repo, 'Submit review', 'SUCCESS', `#${p.number} ${event.toLowerCase()} with ${comments.length} comment(s)`);
      return res;
    },
    'gh:prReviewers': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      await prs.updateReviewers(client, r, asNum(p.number, 'number'), asLogins(p.add, 'add'), asLogins(p.remove, 'remove'));
    },
    'gh:prAssignees': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      await prs.updateAssignees(client, r, asNum(p.number, 'number'), asLogins(p.add, 'add'), asLogins(p.remove, 'remove'));
    },
    'gh:prLabels': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      await prs.setLabels(client, r, asNum(p.number, 'number'), asStringArray(p.labels ?? [], 'labels', 100).map((l) => asLine(l, 'label', { max: 100 })));
    },
    'gh:labelCreate': async (payload) => {
      const { p, r, client, login } = await repoCtx(payload);
      await prs.createLabel(client, r, {
        name: asLine(p.name, 'Label name', { max: 50 }),
        color: asString(p.color, 'color', { pattern: /^[0-9a-fA-F]{6}$/ }),
        description: asOptionalString(p.description, 'description', { max: 100 }),
      });
      invalidate(r, login);
    },
    'gh:prMilestone': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      await prs.setMilestone(client, r, asNum(p.number, 'number'), p.milestone === null ? null : asNum(p.milestone, 'milestone'));
    },
    'gh:jobLogs': async (payload) => {
      const { p, repo, r, client, apiBase } = await repoCtx(payload);
      const jobId = asNum(p.jobId, 'job');
      const runId = p.runId === undefined || p.runId === null ? undefined : asNum(p.runId, 'run');
      const jobName = p.jobName === undefined || p.jobName === null ? undefined : asString(p.jobName, 'job name', { max: 300 });
      const apiHost = new URL(apiBase).host;
      const ghRepo = apiHost === 'api.github.com' ? `${r.owner}/${r.name}` : `${apiHost}/${r.owner}/${r.name}`;
      // Last resort: the user's own GitHub CLI (only if it is installed and signed in; gh adds its token itself).
      const cli = runId ? () => runGhChecked(['run', 'view', String(runId), '--job', String(jobId), '--log', '-R', ghRepo], repo.path, '') : undefined;
      return wf.robustJobLogs(client, r, { jobId, runId, jobName }, cli);
    },
    'gh:jobAnnotations': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return wf.jobAnnotations(client, r, asNum(p.jobId, 'job'));
    },
    'gh:rerunJob': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      await prs.rerunJob(client, r, asNum(p.jobId, 'job'));
      ctx.recordOperation(repo, 'Re-run check', 'SUCCESS', `job ${p.jobId}`);
    },

    // ---------------- merge ----------------
    'gh:preMerge': async (payload) => {
      const { p, repo, r, client, login } = await repoCtx(payload);
      const number = asNum(p.number, 'number');
      const state = await loadMergeState(client, r, number);
      const { rules, readable, raw } = await loadBranchRules(client, r, state.baseRefName);
      const requirements = evaluateMerge(state, raw);
      const authOptions: MergeAuthOption[] = [
        { id: 'session', label: `Signed-in account (${login})`, description: 'Merge with the GitHub session of the account selected in the header.', available: true },
        { id: 'github-app', label: 'GitHub App Installation Token', description: 'Generate a short-lived token (contents + pull requests: write) for this repository only; revoked right after the merge.', available: true },
        {
          id: 'ssh',
          label: 'SSH',
          description: 'SSH authenticates Git transport, not the GitHub API.',
          available: false,
          reason: 'GitHub merges pull requests through its API, which cannot be authenticated with an SSH key. To merge over SSH, merge the branch locally and push it (Push dialog → SSH).',
        },
      ];
      const report: PreMergeReport = {
        prNumber: number,
        title: state.title,
        headOid: state.headRefOid,
        baseRefName: state.baseRefName,
        headRefName: state.headRefName,
        state: state.state,
        requirements,
        rules,
        rulesReadable: readable,
        mergeMethods: state.mergeMethods,
        defaultMethod: defaultMergeMethod(state, raw),
        summary: worst(requirements.map((x) => x.state)),
        authOptions,
        account: login,
        githubApp: repo.settings.githubApp ? { appId: repo.settings.githubApp.appId, owner: r.owner, repo: r.name } : null,
      };
      return report;
    },
    'gh:merge': async (payload) => {
      const { p, repo, r, client, login, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const number = asNum(p.number, 'number');
      const method = asEnum(p.method, 'merge method', ['merge', 'squash', 'rebase'] as const);
      const sha = asSha(p.sha);
      const title = asOptionalString(p.title, 'Commit title', { max: 256 });
      const message = asOptionalString(p.message, 'Commit message', { max: 65_000, trim: false });
      const auth = asObject(p.auth, 'auth');
      const authMethod = asEnum(auth.method, 'authentication', ['session', 'github-app'] as const);

      // Inspect the current state first: never merge something other than what was reviewed.
      const current = await loadMergeState(client, r, number);
      if (current.state === 'MERGED') return { merged: true, sha: current.mergeCommitOid, message: 'This pull request was already merged.', authDescription: 'not needed' };
      if (current.headRefOid !== sha) throw new AppError({ code: 'head-changed', title: 'Pull Request Changed', message: 'New commits were pushed after you opened the merge dialog. Review the merge again.', actions: ['retry'] });

      let mergeClient = client;
      let authDescription = `GitHub session of ${login}`;
      let cleanup: () => Promise<void> = async () => {};
      if (authMethod === 'github-app') {
        const appId = asNumericId(auth.appId, 'App ID');
        let pem: string | null = null;
        if (auth.keyHandle) pem = ctx.vault.take(asString(auth.keyHandle, 'keyHandle', { max: 64 }), 'private-key');
        else if (auth.privateKey) pem = asString(auth.privateKey, 'Private key', { max: 16_384, trim: false });
        else if (auth.useSavedKey === true) {
          if (!repo.settings.allowSavedCredentials) throw new AppError({ code: 'auth-input', title: 'Saved Key Unavailable', message: 'Saved credentials are disabled for this repository.' });
          pem = ctx.secrets.getGitHubAppKey(repo.id);
        }
        if (!pem) throw new AppError({ code: 'auth-input', title: 'Private Key Required', message: 'Load or paste the GitHub App private key.', actions: ['review-auth'] });
        const key = parsePrivateKey(pem);
        pem = null;
        const gh = ctx.githubFor(apiBase);
        const tok = await gh.generateInstallationToken({
          appId,
          key,
          owner: r.owner,
          repo: r.name,
          installationId: auth.installationId ? asNumericId(auth.installationId, 'Installation ID') : undefined,
          permissions: { contents: 'write', pull_requests: 'write' },
        });
        let token = tok.token;
        mergeClient = new GitHubClient(apiBase, token);
        authDescription = `GitHub App ${appId} installation token (repository-scoped, revoked after use)`;
        ctx.tokens.track(token, { source: 'operation', apiBase, appId: String(appId), repositories: [`${r.owner}/${r.name}`], permissions: tok.permissions, expiresAt: tok.expiresAt, purpose: 'merge' });
        cleanup = async () => {
          const ok = await revokeWithRetry(gh, token);
          ctx.tokens.setResult(token, ok);
          token = '';
        };
      }
      try {
        const res = await mergePullRequest(mergeClient, r, number, { method, sha, title, message });
        ctx.recordOperation(repo, 'Merge PR', res.merged ? 'SUCCESS' : 'FAILED', `#${number} (${method}) ${res.sha ? res.sha.slice(0, 7) : ''} using ${authDescription}`);
        return { ...res, authDescription };
      } catch (err) {
        ctx.recordOperation(repo, 'Merge PR', 'FAILED', `#${number} (${method}) using ${authDescription}`);
        throw err;
      } finally {
        await cleanup();
      }
    },

    // ---------------- security & quality ----------------
    'gh:secOverview': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return sec.getSecurityOverview(client, r);
    },
    'gh:codeScanning': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return sec.listCodeScanningAlerts(client, r, {
        state: p.state ? asEnum(p.state, 'state', ['open', 'closed', 'dismissed', 'fixed'] as const) : undefined,
        severity: p.severity ? asEnum(p.severity, 'severity', ['critical', 'high', 'medium', 'low', 'warning', 'note', 'error'] as const) : undefined,
        tool: asOptionalString(p.tool, 'tool', { max: 100 }),
        ref: p.ref ? asBranchName(p.ref, 'branch') : undefined,
      });
    },
    'gh:codeScanningAlert': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return sec.codeScanningAlertDetails(client, r, asNum(p.number, 'alert'));
    },
    'gh:codeScanningUpdate': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const state = asEnum(p.state, 'state', ['open', 'dismissed'] as const);
      await sec.updateCodeScanningAlert(client, r, asNum(p.number, 'alert'), {
        state,
        reason: state === 'dismissed' ? asEnum(p.reason, 'reason', ['false positive', "won't fix", 'used in tests'] as const) : undefined,
        comment: asOptionalString(p.comment, 'comment', { max: 280 }),
      });
      ctx.recordOperation(repo, state === 'dismissed' ? 'Dismiss code scanning alert' : 'Reopen code scanning alert', 'SUCCESS', `#${p.number}`);
    },
    'gh:dependabot': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return sec.listDependabotAlerts(client, r, {
        state: p.state ? asEnum(p.state, 'state', ['open', 'dismissed', 'fixed', 'auto_dismissed'] as const) : undefined,
        severity: p.severity ? asEnum(p.severity, 'severity', ['critical', 'high', 'medium', 'low'] as const) : undefined,
        ecosystem: asOptionalString(p.ecosystem, 'ecosystem', { max: 50 }),
      });
    },
    'gh:dependabotUpdate': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const state = asEnum(p.state, 'state', ['open', 'dismissed'] as const);
      await sec.updateDependabotAlert(client, r, asNum(p.number, 'alert'), {
        state,
        reason: state === 'dismissed' ? asEnum(p.reason, 'reason', ['fix_started', 'inaccurate', 'no_bandwidth', 'not_used', 'tolerable_risk'] as const) : undefined,
        comment: asOptionalString(p.comment, 'comment', { max: 280 }),
      });
      ctx.recordOperation(repo, state === 'dismissed' ? 'Dismiss Dependabot alert' : 'Reopen Dependabot alert', 'SUCCESS', `#${p.number}`);
    },
    'gh:dependabotPrs': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return sec.dependabotPullRequests(client, r);
    },
    'gh:dependabotCommand': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const command = asEnum(p.command, 'command', ['rebase', 'recreate'] as const);
      await prs.addComment(client, r, asNum(p.number, 'number'), `@dependabot ${command}`);
      ctx.recordOperation(repo, 'Dependabot command', 'SUCCESS', `#${p.number} @dependabot ${command}`);
    },
    'gh:secSetting': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const setting = asEnum(p.setting, 'setting', ['vulnerability-alerts', 'automated-security-fixes'] as const);
      const enabled = asBoolean(p.enabled, 'enabled');
      if (setting === 'vulnerability-alerts') await sec.setVulnerabilityAlerts(client, r, enabled);
      else await sec.setAutomatedSecurityFixes(client, r, enabled);
      ctx.recordOperation(repo, 'Security setting', 'SUCCESS', `${setting} ${enabled ? 'enabled' : 'disabled'}`);
      return sec.getSecurityOverview(client, r);
    },
    'gh:repoOverview': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return getRepoOverview(client, r);
    },
    'gh:readLocalFile': async (payload) => {
      const p = asObject(payload);
      const { repo } = ctx.git(p.repoId);
      const full = resolveInsideRepo(repo.path, asString(p.path, 'path', { trim: false }));
      const buf = await fs.readFile(full).catch(() => null);
      if (!buf) throw new AppError({ code: 'file-missing', title: 'File Not Found Locally', message: `${p.path} does not exist in your local working copy (it may be on another branch).` });
      if (looksBinary(buf)) throw new AppError({ code: 'binary', title: 'Binary File', message: 'This file is binary and cannot be shown.' });
      const max = 1024 * 1024;
      return { path: String(p.path), content: buf.subarray(0, max).toString('utf8'), truncated: buf.length > max };
    },

    // ---------------- actions ----------------
    'gh:workflows': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return wf.listWorkflows(client, r);
    },
    'gh:runs': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return wf.listRuns(client, r, {
        workflowId: p.workflowId ? asNum(p.workflowId, 'workflow') : undefined,
        branch: p.branch ? asBranchName(p.branch, 'branch') : undefined,
        status: p.status ? asEnum(p.status, 'status', ['completed', 'success', 'failure', 'cancelled', 'in_progress', 'queued', 'waiting', 'action_required'] as const) : undefined,
        page: p.page ? asInt(p.page, 'page', 1, 1000) : 1,
      });
    },
    'gh:runJobs': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return wf.getRunJobs(client, r, asNum(p.runId, 'run'));
    },
    'gh:labelGates': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      const ref = asString(p.ref, 'commit or branch', { max: 255, pattern: /^[^-\s~^:?*[\\][^\s~^:?*[\\]*$/ });
      return wf.labelGates(client, r, ref);
    },
    'gh:runAction': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const action = asEnum(p.action, 'action', ['rerun', 'rerun-failed', 'cancel'] as const);
      await wf.runAction(client, r, asNum(p.runId, 'run'), action);
      ctx.recordOperation(repo, action === 'cancel' ? 'Cancel workflow run' : 'Re-run workflow', 'SUCCESS', `run ${p.runId}`);
    },
    'gh:dispatchInfo': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      const path = asString(p.path, 'path', { max: 300, pattern: /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/ });
      return wf.workflowDispatchInfo(client, r, path, asBranchName(p.ref, 'branch'));
    },
    'gh:dispatch': async (payload) => {
      const { p, repo, r, client, login, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const inputs: Record<string, string> = {};
      for (const [k, v] of Object.entries(asObject(p.inputs ?? {}, 'inputs'))) inputs[asString(k, 'input name', { max: 100, pattern: /^[A-Za-z0-9_-]+$/ })] = asString(v, k, { min: 0, max: 10_000, trim: false });
      const ref = asBranchName(p.ref, 'branch');
      const workflowId = asNum(p.workflowId, 'workflow');
      const op = await operationClient(repo, r, apiBase, login, p.auth, { actions: 'write', contents: 'read' }, 'run workflow');
      const since = Date.now();
      try {
        await wf.dispatchWorkflow(op.client, r, workflowId, ref, inputs);
        ctx.recordOperation(repo, 'Run workflow', 'SUCCESS', `workflow ${workflowId} on ${ref} using ${op.description}`);
      } catch (err) {
        ctx.recordOperation(repo, 'Run workflow', 'FAILED', `workflow ${workflowId} on ${ref} using ${op.description}`);
        throw err;
      } finally {
        await op.cleanup();
      }
      // Reading the new run only needs the session.
      const runId = await wf.findDispatchedRun(client, r, workflowId, ref, since);
      return { runId, authDescription: op.description };
    },
    // ---------------- account centre ----------------
    'gh:acctProfile': async (payload) => {
      const p = asObject(payload ?? {});
      return acct.getProfile((await session()).client, p.year === undefined || p.year === null ? undefined : asInt(p.year, 'year', 2008, 2100));
    },
    'gh:acctRepos': async (payload) => {
      const p = asObject(payload ?? {});
      return acct.listRepos((await session()).client, p.after ? asString(p.after, 'cursor', { max: 200 }) : null);
    },
    'gh:acctUpdateProfile': async (payload) => {
      const patch = asObject(asObject(payload).patch, 'profile');
      const out: import('../../shared/github').PublicProfilePatch = {};
      const field = (k: 'name' | 'blog' | 'company' | 'location' | 'bio' | 'twitter_username', max: number) => {
        if (patch[k] !== undefined) out[k] = asString(patch[k], k, { min: 0, max, trim: true });
      };
      field('name', 255);
      field('blog', 255);
      field('company', 255);
      field('location', 255);
      field('bio', 160);
      field('twitter_username', 15);
      if (patch.hireable !== undefined) out.hireable = asBoolean(patch.hireable, 'hireable');
      await acct.updateProfile((await session()).client, out);
      ctx.recordOperation(null, 'Update profile', 'SUCCESS', Object.keys(out).join(', '));
    },
    'gh:acctEmails': async () => acct.listEmails((await session()).client),
    'gh:acctSshKeys': async () => {
      const s = await session();
      return acct.listSshKeys(s.client, keyTokenInfo(s.account));
    },
    'gh:acctAddSshKey': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const kind = asEnum(p.kind, 'kind', ['authentication', 'signing'] as const);
      const title = asLine(p.title, 'Title', { max: 100 });
      const key = asString(p.key, 'Public key', { max: 16_384, pattern: SSH_PUBLIC_KEY });
      const op = await userOperation(p.auth, `add an SSH ${kind} key`);
      try {
        await acct.addSshKey(op.client, kind, title, key.trim());
        ctx.recordOperation(null, 'Add SSH key', 'SUCCESS', `${title} (${kind}) using ${op.description}`);
      } finally {
        await op.cleanup();
      }
    },
    'gh:acctDeleteSshKey': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const kind = asEnum(p.kind, 'kind', ['authentication', 'signing'] as const);
      const id = asNum(p.id, 'key');
      const op = await userOperation(p.auth, 'delete an SSH key');
      try {
        await acct.deleteSshKey(op.client, kind, id);
        ctx.recordOperation(null, 'Delete SSH key', 'SUCCESS', `${kind} key ${id} using ${op.description}`);
      } finally {
        await op.cleanup();
      }
    },
    'gh:acctGpgKeys': async () => {
      const s = await session();
      const r = await acct.listGpgKeysWithAccess(s.client, keyTokenInfo(s.account));
      if (!r.access.ok) throw acct.keyAccessError(r.access.missing, r.access.tokenKind);
      return r.keys;
    },
    'gh:acctGpgKeyList': async () => {
      const s = await session();
      return acct.listGpgKeysWithAccess(s.client, keyTokenInfo(s.account));
    },
    'gh:acctAddGpgKey': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const name = asLine(p.name, 'Name', { max: 100 });
      const armored = asString(p.armored, 'Public key', { max: 65_536, trim: false });
      if (!armored.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) throw new ValidationError('Paste an ASCII-armoured PUBLIC key (BEGIN PGP PUBLIC KEY BLOCK)');
      if (armored.includes('PRIVATE KEY')) throw new ValidationError('That is a private key — never upload it. Export the public key instead.');
      const op = await userOperation(p.auth, 'add a GPG key');
      try {
        await acct.addGpgKey(op.client, name, armored);
        ctx.recordOperation(null, 'Add GPG key', 'SUCCESS', `${name} using ${op.description}`);
      } finally {
        await op.cleanup();
      }
    },
    'gh:acctDeleteGpgKey': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const id = asNum(p.id, 'key');
      const op = await userOperation(p.auth, 'delete a GPG key');
      try {
        await acct.deleteGpgKey(op.client, id);
        ctx.recordOperation(null, 'Delete GPG key', 'SUCCESS', `key ${id} using ${op.description}`);
      } finally {
        await op.cleanup();
      }
    },
    'gh:acctCredentials': async () => {
      const repos = ctx.repos.list();
      const tokens = ctx.tokens.list();
      return {
        accounts: ctx.accounts.list().map((a) => {
          const st = ctx.sessions.status(a.id);
          return { login: a.login, remembered: ctx.accountSecrets.has(a.id), signedIn: st.active, scopes: st.scopes, host: new URL(a.apiBaseUrl ?? DEFAULT_API_BASE).host.replace(/^api\./, '') };
        }),
        repoPats: repos.flatMap((r) => {
          const pat = ctx.secrets.getPat(r.id);
          return pat ? [{ repo: r.name, username: pat.username || '(default)' }] : [];
        }),
        repoAppKeys: repos.filter((r) => ctx.secrets.status(r.id).githubAppKey).map((r) => ({ repo: r.name, appId: r.settings.githubApp?.appId ?? null })),
        repoSshKeys: repos.filter((r) => r.settings.sshKeyPath).map((r) => ({ repo: r.name, keyFile: r.settings.sshKeyPath!.replace(/^.*[\\/]/, '') })),
        apps: ctx.appRegistry?.list() ?? [],
        installationTokens: { active: tokens.filter((t) => t.status === 'active').length, revoked: tokens.filter((t) => t.status === 'revoked').length, total: tokens.length },
        encryptionAvailable: ctx.secrets.encryptionAvailable(),
      };
    },
    'gh:localGpg': async () => {
      const st = await gpgStatus();
      return { available: st.available, version: st.version, binary: st.binary, keys: st.available ? await listLocalGpgKeys().catch(() => []) : [] };
    },
    'gh:localGpgGenerate': async (payload) => {
      const p = asObject(payload);
      const name = asLine(p.name, 'Name', { max: 100, pattern: /^[^<>()]+$/ });
      const email = asString(p.email, 'Email', { max: 254, pattern: /^[^\s<>()@]+@[^\s<>()@]+\.[^\s<>()@]+$/ });
      const passphrase = asString(p.passphrase ?? '', 'Passphrase', { min: 0, max: 256, trim: false });
      if (/[\r\n]/.test(passphrase)) throw new ValidationError('The passphrase cannot contain line breaks');
      const expiry = asEnum(p.expiry, 'expiry', ['1y', '2y', 'never'] as const);
      const key = await generateGpgKey({ name, email, passphrase, expiry });
      ctx.recordOperation(null, 'Generate GPG key', 'SUCCESS', `${key.keyId} for ${email}`);
      return { key, publicKey: await exportGpgPublicKey(key.fingerprint || key.keyId) };
    },
    'gh:localGpgExport': async (payload) => ({ publicKey: await exportGpgPublicKey(asString(asObject(payload).keyId, 'key', { max: 40 })) }),

    // ---------------- GitHub Apps registered at account level ----------------
    'gh:appsList': async () => registry().list(),
    'gh:appsAdd': async (payload) => {
      const p = asObject(payload);
      const appId = asNumericId(p.appId, 'App ID');
      const apiBase = p.apiBaseUrl ? asString(p.apiBaseUrl, 'API URL', { max: 300, pattern: /^https:\/\/[^\s]+$/ }).replace(/\/$/, '') : (ctx.accounts.get(ctx.accounts.activeId() ?? '')?.apiBaseUrl ?? DEFAULT_API_BASE);
      let pem: string | null = p.keyHandle ? ctx.vault.take(asString(p.keyHandle, 'keyHandle', { max: 64 }), 'private-key') : p.privateKey ? asString(p.privateKey, 'Private key', { max: 16_384, trim: false }) : null;
      if (!pem) throw new AppError({ code: 'auth-input', title: 'Private Key Required', message: 'Load or paste the App private key (.pem).' });
      try {
        const d = await acct.appDetails(apiBase, appId, parsePrivateKey(pem));
        const rec = registry().upsert({ appId, apiBase, ...d }, pem);
        ctx.recordOperation(null, 'Register GitHub App', 'SUCCESS', `${d.name} (${appId})`);
        return rec;
      } finally {
        pem = null;
      }
    },
    'gh:appsRemove': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const id = asId(p.id, 'app');
      let unlinked = 0;
      for (const repo of ctx.repos.list()) {
        if (repo.settings.githubApp?.registryId === id) {
          ctx.repos.updateSettings(repo.id, { githubApp: undefined });
          unlinked++;
        }
      }
      const app = registry().get(id);
      registry().remove(id);
      ctx.recordOperation(null, 'Remove GitHub App', 'SUCCESS', `${app?.name ?? id}; unlinked from ${unlinked} repositor${unlinked === 1 ? 'y' : 'ies'}`);
      return { unlinked };
    },
    'gh:appsInstallations': async (payload) => {
      const { app, key } = registeredKey(asObject(payload).id);
      return acct.appInstallations(app.apiBase, app.appId, key);
    },
    'gh:appsInstallationRepos': async (payload) => {
      const p = asObject(payload);
      const { app, key } = registeredKey(p.id);
      return acct.installationRepos(app.apiBase, app.appId, key, asNum(p.installationId, 'installation'));
    },

    // ---------------- repository administration ----------------
    'gh:adminSecrets': async (payload) => {
      const { r, client } = await repoCtx(payload);
      const isOrg = await client
        .get<{ owner?: { type?: string } }>(`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`, { action: 'read the repository' })
        .then((x) => x.owner?.type === 'Organization')
        .catch(() => false);
      return admin.secretsOverview(client, r, isOrg);
    },
    'gh:adminSecretUsage': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return admin.secretUsage(client, r);
    },
    'gh:adminPutSecret': async (payload) => {
      const { p, repo, r, client, login, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const scope = asEnum(p.scope, 'scope', ['repo', 'env', 'org', 'copilot'] as const);
      const env = scope === 'env' ? asString(p.env, 'environment', { max: 255, pattern: /^[^/\\\0]+$/ }) : undefined;
      const name = asSecretName(p.name);
      const value = asString(p.value, 'Secret value', { min: 1, max: 48 * 1024, trim: false });
      const orgVisibility = p.orgVisibility ? asEnum(p.orgVisibility, 'visibility', ['all', 'private', 'selected'] as const) : undefined;
      const perms: Record<string, 'read' | 'write'> = scope === 'org' ? { organization_secrets: 'write' } : { secrets: 'write', environments: 'write' };
      const op = await operationClient(repo, r, apiBase, login, p.auth, perms, 'save a secret');
      try {
        const repoNumericId = scope === 'org' && (orgVisibility ?? 'selected') === 'selected' ? await admin.repoId(client, r) : undefined;
        await admin.putSecret(op.client, r, { scope, env, name, value, orgVisibility, repoId: repoNumericId });
        ctx.recordOperation(repo, 'Save secret', 'SUCCESS', `${name} (${scope}${env ? `: ${env}` : ''}) using ${op.description}`);
      } catch (err) {
        ctx.recordOperation(repo, 'Save secret', 'FAILED', `${name} (${scope}) using ${op.description}`);
        throw err;
      } finally {
        await op.cleanup();
      }
    },
    'gh:adminDeleteSecret': async (payload) => {
      const { p, repo, r, login, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const scope = asEnum(p.scope, 'scope', ['repo', 'env', 'org', 'copilot'] as const);
      const env = scope === 'env' ? asString(p.env, 'environment', { max: 255, pattern: /^[^/\\\0]+$/ }) : undefined;
      const name = asSecretName(p.name);
      const op = await operationClient(repo, r, apiBase, login, p.auth, scope === 'org' ? { organization_secrets: 'write' } : { secrets: 'write', environments: 'write' }, 'delete a secret');
      try {
        await admin.deleteSecret(op.client, r, { scope, env, name });
        ctx.recordOperation(repo, 'Delete secret', 'SUCCESS', `${name} (${scope}${env ? `: ${env}` : ''}) using ${op.description}`);
      } finally {
        await op.cleanup();
      }
    },
    'gh:adminCreateEnv': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      const name = asLine(p.name, 'Environment', { max: 255, pattern: /^[^/\\\0'"]+$/ });
      await admin.createEnvironment(client, r, name);
      ctx.recordOperation(repo, 'Create environment', 'SUCCESS', name);
    },
    'gh:adminDeployKeys': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return admin.listDeployKeys(client, r);
    },
    'gh:adminAddDeployKey': async (payload) => {
      const { p, repo, r, login, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const title = asLine(p.title, 'Title', { max: 100 });
      const key = asString(p.key, 'Public key', { max: 16_384, pattern: SSH_PUBLIC_KEY }).trim();
      const readOnly = asBoolean(p.readOnly, 'readOnly');
      const op = await operationClient(repo, r, apiBase, login, p.auth, { administration: 'write' }, 'add a deploy key');
      try {
        await admin.addDeployKey(op.client, r, { title, key, readOnly });
        ctx.recordOperation(repo, 'Add deploy key', 'SUCCESS', `${title} (${readOnly ? 'read-only' : 'read/write'}) using ${op.description}`);
      } finally {
        await op.cleanup();
      }
    },
    'gh:adminDeleteDeployKey': async (payload) => {
      const { p, repo, r, login, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const id = asNum(p.id, 'key');
      const op = await operationClient(repo, r, apiBase, login, p.auth, { administration: 'write' }, 'delete a deploy key');
      try {
        await admin.deleteDeployKey(op.client, r, id);
        ctx.recordOperation(repo, 'Delete deploy key', 'SUCCESS', `key ${id} using ${op.description}`);
      } finally {
        await op.cleanup();
      }
    },
    'gh:adminBranches': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return admin.remoteBranches(client, r);
    },
    'gh:adminTags': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return admin.remoteTags(client, r);
    },
    'gh:adminCommits': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      const ref = asString(p.ref, 'branch or tag', { max: 255, pattern: /^[^-\s~^:?*[\\][^\s~^:?*[\\]*$/ });
      return admin.remoteCommits(client, r, ref, p.page ? asInt(p.page, 'page', 1, 1000) : 1);
    },
    'gh:adminDeleteRepo': async (payload) => {
      const { p, repo, r, login, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const full = `${r.owner}/${r.name}`;
      if (asString(p.typedName, 'confirmation', { max: 300 }) !== full) throw new ValidationError(`Type ${full} exactly to confirm`);
      const op = await operationClient(repo, r, apiBase, login, p.auth, { administration: 'write' }, 'delete the repository');
      try {
        await admin.deleteRepository(op.client, r);
        ctx.recordOperation(repo, 'Delete GitHub repository', 'SUCCESS', `${full} using ${op.description}`);
      } catch (err) {
        ctx.recordOperation(repo, 'Delete GitHub repository', 'FAILED', `${full} using ${op.description}`);
        throw err;
      } finally {
        await op.cleanup();
      }
    },
    'gh:adminAppStatus': async (payload) => {
      const { repo, r } = await repoCtx(payload);
      const apps = ctx.appRegistry?.list() ?? [];
      const id = repo.settings.githubApp?.registryId;
      const linkedApp = id ? apps.find((a) => a.id === id) : undefined;
      if (!linkedApp) return { linked: null, apps };
      const pem = ctx.appRegistry!.getKey(linkedApp.id);
      const installed = pem ? await acct.repoInstallation(linkedApp.apiBase, linkedApp.appId, parsePrivateKey(pem), r.owner, r.name).catch(() => null) : null;
      return { linked: { ...linkedApp, installed }, apps };
    },
    'gh:adminLinkApp': async (payload) => {
      const { p, repo, r } = await repoCtx(payload);
      const { app, key } = registeredKey(p.registryId);
      const inst = await acct.repoInstallation(app.apiBase, app.appId, key, r.owner, r.name);
      ctx.repos.updateSettings(repo.id, {
        githubApp: { appId: app.appId, owner: r.owner, repo: r.name, installationId: inst ? String(inst.id) : undefined, registryId: app.id },
        // Linking is the explicit opt-in to use the account-level key for this repository.
        allowSavedCredentials: true,
      });
      ctx.recordOperation(repo, 'Link GitHub App', 'SUCCESS', `${app.name} (${app.appId})${inst ? '' : ' — not installed yet'}`);
      return { installed: !!inst, installationId: inst?.id ?? null };
    },
    'gh:adminUnlinkApp': async (payload) => {
      const { repo } = await repoCtx(payload);
      if (repo.settings.githubApp?.registryId) ctx.repos.updateSettings(repo.id, { githubApp: undefined });
      ctx.recordOperation(repo, 'Unlink GitHub App', 'SUCCESS', '');
    },

    'gh:repoTags': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return wf.listTags(client, r);
    },
    'gh:starterWorkflows': async (payload) => {
      const { r, client } = await repoCtx(payload);
      return wf.starterWorkflows(client, r);
    },
    'gh:starterWorkflow': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return wf.starterWorkflow(client, r, asString(p.category, 'category', { max: 40 }), asString(p.id, 'template', { max: 100 }));
    },
    'gh:marketplaceSearch': async (payload) => {
      const { p, client } = await repoCtx(payload);
      return wf.marketplaceSearch(client, asString(p.query, 'search', { min: 0, max: 100 }));
    },
    'gh:actionLatest': async (payload) => {
      const { p, client } = await repoCtx(payload);
      return wf.actionLatest(client, asString(p.fullName, 'action', { max: 200, pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ }));
    },
    'gh:workflowFile': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return wf.readFile(client, r, asWorkflowPath(p.path), asBranchName(p.ref, 'branch'));
    },
    'gh:workflowWrite': async (payload) => {
      const { p, repo, r, login, apiBase } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const path = asWorkflowPath(p.path);
      const branch = asBranchName(p.branch, 'branch');
      const mode = asEnum(p.mode, 'mode', ['direct', 'pull-request'] as const);
      const content = asString(p.content, 'Workflow', { min: 1, max: 200_000, trim: false });
      const message = asLine(p.message, 'Commit message', { max: 200 });
      const existingSha = p.existingSha ? asSha(p.existingSha) : null;
      // Writing under .github/workflows needs the "workflow" scope (PAT) or "workflows: write" (App).
      const op = await operationClient(repo, r, apiBase, login, p.auth, { contents: 'write', workflows: 'write', pull_requests: 'write' }, 'commit a workflow');
      try {
        const res = await wf.writeWorkflow(op.client, r, { path, content, branch, mode, message, existingSha });
        ctx.recordOperation(repo, 'Commit workflow', 'SUCCESS', `${path} → ${res.mode === 'direct' ? branch : `PR from ${res.branch}`} using ${op.description}`);
        return { ...res, authDescription: op.description };
      } catch (err) {
        ctx.recordOperation(repo, 'Commit workflow', 'FAILED', `${path} using ${op.description}`);
        throw err;
      } finally {
        await op.cleanup();
      }
    },
    'gh:templates': async () => wf.TEMPLATES,
    'gh:templatePropose': async (payload) => {
      const { p, r, client } = await repoCtx(payload);
      return wf.proposeTemplate(client, r, asString(p.templateId, 'template', { max: 50 }));
    },
    'gh:templateApply': async (payload) => {
      const { p, repo, r, client } = await repoCtx(payload);
      asConfirmed(p.confirmed);
      const path = asString(p.path, 'path', { max: 200, pattern: /^\.github\/(workflows\/[A-Za-z0-9._-]+\.ya?ml|dependabot\.ya?ml)$/ });
      // Only paths of known templates may be written — never arbitrary workflows.
      if (!wf.TEMPLATES.some((t) => t.path === path)) throw new ValidationError('Only the listed configurations can be written');
      const res = await wf.applyTemplate(client, r, {
        path,
        content: asString(p.content, 'content', { max: 100_000, trim: false }),
        mode: asEnum(p.mode, 'mode', ['pull-request', 'direct'] as const),
        overwrite: asBoolean(p.overwrite, 'overwrite'),
        existingSha: p.existingSha ? asString(p.existingSha, 'sha', { pattern: /^[0-9a-f]{40}$/ }) : null,
        templateName: asLine(p.templateName, 'name', { max: 100 }),
      });
      ctx.recordOperation(repo, 'Configure workflow', 'SUCCESS', `${path} via ${res.mode === 'pull-request' ? 'pull request' : 'direct commit'}: ${res.url}`);
      return res;
    },
  };

  // When GitHub rejects the signed-in account's token (password changed, token revoked or expired),
  // drop the session and the saved sign-in so the app asks the user to sign in again.
  for (const key of Object.keys(handlers) as GitHubChannels[]) {
    const inner = handlers[key] as (payload: unknown) => Promise<unknown>;
    (handlers as Record<string, (payload: unknown) => Promise<unknown>>)[key] = async (payload) => {
      try {
        return await inner(payload);
      } catch (err) {
        const id = ctx.accounts.activeId();
        if (id && isRejectedCredential(err) && (await ctx.sessions.stillValid(id)) === false) throw ctx.sessions.invalidate(id);
        throw err;
      }
    };
  }
  return handlers;
}
