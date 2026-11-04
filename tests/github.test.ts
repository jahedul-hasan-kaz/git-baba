import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeAuthOptions, resolveAuth } from '../src/main/github/authResolver';
import { createAppJwt, GitHubService, parsePrivateKey, privateKeyFingerprint, validateApiBaseUrl } from '../src/main/github/GitHubService';
import type { SecretStore } from '../src/main/repositories/SecretStore';
import { EphemeralVault } from '../src/main/security/EphemeralVault';
import type { RepoRecord } from '../src/shared/types';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function fakeFetch(routes: Record<string, (init: RequestInit) => { status: number; body?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const { status, body } = route(init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { impl, calls };
}

describe('GitHub App JWT', () => {
  it('creates a valid RS256 JWT with a back-dated iat and ≤10 minute expiry', () => {
    const key = parsePrivateKey(PEM);
    const now = 1_700_000_000;
    const jwt = createAppJwt('12345', key, now);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload).toEqual({ iss: '12345', iat: now - 60, exp: now + 540 });
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('accepts keys pasted with escaped newlines and rejects non-keys', () => {
    expect(() => parsePrivateKey(PEM.replace(/\n/g, '\\n'))).not.toThrow();
    expect(() => parsePrivateKey('not a key')).toThrow(/Invalid Private Key|must be/);
    expect(privateKeyFingerprint(parsePrivateKey(PEM))).toMatch(/^SHA256:/);
  });

  it('only allows https API URLs', () => {
    expect(validateApiBaseUrl('https://ghe.example.com/api/v3/')).toBe('https://ghe.example.com/api/v3');
    expect(() => validateApiBaseUrl('http://ghe.example.com')).toThrow();
    expect(() => validateApiBaseUrl('https://u:p@ghe.example.com')).toThrow();
  });
});

describe('GitHubService', () => {
  it('looks up the installation and requests a repository-scoped token with minimal permissions', async () => {
    const { impl, calls } = fakeFetch({
      'GET /repos/acme/api/installation': () => ({ status: 200, body: { id: 99, account: { login: 'acme' }, target_type: 'Organization', repository_selection: 'selected', permissions: { contents: 'write' } } }),
      'POST /app/installations/99/access_tokens': () => ({
        status: 201,
        body: { token: 'ghs_generatedtoken000000000000000000000', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'write' }, repositories: [{ full_name: 'acme/api' }] },
      }),
    });
    const gh = new GitHubService('https://api.github.com', impl);
    const tok = await gh.generateInstallationToken({ appId: '1', key: parsePrivateKey(PEM), owner: 'acme', repo: 'api', permissions: { contents: 'write' } });
    expect(tok.installationId).toBe('99');
    expect(tok.repositories).toEqual(['acme/api']);
    const body = JSON.parse(String(calls[1].init.body));
    expect(body).toEqual({ repositories: ['api'], permissions: { contents: 'write' } });
    expect((calls[1].init.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
  });

  it('turns API failures into friendly errors without credentials', async () => {
    const { impl } = fakeFetch({ 'GET /repos/acme/api/installation': () => ({ status: 404, body: { message: 'Not Found' } }) });
    const gh = new GitHubService('https://api.github.com', impl);
    await expect(gh.generateInstallationToken({ appId: '1', key: parsePrivateKey(PEM), owner: 'acme', repo: 'api' })).rejects.toMatchObject({
      friendly: { code: 'installation-not-found', title: 'GitHub App Not Installed' },
    });

    const { impl: impl401 } = fakeFetch({ 'GET /app': () => ({ status: 401, body: { message: 'A JSON web token could not be decoded' } }) });
    const err = await new GitHubService('https://api.github.com', impl401).authenticate('1', parsePrivateKey(PEM)).catch((e) => e);
    expect(err.friendly.title).toBe('Authentication Failed');
    expect(JSON.stringify(err.friendly)).not.toMatch(/eyJ/);
  });

  it('maps PR validation errors', async () => {
    const { impl } = fakeFetch({ 'POST /repos/acme/api/pulls': () => ({ status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feature.' }] } }) });
    const gh = new GitHubService('https://api.github.com', impl);
    await expect(gh.createPullRequest('ghs_x', { owner: 'acme', repo: 'api', title: 't', body: '', head: 'feature', base: 'main', draft: false })).rejects.toMatchObject({
      friendly: { message: 'A pull request for this branch already exists.' },
    });
  });

  it('revokes tokens', async () => {
    const { impl, calls } = fakeFetch({ 'DELETE /installation/token': () => ({ status: 204 }) });
    expect(await new GitHubService('https://api.github.com', impl).revokeInstallationToken('ghs_x')).toBe(true);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('token ghs_x');
  });
});

describe('resolveAuth', () => {
  const repo = (settings: Partial<RepoRecord['settings']> = {}): RepoRecord => ({
    id: 'repoAAAAAAAA',
    name: 'api',
    path: '/x',
    addedAt: '',
    settings: { runHooks: false, allowSystemCredentials: false, allowSavedCredentials: false, ...settings },
  });
  const deps = (fetchImpl?: ReturnType<typeof fakeFetch>['impl']) => ({
    secrets: { getPat: () => null, getGitHubAppKey: () => null, savePat: () => {}, saveGitHubAppKey: () => {} } as unknown as SecretStore,
    vault: new EphemeralVault(),
    githubFor: (b: string) => new GitHubService(b, fetchImpl),
  });

  it('offers "Git identity only" first for push and uses the existing Git setup when explicitly chosen', async () => {
    const opts = describeAuthOptions(repo(), 'git@github.com:acme/api.git', 'push', { pat: false, githubAppKey: false });
    expect(opts.map((o) => o.method)).toEqual(['system', 'ssh', 'github-app', 'pat']);
    expect(opts[0].label).toBe('Git identity only');
    await expect(resolveAuth(deps(), repo(), 'https://github.com/acme/api.git', { method: 'system' }, 'push')).resolves.toMatchObject({ git: { kind: 'system' } });
  });

  it('uses the SSH URL for the SSH method on a GitHub HTTPS remote', async () => {
    const r = await resolveAuth(deps(), repo(), 'https://github.com/acme/api.git', { method: 'ssh', keySource: 'agent' }, 'push');
    expect(r.transportUrl).toBe('git@github.com:acme/api.git');
  });

  it('refuses methods that do not fit the remote', async () => {
    await expect(resolveAuth(deps(), repo(), 'git@gitlab.com:acme/api.git', { method: 'pat', token: 'x' }, 'push')).rejects.toMatchObject({ friendly: { code: 'auth-not-applicable' } });
  });

  it('uses HTTPS for token methods on a GitHub SSH remote, without changing the remote', async () => {
    const r = await resolveAuth(deps(), repo(), 'git@github.com:acme/api.git', { method: 'pat', token: 'ghp_x' }, 'push');
    expect(r.transportUrl).toBe('https://github.com/acme/api.git');
    expect(r.git).toMatchObject({ kind: 'basic', httpPrefix: 'https://github.com/' });
  });

  it('accepts an existing installation token (pasted) and revokes it after use', async () => {
    const { impl, calls } = fakeFetch({ 'DELETE /installation/token': () => ({ status: 204 }) });
    const r = await resolveAuth(deps(impl), repo(), 'git@github.com:acme/api.git', { method: 'github-app', tokenMode: 'existing', existingToken: 'ghs_pasted', appId: '', owner: '', repo: '' }, 'push');
    expect(r.git).toMatchObject({ kind: 'basic', username: 'x-access-token', password: 'ghs_pasted' });
    expect(r.transportUrl).toBe('https://github.com/acme/api.git');
    await r.cleanup();
    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual(['DELETE /installation/token']);
    expect(r.revocation?.revoked).toBe(true);
  });

  it('uses a token generated instantly in the dialog (vault handle)', async () => {
    const d = deps();
    const { handle } = d.vault.put('installation-token', 'ghs_generated_now', 60_000);
    const r = await resolveAuth(d, repo(), 'https://github.com/acme/api.git', { method: 'github-app', tokenMode: 'existing', tokenHandle: handle, appId: '', owner: '', repo: '' }, 'push');
    expect(r.git).toMatchObject({ password: 'ghs_generated_now' });
    d.vault.clear();
  });

  it('reports the detected installation id so it can be remembered', async () => {
    const { impl } = fakeFetch({
      'GET /repos/acme/api/installation': () => ({ status: 200, body: { id: 4242, account: { login: 'acme' }, permissions: {} } }),
      'POST /app/installations/4242/access_tokens': () => ({ status: 201, body: { token: 'ghs_t', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'write' } } }),
    });
    const r = await resolveAuth(deps(impl), repo(), 'git@github.com:acme/api.git', { method: 'github-app', appId: '1', owner: 'acme', repo: 'api', privateKey: PEM }, 'push');
    expect(r.detectedInstallationId).toBe('4242');
    expect(r.transportUrl).toBe('https://github.com/acme/api.git');
  });

  it('refuses GitHub App credentials for a different repository', async () => {
    await expect(
      resolveAuth(deps(), repo(), 'https://github.com/acme/api.git', { method: 'github-app', appId: '1', owner: 'acme', repo: 'other', privateKey: PEM }, 'push'),
    ).rejects.toMatchObject({ friendly: { code: 'repo-mismatch' } });
  });

  it('refuses saved credentials when the repository did not opt in', async () => {
    await expect(resolveAuth(deps(), repo(), 'https://github.com/acme/api.git', { method: 'pat', useSaved: true }, 'push')).rejects.toMatchObject({ friendly: { code: 'auth-input' } });
  });

  it('generates, uses and revokes an installation token for push', async () => {
    const { impl, calls } = fakeFetch({
      'GET /repos/acme/api/installation': () => ({ status: 200, body: { id: 7, account: { login: 'acme' }, permissions: {} } }),
      'POST /app/installations/7/access_tokens': () => ({ status: 201, body: { token: 'ghs_pushtoken', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'write' } } }),
      'DELETE /installation/token': () => ({ status: 204 }),
    });
    const r = await resolveAuth(deps(impl), repo(), 'https://github.com/acme/api.git', { method: 'github-app', appId: '1', owner: 'acme', repo: 'api', privateKey: PEM }, 'push');
    expect(r.git).toMatchObject({ kind: 'basic', username: 'x-access-token', password: 'ghs_pushtoken' });
    expect(r.description).not.toContain('ghs_pushtoken');
    await r.cleanup();
    expect(calls.at(-1)?.init.method).toBe('DELETE');
  });
});
