import type { GitHubAccount, RepoRecord } from '../../shared/types';
import { AppError } from '../git/errors';
import type { ParsedRemote } from '../git/remoteUrl';
import type { AccountStore } from './AccountStore';

/**
 * The account a repository belongs to: the one chosen in its settings, else the account that
 * owns the remote's owner (personal login first, then organisation membership — preferring the
 * active account when several are members). Null when no added account matches.
 */
export function repoOwnerAccount(accounts: AccountStore, repo: RepoRecord, parsed: ParsedRemote | null): GitHubAccount | null {
  const explicit = repo.settings.accountId ? accounts.get(repo.settings.accountId) : undefined;
  if (explicit) return explicit;
  if (!parsed?.isGitHub || !parsed.owner) return null;
  return accounts.matchOwner(parsed.owner)?.account ?? null;
}

/**
 * One account at a time: commits, pushes and GitHub features of a repository that belongs to
 * another added account need that account to be the active one. Repositories that match no
 * added account (local, other servers, third-party repos) are not restricted.
 */
export function assertRepoAccountActive(accounts: AccountStore, repo: RepoRecord, parsed: ParsedRemote | null, what: string): void {
  const owner = repoOwnerAccount(accounts, repo, parsed);
  if (!owner) return;
  const activeId = accounts.activeId();
  if (owner.id === activeId) return;
  const active = activeId ? accounts.get(activeId) : undefined;
  throw new AppError({
    code: 'switch-account',
    title: `Switch to ${owner.login}`,
    message: `${repo.name} belongs to ${owner.login}${active ? `, but you are using ${active.login}` : ''}. Switch to ${owner.login} to ${what}.`,
    actions: ['switch-account'],
    switchAccount: { accountId: owner.id, login: owner.login },
  });
}
