import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGitAuthEnv } from '../src/main/git/credentials';
import { toFriendlyError } from '../src/main/git/errors';
import { applicableAuthMethods, httpsEquivalent, parseRemoteUrl, sshEquivalent, validateRemoteUrl } from '../src/main/git/remoteUrl';
import { isPublished } from '../src/shared/publish';
import { GitCommandError } from '../src/main/git/runner';
import { SecretStore, type Encryptor } from '../src/main/repositories/SecretStore';
import { ConfirmationRegistry } from '../src/main/security/ConfirmationRegistry';
import { EphemeralVault } from '../src/main/security/EphemeralVault';
import { resolveInsideRepo } from '../src/main/util/paths';
import { maskToken, redactSecrets } from '../src/main/util/redact';
import { asFolderName, isValidBranchName } from '../src/main/util/validate';

describe('redactSecrets', () => {
  it('removes tokens, private keys, JWTs, auth headers and URL credentials', () => {
    const text = [
      'token ghs_abcdefghijklmnopqrstuvwxyz012345',
      'pat github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl',
      'Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0',
      'https://user:hunter2@github.com/o/r.git',
    ].join('\n');
    const out = redactSecrets(text, ['customsecret']);
    expect(out).not.toMatch(/ghs_|github_pat_|MIIEow|eyJhbGci|eC1hY2Nlc3M|hunter2/);
    expect(redactSecrets('value customsecret here', ['customsecret'])).toBe('value [REDACTED] here');
  });

  it('masks tokens for display', () => {
    expect(maskToken('ghs_1234567890abcdef')).toBe('ghs_••••••••cdef');
  });
});

describe('path validation', () => {
  const root = path.resolve(os.tmpdir(), 'repo-root');
  it('accepts paths inside the repository', () => {
    expect(resolveInsideRepo(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
  });
  it.each(['../etc/passwd', 'src/../../x', '/etc/passwd', 'C:\\Windows\\x', '.git/config', 'sub/.GIT/hooks/pre-commit', 'a\0b', ''])('rejects %j', (p) => {
    expect(() => resolveInsideRepo(root, p)).toThrow();
  });
});

describe('input validation', () => {
  it('validates branch names', () => {
    expect(isValidBranchName('feature/login-fix')).toBe(true);
    for (const bad of ['-f', '--upload-pack=x', 'a..b', 'a b', 'x.lock', 'a~1', 'a^', 'a:b', '@', 'refs/../x', '.hidden']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });
  it('validates folder names', () => {
    expect(asFolderName('my-project')).toBe('my-project');
    for (const bad of ['..', 'a/b', 'a\\b', '-x', 'CON', 'trail.']) expect(() => asFolderName(bad)).toThrow();
  });
});

describe('remote URLs', () => {
  it('parses GitHub https and ssh remotes', () => {
    expect(parseRemoteUrl('https://github.com/acme/backend.git')).toMatchObject({ protocol: 'https', owner: 'acme', repo: 'backend', isGitHub: true, httpPrefix: 'https://github.com/' });
    expect(parseRemoteUrl('git@github.com:acme/backend.git')).toMatchObject({ protocol: 'ssh', owner: 'acme', repo: 'backend', isGitHub: true });
    expect(parseRemoteUrl('ssh://git@github.com/acme/backend')).toMatchObject({ protocol: 'ssh', repo: 'backend' });
    expect(parseRemoteUrl('C:\\repos\\bare.git').protocol).toBe('local');
    expect(parseRemoteUrl('/srv/git/bare.git').protocol).toBe('local');
  });

  it('rejects dangerous or credential-bearing URLs', () => {
    for (const bad of ['ext::sh -c touch% /tmp/pwned', '--upload-pack=evil', 'https://token@github.com/a/b', 'fd::17', 'https://github.com/a b']) {
      expect(validateRemoteUrl(bad).ok, bad).toBe(false);
    }
    expect(validateRemoteUrl('https://github.com/a/b.git').ok).toBe(true);
  });

  it('accepts folder paths with spaces, but not network URLs with spaces', () => {
    expect(validateRemoteUrl('C:\\My Projects\\repo.git').ok).toBe(true);
    expect(validateRemoteUrl('/srv/my repos/a.git').ok).toBe(true);
    expect(validateRemoteUrl('git@github.com:a/b c.git').ok).toBe(false);
    expect(validateRemoteUrl('C:\\repo\u0007.git').ok).toBe(false);
  });

  it('tells whether the current branch is published under its own name', () => {
    expect(isPublished({ branch: 'main', upstream: 'origin/main' })).toBe(true);
    expect(isPublished({ branch: 'main', upstream: 'origin/main', upstreamGone: true })).toBe(false);
    expect(isPublished({ branch: 'feature', upstream: 'origin/main' })).toBe(false);
    expect(isPublished({ branch: 'main', upstream: null })).toBe(false);
  });

  it('offers only applicable auth methods', () => {
    expect(applicableAuthMethods(parseRemoteUrl('https://github.com/a/b'))).toEqual(['system', 'ssh', 'github-app', 'pat']);
    expect(applicableAuthMethods(parseRemoteUrl('https://gitlab.com/a/b'))).toEqual(['system', 'pat']);
    // GitHub SSH remotes also accept tokens (over HTTPS for that operation); other SSH hosts only SSH.
    expect(applicableAuthMethods(parseRemoteUrl('git@github.com:a/b.git'))).toEqual(['system', 'ssh', 'github-app', 'pat']);
    expect(applicableAuthMethods(parseRemoteUrl('git@gitlab.com:a/b.git'))).toEqual(['system', 'ssh']);
    expect(sshEquivalent(parseRemoteUrl('https://github.com/acme/api.git'))).toBe('git@github.com:acme/api.git');
    expect(sshEquivalent(parseRemoteUrl('https://gitlab.com/acme/api.git'))).toBeNull();
    expect(httpsEquivalent(parseRemoteUrl('git@github.com:acme/api.git'))).toEqual({ url: 'https://github.com/acme/api.git', httpPrefix: 'https://github.com/' });
    expect(httpsEquivalent(parseRemoteUrl('https://github.com/acme/api.git'))).toBeNull();
    expect(applicableAuthMethods(parseRemoteUrl('/srv/bare.git'))).toEqual(['none']);
  });
});

describe('git credential injection', () => {
  it('uses environment config scoped to the host and disables credential helpers', () => {
    const { env, secrets } = buildGitAuthEnv({ kind: 'basic', username: 'x-access-token', password: 'ghs_secret', httpPrefix: 'https://github.com/' });
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraHeader');
    expect(Buffer.from(env.GIT_CONFIG_VALUE_1.replace('Authorization: Basic ', ''), 'base64').toString()).toBe('x-access-token:ghs_secret');
    expect(secrets).toContain('ghs_secret');
  });
});

describe('friendly errors', () => {
  it('maps git authentication failures without leaking credentials', () => {
    const err = new GitCommandError({ exitCode: 128, stderr: "remote: Invalid username or password.\nfatal: Authentication failed for 'https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b'", stdout: '', command: 'git push' });
    const f = toFriendlyError(err, 'Push');
    expect(f.title).toBe('Authentication Failed');
    expect(f.actions).toContain('review-auth');
    expect(f.technical).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });

  it('maps rejected pushes and conflicts', () => {
    const push = toFriendlyError(new GitCommandError({ exitCode: 1, stderr: ' ! [rejected] main -> main (fetch first)', stdout: '', command: 'git push' }), 'Push');
    expect(push.code).toBe('push-rejected');
    const conflict = toFriendlyError(new GitCommandError({ exitCode: 1, stderr: '', stdout: 'CONFLICT (content): Merge conflict in a.txt', command: 'git merge' }), 'Pull');
    expect(conflict.code).toBe('conflict');
  });

  it('never exposes stack traces for unexpected errors', () => {
    const f = toFriendlyError(new Error('boom'), 'Fetch');
    expect(f.message).not.toContain('at ');
    expect(f.technical).toBe('boom');
  });
});

describe('ConfirmationRegistry', () => {
  it('is single-use and bound to repo + kind', () => {
    const reg = new ConfirmationRegistry();
    const id = reg.create('push', 'repo1', { oid: 'x' });
    expect(() => reg.consume(id, 'commit', 'repo1')).toThrow();
    const id2 = reg.create('push', 'repo1', { oid: 'y' });
    expect(() => reg.consume(id2, 'push', 'repo2')).toThrow();
    const id3 = reg.create('push', 'repo1', { oid: 'z' });
    expect(reg.consume(id3, 'push', 'repo1')).toEqual({ oid: 'z' });
    expect(() => reg.consume(id3, 'push', 'repo1')).toThrow();
  });

  it('invalidates older previews of the same kind', () => {
    const reg = new ConfirmationRegistry();
    const a = reg.create('commit', 'r', 1);
    reg.create('commit', 'r', 2);
    expect(() => reg.consume(a, 'commit', 'r')).toThrow();
  });
});

describe('EphemeralVault', () => {
  afterEach(() => vi.useRealTimers());

  it('expires entries and runs the expiry hook (used to revoke tokens)', () => {
    vi.useFakeTimers();
    const vault = new EphemeralVault();
    const revoked: string[] = [];
    const { handle } = vault.put('installation-token', 'ghs_x', 1000, { onExpire: (v) => revoked.push(v) });
    expect(vault.get(handle, 'installation-token')).toBe('ghs_x');
    expect(vault.get(handle, 'private-key')).toBeNull();
    vi.advanceTimersByTime(1001);
    expect(vault.get(handle, 'installation-token')).toBeNull();
    expect(revoked).toEqual(['ghs_x']);
  });

  it('take() is single use', () => {
    const vault = new EphemeralVault();
    const { handle } = vault.put('private-key', 'pem', 60_000);
    expect(vault.take(handle, 'private-key')).toBe('pem');
    expect(vault.take(handle, 'private-key')).toBeNull();
    vault.clear();
  });
});

describe('SecretStore', () => {
  const fakeEncryptor = (available = true): Encryptor => ({
    isAvailable: () => available,
    encrypt: (s) => Buffer.from(Buffer.from(s).toString('base64')),
    decrypt: (b) => Buffer.from(b.toString(), 'base64').toString(),
  });

  it('isolates secrets per repository and never writes plaintext', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-secrets-'));
    const store = new SecretStore(dir, fakeEncryptor());
    store.savePat('repoAAAAAAAA', 'x-access-token', 'ghp_supersecret');
    expect(store.getPat('repoAAAAAAAA')?.token).toBe('ghp_supersecret');
    expect(store.getPat('repoBBBBBBBB')).toBeNull();
    const raw = fs.readFileSync(path.join(dir, 'repoAAAAAAAA.bin'), 'utf8');
    expect(raw).not.toContain('ghp_supersecret');
    store.forget('repoAAAAAAAA', 'pat');
    expect(store.status('repoAAAAAAAA').pat).toBe(false);
  });

  it('refuses to save when OS encryption is unavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-secrets-'));
    const store = new SecretStore(dir, fakeEncryptor(false));
    expect(() => store.savePat('repoAAAAAAAA', 'u', 't')).toThrow(/not available/);
  });

  it('rejects ids that could escape the secrets folder', () => {
    const store = new SecretStore(os.tmpdir(), fakeEncryptor());
    expect(() => store.getPat('../../etc')).toThrow();
  });
});
