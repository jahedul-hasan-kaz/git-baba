// Local GPG keys: list, generate, export. Uses git's gpg.program, then Gpg4win, then `gpg` on PATH, otherwise the
// gpg that ships with Git for Windows. Passphrases are written to gpg's stdin (--passphrase-fd 0), never on the command line.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LocalGpgKey } from '../../shared/github';
import { AppError } from './errors';

let gitExecPath: string | null = null;
let resolved: { bin: string; version: string } | null | undefined;

export function setGitExecPathForGpg(p: string): void {
  gitExecPath = p;
  resolved = undefined;
}

function run(bin: string, args: string[], input = '', timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** git's own gpg.program, so keys made here are the ones git signs with. */
function configuredGpgProgram(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['config', '--global', '--get', 'gpg.program'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

async function locate(): Promise<{ bin: string; version: string } | null> {
  if (resolved !== undefined) return resolved;
  // Order: git's gpg.program → Gpg4win → gpg on PATH → the gpg bundled with Git for Windows. On Windows the PATH
  // often finds Git's MSYS gpg first, which has a separate keyring and cannot read Windows paths.
  const candidates: string[] = [];
  const configured = await configuredGpgProgram();
  if (configured) candidates.push(configured);
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      const c = base ? path.join(base, 'GnuPG', 'bin', 'gpg.exe') : '';
      if (c && fs.existsSync(c)) candidates.push(c);
    }
  }
  candidates.push('gpg');
  if (process.platform === 'win32' && gitExecPath) {
    const c = path.resolve(gitExecPath, '..', '..', '..', 'usr', 'bin', 'gpg.exe');
    if (fs.existsSync(c)) candidates.push(c);
  }
  for (const bin of candidates) {
    try {
      const r = await run(bin, ['--version'], '', 10_000);
      if (r.code === 0) {
        resolved = { bin, version: /gpg \(GnuPG\) ([\w.-]+)/.exec(r.stdout)?.[1] ?? 'unknown' };
        return resolved;
      }
    } catch {
      // try the next candidate
    }
  }
  resolved = null;
  return null;
}

export async function gpgStatus(): Promise<{ available: boolean; version: string | null; binary: string | null }> {
  const g = await locate();
  return { available: !!g, version: g?.version ?? null, binary: g?.bin ?? null };
}

async function need(): Promise<string> {
  const g = await locate();
  if (!g) throw new AppError({ code: 'gpg-missing', title: 'GPG Not Found', message: 'Install GnuPG (Gpg4win on Windows) to create and manage GPG keys on this computer.' });
  return g.bin;
}

/** `gpgconf --kill gpg-agent` with the gpgconf next to this gpg; the next gpg call starts a fresh agent. */
async function restartAgent(bin: string): Promise<void> {
  const sibling = path.isAbsolute(bin) ? path.join(path.dirname(bin), process.platform === 'win32' ? 'gpgconf.exe' : 'gpgconf') : 'gpgconf';
  const gpgconf = path.isAbsolute(sibling) && !fs.existsSync(sibling) ? 'gpgconf' : sibling;
  await run(gpgconf, ['--kill', 'gpg-agent'], '', 15_000).catch(() => undefined);
}

/** Forget the located gpg (e.g. after gpg.program changed). */
export function resetGpgLocation(): void {
  resolved = undefined;
}

/**
 * The most useful line of gpg's stderr, rewritten into plain language for the usual failures
 * (no agent, loopback pinentry refused, cancelled pinentry). Pure — exported for tests.
 */
export function gpgFailureMessage(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^gpg: (keybox|directory|revocation|checking the trustdb|marginals needed|depth:|next trustdb|key [0-9A-F]+ marked)/i.test(l) && !/^gpg-agent\[\d+\]: (directory|gpg-agent .* started)/.test(l));
  const all = lines.join('\n');
  if (/Bad passphrase/i.test(all)) return 'Wrong passphrase.';
  if (/agent_genkey failed: No such file or directory/i.test(all)) {
    return 'gpg-agent could not write to the keyring folder (it may have been moved or deleted). Run "gpgconf --kill gpg-agent" and try again.';
  }
  if (/no agent running|can't connect to the agent|connection to the agent is in restricted mode/i.test(all)) {
    return 'gpg could not reach its gpg-agent. Make sure GnuPG (Gpg4win) is installed completely, then try again — or run "gpgconf --launch gpg-agent" once.';
  }
  if (/pinentry/i.test(all) && /loopback|not supported|not allowed/i.test(all)) {
    return 'gpg-agent refused to take the passphrase from Git Baba. Add "allow-loopback-pinentry" to gpg-agent.conf in your GnuPG folder and run "gpgconf --kill gpg-agent".';
  }
  if (/Operation cancelled|canceled/i.test(all)) return 'The passphrase prompt was cancelled.';
  if (/Bad passphrase/i.test(all)) return 'Wrong passphrase.';
  const err = [...lines].reverse().find((l) => /error|failed|invalid|not supported|no such|denied/i.test(l)) ?? lines[lines.length - 1];
  return err ? err.replace(/^gpg: /, '') : 'gpg could not create the key.';
}

const date = (secs: string) => (secs ? new Date(Number(secs) * 1000).toISOString() : null);
const ALGO: Record<string, string> = { '1': 'RSA', '17': 'DSA', '18': 'ECDH', '19': 'ECDSA', '22': 'EdDSA (ed25519)' };

/** Secret keys in the local keyring (keys this computer can sign with). */
export async function listLocalGpgKeys(): Promise<LocalGpgKey[]> {
  const bin = await need();
  const r = await run(bin, ['--batch', '--list-secret-keys', '--with-colons', '--fixed-list-mode']);
  const keys: LocalGpgKey[] = [];
  let cur: LocalGpgKey | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const f = line.split(':');
    if (f[0] === 'sec') {
      cur = { keyId: f[4], fingerprint: '', uid: '', algorithm: ALGO[f[3]] ?? `algo ${f[3]}`, createdAt: date(f[5]), expiresAt: date(f[6]) };
      keys.push(cur);
    } else if (f[0] === 'fpr' && cur && !cur.fingerprint) cur.fingerprint = f[9];
    else if (f[0] === 'uid' && cur && !cur.uid) cur.uid = f[9].replace(/\\x([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    // Subkey ("ssb") fingerprints follow; the primary's fingerprint was already taken above.
  }
  return keys;
}

/** Creates an ed25519 signing key "Name <email>". */
export async function generateGpgKey(p: { name: string; email: string; passphrase: string; expiry: '1y' | '2y' | 'never' }): Promise<LocalGpgKey> {
  const bin = await need();
  const uid = `${p.name} <${p.email}>`;
  const args = ['--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--quick-gen-key', uid, 'ed25519', 'sign', p.expiry === 'never' ? 'never' : p.expiry];
  let r = await run(bin, args, `${p.passphrase}\n`, 120_000);
  if (r.code !== 0 && /agent_genkey failed|No agent running|can't connect to the agent|IPC connect call failed/i.test(r.stderr)) {
    // A stale or wedged gpg-agent (e.g. its keyring folder was moved) — restart it once and retry.
    await restartAgent(bin);
    r = await run(bin, args, `${p.passphrase}\n`, 120_000);
  }
  if (r.code !== 0) throw new AppError({ code: 'gpg-failed', title: 'GPG Key Not Created', message: gpgFailureMessage(r.stderr), technical: `${bin} --quick-gen-key\n${r.stderr}` });
  const keys = await listLocalGpgKeys();
  const k = keys.filter((x) => x.uid === uid).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
  if (!k) throw new AppError({ code: 'gpg-failed', title: 'GPG Key Not Found', message: 'The key was created but could not be read back from the keyring.' });
  return k;
}

/** ASCII-armoured PUBLIC key (never the secret key). */
export async function exportGpgPublicKey(keyId: string): Promise<string> {
  if (!/^[0-9A-Fa-f]{8,40}$/.test(keyId)) throw new AppError({ code: 'invalid-input', title: 'Invalid Key', message: 'Unknown key id.' });
  const bin = await need();
  const r = await run(bin, ['--batch', '--armor', '--export', keyId]);
  if (r.code !== 0 || !r.stdout.includes('BEGIN PGP PUBLIC KEY BLOCK')) throw new AppError({ code: 'gpg-failed', title: 'Export Failed', message: 'gpg could not export the public key.' });
  return r.stdout;
}
