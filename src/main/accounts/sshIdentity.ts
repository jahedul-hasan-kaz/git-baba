import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { redactSecrets } from '../util/redact';

export interface SshIdentityResult {
  ok: boolean;
  login: string | null;
  message: string;
}

/**
 * Interprets the output of `ssh -T git@github.com`. GitHub answers a successful key with
 * "Hi <login>! You've successfully authenticated, but GitHub does not provide shell access." and
 * exits with code 1 (no shell) — so the exit code alone means nothing; the greeting does.
 * Deploy keys answer "Hi <owner>/<repo>!" — they belong to a repository, not an account.
 */
export function parseSshWhoAmI(output: string, code: number | null): SshIdentityResult {
  const text = output.replace(/\r/g, '');
  const hi = /Hi ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(\/[A-Za-z0-9._-]+)?! You've successfully authenticated/.exec(text);
  if (hi) {
    if (hi[2]) return { ok: false, login: null, message: `This key is a deploy key of the repository ${hi[1]}${hi[2]} — it does not belong to a personal account.` };
    return { ok: true, login: hi[1], message: `The SSH key authenticates as ${hi[1]}.` };
  }
  // GitHub Enterprise / other servers sometimes greet differently ("Welcome to GitLab, @name!").
  const welcome = /Welcome to [\w .]+, @([A-Za-z0-9_.-]+)!/.exec(text);
  if (welcome) return { ok: true, login: welcome[1], message: `The SSH key authenticates as ${welcome[1]}.` };

  if (/passphrase|bad permissions|load key/i.test(text) && /key/i.test(text)) {
    return { ok: false, login: null, message: 'The key is passphrase-protected or unreadable. Load it into ssh-agent (ssh-add) first, then try again.' };
  }
  if (/Permission denied \(publickey/i.test(text)) {
    return { ok: false, login: null, message: 'GitHub did not accept any SSH key from this computer. Add your public key on GitHub (Settings → SSH keys) or load it into ssh-agent.' };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return { ok: false, login: null, message: 'The server’s host key does not match the one this computer remembers (known_hosts). Check it before continuing.' };
  }
  if (/Could not resolve hostname|Connection timed out|Connection refused|Network is unreachable|Connection closed/i.test(text)) {
    return { ok: false, login: null, message: 'Could not reach the server over SSH (port 22). Check the network or proxy.' };
  }
  if (code === null && !text.trim()) return { ok: false, login: null, message: 'SSH did not answer in time.' };
  const last = text.trim().split('\n').filter(Boolean).pop();
  return { ok: false, login: null, message: last ? `SSH said: ${last.slice(0, 300)}` : `ssh exited with code ${code}.` };
}

/** Builds the ssh arguments. A chosen key is used exclusively; otherwise ssh-agent / default keys are tried. */
export function sshWhoAmIArgs(host: string, keyPath?: string): string[] {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10'];
  if (keyPath) args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
  args.push(`git@${host}`);
  return args;
}

/** Runs `ssh -T git@host` (no shell, batch mode — never prompts) and reports who the key belongs to. */
export function sshWhoAmI(host: string, keyPath?: string): Promise<SshIdentityResult> {
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return Promise.resolve({ ok: false, login: null, message: 'Invalid host.' });
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('ssh', sshWhoAmIArgs(host, keyPath), { cwd: os.homedir(), windowsHide: true, env: { ...process.env, SSH_ASKPASS: '', DISPLAY: '' } });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, login: null, message: e.code === 'ENOENT' ? 'The ssh command is not installed (Windows: Settings → Optional features → OpenSSH Client, or install Git for Windows).' : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(parseSshWhoAmI(redactSecrets(out), code));
    });
    child.stdin.end();
  });
}
