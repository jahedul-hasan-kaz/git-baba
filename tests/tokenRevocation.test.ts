import { describe, expect, it } from 'vitest';
import { resolveAuth, revokeWithRetry } from '../src/main/github/authResolver';
import type { GitHubService } from '../src/main/github/GitHubService';
import { EphemeralVault } from '../src/main/security/EphemeralVault';
import type { RepoRecord } from '../src/shared/types';

const repo: RepoRecord = { id: 'r1', name: 'demo', path: '/tmp/demo', addedAt: '', settings: { runHooks: false, allowSystemCredentials: false, allowSavedCredentials: false } };

function fakeGitHub(failures = 0) {
  const revoked: string[] = [];
  let calls = 0;
  const gh = {
    revokeInstallationToken: async (t: string) => {
      calls++;
      if (calls <= failures) return false;
      revoked.push(t);
      return true;
    },
  } as unknown as GitHubService;
  return { gh, revoked, calls: () => calls };
}

const deps = (gh: GitHubService, vault = new EphemeralVault()) => ({ secrets: {} as never, vault, githubFor: () => gh });

describe('installation tokens are revoked after every operation', () => {
  it('revokes a pasted installation token after the push', async () => {
    const f = fakeGitHub();
    const r = await resolveAuth(deps(f.gh), repo, 'https://github.com/acme/demo.git', { method: 'github-app', tokenMode: 'existing', existingToken: 'ghs_pasted123', appId: '', owner: '', repo: '' }, 'push');
    expect(r.revocation?.revoked).toBeNull();
    await r.cleanup();
    expect(f.revoked).toEqual(['ghs_pasted123']);
    expect(r.revocation?.revoked).toBe(true);
  });

  it('revokes a token generated in the dialog and removes it from memory (single use)', async () => {
    const f = fakeGitHub();
    const vault = new EphemeralVault();
    const { handle } = vault.put('installation-token', 'ghs_generated456', 600_000);
    const r = await resolveAuth(deps(f.gh, vault), repo, 'git@github.com:acme/demo.git', { method: 'github-app', tokenMode: 'existing', tokenHandle: handle, appId: '', owner: '', repo: '' }, 'push');
    expect(vault.get(handle, 'installation-token')).toBeNull();
    await r.cleanup();
    expect(f.revoked).toEqual(['ghs_generated456']);
  });

  it('retries transient revocation failures and reports a final failure', async () => {
    const ok = fakeGitHub(2);
    expect(await revokeWithRetry(ok.gh, 't', 3, 1)).toBe(true);
    expect(ok.calls()).toBe(3);
    const down = fakeGitHub(99);
    expect(await revokeWithRetry(down.gh, 't', 3, 1)).toBe(false);
    expect(down.calls()).toBe(3);
  });

  it('does not involve tokens for SSH or Git-identity pushes', async () => {
    const f = fakeGitHub();
    const r = await resolveAuth(deps(f.gh), repo, 'git@github.com:acme/demo.git', { method: 'system' }, 'push');
    expect(r.revocation).toBeUndefined();
    await r.cleanup();
    expect(f.calls()).toBe(0);
  });
});
