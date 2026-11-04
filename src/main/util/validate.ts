// Small, dependency-free validators for IPC payloads and user input.

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function asObject(value: unknown, name = 'payload'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

interface StringOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
  trim?: boolean;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function asString(value: unknown, name: string, opts: StringOpts = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  const v = opts.trim === false ? value : value.trim();
  const min = opts.min ?? 1;
  const max = opts.max ?? 4096;
  if (v.length < min) throw new ValidationError(`${name} is required`);
  if (v.length > max) throw new ValidationError(`${name} is too long`);
  if (v.includes('\0')) throw new ValidationError(`${name} contains invalid characters`);
  if (opts.pattern && !opts.pattern.test(v)) throw new ValidationError(`${name} has an invalid format`);
  return v;
}

/** Single-line string without control characters. */
export function asLine(value: unknown, name: string, opts: StringOpts = {}): string {
  const v = asString(value, name, opts);
  if (CONTROL_CHARS.test(v) || /[\r\n]/.test(v)) throw new ValidationError(`${name} must be a single line`);
  return v;
}

export function asOptionalString(value: unknown, name: string, opts: StringOpts = {}): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asString(value, name, opts);
}

export function asBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be true or false`);
  return value;
}

export function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  return asBoolean(value, name);
}

export function asInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function asEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function asStringArray(value: unknown, name: string, maxItems = 5000): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list`);
  if (value.length > maxItems) throw new ValidationError(`${name} has too many items`);
  return value.map((v, i) => asString(v, `${name}[${i}]`, { trim: false, max: 4096 }));
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function asId(value: unknown, name: string): string {
  return asString(value, name, { pattern: ID_PATTERN, max: 64 });
}

/**
 * Branch names: mirrors the important parts of `git check-ref-format --branch`
 * and additionally refuses a leading "-" so a name can never be read as an option.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name === '@' || name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.endsWith('.lock') || name.split('/').some((p) => p.startsWith('.') || p.endsWith('.lock'))) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  return true;
}

export function asBranchName(value: unknown, name = 'branch'): string {
  const v = asLine(value, name, { max: 255 });
  if (!isValidBranchName(v)) throw new ValidationError(`"${v}" is not a valid branch name`);
  return v;
}

export function isValidRemoteName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.endsWith('.lock');
}

export function asRemoteName(value: unknown, name = 'remote'): string {
  const v = asLine(value, name, { max: 64 });
  if (!isValidRemoteName(v)) throw new ValidationError(`"${v}" is not a valid remote name`);
  return v;
}

/** GitHub owner / repository name rules (loose but safe for URL path segments). */
export function asGitHubName(value: unknown, name: string): string {
  return asLine(value, name, { max: 100, pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/ });
}

export function asNumericId(value: unknown, name: string): string {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  return asLine(value, name, { max: 20, pattern: /^[1-9][0-9]{0,19}$/ });
}

export function asOptionalNumericId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asNumericId(value, name);
}

/** Folder name for a new repository / clone target: one path segment, no tricks. */
export function asFolderName(value: unknown, name = 'folder name'): string {
  const v = asLine(value, name, { max: 128 });
  if (v === '.' || v === '..' || /[<>:"/\\|?*]/.test(v) || v.startsWith('-') || /[. ]$/.test(v)) {
    throw new ValidationError(`"${v}" is not a valid folder name`);
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(v)) {
    throw new ValidationError(`"${v}" is a reserved name on Windows`);
  }
  return v;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+$/.test(email) && email.length <= 254;
}
