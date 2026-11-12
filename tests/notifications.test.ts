import { describe, expect, it } from 'vitest';
import { eventToActivity, parseWorktrees, runsToActivity, worktreeChanges } from '../src/main/notifications/activity';
import { desktopText } from '../src/main/notifications/desktop';
import type { AppNotification } from '../src/shared/types';

const ev = (type: string, payload: unknown, login = 'octo') => ({ id: '1', type, actor: { login, display_login: login }, created_at: '2026-11-05T10:00:00Z', payload });

describe('eventToActivity', () => {
  it('describes a push with its branch and last commit', () => {
    const d = eventToActivity(ev('PushEvent', { ref: 'refs/heads/main', size: 2, commits: [{ message: 'a' }, { message: 'fix: login\n\nbody' }] }));
    expect(d).toMatchObject({ kind: 'push', action: 'pushed 2 commits to', subject: 'main', ref: 'main', detail: 'fix: login', actor: 'octo' });
  });
  it('tells branch creation, deletion and tags apart', () => {
    expect(eventToActivity(ev('CreateEvent', { ref_type: 'branch', ref: 'feat/x' }))).toMatchObject({ kind: 'branch-create', subject: 'feat/x' });
    expect(eventToActivity(ev('DeleteEvent', { ref_type: 'branch', ref: 'old' }))).toMatchObject({ kind: 'branch-delete', tone: 'warning' });
    expect(eventToActivity(ev('CreateEvent', { ref_type: 'tag', ref: 'v1' }))).toMatchObject({ kind: 'tag' });
  });
  it('marks merged pull requests as merged', () => {
    const d = eventToActivity(ev('PullRequestEvent', { action: 'closed', pull_request: { number: 7, title: 'Add bell', merged: true, head: { ref: 'f' }, base: { ref: 'main' } } }));
    expect(d).toMatchObject({ kind: 'pr', tone: 'success', action: 'merged pull request', number: 7, detail: 'f → main' });
  });
  it('quotes comments and ignores edits', () => {
    expect(eventToActivity(ev('IssueCommentEvent', { action: 'created', issue: { number: 3, title: 'T', pull_request: {} }, comment: { body: 'Looks good' } }))).toMatchObject({
      kind: 'comment',
      action: 'commented on pull request',
      detail: 'Looks good',
    });
    expect(eventToActivity(ev('IssueCommentEvent', { action: 'edited', issue: {}, comment: {} }))).toBeNull();
  });
  it('ignores events nobody needs to hear about', () => {
    expect(eventToActivity(ev('WatchEvent', {}))).toBeNull();
    expect(eventToActivity(ev('PullRequestEvent', { action: 'labeled', pull_request: {} }))).toBeNull();
  });
});

describe('runsToActivity', () => {
  const run = (id: number, status: string, conclusion: string | null) => ({ id, name: 'CI', status, conclusion, head_branch: 'main', updated_at: '2026-11-05T10:05:00Z', triggering_actor: { login: 'octo' } });
  it('reports a run when it finishes', () => {
    const a = runsToActivity([run(1, 'in_progress', null)], {}, '2026-11-05T10:00:00Z');
    expect(a.drafts).toHaveLength(0);
    const b = runsToActivity([run(1, 'completed', 'failure')], a.next, '2026-11-05T10:00:00Z');
    expect(b.drafts[0]).toMatchObject({ kind: 'workflow', tone: 'failure', action: 'workflow failed', subject: 'CI', ref: 'main' });
  });
  it('does not report runs that finished before the baseline', () => {
    expect(runsToActivity([run(2, 'completed', 'success')], {}, '2026-11-06T00:00:00Z').drafts).toHaveLength(0);
  });
});

describe('worktrees', () => {
  it('finds added, removed and switched worktrees', () => {
    const before = parseWorktrees('worktree C:/r\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/r-old\nHEAD 2\nbranch refs/heads/x\n');
    const after = parseWorktrees('worktree C:/r\nHEAD 1\nbranch refs/heads/dev\n\nworktree C:/r-new\nHEAD 3\ndetached\n');
    const kinds = worktreeChanges(before, after, 'now').map((d) => d.action);
    expect(kinds).toEqual(['switched worktree to dev', 'added worktree', 'removed worktree']);
  });
});

describe('desktopText', () => {
  const n = (over: Partial<AppNotification>): AppNotification => ({
    id: 'x',
    accountId: 'a',
    accountLogin: 'me',
    repoId: 'r',
    repo: 'o/r',
    kind: 'push',
    tone: 'info',
    action: 'pushed 1 commit to',
    subject: 'main',
    at: 'now',
    read: false,
    own: false,
    actor: 'octo',
    ...over,
  });
  it('summarises several updates in one banner', () => {
    const t = desktopText([n({}), n({ id: 'y' }), n({ id: 'z' }), n({ id: 'w' })]);
    expect(t.title).toBe('4 new updates in o/r');
    expect(t.body).toContain('…and 1 more');
  });
  it('names who did what for a single update', () => {
    expect(desktopText([n({ kind: 'pr', action: 'opened pull request', subject: 'Bell', number: 5 })]).title).toBe('octo opened pull request #5');
  });
});

import { diffSnapshot, parseSnapshot } from '../src/main/notifications/snapshot';

describe('snapshot diff', () => {
  const since = '2026-11-05T10:00:00Z';
  const later = '2026-11-05T10:05:00Z';
  const repo = (o: Record<string, unknown>) => ({ repository: { branches: { totalCount: 0, nodes: [] }, tags: { nodes: [] }, releases: { nodes: [] }, pullRequests: { nodes: [] }, issues: { nodes: [] }, ...o } });
  const br = (name: string, oid: string, count: number) => ({ name, target: { oid, committedDate: later, messageHeadline: `msg ${oid}`, history: { totalCount: count }, author: { user: { login: 'octo' } } } });

  it('reports created, pushed and deleted branches', () => {
    const a = parseSnapshot(repo({ branches: { totalCount: 2, nodes: [br('main', 'a', 5), br('old', 'o', 2)] } })).snap;
    const b = parseSnapshot(repo({ branches: { totalCount: 2, nodes: [br('main', 'b', 7), br('new', 'n', 1)] } }));
    const d = diffSnapshot(a, b, since, later).map((x) => `${x.kind}:${x.action}:${x.subject}`);
    expect(d).toEqual(['push:pushed 2 commits to:main', 'branch-create:created branch:new', 'branch-delete:deleted branch:old']);
  });

  it('reports PR state changes, new comments and reviews once', () => {
    const pr = (state: string, comments: unknown[] = [], reviews: unknown[] = []) => ({
      number: 4,
      title: 'Bell',
      state,
      createdAt: '2026-11-01T00:00:00Z',
      mergedAt: later,
      headRefName: 'f',
      baseRefName: 'main',
      author: { login: 'octo' },
      mergedBy: { login: 'mona' },
      comments: { nodes: comments },
      reviews: { nodes: reviews },
      reviewThreads: { nodes: [] },
    });
    const a = parseSnapshot(repo({ pullRequests: { nodes: [pr('OPEN', [{ id: 'c0', body: 'old', createdAt: '2026-11-04T00:00:00Z', author: { login: 'x' } }])] } })).snap;
    const b = parseSnapshot(
      repo({
        pullRequests: {
          nodes: [
            pr(
              'MERGED',
              [
                { id: 'c0', body: 'old', createdAt: '2026-11-04T00:00:00Z', author: { login: 'x' } },
                { id: 'c1', body: 'Ship it', createdAt: later, author: { login: 'mona' } },
              ],
              [{ id: 'r1', state: 'APPROVED', body: '', submittedAt: later, author: { login: 'mona' } }],
            ),
          ],
        },
      }),
      a.seen,
    );
    const d = diffSnapshot(a, b, since, later);
    expect(d.map((x) => `${x.kind}:${x.action}:${x.actor}`)).toEqual(['pr:merged pull request:mona', 'review:approved:mona', 'comment:commented on pull request:mona']);
    expect(diffSnapshot(b.snap, parseSnapshot(repo({ pullRequests: { nodes: [] } }), b.snap.seen), since, later)).toHaveLength(0);
  });

  it('ignores a missing branch when the list was cut off', () => {
    const a = parseSnapshot(repo({ branches: { totalCount: 1, nodes: [br('main', 'a', 1)] } })).snap;
    const b = parseSnapshot(repo({ branches: { totalCount: 200, nodes: [] } }));
    expect(diffSnapshot(a, b, since, later)).toHaveLength(0);
  });
});
