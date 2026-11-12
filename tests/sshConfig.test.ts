import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../src/main/git/remoteUrl';
import { parseSshConfig, resolveHostFromBlocks, setSshConfigPathForTests } from '../src/main/git/sshConfig';

describe('SSH host aliases', () => {
  afterEach(() => setSshConfigPathForTests(null));

  it('resolves HostName from ~/.ssh/config (first match wins, wildcards, negation)', () => {
    const blocks = parseSshConfig(`
# work account
Host mahmudx-selise
  HostName github.com
  IdentityFile ~/.ssh/id_work
Host *.corp !skip.corp
  HostName=%h.example.com
Host *
  HostName ignored.example
`);
    expect(resolveHostFromBlocks(blocks, 'mahmudx-selise')).toBe('github.com');
    expect(resolveHostFromBlocks(blocks, 'git.corp')).toBe('git.corp.example.com');
    expect(resolveHostFromBlocks(blocks, 'skip.corp')).toBe('ignored.example');
  });

  it('treats an aliased SSH remote as a GitHub repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ssh-'));
    const file = path.join(dir, 'config');
    fs.writeFileSync(file, 'Host mahmudx-selise\n  HostName github.com\n');
    setSshConfigPathForTests(file);
    const p = parseRemoteUrl('git@mahmudx-selise:Creolytix-GmbH/l3-net-creolytix-engr.git');
    expect(p).toMatchObject({ protocol: 'ssh', host: 'github.com', owner: 'Creolytix-GmbH', repo: 'l3-net-creolytix-engr', isGitHub: true });
    expect(parseRemoteUrl('ssh://git@mahmudx-selise/Creolytix-GmbH/x.git')).toMatchObject({ host: 'github.com', isGitHub: true });
  });

  it('recognises the github.com-<name> alias convention without a config', () => {
    setSshConfigPathForTests(path.join(os.tmpdir(), 'gg-missing-config'));
    expect(parseRemoteUrl('git@github.com-work:org/repo.git')).toMatchObject({ host: 'github.com', isGitHub: true });
    expect(parseRemoteUrl('git@gitlab.com:org/repo.git').isGitHub).toBe(false);
  });
});
