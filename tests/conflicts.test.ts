import { describe, expect, it } from 'vitest';
import { explainConflictCode, hasConflictMarkers, parseConflictMarkers, resolveConflicts } from '../src/main/git/conflicts';

const FILE = ['header', '<<<<<<< HEAD', 'ours 1', 'ours 2', '=======', 'theirs 1', '>>>>>>> origin/main', 'middle', '<<<<<<< HEAD', 'A', '||||||| base', 'BASE', '=======', 'B', '>>>>>>> feature', 'footer', ''].join('\n');

describe('conflict markers', () => {
  it('parses blocks including diff3 base sections', () => {
    const segs = parseConflictMarkers(FILE);
    const conflicts = segs.filter((s) => s.type === 'conflict');
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toMatchObject({ ours: 'ours 1\nours 2\n', theirs: 'theirs 1\n', oursLabel: 'HEAD', theirsLabel: 'origin/main', base: null });
    expect(conflicts[1]).toMatchObject({ ours: 'A\n', base: 'BASE\n', theirs: 'B\n' });
    expect(hasConflictMarkers(FILE)).toBe(true);
  });

  it('resolves all blocks with one choice', () => {
    expect(resolveConflicts(FILE, 'ours')).toBe('header\nours 1\nours 2\nmiddle\nA\nfooter\n');
    expect(resolveConflicts(FILE, 'theirs')).toBe('header\ntheirs 1\nmiddle\nB\nfooter\n');
    expect(resolveConflicts(FILE, 'both')).toBe('header\nours 1\nours 2\ntheirs 1\nmiddle\nA\nB\nfooter\n');
  });

  it('resolves per block and keeps markers for undecided blocks', () => {
    const out = resolveConflicts(FILE, { 0: 'theirs' });
    expect(out.startsWith('header\ntheirs 1\nmiddle\n<<<<<<< HEAD\n')).toBe(true);
    expect(hasConflictMarkers(out)).toBe(true);
  });

  it('preserves CRLF line endings', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    expect(resolveConflicts(crlf, 'ours')).toBe('header\r\nours 1\r\nours 2\r\nmiddle\r\nA\r\nfooter\r\n');
  });

  it('ignores malformed / unterminated markers', () => {
    const text = 'a\n<<<<<<< HEAD\nno end\n';
    expect(hasConflictMarkers(text)).toBe(false);
    expect(resolveConflicts(text, 'ours')).toBe(text);
  });

  it('explains conflict codes for merge and rebase', () => {
    expect(explainConflictCode('UU', 'merge')).toMatch(/Both your current branch/);
    expect(explainConflictCode('DU', 'rebase')).toMatch(/rebasing onto deleted/);
  });
});
