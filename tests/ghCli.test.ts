import { describe, expect, it } from 'vitest';
import { prCliArgs } from '../src/main/github/ghCli';

describe('gh pr command builder', () => {
  const args = (action: string, extra: Partial<Parameters<typeof prCliArgs>[2]> = {}) => prCliArgs('o/r', 7, { action, hasBody: false, ...extra });

  it('builds every allow-listed action with --repo and separate arguments', () => {
    expect(args('checkout')).toEqual(['pr', 'checkout', '7', '--repo', 'o/r']);
    expect(args('comment', { hasBody: true })).toEqual(['pr', 'comment', '7', '--repo', 'o/r', '--body-file', '-']);
    expect(args('approve')).toEqual(['pr', 'review', '7', '--repo', 'o/r', '--approve']);
    expect(args('approve', { hasBody: true })).toEqual(['pr', 'review', '7', '--repo', 'o/r', '--approve', '--body-file', '-']);
    expect(args('request-changes', { hasBody: true })).toContain('--request-changes');
    expect(args('merge', { method: 'squash', deleteBranch: true })).toEqual(['pr', 'merge', '7', '--repo', 'o/r', '--squash', '--delete-branch']);
    expect(args('draft')).toEqual(['pr', 'ready', '7', '--repo', 'o/r', '--undo']);
    // A title that looks like an option is still just the value of --title.
    expect(args('edit-title', { title: '--delete-branch' })).toEqual(['pr', 'edit', '7', '--repo', 'o/r', '--title=--delete-branch']);
  });

  it('refuses unknown actions', () => {
    expect(() => args('delete')).toThrow();
  });
});
