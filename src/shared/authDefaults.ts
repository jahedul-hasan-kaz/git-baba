import type { AuthMethod, CommitSigningPreference, RemoteAuthPreference, SigningMethod } from './types';

/** Where a preselected method comes from, so the UI can say why it was chosen. */
export type DefaultSource = 'github-app' | 'repo-setting' | 'remembered' | 'git-config' | 'default';

export interface RemoteAuthDefaultInput {
  /** Methods the remote supports, in the order the dialog lists them. */
  available: AuthMethod[];
  githubAppLinked: boolean;
  preference?: RemoteAuthPreference;
  sshKeyRemembered: boolean;
  patSaved: boolean;
}

/**
 * The method push, pull, fetch and merge dialogs preselect:
 * 1. a linked GitHub App, 2. the method chosen in repository settings,
 * 3. what is already set up for this repository (remembered SSH key, saved token),
 * 4. the Git identity (the system's own Git setup: ssh-agent, Git Credential Manager).
 */
export function remoteAuthDefault(i: RemoteAuthDefaultInput): { method: AuthMethod | null; source: DefaultSource } {
  const has = (m: AuthMethod) => i.available.includes(m);
  if (i.available.length === 1) return { method: i.available[0], source: 'default' };
  if (i.githubAppLinked && has('github-app')) return { method: 'github-app', source: 'github-app' };
  if (i.preference && has(i.preference)) return { method: i.preference, source: 'repo-setting' };
  if (i.sshKeyRemembered && has('ssh')) return { method: 'ssh', source: 'remembered' };
  if (i.patSaved && has('pat')) return { method: 'pat', source: 'remembered' };
  if (has('system')) return { method: 'system', source: 'default' };
  return { method: i.available[0] ?? null, source: 'default' };
}

/**
 * The commit signing the commit dialog preselects: the repository setting, else git config
 * (commit.gpgsign=true signs), else unsigned. `signedMethod` is the signing that matches
 * gpg.format (gpg, ssh or x509); null when signing is not offered.
 */
export function commitSigningDefault(i: { preference?: CommitSigningPreference; commitGpgSign: boolean; signedMethod: SigningMethod | null }): { method: SigningMethod; source: DefaultSource } {
  if (i.preference === 'unsigned') return { method: 'none', source: 'repo-setting' };
  if (i.preference === 'signed' && i.signedMethod) return { method: i.signedMethod, source: 'repo-setting' };
  if (i.commitGpgSign && i.signedMethod) return { method: i.signedMethod, source: 'git-config' };
  return { method: 'none', source: 'default' };
}
