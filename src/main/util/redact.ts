// Removes secrets from any text before it is logged, stored in history or
// shown as "technical details". Applied defensively everywhere output leaves
// the Git/GitHub layer.

const PATTERNS: [RegExp, string][] = [
  // PEM private keys (any type), including partial/truncated blocks.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  // GitHub token formats: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED TOKEN]'],
  // v1 installation tokens are 40 hex chars prefixed with "v1."
  [/\bv1\.[0-9a-f]{40}\b/g, '[REDACTED TOKEN]'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]'],
  // Authorization headers
  [/(authorization\s*[:=]\s*)(basic|bearer|token)\s+[^\s'"]+/gi, '$1$2 [REDACTED]'],
  // Credentials embedded in URLs: https://user:pass@host or https://token@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(:[^\s/@]*)?@/gi, '$1[REDACTED]@'],
  // GIT_CONFIG_VALUE_n=... (our credential injection) just in case it is echoed.
  [/(GIT_CONFIG_VALUE_\d+=)\S+/g, '$1[REDACTED]'],
];

export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  if (!text) return text;
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}
