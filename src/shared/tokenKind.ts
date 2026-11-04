/** Kinds of GitHub credentials recognisable from their prefix (https://github.blog/2021-04-05-behind-githubs-new-authentication-token-formats/). */
export type TokenKind = 'classic' | 'fine-grained' | 'oauth' | 'app-user' | 'app-installation' | 'refresh' | 'legacy' | 'unknown';

export interface TokenKindInfo {
  kind: TokenKind;
  label: string;
  /** One line: what this kind is good for in Git Baba. */
  hint: string;
  /** Whether it can sign in an account (call /user). */
  usable: boolean;
}

const INFO: Record<TokenKind, Omit<TokenKindInfo, 'kind'>> = {
  classic: { label: 'Classic token', hint: 'Works everywhere you have access. Needs the “repo” scope (plus “read:org” to detect organisations, “workflow” to edit Actions).', usable: true },
  'fine-grained': { label: 'Fine-grained token', hint: 'Limited to the repositories and permissions you picked. Safer; some organisations must approve it first.', usable: true },
  oauth: { label: 'OAuth token', hint: 'Issued to an app (e.g. the GitHub CLI). Works like a classic token.', usable: true },
  'app-user': { label: 'GitHub App user token', hint: 'Acts as you through a GitHub App. Works for most features.', usable: true },
  'app-installation': { label: 'App installation token', hint: 'Belongs to a GitHub App, not a person — it cannot sign in an account. Use the GitHub App Token page.', usable: false },
  refresh: { label: 'Refresh token', hint: 'Only exchanges for a new token — it cannot be used to sign in.', usable: false },
  legacy: { label: 'Older token format', hint: 'A 40-character token from before 2021. It still works if it has not been revoked.', usable: true },
  unknown: { label: 'Unrecognised', hint: 'This does not look like a GitHub token. Classic tokens start with ghp_, fine-grained ones with github_pat_.', usable: false },
};

/** Detects the kind of a GitHub token from its prefix. Never logs or returns the token. */
export function detectTokenKind(raw: string): TokenKindInfo | null {
  const t = raw.trim();
  if (!t) return null;
  let kind: TokenKind = 'unknown';
  if (/^github_pat_[A-Za-z0-9_]{20,}$/.test(t)) kind = 'fine-grained';
  else if (/^ghp_[A-Za-z0-9]{20,}$/.test(t)) kind = 'classic';
  else if (/^gho_[A-Za-z0-9]{20,}$/.test(t)) kind = 'oauth';
  else if (/^ghu_[A-Za-z0-9]{20,}$/.test(t)) kind = 'app-user';
  else if (/^ghs_[A-Za-z0-9]{20,}$/.test(t)) kind = 'app-installation';
  else if (/^ghr_[A-Za-z0-9]{20,}$/.test(t)) kind = 'refresh';
  else if (/^[0-9a-f]{40}$/.test(t)) kind = 'legacy';
  return { kind, ...INFO[kind] };
}

export const NEW_CLASSIC_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Git%20Baba';
export const NEW_FINE_GRAINED_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
export const GH_CLI_INSTALL_URL = 'https://github.com/cli/cli#installation';
