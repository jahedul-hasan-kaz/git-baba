import { describe, expect, it } from 'vitest';
import { inferOrigin, parseReflogOrigin, parseBranches, parseLog, parseNameStatus, parseStatusV2, parseUnifiedDiff, synthesizeAddedDiff, unquoteGitPath } from '../src/main/git/parsers';

describe('parseStatusV2', () => {
  it('parses branch headers, staged/unstaged, renames, conflicts and untracked files', () => {
    const entries = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 aaa bbb src/staged file.ts',
      '1 .M N... 100644 100644 100644 aaa bbb src/unstaged.ts',
      '1 MM N... 100644 100644 100644 aaa bbb both.ts',
      '1 A. N... 000000 100644 100644 000 bbb added.ts',
      '1 .D N... 100644 100644 000000 aaa aaa gone.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? new dir/untracked.txt',
      '',
    ];
    const s = parseStatusV2(entries.join('\0'));
    expect(s.branch).toBe('feature/x');
    expect(s.upstream).toBe('origin/feature/x');
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(3);
    expect(s.staged.map((f) => [f.path, f.kind])).toEqual([
      ['src/staged file.ts', 'modified'],
      ['both.ts', 'modified'],
      ['added.ts', 'added'],
      ['new name.ts', 'renamed'],
    ]);
    expect(s.staged.find((f) => f.kind === 'renamed')?.origPath).toBe('old name.ts');
    expect(s.unstaged.map((f) => [f.path, f.kind])).toEqual([
      ['src/unstaged.ts', 'modified'],
      ['both.ts', 'modified'],
      ['gone.ts', 'deleted'],
    ]);
    expect(s.conflicted).toEqual([{ path: 'conflict.ts', kind: 'conflicted', area: 'conflicted', conflictCode: 'UU' }]);
    expect(s.untracked[0].path).toBe('new dir/untracked.txt');
  });

  it('handles an empty repository and detached HEAD', () => {
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0').headOid).toBeNull();
    const d = parseStatusV2('# branch.oid abc\0# branch.head (detached)\0');
    expect(d.detached).toBe(true);
    expect(d.branch).toBeNull();
  });

  it('flags an upstream that does not exist on the remote (clone of an empty repository)', () => {
    const gone = parseStatusV2('# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0');
    expect(gone.upstream).toBe('origin/main');
    expect(gone.upstreamGone).toBe(true);
    const ok = parseStatusV2('# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -0\0');
    expect(ok.upstreamGone).toBeUndefined();
    expect(ok.ahead).toBe(1);
    expect(parseStatusV2('# branch.oid abc\0# branch.head main\0').upstreamGone).toBeUndefined();
  });
});

describe('parseUnifiedDiff', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 111..222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,4 +1,5 @@',
    ' line one',
    '-line two',
    '+line 2',
    '+--- not a header',
    ' line three',
    '--- removed dashes line',
    'diff --git a/old.txt b/new.txt',
    'similarity index 90%',
    'rename from old.txt',
    'rename to new.txt',
    '--- a/old.txt',
    '+++ b/new.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '\\ No newline at end of file',
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'index 0000000..1234567',
    'Binary files /dev/null and b/logo.png differ',
    'diff --git a/del.txt b/del.txt',
    'deleted file mode 100644',
    '--- a/del.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-x',
    '-y',
    '',
  ].join('\n');

  const files = parseUnifiedDiff(diff);

  it('parses every file', () => {
    expect(files.map((f) => [f.newPath, f.status])).toEqual([
      ['src/app.ts', 'modified'],
      ['new.txt', 'renamed'],
      ['run.sh', 'modified'],
      ['logo.png', 'added'],
      ['del.txt', 'deleted'],
    ]);
  });

  it('tracks line numbers and treats "---" inside a hunk as content', () => {
    const f = files[0];
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(2);
    const lines = f.hunks[0].lines;
    expect(lines.find((l) => l.content === '--- not a header')?.type).toBe('add');
    expect(lines.find((l) => l.content === '-- removed dashes line')?.type).toBe('del');
    expect(lines.find((l) => l.content === 'line 2')?.newLine).toBe(2);
    expect(lines.find((l) => l.content === 'line three')).toMatchObject({ oldLine: 3, newLine: 4 });
  });

  it('captures renames, modes, binary flags and no-newline markers', () => {
    expect(files[1]).toMatchObject({ oldPath: 'old.txt', newPath: 'new.txt', similarity: 90 });
    expect(files[1].hunks[0].lines.at(-1)?.type).toBe('meta');
    expect(files[2]).toMatchObject({ oldMode: '100644', newMode: '100755' });
    expect(files[3].binary).toBe(true);
    expect(files[4].deletions).toBe(2);
  });

  it('truncates very large files', () => {
    const big = ['diff --git a/b.txt b/b.txt', '--- a/b.txt', '+++ b/b.txt', '@@ -0,0 +1,50 @@', ...Array.from({ length: 50 }, (_, i) => `+${i}`)].join('\n');
    const [f] = parseUnifiedDiff(big, { maxLinesPerFile: 10 });
    expect(f.truncated).toBe(true);
    expect(f.additions).toBe(50);
    expect(f.hunks[0].lines).toHaveLength(10);
  });
});

describe('misc parsers', () => {
  it('unquotes C-style git paths including UTF-8 octal escapes', () => {
    expect(unquoteGitPath('"a\\tb"')).toBe('a\tb');
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe('café.txt');
    expect(unquoteGitPath('plain.txt')).toBe('plain.txt');
  });

  it('parses log records', () => {
    const out = 'abc\x1fa\x1fJane\x1fj@x.io\x1f2024-01-01T00:00:00Z\x1fFix: thing\x1e\ndef\x1fd\x1fBob\x1fb@x.io\x1f2024-01-02T00:00:00Z\x1fAdd\x1e\n';
    expect(parseLog(out).map((c) => c.subject)).toEqual(['Fix: thing', 'Add']);
  });

  it('parses branches and skips remote HEAD', () => {
    const out = [
      'refs/heads/main\x1f*\x1faaa\x1forigin/main\x1fahead 1, behind 2\x1fInit\x1e',
      'refs/remotes/origin/HEAD\x1f \x1faaa\x1f\x1f\x1fInit\x1e',
      'refs/remotes/origin/main\x1f \x1fbbb\x1f\x1f\x1fRemote\x1e',
    ].join('\n');
    const b = parseBranches(out);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ name: 'main', current: true, ahead: 1, behind: 2, upstream: 'origin/main' });
    expect(b[1]).toMatchObject({ name: 'origin/main', remote: true });
  });

  it('reads and infers where a branch was created from', () => {
    expect(parseReflogOrigin('branch: Created from main')).toBe('main');
    expect(parseReflogOrigin('branch: Created from HEAD')).toBeNull();
    expect(parseReflogOrigin('clone: from https://x')).toBeNull();
    const locals = new Set(['main', 'feature/x', 'qa']);
    expect(inferOrigin('feature/x', ['HEAD -> feature/x, origin/feature/x', 'origin/qa, qa', 'main, origin/main'], locals)).toBe('qa');
    expect(inferOrigin('origin/feature/x', ['origin/feature/x, feature/x', 'origin/main, main'], locals)).toBe('main');
    expect(inferOrigin('main', ['HEAD -> main, origin/main'], locals)).toBeNull();
  });

  it('parses -z name-status with renames', () => {
    expect(parseNameStatus('M\0a.ts\0R100\0old.ts\0new.ts\0A\0b.ts\0')).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'new.ts', status: 'renamed from old.ts' },
      { path: 'b.ts', status: 'added' },
    ]);
  });

  it('synthesises diffs for untracked files', () => {
    const d = synthesizeAddedDiff('n.txt', 'a\r\nb\n', false);
    expect(d.additions).toBe(2);
    expect(d.hunks[0].lines.map((l) => l.content)).toEqual(['a', 'b']);
  });
});
