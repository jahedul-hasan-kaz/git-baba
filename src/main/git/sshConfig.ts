import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves SSH host aliases from ~/.ssh/config, so a remote like
 * `git@work-account:org/repo.git` (with `Host work-account / HostName github.com`)
 * is recognised as a github.com repository. Read synchronously and cached by mtime;
 * the file is tiny and parseRemoteUrl is synchronous.
 */
interface HostBlock {
  patterns: string[];
  hostName: string | null;
}

let cache: { file: string; mtimeMs: number; blocks: HostBlock[] } | null = null;
let configPathOverride: string | null = null;

/** Tests only. */
export function setSshConfigPathForTests(p: string | null): void {
  configPathOverride = p;
  cache = null;
}

function configPath(): string {
  return configPathOverride ?? path.join(os.homedir(), '.ssh', 'config');
}

export function parseSshConfig(text: string): HostBlock[] {
  const blocks: HostBlock[] = [];
  let current: HostBlock | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = { patterns: value.split(/\s+/).filter(Boolean), hostName: null };
      blocks.push(current);
    } else if (key === 'match') {
      current = null; // Match blocks are conditional; skip them.
    } else if (key === 'hostname' && current && current.hostName === null) {
      current.hostName = value;
    }
  }
  return blocks;
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(value);
}

function blockMatches(b: HostBlock, host: string): boolean {
  let hit = false;
  for (const p of b.patterns) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), host)) return false;
    } else if (globMatch(p, host)) hit = true;
  }
  return hit;
}

/** First matching HostName wins, as in ssh. `%h` expands to the alias. */
export function resolveHostFromBlocks(blocks: HostBlock[], host: string): string {
  for (const b of blocks) {
    if (b.hostName && blockMatches(b, host)) return b.hostName.replace(/%h/g, host).toLowerCase();
  }
  return host;
}

function loadBlocks(): HostBlock[] {
  const file = configPath();
  try {
    const st = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.blocks;
    const blocks = parseSshConfig(fs.readFileSync(file, 'utf8'));
    cache = { file, mtimeMs: st.mtimeMs, blocks };
    return blocks;
  } catch {
    return [];
  }
}

/** The real host name behind an SSH alias (unchanged when there is no alias). */
export function resolveSshHost(host: string): string {
  const real = resolveHostFromBlocks(loadBlocks(), host);
  if (real !== host) return real;
  // Common alias convention when the config is elsewhere: "github.com-work", "github.com_personal".
  if (/^github\.com[-_][a-z0-9._-]+$/i.test(host)) return 'github.com';
  return host;
}
