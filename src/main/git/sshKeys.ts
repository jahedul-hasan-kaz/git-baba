import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppError } from './errors';

export interface SshKeyDetails {
  encrypted: boolean;
  fingerprint: string | null;
}

const MAX_KEY_FILE = 64 * 1024;

/** Reads a private key file just enough to tell whether it is passphrase-protected (no decryption). */
export function inspectSshKey(file: string): SshKeyDetails {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new AppError({ code: 'ssh-key-missing', title: 'SSH Key Not Found', message: `The SSH key file ${file} does not exist anymore. Choose it again.`, actions: ['review-auth'] });
  }
  if (!stat.isFile() || stat.size > MAX_KEY_FILE) {
    throw new AppError({ code: 'ssh-key-invalid', title: 'Not an SSH Private Key', message: 'Choose your private key file (for example ~/.ssh/id_ed25519), not the .pub file.' });
  }
  const text = fs.readFileSync(file, 'utf8');
  if (/^PuTTY-User-Key-File/m.test(text)) {
    throw new AppError({
      code: 'ssh-key-putty',
      title: 'PuTTY Key Not Supported',
      message: 'This is a PuTTY (.ppk) key. Export it in PuTTYgen via Conversions → Export OpenSSH key, then choose the exported file.',
    });
  }
  const openssh = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (openssh) return parseOpenSshKey(Buffer.from(openssh[1].replace(/\s+/g, ''), 'base64'));
  if (/-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/.test(text)) {
    return { encrypted: /Proc-Type:\s*4,ENCRYPTED/.test(text), fingerprint: null };
  }
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) return { encrypted: true, fingerprint: null };
  throw new AppError({ code: 'ssh-key-invalid', title: 'Not an SSH Private Key', message: 'Choose your private key file (for example ~/.ssh/id_ed25519), not the .pub file.' });
}

/** openssh-key-v1: magic, ciphername, kdfname, kdfoptions, nkeys, public key blob, … */
export function parseOpenSshKey(buf: Buffer): SshKeyDetails {
  const magic = 'openssh-key-v1\0';
  if (buf.subarray(0, magic.length).toString('latin1') !== magic) {
    throw new AppError({ code: 'ssh-key-invalid', title: 'Invalid SSH Key', message: 'The SSH key file is damaged or in an unknown format.' });
  }
  let off = magic.length;
  const readString = (): Buffer => {
    const len = buf.readUInt32BE(off);
    off += 4;
    const s = buf.subarray(off, off + len);
    off += len;
    return s;
  };
  try {
    const cipher = readString().toString('latin1');
    readString(); // kdfname
    readString(); // kdfoptions
    off += 4; // number of keys
    const pub = readString();
    const fingerprint = `SHA256:${crypto.createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')}`;
    return { encrypted: cipher !== 'none', fingerprint };
  } catch {
    throw new AppError({ code: 'ssh-key-invalid', title: 'Invalid SSH Key', message: 'The SSH key file is damaged or in an unknown format.' });
  }
}

// ---------------------------------------------------------------------------
// Public keys → matching private key
// ---------------------------------------------------------------------------

export interface ParsedPublicKey {
  type: string;
  fingerprint: string;
  comment: string;
}

const KEY_TYPES = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-dss)$/;

function fingerprintOf(blob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Parses an OpenSSH public key line such as "ssh-ed25519 AAAAC3Nz… you@host". */
export function parsePublicKey(text: string): ParsedPublicKey {
  const line = text.trim().split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? '';
  const [type, b64, ...rest] = line.trim().split(/\s+/);
  const invalid = () =>
    new AppError({
      code: 'ssh-public-key-invalid',
      title: 'Invalid Public Key',
      message: 'Paste a public key line such as "ssh-ed25519 AAAAC3Nz… you@example.com", or load your .pub file.',
      actions: ['review-auth'],
    });
  if (!type || !b64 || !KEY_TYPES.test(type) || !/^[A-Za-z0-9+/]+={0,3}$/.test(b64)) {
    if (/PRIVATE KEY/.test(text)) {
      throw new AppError({ code: 'ssh-private-pasted', title: 'This Is a Private Key', message: 'Never paste a private key. Paste the public key (the contents of the .pub file) instead.' });
    }
    throw invalid();
  }
  const blob = Buffer.from(b64, 'base64');
  // The blob starts with the key type as an SSH string; make sure it matches.
  if (blob.length < 4 || blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('latin1') !== type) throw invalid();
  return { type, fingerprint: fingerprintOf(blob), comment: rest.join(' ') };
}

/** Fingerprint of a private key file: from the key itself (OpenSSH format) or its .pub companion. */
function privateKeyFingerprint(file: string): string | null {
  try {
    const d = inspectSshKey(file);
    if (d.fingerprint) return d.fingerprint;
  } catch {
    return null;
  }
  try {
    return parsePublicKey(fs.readFileSync(`${file}.pub`, 'utf8')).fingerprint;
  } catch {
    return null;
  }
}

/**
 * Finds the private key on this computer that belongs to a public key. Looks next to the
 * .pub file first (if one was loaded), then in ~/.ssh. Files are only read, never modified.
 */
export function findPrivateKeyFor(fingerprint: string, opts: { pubFilePath?: string; sshDir?: string } = {}): string | null {
  const candidates: string[] = [];
  if (opts.pubFilePath && opts.pubFilePath.endsWith('.pub')) candidates.push(opts.pubFilePath.slice(0, -4));
  const dir = opts.sshDir ?? path.join(os.homedir(), '.ssh');
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.pub') || /^(known_hosts|config|authorized_keys|environment)/.test(name)) continue;
      candidates.push(path.join(dir, name));
    }
  } catch {
    // no ~/.ssh
  }
  for (const file of candidates) {
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    if (privateKeyFingerprint(file) === fingerprint) return file;
  }
  return null;
}

/** The ssh-keygen that ships with Git for Windows (same OpenSSH build git uses), else the one on PATH. */
export function sshKeygenBinary(gitExecPath?: string): string {
  if (process.platform === 'win32' && gitExecPath) {
    const candidate = path.resolve(gitExecPath, '..', '..', '..', 'usr', 'bin', 'ssh-keygen.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'ssh-keygen';
}

let configuredKeygen = 'ssh-keygen';
export function setSshKeygenBinary(bin: string): void {
  configuredKeygen = bin;
}
export function getSshKeygenBinary(): string {
  return configuredKeygen;
}

/** Checks a passphrase by asking ssh-keygen to derive the public key (decrypts locally, no network). */
export function verifySshPassphrase(keyPath: string, passphrase: string, keygen = configuredKeygen): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(keygen, ['-y', '-f', toSshPath(keyPath)], {
      env: { ...process.env, ...passphraseEnv(passphrase) },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(true); // ssh-keygen unavailable: let the real operation report problems
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export type SshKeyType = 'ed25519' | 'rsa' | 'ecdsa';

/** Default ~/.ssh folder. */
export function sshDirectory(): string {
  return path.join(os.homedir(), '.ssh');
}

/** Public keys found in ~/.ssh with the private key that sits next to each (if any). */
export function listLocalPublicKeys(dir = sshDirectory()): { pubPath: string; privatePath: string | null; publicKey: string; parsed: ParsedPublicKey }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.pub'));
  } catch {
    return [];
  }
  const out: { pubPath: string; privatePath: string | null; publicKey: string; parsed: ParsedPublicKey }[] = [];
  for (const name of names.sort()) {
    const pubPath = path.join(dir, name);
    try {
      const st = fs.statSync(pubPath);
      if (!st.isFile() || st.size > 16_384) continue;
      const publicKey = fs.readFileSync(pubPath, 'utf8').trim();
      const parsed = parsePublicKey(publicKey);
      const priv = pubPath.slice(0, -4);
      const privatePath = fs.existsSync(priv) && privateKeyFingerprint(priv) === parsed.fingerprint ? priv : null;
      out.push({ pubPath, privatePath, publicKey: publicKey.split(/\r?\n/)[0], parsed });
    } catch {
      // not a public key — skip
    }
  }
  return out;
}

/**
 * Generates a new key pair with ssh-keygen. The passphrase reaches ssh-keygen through the
 * askpass helper (environment of that one process) — never on the command line. Existing
 * files are never overwritten.
 */
export function generateSshKey(
  opts: { type: SshKeyType; file: string; comment: string; passphrase: string },
  keygen = configuredKeygen,
): Promise<void> {
  if (fs.existsSync(opts.file) || fs.existsSync(`${opts.file}.pub`)) {
    return Promise.reject(new AppError({ code: 'ssh-key-exists', title: 'Key File Already Exists', message: `${path.basename(opts.file)} already exists. Choose another file name — existing keys are never overwritten.` }));
  }
  fs.mkdirSync(path.dirname(opts.file), { recursive: true, mode: 0o700 });
  const args = ['-q', '-t', opts.type];
  if (opts.type === 'rsa') args.push('-b', '4096');
  if (opts.type === 'ecdsa') args.push('-b', '521');
  args.push('-C', opts.comment, '-f', toSshPath(opts.file));
  if (!opts.passphrase) args.push('-N', '');
  return new Promise((resolve, reject) => {
    const child = spawn(keygen, args, {
      env: { ...process.env, ...(opts.passphrase ? passphraseEnv(opts.passphrase) : {}) },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    const fail = (detail: string) =>
      reject(new AppError({ code: 'ssh-keygen-failed', title: 'Could Not Generate the Key', message: 'ssh-keygen did not create the key.', technical: detail.replace(opts.passphrase || '\0', '***') }));
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(e.message);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(opts.file) && fs.existsSync(`${opts.file}.pub`)) resolve();
      else fail(stderr || `exit code ${code}`);
    });
  });
}

let askpassScript: string | null = null;

/**
 * A tiny askpass helper that answers ssh/ssh-keygen *passphrase* prompts from an
 * environment variable of that single git process. It contains no secret itself and
 * refuses every other prompt (e.g. unknown host keys), which then fail safely.
 */
export function getAskpassScript(): string {
  if (askpassScript && fs.existsSync(askpassScript)) return askpassScript;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-baba-askpass-'));
  const file = path.join(dir, 'askpass.sh');
  fs.writeFileSync(file, '#!/bin/sh\ncase "$1" in\n  *assphrase*) printf \'%s\\n\' "$GG_SSH_PASSPHRASE" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o700 });
  askpassScript = file;
  return file;
}

/** Forward slashes work for both the MSYS ssh shipped with Git for Windows and POSIX ssh. */
export function toSshPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Single-quote a value for the POSIX shell git uses to run GIT_SSH_COMMAND. */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Environment that makes ssh / ssh-keygen read the passphrase from our askpass helper. */
export function passphraseEnv(passphrase: string): Record<string, string> {
  return {
    SSH_ASKPASS: toSshPath(getAskpassScript()),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
    GG_SSH_PASSPHRASE: passphrase,
  };
}
