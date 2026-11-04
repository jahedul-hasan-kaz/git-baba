import * as crypto from 'node:crypto';

export type ConfirmationKind = 'commit' | 'push' | 'pull' | 'continue' | 'branch-merge' | 'branch-publish' | 'branch-delete' | 'branch-switch';

interface Pending<T> {
  kind: ConfirmationKind;
  repoId: string;
  data: T;
  expiresAt: number;
}

/**
 * Binds a confirmation dialog to the exact state the user reviewed. A preview
 * call registers what was shown (staged-change fingerprint, commit id to push,
 * commit id to merge); the execute call must present the matching single-use id.
 * This keeps "Review → Authenticate → Confirm → Commit/Push" enforced in the
 * main process, not just in the UI.
 */
export class ConfirmationRegistry {
  private readonly pending = new Map<string, Pending<unknown>>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  create<T>(kind: ConfirmationKind, repoId: string, data: T): string {
    this.sweep();
    // Only one outstanding confirmation per repo+kind: a newer preview invalidates older ones.
    for (const [id, p] of this.pending) if (p.kind === kind && p.repoId === repoId) this.pending.delete(id);
    const id = crypto.randomBytes(18).toString('base64url');
    this.pending.set(id, { kind, repoId, data, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  /** Returns the reviewed data and invalidates the id. Throws if missing, expired or mismatched. */
  consume<T>(id: string, kind: ConfirmationKind, repoId: string): T {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p || p.kind !== kind || p.repoId !== repoId || p.expiresAt < Date.now()) {
      throw new ConfirmationError();
    }
    return p.data as T;
  }

  peek<T>(id: string, kind: ConfirmationKind, repoId: string): T | null {
    const p = this.pending.get(id);
    if (!p || p.kind !== kind || p.repoId !== repoId || p.expiresAt < Date.now()) return null;
    return p.data as T;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
  }
}

export class ConfirmationError extends Error {
  constructor() {
    super('This confirmation has expired or was already used. Review the operation again.');
    this.name = 'ConfirmationError';
  }
}
