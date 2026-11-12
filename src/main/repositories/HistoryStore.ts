import * as crypto from 'node:crypto';
import type { HistoryEntry, OperationStatus } from '../../shared/types';
import { redactSecrets } from '../util/redact';
import { readJson, writeJson } from './jsonFile';

const MAX_ENTRIES = 1000;

/** Local, non-sensitive log of operations. Every summary is passed through redaction. */
export class HistoryStore {
  private entries: HistoryEntry[];

  constructor(private readonly file: string) {
    const data = readJson<{ entries?: HistoryEntry[] }>(file, {});
    this.entries = Array.isArray(data.entries) ? data.entries : [];
  }

  add(repoName: string | null, operation: string, status: OperationStatus, summary: string): HistoryEntry {
    const entry: HistoryEntry = {
      id: crypto.randomBytes(8).toString('hex'),
      at: new Date().toISOString(),
      repoName,
      operation,
      status,
      summary: redactSecrets(summary).slice(0, 500),
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    writeJson(this.file, { entries: this.entries });
    return entry;
  }

  list(limit = 500): HistoryEntry[] {
    return this.entries.slice(0, limit);
  }

  clear(): void {
    this.entries = [];
    writeJson(this.file, { entries: [] });
  }
}
