import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { LastOperation, RepoRecord, RepoSettings } from '../../shared/types';
import { readJson, writeJson } from './jsonFile';

export const DEFAULT_SETTINGS: RepoSettings = {
  runHooks: false,
  allowSystemCredentials: false,
  allowSavedCredentials: false,
};

interface RepoFile {
  version: 1;
  repos: RepoRecord[];
}

/**
 * The list of repositories the user added. Contains no secrets. The renderer
 * only ever refers to repositories by id; paths are resolved here.
 */
export class RepoStore {
  private repos: RepoRecord[];

  constructor(private readonly file: string) {
    const data = readJson<RepoFile>(file, { version: 1, repos: [] });
    this.repos = Array.isArray(data.repos) ? data.repos.map((r) => ({ ...r, settings: { ...DEFAULT_SETTINGS, ...r.settings } })) : [];
  }

  private save(): void {
    writeJson(this.file, { version: 1, repos: this.repos } satisfies RepoFile);
  }

  list(): RepoRecord[] {
    return this.repos.map((r) => ({ ...r, settings: { ...r.settings } }));
  }

  get(id: string): RepoRecord | undefined {
    return this.repos.find((r) => r.id === id);
  }

  findByPath(p: string): RepoRecord | undefined {
    const norm = normalizeForCompare(p);
    return this.repos.find((r) => normalizeForCompare(r.path) === norm);
  }

  add(repoPath: string): RepoRecord {
    const existing = this.findByPath(repoPath);
    if (existing) return existing;
    const record: RepoRecord = {
      id: crypto.randomBytes(12).toString('base64url'),
      name: path.basename(repoPath),
      path: repoPath,
      addedAt: new Date().toISOString(),
      settings: { ...DEFAULT_SETTINGS },
    };
    this.repos.push(record);
    this.save();
    return record;
  }

  remove(id: string): boolean {
    const before = this.repos.length;
    this.repos = this.repos.filter((r) => r.id !== id);
    if (this.repos.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  updateSettings(id: string, patch: Partial<RepoSettings>): RepoRecord {
    const repo = this.get(id);
    if (!repo) throw new Error('Unknown repository');
    repo.settings = { ...repo.settings, ...patch };
    // Allow explicit removal of optional values.
    for (const key of Object.keys(patch) as (keyof RepoSettings)[]) {
      if (patch[key] === undefined) delete repo.settings[key];
    }
    this.save();
    return repo;
  }

  setFavorite(id: string, favorite: boolean): RepoRecord {
    const repo = this.get(id);
    if (!repo) throw new Error('Unknown repository');
    if (favorite) repo.favorite = true;
    else delete repo.favorite;
    this.save();
    return repo;
  }

  setLastOperation(id: string, op: LastOperation): void {
    const repo = this.get(id);
    if (!repo) return;
    repo.lastOperation = op;
    this.save();
  }
}

function normalizeForCompare(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}
