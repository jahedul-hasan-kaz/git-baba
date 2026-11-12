import { AppError } from '../../git/errors';
import { redactSecrets } from '../../util/redact';
import type { FetchLike } from '../GitHubService';

const API_VERSION = '2022-11-28';
const USER_AGENT = 'GitBaba-Desktop';
const TIMEOUT_MS = 30_000;

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  accept?: string;
  /** Operation name used in error messages, e.g. "load pull requests". */
  action?: string;
  /** Statuses that are returned instead of thrown (e.g. 404 for "not configured"). */
  allowStatus?: number[];
}

export interface RestResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

/** Error carrying everything needed to explain a GitHub failure — never the token. */
export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly apiMessage: string,
    readonly details: string,
    readonly acceptedPermissions: string | null,
    readonly rateLimitReset: string | null,
    readonly graphqlType: string | null = null,
  ) {
    super(apiMessage);
    this.name = 'GitHubRequestError';
  }
}

/**
 * Central GitHub API access for the account-session features (PRs, security,
 * actions). One instance = one token (one account). Handles REST,
 * GraphQL, pagination, rate limits, retries and error translation.
 */
export class GitHubClient {
  rateLimit: RateLimitInfo = { limit: null, remaining: null, resetAt: null };

  constructor(
    private readonly apiBase: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.downloadFetch = fetchImpl;
  }

  /**
   * Fetches pre-signed download URLs (log redirects), which live on other hosts and need no credentials.
   * Defaults to the client's own fetch; the GitHub CLI transport replaces it, because `gh api` only talks to the API host.
   */
  downloadFetch: FetchLike;

  get graphqlUrl(): string {
    // github.com: https://api.github.com/graphql — GHES: https://host/api/graphql
    return this.apiBase.endsWith('/api/v3') ? `${this.apiBase.slice(0, -3)}/graphql` : `${this.apiBase}/graphql`;
  }

  private headers(accept?: string, hasBody?: boolean): Record<string, string> {
    return {
      Accept: accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      Authorization: `Bearer ${this.token}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private trackRateLimit(h: Headers): void {
    const limit = h.get('x-ratelimit-limit');
    const remaining = h.get('x-ratelimit-remaining');
    const reset = h.get('x-ratelimit-reset');
    if (remaining !== null) {
      this.rateLimit = {
        limit: limit ? Number(limit) : null,
        remaining: Number(remaining),
        resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
      };
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path.startsWith('http') ? path : `${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    // Only ever talk to the configured API host.
    if (url.origin !== new URL(this.apiBase).origin) throw new AppError({ code: 'invalid-url', title: 'Unexpected API URL', message: 'Refusing to send credentials to another host.' });
    return url.toString();
  }

  /** fetch with one retry for transient failures (network, 502/503/504, short secondary rate limits). */
  private async send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        if (attempt === 0) {
          await this.sleep(800);
          continue;
        }
        throw mapGitHubError(new GitHubRequestError(0, 'network', redactSecrets(`${init.method} ${new URL(url).pathname}: ${err instanceof Error ? err.message : String(err)}`, [this.token]), null, null));
      }
      this.trackRateLimit(res.headers);
      if (attempt === 0 && [502, 503, 504].includes(res.status)) {
        await this.sleep(1000);
        continue;
      }
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      if (attempt === 0 && (res.status === 403 || res.status === 429) && retryAfter > 0 && retryAfter <= 10) {
        await this.sleep(retryAfter * 1000);
        continue;
      }
      return res;
    }
  }

  private async toError(res: Response, method: string, url: string): Promise<GitHubRequestError> {
    const text = await res.text().catch(() => '');
    let message = res.statusText || 'Request failed';
    try {
      const parsed = JSON.parse(text) as { message?: string; errors?: ({ message?: string; code?: string } | string)[] };
      message = parsed.message ?? message;
      const extra = parsed.errors?.map((e) => (typeof e === 'string' ? e : (e.message ?? e.code))).filter(Boolean).join('; ');
      if (extra) message = `${message}: ${extra}`;
    } catch {
      // not JSON
    }
    const path = new URL(url).pathname;
    const reset = res.headers.get('x-ratelimit-reset');
    const exhausted = res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429;
    return new GitHubRequestError(
      res.status,
      redactSecrets(message, [this.token]),
      redactSecrets(`${method} ${path} → HTTP ${res.status}\n${message}`, [this.token]),
      res.headers.get('x-accepted-github-permissions'),
      exhausted && reset ? new Date(Number(reset) * 1000).toISOString() : exhausted ? 'soon' : null,
    );
  }

  async rest<T>(method: string, path: string, opts: RequestOptions = {}): Promise<RestResponse<T>> {
    const url = this.buildUrl(path, opts.query);
    const res = await this.send(url, {
      method,
      headers: this.headers(opts.accept, opts.body !== undefined),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: 'error',
    });
    if (!res.ok && !(opts.allowStatus ?? []).includes(res.status)) throw mapGitHubError(await this.toError(res, method, url), opts.action);
    if (res.status === 204 || res.status === 205) return { status: res.status, data: undefined as T, headers: res.headers };
    const text = await res.text();
    let data: T;
    try {
      data = (text ? JSON.parse(text) : undefined) as T;
    } catch {
      data = text as unknown as T;
    }
    return { status: res.status, data, headers: res.headers };
  }

  async get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.rest<T>('GET', path, opts)).data;
  }

  /** Follows Link rel="next" until `maxItems` are collected (never loads everything blindly). */
  async paginate<T>(path: string, opts: RequestOptions & { maxItems?: number; itemsKey?: string } = {}): Promise<{ items: T[]; hasMore: boolean }> {
    const max = opts.maxItems ?? 300;
    const items: T[] = [];
    let next: string | null = this.buildUrl(path, { per_page: 100, ...opts.query });
    while (next && items.length < max) {
      const res: RestResponse<unknown> = await this.rest<unknown>('GET', next, { accept: opts.accept, action: opts.action });
      const page = (opts.itemsKey ? (res.data as Record<string, unknown>)[opts.itemsKey] : res.data) as T[];
      items.push(...(page ?? []));
      next = parseNextLink(res.headers.get('link'));
    }
    return { items: items.slice(0, max), hasMore: !!next || items.length > max };
  }

  /** GraphQL query/mutation. GraphQL "errors" are translated like REST errors. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}, action?: string): Promise<T> {
    const res = await this.send(this.graphqlUrl, {
      method: 'POST',
      headers: this.headers('application/json', true),
      body: JSON.stringify({ query, variables }),
      redirect: 'error',
    });
    if (!res.ok) throw mapGitHubError(await this.toError(res, 'POST', this.graphqlUrl), action);
    const json = (await res.json()) as { data?: T; errors?: { type?: string; message: string; path?: string[] }[] };
    if (json.errors?.length) {
      const first = json.errors[0];
      const status = first.type === 'NOT_FOUND' ? 404 : first.type === 'FORBIDDEN' || first.type === 'INSUFFICIENT_SCOPES' ? 403 : first.type === 'RATE_LIMITED' ? 429 : 422;
      // Partial data with only "not found"/"forbidden" in optional branches is still useful.
      if (json.data && json.errors.every((e) => e.type === 'NOT_FOUND' || e.type === 'FORBIDDEN')) return json.data;
      throw mapGitHubError(
        new GitHubRequestError(status, redactSecrets(first.message, [this.token]), redactSecrets(`GraphQL ${action ?? ''}\n${json.errors.map((e) => `${e.type ?? 'ERROR'}: ${e.message}`).join('\n')}`, [this.token]), null, null, first.type ?? null),
        action,
      );
    }
    return json.data as T;
  }

  /**
   * Downloads a text resource that GitHub serves through a redirect to short-lived storage
   * (e.g. job logs). The credential is sent to GitHub only, never to the redirect target.
   */
  async downloadText(path: string, maxBytes = 512 * 1024, action?: string): Promise<{ text: string; truncated: boolean }> {
    const text = (await this.downloadBytes(path, action)).toString('utf8');
    // Keep the end of the log: that is where failures are.
    return text.length > maxBytes ? { text: text.slice(-maxBytes), truncated: true } : { text, truncated: false };
  }

  /** Same as downloadText, for binary resources (e.g. the run-log ZIP archive). */
  async downloadBytes(path: string, action?: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    const url = this.buildUrl(path);
    const first = await this.send(url, { method: 'GET', headers: this.headers(), redirect: 'manual' });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location');
      if (!location || !location.startsWith('https://')) throw new AppError({ code: 'logs-unavailable', title: 'Logs Unavailable', message: 'GitHub did not provide a download location for these logs.' });
      // A short-lived pre-signed URL on another host: fetched without credentials.
      try {
        res = await this.downloadFetch(location, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        throw new AppError({ code: 'logs-unavailable', title: 'Logs Download Failed', message: `GitHub's log storage could not be reached (${err instanceof Error ? err.message : String(err)}). Check proxy or firewall rules for *.blob.core.windows.net / *.actions.githubusercontent.com.` });
      }
      if (!res.ok) throw new AppError({ code: 'logs-unavailable', title: 'Logs Download Failed', message: `GitHub's log storage answered HTTP ${res.status}. The download link may have expired — try again.` });
    }
    if (!res.ok) throw mapGitHubError(await this.toError(res, 'GET', url), action);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new AppError({ code: 'too-large', title: 'Logs Too Large', message: 'These logs are too large to show here. Open them on GitHub.' });
    return buf;
  }
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

function permissionHint(accepted: string | null): string[] {
  if (!accepted) return [];
  return [`The token needs these permissions: ${accepted.replace(/=/g, ': ').replace(/,\s*/g, ', ')}`];
}

/** Translates GitHub failures into actionable, credential-free messages. */
export function mapGitHubError(err: GitHubRequestError, action = 'complete this action'): AppError {
  const technical = err.details;
  const m = err.apiMessage;
  switch (err.status) {
    case 0:
      return new AppError({ code: 'network', title: 'Cannot Reach GitHub', message: `GitHub could not be reached to ${action}. Check your connection or proxy.`, actions: ['retry'], technical });
    case 401:
      return new AppError({
        code: 'session-expired',
        title: 'Authentication Expired',
        message: 'GitHub rejected the session token. It may have expired or been revoked. Sign in again.',
        reasons: ['The token expired or was revoked', 'The token was regenerated on GitHub'],
        actions: ['review-auth'],
        technical,
      });
    case 403: {
      if (err.rateLimitReset) return rateLimited(err, technical);
      if (/saml|sso/i.test(m)) {
        return new AppError({ code: 'sso-required', title: 'Single Sign-On Required', message: 'This organisation requires SAML SSO. Authorise the token for the organisation on GitHub (Settings → Tokens → Configure SSO).', technical });
      }
      // Exact wording GitHub uses when a fine-grained token lacks access to this repository or permission.
      if (/resource not accessible by personal access token/i.test(m)) {
        return new AppError({
          code: 'pat-permission',
          title: 'Token Not Allowed Here',
          message: `The signed-in account uses a fine-grained personal access token that cannot ${action} in this repository. Your GitHub role may allow it (the gh CLI uses a different token), but this token does not.`,
          reasons: [
            ...permissionHint(err.acceptedPermissions),
            'The token\'s "Resource owner" is your personal account instead of the organisation that owns this repository',
            'This repository is not in the token\'s "Selected repositories"',
            'The organisation has not approved the token yet, or blocks fine-grained tokens',
          ],
          actions: [],
          technical,
        });
      }
      if (/advanced security|code scanning is not enabled|not enabled for this repository|disabled/i.test(m)) {
        return new AppError({ code: 'feature-disabled', title: 'Feature Not Enabled', message: m, technical });
      }
      return new AppError({
        code: 'forbidden',
        title: 'Permission Required',
        message: `You don't have permission to ${action}.`,
        reasons: [...permissionHint(err.acceptedPermissions), 'Your role in the repository may be too low (read/triage/write/admin)', 'Classic tokens may need extra scopes (repo, read:org, project, security_events, workflow)'],
        actions: [],
        technical,
      });
    }
    case 404:
      return new AppError({
        code: 'not-found',
        title: 'Not Found',
        message: `GitHub could not find what was needed to ${action}. It may have been deleted, renamed, or the account cannot see it.`,
        reasons: ['The repository was renamed, transferred or deleted', 'The branch or pull request no longer exists', 'The token has no access (private resources appear as "not found")', ...permissionHint(err.acceptedPermissions)],
        actions: ['retry'],
        technical,
      });
    case 405:
    case 409:
      return new AppError({ code: 'conflict', title: 'GitHub Refused the Change', message: m || `GitHub could not ${action} because of a conflict.`, actions: ['retry'], technical });
    case 410:
      return new AppError({ code: 'gone', title: 'Not Available', message: m || 'This feature is disabled for the repository.', technical });
    case 422:
      return new AppError({ code: 'validation', title: 'GitHub Rejected the Request', message: m || `GitHub could not ${action}.`, technical });
    case 429:
      return rateLimited(err, technical);
    default:
      return new AppError({ code: 'github-error', title: 'GitHub Request Failed', message: `GitHub returned an error (HTTP ${err.status}) while trying to ${action}.`, actions: ['retry'], technical });
  }
}

function rateLimited(err: GitHubRequestError, technical: string): AppError {
  const when = err.rateLimitReset && err.rateLimitReset !== 'soon' ? new Date(err.rateLimitReset).toLocaleTimeString() : 'in a few minutes';
  return new AppError({ code: 'rate-limited', title: 'GitHub Rate Limit Reached', message: `Too many requests were sent to GitHub. The limit resets at ${when}.`, actions: ['retry'], technical });
}
