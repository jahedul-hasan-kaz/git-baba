// "Test connection" for one SSH key (ssh -T git@github.com) and the global commit-signing settings.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SigningConfig, SshTestResult } from '../../shared/types';
import { runGit } from './runner';
import { getSshKeygenBinary, passphraseEnv, toSshPath } from './sshKeys';

/** Interprets the output of `ssh -T git@github.com`. Pure — exported for tests. */
export function parseSshTestOutput(code: number | null, output: string, host = 'github.com'): Omit<SshTestResult, 'via'> {
  const detail = output.trim().slice(0, 4000);
  // GitHub ends the session with exit code 1 after greeting: "Hi octocat! You've successfully authenticated, …"
  const hi = /Hi ([A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?)! You've successfully authenticated/.exec(output);
  if (hi) return { ok: true, login: hi[1], reason: 'ok', message: `Authenticated as ${hi[1]}`, detail };
  if (/Welcome to GitLab|logged in as/i.test(output) && code === 0) return { ok: true, login: null, reason: 'ok', message: 'Authenticated', detail };
  if (/bad passphrase|incorrect passphrase|passphrase.*(wrong|incorrect)/i.test(output)) {
    return { ok: false, login: null, reason: 'passphrase-wrong', message: 'Wrong passphrase for this key.', detail };
  }
  if (/UNPROTECTED PRIVATE KEY FILE|bad permissions/i.test(output)) {
    return { ok: false, login: null, reason: 'key-permissions', message: 'ssh refused the key file because other users can read it. Restrict the file to your user only.', detail };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(output)) {
    return { ok: false, login: null, reason: 'host-key', message: `${host}'s host key does not match the one saved in known_hosts. Check https://docs.github.com/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints before trusting it.`, detail };
  }
  if (/Could not resolve hostname|Connection timed out|Connection refused|Network is unreachable|Operation timed out|connect to host .* port \d+|Connection closed by remote host|kex_exchange_identification/i.test(output)) {
    return { ok: false, login: null, reason: 'network', message: `Could not reach ${host} over SSH. A firewall or proxy may block port 22.`, detail };
  }
  if (/Permission denied \(publickey/i.test(output)) {
    return { ok: false, login: null, reason: 'denied', message: `${host} did not accept this key. Add it to your GitHub account (as an authentication key) first.`, detail };
  }
  const last = detail.split(/\r?\n/).filter((l) => l.trim() && !/^Warning: Permanently added/.test(l)).pop();
  return { ok: false, login: null, reason: 'unknown', message: last ? `ssh: ${last}` : `ssh exited with code ${code ?? 'unknown'}.`, detail };
}

/** The ssh that sits next to the configured ssh-keygen (Git for Windows' OpenSSH), else ssh on PATH. */
export function sshBinary(): string {
  const keygen = getSshKeygenBinary();
  if (path.isAbsolute(keygen)) {
    const c = path.join(path.dirname(keygen), process.platform === 'win32' ? 'ssh.exe' : 'ssh');
    if (fs.existsSync(c)) return c;
  }
  return 'ssh';
}

function runSsh(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string; spawnError: string | null }> {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (e) {
      resolve({ code: null, output: '', spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    const add = (d: Buffer) => {
      if (output.length < 8000) output += d.toString();
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output, spawnError: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, spawnError: null });
    });
  });
}

/**
 * `ssh -T git@<host>` with exactly one key. The user's ~/.ssh/config is NOT read (-F none) so the answer is about
 * this key only; new host keys are accepted into ~/.ssh/known_hosts, changed ones are refused. With a passphrase the
 * askpass helper answers the prompt (environment of this one process only). When port 22 is blocked on github.com,
 * the test is repeated once over ssh.github.com:443.
 */
export async function testSshConnection(opts: { privateKey: string; knownHosts: string; host?: string; passphrase?: string }): Promise<SshTestResult> {
  const host = opts.host ?? 'github.com';
  const bin = sshBinary();
  const base = ['-F', 'none', '-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${toSshPath(opts.knownHosts)}`, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=10', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no'];
  // BatchMode also disables askpass, so it is only used without a passphrase.
  if (!opts.passphrase) base.push('-o', 'BatchMode=yes');
  base.push('-i', toSshPath(opts.privateKey));
  const env = { ...process.env, ...(opts.passphrase ? passphraseEnv(opts.passphrase) : {}) };
  const scrub = (s: string) => (opts.passphrase ? s.split(opts.passphrase).join('***') : s);
  const attempt = async (target: string[], label: string | null): Promise<SshTestResult> => {
    const r = await runSsh(bin, [...base, ...target], env, 25_000);
    if (r.spawnError) return { ok: false, login: null, reason: 'no-ssh', message: 'ssh was not found. Install Git for Windows (it ships OpenSSH) and restart Git Baba.', via: null, detail: r.spawnError };
    return { ...parseSshTestOutput(r.code, scrub(r.output), host), via: label };
  };
  const first = await attempt([`git@${host}`], null);
  if (first.reason === 'network' && host === 'github.com') {
    const second = await attempt(['-p', '443', 'git@ssh.github.com'], 'ssh.github.com:443');
    if (second.ok) return { ...second, message: `${second.message} (port 22 is blocked here; works over ssh.github.com:443)` };
  }
  return first;
}

// ---------------------------------------------------------------------------
// Global signing config
// ---------------------------------------------------------------------------

async function getGlobal(key: string): Promise<string | null> {
  const r = await runGit({ cwd: process.cwd(), args: ['config', '--global', '--get', key], okExitCodes: [1] }).catch(() => null);
  const v = r?.stdout.trim();
  return v ? v : null;
}

export async function readSigningConfig(): Promise<SigningConfig> {
  const [format, signingKey, gpgProgram, sign] = await Promise.all([getGlobal('gpg.format'), getGlobal('user.signingkey'), getGlobal('gpg.program'), getGlobal('commit.gpgsign')]);
  return {
    format: format === 'ssh' || format === 'x509' || format === 'openpgp' ? format : signingKey ? 'openpgp' : null,
    signingKey,
    gpgProgram,
    commitGpgSign: /^(true|yes|on|1)$/i.test(sign ?? ''),
  };
}

/** The exact `git config --global` settings for signing with a key (shown to the user before writing). */
export function signingSettings(p: { kind: 'ssh'; pubPath: string; signAll: boolean } | { kind: 'gpg'; keyId: string; gpgProgram: string | null; signAll: boolean }): [string, string][] {
  const out: [string, string][] =
    p.kind === 'ssh'
      ? [
          ['gpg.format', 'ssh'],
          ['user.signingkey', toSshPath(p.pubPath)],
        ]
      : [['gpg.format', 'openpgp'], ['user.signingkey', p.keyId], ...(p.gpgProgram ? ([['gpg.program', toSshPath(p.gpgProgram)]] as [string, string][]) : [])];
  if (p.signAll) out.push(['commit.gpgsign', 'true']);
  return out;
}

export async function writeSigningConfig(settings: [string, string][]): Promise<SigningConfig> {
  for (const [k, v] of settings) await runGit({ cwd: process.cwd(), args: ['config', '--global', k, v] });
  return readSigningConfig();
}
