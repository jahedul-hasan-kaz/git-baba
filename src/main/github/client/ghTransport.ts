import { spawn } from 'node:child_process';
import type { FetchLike } from '../GitHubService';

const TIMEOUT_MS = 60_000;
const MAX_BYTES = 64 * 1024 * 1024;

/** Splits `gh api --include` output into status line, headers and body. */
export function parseIncluded(raw: Buffer): { status: number; statusText: string; headers: Headers; body: Buffer } | null {
  const text = raw.toString('latin1');
  const m = /^HTTP\/[\d.]+ (\d{3}) ?([^\r\n]*)\r?\n/.exec(text);
  if (!m) return null;
  let sep = text.indexOf('\r\n\r\n');
  let sepLen = 4;
  const lf = text.indexOf('\n\n');
  if (sep === -1 || (lf !== -1 && lf < sep)) {
    sep = lf;
    sepLen = 2;
  }
  const head = sep === -1 ? text : text.slice(0, sep);
  const headers = new Headers();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) {
      try {
        headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
      } catch {
        // ignore header names fetch does not accept
      }
    }
  }
  const body = sep === -1 ? Buffer.alloc(0) : raw.subarray(sep + sepLen);
  // gh follows redirects and can print every hop's headers; the last block is the one the body belongs to.
  if (/^HTTP\/[\d.]+ \d{3}/.test(body.subarray(0, 16).toString('latin1'))) return parseIncluded(body) ?? { status: Number(m[1]), statusText: m[2], headers, body };
  return { status: Number(m[1]), statusText: m[2], headers, body };
}

/**
 * A fetch() that sends GitHub API requests through the user's own GitHub CLI login (`gh api`).
 * Git Baba never sees that token: gh adds it itself. Lets every GitHub feature work when the
 * signed-in account token cannot read the repository (or nobody is signed in).
 */
export function ghFetch(apiBase: string, cwd: string): FetchLike {
  const base = new URL(apiBase);
  const host = base.host === 'api.github.com' ? null : base.host;
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      if (u.host !== base.host) return reject(new Error('Refusing to call another host through the GitHub CLI.'));
      const isGraphql = /\/graphql$/.test(u.pathname);
      const prefix = base.pathname.replace(/\/$/, '');
      const endpoint = isGraphql ? 'graphql' : `${u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname}${u.search}`.replace(/^\//, '');
      const method = (init.method ?? 'GET').toUpperCase();
      const h = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
      const args = ['api', '--include', '--method', method];
      if (host) args.push('--hostname', host);
      for (const name of ['accept', 'content-type', 'x-github-api-version']) {
        const v = h.get(name);
        if (v) args.push('-H', `${name}: ${v}`);
      }
      const body = typeof init.body === 'string' ? init.body : null;
      if (body !== null) args.push('--input', '-');
      args.push(endpoint);

      const chunks: Buffer[] = [];
      let size = 0;
      let errText = '';
      const child = spawn('gh', args, { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: '', PAGER: '' } });
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => {
        size += d.length;
        if (size <= MAX_BYTES) chunks.push(d);
      });
      child.stderr.on('data', (d) => (errText += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        const parsed = parseIncluded(Buffer.concat(chunks));
        if (!parsed) return reject(new Error(errText.trim().split('\n').pop() || 'The GitHub CLI returned no response.'));
        const noBody = [204, 205, 304].includes(parsed.status);
        resolve(new Response(noBody ? null : new Uint8Array(parsed.body), { status: parsed.status, statusText: parsed.statusText, headers: parsed.headers }));
      });
      child.stdin.end(body ?? '');
    });
}
