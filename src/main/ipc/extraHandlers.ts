import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { clipboard, shell } from 'electron';
import type { ApiMap } from '../../shared/api';
import type { AccountCredentialInput, AccountsState, AuthInput, CreateRepoInput, HistoryQuery, RepoSummary } from '../../shared/types';
import { authenticateAccount, describeScopes, verifyToken } from '../accounts/accountAuth';
import type { AppContext } from '../context';
import { AppError } from '../git/errors';
import { DEFAULT_API_BASE, validateApiBaseUrl } from '../github/GitHubService';
import { resolveInsideRepo } from '../util/paths';
import {
  asBoolean,
  asEnum,
  asFolderName,
  asGitHubName,
  asId,
  asInt,
  asLine,
  asObject,
  asOptionalBoolean,
  asOptionalString,
  asString,
  asStringArray,
  ValidationError,
} from '../util/validate';
import { CloneWorkflows } from '../workflows/cloneRepo';
import { CreateRepoWorkflows } from '../workflows/createRepo';
import { asConfirmed, parseAuthInput } from './authInput';
import { createAccountSignInHandlers, type AccountSignInChannels } from './accountHandlers';
import type { ResolvedAuth } from '../github/authResolver';

type Handler<C extends keyof ApiMap> = (payload: unknown) => Promise<ApiMap[C]['res']>;
type HandlerMap<K extends keyof ApiMap> = { [C in K]: Handler<C> };

export type ExtraChannels =
  | 'accounts:list'
  | 'accounts:add'
  | 'accounts:authenticate'
  | 'accounts:setActive'
  | 'accounts:remove'
  | 'accounts:forgetCredential'
  | AccountSignInChannels
  | 'repo:setAccount'
  | 'create:start'
  | 'create:authenticate'
  | 'create:retry'
  | 'create:fix'
  | 'create:cancel'
  | 'clone:listRepos'
  | 'clone:resolveFolder'
  | 'clone:start'
  | 'clone:authenticate'
  | 'clone:cancel'
  | 'clone:removeLeftover'
  | 'graph:log'
  | 'graph:refs'
  | 'graph:recentTags'
  | 'graph:authors'
  | 'graph:commit'
  | 'graph:compare'
  | 'graph:fileAt'
  | 'graph:reveal'
  | 'graph:branchChanges'
  | 'graph:mergeForecast'
  | 'code:info'
  | 'code:tree'
  | 'code:lastCommits'
  | 'code:file'
  | 'code:search'
  | 'code:writeFile'
  | 'code:deleteFile'
  | 'app:copyText';

export function parseAccountCredential(value: unknown): AccountCredentialInput {
  const o = asObject(value, 'credential');
  const useRemembered = asOptionalBoolean(o.useRemembered, 'useRemembered') ?? false;
  const useCli = !useRemembered && (asOptionalBoolean(o.useCli, 'useCli') ?? false);
  return {
    accountId: asId(o.accountId, 'accountId'),
    useRemembered,
    useCli: useCli || undefined,
    token: useRemembered || useCli ? undefined : asString(o.token, 'Token', { max: 512 }),
    remember: asOptionalBoolean(o.remember, 'remember') ?? false,
  };
}

export function createExtraHandlers(
  ctx: AppContext,
  helpers: {
    summarize: (repo: import('../../shared/types').RepoRecord) => Promise<RepoSummary>;
    resolveCloneAuth: (url: string, auth: AuthInput) => Promise<ResolvedAuth>;
  },
): HandlerMap<ExtraChannels> {
  const creates = new CreateRepoWorkflows(ctx);
  const clones = new CloneWorkflows(ctx, helpers.resolveCloneAuth);
  const deps = () => ({ accounts: ctx.accounts, accountSecrets: ctx.accountSecrets, githubFor: (b: string) => ctx.githubFor(b) });

  const accountsState = (): AccountsState => {
    const active = ctx.accounts.activeId();
    return {
      accounts: ctx.accounts.list().map((a) => ({ ...a, active: a.id === active, remembered: ctx.accountSecrets.has(a.id) })),
      activeAccountId: active,
      encryptionAvailable: ctx.accountSecrets.available(),
    };
  };

  const graphGit = (p: Record<string, unknown>) => ctx.git(p.repoId).git;
  /** Branch, remote branch, tag or commit id (validated again in GitService). */
  const asRef = (v: unknown, name: string) => asString(v, name, { max: 255, pattern: /^[^-\s~^:?*[\\][^\s~^:?*[\\]*$/ });
  const asHash = (v: unknown, name: string) => asString(v, name, { pattern: /^[0-9a-f]{40}([0-9a-f]{24})?$/, max: 64 });

  return {
    // ---------------- accounts ----------------
    'accounts:list': async () => accountsState(),

    'accounts:add': async (payload) => {
      const p = asObject(payload);
      let token = asString(p.token, 'Token', { max: 512 });
      const remember = asBoolean(p.remember, 'remember');
      const apiBaseUrl = p.apiBaseUrl ? validateApiBaseUrl(asLine(p.apiBaseUrl, 'API URL', { max: 300 })) : undefined;
      const gh = ctx.githubFor(apiBaseUrl ?? DEFAULT_API_BASE);
      const verified = await verifyToken(gh, token);
      const signIn = asOptionalBoolean(p.signIn, 'signIn') ?? false;
      const account = ctx.accounts.upsert(verified.login, verified.name, verified.orgs, apiBaseUrl, 'token');
      if (remember) ctx.accountSecrets.save(account.id, token);
      // Optional: start the in-memory session now so GitHub features work without asking for the token again.
      if (signIn) await ctx.sessions.signIn({ accountId: account.id, token, remember: false }).catch(() => undefined);
      token = '';
      ctx.recordOperation(null, 'Add GitHub account', 'SUCCESS', `${account.login}${remember ? ' (credential remembered in OS keychain)' : ' (credential not stored)'}`);
      const state = accountsState();
      return { state, account: state.accounts.find((a) => a.id === account.id)!, scopes: describeScopes(verified.scopes) };
    },

    'accounts:authenticate': async (payload) => {
      const credential = parseAccountCredential(asObject(payload).credential);
      const auth = await authenticateAccount(deps(), credential);
      auth.release();
      ctx.recordOperation(null, 'Authenticate account', 'SUCCESS', auth.account.login);
      return { state: accountsState(), verified: auth.verified, scopes: describeScopes(auth.verified.scopes) };
    },

    'accounts:setActive': async (payload) => {
      const id = asObject(payload).accountId;
      // Switching only changes the default for NEW operations; repositories keep their own settings.
      ctx.accounts.setActive(id === null ? null : asId(id, 'accountId'));
      return accountsState();
    },

    'accounts:remove': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const id = asId(p.accountId, 'accountId');
      const account = ctx.accounts.get(id);
      ctx.sessions.end(id); // drop the in-memory session token immediately
      ctx.accountSecrets.forget(id);
      ctx.accounts.remove(id);
      // Repositories keep working with their local Git configuration; only the association is cleared.
      for (const r of ctx.repos.list()) if (r.settings.accountId === id) ctx.repos.updateSettings(r.id, { accountId: undefined });
      ctx.recordOperation(null, 'Remove GitHub account', 'SUCCESS', `${account?.login ?? id} removed from the app (repositories untouched)`);
      return accountsState();
    },

    ...createAccountSignInHandlers(ctx, accountsState),

    'accounts:forgetCredential': async (payload) => {
      const id = asId(asObject(payload).accountId, 'accountId');
      ctx.accountSecrets.forget(id);
      ctx.recordOperation(null, 'Forget account credential', 'SUCCESS', ctx.accounts.get(id)?.login ?? id);
      return accountsState();
    },

    'repo:setAccount': async (payload) => {
      const p = asObject(payload);
      const repo = ctx.repo(p.repoId);
      const accountId = p.accountId === null ? undefined : asId(p.accountId, 'accountId');
      if (accountId && !ctx.accounts.get(accountId)) throw new ValidationError('Unknown account');
      return helpers.summarize(ctx.repos.updateSettings(repo.id, { accountId }));
    },

    // ---------------- create repository ----------------
    'create:start': async (payload) => {
      const i = asObject(asObject(payload).input, 'input');
      const localOnly = asBoolean(i.localOnly, 'localOnly');
      const input: CreateRepoInput = {
        selectionId: asId(i.selectionId, 'selectionId'),
        folderName: i.folderName ? asFolderName(i.folderName) : undefined,
        accountId: localOnly || !i.accountId ? null : asId(i.accountId, 'accountId'),
        name: asGitHubName(i.name, 'Repository name'),
        owner: localOnly ? '' : asGitHubName(i.owner, 'Owner'),
        visibility: asEnum(i.visibility, 'visibility', ['private', 'public'] as const),
        description: asOptionalString(i.description, 'description', { max: 350 }),
        localOnly,
      };
      const parent = ctx.consumePick(input.selectionId, ['create', 'open']);
      return creates.start(input, parent);
    },
    'create:authenticate': async (payload) => {
      const p = asObject(payload);
      return creates.authenticate(asId(p.workflowId, 'workflowId'), parseAccountCredential(p.credential));
    },
    'create:retry': async (payload) => creates.retry(asId(asObject(payload).workflowId, 'workflowId')),
    'create:fix': async (payload) => {
      const p = asObject(payload);
      return creates.fix(asId(p.workflowId, 'workflowId'), asEnum(p.fixId, 'fix', ['replace-remote', 'use-existing', 'init-nested'] as const));
    },
    'create:cancel': async (payload) => creates.cancel(asId(asObject(payload).workflowId, 'workflowId')),

    // ---------------- clone ----------------
    'clone:listRepos': async (payload) => {
      const credential = parseAccountCredential(asObject(payload).credential);
      const auth = await authenticateAccount(deps(), credential);
      try {
        return { login: auth.account.login, repos: await auth.gh.listUserRepositories(auth.token) };
      } finally {
        auth.release();
      }
    },
    /**
     * A folder the user typed. It is only usable for a clone once it is registered here (absolute path,
     * a real directory, created on request) so the clone workflow still receives a validated selection.
     */
    'clone:resolveFolder': async (payload) => {
      const p = asObject(payload);
      const raw = typeof p.path === 'string' ? p.path.trim().replace(/^"(.*)"$/, '$1') : '';
      const register = asOptionalBoolean(p.register, 'register') ?? false;
      const create = asOptionalBoolean(p.create, 'create') ?? false;
      const expanded = raw.startsWith('~') ? nodePath.join(os.homedir(), raw.slice(1)) : raw;
      const target = nodePath.resolve(expanded || nodePath.parse(os.homedir()).root);
      if (raw && !nodePath.isAbsolute(expanded)) {
        throw new AppError({ code: 'invalid-path', title: 'Invalid Folder', message: 'Enter a full folder path, e.g. C:\\Workspace\\github-repo.' });
      }
      if (/[\0\r\n]/.test(target) || target.length > 1024) throw new AppError({ code: 'invalid-path', title: 'Invalid Folder', message: 'The folder path contains invalid characters.' });
      let stat = await fs.stat(target).catch(() => null);
      if (!stat && register && create) {
        await fs.mkdir(target, { recursive: true });
        stat = await fs.stat(target).catch(() => null);
      }
      const isDirectory = !!stat?.isDirectory();
      const selectionId = register && isDirectory ? ctx.registerPick(target, 'clone-parent') : null;
      return { path: target, exists: !!stat, isDirectory, selectionId };
    },
    'clone:start': async (payload) => {
      const i = asObject(asObject(payload).input, 'input');
      const parent = ctx.consumePick(i.selectionId, ['clone-parent']);
      return clones.start(
        {
          selectionId: '',
          folderName: i.folderName ? asFolderName(i.folderName) : '',
          repository: asLine(i.repository, 'Repository', { max: 2048 }),
          accountId: i.accountId ? asId(i.accountId, 'accountId') : null,
        },
        parent,
      );
    },
    'clone:authenticate': async (payload) => {
      const p = asObject(payload);
      const id = asId(p.workflowId, 'workflowId');
      const credential = p.credential ? parseAccountCredential(p.credential) : null;
      const other = !credential && p.auth ? parseAuthInput(p.auth) : null;
      if (other && other.method === 'pat') other.saveForRepo = false;
      if (other && other.method === 'github-app') other.saveKeyForRepo = false;
      const state = await clones.authenticate(id, credential, other);
      if (state.phase === 'done' && state.repo?.id) {
        const repo = ctx.repos.get(state.repo.id);
        if (repo) return clones.setRepo(id, await helpers.summarize(repo));
      }
      return state;
    },
    'clone:cancel': async (payload) => clones.cancel(asId(asObject(payload).workflowId, 'workflowId')),
    'clone:removeLeftover': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      return clones.removeLeftover(asId(p.workflowId, 'workflowId'));
    },

    // ---------------- Git History ----------------
    'graph:log': async (payload) => {
      const p = asObject(payload);
      const q = asObject(p.query, 'query');
      const query: HistoryQuery = {
        scope: asEnum(q.scope, 'scope', ['current', 'all', 'remotes', 'tags', 'ref'] as const),
        ref: asOptionalString(q.ref, 'ref', { max: 255 }),
        author: asOptionalString(q.author, 'author', { max: 254 }),
        sinceDays: q.sinceDays === undefined || q.sinceDays === null ? undefined : asInt(q.sinceDays, 'sinceDays', 1, 36500),
        search: asOptionalString(q.search, 'search', { max: 200 }),
        skip: q.skip === undefined ? 0 : asInt(q.skip, 'skip', 0, 10_000_000),
        limit: q.limit === undefined ? 300 : asInt(q.limit, 'limit', 1, 2000),
      };
      return graphGit(p).graphLogDecorated(query);
    },
    'graph:branchChanges': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).branchChanges(asRef(p.branch, 'branch'), p.base ? asRef(p.base, 'base branch') : undefined);
    },
    'graph:mergeForecast': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).mergeForecast(asRef(p.branch, 'branch'), asRef(p.base, 'base branch'));
    },
    'graph:refs': async (payload) => graphGit(asObject(payload)).graphRefs(),
    'graph:recentTags': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).recentTags(p.limit === undefined ? 15 : asInt(p.limit, 'limit', 1, 100));
    },
    'graph:authors': async (payload) => graphGit(asObject(payload)).graphAuthors(),
    'graph:commit': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).commitDetails(asHash(p.hash, 'commit'));
    },
    'graph:compare': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).compareCommits(asHash(p.from, 'from'), asHash(p.to, 'to'));
    },
    'graph:fileAt': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).fileAtCommit(asHash(p.hash, 'commit'), asString(p.path, 'path', { trim: false }));
    },
    'graph:reveal': async (payload) => {
      const p = asObject(payload);
      const { repo } = ctx.git(p.repoId);
      // Reveal only (never "open"): opening could execute a script from the repository.
      const full = resolveInsideRepo(repo.path, asString(p.path, 'path', { trim: false }));
      shell.showItemInFolder(full);
    },

    // ---------------- Code browser ----------------
    'code:info': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).codeInfo(p.ref ? asRef(p.ref, 'branch') : undefined);
    },
    'code:tree': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).codeTree(asRef(p.ref, 'branch'), asString(p.path ?? '', 'path', { min: 0, max: 4096, trim: false }));
    },
    'code:lastCommits': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).codeLastCommits(asRef(p.ref, 'branch'), asStringArray(p.paths, 'paths', 200));
    },
    'code:file': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).codeFile(asRef(p.ref, 'branch'), asString(p.path, 'path', { trim: false }));
    },
    'code:search': async (payload) => {
      const p = asObject(payload);
      return graphGit(p).codeSearch(asRef(p.ref, 'branch'), asString(p.query, 'search', { min: 2, max: 200 }));
    },
    'code:writeFile': async (payload) => {
      const p = asObject(payload);
      const { repo, git } = ctx.git(p.repoId);
      const rel = asString(p.path, 'path', { max: 1024 }).replace(/\\/g, '/');
      const full = resolveInsideRepo(repo.path, rel);
      const create = asBoolean(p.create, 'create');
      let content = asString(p.content, 'content', { min: 0, max: 5 * 1024 * 1024, trim: false });
      await ctx.withLock(repo.id, async () => {
        const existing = await fs.readFile(full).catch(() => null);
        if (create && existing) throw new AppError({ code: 'file-exists', title: 'File Already Exists', message: `${rel} already exists. Open it to edit instead.` });
        if (!create && !existing) throw new AppError({ code: 'file-missing', title: 'File Not Found', message: `${rel} no longer exists in your working copy.` });
        // Keep Windows line endings when the file already used them.
        if (existing?.includes('\r\n') && !content.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
        await fs.mkdir(nodePath.dirname(full), { recursive: true });
        await fs.writeFile(full, content, { encoding: 'utf8', flag: create ? 'wx' : 'w' });
        await git.stage([rel]);
      });
      ctx.recordOperation(repo, create ? 'Create file' : 'Edit file', 'SUCCESS', rel);
    },
    'code:deleteFile': async (payload) => {
      const p = asObject(payload);
      asConfirmed(p.confirmed);
      const { repo, git } = ctx.git(p.repoId);
      const rel = asString(p.path, 'path', { max: 1024 }).replace(/\\/g, '/');
      const full = resolveInsideRepo(repo.path, rel);
      await ctx.withLock(repo.id, async () => {
        const st = await fs.lstat(full).catch(() => null);
        if (!st || !st.isFile()) throw new AppError({ code: 'file-missing', title: 'File Not Found', message: `${rel} is not a file in your working copy.` });
        await fs.rm(full);
        // Untracked files have nothing to stage.
        await git.stage([rel]).catch(() => undefined);
      });
      ctx.recordOperation(repo, 'Delete file', 'SUCCESS', rel);
    },
    'app:copyText': async (payload) => {
      const text = asString(asObject(payload).text, 'text', { max: 10_000, trim: false });
      if (/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|PRIVATE KEY/.test(text)) throw new AppError({ code: 'refused', title: 'Not Copied', message: 'Credentials are not copied through this action.' });
      await clipboard.writeText(text);
    },
  };
}
