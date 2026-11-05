import { describe, expect, it } from 'vitest';
import { commitSigningDefault, remoteAuthDefault } from '../src/shared/authDefaults';

const all = ['pat', 'github-app', 'ssh', 'system'] as const;
const base = { available: [...all], githubAppLinked: false, sshKeyRemembered: false, patSaved: false };

describe('remoteAuthDefault', () => {
  it('falls back to the Git identity when nothing is set up', () => {
    expect(remoteAuthDefault(base)).toEqual({ method: 'system', source: 'default' });
  });
  it('prefers a linked GitHub App over everything else', () => {
    expect(remoteAuthDefault({ ...base, githubAppLinked: true, preference: 'ssh', patSaved: true })).toEqual({ method: 'github-app', source: 'github-app' });
  });
  it('uses the repository setting next', () => {
    expect(remoteAuthDefault({ ...base, preference: 'pat', sshKeyRemembered: true })).toEqual({ method: 'pat', source: 'repo-setting' });
  });
  it('uses what is already set up before the Git identity', () => {
    expect(remoteAuthDefault({ ...base, sshKeyRemembered: true })).toEqual({ method: 'ssh', source: 'remembered' });
    expect(remoteAuthDefault({ ...base, patSaved: true })).toEqual({ method: 'pat', source: 'remembered' });
  });
  it('ignores a preference the remote cannot use', () => {
    expect(remoteAuthDefault({ ...base, available: ['pat', 'system'], preference: 'ssh' })).toEqual({ method: 'system', source: 'default' });
  });
  it('picks the only method when there is one', () => {
    expect(remoteAuthDefault({ ...base, available: ['none'], githubAppLinked: true })).toEqual({ method: 'none', source: 'default' });
  });
});

describe('commitSigningDefault', () => {
  it('is unsigned when nothing is configured', () => {
    expect(commitSigningDefault({ commitGpgSign: false, signedMethod: 'gpg' })).toEqual({ method: 'none', source: 'default' });
  });
  it('follows git config commit.gpgsign', () => {
    expect(commitSigningDefault({ commitGpgSign: true, signedMethod: 'ssh' })).toEqual({ method: 'ssh', source: 'git-config' });
  });
  it('lets the repository setting override git config', () => {
    expect(commitSigningDefault({ preference: 'unsigned', commitGpgSign: true, signedMethod: 'gpg' })).toEqual({ method: 'none', source: 'repo-setting' });
    expect(commitSigningDefault({ preference: 'signed', commitGpgSign: false, signedMethod: 'gpg' })).toEqual({ method: 'gpg', source: 'repo-setting' });
  });
});
