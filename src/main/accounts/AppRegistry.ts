import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RegisteredApp } from '../../shared/github';
import type { Encryptor } from '../repositories/SecretStore';
import { ID_PATTERN } from '../util/validate';

/**
 * GitHub Apps registered once at account level (App ID, name, slug — not secret) with their private keys
 * encrypted by the OS keychain, one file per App. Repositories link to an App instead of storing their own copy.
 */
export class AppRegistry {
  private apps: RegisteredApp[] = [];

  constructor(
    private readonly file: string,
    private readonly keyDir: string,
    private readonly encryptor: Encryptor,
  ) {
    try {
      this.apps = JSON.parse(fs.readFileSync(file, 'utf8')) as RegisteredApp[];
    } catch {
      this.apps = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.apps, null, 2), { mode: 0o600 });
  }

  private keyFile(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error('Invalid app id');
    return path.join(this.keyDir, `${id}.bin`);
  }

  available(): boolean {
    return this.encryptor.isAvailable();
  }

  list(): RegisteredApp[] {
    return this.apps.map((a) => ({ ...a, hasKey: fs.existsSync(this.keyFile(a.id)) }));
  }

  get(id: string): RegisteredApp | undefined {
    return this.list().find((a) => a.id === id);
  }

  findByAppId(appId: string, apiBase: string): RegisteredApp | undefined {
    return this.list().find((a) => a.appId === appId && a.apiBase === apiBase);
  }

  /** Adds (or refreshes) an App and stores its key encrypted. */
  upsert(app: Omit<RegisteredApp, 'id' | 'addedAt' | 'hasKey'>, pem: string): RegisteredApp {
    if (!this.encryptor.isAvailable()) throw new Error('Secure storage is not available on this system; the App key cannot be saved.');
    const existing = this.apps.find((a) => a.appId === app.appId && a.apiBase === app.apiBase);
    const rec: RegisteredApp = { ...app, id: existing?.id ?? crypto.randomBytes(12).toString('base64url'), addedAt: existing?.addedAt ?? new Date().toISOString(), hasKey: true };
    this.apps = [...this.apps.filter((a) => a.id !== rec.id), rec];
    fs.mkdirSync(this.keyDir, { recursive: true });
    fs.writeFileSync(this.keyFile(rec.id), this.encryptor.encrypt(pem), { mode: 0o600 });
    this.save();
    return rec;
  }

  getKey(id: string): string | null {
    const f = this.keyFile(id);
    if (!fs.existsSync(f) || !this.encryptor.isAvailable()) return null;
    try {
      return this.encryptor.decrypt(fs.readFileSync(f));
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    this.apps = this.apps.filter((a) => a.id !== id);
    fs.rmSync(this.keyFile(id), { force: true });
    this.save();
  }
}
