import type { AuthMethod, RemoteProtocol } from '../../shared/types';
import { resolveSshHost } from './sshConfig';

export interface ParsedRemote {
  protocol: RemoteProtocol;
  host: string | null;
  owner: string | null;
  repo: string | null;
  isGitHub: boolean;
  hasEmbeddedCredentials: boolean;
  /** scheme://host/ prefix, used to scope injected credentials to this host only. */
  httpPrefix: string | null;
}

const SCP_LIKE = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/;

function splitOwnerRepo(p: string): { owner: string | null; repo: string | null } {
  const parts = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (parts.length < 2) return { owner: null, repo: null };
  return { owner: parts[parts.length - 2] || null, repo: parts[parts.length - 1] || null };
}

export function parseRemoteUrl(url: string, githubHosts: string[] = ['github.com']): ParsedRemote {
  const trimmed = url.trim();
  const base: ParsedRemote = {
    protocol: 'unknown',
    host: null,
    owner: null,
    repo: null,
    isGitHub: false,
    hasEmbeddedCredentials: false,
    httpPrefix: null,
  };

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      return base;
    }
    const scheme = u.protocol.replace(':', '').toLowerCase();
    const host = u.hostname.toLowerCase();
    const { owner, repo } = splitOwnerRepo(decodeURIComponent(u.pathname));
    const isGitHub = githubHosts.includes(host);
    if (scheme === 'https' || scheme === 'http') {
      return {
        protocol: scheme,
        host,
        owner,
        repo,
        isGitHub,
        hasEmbeddedCredentials: !!(u.username || u.password),
        httpPrefix: `${scheme}://${u.host}/`,
      };
    }
    if (scheme === 'ssh' || scheme === 'git+ssh') {
      const real = resolveSshHost(host);
      return { ...base, protocol: 'ssh', host: real, owner, repo, isGitHub: githubHosts.includes(real) };
    }
    if (scheme === 'file') {
      return { ...base, protocol: 'local' };
    }
    return { ...base, host };
  }

  // Windows drive paths (C:\repo or C:/repo) look SCP-like; treat them as local first.
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return { ...base, protocol: 'local' };
  }

  const scp = SCP_LIKE.exec(trimmed);
  if (scp) {
    // SSH host aliases from ~/.ssh/config (e.g. "work-account" -> github.com).
    const host = resolveSshHost(scp[2].toLowerCase());
    const { owner, repo } = splitOwnerRepo(scp[3]);
    return { ...base, protocol: 'ssh', host, owner, repo, isGitHub: githubHosts.includes(host) };
  }
  return base;
}

/**
 * Validates a remote URL before it is written to git config or passed to clone.
 * Rejects transport helpers that can execute commands (ext::, fd::) and anything
 * that could be parsed as a command-line option.
 */
export function validateRemoteUrl(url: string): { ok: true } | { ok: false; reason: string } {
  const u = url.trim();
  if (!u) return { ok: false, reason: 'Remote URL is required' };
  if (u.length > 2048) return { ok: false, reason: 'Remote URL is too long' };
  if (u.startsWith('-')) return { ok: false, reason: 'Remote URL may not start with "-"' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(u)) return { ok: false, reason: 'Remote URL may not contain control characters' };
  if (/^[a-zA-Z0-9+.-]+::/.test(u)) return { ok: false, reason: 'Remote helper URLs (such as ext::) are not allowed' };
  const parsed = parseRemoteUrl(u);
  // Folder paths may contain spaces ("C:\My Projects\repo.git"); network URLs may not.
  if (/\s/.test(u) && parsed.protocol !== 'local') return { ok: false, reason: 'Remote URL may not contain spaces' };
  if (parsed.protocol === 'unknown') return { ok: false, reason: 'Only https://, ssh://, git@host:path and local paths are supported' };
  if (parsed.hasEmbeddedCredentials) {
    return { ok: false, reason: 'Remote URLs must not contain credentials. The app asks for authentication separately for each operation.' };
  }
  return { ok: true };
}

/**
 * For a GitHub SSH remote, the equivalent HTTPS URL. Token-based methods use it for
 * that single operation; the configured remote URL is never changed.
 */
export function httpsEquivalent(parsed: ParsedRemote): { url: string; httpPrefix: string } | null {
  if (parsed.protocol !== 'ssh' || !parsed.isGitHub || !parsed.host || !parsed.owner || !parsed.repo) return null;
  return { url: `https://${parsed.host}/${parsed.owner}/${parsed.repo}.git`, httpPrefix: `https://${parsed.host}/` };
}

/** For a GitHub HTTPS remote, the equivalent SSH URL (used by the SSH method for that single operation). */
export function sshEquivalent(parsed: ParsedRemote): string | null {
  if ((parsed.protocol !== 'https' && parsed.protocol !== 'http') || !parsed.isGitHub || !parsed.host || !parsed.owner || !parsed.repo) return null;
  return `git@${parsed.host}:${parsed.owner}/${parsed.repo}.git`;
}

/**
 * Authentication methods that can actually work for a remote, in display order:
 * Git identity only (existing setup) → SSH → GitHub App token → PAT.
 * GitHub accepts every method for the same repository (switching between its SSH and HTTPS URL).
 */
export function applicableAuthMethods(parsed: ParsedRemote): AuthMethod[] {
  const github = parsed.isGitHub && !!parsed.owner && !!parsed.repo;
  switch (parsed.protocol) {
    case 'https':
    case 'http':
      return github ? ['system', 'ssh', 'github-app', 'pat'] : ['system', 'pat'];
    case 'ssh':
      return github ? ['system', 'ssh', 'github-app', 'pat'] : ['system', 'ssh'];
    case 'local':
      return ['none'];
    default:
      return ['system'];
  }
}
