import * as crypto from 'node:crypto';

/** 'ssh-key-path' holds only a file path chosen in the native dialog (not secret, but never accepted raw from the renderer). */
export type VaultKind = 'private-key' | 'installation-token' | 'ssh-key-path';

interface Entry {
  kind: VaultKind;
  value: string;
  repoScope: string | null;
  expiresAt: number;
  timer: NodeJS.Timeout;
  onExpire?: (value: string) => void;
}

/**
 * Short-lived, in-memory holder for secrets the renderer must refer to without
 * seeing (loaded private keys, generated tokens). The renderer only gets an
 * opaque handle. Entries expire automatically and are dropped on quit.
 *
 * JavaScript strings cannot be reliably zeroed; dropping every reference and
 * keeping lifetimes short is the practical mitigation.
 */
export class EphemeralVault {
  private readonly entries = new Map<string, Entry>();

  put(kind: VaultKind, value: string, ttlMs: number, opts: { repoScope?: string | null; onExpire?: (value: string) => void } = {}): { handle: string; expiresAt: number } {
    const handle = crypto.randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    const timer = setTimeout(() => this.expire(handle), ttlMs);
    timer.unref?.();
    this.entries.set(handle, { kind, value, repoScope: opts.repoScope ?? null, expiresAt, timer, onExpire: opts.onExpire });
    return { handle, expiresAt };
  }

  get(handle: string, kind: VaultKind): string | null {
    const e = this.entries.get(handle);
    if (!e || e.kind !== kind || e.expiresAt < Date.now()) return null;
    return e.value;
  }

  /** Read and remove (single use). */
  take(handle: string, kind: VaultKind): string | null {
    const v = this.get(handle, kind);
    if (v !== null) this.delete(handle, false);
    return v;
  }

  delete(handle: string, runExpireHook = true): void {
    const e = this.entries.get(handle);
    if (!e) return;
    clearTimeout(e.timer);
    this.entries.delete(handle);
    if (runExpireHook) e.onExpire?.(e.value);
    e.value = '';
  }

  private expire(handle: string): void {
    this.delete(handle, true);
  }

  clear(): void {
    for (const handle of [...this.entries.keys()]) this.delete(handle, true);
  }

  size(): number {
    return this.entries.size;
  }
}
