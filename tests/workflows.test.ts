import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { authenticateAccount } from '../src/main/accounts/accountAuth';
import { AccountSecretStore, AccountStore } from '../src/main/accounts/AccountStore';
import { AppContext } from '../src/main/context';
import { GitService } from '../src/main/git/GitService';
import { runGit } from '../src/main/git/runner';
import { GitHubService } from '../src/main/github/GitHubService';
import { HistoryStore } from '../src/main/repositories/HistoryStore';
import { RepoStore } from '../src/main/repositories/RepoStore';
import { SecretStore, type Encryptor } from '../src/main/repositories/SecretStore';
import { CloneWorkflows, normalizeCloneTarget } from '../src/main/workflows/cloneRepo';
import { CreateRepoWorkflows } from '../src/main/workflows/createRepo';
import type { CreateRepoState } from '../src/shared/types';

const enc: Encryptor = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s).toString('base64')),
  decrypt: (b) => Buffer.from(b.toString(), 'base64').toString(),
};

type Route = (init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> };

/** Minimal fake GitHub API: routes keyed by "METHOD /path". */
function fakeGitHub(routes: Record<string, Route>) {
  const calls: string[] = [];
  const impl = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push(key);
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const { status, body, headers } = r(init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  };
  return { impl, calls };
}

let tmp: string;
let ctx: AppContext;

function makeCtx(fetchImpl: ReturnType<typeof fakeGitHub>['impl']): AppContext {
  const dir = fs.mkdtempSync(path.join(tmp, 'ctx-'));
  const c = new AppContext(
    new RepoStore(path.join(dir, 'repos.json')),
    new SecretStore(path.join(dir, 'secrets'), enc),
    new HistoryStore(path.join(dir, 'history.json')),
    path.join(dir, 'backups'),
    new AccountStore(path.join(dir, 'accounts.json')),
    new AccountSecretStore(path.join(dir, 'secrets', 'accounts'), enc),
  );
  c.githubFor = (b: string) => new GitHubService(b, fetchImpl);
  return c;
}

const repoBody = (owner: string, name: string, ownerType = 'User') => ({
  full_name: `${owner}/${name}`,
  name,
  owner: { login: owner, type: ownerType },
  private: true,
  html_url: `https://github.com/${owner}/${name}`,
  clone_url: `https://github.com/${owner}/${name}.git`,
  ssh_url: `git@github.com:${owner}/${name}.git`,
  permissions: { admin: true, push: true, pull: true },
});

const userRoute = (login: string, scopes = 'repo, read:org'): Route => () => ({ status: 200, body: { login, name: 'Dev' }, headers: { 'x-oauth-scopes': scopes } });

async function waitFor(get: () => CreateRepoState, pred: (s: CreateRepoState) => boolean) {
  for (let i = 0; i < 100; i++) {
    if (pred(get())) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-wf-')));
});

describe('accounts', () => {
  it('matches repository owners to personal accounts and organisations', () => {
    const store = new AccountStore(path.join(tmp, 'a.json'));
    const a = store.upsert('jahedul-hasan-kaz', 'J', ['inride']);
    const b = store.upsert('company-account', null, ['inride', 'acme']);
    expect(store.matchOwner('JAHEDUL-HASAN-KAZ')).toMatchObject({ account: { id: a.id }, personal: true });
    expect(store.matchOwner('acme')).toMatchObject({ account: { id: b.id }, personal: false });
    // Several accounts in the org: the active one wins.
    store.setActive(b.id);
    expect(store.matchOwner('inride')?.account.id).toBe(b.id);
    expect(store.matchOwner('unknown')).toBeNull();
    store.remove(b.id);
    expect(store.activeId()).toBe(a.id);
  });

  it('refuses a token that belongs to another account, and only remembers on explicit opt-in', async () => {
    const { impl } = fakeGitHub({ 'GET /user': userRoute('someone-else'), 'GET /user/orgs': () => ({ status: 200, body: [] }) });
    ctx = makeCtx(impl);
    const acc = ctx.accounts.upsert('jahedul-hasan-kaz', null, []);
    const deps = { accounts: ctx.accounts, accountSecrets: ctx.accountSecrets, githubFor: ctx.githubFor };
    await expect(authenticateAccount(deps, { accountId: acc.id, token: 'ghp_x' })).rejects.toMatchObject({ friendly: { code: 'account-mismatch' } });
    expect(ctx.accountSecrets.has(acc.id)).toBe(false);

    const ok = fakeGitHub({ 'GET /user': userRoute('jahedul-hasan-kaz'), 'GET /user/orgs': () => ({ status: 200, body: [{ login: 'inride' }] }) });
    ctx.githubFor = (b) => new GitHubService(b, ok.impl);
    const deps2 = { accounts: ctx.accounts, accountSecrets: ctx.accountSecrets, githubFor: ctx.githubFor };
    const auth = await authenticateAccount(deps2, { accountId: acc.id, token: 'ghp_ok' });
    expect(auth.verified.orgs).toEqual(['inride']);
    expect(ctx.accountSecrets.has(acc.id)).toBe(false); // not remembered without consent
    await authenticateAccount(deps2, { accountId: acc.id, token: 'ghp_ok', remember: true });
    expect(ctx.accountSecrets.get(acc.id)).toBe('ghp_ok');
    expect(ctx.accounts.get(acc.id)?.orgs).toEqual(['inride']); // org list refreshed (non-secret)
  });
});

describe('create repository workflow', () => {
  function setup(routes: Record<string, Route> = {}) {
    const gh = fakeGitHub({
      'GET /user': userRoute('jahedul-hasan-kaz'),
      'GET /user/orgs': () => ({ status: 200, body: [{ login: 'inride' }] }),
      'POST /orgs/inride/repos': () => ({ status: 201, body: repoBody('inride', 'agent-management', 'Organization') }),
      ...routes,
    });
    ctx = makeCtx(gh.impl);
    const acc = ctx.accounts.upsert('jahedul-hasan-kaz', null, ['inride']);
    const flows = new CreateRepoWorkflows(ctx);
    const parent = path.join(tmp, 'projects');
    fs.mkdirSync(parent);
    return { gh, acc, flows, parent };
  }

  it('waits for authentication, then runs every step and adds the repository', async () => {
    const { gh, acc, flows, parent } = setup();
    let state = flows.start({ selectionId: 'x', folderName: 'agent-management', accountId: acc.id, name: 'agent-management', owner: 'inride', visibility: 'private', localOnly: false }, parent);
    expect(state.phase).toBe('awaiting-auth');
    expect(gh.calls).toHaveLength(0); // nothing happens before authentication
    state = await flows.authenticate(state.workflowId, { accountId: acc.id, token: 'ghp_ok' });
    expect(state.phase).toBe('done');
    expect(state.steps.map((s) => s.status)).toEqual(Array(8).fill('done'));
    expect(gh.calls).toContain('POST /orgs/inride/repos');
    const local = path.join(parent, 'agent-management');
    const remotes = await new GitService(local).remotes();
    expect(remotes[0].fetchUrl).toBe('https://github.com/inride/agent-management.git');
    const repo = ctx.repos.get(state.repoId!);
    expect(repo?.settings.accountId).toBe(acc.id);
  });

  it('stops when the name exists, and only uses the existing repo through the explicit fix', async () => {
    const { gh, acc, flows, parent } = setup({ 'GET /repos/inride/agent-management': () => ({ status: 200, body: repoBody('inride', 'agent-management', 'Organization') }) });
    let state = flows.start({ selectionId: 'x', folderName: 'a', accountId: acc.id, name: 'agent-management', owner: 'inride', visibility: 'private', localOnly: false }, parent);
    state = await flows.authenticate(state.workflowId, { accountId: acc.id, token: 'ghp_ok' });
    expect(state.phase).toBe('failed');
    expect(state.steps.find((s) => s.id === 'validate-name')?.error?.code).toBe('repo-exists');
    expect(state.fixes.map((f) => f.id)).toEqual(['use-existing']);
    // A plain retry must not silently adopt the existing repository.
    state = await flows.retry(state.workflowId);
    expect(state.phase).toBe('failed');
    state = await flows.fix(state.workflowId, 'use-existing');
    expect(state.phase).toBe('done');
    expect(gh.calls).not.toContain('POST /orgs/inride/repos'); // never created a duplicate
  });

  it('reports "remote already exists" and fixes it only when asked', async () => {
    const { acc, flows, parent } = setup();
    const local = path.join(parent, 'existing');
    const g = await GitService.init(local, 'main');
    await g.setRemote('origin', 'https://github.com/someone/else.git');
    let state = flows.start({ selectionId: 'x', folderName: 'existing', accountId: acc.id, name: 'agent-management', owner: 'inride', visibility: 'private', localOnly: false }, parent);
    state = await flows.authenticate(state.workflowId, { accountId: acc.id, token: 'ghp_ok' });
    expect(state.phase).toBe('failed');
    const failed = state.steps.find((s) => s.status === 'failed');
    expect(failed?.id).toBe('configure-remote');
    expect(state.incomplete).toMatch(/was created successfully, but the local repository could not be set up/);
    expect((await g.remotes())[0].fetchUrl).toBe('https://github.com/someone/else.git'); // untouched
    state = await flows.fix(state.workflowId, 'replace-remote');
    expect(state.phase).toBe('done');
    expect((await g.remotes())[0].fetchUrl).toBe('https://github.com/inride/agent-management.git');
  });

  it('after a failed create request, inspects GitHub before retrying (no duplicate repositories)', async () => {
    let created = false;
    const { gh, acc, flows, parent } = setup({
      'POST /orgs/inride/repos': () => {
        created = true; // GitHub created it, but the response is an error (e.g. timeout)
        return { status: 502, body: { message: 'Bad gateway' } };
      },
      'GET /repos/inride/agent-management': () => (created ? { status: 200, body: repoBody('inride', 'agent-management', 'Organization') } : { status: 404, body: { message: 'Not Found' } }),
    });
    let state = flows.start({ selectionId: 'x', folderName: 'agent', accountId: acc.id, name: 'agent-management', owner: 'inride', visibility: 'private', localOnly: false }, parent);
    state = await flows.authenticate(state.workflowId, { accountId: acc.id, token: 'ghp_ok' });
    expect(state.steps.find((s) => s.id === 'create-github')?.status).toBe('failed');
    state = await flows.retry(state.workflowId);
    expect(state.phase).toBe('done');
    expect(gh.calls.filter((c) => c === 'POST /orgs/inride/repos')).toHaveLength(1);
  });

  it('refuses classic tokens that cannot create repositories', async () => {
    const { acc, flows, parent } = setup({ 'GET /user': userRoute('jahedul-hasan-kaz', 'read:org') });
    let state = flows.start({ selectionId: 'x', folderName: 'a', accountId: acc.id, name: 'agent-management', owner: 'inride', visibility: 'private', localOnly: false }, parent);
    state = await flows.authenticate(state.workflowId, { accountId: acc.id, token: 'ghp_ok' });
    expect(state.steps.find((s) => s.id === 'validate-account')?.error?.code).toBe('missing-scope');
    expect(fs.existsSync(path.join(parent, 'a'))).toBe(false);
  });

  it('creates a local-only repository without any GitHub call', async () => {
    const { gh, flows, parent } = setup();
    const start = flows.start({ selectionId: 'x', folderName: 'local-only', accountId: null, name: 'local-only', owner: '', visibility: 'private', localOnly: true }, parent);
    await waitFor(() => flows.state(start.workflowId), (s) => s.phase === 'done' || s.phase === 'failed');
    const state = flows.state(start.workflowId);
    expect(state.phase).toBe('done');
    expect(state.steps.filter((s) => s.status === 'skipped').map((s) => s.id)).toEqual(['authenticate', 'validate-account', 'create-github', 'configure-remote']);
    expect(gh.calls).toHaveLength(0);
  });
});

describe('clone workflow', () => {
  it('normalises owner/repo and URLs', () => {
    expect(normalizeCloneTarget('inride/agent-management')).toEqual({ url: 'https://github.com/inride/agent-management.git', owner: 'inride', repo: 'agent-management' });
    expect(normalizeCloneTarget('git@github.com:inride/agent.git')).toMatchObject({ owner: 'inride', repo: 'agent' });
    expect(() => normalizeCloneTarget('ext::sh -c x')).toThrow();
  });

  it('authenticates before cloning, reports progress and adds the repository', async () => {
    const { impl } = fakeGitHub({});
    ctx = makeCtx(impl);
    const events: string[] = [];
    ctx.progress = (e) => events.push(e.kind === 'clone' ? e.state.phase : '');
    const bare = path.join(tmp, 'remote.git');
    await runGit({ cwd: tmp, args: ['init', '--bare', '--initial-branch=main', bare] });
    const seed = await GitService.init(path.join(tmp, 'seed'), 'main');
    await seed.setIdentity('S', 's@example.com');
    fs.writeFileSync(path.join(seed.root, 'f.txt'), 'f\n');
    await seed.stageAll();
    const c = await seed.commit('init', 'none');
    await seed.setRemote('origin', bare);
    await seed.push('origin', c.hash, 'main', { kind: 'none' });

    const flows = new CloneWorkflows(ctx, async () => ({ git: { kind: 'none' }, description: 'No authentication (local remote)', secrets: [], cleanup: async () => {} }));
    const parent = path.join(tmp, 'clones');
    fs.mkdirSync(parent);
    let state = flows.start({ selectionId: '', folderName: 'copy', repository: bare, accountId: null }, parent);
    expect(state.phase).toBe('awaiting-auth');
    expect(fs.existsSync(path.join(parent, 'copy'))).toBe(false);
    state = await flows.authenticate(state.workflowId, null, { method: 'none' });
    expect(state.phase).toBe('done');
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'skipped', 'done', 'done', 'done']);
    expect(fs.existsSync(path.join(parent, 'copy', 'f.txt'))).toBe(true);
    expect(events).toContain('running');
    expect(ctx.repos.list()).toHaveLength(1);
  });
});

describe('Git History queries', () => {
  it('returns parents, refs, filters by author/message, details with stats, compare and file content', async () => {
    const g = await GitService.init(path.join(tmp, 'hist'), 'main');
    await g.setIdentity('Alice', 'alice@example.com');
    fs.writeFileSync(path.join(g.root, 'a.txt'), 'one\n');
    await g.stageAll();
    const c1 = await g.commit('Add a', 'none');
    await g.createBranch('feature', null, true);
    fs.writeFileSync(path.join(g.root, 'b.txt'), 'b\n');
    await g.stageAll();
    const c2 = await g.commit('Fix authentication validation', 'none');
    await g.switchBranch('main');
    await runGit({ cwd: g.root, args: ['-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '--allow-empty', '-m', 'Bob change'] });
    await runGit({ cwd: g.root, args: ['merge', '--no-ff', '--no-edit', 'feature'] });
    await runGit({ cwd: g.root, args: ['tag', 'v1.0'] });

    const all = await g.graphLog({ scope: 'all' });
    const merge = all.commits[0];
    expect(merge.parents).toHaveLength(2);
    expect(merge.refs.join(' ')).toMatch(/HEAD -> main/);
    expect(merge.refs.join(' ')).toMatch(/tag: v1.0/);
    expect((await g.graphLog({ scope: 'all', author: 'bob@example.com' })).commits.map((c) => c.subject)).toEqual(['Bob change']);
    expect((await g.graphLog({ scope: 'all', search: 'AUTHENTICATION' })).commits.map((c) => c.hash)).toEqual([c2.hash]);
    expect((await g.graphLog({ scope: 'all', search: c1.hash.slice(0, 7) })).commits.map((c) => c.hash)).toEqual([c1.hash]);
    expect((await g.graphLog({ scope: 'ref', ref: 'feature' })).commits).toHaveLength(2);
    expect((await g.graphLog({ scope: 'all', limit: 2 })).hasMore).toBe(true);

    const refs = await g.graphRefs();
    expect(refs).toMatchObject({ current: 'main', branches: ['feature', 'main'], tags: ['v1.0'] });
    expect((await g.graphAuthors()).map((a) => a.name).sort()).toEqual(['Alice', 'Bob']);

    const d = await g.commitDetails(c2.hash);
    expect(d).toMatchObject({ subject: 'Fix authentication validation', additions: 1, deletions: 0, isMerge: false });
    expect(d.files).toEqual([{ path: 'b.txt', status: 'added', additions: 1, deletions: 0, binary: false }]);
    expect(d.diffs[0].newPath).toBe('b.txt');
    const root = await g.commitDetails(c1.hash); // root commit (no parent) diffs against the empty tree
    expect(root.files.map((f) => f.path)).toEqual(['a.txt']);

    const cmp = await g.compareCommits(c1.hash, merge.hash);
    expect(cmp.files.map((f) => `${f.status}:${f.path}`)).toEqual(['added:b.txt']);
    expect((await g.fileAtCommit(c1.hash, 'a.txt')).content.replace(/\r/g, '')).toBe('one\n');
    await expect(g.fileAtCommit(c1.hash, 'b.txt')).rejects.toMatchObject({ friendly: { code: 'file-missing' } });
    await expect(g.fileAtCommit(c1.hash, '../outside')).rejects.toThrow();
  });
});
