import { spawn } from 'node:child_process';
import { AppError } from '../git/errors';
import { redactSecrets } from '../util/redact';

export interface CliPrInput {
  host: string;
  owner: string;
  name: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  reviewers: string[];
  assignees: string[];
  labels: string[];
}

/**
 * Creates a pull request with the user's own GitHub CLI login (`gh pr create`). gh keeps its
 * token itself — Git Baba never reads it. No shell is involved; every value is a separate argument
 * and the description goes through stdin.
 */
export function createPrWithCli(cwd: string, i: CliPrInput): Promise<{ number: number; url: string }> {
  const repo = i.host === 'github.com' ? `${i.owner}/${i.name}` : `${i.host}/${i.owner}/${i.name}`;
  const args = ['pr', 'create', '--repo', repo, '--base', i.base, '--head', i.head, `--title=${i.title}`, '--body-file', '-'];
  if (i.draft) args.push('--draft');
  for (const r of i.reviewers) args.push('--reviewer', r);
  for (const a of i.assignees) args.push('--assignee', a);
  for (const l of i.labels) args.push(`--label=${l}`);

  return new Promise((resolve, reject) => {
    let out = '';
    let errOut = '';
    const child = spawn('gh', args, { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new AppError({ code: 'gh-missing', title: 'GitHub CLI Not Found', message: 'The gh command is not installed or not on PATH. Install it from cli.github.com and run "gh auth login".' })
          : new AppError({ code: 'gh-failed', title: 'GitHub CLI Failed', message: e.message }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const url = /https?:\/\/\S+\/pull\/(\d+)/.exec(out);
      if (code === 0 && url) return resolve({ number: Number(url[1]), url: url[0] });
      const detail = redactSecrets(errOut.trim() || out.trim()).slice(0, 2000);
      const notAuthed = /gh auth login|not logged in|authentication/i.test(detail);
      reject(
        new AppError({
          code: notAuthed ? 'gh-auth' : 'gh-failed',
          title: notAuthed ? 'GitHub CLI Not Signed In' : 'GitHub CLI Could Not Create the Pull Request',
          message: notAuthed ? 'Run "gh auth login" in a terminal, then try again.' : detail.split('\n').pop() || `gh exited with code ${code}.`,
          technical: detail,
        }),
      );
    });
    child.stdin.end(i.body);
  });
}

export function runGh(args: string[], cwd: string): Promise<{ code: number | null; out: string } | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('gh', args, { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: redactSecrets(out) });
    });
    child.stdin.end();
  });
}

/** Whether the GitHub CLI is installed and signed in to `host` (never reads its token). */
export async function cliStatus(cwd: string, host: string): Promise<{ installed: boolean; loggedIn: boolean; login: string | null; version: string | null }> {
  const v = await runGh(['--version'], cwd);
  if (!v || v.code !== 0) return { installed: false, loggedIn: false, login: null, version: null };
  const version = /gh version ([\w.-]+)/.exec(v.out)?.[1] ?? null;
  const s = await runGh(['auth', 'status', '--hostname', host], cwd);
  const login = s ? (/account (\S+)/.exec(s.out)?.[1] ?? /as (\S+)/.exec(s.out)?.[1] ?? null) : null;
  return { installed: true, loggedIn: s?.code === 0, login: login?.replace(/[()]/g, '') ?? null, version };
}

/** Builds the `gh pr …` arguments for one allow-listed action. Values are separate arguments; bodies go through stdin. */
export function prCliArgs(repo: string, number: number, a: { action: string; title?: string; method?: string; deleteBranch?: boolean; hasBody: boolean }): string[] {
  const n = String(number);
  const body = a.hasBody ? ['--body-file', '-'] : [];
  switch (a.action) {
    case 'checkout':
      return ['pr', 'checkout', n, '--repo', repo];
    case 'comment':
      return ['pr', 'comment', n, '--repo', repo, '--body-file', '-'];
    case 'approve':
      return ['pr', 'review', n, '--repo', repo, '--approve', ...body];
    case 'request-changes':
      return ['pr', 'review', n, '--repo', repo, '--request-changes', '--body-file', '-'];
    case 'review-comment':
      return ['pr', 'review', n, '--repo', repo, '--comment', '--body-file', '-'];
    case 'merge':
      return ['pr', 'merge', n, '--repo', repo, `--${a.method ?? 'merge'}`, ...(a.deleteBranch ? ['--delete-branch'] : [])];
    case 'ready':
      return ['pr', 'ready', n, '--repo', repo];
    case 'draft':
      return ['pr', 'ready', n, '--repo', repo, '--undo'];
    case 'close':
      return ['pr', 'close', n, '--repo', repo];
    case 'reopen':
      return ['pr', 'reopen', n, '--repo', repo];
    case 'edit-title':
      return ['pr', 'edit', n, '--repo', repo, `--title=${a.title ?? ''}`];
    default:
      throw new AppError({ code: 'invalid', title: 'Unknown Action', message: 'This GitHub CLI action is not supported.' });
  }
}

/** Runs gh with stdin input; rejects with a friendly error. */
export function runGhChecked(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let errOut = '';
    const child = spawn('gh', args, { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new AppError({ code: 'gh-missing', title: 'GitHub CLI Not Found', message: 'Install the GitHub CLI from cli.github.com and run "gh auth login".' }) : new AppError({ code: 'gh-failed', title: 'GitHub CLI Failed', message: e.message }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Success: stdout is data (e.g. JSON) and is returned whole — never merged with stderr or shortened.
      if (code === 0) return resolve(out);
      const text = redactSecrets(`${out}\n${errOut}`.trim()).slice(0, 4000);
      const notAuthed = /gh auth login|not logged in/i.test(text);
      reject(new AppError({ code: notAuthed ? 'gh-auth' : 'gh-failed', title: notAuthed ? 'GitHub CLI Not Signed In' : 'GitHub CLI Reported a Problem', message: notAuthed ? 'Run "gh auth login" in a terminal, then try again.' : text.split('\n').filter(Boolean).pop() ?? `gh exited with code ${code}.`, technical: text }));
    });
    child.stdin.end(input);
  });
}

// ---------------------------------------------------------------------------
// Browser sign-in (GitHub device flow, run by the GitHub CLI)
// ---------------------------------------------------------------------------

interface LoginRun {
  child: ReturnType<typeof spawn>;
  done: Promise<{ ok: boolean; message: string }>;
}
const logins = new Map<string, LoginRun>();

/**
 * Starts `gh auth login --web`: GitHub shows a one-time code; the user enters it on github.com and
 * signs in there with password and 2FA/OTP. Git Baba only relays the code — it never sees the password.
 */
export function startBrowserLogin(cwd: string, host: string): Promise<{ loginId: string; code: string; url: string }> {
  const child = spawn('gh', ['auth', 'login', '--hostname', host, '--web', '--git-protocol', 'https', '--skip-ssh-key'], {
    cwd,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '', BROWSER: 'none' },
  });
  const loginId = `login-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let text = '';
  const done = new Promise<{ ok: boolean; message: string }>((resolve) => {
    child.on('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, message: e.code === 'ENOENT' ? 'The GitHub CLI is not installed.' : e.message }));
    child.on('close', (code) => {
      logins.delete(loginId);
      resolve({ ok: code === 0, message: redactSecrets(text.trim().split('\n').filter(Boolean).pop() ?? '') });
    });
  });
  logins.set(loginId, { child, done });
  setTimeout(() => child.kill(), 15 * 60_000).unref?.();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError({ code: 'gh-failed', title: 'Sign-In Did Not Start', message: 'GitHub did not provide a sign-in code. Check your connection and try again.' })), 30_000);
    const onData = (d: Buffer) => {
      text += d.toString();
      // gh may wait for Enter before continuing; the browser is opened by Git Baba instead.
      if (/press enter/i.test(text)) child.stdin?.write('\n');
      const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text)?.[1];
      if (code) {
        clearTimeout(timer);
        const url = /(https:\/\/\S+\/login\/device)/.exec(text)?.[1] ?? `https://${host}/login/device`;
        resolve({ loginId, code, url });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    void done.then((r) => {
      clearTimeout(timer);
      if (!r.ok) reject(new AppError({ code: 'gh-failed', title: 'Sign-In Did Not Start', message: r.message || 'The GitHub CLI could not start the browser sign-in.' }));
    });
  });
}

export async function waitBrowserLogin(loginId: string): Promise<{ ok: boolean; message: string }> {
  const run = logins.get(loginId);
  if (!run) return { ok: false, message: 'This sign-in is no longer running. Start again.' };
  return run.done;
}

export function cancelBrowserLogin(loginId: string): void {
  logins.get(loginId)?.child.kill();
}

// ---------------------------------------------------------------------------
// Accounts: which logins gh holds, and (main process only) the token for one of them
// ---------------------------------------------------------------------------

/** Parses `gh auth status --hostname <host>` output into the signed-in logins and the active one. */
export function parseGhAuthStatus(out: string): { logins: string[]; active: string | null } {
  const logins: string[] = [];
  let active: string | null = null;
  const lines = out.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /Logged in to \S+ (?:account|as) ([A-Za-z0-9-]+)/.exec(lines[i]);
    if (!m) continue;
    if (!logins.includes(m[1])) logins.push(m[1]);
    // Newer gh prints "- Active account: true" on a following line; older versions have a single account.
    const next = lines.slice(i + 1, i + 4).join('\n');
    if (/Active account: true/i.test(next)) active = m[1];
  }
  if (!active && logins.length === 1) active = logins[0];
  return { logins, active };
}

export async function cliAccounts(cwd: string, host: string): Promise<{ installed: boolean; version: string | null; logins: string[]; active: string | null }> {
  const v = await runGh(['--version'], cwd);
  if (!v || v.code !== 0) return { installed: false, version: null, logins: [], active: null };
  const version = /gh version ([\w.-]+)/.exec(v.out)?.[1] ?? null;
  const s = await runGh(['auth', 'status', '--hostname', host], cwd);
  return { installed: true, version, ...(s ? parseGhAuthStatus(s.out) : { logins: [], active: null }) };
}

/**
 * Reads the token gh holds for `host` (and `login`, when gh supports several accounts). MAIN PROCESS ONLY —
 * the value must never be sent to the renderer or logged. Returns null when gh has none.
 */
export function ghAuthToken(cwd: string, host: string, login?: string): Promise<string | null> {
  const run = (args: string[]) =>
    new Promise<string | null>((resolve) => {
      let out = '';
      const child = spawn('gh', args, { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const t = out.trim();
        resolve(code === 0 && t && !/\s/.test(t) && t.length <= 512 ? t : null);
      });
      child.stdin.end();
    });
  return (async () => {
    if (login) {
      const t = await run(['auth', 'token', '--hostname', host, '--user', login]);
      if (t) return t;
    }
    // Older gh (no --user): the active account's token; the caller verifies whose it is.
    return run(['auth', 'token', '--hostname', host]);
  })();
}
