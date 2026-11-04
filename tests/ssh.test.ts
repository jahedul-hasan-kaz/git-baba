import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGitAuthEnv } from '../src/main/git/credentials';
import { GitService } from '../src/main/git/GitService';
import { runGit } from '../src/main/git/runner';
import { findPrivateKeyFor, inspectSshKey, parsePublicKey, sshKeygenBinary, verifySshPassphrase } from '../src/main/git/sshKeys';
import { resolveSshKeyFile } from '../src/main/github/authResolver';
import { EphemeralVault } from '../src/main/security/EphemeralVault';
import type { SecretStore } from '../src/main/repositories/SecretStore';
import type { RepoRecord } from '../src/shared/types';

const PASSPHRASE = "correct horse $battery 'staple'";
let tmp: string;
let plainKey: string;
let encryptedKey: string;

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    // ssh-keygen -? exits non-zero but exists
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
const sshAvailable = hasSshKeygen();

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ssh-')));
  if (!sshAvailable) return;
  plainKey = path.join(tmp, 'id_plain');
  encryptedKey = path.join(tmp, 'id with space');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'plain', '-f', plainKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', PASSPHRASE, '-C', 'enc', '-f', encryptedKey]);
});

describe.skipIf(!sshAvailable)('SSH keys', () => {
  it('detects passphrase protection and computes the same fingerprint as ssh-keygen', () => {
    const plain = inspectSshKey(plainKey);
    const enc = inspectSshKey(encryptedKey);
    expect(plain.encrypted).toBe(false);
    expect(enc.encrypted).toBe(true);
    const expected = execFileSync('ssh-keygen', ['-lf', `${plainKey}.pub`]).toString().split(' ')[1];
    expect(plain.fingerprint).toBe(expected);
  });

  it('rejects public keys and PuTTY keys', () => {
    expect(() => inspectSshKey(`${plainKey}.pub`)).toThrow();
    const ppk = path.join(tmp, 'key.ppk');
    fs.writeFileSync(ppk, 'PuTTY-User-Key-File-3: ssh-ed25519\n');
    expect(() => inspectSshKey(ppk)).toThrow(/PuTTY/);
  });

  it('builds a GIT_SSH_COMMAND for the chosen key and passes the passphrase only via env', () => {
    const { env, secrets } = buildGitAuthEnv({ kind: 'ssh', keyPath: encryptedKey, passphrase: PASSPHRASE });
    expect(env.GIT_SSH_COMMAND).toContain('-o IdentitiesOnly=yes');
    expect(env.GIT_SSH_COMMAND).toContain(`'${encryptedKey.replace(/\\/g, '/')}'`);
    expect(env.GIT_SSH_COMMAND).not.toContain(PASSPHRASE);
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(env.GG_SSH_PASSPHRASE).toBe(PASSPHRASE);
    expect(secrets).toContain(PASSPHRASE);
    expect(buildGitAuthEnv({ kind: 'ssh', keyPath: plainKey }).env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
  });

  it('requires a passphrase for protected keys and only accepts dialog handles or the remembered path', () => {
    const vault = new EphemeralVault();
    const deps = { vault, secrets: {} as SecretStore, githubFor: () => { throw new Error('unused'); } };
    const repo: RepoRecord = { id: 'repoAAAAAAAA', name: 'r', path: tmp, addedAt: '', settings: { runHooks: false, allowSystemCredentials: false, allowSavedCredentials: false, sshKeyPath: plainKey } };
    const { handle } = vault.put('ssh-key-path', encryptedKey, 60_000);
    expect(() => resolveSshKeyFile(deps, repo, { keySource: 'file', keyHandle: handle })).toThrow(/passphrase/);
    expect(resolveSshKeyFile(deps, repo, { keySource: 'file', keyHandle: handle, passphrase: 'x' })?.keyPath).toBe(encryptedKey);
    expect(resolveSshKeyFile(deps, repo, { keySource: 'file', keyHandle: 'saved' })?.keyPath).toBe(plainKey);
    expect(() => resolveSshKeyFile(deps, repo, { keySource: 'file', keyHandle: 'not-a-real-handle' })).toThrow(/Provide your SSH public key/);
    expect(resolveSshKeyFile(deps, repo, { keySource: 'agent' })).toBeNull();
    vault.clear();
  });

  it('parses public keys and refuses pasted private keys', () => {
    const pubText = fs.readFileSync(`${encryptedKey}.pub`, 'utf8');
    const pub = parsePublicKey(pubText);
    expect(pub.type).toBe('ssh-ed25519');
    expect(pub.comment).toBe('enc');
    expect(pub.fingerprint).toBe(inspectSshKey(encryptedKey).fingerprint);
    expect(() => parsePublicKey(fs.readFileSync(encryptedKey, 'utf8'))).toThrow(/private key/i);
    expect(() => parsePublicKey('ssh-ed25519 not-base64!!')).toThrow();
    expect(() => parsePublicKey('ssh-rsa ' + pubText.split(' ')[1])).toThrow(); // type/blob mismatch
  });

  it('finds the private key that matches a public key (next to the .pub file, or in the ssh folder)', () => {
    const pub = parsePublicKey(fs.readFileSync(`${encryptedKey}.pub`, 'utf8'));
    expect(findPrivateKeyFor(pub.fingerprint, { sshDir: tmp })).toBe(encryptedKey);
    expect(findPrivateKeyFor(pub.fingerprint, { pubFilePath: `${encryptedKey}.pub`, sshDir: path.join(tmp, 'nope') })).toBe(encryptedKey);
    const other = parsePublicKey(fs.readFileSync(`${plainKey}.pub`, 'utf8'));
    expect(findPrivateKeyFor(other.fingerprint, { sshDir: tmp })).toBe(plainKey);
    expect(findPrivateKeyFor('SHA256:doesnotexist', { sshDir: tmp })).toBeNull();
  });

  it('verifies the passphrase locally before any network operation (askpass, no tty)', async () => {
    // Same binary the app uses at startup (Git's own ssh-keygen; Windows' OpenSSH cannot run the askpass script).
    const keygen = sshKeygenBinary(execFileSync('git', ['--exec-path']).toString().trim());
    expect(await verifySshPassphrase(encryptedKey, PASSPHRASE, keygen)).toBe(true);
    expect(await verifySshPassphrase(encryptedKey, 'wrong passphrase', keygen)).toBe(false);
  });
});

describe('push via transport URL (HTTPS equivalent of an SSH remote)', () => {
  it('pushes to the transport URL and records the remote-tracking ref for the named remote', async () => {
    const bare = path.join(tmp, 'remote.git');
    await runGit({ cwd: tmp, args: ['init', '--bare', '--initial-branch=main', bare] });
    const g = await GitService.init(path.join(tmp, 'transport'), 'main');
    await g.setIdentity('T', 't@example.com');
    // "origin" points somewhere unreachable; the operation uses the transport URL instead.
    await g.setRemote('origin', 'git@github.com:acme/does-not-exist.git');
    fs.writeFileSync(path.join(g.root, 'f.txt'), 'f\n');
    await g.stageAll();
    const c = await g.commit('init', 'none');
    await g.push('origin', c.hash, 'main', { kind: 'none' }, { setUpstreamFor: 'main', transportUrl: bare });
    expect(await g.revParse('refs/remotes/origin/main')).toBe(c.hash);
    expect((await runGit({ cwd: bare, args: ['rev-parse', 'refs/heads/main'] })).stdout.trim()).toBe(c.hash);
    expect((await g.remotes())[0].fetchUrl).toBe('git@github.com:acme/does-not-exist.git');
    await g.fetch('origin', { kind: 'none' }, bare);
  });
});
