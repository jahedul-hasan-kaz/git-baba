import type { DeployKey, GhSecret, RefCommitInfo, RemoteBranch, RemoteCommit, RemoteTag, SecretScope, SecretsOverview } from '../../../shared/github';
import { AppError } from '../../git/errors';
import { encryptSecretForGitHub } from '../../security/sealedBox';
import type { GitHubClient } from '../client/GitHubClient';
import type { RepoCoords } from './pullRequests';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const enc = encodeURIComponent;
const base = (r: RepoCoords) => `/repos/${enc(r.owner)}/${enc(r.name)}`;

/** The environment GitHub Copilot coding agent reads its secrets and variables from. */
export const COPILOT_ENV = 'copilot';

const mapSecret = (s: Json): GhSecret => ({ name: s.name, createdAt: s.created_at ?? null, updatedAt: s.updated_at ?? null, ...(s.visibility ? { visibility: s.visibility } : {}) });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function listSecrets(c: GitHubClient, path: string): Promise<GhSecret[]> {
  const res = await c.paginate<Json>(path, { itemsKey: 'secrets', maxItems: 500, action: 'list secrets' });
  return res.items.map(mapSecret);
}

/** Every secret store that applies to this repository, each loaded independently (one failing does not hide the others). */
export async function secretsOverview(c: GitHubClient, r: RepoCoords, isOrg: boolean): Promise<SecretsOverview> {
  const out: SecretsOverview = { repo: null, repoError: null, environments: [], org: null, copilot: { exists: false, secrets: null, error: null } };
  const envsP = c.get<{ environments: Json[] }>(`${base(r)}/environments`, { query: { per_page: 100 }, action: 'list environments' }).catch(() => ({ environments: [] as Json[] }));
  try {
    out.repo = await listSecrets(c, `${base(r)}/actions/secrets`);
  } catch (err) {
    out.repoError = errText(err);
  }
  const envs = (await envsP).environments ?? [];
  out.environments = await Promise.all(
    envs
      .filter((e) => e.name !== COPILOT_ENV)
      .map(async (e) => {
        const prot = (e.protection_rules ?? []).length > 0;
        try {
          return { name: e.name, protected: prot, secrets: await listSecrets(c, `${base(r)}/environments/${enc(e.name)}/secrets`), error: null };
        } catch (err) {
          return { name: e.name, protected: prot, secrets: null, error: errText(err) };
        }
      }),
  );
  if (envs.some((e) => e.name === COPILOT_ENV)) {
    out.copilot.exists = true;
    try {
      out.copilot.secrets = await listSecrets(c, `${base(r)}/environments/${COPILOT_ENV}/secrets`);
    } catch (err) {
      out.copilot.error = errText(err);
    }
  }
  if (isOrg) {
    // Secrets shared with this repository by the organisation (readable with repo admin).
    try {
      const shared = await listSecrets(c, `${base(r)}/actions/organization-secrets`);
      // Managing them needs organisation admin: probe the org list.
      const manageable = await c
        .rest<Json>('GET', `/orgs/${enc(r.owner)}/actions/secrets`, { query: { per_page: 1 }, allowStatus: [403, 404], action: 'check organisation access' })
        .then((x) => x.status === 200)
        .catch(() => false);
      out.org = { name: r.owner, secrets: shared, manageable, error: null };
    } catch (err) {
      out.org = { name: r.owner, secrets: null, manageable: false, error: errText(err) };
    }
  }
  return out;
}

function scopePath(r: RepoCoords, scope: SecretScope, env?: string): string {
  switch (scope) {
    case 'repo':
      return `${base(r)}/actions/secrets`;
    case 'env':
      if (!env) throw new AppError({ code: 'invalid-input', title: 'Environment Required', message: 'Choose an environment.' });
      return `${base(r)}/environments/${enc(env)}/secrets`;
    case 'copilot':
      return `${base(r)}/environments/${COPILOT_ENV}/secrets`;
    case 'org':
      return `/orgs/${enc(r.owner)}/actions/secrets`;
  }
}

/**
 * Creates or updates a secret. The value is encrypted on this computer with the target's public key
 * (libsodium sealed box) — GitHub never receives it in clear text, and the value is not kept anywhere.
 */
export async function putSecret(
  c: GitHubClient,
  r: RepoCoords,
  p: { scope: SecretScope; env?: string; name: string; value: string; orgVisibility?: 'all' | 'private' | 'selected'; repoId?: number },
): Promise<void> {
  if (p.scope === 'copilot') {
    // Make sure the Copilot environment exists (creating it is idempotent).
    await c.rest('PUT', `${base(r)}/environments/${COPILOT_ENV}`, { body: {}, action: 'prepare the Copilot environment' });
  }
  const path = scopePath(r, p.scope, p.env);
  const key = await c.get<{ key_id: string; key: string }>(`${path}/public-key`, { action: 'read the encryption key' });
  const encrypted = encryptSecretForGitHub(p.value, key.key);
  const body: Json = { encrypted_value: encrypted, key_id: key.key_id };
  if (p.scope === 'org') {
    body.visibility = p.orgVisibility ?? 'selected';
    if (body.visibility === 'selected' && p.repoId) body.selected_repository_ids = [p.repoId];
  }
  await c.rest('PUT', `${path}/${enc(p.name)}`, { body, action: `save secret ${p.name}` });
}

export async function deleteSecret(c: GitHubClient, r: RepoCoords, p: { scope: SecretScope; env?: string; name: string }): Promise<void> {
  await c.rest('DELETE', `${scopePath(r, p.scope, p.env)}/${enc(p.name)}`, { action: `delete secret ${p.name}` });
}

export async function createEnvironment(c: GitHubClient, r: RepoCoords, name: string): Promise<void> {
  await c.rest('PUT', `${base(r)}/environments/${enc(name)}`, { body: {}, action: 'create the environment' });
}

/**
 * Which workflows reference which secrets (`secrets.NAME`) on the default branch — to flag secrets that are
 * referenced but missing, and secrets nothing uses. Read-only; workflow files are only scanned as text.
 */
export async function secretUsage(c: GitHubClient, r: RepoCoords): Promise<Record<string, string[]>> {
  const repo = await c.get<Json>(base(r), { action: 'read the repository' });
  const wfs = await c.paginate<Json>(`${base(r)}/actions/workflows`, { itemsKey: 'workflows', maxItems: 60, action: 'list workflows' });
  const usage: Record<string, string[]> = {};
  await Promise.all(
    wfs.items
      .filter((w) => /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(w.path))
      .map(async (w) => {
        const res = await c.rest<Json>('GET', `${base(r)}/contents/${w.path.split('/').map(enc).join('/')}`, { query: { ref: repo.default_branch }, allowStatus: [404], action: 'read a workflow' }).catch(() => null);
        if (!res || res.status !== 200 || typeof res.data.content !== 'string') return;
        const text = Buffer.from(res.data.content, 'base64').toString('utf8');
        for (const m of text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
          const name = m[1].toUpperCase();
          if (name === 'GITHUB_TOKEN') continue;
          usage[name] = [...new Set([...(usage[name] ?? []), w.name as string])];
        }
      }),
  );
  return usage;
}

// ---------------------------------------------------------------------------
// Deploy keys
// ---------------------------------------------------------------------------

export async function listDeployKeys(c: GitHubClient, r: RepoCoords): Promise<DeployKey[]> {
  const res = await c.paginate<Json>(`${base(r)}/keys`, { maxItems: 200, action: 'list deploy keys' });
  return res.items.map((k) => ({
    id: k.id,
    title: k.title ?? '',
    key: k.key,
    readOnly: !!k.read_only,
    verified: !!k.verified,
    createdAt: k.created_at ?? null,
    lastUsed: k.last_used ?? null,
    addedBy: k.added_by ?? null,
  }));
}

export async function addDeployKey(c: GitHubClient, r: RepoCoords, p: { title: string; key: string; readOnly: boolean }): Promise<void> {
  await c.rest('POST', `${base(r)}/keys`, { body: { title: p.title, key: p.key, read_only: p.readOnly }, action: 'add the deploy key' });
}

export async function deleteDeployKey(c: GitHubClient, r: RepoCoords, id: number): Promise<void> {
  await c.rest('DELETE', `${base(r)}/keys/${id}`, { action: 'delete the deploy key' });
}

// ---------------------------------------------------------------------------
// Branches, tags, commits on GitHub
// ---------------------------------------------------------------------------

/** Commit date, author and headline of the newest 100 refs under a prefix (best effort: empty on any error). */
async function refCommits(c: GitHubClient, r: RepoCoords, prefix: 'refs/heads/' | 'refs/tags/'): Promise<Map<string, RefCommitInfo>> {
  const commit = 'oid committedDate messageHeadline author { name user { login } }';
  const q = `query($o: String!, $n: String!, $p: String!) { repository(owner: $o, name: $n) { refs(refPrefix: $p, first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
    nodes { name target { __typename ... on Commit { ${commit} } ... on Tag { target { ... on Commit { ${commit} } } } } } } } }`;
  const out = new Map<string, RefCommitInfo>();
  try {
    const data = await c.graphql<Json>(q, { o: r.owner, n: r.name, p: prefix }, 'read branch dates');
    for (const n of data?.repository?.refs?.nodes ?? []) {
      const t = n.target?.__typename === 'Tag' ? n.target.target : n.target;
      if (!t) continue;
      out.set(n.name, { date: t.committedDate ?? null, author: t.author?.user?.login ?? t.author?.name ?? null, message: t.messageHeadline ?? null });
    }
  } catch {
    /* dates are optional */
  }
  return out;
}

export async function remoteBranches(c: GitHubClient, r: RepoCoords): Promise<RemoteBranch[]> {
  const [res, info] = await Promise.all([c.paginate<Json>(`${base(r)}/branches`, { maxItems: 500, action: 'list branches' }), refCommits(c, r, 'refs/heads/')]);
  return res.items.map((b) => ({ name: b.name, sha: b.commit?.sha ?? '', protected: !!b.protected, ...info.get(b.name) }));
}

export async function remoteTags(c: GitHubClient, r: RepoCoords): Promise<RemoteTag[]> {
  const [res, info] = await Promise.all([c.paginate<Json>(`${base(r)}/tags`, { maxItems: 500, action: 'list tags' }), refCommits(c, r, 'refs/tags/')]);
  return res.items.map((t) => ({ name: t.name, sha: t.commit?.sha ?? '', ...info.get(t.name) }));
}

export async function remoteCommits(c: GitHubClient, r: RepoCoords, ref: string, page: number): Promise<{ commits: RemoteCommit[]; hasMore: boolean }> {
  const res = await c.get<Json[]>(`${base(r)}/commits`, { query: { sha: ref, per_page: 40, page }, action: 'list commits' });
  return {
    hasMore: res.length === 40,
    commits: res.map((x) => ({
      sha: x.sha,
      message: String(x.commit?.message ?? '').split('\n')[0],
      author: x.author?.login ?? x.commit?.author?.name ?? null,
      avatarUrl: x.author?.avatar_url ?? null,
      date: x.commit?.author?.date ?? null,
      url: x.html_url,
      verified: !!x.commit?.verification?.verified,
    })),
  };
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

export async function repoId(c: GitHubClient, r: RepoCoords): Promise<number> {
  return (await c.get<Json>(base(r), { action: 'read the repository' })).id;
}

export async function deleteRepository(c: GitHubClient, r: RepoCoords): Promise<void> {
  await c.rest('DELETE', base(r), { action: 'delete the repository' });
}
