import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { ProgressEvent, RepoRecord } from '../shared/types';
import { AccountSessions } from './accounts/AccountSessions';
import type { AccountSecretStore, AccountStore } from './accounts/AccountStore';
import type { AppRegistry } from './accounts/AppRegistry';
import { AppError } from './git/errors';
import { GitService } from './git/GitService';
import { GitHubService } from './github/GitHubService';
import type { HistoryStore } from './repositories/HistoryStore';
import type { RepoStore } from './repositories/RepoStore';
import type { SecretStore } from './repositories/SecretStore';
import { ConfirmationRegistry } from './security/ConfirmationRegistry';
import { EphemeralVault } from './security/EphemeralVault';
import { SecurityScanner } from './security/SecurityScanner';
import { TokenRegistry } from './security/TokenRegistry';
import { asId } from './util/validate';

export interface DirectoryPick {
  path: string;
  purpose: 'open' | 'create' | 'clone-parent';
  expiresAt: number;
}

/** Long-lived services shared by all IPC handlers. */
export class AppContext {
  readonly vault = new EphemeralVault();
  /** Installation tokens generated/used this session, with their revocation status (memory only). */
  readonly tokens = new TokenRegistry();
  readonly confirmations = new ConfirmationRegistry();
  readonly scanner = new SecurityScanner();
  private readonly picks = new Map<string, DirectoryPick>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /** Sends live progress/state for long operations to the window (set by index.ts). */
  progress: (event: ProgressEvent) => void = () => {};

  /** Activity notifications for the active account (set by index.ts). */
  notifications: import('./notifications/NotificationCenter').NotificationCenter | null = null;

  /** In-memory signed-in GitHub sessions (never persisted). */
  readonly sessions = new AccountSessions(() => ({ accounts: this.accounts, accountSecrets: this.accountSecrets, githubFor: (b: string) => this.githubFor(b) }));

  constructor(
    readonly repos: RepoStore,
    readonly secrets: SecretStore,
    readonly history: HistoryStore,
    readonly backupRoot: string,
    readonly accounts: AccountStore,
    readonly accountSecrets: AccountSecretStore,
  ) {}

  /** Account-level GitHub App registry (set at start-up; null in tests that do not need it). */
  appRegistry: AppRegistry | null = null;

  githubFor(apiBase: string): GitHubService {
    return new GitHubService(apiBase);
  }

  repo(repoId: unknown): RepoRecord {
    const id = asId(repoId, 'repoId');
    const repo = this.repos.get(id);
    if (!repo) throw new AppError({ code: 'unknown-repo', title: 'Repository Not Found', message: 'This repository is no longer in the app.' });
    return repo;
  }

  git(repoId: unknown): { repo: RepoRecord; git: GitService } {
    const repo = this.repo(repoId);
    if (!fs.existsSync(repo.path)) {
      throw new AppError({
        code: 'repo-missing',
        title: 'Repository Folder Missing',
        message: `The folder ${repo.path} no longer exists. It may have been moved or deleted. Remove it from the app or add it again.`,
      });
    }
    return { repo, git: new GitService(repo.path, { runHooks: repo.settings.runHooks }) };
  }

  /** Serialises mutating operations per repository so two git commands never race. */
  async withLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repoId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => current);
    this.locks.set(repoId, chained);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(repoId) === chained) this.locks.delete(repoId);
    }
  }

  registerPick(path: string, purpose: DirectoryPick['purpose']): string {
    const id = crypto.randomBytes(12).toString('base64url');
    this.picks.set(id, { path, purpose, expiresAt: Date.now() + 30 * 60_000 });
    return id;
  }

  /** Paths only enter the app through a native folder dialog; the renderer refers to them by id. */
  consumePick(selectionId: unknown, purposes: DirectoryPick['purpose'][]): string {
    const id = asId(selectionId, 'selectionId');
    const pick = this.picks.get(id);
    this.picks.delete(id);
    if (!pick || pick.expiresAt < Date.now() || !purposes.includes(pick.purpose)) {
      throw new AppError({ code: 'selection-expired', title: 'Folder Selection Expired', message: 'Please choose the folder again.' });
    }
    return pick.path;
  }

  recordOperation(repo: RepoRecord | null, operation: string, status: 'SUCCESS' | 'WARNING' | 'CANCELLED' | 'FAILED', summary: string): void {
    this.history.add(repo?.name ?? null, operation, status, summary);
    if (repo) this.repos.setLastOperation(repo.id, { operation, status, at: new Date().toISOString() });
  }
}
