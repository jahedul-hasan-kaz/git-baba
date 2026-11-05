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
