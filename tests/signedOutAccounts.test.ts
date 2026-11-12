import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/main/accounts/AccountStore';

describe('signed-out accounts', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-so-'));
    file = path.join(dir, 'accounts.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('takes the account out of the list and remembers it for its repositories', () => {
    const s = new AccountStore(file);
    const a = s.upsert('alice', 'Alice', ['acme']);
    const b = s.upsert('bob', null, []);
    s.remove(a.id);
    expect(s.list().map((x) => x.login)).toEqual(['bob']);
    expect(s.activeId()).toBe(b.id);
    expect(s.signedOutList().map((x) => x.login)).toEqual(['alice']);

    // Linked repository, personal repository and organisation repository all ask for alice.
    expect(s.missingFor(a.id, 'whoever')?.account.login).toBe('alice');
    expect(s.missingFor(undefined, 'alice')).toMatchObject({ account: { login: 'alice' }, viaOrg: null });
    expect(s.missingFor(undefined, 'ACME')).toMatchObject({ account: { login: 'alice' }, viaOrg: 'ACME' });
    // Repositories of present accounts or unknown owners are not affected.
    expect(s.missingFor(undefined, 'bob')).toBeNull();
    expect(s.missingFor(undefined, 'someone-else')).toBeNull();
    expect(s.missingFor(undefined, null)).toBeNull();

    // Persisted.
    expect(new AccountStore(file).signedOutList().map((x) => x.login)).toEqual(['alice']);
  });

  it('signing in again restores the same id, so linked repositories find it', () => {
    const s = new AccountStore(file);
    const a = s.upsert('alice', null, []);
    s.remove(a.id);
    const back = s.upsert('alice', null, []);
    expect(back.id).toBe(a.id);
    expect(s.signedOutList()).toEqual([]);
    expect(s.missingFor(a.id, 'alice')).toBeNull();
  });

  it('reads older account files without a signed-out list', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, activeAccountId: null, accounts: [] }));
    expect(new AccountStore(file).signedOutList()).toEqual([]);
  });
});
