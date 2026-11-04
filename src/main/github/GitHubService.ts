import * as crypto from 'node:crypto';
import { AppError } from '../git/errors';
import { redactSecrets } from '../util/redact';

export const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'GitBaba-Desktop';

export interface InstallationToken {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
  repositories: string[];
  installationId: string;
}

export interface InstallationSummary {
  id: string;
  account: string;
  targetType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
}

export interface AppIdentity {
  id: string;
  slug: string;
  name: string;
  owner: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface RawRepo {
  full_name: string;
  name: string;
  owner: { login: string; type: string };
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface RepoInfo {
  fullName: string;
  name: string;
  owner: string;
  ownerType: 'User' | 'Organization' | string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  canPush: boolean | null;
  canPull: boolean | null;
}

function toRepoInfo(r: RawRepo): RepoInfo {
  return {
    fullName: r.full_name,
    name: r.name,
    owner: r.owner.login,
    ownerType: r.owner.type,
    private: r.private,
    htmlUrl: r.html_url,
    cloneUrl: r.clone_url,
    sshUrl: r.ssh_url,
    canPush: r.permissions?.push ?? null,
    canPull: r.permissions?.pull ?? null,
  };
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/** Normalises a pasted PEM (handles "\n" escapes and Windows line endings) and checks it is an RSA private key. */
export function parsePrivateKey(pem: string): crypto.KeyObject {
  const normalized = pem.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(normalized)) {
    throw new AppError({
      code: 'invalid-private-key',
      title: 'Invalid Private Key',
      message: 'The private key must be the .pem file downloaded from the GitHub App settings page (it begins with "-----BEGIN RSA PRIVATE KEY-----").',
    });
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: normalized, format: 'pem' });
  } catch {
    throw new AppError({ code: 'invalid-private-key', title: 'Invalid Private Key', message: 'The private key could not be read. Make sure the whole .pem file was supplied.' });
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new AppError({ code: 'invalid-private-key', title: 'Invalid Private Key', message: 'GitHub App keys must be RSA keys.' });
  }
  return key;
}

/** SHA256 fingerprint in the same format GitHub shows next to App private keys. */
export function privateKeyFingerprint(key: crypto.KeyObject): string {
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return `SHA256:${crypto.createHash('sha256').update(pub).digest('base64')}`;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Creates the short-lived (≤10 min) RS256 JWT a GitHub App uses to authenticate as itself.
 * `iat` is back-dated 60s to tolerate clock drift, as GitHub recommends.
 */
export function createAppJwt(appId: string, key: crypto.KeyObject, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}

export function validateApiBaseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AppError({ code: 'invalid-api-url', title: 'Invalid API URL', message: 'The GitHub API URL is not a valid URL.' });
  }
  if (u.protocol !== 'https:' || u.username || u.password) {
    throw new AppError({ code: 'invalid-api-url', title: 'Invalid API URL', message: 'The GitHub API URL must be an https:// URL without credentials.' });
  }
  return u.toString().replace(/\/+$/, '');
}

export function apiBaseForHost(host: string | null): string {
  if (!host || host === 'github.com') return DEFAULT_API_BASE;
  return `https://${host}/api/v3`;
}

/**
 * Thin GitHub REST client. Secrets are passed per call and never stored on the
 * instance; error details are redacted before they leave this class.
 */
export class GitHubService {
  constructor(
    private readonly apiBase: string = DEFAULT_API_BASE,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private async request<T>(method: string, path: string, auth: { type: 'bearer' | 'token'; value: string }, body?: unknown): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, auth, body)).data;
  }

  private async requestWithHeaders<T>(method: string, path: string, auth: { type: 'bearer' | 'token'; value: string }, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const url = `${this.apiBase}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
          Authorization: `${auth.type === 'bearer' ? 'Bearer' : 'token'} ${auth.value}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new GitHubApiError(0, 'network', redactSecrets(`${method} ${path}: ${err instanceof Error ? err.message : String(err)}`, [auth.value]));
    }
    if (res.status === 204) return { data: undefined as T, headers: res.headers };
    const text = await res.text();
    if (!res.ok) {
      let message = res.statusText;
      try {
        const parsed = JSON.parse(text) as { message?: string; errors?: { message?: string; code?: string }[] };
        message = parsed.message ?? message;
        const extra = parsed.errors?.map((e) => e.message ?? e.code).filter(Boolean).join('; ');
        if (extra) message = `${message}: ${extra}`;
      } catch {
        // non-JSON error body
      }
      const remaining = res.headers.get('x-ratelimit-remaining');
      const details = redactSecrets(`${method} ${path} → HTTP ${res.status}\n${message}${remaining === '0' ? '\n(rate limit exhausted)' : ''}`, [auth.value]);
      throw new GitHubApiError(res.status, redactSecrets(message, [auth.value]), details);
    }
    return { data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
  }

  // ---------------------------------------------------------------------
  // User accounts (token = PAT / fine-grained token of that account)
  // ---------------------------------------------------------------------

  /** Who does this token belong to? Also returns classic scopes (null for fine-grained tokens). */
  async getAuthenticatedUser(token: string): Promise<{ login: string; name: string | null; scopes: string[] | null }> {
    try {
      const { data, headers } = await this.requestWithHeaders<{ login: string; name: string | null }>('GET', '/user', { type: 'token', value: token });
      const raw = headers.get('x-oauth-scopes');
      return { login: data.login, name: data.name ?? null, scopes: raw === null ? null : raw.split(',').map((s) => s.trim()).filter(Boolean) };
    } catch (err) {
      throw this.toAppError(err, 'repositories');
    }
  }

  /** Organisations of the token's user (needs read:org for classic tokens; may be empty otherwise). */
  async getUserOrgs(token: string): Promise<string[]> {
    try {
      const orgs = await this.request<{ login: string }[]>('GET', '/user/orgs?per_page=100', { type: 'token', value: token });
      return orgs.map((o) => o.login);
    } catch {
      return [];
    }
  }

  /** Membership of the token's user in an organisation, or null if not visible. */
  async getOrgMembership(token: string, org: string): Promise<{ state: string; role: string } | null> {
    try {
      return await this.request<{ state: string; role: string }>('GET', `/user/memberships/orgs/${encodeURIComponent(org)}`, { type: 'token', value: token });
    } catch {
      return null;
    }
  }

  /** Repository details as seen by the token, or null when it does not exist / is not visible. */
  async getRepository(token: string, owner: string, repo: string): Promise<RepoInfo | null> {
    try {
      const r = await this.request<RawRepo>('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { type: 'token', value: token });
      return toRepoInfo(r);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw this.toAppError(err, 'repositories', { owner, repo });
    }
  }

  /** Repositories the token's user can read (own, collaborator, organisation), most recently updated first. */
  async listUserRepositories(token: string, maxPages = 10): Promise<{ fullName: string; owner: string; name: string; private: boolean; fork: boolean; archived: boolean; description: string | null; updatedAt: string | null }[]> {
    type Row = RawRepo & { fork?: boolean; archived?: boolean; description?: string | null; pushed_at?: string | null; updated_at?: string | null };
    const out: Awaited<ReturnType<GitHubService['listUserRepositories']>> = [];
    try {
      for (let page = 1; page <= maxPages; page++) {
        const rows = await this.request<Row[]>('GET', `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, { type: 'token', value: token });
        for (const r of rows) {
          out.push({
            fullName: r.full_name,
            owner: r.owner.login,
            name: r.name,
            private: r.private,
            fork: !!r.fork,
            archived: !!r.archived,
            description: r.description ?? null,
            updatedAt: r.pushed_at ?? r.updated_at ?? null,
          });
        }
        if (rows.length < 100) break;
      }
    } catch (err) {
      throw this.toAppError(err, 'repositories');
    }
    return out;
  }

  /** Creates a repository for the user (personal) or an organisation. */
  async createRepository(token: string, p: { owner: string; personal: boolean; name: string; private: boolean; description?: string }): Promise<RepoInfo> {
    const path = p.personal ? '/user/repos' : `/orgs/${encodeURIComponent(p.owner)}/repos`;
    try {
      const r = await this.request<RawRepo>('POST', path, { type: 'token', value: token }, { name: p.name, private: p.private, description: p.description ?? '', auto_init: false });
      return toRepoInfo(r);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422 && /name already exists/i.test(err.message)) {
        throw new AppError({ code: 'repo-exists', title: 'Repository Already Exists', message: `${p.owner}/${p.name} already exists on GitHub.`, technical: err.details });
      }
      if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
        throw new AppError({
          code: 'create-forbidden',
          title: 'Not Allowed to Create Repository',
          message: p.personal ? 'The token is not allowed to create repositories for this account.' : `The token is not allowed to create repositories in the "${p.owner}" organisation.`,
          reasons: [
            'Classic token: needs the "repo" scope (or "public_repo" for public repositories)',
            'Fine-grained token: needs "Administration: Read and write" for the account/organisation',
            'The organisation does not allow members to create repositories',
          ],
          actions: ['review-auth'],
          technical: err.details,
        });
      }
      throw this.toAppError(err, 'repositories', { owner: p.owner, repo: p.name });
    }
  }

  /** Verifies App ID + private key by calling GET /app with an App JWT. */
  async authenticate(appId: string, key: crypto.KeyObject): Promise<AppIdentity> {
    const jwt = createAppJwt(appId, key);
    try {
      const app = await this.request<{ id: number; slug: string; name: string; owner?: { login: string } }>('GET', '/app', { type: 'bearer', value: jwt });
      return { id: String(app.id), slug: app.slug, name: app.name, owner: app.owner?.login ?? '' };
    } catch (err) {
      throw this.toAppError(err, 'authenticate');
    }
  }

  async getInstallations(appId: string, key: crypto.KeyObject): Promise<InstallationSummary[]> {
    const jwt = createAppJwt(appId, key);
    try {
      const list = await this.request<
        { id: number; account: { login: string } | null; target_type: string; repository_selection: string; permissions: Record<string, string> }[]
      >('GET', '/app/installations?per_page=100', { type: 'bearer', value: jwt });
      return list.map((i) => ({
        id: String(i.id),
        account: i.account?.login ?? '',
        targetType: i.target_type,
        repositorySelection: i.repository_selection,
        permissions: i.permissions,
      }));
    } catch (err) {
      throw this.toAppError(err, 'installations');
    }
  }

  /** Finds the installation that covers owner/repo. */
  async getRepoInstallation(appId: string, key: crypto.KeyObject, owner: string, repo: string): Promise<InstallationSummary> {
    const jwt = createAppJwt(appId, key);
    try {
      const i = await this.request<{ id: number; account: { login: string }; target_type: string; repository_selection: string; permissions: Record<string, string> }>(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
        { type: 'bearer', value: jwt },
      );
      return { id: String(i.id), account: i.account?.login ?? '', targetType: i.target_type, repositorySelection: i.repository_selection, permissions: i.permissions };
    } catch (err) {
      throw this.toAppError(err, 'installation', { owner, repo });
    }
  }

  /**
   * Generates an installation access token scoped down to a single repository and
   * only the permissions the operation needs. GitHub tokens last at most 1 hour;
   * callers revoke them as soon as the operation finishes.
   */
  async generateInstallationToken(opts: {
    appId: string;
    key: crypto.KeyObject;
    owner: string;
    repo: string;
    installationId?: string;
    permissions?: Record<string, 'read' | 'write'>;
  }): Promise<InstallationToken> {
    const installationId = opts.installationId ?? (await this.getRepoInstallation(opts.appId, opts.key, opts.owner, opts.repo)).id;
    const jwt = createAppJwt(opts.appId, opts.key);
    try {
      const res = await this.request<{
        token: string;
        expires_at: string;
        permissions: Record<string, string>;
        repositories?: { full_name: string }[];
      }>('POST', `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { type: 'bearer', value: jwt }, {
        repositories: [opts.repo],
        ...(opts.permissions ? { permissions: opts.permissions } : {}),
      });
      return {
        token: res.token,
        expiresAt: res.expires_at,
        permissions: res.permissions,
        repositories: res.repositories?.map((r) => r.full_name) ?? [`${opts.owner}/${opts.repo}`],
        installationId,
      };
    } catch (err) {
      throw this.toAppError(err, 'token', { owner: opts.owner, repo: opts.repo });
    }
  }

  /** Revokes an installation token immediately (DELETE /installation/token). Failures are ignored. */
  async revokeInstallationToken(token: string): Promise<boolean> {
    try {
      await this.request('DELETE', '/installation/token', { type: 'token', value: token });
      return true;
    } catch {
      return false;
    }
  }

  async getRepositories(token: string): Promise<string[]> {
    try {
      const res = await this.request<{ repositories: { full_name: string }[] }>('GET', '/installation/repositories?per_page=100', { type: 'token', value: token });
      return res.repositories.map((r) => r.full_name);
    } catch (err) {
      throw this.toAppError(err, 'repositories');
    }
  }

  async createPullRequest(token: string, p: { owner: string; repo: string; title: string; body: string; head: string; base: string; draft: boolean }): Promise<{ number: number; url: string; title: string }> {
    try {
      const res = await this.request<{ number: number; html_url: string; title: string }>(
        'POST',
        `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/pulls`,
        { type: 'token', value: token },
        { title: p.title, body: p.body, head: p.head, base: p.base, draft: p.draft },
      );
      return { number: res.number, url: res.html_url, title: res.title };
    } catch (err) {
      throw this.toAppError(err, 'pull-request', { owner: p.owner, repo: p.repo });
    }
  }

  async getPullRequest(token: string, owner: string, repo: string, number: number): Promise<{ number: number; url: string; title: string; state: string }> {
    try {
      const res = await this.request<{ number: number; html_url: string; title: string; state: string }>(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
        { type: 'token', value: token },
      );
      return { number: res.number, url: res.html_url, title: res.title, state: res.state };
    } catch (err) {
      throw this.toAppError(err, 'pull-request', { owner, repo });
    }
  }

  /** Converts API failures into friendly, credential-free messages. */
  toAppError(err: unknown, stage: 'authenticate' | 'installations' | 'installation' | 'token' | 'repositories' | 'pull-request', ctx: { owner?: string; repo?: string } = {}): AppError {
    if (err instanceof AppError) return err;
    if (!(err instanceof GitHubApiError)) {
      return new AppError({ code: 'github-unexpected', title: 'GitHub Request Failed', message: 'An unexpected error occurred while talking to GitHub.', technical: redactSecrets(String(err)) });
    }
    const repoName = ctx.owner && ctx.repo ? `${ctx.owner}/${ctx.repo}` : 'the repository';
    const technical = err.details;
    if (err.status === 0) {
      return new AppError({ code: 'network', title: 'Cannot Reach GitHub', message: 'GitHub could not be reached. Check your internet connection, proxy, or the API URL.', actions: ['retry'], technical });
    }
    if (err.status === 401) {
      return new AppError({
        code: 'github-auth-failed',
        title: 'Authentication Failed',
        message: stage === 'pull-request' || stage === 'repositories' ? 'GitHub rejected the token.' : 'GitHub rejected the GitHub App credentials.',
        reasons:
          stage === 'pull-request' || stage === 'repositories'
            ? ['Token expired or was revoked', 'Token was copied incompletely']
            : ['The App ID does not match the private key', 'The private key was revoked or regenerated', "Your computer's clock is wrong (the JWT appears expired)"],
        actions: ['review-auth'],
        technical,
      });
    }
    if (err.status === 404) {
      if (stage === 'installation' || stage === 'token') {
        return new AppError({
          code: 'installation-not-found',
          title: 'GitHub App Not Installed',
          message: `The GitHub App is not installed on ${repoName}, or the repository does not exist.`,
          reasons: ['Install the App on the repository (or its organization)', 'If the App is installed on selected repositories only, add this repository', 'Check the owner and repository name'],
          actions: ['review-auth'],
          technical,
        });
      }
      return new AppError({
        code: 'github-not-found',
        title: 'Not Found',
        message: `GitHub could not find ${repoName}, or the credentials cannot access it.`,
        reasons: ['The repository is private and the token has no access', 'The owner or repository name is misspelled'],
        actions: ['review-auth'],
        technical,
      });
    }
    if (err.status === 403) {
      const rate = /rate limit/i.test(err.message) || /rate limit/i.test(err.details);
      return new AppError({
        code: rate ? 'rate-limited' : 'github-forbidden',
        title: rate ? 'GitHub Rate Limit Reached' : 'Permission Denied',
        message: rate ? 'Too many requests were sent to GitHub. Wait a few minutes and try again.' : `The credentials are valid but lack permission for this action on ${repoName}.`,
        reasons: rate
          ? []
          : stage === 'pull-request'
            ? ['The GitHub App needs "Pull requests: Read & write" permission', 'A fine-grained token needs "Pull requests: Write" for this repository']
            : ['The GitHub App installation does not grant the requested permission', 'The App needs "Contents: Read & write" to push', 'The organization restricts this App'],
        actions: rate ? ['retry'] : ['review-auth'],
        technical,
      });
    }
    if (err.status === 422) {
      const msg = err.message;
      let friendly = msg;
      if (/A pull request already exists/i.test(msg)) friendly = 'A pull request for this branch already exists.';
      else if (/No commits between/i.test(msg)) friendly = 'There are no commits between the target and source branch.';
      else if (/head.*invalid|field.*head/i.test(msg)) friendly = 'The source branch does not exist on GitHub. Push it first.';
      else if (/base.*invalid|field.*base/i.test(msg)) friendly = 'The target branch does not exist on GitHub.';
      else if (/permissions/i.test(msg)) friendly = 'The requested token permissions exceed what the GitHub App installation grants.';
      return new AppError({ code: 'github-validation', title: 'GitHub Rejected the Request', message: friendly, technical });
    }
    return new AppError({
      code: 'github-error',
      title: 'GitHub Request Failed',
      message: `GitHub returned an error (HTTP ${err.status}).`,
      actions: ['retry'],
      technical,
    });
  }
}
