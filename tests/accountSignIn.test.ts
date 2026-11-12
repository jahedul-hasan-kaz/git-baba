import { describe, expect, it } from 'vitest';
import { hostForApiBase } from '../src/main/accounts/accountAuth';
import { parseSshWhoAmI, sshWhoAmIArgs } from '../src/main/accounts/sshIdentity';
import { parseGhAuthStatus } from '../src/main/github/ghCli';
import { detectTokenKind } from '../src/shared/tokenKind';

describe('ssh -T identity parsing', () => {
  it('reads the login from GitHub’s greeting (exit code 1 is normal)', () => {
    const r = parseSshWhoAmI("Hi octo-cat! You've successfully authenticated, but GitHub does not provide shell access.\r\n", 1);
    expect(r).toEqual({ ok: true, login: 'octo-cat', message: expect.stringContaining('octo-cat') });
  });

  it('ignores warnings printed before the greeting', () => {
    const out = "Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\nHi alice! You've successfully authenticated, but GitHub does not provide shell access.";
    expect(parseSshWhoAmI(out, 1).login).toBe('alice');
  });

  it('refuses deploy keys (they belong to a repository)', () => {
    const r = parseSshWhoAmI("Hi acme/backend! You've successfully authenticated, but GitHub does not provide shell access.", 1);
    expect(r.ok).toBe(false);
    expect(r.login).toBeNull();
    expect(r.message).toMatch(/deploy key/);
  });

  it('explains a rejected key, a host-key problem and network failures', () => {
    expect(parseSshWhoAmI('git@github.com: Permission denied (publickey).', 255).message).toMatch(/did not accept/);
    expect(parseSshWhoAmI('Host key verification failed.', 255).message).toMatch(/host key/);
    expect(parseSshWhoAmI('ssh: Could not resolve hostname github.com: No such host is known.', 255).message).toMatch(/reach/);
    expect(parseSshWhoAmI("Load key \"C:\\\\Users\\\\me\\\\.ssh\\\\id_ed25519\": incorrect passphrase supplied to decrypt private key\nPermission denied (publickey).", 255).message).toMatch(/passphrase/);
    expect(parseSshWhoAmI('', null).ok).toBe(false);
  });

  it('builds batch-mode arguments and uses a chosen key exclusively', () => {
    expect(sshWhoAmIArgs('github.com')).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', 'git@github.com']);
    const withKey = sshWhoAmIArgs('ghe.example.com', 'C:\\keys\\id');
    expect(withKey).toContain('IdentitiesOnly=yes');
    expect(withKey.slice(-1)).toEqual(['git@ghe.example.com']);
  });
});

describe('token kind detection', () => {
  it('recognises GitHub token prefixes', () => {
    expect(detectTokenKind('ghp_' + 'a'.repeat(36))?.kind).toBe('classic');
    expect(detectTokenKind('github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz')?.kind).toBe('fine-grained');
    expect(detectTokenKind('gho_' + 'B'.repeat(36))?.kind).toBe('oauth');
    expect(detectTokenKind('ghs_' + 'c'.repeat(36))).toMatchObject({ kind: 'app-installation', usable: false });
    expect(detectTokenKind('0123456789abcdef0123456789abcdef01234567')?.kind).toBe('legacy');
  });
  it('flags non-tokens and ignores empty input', () => {
    expect(detectTokenKind('my password')).toMatchObject({ kind: 'unknown', usable: false });
    expect(detectTokenKind('   ')).toBeNull();
  });
});

describe('gh auth status parsing', () => {
  it('lists logins and finds the active one', () => {
    const out = `github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  - Git operations protocol: https

  ✓ Logged in to github.com account bob (keyring)
  - Active account: false`;
    expect(parseGhAuthStatus(out)).toEqual({ logins: ['alice', 'bob'], active: 'alice' });
  });
  it('handles the older single-account format', () => {
    expect(parseGhAuthStatus('github.com\n  ✓ Logged in to github.com as carol (oauth_token)')).toEqual({ logins: ['carol'], active: 'carol' });
    expect(parseGhAuthStatus('You are not logged into any GitHub hosts.')).toEqual({ logins: [], active: null });
  });
});

describe('API base → host', () => {
  it('maps github.com and Enterprise API URLs to their web host', () => {
    expect(hostForApiBase(undefined)).toBe('github.com');
    expect(hostForApiBase('https://api.github.com')).toBe('github.com');
    expect(hostForApiBase('https://ghe.example.com/api/v3')).toBe('ghe.example.com');
  });
});
