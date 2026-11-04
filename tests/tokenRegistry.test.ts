import { describe, expect, it } from 'vitest';
import { resolveAuth } from '../src/main/github/authResolver';
import type { GitHubService } from '../src/main/github/GitHubService';
import { EphemeralVault } from '../src/main/security/EphemeralVault';
import { TokenRegistry } from '../src/main/security/TokenRegistry';
import type { RepoRecord } from '../src/shared/types';

const repo: RepoRecord = { id: 'r1', name: 'demo', path: '/tmp/demo', addedAt: '', settings: { runHooks: false, allowSystemCredentials: false, allowSavedCredentials: false } };

describe('installation token list', () => {
  it('never exposes the raw token and tracks status transitions', () => {
    const reg = new TokenRegistry();
    const id = reg.track('ghs_secretvalue1234', { source: 'token-page', apiBase: 'https://api.github.com', appId: '1', repositories: ['acme/demo'], permissions: { contents: 'read' } });
    const [rec] = reg.list();
    expect(JSON.stringify(rec)).not.toContain('ghs_secretvalue1234');
    expect(rec).toMatchObject({ id, status: 'active', masked: expect.stringContaining('••') });
    expect(reg.revocable(id)?.token).toBe('ghs_secretvalue1234');

    reg.record(id, false);
    expect(reg.list()[0].status).toBe('revoke-failed');
    expect(reg.activeIds()).toEqual([id]);

    reg.record(id, true);
    expect(reg.list()[0].status).toBe('revoked');
    expect(reg.revocable(id)).toBeNull();
    expect(reg.clearFinished()).toBe(1);
    expect(reg.list()).toEqual([]);
  });

  it('marks tokens past their GitHub expiry as expired and forgets the secret', () => {
    const reg = new TokenRegistry();
    const id = reg.track('ghs_old', { source: 'pasted', apiBase: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(reg.list()[0].status).toBe('expired');
    expect(reg.revocable(id)).toBeNull();
  });

  it('a token generated in a dialog and then used for a push shows as one entry, revoked', async () => {
    const reg = new TokenRegistry();
    const vault = new EphemeralVault();
    const { handle } = vault.put('installation-token', 'ghs_fromdialog', 60_000);
    reg.track('ghs_fromdialog', { source: 'dialog', apiBase: 'https://api.github.com', vaultHandle: handle });
    const gh = { revokeInstallationToken: async () => true } as unknown as GitHubService;
    const r = await resolveAuth({ secrets: {} as never, vault, githubFor: () => gh, tokens: reg }, repo, 'https://github.com/acme/demo.git', { method: 'github-app', tokenMode: 'existing', tokenHandle: handle, appId: '', owner: '', repo: '' }, 'push');
    await r.cleanup();
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'dialog', status: 'revoked', usedFor: ['push'] });
  });
});
