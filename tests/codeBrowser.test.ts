import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/GitService';
import { branchFromMergeSubject, parseGrep, parseLsTree, parseNameRev } from '../src/main/git/parsers';
import { languageOf } from '../src/shared/languages';

describe('history branch labels', () => {
  it('splits name-rev output into tip and innermost merge', () => {
    expect(parseNameRev('feature/x~2')).toEqual({ tip: 'feature/x', mergeRev: null });
    expect(parseNameRev('main~3^2~1')).toEqual({ tip: 'main', mergeRev: 'main~3' });
    expect(parseNameRev('main~3^2~1^2')).toEqual({ tip: 'main', mergeRev: 'main~3^2~1' });
    expect(parseNameRev('remotes/origin/dev')).toEqual({ tip: 'origin/dev', mergeRev: null });
    expect(parseNameRev('undefined')).toEqual({ tip: null, mergeRev: null });
  });

  it('reads branch names from merge subjects', () => {
    expect(branchFromMergeSubject("Merge branch 'feature/login' into main")).toBe('feature/login');
    expect(branchFromMergeSubject('Merge pull request #42 from octo/fix-bug')).toBe('fix-bug');
    expect(branchFromMergeSubject("Merge remote-tracking branch 'origin/dev'")).toBe('dev');
    expect(branchFromMergeSubject('Fix typo')).toBeNull();
  });
});

describe('code browser parsers', () => {
  it('parses ls-tree with folders first', () => {
    const out = '100644 blob aaa      12\tb.txt\x00040000 tree bbb       -\tsrc\x00120000 blob ccc       5\tlink\x00160000 commit ddd       -\tlib\x00';
    expect(parseLsTree(out, 'pkg')).toEqual([
      { name: 'src', path: 'pkg/src', type: 'dir', size: null },
      { name: 'b.txt', path: 'pkg/b.txt', type: 'file', size: 12 },
      { name: 'lib', path: 'pkg/lib', type: 'submodule', size: null },
      { name: 'link', path: 'pkg/link', type: 'symlink', size: 5 },
    ]);
  });

  it('parses grep output and caps results', () => {
    const oid = 'a'.repeat(40);
    const out = `${oid}:src/a.ts\x003\x00const x = 1;\n${oid}:b.md\x0010\x00hello: world\n`;
    expect(parseGrep(out, 10)).toEqual({ hits: [{ path: 'src/a.ts', line: 3, text: 'const x = 1;' }, { path: 'b.md', line: 10, text: 'hello: world' }], truncated: false });
    expect(parseGrep(out, 1).truncated).toBe(true);
  });

  it('detects languages and skips vendored files', () => {
    expect(languageOf('src/App.tsx')).toBe('TypeScript');
    expect(languageOf('Dockerfile')).toBe('Dockerfile');
    expect(languageOf('node_modules/x/index.js')).toBeNull();
    expect(languageOf('dist/app.min.js')).toBeNull();
    expect(languageOf('LICENSE')).toBeNull();
  });
});

describe('GitService history + code browser', () => {
  let git: GitService;
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(git.root, name)), { recursive: true });
    fs.writeFileSync(path.join(git.root, name), content);
  };
  const commit = async (msg: string) => {
    await git.stageAll();
    return git.commit(msg, 'none');
  };

  beforeEach(async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-code-')));
    git = await GitService.init(dir, 'main');
    await git.setIdentity('Test', 'test@example.com');
    write('README.md', '# Demo\n');
    write('src/app.ts', 'export const hello = "world";\n');
    await commit('initial');
    await git.createBranch('feature/a', null, true);
    write('src/feature.ts', 'export const feature = true;\n');
    await commit('add feature');
    await git.switchBranch('main');
    write('CHANGELOG.md', 'v1\n');
    await commit('main work');
    await git.merge(await git.revParse('feature/a'), { message: "Merge branch 'feature/a'" });
    await git.deleteBranch('feature/a', true);
    await git.createBranch('wip', null, true);
    write('notes.txt', 'hello world\n');
    await commit('wip notes');
  });

  it('labels commits with their branch and marks what main contains', async () => {
    const res = await git.graphLogDecorated({ scope: 'all', limit: 50 });
    expect(res.mainRef).toBe('main');
    const by = (s: string) => res.commits.find((c) => c.subject === s)!;
    expect(by('wip notes').branch).toBe('wip');
    expect(by('wip notes').merged).toBe(false);
    // The feature branch is gone, but the merge commit still names it.
    expect(by('add feature').branch).toBe('feature/a');
    expect(by('add feature').merged).toBe(true);
    expect(by('initial').merged).toBe(true);
  });

  it('shows what a branch adds compared with main', async () => {
    const ch = await git.branchChanges('wip');
    expect(ch.base).toBe('main');
    expect(ch.ahead).toBe(1);
    expect(ch.behind).toBe(0);
    expect(ch.commits.map((c) => c.subject)).toEqual(['wip notes']);
    expect(ch.files.map((f) => f.path)).toEqual(['notes.txt']);
  });

  it('browses, reads and searches files at a ref', async () => {
    const info = await git.codeInfo('main');
    expect(info.readme).toBe('README.md');
    expect(info.commitCount).toBe(4);
    expect(info.languages.TypeScript).toBeGreaterThan(0);
    const root = await git.codeTree('main', '');
    expect(root.map((e) => e.name)).toEqual(['src', 'CHANGELOG.md', 'README.md']);
    const src = await git.codeTree('main', 'src');
    expect(src.map((e) => e.path)).toEqual(['src/app.ts', 'src/feature.ts']);
    expect((await git.codeFile('main', 'src/app.ts')).content).toContain('hello');
    const found = await git.codeSearch('wip', 'HELLO');
    expect(found.hits.map((h) => h.path).sort()).toEqual(['notes.txt', 'src/app.ts']);
    const last = await git.codeLastCommits('main', ['src', 'README.md']);
    expect(last.src?.subject).toBe('add feature');
    expect(last['README.md']?.subject).toBe('initial');
  });

  it('refuses refs that look like options', async () => {
    await expect(git.codeTree('--output=x', '')).rejects.toThrow();
    await expect(git.codeTree('main', '../outside')).rejects.toThrow();
  });
});
