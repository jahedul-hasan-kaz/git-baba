import * as path from 'node:path';
import { ValidationError } from './validate';

/**
 * Resolves a repository-relative path received over IPC and guarantees it
 * stays inside the working tree and outside the .git directory.
 */
export function resolveInsideRepo(repoRoot: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 4096) {
    throw new ValidationError('Invalid file path');
  }
  if (relPath.includes('\0')) throw new ValidationError('Invalid file path');
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new ValidationError('File paths must be relative to the repository');
  }
  const normalized = path.normalize(relPath);
  const segments = normalized.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) throw new ValidationError('File path escapes the repository');
  if (segments.some((s) => s.toLowerCase() === '.git')) throw new ValidationError('The .git directory cannot be modified directly');

  const root = path.resolve(repoRoot);
  const full = path.resolve(root, normalized);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ValidationError('File path escapes the repository');
  }
  return full;
}

/** Validates a list of repo-relative paths and returns them in git's forward-slash form. */
export function sanitizeRepoPaths(repoRoot: string, relPaths: string[]): string[] {
  return relPaths.map((p) => {
    resolveInsideRepo(repoRoot, p);
    return p.replace(/\\/g, '/');
  });
}
