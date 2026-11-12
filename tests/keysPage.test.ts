import { describe, expect, it } from 'vitest';
import { AppError } from '../src/main/git/errors';
import { gpgFailureMessage } from '../src/main/git/gpg';
import { parseSshTestOutput, signingSettings } from '../src/main/git/sshTest';
import { isKeyAccessDenied, KEY_PERMISSIONS, keyAccessError, listGpgKeysWithAccess, listSshKeys } from '../src/main/github/services/account';
import { GitHubClient } from '../src/main/github/client/GitHubClient';
import {
  isGpgSigningKey,
  isSshSigningKey,
  keyFileNameProblem,
  passphraseStrength,
  shortFingerprint,
  suggestKeyFileName,
  takenKeyNames,
} from '../src/renderer/pages/account/settings/keyNames';

describe('key file names', () => {
  it('suggests id_<type>_<login> and then numbered variants', () => {
    const taken = takenKeyNames(['C:\\Users\\me\\.ssh\\id_ed25519.pub', '/home/me/.ssh/id_ed25519_octocat.pub', '/home/me/.ssh/id_ed25519_octocat_2.pub']);
    expect(suggestKeyFileName('ed25519', 'Octocat', taken)).toBe('id_ed25519_octocat_3');
    expect(suggestKeyFileName('rsa', 'Octocat', taken)).toBe('id_rsa_octocat');
    expect(suggestKeyFileName('ed25519', null, taken)).toBe('id_ed25519_2');
    expect(suggestKeyFileName('ed25519', 'new.user', new Set())).toBe('id_ed25519_new.user');
  });

  it('validates names live', () => {
    const taken = takenKeyNames(['/x/.ssh/id_ed25519_github.pub']);
    expect(keyFileNameProblem('id_ed25519_github', taken)).toMatch(/already exists/);
    expect(keyFileNameProblem('ID_ED25519_GITHUB', taken)).toMatch(/already exists/);
    expect(keyFileNameProblem('my key', taken)).toMatch(/letters/);
    expect(keyFileNameProblem('k.pub', taken)).toMatch(/\.pub/);
    expect(keyFileNameProblem('known_hosts2', taken)).toMatch(/reserved/);
    expect(keyFileNameProblem('.hidden', taken)).toMatch(/dot/);
    expect(keyFileNameProblem('', taken)).toMatch(/Enter/);
    expect(keyFileNameProblem('id_work', taken)).toBeNull();
  });

  it('rates passphrases', () => {
    expect(passphraseStrength('').score).toBe(0);
    expect(passphraseStrength('abc').label).toBe('Too short');
    expect(passphraseStrength('abcdefgh1X').score).toBe(2);
    expect(passphraseStrength('correct horse battery staple').score).toBe(3);
  });

  it('shortens fingerprints', () => {
    expect(shortFingerprint('SHA256:abcdefghijklmnopqrstuvwxyz0123')).toBe('abcdefgh…0123');
  });
});

describe('signing key detection', () => {
  const k = { pubPath: 'C:\\Users\\me\\.ssh\\id_ed25519.pub', publicKey: 'ssh-ed25519 AAAAC3Nza me@x' };
  it('matches SSH keys by path or literal key', () => {
    expect(isSshSigningKey('C:/Users/me/.ssh/id_ed25519.pub', k)).toBe(true);
    expect(isSshSigningKey('~/.ssh/id_ed25519.pub', k)).toBe(true);
    expect(isSshSigningKey('key::ssh-ed25519 AAAAC3Nza other', k)).toBe(true);
    expect(isSshSigningKey('ssh-ed25519 AAAAC3Nza', k)).toBe(true);
    expect(isSshSigningKey('C:/Users/me/.ssh/id_rsa.pub', k)).toBe(false);
    expect(isSshSigningKey(null, k)).toBe(false);
  });
  it('matches GPG keys by id or fingerprint', () => {
    const g = { keyId: 'BA25F952FFDF5530', fingerprint: 'FD6F9471BFB89030494E4418BA25F952FFDF5530' };
    expect(isGpgSigningKey('BA25F952FFDF5530', g)).toBe(true);
    expect(isGpgSigningKey('0xba25f952ffdf5530!', g)).toBe(true);
    expect(isGpgSigningKey('FD6F9471BFB89030494E4418BA25F952FFDF5530', g)).toBe(true);
    expect(isGpgSigningKey('FFDF5530', g)).toBe(true);
    expect(isGpgSigningKey('1234567890ABCDEF', g)).toBe(false);
  });
});

describe('ssh -T output', () => {
  it('recognises a successful GitHub login (exit code 1)', () => {
    const r = parseSshTestOutput(1, "Hi octo-cat! You've successfully authenticated, but GitHub does not provide shell access.\n");
    expect(r).toMatchObject({ ok: true, login: 'octo-cat', reason: 'ok' });
  });
  it('recognises deploy keys', () => {
    expect(parseSshTestOutput(1, "Hi acme/site! You've successfully authenticated, but GitHub does not provide shell access.").login).toBe('acme/site');
  });
  it('explains failures', () => {
    expect(parseSshTestOutput(255, "Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\r\ngit@github.com: Permission denied (publickey).").reason).toBe('denied');
    expect(parseSshTestOutput(255, 'ssh: connect to host github.com port 22: Connection timed out').reason).toBe('network');
    expect(parseSshTestOutput(255, 'ssh: Could not resolve hostname github.com: Name or service not known').reason).toBe('network');
    expect(parseSshTestOutput(255, '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.').reason).toBe('host-key');
    expect(parseSshTestOutput(255, 'WARNING: UNPROTECTED PRIVATE KEY FILE!\nbad permissions').reason).toBe('key-permissions');
    expect(parseSshTestOutput(255, 'something odd')).toMatchObject({ reason: 'unknown', message: 'ssh: something odd' });
  });
});

describe('signing settings', () => {
  it('lists exactly what will be written', () => {
    expect(signingSettings({ kind: 'ssh', pubPath: 'C:\\Users\\me\\.ssh\\id.pub', signAll: false })).toEqual([
      ['gpg.format', 'ssh'],
      ['user.signingkey', 'C:/Users/me/.ssh/id.pub'],
    ]);
    expect(signingSettings({ kind: 'gpg', keyId: 'ABCDEF0123456789', gpgProgram: 'C:\\Program Files\\GnuPG\\bin\\gpg.exe', signAll: true })).toEqual([
      ['gpg.format', 'openpgp'],
      ['user.signingkey', 'ABCDEF0123456789'],
      ['gpg.program', 'C:/Program Files/GnuPG/bin/gpg.exe'],
      ['commit.gpgsign', 'true'],
    ]);
  });
});

describe('gpg failure messages', () => {
  it('surfaces the real reason', () => {
    expect(gpgFailureMessage("gpg: keybox 'x' created\ngpg: can't connect to the agent: IPC connect call failed\ngpg: agent_genkey failed: No agent running\ngpg: key generation failed: No agent running")).toMatch(/gpg-agent/);
    expect(gpgFailureMessage('gpg: agent_genkey failed: Bad passphrase\ngpg: key generation failed: Bad passphrase')).toBe('Wrong passphrase.');
    expect(gpgFailureMessage('gpg: key generation failed: Invalid user ID')).toBe('key generation failed: Invalid user ID');
  });
});

describe('account key permissions', () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const client = (routes: Record<string, () => Response>) =>
    new GitHubClient('https://api.github.com', 'tok', async (url) => {
      const p = new URL(String(url)).pathname;
      return (routes[p] ?? (() => json(404, { message: 'Not Found' })))();
    }, async () => undefined);

  it('returns empty lists plus the missing permissions instead of a repository error', async () => {
    const denied = () => json(403, { message: 'Resource not accessible by personal access token' });
    const r = await listSshKeys(client({ '/user/keys': denied, '/user/ssh_signing_keys': denied }), { tokenKind: 'fine-grained', webBase: 'https://github.com' });
    expect(r.authentication).toEqual([]);
    expect(r.access.ok).toBe(false);
    expect(r.access.missing.map((m) => m.fineGrained)).toEqual(['Git SSH keys', 'SSH signing keys']);
    expect(r.signingError).toBeNull();
  });

  it('keeps the readable list when only signing keys are denied', async () => {
    const r = await listSshKeys(
      client({ '/user/keys': () => json(200, [{ id: 1, title: 't', key: 'ssh-ed25519 AAAA', created_at: null }]), '/user/ssh_signing_keys': () => json(404, { message: 'Not Found' }) }),
      { tokenKind: 'classic', webBase: 'https://github.com' },
    );
    expect(r.authentication).toHaveLength(1);
    expect(r.access.missing).toEqual([KEY_PERMISSIONS.signing]);
  });

  it('GPG list degrades the same way, and the thrown variant says what to enable', async () => {
    const r = await listGpgKeysWithAccess(client({ '/user/gpg_keys': () => json(403, { message: 'Resource not accessible by personal access token' }) }), { tokenKind: 'fine-grained', webBase: 'https://github.com' });
    expect(r).toMatchObject({ keys: [], access: { ok: false, missing: [KEY_PERMISSIONS.gpg] } });
    const e = keyAccessError([KEY_PERMISSIONS.gpg], 'fine-grained');
    expect(e.friendly.message).toContain('"GPG keys"');
    expect(e.friendly.message).not.toMatch(/repository/);
    expect(isKeyAccessDenied(new AppError({ code: 'network', title: 'x', message: 'y' }))).toBe(false);
  });
});
