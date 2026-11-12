// Pure helpers for the Keys page (no React) — unit-tested in tests/keysPage.test.ts.

export const SSH_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/** Lower-case, file-name-safe slug of a GitHub login ("Octo.Cat" → "octo.cat"). */
export function loginSlug(login: string | null | undefined): string {
  return (login ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '').slice(0, 30);
}

/** Base names (no directory, no ".pub") of the key files already in ~/.ssh. */
export function takenKeyNames(pubPaths: string[]): Set<string> {
  return new Set(pubPaths.map((p) => p.replace(/^.*[\\/]/, '').replace(/\.pub$/i, '').toLowerCase()));
}

/** First free name: id_<type>_<login>, then …_2, …_3 (or id_<type>, id_<type>_2 without a login). */
export function suggestKeyFileName(type: string, login: string | null | undefined, taken: Set<string>): string {
  const slug = loginSlug(login);
  const base = slug ? `id_${type}_${slug}` : `id_${type}`;
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base}_${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return `${base}_${Date.now()}`;
}

/** Live validation of a key file name; null when it can be used. */
export function keyFileNameProblem(name: string, taken: Set<string>): string | null {
  const n = name.trim();
  if (!n) return 'Enter a file name.';
  if (n.length > 64) return 'Use at most 64 characters.';
  if (!SSH_FILE_NAME.test(n)) return 'Use letters, digits, dot, dash or underscore only.';
  if (n.startsWith('.')) return 'The name cannot start with a dot.';
  if (/\.pub$/i.test(n)) return 'Leave out ".pub" — it is added for the public key.';
  if (/^(known_hosts|config|authorized_keys|environment)/i.test(n)) return 'That name is reserved by ssh.';
  if (taken.has(n.toLowerCase())) return `${n} already exists in ~/.ssh — pick another name.`;
  return null;
}

/** Rough passphrase strength for the hint under the field. */
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!p) return { score: 0, label: 'No passphrase' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  const words = p.trim().split(/\s+/).length;
  if (p.length >= 16 || (words >= 4 && p.length >= 14) || (p.length >= 12 && classes >= 3)) return { score: 3, label: 'Strong' };
  if (p.length >= 10 && classes >= 2) return { score: 2, label: 'Good' };
  return { score: 1, label: p.length < 5 ? 'Too short' : 'Weak' };
}

/** "SHA256:abcd…wxyz" — enough to recognise a key at a glance. */
export function shortFingerprint(fp: string): string {
  const m = /^(SHA256:)?(.+)$/.exec(fp.trim());
  const body = m ? m[2] : fp;
  return body.length > 14 ? `${body.slice(0, 8)}…${body.slice(-4)}` : body;
}

/** "ssh-ed25519 AAAA…" body (type + base64), without the comment — used to match local and GitHub keys. */
export const keyBody = (k: string): string => k.trim().split(/\s+/).slice(0, 2).join(' ');

/** Does git's user.signingkey refer to this SSH key (by .pub path or literal "key::ssh-… AAAA")? */
export function isSshSigningKey(signingKey: string | null, k: { pubPath: string; publicKey: string }): boolean {
  if (!signingKey) return false;
  const v = signingKey.trim();
  if (v.startsWith('key::')) return keyBody(v.slice(5)) === keyBody(k.publicKey);
  if (/^(ssh-|ecdsa-|sk-)/.test(v)) return keyBody(v) === keyBody(k.publicKey);
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^~\//, '').toLowerCase();
  const a = norm(v);
  const b = norm(k.pubPath);
  return a === b || (v.startsWith('~/') && b.endsWith(`/${a}`));
}

/** Does user.signingkey refer to this GPG key (long id, fingerprint or its suffix; a trailing "!" is allowed)? */
export function isGpgSigningKey(signingKey: string | null, k: { keyId: string; fingerprint: string }): boolean {
  if (!signingKey) return false;
  const v = signingKey.trim().replace(/^0x/i, '').replace(/!$/, '').toUpperCase();
  if (!/^[0-9A-F]{8,40}$/.test(v)) return false;
  return (!!k.fingerprint && k.fingerprint.toUpperCase().endsWith(v)) || k.keyId.toUpperCase().endsWith(v) || v.endsWith(k.keyId.toUpperCase());
}
