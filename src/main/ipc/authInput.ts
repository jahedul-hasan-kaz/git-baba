import type { AuthInput, SshKeyInput } from '../../shared/types';
import {
  asBoolean,
  asEnum,
  asGitHubName,
  asLine,
  asNumericId,
  asObject,
  asOptionalBoolean,
  asOptionalNumericId,
  asOptionalString,
  asString,
  ValidationError,
} from '../util/validate';

const HANDLE = /^[A-Za-z0-9_-]+$/;

/** Validates the SSH key part of an auth input or a commit-signing request. */
export function parseSshKeyInput(o: Record<string, unknown>): SshKeyInput {
  const keySource = o.keySource === undefined ? 'agent' : asEnum(o.keySource, 'keySource', ['agent', 'file'] as const);
  if (keySource === 'agent') return { keySource };
  return {
    keySource,
    keyHandle: asString(o.keyHandle, 'SSH key', { max: 64, pattern: HANDLE }),
    // Passphrases may legitimately contain leading/trailing spaces.
    passphrase: asOptionalString(o.passphrase, 'passphrase', { max: 1024, trim: false }),
    rememberKeyPath: asOptionalBoolean(o.rememberKeyPath, 'rememberKeyPath') ?? false,
  };
}

/** Validates an AuthInput received from the renderer. */
export function parseAuthInput(value: unknown): AuthInput {
  const o = asObject(value, 'auth');
  const method = asEnum(o.method, 'auth.method', ['pat', 'github-app', 'ssh', 'system', 'none'] as const);
  switch (method) {
    case 'ssh':
      return { method, ...parseSshKeyInput(o) };
    case 'pat': {
      const useSaved = asOptionalBoolean(o.useSaved, 'useSaved') ?? false;
      const token = useSaved ? undefined : asString(o.token, 'token', { max: 512 });
      return {
        method,
        username: o.username ? asLine(o.username, 'username', { max: 100 }) : undefined,
        token,
        useSaved,
        saveForRepo: asOptionalBoolean(o.saveForRepo, 'saveForRepo') ?? false,
      };
    }
    case 'github-app': {
      const tokenMode = o.tokenMode === undefined ? 'generate' : asEnum(o.tokenMode, 'tokenMode', ['generate', 'existing'] as const);
      const rememberApp = asOptionalBoolean(o.rememberApp, 'rememberApp') ?? false;
      if (tokenMode === 'existing') {
        const tokenHandle = asOptionalString(o.tokenHandle, 'tokenHandle', { max: 64, pattern: HANDLE });
        const existingToken = tokenHandle ? undefined : asString(o.existingToken, 'Installation token', { max: 512 });
        return {
          method,
          tokenMode,
          tokenHandle,
          existingToken,
          appId: o.appId ? asNumericId(o.appId, 'App ID') : '',
          owner: o.owner ? asGitHubName(o.owner, 'Owner') : '',
          repo: o.repo ? asGitHubName(o.repo, 'Repository') : '',
          rememberApp: false,
        };
      }
      const useSavedKey = asOptionalBoolean(o.useSavedKey, 'useSavedKey') ?? false;
      const privateKey = asOptionalString(o.privateKey, 'privateKey', { max: 16_384, trim: false });
      const keyHandle = asOptionalString(o.keyHandle, 'keyHandle', { max: 64, pattern: HANDLE });
      if (!useSavedKey && !privateKey && !keyHandle) throw new ValidationError('A private key is required');
      return {
        method,
        tokenMode,
        appId: asNumericId(o.appId, 'App ID'),
        owner: asGitHubName(o.owner, 'Owner'),
        repo: asGitHubName(o.repo, 'Repository'),
        installationId: asOptionalNumericId(o.installationId, 'Installation ID'),
        privateKey,
        keyHandle,
        useSavedKey,
        saveKeyForRepo: asOptionalBoolean(o.saveKeyForRepo, 'saveKeyForRepo') ?? false,
        rememberApp,
      };
    }
    default:
      return { method };
  }
}

export function asConfirmed(value: unknown): true {
  if (asBoolean(value, 'confirmed') !== true) throw new ValidationError('This action requires explicit confirmation');
  return true;
}
