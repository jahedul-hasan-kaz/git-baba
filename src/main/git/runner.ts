import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactSecrets } from '../util/redact';

export interface GitRunOptions {
  cwd: string;
  args: string[];
  /** Extra environment variables (e.g. credential injection). Never logged. */
  env?: Record<string, string>;
  input?: string;
  /** Kills git after this long without any output (default 2 minutes). */
  timeoutMs?: number;
  maxBufferBytes?: number;
  /** Exit codes that should not be treated as failures (e.g. 1 for `diff --no-index`). */
  okExitCodes?: number[];
  /** Secret strings that must be scrubbed from any error output. */
  secrets?: string[];
  /** Whether repository hooks may run. Defaults to false. */
  runHooks?: boolean;
  /** Receives progress lines from stderr (e.g. "Receiving objects:  72%"), already redacted. */
  onProgress?: (line: string) => void;
  /** Aborting kills the git process (user pressed Cancel). */
  signal?: AbortSignal;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly command: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;

  constructor(opts: { exitCode: number | null; stderr: string; stdout: string; command: string; timedOut?: boolean; cancelled?: boolean; message?: string }) {
    super(opts.message ?? (opts.stderr.trim().split('\n').pop() || `git exited with code ${opts.exitCode}`));
    this.name = 'GitCommandError';
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.stdout = opts.stdout;
    this.command = opts.command;
    this.timedOut = !!opts.timedOut;
    this.cancelled = !!opts.cancelled;
  }
}

let gitBinary = 'git';
export function setGitBinary(bin: string): void {
  gitBinary = bin;
}

let emptyHooksDir: string | null = null;
/** An empty directory used as core.hooksPath so repository hooks never run unless enabled. */
export function getEmptyHooksDir(): string {
  if (!emptyHooksDir) {
    emptyHooksDir = path.join(os.tmpdir(), 'git-baba-no-hooks');
    fs.mkdirSync(emptyHooksDir, { recursive: true });
  }
  return emptyHooksDir;
}

/**
 * Settings forced on every git invocation. They neutralise repository-local
 * configuration that could execute programs (fsmonitor, external diff/textconv
 * drivers are disabled per command) and keep output machine-readable.
 */
export function baseConfigArgs(runHooks: boolean): string[] {
  const args = [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.quotepath=false',
    '-c', 'core.pager=cat',
    '-c', 'color.ui=never',
    '-c', 'diff.noprefix=false',
    '-c', 'diff.mnemonicPrefix=false',
    '-c', 'diff.external=',
    '-c', 'protocol.ext.allow=never',
    '-c', 'advice.detachedHead=false',
  ];
  if (!runHooks) {
    args.push('-c', `core.hooksPath=${getEmptyHooksDir()}`);
  }
  return args;
}

const STRIPPED_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_EXTERNAL_DIFF|GIT_EXEC_PATH|GIT_TRACE.*|GIT_CURL_VERBOSE|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES)$/;

function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!STRIPPED_ENV.test(k)) env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.GIT_EDITOR = 'true';
  env.GIT_MERGE_AUTOEDIT = 'no';
  env.LC_ALL = 'C';
  env.LANGUAGE = 'C';
  return { ...env, ...(extra ?? {}) };
}

export function runGit(opts: GitRunOptions): Promise<GitRunResult> {
  const args = [...baseConfigArgs(!!opts.runHooks), ...opts.args];
  const secrets = opts.secrets ?? [];
  const command = redactSecrets(`git ${opts.args.join(' ')}`, secrets);
  const maxBuffer = opts.maxBufferBytes ?? 64 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const okCodes = new Set([0, ...(opts.okExitCodes ?? [])]);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(gitBinary, args, {
        cwd: opts.cwd,
        env: buildEnv(opts.env),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new GitCommandError({ exitCode: null, stderr: String(err), stdout: '', command, message: 'Git could not be started' }));
      return;
    }

    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let killedReason: 'timeout' | 'buffer' | 'cancelled' | null = null;
    const onAbort = () => {
      killedReason = 'cancelled';
      child.kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    let progressBuffer = '';

    // An idle timeout: output (such as clone/fetch progress) keeps a slow but working operation alive.
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        killedReason = 'timeout';
        child.kill();
      }, timeoutMs);
    };
    arm();

    child.stdout.on('data', (d: Buffer) => {
      arm();
      size += d.length;
      if (size > maxBuffer) {
        killedReason = 'buffer';
        child.kill();
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      arm();
      if (opts.onProgress) {
        // Git rewrites progress lines with \r; report each completed line.
        progressBuffer += d.toString('utf8');
        const parts = progressBuffer.split(/[\r\n]/);
        progressBuffer = parts.pop() ?? '';
        for (const line of parts) if (line.trim()) opts.onProgress(redactSecrets(line.trim(), secrets));
      }
      if (errChunks.reduce((n, c) => n + c.length, 0) < 1024 * 1024) errChunks.push(d);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const message = err.code === 'ENOENT' ? 'Git is not installed or not on PATH' : 'Git could not be started';
      reject(new GitCommandError({ exitCode: null, stderr: redactSecrets(String(err.message), secrets), stdout: '', command, message }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = redactSecrets(Buffer.concat(errChunks).toString('utf8'), secrets);
      opts.signal?.removeEventListener('abort', onAbort);
      if (killedReason === 'cancelled') {
        reject(new GitCommandError({ exitCode: code, stderr, stdout: '', command, cancelled: true, message: 'Operation cancelled' }));
        return;
      }
      if (killedReason === 'timeout') {
        reject(new GitCommandError({ exitCode: code, stderr, stdout: '', command, timedOut: true, message: 'Git operation timed out' }));
        return;
      }
      if (killedReason === 'buffer') {
        reject(new GitCommandError({ exitCode: code, stderr, stdout: '', command, message: 'Git output was too large to display' }));
        return;
      }
      const exitCode = code ?? -1;
      if (!okCodes.has(exitCode)) {
        reject(new GitCommandError({ exitCode, stderr, stdout: redactSecrets(stdout, secrets), command }));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}
