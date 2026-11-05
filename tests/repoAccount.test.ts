import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/main/accounts/AccountStore';
import { assertRepoAccountActive, repoOwnerAccount } from '../src/main/accounts/repoAccount';
import { parseRemoteUrl } from '../src/main/git/remoteUrl';
import type { RepoRecord } from '../src/shared/types';

const repo = (name: string, accountId?: string): RepoRecord => ({ id: name, name, path: '', addedAt: '', settings: { runHooks: false, allowSystemCredentials: false, allowSavedCredentials: false, accountId } });

describe('one active account at a time', () => {
  const store = () => new AccountStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-acc-')), 'a.json'));

  it('allows repos of the active account and refuses those of another added account', () => {
    const accounts = store();
    const a = accounts.upsert('alice', null, ['acme']);
    const b = accounts.upsert('bob', null, ['bobcorp']);
    accounts.setActive(a.id);
    const own = parseRemoteUrl('https://github.com/alice/site.git');
    const org = parseRemoteUrl('https://github.com/acme/app.git');
    const bobs = parseRemoteUrl('git@github.com:bobcorp/api.git');
    expect(() => assertRepoAccountActive(accounts, repo('site'), own, 'push')).not.toThrow();
    expect(() => assertRepoAccountActive(accounts, repo('app'), org, 'push')).not.toThrow();
    let err: unknown;
    try {
      assertRepoAccountActive(accounts, repo('api'), bobs, 'push');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ friendly: { code: 'switch-account', switchAccount: { accountId: b.id, login: 'bob' } } });
    accounts.setActive(b.id);
    expect(() => assertRepoAccountActive(accounts, repo('api'), bobs, 'push')).not.toThrow();
    expect(() => assertRepoAccountActive(accounts, repo('site'), own, 'commit')).toThrow(/Switch to alice/);
  });

  it('does not restrict repos that match no added account, and honours an explicit choice', () => {
    const accounts = store();
    const a = accounts.upsert('alice', null, []);
    const b = accounts.upsert('bob', null, []);
    accounts.setActive(a.id);
    expect(() => assertRepoAccountActive(accounts, repo('oss'), parseRemoteUrl('https://github.com/torvalds/linux.git'), 'pull')).not.toThrow();
    expect(() => assertRepoAccountActive(accounts, repo('local'), null, 'commit')).not.toThrow();
    expect(repoOwnerAccount(accounts, repo('x', b.id), parseRemoteUrl('https://github.com/alice/x.git'))?.login).toBe('bob');
  });

  it('prefers the active account for an organisation both accounts belong to', () => {
    const accounts = store();
    accounts.upsert('alice', null, ['shared']);
    const b = accounts.upsert('bob', null, ['shared']);
    accounts.setActive(b.id);
    expect(() => assertRepoAccountActive(accounts, repo('s'), parseRemoteUrl('https://github.com/shared/s.git'), 'push')).not.toThrow();
  });
});
