import * as crypto from 'node:crypto';
import type { InstallationTokenRecord, TokenSource } from '../../shared/types';
import { maskToken } from '../util/redact';

interface Entry extends InstallationTokenRecord {
  /** Raw token, kept in memory only while the token is active (needed to revoke it). */
  token: string | null;
  apiBase: string;
  /** Vault handle when the token is also held for copy/reveal (token page, instant generation). */
  vaultHandle: string | null;
}

const MAX_ENTRIES = 200;

/**
 * Every GitHub App installation token Git Baba generates or uses in this session, with its
 * status. GitHub offers no API to list installation tokens, and Git Baba never writes them to
 * disk, so this in-memory list (cleared on quit) is the complete picture for this app.
 * The renderer only ever receives masked tokens and opaque ids.
 */
export class TokenRegistry {
  private readonly entries = new Map<string, Entry>();

  private static keyOf(token: string): string {
    return crypto.createHash('sha256').update(token).digest('base64url').slice(0, 24);
  }

  /** Registers a token (idempotent: the same token used again keeps one entry). Returns its id. */
  track(token: string, meta: { source: TokenSource; apiBase: string; appId?: string | null; repositories?: string[]; permissions?: Record<string, string>; expiresAt?: string | null; vaultHandle?: string | null; purpose?: string | null }): string {
    const id = TokenRegistry.keyOf(token);
    const existing = this.entries.get(id);
    if (existing) {
      if (meta.purpose) existing.usedFor = [...new Set([...existing.usedFor, meta.purpose])];
      if (meta.vaultHandle) existing.vaultHandle = meta.vaultHandle;
      return id;
    }
    this.entries.set(id, {
      id,
      masked: maskToken(token),
      source: meta.source,
      appId: meta.appId ?? null,
      repositories: meta.repositories ?? [],
      permissions: meta.permissions ?? {},
      createdAt: new Date().toISOString(),
      expiresAt: meta.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
      status: 'active',
      revokedAt: null,
      lastError: null,
      usedFor: meta.purpose ? [meta.purpose] : [],
      token,
      apiBase: meta.apiBase,
      vaultHandle: meta.vaultHandle ?? null,
    });
    this.trim();
    return id;
  }

  /** Records the outcome of a revocation attempt made elsewhere (e.g. after a push). */
  setResult(token: string, revoked: boolean, error?: string): void {
    const e = this.entries.get(TokenRegistry.keyOf(token));
    if (!e) return;
    this.applyResult(e, revoked, error);
  }

  private applyResult(e: Entry, revoked: boolean, error?: string) {
    if (revoked) {
      e.status = 'revoked';
      e.revokedAt = new Date().toISOString();
      e.lastError = null;
      e.token = null;
      e.vaultHandle = null;
    } else {
      e.status = 'revoke-failed';
      e.lastError = error ?? 'GitHub could not be reached to revoke the token.';
    }
  }

  private refresh(e: Entry) {
    if ((e.status === 'active' || e.status === 'revoke-failed') && new Date(e.expiresAt).getTime() <= Date.now()) {
      e.status = 'expired';
      e.token = null;
      e.vaultHandle = null;
    }
  }

  list(): InstallationTokenRecord[] {
    return [...this.entries.values()]
      .map((e) => {
        this.refresh(e);
        const { token: _t, apiBase: _a, vaultHandle: _v, ...pub } = e;
        return { ...pub };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Data needed to revoke one entry; null when there is nothing left to revoke. */
  revocable(id: string): { token: string; apiBase: string; vaultHandle: string | null } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    this.refresh(e);
    if (!e.token || (e.status !== 'active' && e.status !== 'revoke-failed')) return null;
    return { token: e.token, apiBase: e.apiBase, vaultHandle: e.vaultHandle };
  }

  activeIds(): string[] {
    return this.list()
      .filter((e) => e.status === 'active' || e.status === 'revoke-failed')
      .map((e) => e.id);
  }

  record(id: string, revoked: boolean, error?: string): void {
    const e = this.entries.get(id);
    if (e) this.applyResult(e, revoked, error);
  }

  /** Removes finished entries (revoked / expired) from the list. */
  clearFinished(): number {
    let n = 0;
    for (const e of [...this.entries.values()]) {
      this.refresh(e);
      if (e.status === 'revoked' || e.status === 'expired') {
        this.entries.delete(e.id);
        n++;
      }
    }
    return n;
  }

  private trim() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const finished = [...this.entries.values()].filter((e) => e.status === 'revoked' || e.status === 'expired').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const e of finished) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(e.id);
    }
  }
}
