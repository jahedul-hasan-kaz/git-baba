import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationCenter } from '../src/main/notifications/NotificationCenter';
import type { AppNotification, RepoRecord } from '../src/shared/types';

/** GraphQL snapshot data with one branch "main" at `oid` (history `count`) authored by `who`. */
const snap = (oid: string, count: number, who: string, extra: Record<string, unknown> = {}) => ({
  repository: {
    branches: { totalCount: 1, nodes: [{ name: 'main', target: { oid, committedDate: new Date(Date.now() + 1000).toISOString(), messageHeadline: 'Update README.md', history: { totalCount: count }, author: { user: { login: who } } } }] },
    tags: { nodes: [] },
    releases: { nodes: [] },
    pullRequests: { nodes: [] },
    issues: { nodes: [] },
    ...extra,
  },
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-notify-'));
  let data: unknown = snap('a1', 10, 'octo');
  let active: { id: string; login: string } | null = { id: 'A', login: 'me' };
  const desktop: AppNotification[][] = [];
  const repo = { id: 'r1', name: 'repo', path: dir, addedAt: '', settings: { runHooks: false, allowSystemCredentials: true, allowSavedCredentials: false } } as RepoRecord;
  const client = { graphql: async () => data, get: async () => ({ workflow_runs: [] }) };
  const center = new NotificationCenter({
    file: path.join(dir, 'n.json'),
    activeAccount: () => active,
    client: async () => client as never,
    reposFor: async (id) => (id === 'A' ? [{ repo, accountId: 'A', owner: 'o', name: 'repo' }] : []),
    worktrees: async () => null,
    desktop: (items) => desktop.push(items),
    emit: () => undefined,
    desktopSupported: true,
  });
  return { center, desktop, setData: (d: unknown) => (data = d), setActive: (a: typeof active) => (active = a) };
}

describe('NotificationCenter', () => {
  it('stays silent on the first look, then reports a push', async () => {
    const t = setup();
    expect((await t.center.refresh()).items).toHaveLength(0);
    t.setData(snap('b2', 11, 'octo'));
    const feed = await t.center.refresh();
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ kind: 'push', action: 'pushed 1 commit to', subject: 'main', actor: 'octo', repo: 'o/repo', detail: 'Update README.md', own: false });
    expect(t.desktop).toHaveLength(1);
    // Nothing changed: nothing new.
    expect((await t.center.refresh()).items).toHaveLength(1);
  });

  it('never notifies about your own changes', async () => {
    const t = setup();
    await t.center.refresh();
    t.setData(snap('c3', 11, 'me'));
    expect((await t.center.refresh()).items).toHaveLength(0);
    expect(t.desktop).toHaveLength(0);
    t.setData(snap('c4', 12, 'octo'));
    expect((await t.center.refresh()).items.map((n) => n.actor)).toEqual(['octo']);
  });

  it('marks everything read and shows only the active account', async () => {
    const t = setup();
    await t.center.refresh();
    t.setData(snap('d4', 12, 'octo'));
    await t.center.refresh();
    expect(t.center.markAllRead().unread).toBe(0);
    t.setActive({ id: 'B', login: 'other' });
    expect(t.center.feed().items).toHaveLength(0);
  });
});
