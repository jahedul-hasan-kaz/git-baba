import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SavedSecretsStatus } from '../../shared/types';
import { ID_PATTERN } from '../util/validate';

/** OS-backed encryption (Electron safeStorage in production, a fake in tests). */
export interface Encryptor {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export type SecretKind = 'pat' | 'githubAppKey';

interface SecretBlob {
  pat?: { username: string; token: string };
  githubAppKey?: string;
}

/**
 * Opt-in, per-repository encrypted credential storage. Each repository has its
 * own file so a credential saved for one repository can never be offered for
 * another. Nothing is stored unless the user ticks "save" in an auth dialog,
 * and stored values are still only used after a per-operation confirmation.
 */
export class SecretStore {
  constructor(
    private readonly dir: string,
    private readonly encryptor: Encryptor,
  ) {}

  /** Key of the account-level GitHub App a repository is linked to (set by the app at start-up). */
  linkedAppKey: (repoId: string) => string | null = () => null;

  private fileFor(repoId: string): string {
    if (!ID_PATTERN.test(repoId)) throw new Error('Invalid repository id');
    return path.join(this.dir, `${repoId}.bin`);
  }

  private read(repoId: string): SecretBlob {
    const file = this.fileFor(repoId);
    if (!fs.existsSync(file) || !this.encryptor.isAvailable()) return {};
    try {
      return JSON.parse(this.encryptor.decrypt(fs.readFileSync(file))) as SecretBlob;
    } catch {
      return {};
    }
  }

  private write(repoId: string, blob: SecretBlob): void {
    const file = this.fileFor(repoId);
    if (!blob.pat && !blob.githubAppKey) {
      fs.rmSync(file, { force: true });
      return;
    }
    if (!this.encryptor.isAvailable()) {
      throw new Error('Secure storage is not available on this system; credentials cannot be saved.');
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, this.encryptor.encrypt(JSON.stringify(blob)), { mode: 0o600 });
  }

  encryptionAvailable(): boolean {
    return this.encryptor.isAvailable();
  }

  status(repoId: string): SavedSecretsStatus {
    const blob = this.read(repoId);
    return { pat: !!blob.pat, githubAppKey: !!blob.githubAppKey || !!this.linkedAppKey(repoId), encryptionAvailable: this.encryptor.isAvailable() };
  }

  savePat(repoId: string, username: string, token: string): void {
    this.write(repoId, { ...this.read(repoId), pat: { username, token } });
  }

  saveGitHubAppKey(repoId: string, pem: string): void {
    this.write(repoId, { ...this.read(repoId), githubAppKey: pem });
  }

  getPat(repoId: string): { username: string; token: string } | null {
    return this.read(repoId).pat ?? null;
  }

  getGitHubAppKey(repoId: string): string | null {
    // A key saved for this repository wins; otherwise the key of the account-level App it is linked to.
    return this.read(repoId).githubAppKey ?? this.linkedAppKey(repoId);
  }

  forget(repoId: string, kind?: SecretKind): void {
    if (!kind) {
      fs.rmSync(this.fileFor(repoId), { force: true });
      return;
    }
    const blob = this.read(repoId);
    delete blob[kind];
    this.write(repoId, blob);
  }
}
