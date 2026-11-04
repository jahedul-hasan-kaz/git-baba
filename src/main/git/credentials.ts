// Turns a resolved credential into environment variables for a single git
// process. Credentials are never placed on the command line (visible in the
// process list) and never written to git config on disk.
import { passphraseEnv, shellQuote, toSshPath } from './sshKeys';

export type ResolvedGitAuth =
  | { kind: 'basic'; username: string; password: string; httpPrefix: string }
  | { kind: 'ssh'; keyPath?: string; passphrase?: string }
  | { kind: 'system' }
  | { kind: 'none' };

export interface GitAuthEnv {
  env: Record<string, string>;
  secrets: string[];
}

export function buildGitAuthEnv(auth: ResolvedGitAuth, opts: { sshCommandConfigured?: boolean } = {}): GitAuthEnv {
  switch (auth.kind) {
    case 'basic': {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
      return {
        env: {
          GIT_CONFIG_COUNT: '2',
          // An empty value resets the helper list, so stored credentials are not consulted
          // and the supplied token is not saved by a helper after a successful push.
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: '',
          GIT_CONFIG_KEY_1: `http.${auth.httpPrefix}.extraHeader`,
          GIT_CONFIG_VALUE_1: `Authorization: Basic ${encoded}`,
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
        },
        secrets: [auth.password, encoded],
      };
    }
    case 'ssh': {
      const env: Record<string, string> = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
      };
      const secrets: string[] = [];
      if (auth.keyPath) {
        // Use exactly the chosen key file, not whatever ssh-agent offers.
        // accept-new: trust a host on first contact (no invisible prompt), but still refuse a CHANGED host key.
        env.GIT_SSH_COMMAND = `ssh -i ${shellQuote(toSshPath(auth.keyPath))} -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=accept-new`;
        if (auth.passphrase) {
          Object.assign(env, passphraseEnv(auth.passphrase));
          secrets.push(auth.passphrase);
        } else {
          env.GIT_SSH_COMMAND += ' -o BatchMode=yes';
        }
      } else if (!opts.sshCommandConfigured && !process.env.GIT_SSH && !process.env.GIT_SSH_COMMAND) {
        // The user's own SSH setup (core.sshCommand, GIT_SSH for plink/Pageant, GIT_SSH_COMMAND) wins.
        // ssh-agent mode: fail fast instead of hanging on an invisible prompt.
        env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
      }
      return { env, secrets };
    }
    case 'none':
      return {
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' },
        secrets: [],
      };
    case 'system':
      return { env: {}, secrets: [] };
  }
}
