import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitHubAccount, SignedOutAccount } from '../../shared/types';
import type { Encryptor } from '../repositories/SecretStore';
import { readJson, writeJson } from '../repositories/jsonFile';
import { ID_PATTERN } from '../util/validate';

interface AccountsFile {
  version: 1;
  activeAccountId: string | null;
  accounts: GitHubAccount[];
  /** Accounts signed out or removed, so their repositories can ask for them again. */
  signedOut?: SignedOutAccount[];
}

const MAX_SIGNED_OUT = 50;

/**
 * GitHub accounts known to the app: identity only (login, name, organisations).
 * Never contains a token. The "active" account is only a default for new
 * operations — it never changes how existing repositories authenticate.
 */
export class AccountStore {
  private data: AccountsFile;

  constructor(private readonly file: string) {
    const d = readJson<Partial<AccountsFile>>(file, {});
    this.data = {
      version: 1,
      activeAccountId: d.activeAccountId ?? null,
      accounts: Array.isArray(d.accounts) ? d.accounts : [],
      signedOut: Array.isArray(d.signedOut) ? d.signedOut.filter((s) => s && typeof s.login === 'string' && typeof s.id === 'string') : [],
    };
  }

  private save(): void {
    writeJson(this.file, this.data);
  }

  list(): GitHubAccount[] {
    return this.data.accounts.map((a) => ({ ...a, orgs: [...a.orgs] }));
  }

  get(id: string): GitHubAccount | undefined {
    return this.data.accounts.find((a) => a.id === id);
  }

  findByLogin(login: string): GitHubAccount | undefined {
    return this.data.accounts.find((a) => a.login.toLowerCase() === login.toLowerCase());
  }

  activeId(): string | null {
    return this.data.activeAccountId && this.get(this.data.activeAccountId) ? this.data.activeAccountId : null;
  }

  setActive(id: string | null): void {
    if (id && !this.get(id)) throw new Error('Unknown account');
    this.data.activeAccountId = id;
    this.save();
  }

  /**
   * Adds or refreshes an account after its identity was verified (token with GitHub, or an SSH key).
   * An SSH check never downgrades an account that was already verified with a token.
   */
  upsert(login: string, name: string | null, orgs: string[], apiBaseUrl?: string, method: GitHubAccount['method'] = 'token'): GitHubAccount {
    const existing = this.findByLogin(login);
    const now = new Date().toISOString();
    if (existing) {
      const keep = method === 'ssh' && existing.method !== 'ssh';
      Object.assign(existing, keep ? { lastVerifiedAt: now } : { login, name, orgs, lastVerifiedAt: now, apiBaseUrl, method });
      this.save();
      return existing;
    }
    // Signing in again to a signed-out account keeps its id, so repositories linked to it find it again.
    const back = this.findSignedOut(login);
    const id = back && !this.get(back.id) ? back.id : crypto.randomBytes(12).toString('base64url');
    this.data.signedOut = (this.data.signedOut ?? []).filter((s) => s.login.toLowerCase() !== login.toLowerCase());
    const account: GitHubAccount = { id, login, name, orgs, addedAt: now, lastVerifiedAt: now, apiBaseUrl, method };
    this.data.accounts.push(account);
    if (!this.data.activeAccountId) this.data.activeAccountId = account.id;
    this.save();
    return account;
  }

  remove(id: string): void {
    const gone = this.get(id);
    if (gone) {
      const rest = (this.data.signedOut ?? []).filter((s) => s.login.toLowerCase() !== gone.login.toLowerCase());
      this.data.signedOut = [{ id: gone.id, login: gone.login, name: gone.name, orgs: [...gone.orgs], apiBaseUrl: gone.apiBaseUrl, at: new Date().toISOString() }, ...rest].slice(0, MAX_SIGNED_OUT);
    }
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.activeAccountId === id) this.data.activeAccountId = this.data.accounts[0]?.id ?? null;
    this.save();
  }

  /** Accounts signed out of the app, newest first. */
  signedOutList(): SignedOutAccount[] {
    return (this.data.signedOut ?? []).filter((s) => !this.findByLogin(s.login)).map((s) => ({ ...s, orgs: [...s.orgs] }));
  }

  findSignedOut(login: string): SignedOutAccount | undefined {
    return (this.data.signedOut ?? []).find((s) => s.login.toLowerCase() === login.toLowerCase());
  }

  /**
   * The signed-out account a repository needs: the one it was linked to, else the one that owned or belonged to
   * its owner. Null when an added account already covers it, or no known account ever did.
   */
  missingFor(linkedId: string | undefined, owner: string | null): { account: SignedOutAccount; viaOrg: string | null } | null {
    const list = this.signedOutList();
    if (linkedId && !this.get(linkedId)) {
      const linked = list.find((s) => s.id === linkedId);
      if (linked) return { account: linked, viaOrg: owner && owner.toLowerCase() !== linked.login.toLowerCase() ? owner : null };
    }
    if (!owner || this.matchOwner(owner)) return null;
    const o = owner.toLowerCase();
    const personal = list.find((s) => s.login.toLowerCase() === o);
    if (personal) return { account: personal, viaOrg: null };
    const member = list.find((s) => s.orgs.some((g) => g.toLowerCase() === o));
    return member ? { account: member, viaOrg: owner } : null;
  }

  /** The account that owns or belongs to `owner` (personal account first, then organisation membership). */
  matchOwner(owner: string): { account: GitHubAccount; personal: boolean } | null {
    const o = owner.toLowerCase();
    const personal = this.data.accounts.find((a) => a.login.toLowerCase() === o);
    if (personal) return { account: personal, personal: true };
    const member = this.data.accounts.filter((a) => a.orgs.some((g) => g.toLowerCase() === o));
    if (member.length === 0) return null;
    // Prefer the active account when several accounts belong to the organisation.
    const active = member.find((a) => a.id === this.data.activeAccountId);
    return { account: active ?? member[0], personal: false };
  }
}

/**
 * Account tokens the user explicitly asked to remember ("Remember this credential"),
 * encrypted with the OS keychain via Electron safeStorage. One file per account.
 */
export class AccountSecretStore {
  constructor(
    private readonly dir: string,
    private readonly encryptor: Encryptor,
  ) {}

  private fileFor(accountId: string): string {
    if (!ID_PATTERN.test(accountId)) throw new Error('Invalid account id');
    return path.join(this.dir, `${accountId}.bin`);
  }

  available(): boolean {
    return this.encryptor.isAvailable();
  }

  has(accountId: string): boolean {
    return fs.existsSync(this.fileFor(accountId));
  }

  save(accountId: string, token: string): void {
    if (!this.encryptor.isAvailable()) throw new Error('Secure storage (OS keychain) is not available on this system; the credential cannot be remembered.');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(accountId), this.encryptor.encrypt(token), { mode: 0o600 });
  }

  get(accountId: string): string | null {
    const f = this.fileFor(accountId);
    if (!fs.existsSync(f) || !this.encryptor.isAvailable()) return null;
    try {
      return this.encryptor.decrypt(fs.readFileSync(f));
    } catch {
      return null;
    }
  }

  forget(accountId: string): void {
    fs.rmSync(this.fileFor(accountId), { force: true });
  }
}
