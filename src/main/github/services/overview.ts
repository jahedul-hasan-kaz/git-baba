import type { RepoOverview } from '../../../shared/github';
import type { GitHubClient } from '../client/GitHubClient';
import type { RepoCoords } from './pullRequests';

interface RestRepo {
  full_name: string;
  description: string | null;
  homepage: string | null;
  topics?: string[];
  license: { spdx_id: string | null; name: string } | null;
  html_url: string;
  private: boolean;
  fork: boolean;
  parent?: { full_name: string };
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  subscribers_count?: number;
  watchers_count: number;
  open_issues_count: number;
}

interface RestContributor {
  login?: string;
  avatar_url?: string;
  contributions: number;
  html_url?: string;
  type?: string;
}

interface RestDeployment {
  id: number;
  environment: string;
  ref: string;
  sha: string;
  created_at: string;
  creator: { login: string } | null;
}

interface RestDeploymentStatus {
  state: string;
  environment_url?: string;
  target_url?: string;
}

interface RestRelease {
  name: string | null;
  tag_name: string;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

/** Page number of rel="last" in a Link header (the total when per_page=1). */
function lastPage(link: string | null): number | null {
  const m = link ? /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link) : null;
  return m ? Number(m[1]) : null;
}

/** Everything shown in the Code tab's "About" sidebar. Optional parts degrade to empty rather than failing. */
export async function getRepoOverview(client: GitHubClient, r: RepoCoords): Promise<RepoOverview> {
  const base = `/repos/${r.owner}/${r.name}`;
  const repo = await client.get<RestRepo>(base, { action: 'load the repository' });
  const soft = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

  const [contributors, contributorsTotal, languages, deployments, releases, viewerStarred] = await Promise.all([
    soft(
      client.rest<RestContributor[] | undefined>('GET', `${base}/contributors`, { query: { per_page: 24 }, allowStatus: [202, 204] }).then((res) => (Array.isArray(res.data) ? res.data : [])),
      [] as RestContributor[],
    ),
    soft(
      client.rest<unknown>('GET', `${base}/contributors`, { query: { per_page: 1, anon: 'true' }, allowStatus: [202, 204] }).then((res) => lastPage(res.headers.get('link')) ?? (Array.isArray(res.data) ? res.data.length : null)),
      null as number | null,
    ),
    soft(client.get<Record<string, number>>(`${base}/languages`), {} as Record<string, number>),
    soft(
      client.get<RestDeployment[]>(`${base}/deployments`, { query: { per_page: 8 } }).then((list) =>
        Promise.all(
          list.map(async (d) => {
            const [st] = await soft(client.get<RestDeploymentStatus[]>(`${base}/deployments/${d.id}/statuses`, { query: { per_page: 1 } }), []);
            return {
              id: d.id,
              environment: d.environment,
              ref: d.ref,
              sha: d.sha,
              createdAt: d.created_at,
              creator: d.creator?.login ?? null,
              state: st?.state ?? 'pending',
              url: st?.environment_url || st?.target_url || null,
            };
          }),
        ),
      ),
      [] as RepoOverview['deployments'],
    ),
    soft(client.get<RestRelease[]>(`${base}/releases`, { query: { per_page: 5 } }), [] as RestRelease[]),
    soft(
      client.rest<unknown>('GET', `/user/starred/${r.owner}/${r.name}`, { allowStatus: [404] }).then((res) => res.status === 204),
      null as boolean | null,
    ),
  ]);

  return {
    fullName: repo.full_name,
    description: repo.description,
    homepage: repo.homepage || null,
    topics: repo.topics ?? [],
    license: repo.license ? (repo.license.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : repo.license.name) : null,
    htmlUrl: repo.html_url,
    isPrivate: repo.private,
    isFork: repo.fork,
    parent: repo.parent?.full_name ?? null,
    defaultBranch: repo.default_branch,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.subscribers_count ?? repo.watchers_count,
    openIssues: repo.open_issues_count,
    viewerStarred,
    contributors: contributors
      .filter((c) => c.login)
      .map((c) => ({ login: c.login!, avatarUrl: c.avatar_url ?? '', contributions: c.contributions, url: c.html_url ?? '' })),
    contributorsTotal,
    languages,
    deployments,
    releases: releases
      .filter((x) => !x.draft)
      .map((x) => ({ name: x.name || x.tag_name, tag: x.tag_name, publishedAt: x.published_at, url: x.html_url, prerelease: x.prerelease })),
  };
}
