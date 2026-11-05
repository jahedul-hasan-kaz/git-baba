import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationCenter } from '../src/main/notifications/NotificationCenter';
import type { AppNotification, RepoRecord } from '../src/shared/types';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-notify-'));
  let events: unknown[] = [];
  let active: { id: string; login: string } | null = { id: 'A', login: 'me' };
  const desktop: AppNotification[][] = [];
  const repo = { id: 'r1', name: 'repo', path: dir, addedAt: '', settings: { runHooks: false, allowSystemCredentials: true, allowSavedCredentials: false } } as RepoRecord;
  const client = { get: async (p: string) => (p.endsWith('/events') ? events : { workflow_runs: [] }) };
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
  const push = (id: string, login: string) => ({ id, type: 'PushEvent', actor: { login }, created_at: new Date(Date.now() + 1000).toISOString(), payload: { ref: 'refs/heads/main', size: 1, commits: [{ message: 'm' }] } });
  return { center, desktop, setEvents: (e: unknown[]) => (events = e), setActive: (a: typeof active) => (active = a), push };
}

describe('NotificationCenter', () => {
  it('stays silent on the first look, then notifies about new activity', async () => {
    const t = setup();
    t.setEvents([t.push('1', 'octo')]);
    expect((await t.center.refresh()).items).toHaveLength(0);
    t.setEvents([t.push('2', 'octo'), t.push('1', 'octo')]);
    const feed = await t.center.refresh();
    expect(feed.items).toHaveLength(1);
    expect(feed.unread).toBe(1);
    expect(feed.items[0]).toMatchObject({ actor: 'octo', repo: 'o/repo', accountLogin: 'me', own: false });
    expect(t.desktop).toHaveLength(1);
  });

  it('keeps your own activity out of desktop banners by default', async () => {
    const t = setup();
    await t.center.refresh();
    t.setEvents([t.push('3', 'me')]);
    const feed = await t.center.refresh();
    expect(feed.items[0].own).toBe(true);
    expect(t.desktop).toHaveLength(0);
  });

  it('marks everything read and shows only the active account', async () => {
    const t = setup();
    await t.center.refresh();
    t.setEvents([t.push('4', 'octo')]);
    await t.center.refresh();
    expect(t.center.markAllRead().unread).toBe(0);
    t.setActive({ id: 'B', login: 'other' });
    expect(t.center.feed().items).toHaveLength(0);
  });
});
