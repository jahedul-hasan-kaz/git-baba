import * as path from 'node:path';
import type { AuthInput, AuthMethod, AuthOption, RepoRecord, SshKeyInput } from '../../shared/types';
import type { ResolvedGitAuth } from '../git/credentials';
import { AppError } from '../git/errors';
import { applicableAuthMethods, httpsEquivalent, parseRemoteUrl, sshEquivalent, type ParsedRemote } from '../git/remoteUrl';
import { inspectSshKey, verifySshPassphrase } from '../git/sshKeys';
import type { SecretStore } from '../repositories/SecretStore';
import type { EphemeralVault } from '../security/EphemeralVault';
import type { TokenRegistry } from '../security/TokenRegistry';
import { maskToken } from '../util/redact';
import { apiBaseForHost, GitHubService, parsePrivateKey, validateApiBaseUrl } from './GitHubService';

export type AuthPurpose = 'push' | 'fetch' | 'clone' | 'pr';

export interface ResolvedAuth {
  git: ResolvedGitAuth;
  /** Bearer token for GitHub REST calls (PR creation). */
  apiToken?: string;
  /** Set when a token method is used with an SSH remote: run this one operation against the HTTPS URL. */
  transportUrl?: string;
  /** Installation id discovered while generating a token (so it can be remembered). */
  detectedInstallationId?: string;
  /** SSH key file used (so its path can be remembered). */
  sshKeyPath?: string;
  /** Human-readable description for history/results — never contains the secret. */
  description: string;
  secrets: string[];
  /** Revokes generated tokens and drops references. Always call in `finally`. */
  cleanup: () => Promise<void>;
  /**
   * Set for GitHub App installation tokens: every such token is revoked after the operation.
   * `revoked` is null until cleanup ran, then true/false (false = GitHub could not be reached).
   */
  revocation?: { revoked: boolean | null };
}

/** Revokes an installation token, retrying transient failures. Returns true when GitHub confirmed it. */
export async function revokeWithRetry(gh: GitHubService, token: string, attempts = 3, delayMs = 500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await gh.revokeInstallationToken(token)) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
  }
  return false;
}

export interface AuthDeps {
  secrets: SecretStore;
  vault: EphemeralVault;
  githubFor: (apiBase: string) => GitHubService;
  /** Session list of installation tokens shown on the token page (optional in tests). */
  tokens?: TokenRegistry;
}

const METHOD_TEXT: Record<AuthMethod, { label: string; description: string }> = {
  pat: { label: 'Git Credential / PAT', description: 'Personal access token (or password) entered for this operation only.' },
  'github-app': {
    label: 'GitHub App Installation Token',
    description: 'Generate a short-lived token from your GitHub App (scoped to this repository, revoked right after use), or use an installation token you already have.',
  },
  ssh: { label: 'SSH', description: 'Provide your SSH public key (paste it or load the .pub file). The app finds the matching private key on this computer and asks for its passphrase.' },
  system: {
    label: 'Git identity only',
    description: "Push directly with this computer's existing Git setup (ssh-agent / ~/.ssh keys for SSH, Git Credential Manager for HTTPS). The app does not ask for any credentials.",
  },
  none: { label: 'No authentication (local remote)', description: 'The remote is a folder on this computer.' },
};

export function describeAuthOptions(repo: RepoRecord, remoteUrl: string | null, purpose: AuthPurpose, saved: { pat: boolean; githubAppKey: boolean }): AuthOption[] {
  const parsed = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
  let methods: AuthMethod[] = parsed ? applicableAuthMethods(parsed) : ['pat', 'ssh', 'system'];
  if (purpose === 'pr') {
    methods = parsed?.isGitHub ? ['github-app', 'pat'] : [];
  }
  // "Git identity only" is offered as an explicit, per-operation choice; it is never used unless selected.
  const https = parsed ? httpsEquivalent(parsed) : null;
  const sshUrl = parsed ? sshEquivalent(parsed) : null;
  return methods.map((m) => ({
    method: m,
    ...METHOD_TEXT[m],
    hasSaved: repo.settings.allowSavedCredentials && ((m === 'pat' && saved.pat) || (m === 'github-app' && saved.githubAppKey)),
    ...(https && purpose !== 'pr' && (m === 'pat' || m === 'github-app') ? { viaHttps: https.url } : {}),
    ...(sshUrl && m === 'ssh' ? { viaSsh: sshUrl } : {}),
  }));
}

function authError(message: string): AppError {
  return new AppError({ code: 'auth-input', title: 'Authentication Required', message, actions: ['review-auth'] });
}

/** HTTPS transport for token methods; SSH GitHub remotes are mapped to their HTTPS equivalent. */
function httpTransport(parsed: ParsedRemote): { httpPrefix: string; transportUrl?: string } {
  if (parsed.httpPrefix) return { httpPrefix: parsed.httpPrefix };
  const https = httpsEquivalent(parsed);
  if (https) return { httpPrefix: https.httpPrefix, transportUrl: https.url };
  throw new AppError({ code: 'auth-not-applicable', title: 'HTTPS Remote Required', message: 'Token authentication only works with GitHub or https:// remotes.' });
}

/** Resolves the SSH key file the user chose (dialog handle or the path remembered for this repo). */
export function resolveSshKeyFile(deps: AuthDeps, repo: RepoRecord, input: SshKeyInput): { keyPath: string; encrypted: boolean; fingerprint: string | null } | null {
  if (input.keySource !== 'file') return null;
  const keyPath = input.keyHandle === 'saved' ? repo.settings.sshKeyPath : input.keyHandle ? deps.vault.get(input.keyHandle, 'ssh-key-path') : null;
  if (!keyPath) throw authError('Provide your SSH public key so the matching private key can be found.');
  const details = inspectSshKey(keyPath);
  if (details.encrypted && !input.passphrase) throw authError(`The SSH key ${path.basename(keyPath)} is protected by a passphrase. Enter the passphrase.`);
  return { keyPath, ...details };
}

/**
 * Resolves the user's per-operation choice into credentials for exactly one
 * operation on exactly one repository.
 */
export async function resolveAuth(
  deps: AuthDeps,
  repo: RepoRecord,
  remoteUrl: string,
  input: AuthInput,
  purpose: AuthPurpose,
): Promise<ResolvedAuth> {
  const parsed = parseRemoteUrl(remoteUrl);
  const allowed = describeAuthOptions(repo, remoteUrl, purpose, { pat: true, githubAppKey: true }).map((o) => o.method);
  if (!allowed.includes(input.method)) {
    throw new AppError({
      code: 'auth-not-applicable',
      title: 'Authentication Method Not Available',
      message: `"${METHOD_TEXT[input.method].label}" cannot be used for this ${purpose} with remote ${parsed.host ?? 'URL'}.`,
      actions: ['review-auth'],
    });
  }
  const noop = async () => {};

  switch (input.method) {
    case 'none':
      return { git: { kind: 'none' }, description: 'No authentication (local remote)', secrets: [], cleanup: noop };
    case 'system':
      return { git: { kind: 'system' }, description: 'Git identity only (existing Git setup)', secrets: [], cleanup: noop };
    case 'ssh': {
      const transportUrl = sshEquivalent(parsed) ?? undefined;
      const key = resolveSshKeyFile(deps, repo, input);
      if (!key) return { git: { kind: 'ssh' }, transportUrl, description: 'SSH (ssh-agent)', secrets: [], cleanup: noop };
      let passphrase = input.passphrase ?? '';
      // Check the passphrase locally first so a typo gets a clear message instead of "Permission denied".
      if (key.encrypted && !(await verifySshPassphrase(key.keyPath, passphrase))) {
        throw new AppError({
          code: 'ssh-passphrase',
          title: 'Incorrect Passphrase',
          message: `The passphrase for ${path.basename(key.keyPath)} is not correct. Re-type it and try again.`,
          actions: ['review-auth'],
        });
      }
      return {
        git: { kind: 'ssh', keyPath: key.keyPath, passphrase: passphrase || undefined },
        transportUrl,
        sshKeyPath: key.keyPath,
        description: `SSH key ${path.basename(key.keyPath)}${key.fingerprint ? ` (${key.fingerprint})` : ''}${key.encrypted ? ', passphrase supplied' : ''}`,
        secrets: passphrase ? [passphrase] : [],
        cleanup: async () => {
          passphrase = '';
        },
      };
    }
    case 'pat': {
      let username = input.username?.trim() || repo.settings.patUsername || '';
      let token = input.token ?? '';
      if (input.useSaved) {
        if (!repo.settings.allowSavedCredentials) throw authError('Saved credentials are disabled for this repository.');
        const saved = deps.secrets.getPat(repo.id);
        if (!saved) throw authError('No saved token exists for this repository.');
        token = saved.token;
        username = username || saved.username;
      }
      if (!token) throw authError('Enter a personal access token.');
      if (/\s/.test(token) || token.length > 512) throw authError('The token contains invalid characters.');
      username = username || (parsed.isGitHub ? 'x-access-token' : '');
      if (!username) throw authError('Enter the username for this Git server.');
      if (input.saveForRepo && !input.useSaved) deps.secrets.savePat(repo.id, username, token);
      const transport = httpTransport(parsed);
      return {
        git: { kind: 'basic', username, password: token, httpPrefix: transport.httpPrefix },
        transportUrl: transport.transportUrl,
        apiToken: token,
        description: `Personal access token ${maskToken(token)}${transport.transportUrl ? ' (over HTTPS)' : ''}`,
        secrets: [token],
        cleanup: async () => {
          token = '';
        },
      };
    }
    case 'github-app': {
      const owner = (input.owner || parsed.owner || '').trim();
      const name = (input.repo || parsed.repo || '').trim();
      // Isolation: GitHub App credentials may only be used for the repository the remote points to.
      if (!parsed.owner || !parsed.repo || parsed.owner.toLowerCase() !== owner.toLowerCase() || parsed.repo.toLowerCase() !== name.toLowerCase()) {
        throw new AppError({
          code: 'repo-mismatch',
          title: 'Repository Mismatch',
          message: `The GitHub App details are for ${owner}/${name}, but this repository's remote is ${parsed.owner ?? '?'}/${parsed.repo ?? '?'}. Credentials can only be used for the repository they belong to.`,
          actions: ['review-auth'],
        });
      }
      const transport = httpTransport(parsed);
      const viaHttps = transport.transportUrl ? ' over HTTPS' : '';

      if (input.tokenMode === 'existing') {
        // A token the user already has (pasted, or generated moments ago in this dialog).
        // Taken out of the vault: it is single-use and revoked right after this operation.
        let token = input.tokenHandle ? deps.vault.take(input.tokenHandle, 'installation-token') : (input.existingToken ?? '').trim();
        if (!token) throw authError(input.tokenHandle ? 'The generated token has expired. Generate a new one.' : 'Paste an installation token or generate one.');
        if (/\s/.test(token) || token.length > 512) throw authError('The token contains invalid characters.');
        const apiBase = repo.settings.apiBaseUrl ? validateApiBaseUrl(repo.settings.apiBaseUrl) : apiBaseForHost(parsed.host);
        const gh = deps.githubFor(apiBase);
        const revocation: { revoked: boolean | null } = { revoked: null };
        deps.tokens?.track(token, { source: input.tokenHandle ? 'dialog' : 'pasted', apiBase, repositories: [`${owner}/${name}`], purpose });
        return {
          git: { kind: 'basic', username: 'x-access-token', password: token, httpPrefix: transport.httpPrefix },
          transportUrl: transport.transportUrl,
          apiToken: token,
          description: `Installation token ${maskToken(token)} (revoked after use)${viaHttps}`,
          secrets: [token],
          revocation,
          cleanup: async () => {
            if (token) {
              revocation.revoked = await revokeWithRetry(gh, token);
              deps.tokens?.setResult(token, revocation.revoked);
            }
            token = '';
          },
        };
      }

      let pem: string | null = null;
      if (input.keyHandle) pem = deps.vault.take(input.keyHandle, 'private-key');
      else if (input.privateKey) pem = input.privateKey;
      else if (input.useSavedKey) {
        if (!repo.settings.allowSavedCredentials) throw authError('Saved credentials are disabled for this repository.');
        pem = deps.secrets.getGitHubAppKey(repo.id);
      }
      if (!pem) throw authError('Provide the GitHub App private key (paste it or load the .pem file).');
      const key = parsePrivateKey(pem);
      if (input.saveKeyForRepo && !input.useSavedKey) deps.secrets.saveGitHubAppKey(repo.id, pem);
      pem = null;

      const apiBase = repo.settings.apiBaseUrl ? validateApiBaseUrl(repo.settings.apiBaseUrl) : apiBaseForHost(parsed.host);
      const gh = deps.githubFor(apiBase);
      const permissions: Record<string, 'read' | 'write'> =
        purpose === 'push' ? { contents: 'write' } : purpose === 'pr' ? { pull_requests: 'write', contents: 'read' } : { contents: 'read' };
      const tok = await gh.generateInstallationToken({ appId: input.appId, key, owner, repo: name, installationId: input.installationId, permissions });
      let token = tok.token;
      const revocation: { revoked: boolean | null } = { revoked: null };
      deps.tokens?.track(token, { source: 'operation', apiBase, appId: input.appId, repositories: [`${owner}/${name}`], permissions: tok.permissions, expiresAt: tok.expiresAt, purpose });
      return {
        revocation,
        git: { kind: 'basic', username: 'x-access-token', password: token, httpPrefix: transport.httpPrefix },
        transportUrl: transport.transportUrl,
        apiToken: token,
        detectedInstallationId: tok.installationId,
        description: `GitHub App ${input.appId} installation token ${maskToken(token)} (${Object.entries(tok.permissions)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ')}; revoked after use)${viaHttps}`,
        secrets: [token],
        cleanup: async () => {
          if (token) {
            revocation.revoked = await revokeWithRetry(gh, token);
            deps.tokens?.setResult(token, revocation.revoked);
          }
          token = '';
        },
      };
    }
  }
}
