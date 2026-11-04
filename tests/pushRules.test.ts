import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/GitService';
import { analyzeReport, recheckReport } from '../src/main/git/pushRuleAnalysis';
import { parsePushRejection } from '../src/main/git/pushRules';
import { runGit } from '../src/main/git/runner';

const SHA1 = '8728dbe67c1e5bf0c1a3c64d6f1b6b3c1b2a9e11';
const SHA2 = '1b2c3d4e5f60718293a4b5c6d7e8f90123456789';

const RULESET = `remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: Review all repository rules at https://github.com/inride-llc/app/rules?ref=refs%2Fheads%2Fmain
remote:
remote: - Changes must be made through a pull request.
remote:
remote: - Required status check "build" is expected.
remote:
remote: - This branch must not contain merge commits.
remote:   Found 1 violation:
remote:
remote:   ${SHA2}
remote:
To github.com:inride-llc/app.git
 ! [remote rejected] HEAD -> main (push declined due to repository rule violations)`;

const SECRET = `remote: error: GH013: Repository rule violations found for refs/heads/feature.
remote:
remote: - GITHUB PUSH PROTECTION
remote:   —————————————————————————————————————————
remote:     Resolve the following violations before pushing again
remote:
remote:     - Push cannot contain secrets
remote:
remote:     —— GitHub Personal Access Token ——————————————————————
remote:      locations:
remote:        - commit: ${SHA1}
remote:          path: config/settings.json:4
remote:
remote:      (?) To push, remove secret from commit(s) or follow this URL to allow the secret.
remote:      https://github.com/inride-llc/app/security/secret-scanning/unblock-secret/2abcDEF
remote:`;

const PROTECTED = `remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: error: At least 1 approving review is required by reviewers with write access.
To github.com:inride-llc/app.git
 ! [remote rejected] main -> main (protected branch hook declined)`;

const LARGE = `remote: error: Trace: abc
remote: error: See https://gh.io/lfs for more information.
remote: error: File assets/video.mp4 is 120.53 MB; this exceeds GitHub's file size limit of 100.00 MB
remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.`;

describe('parsing GitHub push rejections', () => {
  it('reads every ruleset violation with its own explanation', () => {
    const r = parsePushRejection(RULESET)!;
    expect(r.kind).toBe('ruleset');
    expect(r.ref).toBe('refs/heads/main');
    expect(r.rulesUrl).toContain('/rules?ref=');
    expect(r.violations.map((v) => v.id)).toEqual(['pull-request', 'status-checks', 'linear-history']);
    expect(r.violations[1].checks).toEqual(['build']);
    expect(r.violations[2].commits).toEqual([SHA2]);
    expect(r.violations[0].locallyFixable).toBe(false);
    expect(r.violations[0].fixes).toContain('push-to-branch');
  });

  it('reads push protection: secret type, file, line, commit and the unblock link', () => {
    const r = parsePushRejection(SECRET)!;
    expect(r.violations).toHaveLength(1);
    const v = r.violations[0];
    expect(v.id).toBe('secret');
    expect(v.title).toContain('GitHub Personal Access Token');
    expect(v.files).toEqual([{ path: 'config/settings.json', commit: SHA1, line: 4, sizeMb: null }]);
    expect(v.unblockUrl).toContain('/unblock-secret/');
    expect(v.fixes).toEqual(['drop-file', 'unblock-secret']);
  });

  it('reads classic branch protection and large files', () => {
    expect(parsePushRejection(PROTECTED)!.violations.map((v) => v.id)).toEqual(['reviews']);
    const large = parsePushRejection(LARGE)!;
    expect(large.violations[0]).toMatchObject({ id: 'file-size', files: [{ path: 'assets/video.mp4', sizeMb: 120.53 }] });
  });

  it('ignores ordinary push failures', () => {
    expect(parsePushRejection(' ! [rejected] main -> main (fetch first)')).toBeNull();
  });
});

describe('removing a file from unpushed commits', () => {
  let git: GitService;
  let bare: string;
  const read = (f: string) => fs.readFileSync(path.join(git.root, f), 'utf8').replace(/\r\n/g, '\n');
  const write = (f: string, c: string) => fs.writeFileSync(path.join(git.root, f), c);

  beforeEach(async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-pr-')));
    bare = path.join(tmp, 'remote.git');
    await runGit({ cwd: tmp, args: ['init', '--bare', '--initial-branch=main', bare] });
    git = await GitService.init(path.join(tmp, 'w'), 'main');
    await git.setIdentity('T', 't@example.com');
    await git.setRemote('origin', bare);
    write('settings.json', '{"token": ""}\n');
    write('app.ts', 'v1\n');
    await git.stageAll();
    const c = await git.commit('base', 'none');
    await git.push('origin', c.hash, 'main', { kind: 'none' }, { setUpstreamFor: 'main' });
    // Unpushed: one commit leaks a secret together with a real change, one only touches app.ts.
    write('settings.json', '{"token": "ghp_secret"}\n');
    write('app.ts', 'v2\n');
    await git.stageAll();
    await git.commit('feature + oops', 'none');
    write('app.ts', 'v3\n');
    await git.stageAll();
    await git.commit('more feature', 'none');
  });

  it('keeps unrelated changes, keeps the working copy, makes a backup, and re-check passes', async () => {
    const head = await git.revParse('HEAD');
    write('notes.txt', 'unrelated staged change\n');
    await git.stageAll();
    const commits = await git.unpushedCommits(head, 'origin');
    expect(commits).toHaveLength(2);

    const r = await git.dropPathFromCommits('settings.json', 'main', commits);
    expect(r.rewritten).toBe(2);
    // The secret is gone from history…
    const all = (await runGit({ cwd: git.root, args: ['log', '-p', 'origin/main..main'] })).stdout;
    expect(all).not.toContain('ghp_secret');
    // …the other changes are still committed, with original messages…
    expect((await runGit({ cwd: git.root, args: ['show', 'HEAD:app.ts'] })).stdout.trim()).toBe('v3');
    expect((await runGit({ cwd: git.root, args: ['log', '--format=%s', 'origin/main..main'] })).stdout.trim().split('\n')).toEqual(['more feature', 'feature + oops']);
    // …the working copy is untouched and shows as an uncommitted change; unrelated staging is preserved.
    expect(read('settings.json')).toContain('ghp_secret');
    const st = await git.status();
    expect(st.unstaged.map((f) => f.path)).toEqual(['settings.json']);
    expect(st.staged.map((f) => f.path)).toEqual(['notes.txt']);

    // Re-check: the file is no longer part of the push.
    const report = parsePushRejection(SECRET.replace(SHA1, commits[0].hash).replace('config/settings.json', 'settings.json'))!;
    const analyzed = await analyzeReport(git, report, { branch: 'main', remote: 'origin', remoteBranch: 'main', head, canRewrite: true });
    expect(analyzed.violations[0].files[0].path).toBe('settings.json');
    const rechecked = await recheckReport(git, analyzed, r.newHead);
    expect(rechecked.violations[0].status).toBe('resolved');

    // Undo brings the original commits back.
    await git.restoreBackup('main', r.backupRef, 'settings.json');
    expect(await git.revParse('HEAD')).toBe(head);
    expect((await recheckReport(git, analyzed, head)).violations[0].status).toBe('still-present');
  });

  it('drops a commit that only contained the removed file', async () => {
    write('big.bin', 'x'.repeat(1000));
    await git.stageAll();
    await git.commit('add big file', 'none');
    const head = await git.revParse('HEAD');
    const r = await git.dropPathFromCommits('big.bin', 'main', await git.unpushedCommits(head, 'origin'));
    expect(r.dropped).toBe(1);
    expect((await runGit({ cwd: git.root, args: ['log', '--format=%s', 'origin/main..main'] })).stdout.trim().split('\n')).toEqual(['more feature', 'feature + oops']);
    expect(fs.existsSync(path.join(git.root, 'big.bin'))).toBe(true);
    expect((await git.status()).untracked.map((f) => f.path)).toEqual(['big.bin']);
  });
});
