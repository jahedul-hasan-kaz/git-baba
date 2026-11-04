import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountSessions } from '../src/main/accounts/AccountSessions';
import { AccountSecretStore, AccountStore } from '../src/main/accounts/AccountStore';
import { GitHubClient, parseNextLink } from '../src/main/github/client/GitHubClient';
import { GitHubService } from '../src/main/github/GitHubService';
import { defaultMergeMethod, describeRule, evaluateMerge, worst, type MergeState } from '../src/main/github/services/merge';
import { buildPrSearchQuery, listPullRequests, mapCheck, patchToFileDiff, permissionsFrom } from '../src/main/github/services/pullRequests';
import { mapCodeScanningAlert, mapDependabotAlert } from '../src/main/github/services/security';
import { applyTemplate, parseDispatch, renderTemplate } from '../src/main/github/services/workflows';
import type { Encryptor } from '../src/main/repositories/SecretStore';

type Call = { url: string; init: RequestInit };
function fake(handler: (url: URL, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(new URL(url), init, calls.length);
  };
  return { impl, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noSleep = async () => {};

describe('GitHubClient', () => {
  it('follows Link pagination up to maxItems', async () => {
    const { impl, calls } = fake((u) => {
      const page = Number(u.searchParams.get('page') ?? '1');
      const next = page < 5 ? { link: `<https://api.github.com/repos/o/r/labels?per_page=100&page=${page + 1}>; rel="next"` } : {};
      return json(Array.from({ length: 100 }, (_, i) => ({ name: `l${page}-${i}` })), 200, next);
    });
    const c = new GitHubClient('https://api.github.com', 'tok', impl, noSleep);
    const r = await c.paginate<{ name: string }>('/repos/o/r/labels', { maxItems: 250 });
    expect(r.items).toHaveLength(250);
    expect(r.hasMore).toBe(true);
    expect(calls).toHaveLength(3); // never loads everything
  });

  it('retries transient failures once and maps rate limits with the reset time', async () => {
    let n = 0;
    const { impl } = fake(() => (++n === 1 ? new Response('bad gateway', { status: 502 }) : json({ ok: true })));
    expect(await new GitHubClient('https://api.github.com', 't', impl, noSleep).get('/x')).toEqual({ ok: true });

    const reset = Math.floor(Date.now() / 1000) + 600;
    const limited = fake(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    await expect(new GitHubClient('https://api.github.com', 't', limited.impl, noSleep).get('/x')).rejects.toMatchObject({ friendly: { code: 'rate-limited' } });
  });

  it('explains missing permissions using the accepted-permissions header, without leaking the token', async () => {
    const { impl } = fake(() => json({ message: 'Resource not accessible by personal access token' }, 403, { 'x-accepted-github-permissions': 'pull_requests=write' }));
    const err = await new GitHubClient('https://api.github.com', 'ghp_secret_token_value_123456', impl, noSleep).rest('POST', '/repos/o/r/pulls', { action: 'create the pull request' }).catch((e) => e);
    expect(err.friendly.code).toBe('pat-permission');
    expect(err.friendly.message).toContain('create the pull request');
    expect(err.friendly.reasons.join(' ')).toContain('Resource owner');
    expect(err.friendly.reasons.join(' ')).toContain('pull_requests: write');
    expect(JSON.stringify(err.friendly)).not.toContain('ghp_secret_token_value_123456');
  });

  it('maps 401 / 404 / 409 / 422 and network errors', async () => {
    for (const [status, code] of [[401, 'session-expired'], [404, 'not-found'], [409, 'conflict'], [422, 'validation']] as const) {
      const { impl } = fake(() => json({ message: 'x' }, status));
      await expect(new GitHubClient('https://api.github.com', 't', impl, noSleep).get('/x')).rejects.toMatchObject({ friendly: { code } });
    }
    const down = fake(() => {
      throw new Error('ECONNRESET');
    });
    await expect(new GitHubClient('https://api.github.com', 't', down.impl, noSleep).get('/x')).rejects.toMatchObject({ friendly: { code: 'network' } });
  });

  it('translates GraphQL errors and keeps partial data for not-found branches', async () => {
    const forbidden = fake(() => json({ data: null, errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'needs read:project' }] }));
    await expect(new GitHubClient('https://api.github.com', 't', forbidden.impl, noSleep).graphql('query{}')).rejects.toMatchObject({ friendly: { code: 'forbidden' } });
    const partial = fake(() => json({ data: { a: 1, b: null }, errors: [{ type: 'NOT_FOUND', message: 'nope' }] }));
    expect(await new GitHubClient('https://api.github.com', 't', partial.impl, noSleep).graphql('query{}')).toEqual({ a: 1, b: null });
  });

  it('never sends the token to another host or to a log-download redirect', async () => {
    const c = new GitHubClient('https://api.github.com', 'tok', fake(() => json({})).impl, noSleep);
    await expect(c.get('https://evil.example/steal')).rejects.toMatchObject({ friendly: { code: 'invalid-url' } });
    const { impl, calls } = fake((u) => (u.host === 'api.github.com' ? new Response(null, { status: 302, headers: { location: 'https://pipelines.example/log.txt' } }) : new Response('line1\nfailed here')));
    const logs = await new GitHubClient('https://api.github.com', 'tok', impl, noSleep).downloadText('/repos/o/r/actions/jobs/1/logs');
    expect(logs.text).toContain('failed here');
    expect((calls[1].init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it('uses the right GraphQL endpoint for GitHub Enterprise', () => {
    expect(new GitHubClient('https://ghe.example.com/api/v3', 't').graphqlUrl).toBe('https://ghe.example.com/api/graphql');
    expect(new GitHubClient('https://api.github.com', 't').graphqlUrl).toBe('https://api.github.com/graphql');
    expect(parseNextLink('<https://a/x?page=2>; rel="next", <https://a/x?page=9>; rel="last"')).toBe('https://a/x?page=2');
  });
});

describe('pull requests', () => {
  const r = { owner: 'inride', name: 'agent' };
  it('builds GitHub search queries where filters and sorting combine', () => {
    expect(buildPrSearchQuery(r, { state: 'merged', sort: 'most-comments', author: 'jahedul', label: 'bug fix', review: 'approved', text: 'auth' })).toBe(
      'repo:inride/agent is:pr is:merged author:jahedul label:"bug fix" review:approved sort:comments-desc auth',
    );
    expect(buildPrSearchQuery(r, { state: 'closed', sort: 'best-match', assignee: '__none__', review: 'review-requested-me' })).toBe('repo:inride/agent is:pr is:closed is:unmerged no:assignee review-requested:@me');
    expect(buildPrSearchQuery(r, { state: 'all', sort: 'least-recently-updated', milestone: 'v1 "beta"' })).toBe('repo:inride/agent is:pr milestone:"v1 beta" sort:updated-asc');
  });

  it('maps a pull request search into list items', async () => {
    const { impl } = fake(async () => {
      return json({
        data: {
          search: {
            issueCount: 1,
            pageInfo: { endCursor: 'c1', hasNextPage: false },
            nodes: [
              {
                id: 'PR1', number: 7, title: 'Fix auth', state: 'OPEN', isDraft: false, createdAt: 'x', updatedAt: 'y', baseRefName: 'main', headRefName: 'fix',
                author: { login: 'a' }, assignees: { nodes: [] }, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] }, milestone: null,
                comments: { totalCount: 2 }, commits: { totalCount: 3 }, changedFiles: 4, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
                reviewRequests: { nodes: [{ requestedReviewer: { login: 'rev' } }] }, latestReviews: { nodes: [{ author: { login: 'x' }, state: 'APPROVED' }] },
                rollup: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
              },
            ],
          },
        },
      });
    });
    const res = await listPullRequests(new GitHubClient('https://api.github.com', 't', impl, noSleep), r, { state: 'open', sort: 'newest' });
    expect(res.items[0]).toMatchObject({ number: 7, checks: 'FAILURE', reviewers: [{ login: 'x', state: 'APPROVED' }, { login: 'rev', state: 'REQUESTED' }] });
  });

  it('maps check runs and status contexts to clear states', () => {
    expect(mapCheck({ __typename: 'CheckRun', id: '1', databaseId: 9, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true, checkSuite: { workflowRun: { databaseId: 5, workflow: { name: 'CI' } } } })).toMatchObject({ status: 'failed', jobId: 9, runId: 5, workflow: 'CI', isRequired: true });
    expect(mapCheck({ __typename: 'CheckRun', id: '2', name: 'b', status: 'IN_PROGRESS', conclusion: null, checkSuite: null }).status).toBe('running');
    expect(mapCheck({ __typename: 'CheckRun', id: '3', name: 'c', status: 'COMPLETED', conclusion: 'SKIPPED' }).status).toBe('skipped');
    expect(mapCheck({ __typename: 'CheckRun', id: '4', name: 'd', status: 'COMPLETED', conclusion: 'CANCELLED' }).status).toBe('cancelled');
    expect(mapCheck({ __typename: 'StatusContext', id: '5', context: 'ci/x', state: 'PENDING' }).status).toBe('pending');
  });

  it('turns GitHub file patches into the app’s diff model', () => {
    const d = patchToFileDiff('src/a.ts', null, 'modified', '@@ -1,2 +1,2 @@\n a\n-b\n+c');
    expect(d?.hunks[0].lines.map((l) => `${l.type}:${l.content}:${l.newLine ?? ''}`)).toEqual(['context:a:1', 'del:b:', 'add:c:2']);
    expect(patchToFileDiff('new.ts', null, 'added', '@@ -0,0 +1 @@\n+x')?.status).toBe('added');
    expect(patchToFileDiff('b.ts', 'a.ts', 'renamed', '@@ -1 +1 @@\n-x\n+y')).toMatchObject({ status: 'renamed', oldPath: 'a.ts', newPath: 'b.ts' });
    expect(patchToFileDiff('img.png', null, 'added', undefined)).toBeNull();
  });

  it('derives permissions from the viewer role', () => {
    expect(permissionsFrom('TRIAGE')).toEqual({ level: 'TRIAGE', canTriage: true, canWrite: false, canAdmin: false });
    expect(permissionsFrom('ADMIN').canAdmin).toBe(true);
    expect(permissionsFrom(null).level).toBe('NONE');
  });
});

describe('merge evaluation', () => {
  const base: MergeState = {
    number: 1, title: 't', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', headRefOid: 'a'.repeat(40),
    baseRefName: 'main', headRefName: 'fix', mergeCommitOid: null, unresolvedThreads: 0, checks: [], viewerPermission: 'WRITE',
    mergeMethods: { merge: true, squash: true, rebase: true }, viewerDefaultMergeMethod: 'MERGE',
  };

  it('reports failed requirements without blocking anything', () => {
    const req = evaluateMerge(
      {
        ...base,
        mergeable: 'CONFLICTING',
        reviewDecision: 'REVIEW_REQUIRED',
        unresolvedThreads: 2,
        mergeStateStatus: 'BLOCKED',
        checks: [
          { id: '1', kind: 'check-run', name: 'build', workflow: 'CI', status: 'failed', rawStatus: 'COMPLETED', conclusion: 'FAILURE', startedAt: null, completedAt: null, detailsUrl: null, jobId: 1, runId: 1, isRequired: true },
          { id: '2', kind: 'check-run', name: 'lint', workflow: 'CI', status: 'running', rawStatus: 'IN_PROGRESS', conclusion: null, startedAt: null, completedAt: null, detailsUrl: null, jobId: 2, runId: 1, isRequired: false },
        ],
      },
      [{ type: 'pull_request', parameters: { required_approving_review_count: 2, required_review_thread_resolution: true } }],
    );
    const byId = Object.fromEntries(req.map((r) => [r.id, r]));
    expect(byId.conflicts.state).toBe('failed');
    expect(byId['required-checks']).toMatchObject({ state: 'failed', detail: 'Failing: build' });
    expect(byId.checks.state).toBe('pending');
    expect(byId.reviews.detail).toContain('2 approving reviews');
    expect(byId.conversations.state).toBe('failed');
    expect(byId.blocked.state).toBe('warning');
    expect(worst(req.map((r) => r.state))).toBe('failed');
  });

  it('passes a clean, approved PR and respects linear-history rules for the default method', () => {
    const req = evaluateMerge(base, []);
    expect(worst(req.map((r) => r.state))).not.toBe('failed');
    expect(defaultMergeMethod(base, [{ type: 'required_linear_history' }])).toBe('squash');
    expect(defaultMergeMethod({ ...base, viewerDefaultMergeMethod: 'REBASE' }, [])).toBe('rebase');
    expect(describeRule('required_status_checks', { required_status_checks: [{ context: 'build' }], strict_required_status_checks_policy: true })).toContain('build — branch must be up to date');
  });

  it('handles already merged pull requests as information', () => {
    const req = evaluateMerge({ ...base, state: 'MERGED', mergeCommitOid: 'abcdef1234' }, []);
    expect(req[0]).toMatchObject({ id: 'state', state: 'info' });
  });
});

describe('actions & workflow templates', () => {
  it('reads workflow_dispatch inputs', () => {
    const yaml = `name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        default: staging
        type: choice
        options:
          - staging
          - production
      dry_run:
        description: Dry run only
        type: boolean
        default: "true"
jobs: {}
`;
    const r = parseDispatch(yaml);
    expect(r.dispatchable).toBe(true);
    expect(r.inputs).toEqual([
      { name: 'environment', description: 'Target environment', required: true, default: 'staging', type: 'choice', options: ['staging', 'production'] },
      { name: 'dry_run', description: 'Dry run only', required: false, default: 'true', type: 'boolean', options: [] },
    ]);
    expect(parseDispatch('on: [push, workflow_dispatch]\n').dispatchable).toBe(true);
    expect(parseDispatch('on:\n  push:\n').dispatchable).toBe(false);
  });

  it('renders templates for the detected languages and ecosystems', () => {
    const codeql = renderTemplate('codeql', { defaultBranch: 'develop', languages: ['TypeScript', 'JavaScript', 'Python', 'HTML'], ecosystems: [] });
    expect(codeql).toContain(`language: [ 'javascript-typescript', 'python' ]`);
    expect(codeql).toContain('branches: [ "develop" ]');
    expect(renderTemplate('dependabot', { defaultBranch: 'main', languages: [], ecosystems: ['npm', 'github-actions'] })).toContain('package-ecosystem: "github-actions"');
  });

  it('never overwrites an existing workflow unless asked, and never if it changed since review', async () => {
    const existing = Buffer.from('name: mine').toString('base64');
    const writes: string[] = [];
    const { impl } = fake((u, init) => {
      if (init.method === 'PUT') writes.push(u.pathname);
      if (u.pathname === '/repos/o/r') return json({ default_branch: 'main' });
      if (u.pathname.includes('/contents/')) return json({ type: 'file', content: existing, sha: 'b'.repeat(40) });
      return json({});
    });
    const c = new GitHubClient('https://api.github.com', 't', impl, noSleep);
    const r = { owner: 'o', name: 'r' };
    await expect(applyTemplate(c, r, { path: '.github/workflows/codeql.yml', content: 'x', mode: 'direct', overwrite: false, existingSha: null, templateName: 'CodeQL' })).rejects.toMatchObject({ friendly: { code: 'exists' } });
    await expect(applyTemplate(c, r, { path: '.github/workflows/codeql.yml', content: 'x', mode: 'direct', overwrite: true, existingSha: 'c'.repeat(40), templateName: 'CodeQL' })).rejects.toMatchObject({ friendly: { code: 'changed' } });
    expect(writes).toEqual([]);
  });
});

describe('security mapping', () => {
  it('maps code scanning alerts and separates code-quality findings', () => {
    const sec = mapCodeScanningAlert({ number: 1, state: 'open', rule: { id: 'js/xss', severity: 'error', security_severity_level: 'high', tags: ['security'] }, tool: { name: 'CodeQL' }, most_recent_instance: { location: { path: 'a.js', start_line: 3 }, message: { text: 'XSS' }, ref: 'refs/heads/main' }, created_at: 'x', html_url: 'u' });
    expect(sec).toMatchObject({ severity: 'high', path: 'a.js', startLine: 3, isQuality: false });
    const quality = mapCodeScanningAlert({ number: 2, state: 'open', rule: { id: 'js/unused', severity: 'note', tags: ['maintainability'] }, tool: { name: 'CodeQL' }, created_at: 'x', html_url: 'u' });
    expect(quality.isQuality).toBe(true);
  });

  it('maps Dependabot alerts with advisory details', () => {
    const a = mapDependabotAlert({
      number: 3, state: 'open', html_url: 'u', created_at: 'c',
      dependency: { package: { name: 'lodash', ecosystem: 'npm' }, manifest_path: 'package.json', scope: 'runtime' },
      security_advisory: { ghsa_id: 'GHSA-x', cve_id: 'CVE-2021-1', summary: 'Prototype pollution', severity: 'high', references: [{ url: 'https://a' }] },
      security_vulnerability: { severity: 'critical', vulnerable_version_range: '< 4.17.21', first_patched_version: { identifier: '4.17.21' } },
    });
    expect(a).toMatchObject({ package: 'lodash', severity: 'critical', cveId: 'CVE-2021-1', patchedVersion: '4.17.21', manifest: 'package.json', references: ['https://a'] });
  });
});

describe('account sessions', () => {
  const enc: Encryptor = { isAvailable: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() };
  it('keeps the token in memory only, verifies the account, and ends on sign-out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-sess-'));
    const accounts = new AccountStore(path.join(dir, 'a.json'));
    const secrets = new AccountSecretStore(path.join(dir, 's'), enc);
    const acc = accounts.upsert('jahedul', null, []);
    const { impl } = fake((u) => (u.pathname === '/user' ? json({ login: 'jahedul', name: null }, 200, { 'x-oauth-scopes': 'repo' }) : json([])));
    const sessions = new AccountSessions(() => ({ accounts, accountSecrets: secrets, githubFor: (b) => new GitHubService(b, impl) }));
    expect(() => sessions.client(acc.id)).toThrow(/Sign in/);
    const st = await sessions.signIn({ accountId: acc.id, token: 'ghp_session' });
    expect(st.active).toBe(true);
    expect(sessions.client(acc.id).login).toBe('jahedul');
    expect(fs.readdirSync(dir)).toEqual(['a.json']); // nothing written besides the account identity
    sessions.end(acc.id);
    expect(() => sessions.client(acc.id)).toThrow(/Sign in/);
  });
});
