import type * as crypto from 'node:crypto';
import type { AccountProfile, AccountRepo, AppInstallationInfo, ContributionDay, GhGpgKey, GhSshKey, KeyListAccess, KeyPermissionNeed, PublicProfilePatch } from '../../../shared/github';
import { AppError } from '../../git/errors';
import { GitHubClient } from '../client/GitHubClient';
import { createAppJwt } from '../GitHubService';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const LEVEL: Record<string, ContributionDay['level']> = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

// ---------------------------------------------------------------------------
// Profile + contributions
// ---------------------------------------------------------------------------

export async function getProfile(c: GitHubClient, year?: number): Promise<AccountProfile> {
  const now = new Date();
  const y = year && year <= now.getUTCFullYear() ? year : null;
  const from = y ? `${y}-01-01T00:00:00Z` : new Date(now.getTime() - 364 * 86400_000).toISOString();
  const to = y && y < now.getUTCFullYear() ? `${y}-12-31T23:59:59Z` : now.toISOString();
  const d = await c.graphql<{ viewer: Json }>(
    `query($from: DateTime!, $to: DateTime!) { viewer {
      login name avatarUrl url bio company location websiteUrl twitterUsername isHireable createdAt
      followers { totalCount } following { totalCount }
      repositories(ownerAffiliations: OWNER) { totalCount }
      starredRepositories { totalCount }
      organizations(first: 20) { nodes { login avatarUrl } }
      contributionsCollection(from: $from, to: $to) {
        contributionYears
        totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions totalIssueContributions
        totalRepositoriesWithContributedCommits
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } }
        commitContributionsByRepository(maxRepositories: 8) { repository { nameWithOwner } contributions { totalCount } }
      }
    } }`,
    { from, to },
    'load your profile',
  );
  const v = d.viewer;
  // GraphQL's viewer.email needs the user:email scope, which browser sign-ins don't have.
  // REST /user returns the public email with no extra scope.
  v.email = await c.get<Json>('/user', { action: 'load your profile' }).then((u) => u.email ?? null).catch(() => null);
  const cc = v.contributionsCollection;
  const weeks: ContributionDay[][] = (cc.contributionCalendar.weeks as Json[]).map((w) =>
    (w.contributionDays as Json[]).map((x) => ({ date: x.date, count: x.contributionCount, level: LEVEL[x.contributionLevel] ?? 0 })),
  );
  const days = weeks.flat();
  // Streaks, counted up to today (a zero today does not break the current streak yet).
  let longest = 0;
  let run = 0;
  for (const x of days) {
    run = x.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  const busiest = days.reduce<ContributionDay | null>((m, x) => (!m || x.count > m.count ? x : m), null);
  return {
    login: v.login,
    name: v.name ?? null,
    avatarUrl: v.avatarUrl,
    url: v.url,
    bio: v.bio || null,
    company: v.company || null,
    location: v.location || null,
    blog: v.websiteUrl || null,
    twitter: v.twitterUsername || null,
    email: v.email || null,
    hireable: !!v.isHireable,
    createdAt: v.createdAt,
    followers: v.followers.totalCount,
    following: v.following.totalCount,
    ownedRepos: v.repositories.totalCount,
    starred: v.starredRepositories.totalCount,
    organizations: (v.organizations?.nodes ?? []).filter(Boolean),
    contributions: {
      year: y ?? now.getUTCFullYear(),
      total: cc.contributionCalendar.totalContributions,
      commits: cc.totalCommitContributions,
      pullRequests: cc.totalPullRequestContributions,
      reviews: cc.totalPullRequestReviewContributions,
      issues: cc.totalIssueContributions,
      reposContributed: cc.totalRepositoriesWithContributedCommits,
      weeks,
      topRepos: (cc.commitContributionsByRepository as Json[]).map((r) => ({ name: r.repository.nameWithOwner, count: r.contributions.totalCount })),
      currentStreak: current,
      longestStreak: longest,
      busiestDay: busiest && busiest.count > 0 ? busiest : null,
    },
    years: [...(cc.contributionYears as number[])].sort((a, b) => b - a),
  };
}

export async function updateProfile(c: GitHubClient, patch: PublicProfilePatch): Promise<void> {
  await c.rest('PATCH', '/user', { body: patch, action: 'update your public profile' });
}

// ---------------------------------------------------------------------------
// Repositories with size, commits, tags, collaborators
// ---------------------------------------------------------------------------

export async function listRepos(c: GitHubClient, after: string | null): Promise<{ repos: AccountRepo[]; endCursor: string | null; hasNextPage: boolean; total: number }> {
  const d = await c.graphql<{ viewer: { repositories: Json } }>(
    `query($after: String) { viewer { repositories(first: 30, after: $after, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: { field: PUSHED_AT, direction: DESC }) {
      totalCount pageInfo { endCursor hasNextPage }
      nodes {
        nameWithOwner name owner { login } url description isPrivate isFork isArchived diskUsage stargazerCount forkCount pushedAt viewerPermission
        primaryLanguage { name color }
        defaultBranchRef { name target { ... on Commit { history { totalCount } } } }
        refs(refPrefix: "refs/tags/", first: 0) { totalCount }
        collaborators(first: 0) { totalCount }
      }
    } } }`,
    { after },
    'load your repositories',
  );
  const r = d.viewer.repositories;
  return {
    total: r.totalCount,
    endCursor: r.pageInfo.endCursor ?? null,
    hasNextPage: !!r.pageInfo.hasNextPage,
    repos: (r.nodes as Json[]).filter(Boolean).map((n) => ({
      fullName: n.nameWithOwner,
      owner: n.owner.login,
      name: n.name,
      url: n.url,
      description: n.description ?? null,
      isPrivate: n.isPrivate,
      isFork: n.isFork,
      isArchived: n.isArchived,
      sizeKb: n.diskUsage ?? 0,
      stars: n.stargazerCount,
      forks: n.forkCount,
      language: n.primaryLanguage?.name ?? null,
      languageColor: n.primaryLanguage?.color ?? null,
      pushedAt: n.pushedAt ?? null,
      permission: n.viewerPermission ?? null,
      defaultBranch: n.defaultBranchRef?.name ?? null,
      commits: n.defaultBranchRef?.target?.history?.totalCount ?? null,
      tags: n.refs?.totalCount ?? null,
      collaborators: n.collaborators?.totalCount ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// SSH & GPG keys on the account
// ---------------------------------------------------------------------------

/** Token permissions for each account-level key endpoint (fine-grained "Account permissions" name and classic scope). */
export const KEY_PERMISSIONS = {
  ssh: { label: 'SSH authentication keys', fineGrained: 'Git SSH keys', classic: 'admin:public_key' },
  signing: { label: 'SSH signing keys', fineGrained: 'SSH signing keys', classic: 'admin:ssh_signing_key' },
  gpg: { label: 'GPG keys', fineGrained: 'GPG keys', classic: 'admin:gpg_key' },
} satisfies Record<string, KeyPermissionNeed>;

/**
 * True when GitHub refused an account-level key endpoint because the TOKEN lacks the permission: fine-grained
 * tokens get 403 "Resource not accessible by personal access token", classic tokens without the scope get 404 or 403.
 */
export function isKeyAccessDenied(err: unknown): boolean {
  return err instanceof AppError && ['pat-permission', 'forbidden', 'not-found'].includes(err.friendly.code);
}

/** Precise error for callers that still throw (the old wording blamed "this repository"). */
export function keyAccessError(needs: KeyPermissionNeed[], tokenKind: 'fine-grained' | 'classic', cause?: unknown): AppError {
  const names = needs.map((n) => (tokenKind === 'fine-grained' ? `"${n.fineGrained}"` : n.classic)).join(', ');
  return new AppError({
    code: 'key-access-denied',
    title: 'Token Cannot Read Your Keys',
    message:
      tokenKind === 'fine-grained'
        ? `The signed-in fine-grained token has no access to your account's keys. Edit the token on GitHub → Account permissions → set ${names} to "Read and write".`
        : `The signed-in classic token is missing the ${names} scope. Edit the token on GitHub and tick it.`,
    reasons: needs.map((n) => `${n.label}: fine-grained "${n.fineGrained}" (Account permissions) or classic scope ${n.classic}`),
    actions: ['retry'],
    technical: cause instanceof AppError ? cause.friendly.technical : undefined,
  });
}

function keyAccess(missing: KeyPermissionNeed[], tokenKind: 'fine-grained' | 'classic', webBase: string): KeyListAccess {
  return { ok: missing.length === 0, tokenKind, missing, webBase };
}

const toSsh = (k: Json, kind: GhSshKey['kind']): GhSshKey => ({ id: k.id, title: k.title ?? '', key: k.key, createdAt: k.created_at ?? null, kind, ...(kind === 'authentication' ? { verified: k.verified, readOnly: k.read_only } : {}) });

/**
 * SSH authentication + signing keys. A token without permission for either list does NOT fail the call:
 * that list comes back empty and `access.missing` names the permission to add.
 */
export async function listSshKeys(
  c: GitHubClient,
  opts: { tokenKind?: 'fine-grained' | 'classic'; webBase?: string } = {},
): Promise<{ authentication: GhSshKey[]; signing: GhSshKey[]; signingError: string | null; access: KeyListAccess }> {
  const missing: KeyPermissionNeed[] = [];
  let authentication: GhSshKey[] = [];
  let signing: GhSshKey[] = [];
  let signingError: string | null = null;
  const [a, s] = await Promise.allSettled([
    c.paginate<Json>('/user/keys', { maxItems: 200, action: 'list your SSH keys' }),
    c.paginate<Json>('/user/ssh_signing_keys', { maxItems: 200, action: 'list your SSH signing keys' }),
  ]);
  if (a.status === 'fulfilled') authentication = a.value.items.map((k) => toSsh(k, 'authentication'));
  else if (isKeyAccessDenied(a.reason)) missing.push(KEY_PERMISSIONS.ssh);
  else throw a.reason;
  if (s.status === 'fulfilled') signing = s.value.items.map((k) => toSsh(k, 'signing'));
  else if (isKeyAccessDenied(s.reason)) missing.push(KEY_PERMISSIONS.signing);
  else signingError = s.reason instanceof Error ? s.reason.message : String(s.reason);
  return { authentication, signing, signingError, access: keyAccess(missing, opts.tokenKind ?? 'fine-grained', opts.webBase ?? 'https://github.com') };
}

/** Runs a key write; a token-permission refusal becomes a precise account-level error. */
async function keyWrite(need: KeyPermissionNeed, fn: () => Promise<unknown>, notFoundIsMissing = true): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (isKeyAccessDenied(err) && (notFoundIsMissing || (err as AppError).friendly.code !== 'not-found')) {
      throw keyAccessError([need], (err as AppError).friendly.code === 'pat-permission' ? 'fine-grained' : 'classic', err);
    }
    throw err;
  }
}

export async function addSshKey(c: GitHubClient, kind: GhSshKey['kind'], title: string, key: string): Promise<void> {
  await keyWrite(kind === 'signing' ? KEY_PERMISSIONS.signing : KEY_PERMISSIONS.ssh, () =>
    c.rest('POST', kind === 'signing' ? '/user/ssh_signing_keys' : '/user/keys', { body: { title, key }, action: 'add the SSH key' }),
  );
}

export async function deleteSshKey(c: GitHubClient, kind: GhSshKey['kind'], id: number): Promise<void> {
  // A 404 on delete usually means the key is already gone — keep that message.
  await keyWrite(kind === 'signing' ? KEY_PERMISSIONS.signing : KEY_PERMISSIONS.ssh, () => c.rest('DELETE', kind === 'signing' ? `/user/ssh_signing_keys/${id}` : `/user/keys/${id}`, { action: 'delete the SSH key' }), false);
}

export async function listGpgKeys(c: GitHubClient): Promise<GhGpgKey[]> {
  const res = await c.paginate<Json>('/user/gpg_keys', { maxItems: 200, action: 'list your GPG keys' });
  return res.items.map((k) => ({
    id: k.id,
    keyId: k.key_id,
    emails: (k.emails ?? []).map((e: Json) => ({ email: e.email, verified: !!e.verified })),
    createdAt: k.created_at ?? null,
    expiresAt: k.expires_at ?? null,
    canSign: !!k.can_sign,
    revoked: !!k.revoked,
    subkeys: (k.subkeys ?? []).length,
  }));
}

/** GPG keys, or an empty list + `access.missing` when the token cannot read them. */
export async function listGpgKeysWithAccess(c: GitHubClient, opts: { tokenKind: 'fine-grained' | 'classic'; webBase: string }): Promise<{ keys: GhGpgKey[]; access: KeyListAccess }> {
  try {
    return { keys: await listGpgKeys(c), access: keyAccess([], opts.tokenKind, opts.webBase) };
  } catch (err) {
    if (!isKeyAccessDenied(err)) throw err;
    return { keys: [], access: keyAccess([KEY_PERMISSIONS.gpg], opts.tokenKind, opts.webBase) };
  }
}

export async function addGpgKey(c: GitHubClient, name: string, armored: string): Promise<void> {
  await keyWrite(KEY_PERMISSIONS.gpg, () => c.rest('POST', '/user/gpg_keys', { body: { name, armored_public_key: armored }, action: 'add the GPG key' }));
}

export async function deleteGpgKey(c: GitHubClient, id: number): Promise<void> {
  await keyWrite(KEY_PERMISSIONS.gpg, () => c.rest('DELETE', `/user/gpg_keys/${id}`, { action: 'delete the GPG key' }), false);
}

export async function listEmails(c: GitHubClient): Promise<{ email: string; verified: boolean; primary: boolean }[]> {
  try {
    const res = await c.get<Json[]>('/user/emails', { query: { per_page: 100 }, action: 'list your email addresses' });
    return res.map((e) => ({ email: e.email, verified: !!e.verified, primary: !!e.primary }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GitHub Apps (App JWT)
// ---------------------------------------------------------------------------

export async function appDetails(apiBase: string, appId: string, key: crypto.KeyObject): Promise<{ name: string; slug: string; owner: string; htmlUrl: string; permissions: Record<string, string>; events: string[] }> {
  const c = new GitHubClient(apiBase, createAppJwt(appId, key));
  const a = await c.get<Json>('/app', { action: 'verify the GitHub App' });
  if (String(a.id) !== appId) throw new AppError({ code: 'app-mismatch', title: 'Wrong Key', message: 'This private key belongs to a different GitHub App.' });
  return { name: a.name, slug: a.slug, owner: a.owner?.login ?? '', htmlUrl: a.html_url, permissions: a.permissions ?? {}, events: a.events ?? [] };
}

export async function appInstallations(apiBase: string, appId: string, key: crypto.KeyObject): Promise<AppInstallationInfo[]> {
  const c = new GitHubClient(apiBase, createAppJwt(appId, key));
  const list = await c.paginate<Json>('/app/installations', { maxItems: 200, action: 'list installations' });
  return list.items.map((i) => ({
    id: i.id,
    account: i.account?.login ?? '',
    accountType: i.target_type ?? i.account?.type ?? '',
    repositorySelection: i.repository_selection === 'all' ? 'all' : 'selected',
    repositories: null,
    htmlUrl: i.html_url,
    suspended: !!i.suspended_at,
    createdAt: i.created_at ?? null,
  }));
}

/** Repositories an installation can reach — read with a short-lived installation token (revoked straight after). */
export async function installationRepos(apiBase: string, appId: string, key: crypto.KeyObject, installationId: number): Promise<string[]> {
  const jwtClient = new GitHubClient(apiBase, createAppJwt(appId, key));
  const tok = await jwtClient.rest<Json>('POST', `/app/installations/${installationId}/access_tokens`, { body: { permissions: { metadata: 'read' } }, action: 'read the installation' });
  let token = String(tok.data.token);
  try {
    const c = new GitHubClient(apiBase, token);
    const res = await c.paginate<Json>('/installation/repositories', { itemsKey: 'repositories', maxItems: 500, action: 'list installation repositories' });
    return res.items.map((r) => r.full_name);
  } finally {
    await new GitHubClient(apiBase, token).rest('DELETE', '/installation/token', { action: 'revoke the token' }).catch(() => undefined);
    token = '';
  }
}

/** The installation of `appId` that covers owner/repo, or null when the App is not installed there. */
export async function repoInstallation(apiBase: string, appId: string, key: crypto.KeyObject, owner: string, repo: string): Promise<{ id: number; account: string } | null> {
  const c = new GitHubClient(apiBase, createAppJwt(appId, key));
  const res = await c.rest<Json>('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, { allowStatus: [404], action: 'check the installation' });
  return res.status === 404 ? null : { id: res.data.id, account: res.data.account?.login ?? '' };
}
