import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  BranchInfo,
  BranchOrigin,
  CommitDetails,
  CommitInfo,
  CommitStatFile,
  CompareResult,
  ConflictFile,
  ConflictSnapshot,
  FileAtCommit,
  BranchChanges,
  MergeForecast,
  TransplantPreview,
  TransplantResult,
  HistoryActionResult,
  RebasePreview,
  ResetMode,
  ResetPreview,
  ResetResult,
  CodeEntry,
  CodeInfo,
  CodeLastCommit,
  CodeSearchHit,
  GraphCommit,
  TagInfo,
  HistoryQuery,
  FileDiff,
  GitIdentity,
  InProgressOperation,
  RemoteInfo,
  RepoStatus,
  SigningMethod,
  StashEntry,
  RepoContributor,
} from '../../shared/types';
import { resolveInsideRepo, sanitizeRepoPaths } from '../util/paths';
import { isValidBranchName, isValidRemoteName } from '../util/validate';
import { buildGitAuthEnv, type ResolvedGitAuth } from './credentials';
import { AppError, toFriendlyError } from './errors';
import {
  BRANCH_FORMAT,
  GRAPH_FIELDS,
  GRAPH_FORMAT,
  LOG_FORMAT,
  mergeNumstat,
  parseGraphLog,
  looksBinary,
  parseBranches,
  parseReflogOrigin,
  inferOrigin,
  parseLog,
  parseNameStatus,
  parseNameRev,
  branchFromMergeSubject,
  parseLsTree,
  parseGrep,
  parseStashList,
  parseStatusV2,
  parseUnifiedDiff,
  synthesizeAddedDiff,
} from './parsers';
import { explainConflictCode, hasConflictMarkers } from './conflicts';
import { parseRemoteUrl, validateRemoteUrl } from './remoteUrl';
import { runGit, type GitRunOptions } from './runner';
import { languageOf } from '../../shared/languages';
import { buildPartialPatch } from '../../shared/partialPatch';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Idle limits (no output for this long), not total durations. */
const NETWORK_TIMEOUT = 10 * 60_000;
const LONG_LOCAL_TIMEOUT = 30 * 60_000;
/** "Writing objects:  42% (5/12)" and similar --progress lines, dropped from summaries. */
const PROGRESS_LINE = /^(?:remote: )?(?:[A-Za-z][A-Za-z ]+:\s+\d{1,3}% \(|(?:Enumerating|Counting|Compressing|Writing) objects|Delta compression|Total \d+ )/;
const MAX_FILE_PREVIEW = 2 * 1024 * 1024;

/** Flags that stop diff from running external programs configured by the repository. */
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--no-color'];

export interface GitServiceOptions {
  runHooks?: boolean;
}

/**
 * All Git operations for one repository. UI code never runs git directly; it
 * goes through IPC handlers that call this service. Every argument that comes
 * from the user is validated and separated from options with `--`.
 */
export class GitService {
  readonly root: string;
  private readonly runHooks: boolean;

  constructor(root: string, opts: GitServiceOptions = {}) {
    this.root = root;
    this.runHooks = !!opts.runHooks;
  }

  private git(args: string[], opts: Partial<GitRunOptions> = {}) {
    return runGit({ cwd: this.root, args, runHooks: this.runHooks, ...opts });
  }

  private async gitOut(args: string[], opts: Partial<GitRunOptions> = {}): Promise<string> {
    return (await this.git(args, opts)).stdout;
  }

  private async authEnv(auth: ResolvedGitAuth) {
    let sshCommandConfigured = false;
    if (auth.kind === 'ssh') sshCommandConfigured = !!(await this.getConfig('core.sshCommand'));
    return buildGitAuthEnv(auth, { sshCommandConfigured });
  }

  // ---------------------------------------------------------------------
  // Repository lifecycle
  // ---------------------------------------------------------------------

  static async init(dir: string, initialBranch = 'main'): Promise<GitService> {
    if (!isValidBranchName(initialBranch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${initialBranch}" is not a valid branch name.` });
    await fs.mkdir(dir, { recursive: true });
    await runGit({ cwd: dir, args: ['init', `--initial-branch=${initialBranch}`] });
    return new GitService(dir);
  }

  /** `transportUrl` (an HTTPS equivalent of an SSH URL) is used for the download only; origin keeps `url`. */
  static async clone(
    parentDir: string,
    url: string,
    folderName: string,
    auth: ResolvedGitAuth,
    transportUrl?: string,
    opts: { onProgress?: (line: string) => void; signal?: AbortSignal } = {},
  ): Promise<GitService> {
    for (const u of [url, transportUrl].filter((x): x is string => !!x)) {
      const v = validateRemoteUrl(u);
      if (!v.ok) throw new AppError({ code: 'invalid-url', title: 'Invalid Remote URL', message: v.reason });
    }
    const target = path.join(parentDir, folderName);
    // Like fetch/push: a global core.sshCommand (e.g. Windows OpenSSH for its agent) is respected.
    let sshCommandConfigured = false;
    if (auth.kind === 'ssh') {
      const r = await runGit({ cwd: parentDir, args: ['config', '--get', 'core.sshCommand'], okExitCodes: [1] }).catch(() => null);
      sshCommandConfigured = !!r?.stdout.trim();
    }
    const { env, secrets } = buildGitAuthEnv(auth, { sshCommandConfigured });
    // --no-checkout is not used: checkout does not execute repository code because hooks are
    // disabled (core.hooksPath) and the clone has no repository-local config yet.
    await runGit({
      cwd: parentDir,
      args: ['clone', '--progress', '--no-recurse-submodules', '--', transportUrl ?? url, folderName],
      env,
      secrets,
      timeoutMs: NETWORK_TIMEOUT,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
    if (transportUrl) await runGit({ cwd: target, args: ['remote', 'set-url', '--', 'origin', url] });
    return new GitService(target);
  }

  /**
   * The working tree that contains `dir`, or null when it is not inside a repository. Throws for a
   * repository Git refuses to use (another user's folder) or one without a working tree (bare, or the
   * .git folder itself), so the user is not sent to "Create Repository" for an existing one.
   */
  static async findTopLevel(dir: string): Promise<string | null> {
    try {
      const out = await runGit({ cwd: dir, args: ['rev-parse', '--show-toplevel'] });
      return path.resolve(out.stdout.trim());
    } catch (err) {
      const text = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message ?? ''}`;
      if (/dubious ownership|safe\.directory/i.test(text)) throw new AppError(toFriendlyError(err, 'Open Repository'));
      if (/must be run in a work tree/i.test(text)) {
        throw new AppError({
          code: 'bare-repo',
          title: 'Repository Without Working Files',
          message: `${dir} is a bare repository or the .git folder itself, so there are no files to work on. Choose the project folder that contains .git, or clone this repository into a new folder.`,
        });
      }
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Status & diffs
  // ---------------------------------------------------------------------

  async status(): Promise<RepoStatus> {
    const out = await this.gitOut(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ...parseStatusV2(out), operation: await this.operationInProgress() };
  }

  async operationInProgress(): Promise<InProgressOperation> {
    const gitDir = await this.gitDir();
    const exists = async (p: string) => {
      try {
        await fs.access(path.join(gitDir, p));
        return true;
      } catch {
        return false;
      }
    };
    if ((await exists('rebase-merge')) || (await exists('rebase-apply'))) return 'rebase';
    if (await exists('MERGE_HEAD')) return 'merge';
    if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (await exists('REVERT_HEAD')) return 'revert';
    return null;
  }

  private gitDirCache: string | null = null;
  async gitDir(): Promise<string> {
    if (!this.gitDirCache) {
      const out = (await this.gitOut(['rev-parse', '--absolute-git-dir'])).trim();
      this.gitDirCache = path.resolve(out);
    }
    return this.gitDirCache;
  }

  async hasHead(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  async diffFile(relPath: string, area: 'staged' | 'unstaged' | 'untracked' | 'conflicted'): Promise<FileDiff | null> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    if (area === 'untracked') {
      const full = resolveInsideRepo(this.root, p);
      const stat = await fs.stat(full);
      if (!stat.isFile()) return synthesizeAddedDiff(p, '', false);
      if (stat.size > MAX_FILE_PREVIEW) {
        return { ...synthesizeAddedDiff(p, '', false), truncated: true };
      }
      const buf = await fs.readFile(full);
      const binary = looksBinary(buf);
      return synthesizeAddedDiff(p, binary ? '' : buf.toString('utf8'), binary);
    }
    const args = ['diff', ...SAFE_DIFF, '-M'];
    if (area === 'staged') args.push('--cached');
    args.push('--', p);
    const diffs = parseUnifiedDiff(await this.gitOut(args));
    return diffs[0] ?? null;
  }

  async diffRange(from: string, to: string, opts: { threeDot?: boolean } = {}): Promise<FileDiff[]> {
    this.assertRevision(from);
    this.assertRevision(to);
    const range = opts.threeDot ? `${from}...${to}` : `${from}..${to}`;
    const out = await this.gitOut(['diff', ...SAFE_DIFF, '-M', range, '--'], { maxBufferBytes: 200 * 1024 * 1024 });
    return parseUnifiedDiff(out);
  }

  async nameStatus(from: string, to: string, threeDot = false): Promise<{ path: string; status: string }[]> {
    this.assertRevision(from);
    this.assertRevision(to);
    const range = threeDot ? `${from}...${to}` : `${from}..${to}`;
    return parseNameStatus(await this.gitOut(['diff', ...SAFE_DIFF, '--name-status', '-M', '-z', range, '--']));
  }

  /** Hash of the staged changes, used to bind a commit confirmation to exactly what was reviewed. */
  async stagedFingerprint(): Promise<string> {
    return this.gitOut(['diff', '--cached', '--raw', '-z', '--no-abbrev', ...SAFE_DIFF]);
  }

  // ---------------------------------------------------------------------
  // Staging
  // ---------------------------------------------------------------------

  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const clean = sanitizeRepoPaths(this.root, paths);
    await this.git(['add', '--', ...clean]);
  }

  async stageAll(): Promise<void> {
    await this.git(['add', '--all']);
  }

  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const clean = sanitizeRepoPaths(this.root, paths);
    if (await this.hasHead()) await this.git(['restore', '--staged', '--', ...clean]);
    else await this.git(['rm', '--cached', '-r', '-q', '--', ...clean]);
  }

  async unstageAll(): Promise<void> {
    if (await this.hasHead()) await this.git(['restore', '--staged', '--', '.']);
    else await this.git(['rm', '--cached', '-r', '-q', '--', '.']);
  }

  /**
   * Discards working-tree changes. A copy of every affected file is saved to
   * `backupDir` first, so even a confirmed discard is recoverable.
   */
  async discard(paths: string[], backupDir: string): Promise<{ backedUp: number }> {
    const clean = sanitizeRepoPaths(this.root, paths);
    const status = await this.status();
    const untracked = new Set(status.untracked.map((f) => f.path));
    const tracked = clean.filter((p) => !untracked.has(p));
    const removed = clean.filter((p) => untracked.has(p));

    let backedUp = 0;
    for (const p of clean) {
      const src = resolveInsideRepo(this.root, p);
      try {
        const st = await fs.stat(src);
        if (!st.isFile()) continue;
        const dest = path.join(backupDir, p);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
        backedUp++;
      } catch {
        // deleted files have nothing to back up
      }
    }
    if (tracked.length) await this.git(['restore', '--worktree', '--', ...tracked]);
    for (const p of removed) await fs.rm(resolveInsideRepo(this.root, p), { force: true });
    return { backedUp };
  }

  // ---------------------------------------------------------------------
  // Identity & config
  // ---------------------------------------------------------------------

  async getConfig(key: string): Promise<string | null> {
    try {
      const out = await this.gitOut(['config', '--get', key], { okExitCodes: [] });
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async identity(): Promise<GitIdentity> {
    const [name, email, signingKey, gpgFormat, sign] = await Promise.all([
      this.getConfig('user.name'),
      this.getConfig('user.email'),
      this.getConfig('user.signingkey'),
      this.getConfig('gpg.format'),
      this.getConfig('commit.gpgsign'),
    ]);
    return { name, email, signingKey, gpgFormat, commitGpgSign: sign === 'true' };
  }

  async setIdentity(name: string, email: string): Promise<void> {
    await this.git(['config', '--local', 'user.name', name]);
    await this.git(['config', '--local', 'user.email', email]);
  }

  signingOptions(identity: GitIdentity): { method: SigningMethod; label: string; description: string }[] {
    const options: { method: SigningMethod; label: string; description: string }[] = [
      { method: 'none', label: 'Git identity only (unsigned)', description: `Commit as ${identity.name ?? '?'} <${identity.email ?? '?'}> without a cryptographic signature.` },
    ];
    // A configured gpg.format=ssh / x509 is offered first, so signing uses the key the user set up.
    if (identity.gpgFormat === 'ssh') {
      options.push({
        method: 'ssh',
        label: 'SSH signed commit',
        description: identity.signingKey ? `Sign with your SSH key ${identity.signingKey} (gpg.format=ssh).` : 'Sign with the SSH key set in user.signingkey (gpg.format=ssh).',
      });
    } else if (identity.gpgFormat === 'x509') {
      options.push({ method: 'x509', label: 'X.509 signed commit', description: `Sign with your X.509 certificate${identity.signingKey ? ` ${identity.signingKey}` : ''} (gpg.format=x509).` });
    }
    const gpgKey = (identity.gpgFormat ?? 'openpgp') === 'openpgp' ? identity.signingKey : null;
    options.push({
      method: 'gpg',
      label: 'GPG signed commit',
      description: gpgKey
        ? `Sign with your GPG key ${gpgKey}. GPG may ask for its passphrase in its own window.`
        : `Sign with your default GPG key for ${identity.email ?? 'your email'} (GPG must be installed). GPG may ask for its passphrase in its own window.`,
    });
    return options;
  }

  // ---------------------------------------------------------------------
  // Commit
  // ---------------------------------------------------------------------

  async commit(message: string, signing: SigningMethod, opts: { allowEmpty?: boolean } = {}): Promise<CommitInfo> {
    const args = this.signingArgs(signing);
    // Same as `git commit -F`: keep lines starting with "#" (such as "#42 fix …").
    args.push('commit', '--file=-', '--cleanup=whitespace');
    args.push(signing === 'none' ? '--no-gpg-sign' : '--gpg-sign');
    if (opts.allowEmpty) args.push('--allow-empty');
    await this.git(args, { input: message, timeoutMs: 5 * 60_000 });
    const [head] = await this.log({ limit: 1 });
    return head;
  }

  // ---------------------------------------------------------------------
  // Remotes
  // ---------------------------------------------------------------------

  async remotes(): Promise<RemoteInfo[]> {
    const out = await this.gitOut(['remote', '-v']);
    const map = new Map<string, RemoteInfo>();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line.trim());
      if (!m) continue;
      const [, name, url, kind] = m;
      const parsed = parseRemoteUrl(url);
      const entry = map.get(name) ?? {
        name,
        fetchUrl: url,
        pushUrl: url,
        protocol: parsed.protocol,
        isGitHub: parsed.isGitHub,
        hasEmbeddedCredentials: parsed.hasEmbeddedCredentials,
      };
      if (kind === 'fetch') entry.fetchUrl = url;
      else entry.pushUrl = url;
      entry.hasEmbeddedCredentials = entry.hasEmbeddedCredentials || parsed.hasEmbeddedCredentials;
      map.set(name, entry);
    }
    return [...map.values()];
  }

  async setRemote(name: string, url: string): Promise<void> {
    if (!isValidRemoteName(name)) throw new AppError({ code: 'invalid-remote', title: 'Invalid Remote Name', message: `"${name}" is not a valid remote name.` });
    const v = validateRemoteUrl(url);
    if (!v.ok) throw new AppError({ code: 'invalid-url', title: 'Invalid Remote URL', message: v.reason });
    const existing = (await this.remotes()).some((r) => r.name === name);
    await this.git(existing ? ['remote', 'set-url', '--', name, url] : ['remote', 'add', '--', name, url]);
  }

  async removeRemote(name: string): Promise<void> {
    if (!isValidRemoteName(name)) throw new AppError({ code: 'invalid-remote', title: 'Invalid Remote Name', message: `"${name}" is not a valid remote name.` });
    await this.git(['remote', 'remove', '--', name]);
  }

  /** Builds `-c` options and env for the chosen commit signing method. */
  private signingArgs(signing: SigningMethod): string[] {
    if (signing === 'gpg') return ['-c', 'gpg.format=openpgp'];
    if (signing === 'ssh') return ['-c', 'gpg.format=ssh'];
    if (signing === 'x509') return ['-c', 'gpg.format=x509'];
    return [];
  }

  /**
   * `transportUrl` lets a token method fetch a GitHub SSH remote over HTTPS for this one
   * operation; results still land in refs/remotes/<remote>/*.
   */
  async fetch(remote: string, auth: ResolvedGitAuth, transportUrl?: string): Promise<void> {
    if (!isValidRemoteName(remote)) throw new AppError({ code: 'invalid-remote', title: 'Invalid Remote', message: 'Invalid remote name.' });
    const { env, secrets } = await this.authEnv(auth);
    if (transportUrl) {
      const v = validateRemoteUrl(transportUrl);
      if (!v.ok) throw new AppError({ code: 'invalid-url', title: 'Invalid Remote URL', message: v.reason });
      await this.git(['fetch', '--progress', '--prune', '--no-recurse-submodules', '--', transportUrl, `+refs/heads/*:refs/remotes/${remote}/*`], { env, secrets, timeoutMs: NETWORK_TIMEOUT });
      return;
    }
    await this.git(['fetch', '--progress', '--prune', '--no-recurse-submodules', '--', remote], { env, secrets, timeoutMs: NETWORK_TIMEOUT });
  }

  /**
   * Pushes exactly the reviewed commit to refs/heads/<remoteBranch>. Pushing an
   * object id (not a moving ref) guarantees that what was reviewed is what is sent.
   */
  async push(remote: string, oid: string, remoteBranch: string, auth: ResolvedGitAuth, opts: { setUpstreamFor?: string; transportUrl?: string } = {}): Promise<string> {
    if (!isValidRemoteName(remote)) throw new AppError({ code: 'invalid-remote', title: 'Invalid Remote', message: 'Invalid remote name.' });
    if (!isValidBranchName(remoteBranch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch', message: 'Invalid branch name.' });
    this.assertOid(oid);
    if (opts.transportUrl) {
      const v = validateRemoteUrl(opts.transportUrl);
      if (!v.ok) throw new AppError({ code: 'invalid-url', title: 'Invalid Remote URL', message: v.reason });
    }
    const { env, secrets } = await this.authEnv(auth);
    const res = await this.git(['push', '--porcelain', '--progress', '--', opts.transportUrl ?? remote, `${oid}:refs/heads/${remoteBranch}`], {
      env,
      secrets,
      timeoutMs: NETWORK_TIMEOUT,
    });
    // Record the remote-tracking ref without another network round-trip (needed when pushing by URL).
    await this.git(['update-ref', `refs/remotes/${remote}/${remoteBranch}`, oid]);
    if (opts.setUpstreamFor && isValidBranchName(opts.setUpstreamFor)) {
      await this.git(['branch', `--set-upstream-to=${remote}/${remoteBranch}`, '--', opts.setUpstreamFor]);
    }
    const stderr = res.stderr
      .split(/[\r\n]+/)
      .filter((l) => l.trim() && !PROGRESS_LINE.test(l.trim()))
      .join('\n');
    return `${res.stdout}\n${stderr}`.trim();
  }

  // ---------------------------------------------------------------------
  // Integrating fetched changes
  // ---------------------------------------------------------------------

  async revParse(rev: string): Promise<string> {
    this.assertRevision(rev);
    return (await this.gitOut(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])).trim();
  }

  async parentOf(oid: string): Promise<string | null> {
    this.assertOid(oid);
    try {
      return (await this.gitOut(['rev-parse', '--verify', '--quiet', `${oid}^1`])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Commits reachable from `oid` that no remote-tracking branch of `remote` contains yet. */
  async commitsNotOnRemote(oid: string, remote: string, limit: number): Promise<CommitInfo[]> {
    this.assertOid(oid);
    if (!isValidRemoteName(remote)) throw new AppError({ code: 'invalid-remote', title: 'Invalid Remote', message: 'Invalid remote name.' });
    return parseLog(await this.gitOut(['log', `--format=${LOG_FORMAT}`, `-n${limit}`, oid, '--not', `--remotes=${remote}`, '--']));
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    this.assertRevision(a);
    this.assertRevision(b);
    const res = await this.git(['merge-base', '--is-ancestor', a, b], { okExitCodes: [1] });
    return res.exitCode === 0;
  }

  /** Renames a local branch that has not been published (no upstream, no branch of that name on any remote). */
  async renameBranch(oldName: string, newName: string): Promise<void> {
    for (const n of [oldName, newName]) if (!isValidBranchName(n)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${n}" is not a valid branch name.` });
    if (!(await this.tryRevParse(`refs/heads/${oldName}`))) throw new AppError({ code: 'invalid-branch', title: 'Branch Not Found', message: `There is no local branch ${oldName}.` });
    if (await this.tryRevParse(`refs/heads/${newName}`)) throw new AppError({ code: 'branch-exists', title: 'Branch Exists', message: `A branch named ${newName} already exists.` });
    const upstream = (await this.gitOut(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${oldName}`])).trim();
    const remotes = (await this.gitOut(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).split('\n').filter((r) => r && !r.endsWith('/HEAD'));
    const onRemote = remotes.find((r) => r.slice(r.indexOf('/') + 1) === oldName);
    if (upstream || onRemote) {
      throw new AppError({ code: 'branch-published', title: 'Branch Is Published', message: `${oldName} already exists on the remote (${upstream || onRemote}). Renaming it here would leave the remote branch behind and break tracking, so only unpublished branches can be renamed.` });
    }
    await this.git(['branch', '-m', '--', oldName, newName]);
  }

  /** Moves a (not checked-out) branch to `newOid`, only if it still points to `expectedOld`. */
  async updateBranchRef(branch: string, newOid: string, expectedOld: string): Promise<void> {
    if (!isValidBranchName(branch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${branch}" is not a valid branch name.` });
    this.assertOid(newOid);
    this.assertOid(expectedOld);
    await this.git(['update-ref', '-m', 'Git Baba: fast-forward to remote', `refs/heads/${branch}`, newOid, expectedOld]);
  }

  async mergeFastForwardOnly(oid: string): Promise<void> {
    this.assertOid(oid);
    await this.git(['merge', '--ff-only', '--no-edit', oid]);
  }

  /** Returns true when the merge stopped with conflicts. */
  /**
   * Returns true when the merge stopped with conflicts.
   * `allowUnrelated` combines branches without common history (only after explicit user consent);
   * `prefer` auto-resolves conflicting hunks in favour of one side (-X ours / -X theirs).
   */
  async merge(oid: string, opts: { message?: string; allowUnrelated?: boolean; prefer?: 'ours' | 'theirs' } = {}): Promise<boolean> {
    this.assertOid(oid);
    // --ff: a merge was asked for, so a user's merge.ff=only must not turn it into a refusal.
    const args = ['merge', '--no-edit', '--ff'];
    if (opts.allowUnrelated) args.push('--allow-unrelated-histories');
    if (opts.prefer) args.push('-X', opts.prefer);
    if (opts.message) args.push('-m', opts.message);
    args.push(oid);
    try {
      await this.git(args, { timeoutMs: LONG_LOCAL_TIMEOUT });
      return false;
    } catch (err) {
      if ((await this.status()).conflicted.length > 0) return true;
      throw err;
    }
  }

  /** Squash and merge: all of `oid`'s changes as one new commit on the current branch. True on conflicts. */
  async squashMerge(oid: string, message: string, opts: { allowUnrelated?: boolean; prefer?: 'ours' | 'theirs' } = {}): Promise<boolean> {
    this.assertOid(oid);
    const args = ['merge', '--squash'];
    if (opts.allowUnrelated) args.push('--allow-unrelated-histories');
    if (opts.prefer) args.push('-X', opts.prefer);
    args.push(oid);
    try {
      await this.git(args, { timeoutMs: LONG_LOCAL_TIMEOUT });
    } catch (err) {
      if ((await this.status()).conflicted.length > 0) return true;
      throw err;
    }
    // Nothing staged: the target already had every change.
    if (!(await this.gitOut(['diff', '--cached', '--name-only'])).trim()) return false;
    await this.git(['commit', '--file=-', '--cleanup=whitespace'], { input: message, timeoutMs: 5 * 60_000 });
    return false;
  }

  /**
   * Rebase and merge: replays the commits of `base..oid` (merge commits skipped) one by one onto the
   * current branch, keeping history linear. True on conflicts (the cherry-pick sequence can be continued).
   */
  async replayCommits(base: string, oid: string, opts: { prefer?: 'ours' | 'theirs' } = {}): Promise<boolean> {
    this.assertOid(base);
    this.assertOid(oid);
    const list = (await this.gitOut(['rev-list', '--reverse', '--no-merges', `${base}..${oid}`])).split('\n').filter(Boolean);
    if (!list.length) return false;
    const args = ['cherry-pick', '--allow-empty', '--keep-redundant-commits'];
    if (opts.prefer) args.push('-X', opts.prefer);
    try {
      await this.git([...args, ...list], { timeoutMs: LONG_LOCAL_TIMEOUT });
      return false;
    } catch (err) {
      if ((await this.status()).conflicted.length > 0) return true;
      throw err;
    }
  }

  async rebase(oid: string): Promise<boolean> {
    this.assertOid(oid);
    try {
      await this.git(['rebase', '--no-autostash', oid], { timeoutMs: LONG_LOCAL_TIMEOUT });
      return false;
    } catch (err) {
      if ((await this.status()).conflicted.length > 0) return true;
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Conflicts
  // ---------------------------------------------------------------------

  async conflictFile(relPath: string): Promise<ConflictFile> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const status = await this.status();
    const entry = status.conflicted.find((c) => c.path === p);
    const op = status.operation;
    const full = resolveInsideRepo(this.root, p);
    let content = '';
    let binary = false;
    try {
      const buf = await fs.readFile(full);
      binary = looksBinary(buf);
      content = binary ? '' : buf.toString('utf8');
    } catch {
      content = '';
    }
    const isRebase = op === 'rebase';
    return {
      path: p,
      content,
      binary,
      hasMarkers: !binary && hasConflictMarkers(content),
      conflictCode: entry?.conflictCode ?? '',
      explanation: explainConflictCode(entry?.conflictCode ?? '', op),
      oursLabel: isRebase ? 'Current (upstream you are rebasing onto)' : 'Current (your branch)',
      theirsLabel: isRebase ? 'Incoming (your commit being replayed)' : 'Incoming (remote/other branch)',
    };
  }

  /** Writes resolved content for a conflicted file. Never stages it — the user marks it resolved explicitly. */
  async writeResolution(relPath: string, content: string): Promise<void> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const status = await this.status();
    if (!status.conflicted.some((c) => c.path === p)) {
      throw new AppError({ code: 'not-conflicted', title: 'File Is Not Conflicted', message: 'Only conflicted files can be edited here.' });
    }
    await fs.writeFile(resolveInsideRepo(this.root, p), content, 'utf8');
  }

  /** Resolve a whole file by taking one side (works for binary and delete/modify conflicts too). */
  async takeSide(relPath: string, side: 'ours' | 'theirs'): Promise<void> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const status = await this.status();
    const entry = status.conflicted.find((c) => c.path === p);
    if (!entry) throw new AppError({ code: 'not-conflicted', title: 'File Is Not Conflicted', message: 'Only conflicted files can be resolved here.' });
    const code = entry.conflictCode ?? 'UU';
    // Deleted on the chosen side → resolution is deletion.
    const deletedOnSide = side === 'ours' ? code[0] === 'D' : code[1] === 'D';
    if (deletedOnSide) {
      await fs.rm(resolveInsideRepo(this.root, p), { force: true });
      return;
    }
    await this.git(['checkout', side === 'ours' ? '--ours' : '--theirs', '--', p]);
  }

  async markResolved(relPath: string): Promise<void> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const full = resolveInsideRepo(this.root, p);
    let exists = true;
    try {
      const buf = await fs.readFile(full);
      if (!looksBinary(buf) && hasConflictMarkers(buf.toString('utf8'))) {
        throw new AppError({
          code: 'markers-remain',
          title: 'Conflict Markers Remain',
          message: `${p} still contains conflict markers (<<<<<<< ======= >>>>>>>). Resolve every block before marking it resolved.`,
        });
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      exists = false;
    }
    if (exists) await this.git(['add', '--', p]);
    else await this.git(['rm', '--quiet', '--', p]);
  }

  // ---------------------------------------------------------------------
  // Conflict snapshots (undo for "accept" / "mark resolved")
  // ---------------------------------------------------------------------

  private async snapshotFile(): Promise<string> {
    return path.join(await this.gitDir(), 'gitbaba-conflicts.json');
  }

  /** Saved original conflict states, valid only while HEAD is unchanged (a new rebase step / operation discards them). */
  async readConflictSnapshots(): Promise<Record<string, ConflictSnapshot>> {
    try {
      const raw = JSON.parse(await fs.readFile(await this.snapshotFile(), 'utf8')) as { head: string | null; files: Record<string, ConflictSnapshot> };
      const head = (await this.hasHead()) ? await this.revParse('HEAD') : null;
      return raw.head === head ? raw.files : {};
    } catch {
      return {};
    }
  }

  private async writeConflictSnapshots(files: Record<string, ConflictSnapshot>): Promise<void> {
    const file = await this.snapshotFile();
    if (!Object.keys(files).length) {
      await fs.rm(file, { force: true });
      return;
    }
    const head = (await this.hasHead()) ? await this.revParse('HEAD') : null;
    await fs.writeFile(file, JSON.stringify({ head, files }));
  }

  async clearConflictSnapshots(): Promise<void> {
    await fs.rm(await this.snapshotFile(), { force: true });
  }

  /**
   * Saves the original conflicted state of a file (its three index stages and the working file
   * with markers, stored as Git objects) before the first change, so it can be restored later.
   */
  async snapshotConflict(relPath: string): Promise<void> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const snaps = await this.readConflictSnapshots();
    if (snaps[p]) return;
    const out = await this.gitOut(['ls-files', '-u', '-z', '--', p]);
    const stages = out
      .split('\0')
      .filter(Boolean)
      .map((l) => {
        const [meta, file] = l.split('\t');
        const [mode, oid, stage] = meta.split(' ');
        return { mode, oid, stage: Number(stage), file };
      })
      .filter((s) => s.file === p)
      .map(({ mode, oid, stage }) => ({ mode, oid, stage }));
    if (!stages.length) return; // not (or no longer) conflicted
    let working: string | null = null;
    try {
      await fs.access(resolveInsideRepo(this.root, p));
      working = (await this.gitOut(['hash-object', '-w', '--', p])).trim();
    } catch {
      working = null;
    }
    snaps[p] = { stages, working };
    await this.writeConflictSnapshots(snaps);
  }

  /** Puts a file back into its original conflicted state (undoes accept/edit/mark resolved). */
  async restoreConflict(relPath: string): Promise<void> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const snaps = await this.readConflictSnapshots();
    const s = snaps[p];
    if (!s) throw new AppError({ code: 'no-snapshot', title: 'Nothing to Undo', message: `There is no saved conflict state for ${p}. It may have been resolved before this version of Git Baba, or the operation moved on.` });
    const zero = '0'.repeat(40);
    const setIndex = (lines: string[]) => this.git(['update-index', '--index-info'], { input: `${lines.join('\n')}\n` });
    const full = resolveInsideRepo(this.root, p);
    if (s.working) {
      // Let Git write the saved file (binary-safe, same line-ending filters): stage it, check it out…
      const mode = (s.stages.find((x) => x.stage === 2) ?? s.stages[s.stages.length - 1]).mode;
      await setIndex([`0 ${zero}\t${p}`, `${mode} ${s.working} 0\t${p}`]);
      await this.git(['checkout-index', '-f', '--', p]);
    } else {
      await fs.rm(full, { force: true });
    }
    // …then put back the three conflict stages exactly as they were.
    await setIndex([`0 ${zero}\t${p}`, ...s.stages.map((st) => `${st.mode} ${st.oid} ${st.stage}\t${p}`)]);
  }

  /** Whether the file differs from how it looked when the conflict happened (an accept/edit was applied). */
  async conflictChanged(relPath: string, snap: ConflictSnapshot): Promise<boolean> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    try {
      await fs.access(resolveInsideRepo(this.root, p));
    } catch {
      return snap.working !== null;
    }
    const now = (await this.gitOut(['hash-object', '--', p])).trim();
    return now !== snap.working;
  }

  /** Branch names behind "current" and "incoming" for the operation in progress. */
  async conflictSides(): Promise<{ operation: InProgressOperation; current: string; incoming: string; currentRef: string | null; incomingRef: string | null }> {
    const op = await this.operationInProgress();
    const gitDir = await this.gitDir();
    const read = async (f: string) => {
      try {
        return (await fs.readFile(path.join(gitDir, f), 'utf8')).trim();
      } catch {
        return null;
      }
    };
    const nameOf = async (oid: string | null): Promise<string | null> => {
      if (!oid || !/^[0-9a-f]{40}$/.test(oid)) return null;
      const res = await this.git(['name-rev', '--name-only', '--no-undefined', '--exclude=refs/tags/*', oid], { okExitCodes: [128] });
      const n = res.exitCode === 0 ? res.stdout.trim().replace(/^remotes\//, '').replace(/[~^]\d*$/, '') : '';
      return n || oid.slice(0, 8);
    };
    const st = await this.status();
    const branch = st.branch ?? 'HEAD';
    if (op === 'merge') {
      const msg = (await read('MERGE_MSG')) ?? '';
      const m = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg) ?? /Merge commit '([^']+)'/.exec(msg);
      const mergeHead = await read('MERGE_HEAD');
      return { operation: op, current: branch, currentRef: st.headOid, incoming: m?.[1] ?? (await nameOf(mergeHead?.split('\n')[0] ?? null)) ?? 'the other branch', incomingRef: mergeHead?.split('\n')[0] ?? null };
    }
    if (op === 'rebase') {
      const dir = (await read('rebase-merge/onto')) ? 'rebase-merge' : 'rebase-apply';
      const onto = await read(`${dir}/onto`);
      const headName = ((await read(`${dir}/head-name`)) ?? '').replace(/^refs\/heads\//, '');
      // During a rebase "ours" is the branch being rebased onto and "theirs" is your commit being replayed.
      return { operation: op, current: (await nameOf(onto)) ?? 'the new base', currentRef: onto, incoming: headName ? `your commits from ${headName}` : 'your commit being replayed', incomingRef: await read('REBASE_HEAD') };
    }
    if (op === 'cherry-pick' || op === 'revert') {
      const h = await read(op === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD');
      return { operation: op, current: branch, currentRef: st.headOid, incoming: `${op === 'revert' ? 'revert of ' : ''}${(await nameOf(h)) ?? 'the picked commit'}`, incomingRef: h };
    }
    return { operation: null, current: branch, currentRef: st.headOid, incoming: 'stashed changes', incomingRef: null };
  }

  /** Continuing a merge/rebase creates commits, so the caller must have obtained commit confirmation. */
  async continueOperation(signing: SigningMethod): Promise<void> {
    const op = await this.operationInProgress();
    const status = await this.status();
    if (status.conflicted.length > 0) {
      throw new AppError({
        code: 'unresolved',
        title: 'Unresolved Conflicts Remain',
        message: `${status.conflicted.length} file(s) are still conflicted. Resolve and mark them before continuing.`,
        actions: ['resolve-conflicts'],
      });
    }
    const signArgs = signing === 'none' ? ['-c', 'commit.gpgSign=false'] : ['-c', 'commit.gpgSign=true', ...this.signingArgs(signing)];
    const opts = {};
    if (op === 'merge') await this.git([...signArgs, 'commit', '--no-edit'], opts);
    else if (op === 'rebase') await this.git([...signArgs, '-c', 'core.editor=true', 'rebase', '--continue'], opts);
    else if (op === 'cherry-pick') await this.git([...signArgs, 'cherry-pick', '--continue'], opts);
    else if (op === 'revert') await this.git([...signArgs, 'revert', '--continue'], opts);
    else throw new AppError({ code: 'no-operation', title: 'Nothing to Continue', message: 'No merge or rebase is in progress.' });
  }

  async abortOperation(): Promise<void> {
    const op = await this.operationInProgress();
    if (op === 'merge') await this.git(['merge', '--abort']);
    else if (op === 'rebase') await this.git(['rebase', '--abort']);
    else if (op === 'cherry-pick') await this.git(['cherry-pick', '--abort']);
    else if (op === 'revert') await this.git(['revert', '--abort']);
    else throw new AppError({ code: 'no-operation', title: 'Nothing to Abort', message: 'No merge or rebase is in progress.' });
  }

  // ---------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------

  async branches(): Promise<BranchInfo[]> {
    if (!(await this.hasHead())) {
      const status = await this.status();
      return status.branch ? [{ name: status.branch, current: true, remote: false, oid: '', subject: '(no commits yet)' }] : [];
    }
    return parseBranches(await this.gitOut(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']));
  }

  /** Where each branch was started from: Git's own reflog note where it exists, else the nearest other branch in its history. */
  async branchOrigins(): Promise<Record<string, BranchOrigin>> {
    const all = await this.branches();
    if (!(await this.hasHead())) return {};
    const locals = new Set(all.filter((b) => !b.remote).map((b) => b.name));
    const result: Record<string, BranchOrigin> = {};
    const one = async (b: BranchInfo) => {
      const ref = `${b.remote ? 'refs/remotes' : 'refs/heads'}/${b.name}`;
      try {
        if (!b.remote) {
          const lines = (await this.gitOut(['reflog', 'show', '--format=%gs', ref, '--'])).split('\n').filter(Boolean);
          const from = lines.length ? parseReflogOrigin(lines[lines.length - 1]) : null;
          if (from && from !== b.name) {
            result[b.name] = { from, source: 'reflog' };
            return;
          }
        }
        const out = await this.gitOut(['log', '--first-parent', '--simplify-by-decoration', '--decorate-refs=refs/heads', '--decorate-refs=refs/remotes', '--format=%D', ref, '--'], { maxBufferBytes: 16 * 1024 * 1024 });
        const from = inferOrigin(b.name, out.split('\n').filter((l) => l.trim()), locals);
        if (from) result[b.name] = { from, source: 'inferred' };
      } catch {
        // unknown origin: show nothing
      }
    };
    const queue = all.filter((b) => !b.name.endsWith('/HEAD'));
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let b = queue.shift(); b; b = queue.shift()) await one(b);
    }));
    return result;
  }

  async createBranch(name: string, startPoint: string | null, switchTo: boolean): Promise<void> {
    if (!isValidBranchName(name)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${name}" is not a valid branch name.` });
    if (startPoint) this.assertRevision(startPoint);
    // --no-track: a new branch started from origin/main must not track main (pushing it would update main).
    if (switchTo) await this.git(['switch', '--no-track', '-c', name, ...(startPoint ? [startPoint] : [])]);
    else await this.git(['branch', '--no-track', '--', name, ...(startPoint ? [startPoint] : [])]);
  }

  async switchBranch(name: string): Promise<void> {
    if (!isValidBranchName(name)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${name}" is not a valid branch name.` });
    // No --discard-changes / --force: git refuses if local changes would be lost.
    await this.git(['switch', name]);
  }

  async deleteBranch(name: string, force: boolean): Promise<void> {
    if (!isValidBranchName(name)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${name}" is not a valid branch name.` });
    await this.git(['branch', force ? '-D' : '-d', '--', name]);
  }

  /** Commit id of a ref, or null when it does not exist. */
  async tryRevParse(rev: string): Promise<string | null> {
    try {
      return (await this.revParse(rev)) || null;
    } catch {
      return null;
    }
  }

  /**
   * Predicts a merge without touching the working tree or index (git merge-tree, Git 2.38+).
   * Returns the conflicted paths, or null when the prediction is not available.
   */
  async predictMergeConflicts(ours: string, theirs: string, allowUnrelated = false): Promise<string[] | null> {
    this.assertRevision(ours);
    this.assertRevision(theirs);
    try {
      const res = await this.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', ...(allowUnrelated ? ['--allow-unrelated-histories'] : []), ours, theirs], { okExitCodes: [1] });
      if (res.exitCode === 0) return [];
      // First line is the tree id; then the conflicted paths.
      return [...new Set(res.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))];
    } catch {
      return null;
    }
  }

  /** Commits reachable from `ref` that no other branch/tag/remote ref (except `excluding`) contains. */
  async uniqueCommitCount(ref: string, excluding: string[]): Promise<number> {
    this.assertRevision(ref);
    excluding.forEach((r) => this.assertRevision(r));
    const out = await this.gitOut(['rev-list', '--count', ref, '--not', ...excluding.map((r) => `--exclude=${r}`), '--all']);
    return Number(out.trim()) || 0;
  }

  /** The remote's default branch as last fetched (refs/remotes/<remote>/HEAD), if known. */
  async remoteDefaultBranch(remote: string): Promise<string | null> {
    if (!isValidRemoteName(remote)) return null;
    const res = await this.git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { okExitCodes: [1, 128] });
    const v = res.exitCode === 0 ? res.stdout.trim() : '';
    return v.startsWith(`${remote}/`) ? v.slice(remote.length + 1) : null;
  }

  /** Asks the remote (not the local tracking ref) where a branch points. Null when it does not exist. */
  async lsRemoteBranch(remote: string, branch: string, auth: ResolvedGitAuth, transportUrl?: string): Promise<string | null> {
    if (!isValidRemoteName(remote)) throw new AppError({ code: 'invalid-remote', title: 'Invalid Remote', message: 'Invalid remote name.' });
    if (!isValidBranchName(branch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch', message: 'Invalid branch name.' });
    if (transportUrl) {
      const v = validateRemoteUrl(transportUrl);
      if (!v.ok) throw new AppError({ code: 'invalid-url', title: 'Invalid Remote URL', message: v.reason });
    }
    const { env, secrets } = await this.authEnv(auth);
    const out = await this.gitOut(['ls-remote', '--heads', '--', transportUrl ?? remote, `refs/heads/${branch}`], { env, secrets, timeoutMs: NETWORK_TIMEOUT });
    const line = out.split('\n').find((l) => l.trim().endsWith(`\trefs/heads/${branch}`));
    return line ? line.split('\t')[0].trim() : null;
  }

  // ---------------------------------------------------------------------
  // Safe branch switching with uncommitted changes
  // ---------------------------------------------------------------------

  /** Snapshot of tracked changes as a stash-like commit, without touching files, index or refs. */
  async snapshotTrackedChanges(): Promise<string | null> {
    const oid = (await this.gitOut(['stash', 'create'])).trim();
    return oid || null;
  }

  /**
   * Predicts which tracked files would conflict if the changes captured in `snapshot`
   * (made on top of `base`) were applied to `target`. Nothing in the repository changes.
   */
  async predictApplyConflicts(base: string, target: string, snapshot: string): Promise<string[] | null> {
    [base, target, snapshot].forEach((r) => this.assertRevision(r));
    try {
      const res = await this.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, target, snapshot], { okExitCodes: [1] });
      if (res.exitCode === 0) return [];
      return [...new Set(res.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))];
    } catch {
      return null;
    }
  }

  /** Which of `paths` exist in the tree of `ref`. */
  async pathsInTree(ref: string, paths: string[]): Promise<Set<string>> {
    this.assertRevision(ref);
    if (!paths.length) return new Set();
    const safe = sanitizeRepoPaths(this.root, paths);
    const found = new Set<string>();
    for (let i = 0; i < safe.length; i += 200) {
      const out = await this.gitOut(['ls-tree', '-r', '--name-only', ref, '--', ...safe.slice(i, i + 200)]);
      out.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => found.add(l));
    }
    return found;
  }

  /** Stashes everything (tracked and untracked) and returns the stash commit id. */
  async stashAll(message: string): Promise<string> {
    const before = await this.tryRevParse('refs/stash');
    await this.git(['stash', 'push', '--include-untracked', '-m', message]);
    const after = await this.tryRevParse('refs/stash');
    if (!after || after === before) throw new AppError({ code: 'stash-failed', title: 'Nothing Was Stashed', message: 'Git did not create a stash for your changes.' });
    return after;
  }

  /** Applies a stash by commit id. Returns true when it stopped with conflicts (the stash is kept). */
  async stashApplyCommit(oid: string): Promise<boolean> {
    this.assertOid(oid);
    try {
      await this.git(['stash', 'apply', oid]);
      return false;
    } catch (err) {
      if ((await this.status()).conflicted.length > 0) return true;
      throw err;
    }
  }

  /** Index of a stash entry by its commit id, or null when it no longer exists. */
  async stashIndexOf(oid: string): Promise<number | null> {
    this.assertOid(oid);
    const res = await this.git(['stash', 'list', '--format=%H'], { okExitCodes: [1] });
    const i = res.stdout.split('\n').map((l) => l.trim()).indexOf(oid);
    return i >= 0 ? i : null;
  }

  async stashDropCommit(oid: string): Promise<boolean> {
    const i = await this.stashIndexOf(oid);
    if (i === null) return false;
    await this.git(['stash', 'drop', `stash@{${i}}`]);
    return true;
  }

  /** Untracked files recorded in a stash (its third parent), if any. */
  async stashUntrackedPaths(oid: string): Promise<string[]> {
    this.assertOid(oid);
    // `oid` is a validated object id, so `^3` (third parent = untracked files) is safe here.
    const res = await this.git(['rev-parse', '--verify', '--quiet', `${oid}^3`], { okExitCodes: [1] });
    const third = res.exitCode === 0 ? res.stdout.trim() : '';
    if (!third) return [];
    return (await this.gitOut(['ls-tree', '-r', '--name-only', third])).split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /** Creates a local branch tracking a remote branch and switches to it. */
  async switchToNewTracking(local: string, remoteRef: string): Promise<void> {
    if (!isValidBranchName(local)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${local}" is not a valid branch name.` });
    this.assertRevision(remoteRef);
    await this.git(['switch', '--track', '-c', local, remoteRef]);
  }

  /** Unstages everything; working-tree files are left exactly as they are. */
  async unstageAllKeepFiles(): Promise<void> {
    await this.git(['reset', '-q']);
  }

  /** Removes exactly these untracked (not ignored) files. Tracked files are never touched by `git clean`. */
  async cleanUntracked(paths: string[]): Promise<void> {
    const safe = sanitizeRepoPaths(this.root, paths);
    for (let i = 0; i < safe.length; i += 200) {
      await this.git(['clean', '-f', '-q', '--', ...safe.slice(i, i + 200).map((p) => `:(literal)${p}`)]);
    }
  }

  /** Discards working-tree changes to tracked files. Only used after explicit confirmation, with a stash backup. */
  async resetHardHead(): Promise<void> {
    await this.git(['reset', '--hard', '-q', 'HEAD']);
  }

  // ---------------------------------------------------------------------
  // Repairing unpushed commits (push rejected by repository rules)
  // ---------------------------------------------------------------------

  /** Commits reachable from `oid` that no ref of `remote` has, oldest first, with their parents. */
  async unpushedCommits(oid: string, remote: string): Promise<{ hash: string; parents: string[] }[]> {
    this.assertOid(oid);
    if (!isValidRemoteName(remote)) throw new AppError({ code: 'invalid-remote', title: 'Invalid Remote', message: 'Invalid remote name.' });
    const out = await this.gitOut(['rev-list', '--reverse', '--topo-order', '--parents', oid, '--not', `--remotes=${remote}`]);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [hash, ...parents] = l.split(' ');
        return { hash, parents };
      });
  }

  async commitMeta(oid: string): Promise<{ authorName: string; authorEmail: string; authorDate: string; subject: string; message: string; signed: boolean }> {
    this.assertOid(oid);
    const out = await this.gitOut(['log', '-1', '--format=%an%x00%ae%x00%ad%x00%s%x00%B', '--date=raw', oid, '--']);
    const [authorName, authorEmail, authorDate, subject, ...rest] = out.split('\0');
    const raw = await this.gitOut(['cat-file', 'commit', oid]);
    const header = raw.split('\n\n')[0];
    return { authorName, authorEmail, authorDate, subject, message: rest.join('\0').replace(/\n+$/, '\n'), signed: /^gpgsig(-sha256)? /m.test(header) };
  }

  /** Mode and blob of a path in a commit's tree, or null when absent. */
  async treeEntry(oid: string, relPath: string): Promise<{ mode: string; blob: string } | null> {
    this.assertOid(oid);
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const out = await this.gitOut(['ls-tree', '-z', oid, '--', p]);
    const rec = out.split('\0').find((r) => r.endsWith(`\t${p}`));
    if (!rec) return null;
    const [mode, , blob] = rec.split('\t')[0].split(' ');
    return { mode, blob };
  }

  private async treeOf(oid: string): Promise<string> {
    this.assertOid(oid);
    return (await this.gitOut(['rev-parse', `${oid}^{tree}`])).trim();
  }

  /**
   * Removes every change to `relPath` from the given unpushed commits by recreating them with the
   * file as it was before them (the remote's version, or absent). Authors, dates and messages are
   * kept; commits that become empty are dropped. The old history is kept under a backup ref.
   * The working copy of the file is NOT touched — it stays as an uncommitted change.
   */
  async dropPathFromCommits(relPath: string, branch: string, commits: { hash: string; parents: string[] }[]): Promise<{ oldHead: string; newHead: string; rewritten: number; dropped: number; backupRef: string }> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    if (!isValidBranchName(branch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch', message: 'Invalid branch name.' });
    const oldHead = await this.revParse(`refs/heads/${branch}`);
    if (!commits.length || commits[commits.length - 1].hash !== oldHead) {
      throw new AppError({ code: 'changed-since-review', title: 'Branch Changed', message: `${branch} changed since the check. Review the push again.` });
    }
    const tmpIndex = path.join(await this.gitDir(), 'gitbaba-rewrite-index');
    const env = { GIT_INDEX_FILE: tmpIndex };
    const map = new Map<string, string>();
    let rewritten = 0;
    let dropped = 0;
    try {
      for (const c of commits) {
        c.parents.forEach((x) => this.assertOid(x));
        const newParents = c.parents.map((x) => map.get(x) ?? x);
        // The file's version before these commits = its version in the (rewritten) first parent.
        const base = newParents[0] ? await this.treeEntry(newParents[0], p) : null;
        await this.git(['read-tree', c.hash], { env });
        if (base) await this.git(['update-index', '--add', '--cacheinfo', `${base.mode},${base.blob},${p}`], { env });
        else await this.git(['update-index', '--force-remove', '--', p], { env });
        const tree = (await this.gitOut(['write-tree'], { env })).trim();
        if (newParents.length <= 1 && newParents[0] && tree === (await this.treeOf(newParents[0]))) {
          // Only this file changed in the commit: drop the now-empty commit.
          map.set(c.hash, newParents[0]);
          dropped++;
          continue;
        }
        if (tree === (await this.treeOf(c.hash)) && newParents.every((x, i) => x === c.parents[i])) {
          map.set(c.hash, c.hash); // untouched commit, parents unchanged
          continue;
        }
        const meta = await this.commitMeta(c.hash);
        const args = ['commit-tree', '--no-gpg-sign', tree, ...newParents.flatMap((x) => ['-p', x])];
        const res = await this.git(args, {
          input: meta.message,
          env: { GIT_AUTHOR_NAME: meta.authorName, GIT_AUTHOR_EMAIL: meta.authorEmail, GIT_AUTHOR_DATE: meta.authorDate },
        });
        map.set(c.hash, res.stdout.trim());
        rewritten++;
      }
    } finally {
      await fs.rm(tmpIndex, { force: true });
    }
    const newHead = map.get(oldHead)!;
    this.assertOid(newHead);
    const backupRef = `refs/gitbaba/backup/${branch.replace(/[^A-Za-z0-9._-]+/g, '-')}/${Date.now()}`;
    await this.git(['update-ref', '-m', 'Git Baba: backup before removing a file from unpushed commits', backupRef, oldHead]);
    await this.git(['update-ref', '-m', `Git Baba: removed ${p} from unpushed commits`, `refs/heads/${branch}`, newHead, oldHead]);
    // Only this path's index entry follows the new HEAD; every other staged change is kept.
    await this.git(['reset', '-q', newHead, '--', p]);
    return { oldHead, newHead, rewritten, dropped, backupRef };
  }

  /** Undo of dropPathFromCommits: points the branch back at the backed-up history (working files untouched). */
  async restoreBackup(branch: string, backupRef: string, relPath: string): Promise<string> {
    if (!/^refs\/gitbaba\/backup\/[A-Za-z0-9._/-]+$/.test(backupRef) || backupRef.includes('..')) throw new AppError({ code: 'invalid-input', title: 'Invalid Backup', message: 'Unknown backup reference.' });
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const backup = (await this.gitOut(['rev-parse', '--verify', '--quiet', `${backupRef}^{commit}`])).trim();
    const current = await this.revParse(`refs/heads/${branch}`);
    await this.git(['update-ref', '-m', 'Git Baba: undo removing a file from unpushed commits', `refs/heads/${branch}`, backup, current]);
    await this.git(['reset', '-q', backup, '--', p]);
    await this.git(['update-ref', '-d', backupRef]);
    return backup;
  }

  /** Paths changed between `base` (exclusive) and `head`, with blob sizes at head. */
  async changedPathsWithSize(base: string | null, head: string): Promise<{ path: string; status: string; size: number | null }[]> {
    this.assertOid(head);
    const changes = base ? await this.nameStatus(base, head) : (await this.gitOut(['ls-tree', '-r', '--name-only', head])).split('\n').filter(Boolean).map((p2) => ({ path: p2, status: 'added' }));
    if (!changes.length) return [];
    const sizes = new Map<string, number>();
    const out = await this.gitOut(['ls-tree', '-r', '-l', '-z', head]);
    for (const rec of out.split('\0').filter(Boolean)) {
      const [meta, file] = rec.split('\t');
      const size = Number(meta.trim().split(/\s+/)[3]);
      if (!Number.isNaN(size)) sizes.set(file, size);
    }
    return changes.map((c) => ({ ...c, size: sizes.get(c.path) ?? null }));
  }

  /** Removes a stale remote-tracking ref (e.g. the branch was already deleted on the remote). */
  async dropTrackingRef(remote: string, branch: string): Promise<void> {
    if (!isValidRemoteName(remote) || !isValidBranchName(branch)) return;
    await this.git(['update-ref', '-d', `refs/remotes/${remote}/${branch}`], { okExitCodes: [1] }).catch(() => undefined);
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    this.assertRevision(a);
    this.assertRevision(b);
    const res = await this.git(['merge-base', a, b], { okExitCodes: [1] });
    return res.exitCode === 0 ? res.stdout.trim() || null : null;
  }

  /** Deletes refs/heads/<branch> on the remote and drops the local remote-tracking ref. */
  async deleteRemoteBranch(remote: string, branch: string, auth: ResolvedGitAuth, transportUrl?: string): Promise<string> {
    if (!isValidRemoteName(remote)) throw new AppError({ code: 'invalid-remote', title: 'Invalid Remote', message: 'Invalid remote name.' });
    if (!isValidBranchName(branch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch', message: 'Invalid branch name.' });
    if (transportUrl) {
      const v = validateRemoteUrl(transportUrl);
      if (!v.ok) throw new AppError({ code: 'invalid-url', title: 'Invalid Remote URL', message: v.reason });
    }
    const { env, secrets } = await this.authEnv(auth);
    const res = await this.git(['push', '--porcelain', '--', transportUrl ?? remote, `:refs/heads/${branch}`], { env, secrets, timeoutMs: NETWORK_TIMEOUT });
    await this.git(['update-ref', '-d', `refs/remotes/${remote}/${branch}`], { okExitCodes: [1] }).catch(() => undefined);
    return `${res.stdout}\n${res.stderr}`.trim();
  }

  // ---------------------------------------------------------------------
  // Log & stash
  // ---------------------------------------------------------------------

  async log(opts: { range?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    if (!(await this.hasHead())) return [];
    const args = ['log', `--format=${LOG_FORMAT}`, `-n${opts.limit ?? 200}`];
    if (opts.range) {
      this.assertRevision(opts.range.replace(/\.\.\.?/, '_'));
      args.push(opts.range);
    }
    args.push('--');
    return parseLog(await this.gitOut(args));
  }

  async stashList(): Promise<StashEntry[]> {
    if (!(await this.hasHead())) return [];
    return parseStashList(await this.gitOut(['stash', 'list', '--format=%gd%x1f%s']));
  }

  /**
   * Stages, unstages or discards selected hunks / lines of one file. The selection refers to the hunks
   * and line positions of the diff the user is looking at (git:diffFile for that area).
   * For a discard, the exact reverse-applied patch is written to `backupFile` first.
   */
  async applySelection(relPath: string, action: 'stage' | 'unstage' | 'discard', selection: { hunk: number; lines?: number[] }[], backupFile?: string): Promise<{ lines: number }> {
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const cached = action === 'unstage';
    const raw = await this.gitOut(['diff', ...SAFE_DIFF, '--no-renames', '-U3', ...(cached ? ['--cached'] : []), '--', p]);
    if (!raw.trim()) throw new AppError({ code: 'stale', title: 'Nothing to Apply', message: `${p} has no ${cached ? 'staged' : 'unstaged'} changes any more. Refresh and try again.` });
    if (/^(Binary files |GIT binary patch)/m.test(raw)) throw new AppError({ code: 'binary', title: 'Binary File', message: 'Parts of a binary file cannot be staged separately — stage the whole file.' });
    const sel = new Map<number, Set<number> | 'all'>();
    for (const s of selection) sel.set(s.hunk, s.lines ? new Set(s.lines) : 'all');
    const reverse = action !== 'stage';
    const patch = buildPartialPatch(raw, sel, reverse);
    if (!patch) throw new AppError({ code: 'empty-selection', title: 'Nothing Selected', message: 'Select at least one changed line.' });
    const count = patch.split('\n').filter((l) => /^[+-](?![+-]{2} )/.test(l)).length;
    if (action === 'discard' && backupFile) {
      await fs.mkdir(path.dirname(backupFile), { recursive: true });
      await fs.writeFile(backupFile, patch, 'utf8');
    }
    const args = ['apply', '--recount', '--whitespace=nowarn'];
    if (action !== 'discard') args.push('--cached');
    if (reverse) args.push('-R');
    args.push('-');
    await this.git(args, { input: patch });
    return { lines: count };
  }

  /** Added / deleted line counts per path, for the staged and unstaged areas. */
  async changeStats(): Promise<{ staged: Record<string, [number, number]>; unstaged: Record<string, [number, number]> }> {
    if (!(await this.hasHead())) return { staged: {}, unstaged: {} };
    const parse = (out: string) => {
      const r: Record<string, [number, number]> = {};
      for (const rec of out.split('\0')) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(rec.replace(/^\n/, ''));
        if (m) r[m[3]] = [m[1] === '-' ? 0 : Number(m[1]), m[2] === '-' ? 0 : Number(m[2])];
      }
      return r;
    };
    const [st, un] = await Promise.all([
      this.gitOut(['diff', ...SAFE_DIFF, '--no-renames', '--numstat', '-z', '--cached']).catch(() => ''),
      this.gitOut(['diff', ...SAFE_DIFF, '--no-renames', '--numstat', '-z']).catch(() => ''),
    ]);
    return { staged: parse(st), unstaged: parse(un) };
  }

  async stashPush(message: string, includeUntracked: boolean): Promise<void> {
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message) args.push('-m', message);
    await this.git(args);
  }

  async stashApply(index: number, pop: boolean): Promise<void> {
    await this.git(['stash', pop ? 'pop' : 'apply', `stash@{${index}}`]);
  }

  async stashDrop(index: number): Promise<void> {
    await this.git(['stash', 'drop', `stash@{${index}}`]);
  }

  // ---------------------------------------------------------------------
  // Git History (graph view)
  // ---------------------------------------------------------------------

  /** Commits with parents and ref decorations, newest first in topological order. */
  async graphLog(q: HistoryQuery): Promise<{ commits: GraphCommit[]; hasMore: boolean }> {
    if (!(await this.hasHead())) return { commits: [], hasMore: false };
    const limit = Math.min(Math.max(q.limit ?? 300, 1), 2000);
    const args = ['log', '--topo-order', '--decorate=short', `--format=${GRAPH_FORMAT}`, `--max-count=${limit + 1}`, `--skip=${q.skip ?? 0}`];
    switch (q.scope) {
      case 'all':
        args.push('--branches', '--remotes', '--tags', 'HEAD');
        break;
      case 'remotes':
        args.push('--remotes');
        break;
      case 'tags':
        args.push('--tags');
        break;
      case 'ref':
        if (!q.ref) throw new AppError({ code: 'invalid-revision', title: 'Select a Branch', message: 'Choose a branch or tag to show.' });
        this.assertRevision(q.ref);
        args.push(`--end-of-options`, q.ref);
        break;
      default:
        args.push('HEAD');
    }
    // Author and message filters are literal (fixed-string) matches, never regular expressions.
    const filters: string[] = [];
    if (q.author) filters.push(`--author=${q.author}`);
    if (q.sinceDays) filters.push(`--since=${q.sinceDays}.days.ago`);
    const search = q.search?.trim();
    if (search && /^[0-9a-f]{4,40}$/i.test(search)) {
      // Looks like a commit id: try a hash-prefix match first.
      const all = parseGraphLog(await this.gitOut([...args.slice(0, 1), ...filters, '--fixed-strings', ...args.slice(1), '--'], { maxBufferBytes: 64 * 1024 * 1024 }));
      const hits = all.filter((c) => c.hash.startsWith(search.toLowerCase()));
      if (hits.length) return { commits: hits, hasMore: false };
    }
    if (search) filters.push('-i', `--grep=${search}`);
    if (filters.length) filters.push('--fixed-strings');
    args.splice(1, 0, ...filters);
    args.push('--');
    const commits = parseGraphLog(await this.gitOut(args, { maxBufferBytes: 64 * 1024 * 1024 }));
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
  }

  /** graphLog plus, for every commit, the branch it was made on and whether main already contains it. */
  async graphLogDecorated(q: HistoryQuery): Promise<{ commits: GraphCommit[]; hasMore: boolean; mainRef: string | null }> {
    const res = await this.graphLog(q);
    const main = await this.mainRef();
    if (res.commits.length) {
      // Labels are a convenience: a failure here must never hide the history itself.
      await Promise.all([
        this.labelBranches(res.commits).catch(() => undefined),
        this.markMerged(res.commits, main).catch(() => undefined),
        this.labelTags(res.commits).catch(() => undefined),
      ]);
    }
    return { ...res, mainRef: main };
  }

  /**
   * The main branch: what origin/HEAD points to, else origin/main, origin/master, main, master.
   * The remote branch wins over the local one — that is where pull requests are merged.
   */
  async mainRef(): Promise<string | null> {
    const res = await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { okExitCodes: [1, 128] }).catch(() => null);
    const viaHead = res && res.exitCode === 0 ? res.stdout.trim() : '';
    for (const c of [viaHead, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)) {
      if (await this.tryRevParse(`${c}^{commit}`)) return c;
    }
    return null;
  }

  private mergedCache: { oid: string; set: Set<string> } | null = null;

  private async markMerged(commits: GraphCommit[], main: string | null): Promise<void> {
    if (!main) return;
    const oid = await this.tryRevParse(`${main}^{commit}`);
    if (!oid) return;
    if (this.mergedCache?.oid !== oid) {
      const out = await this.gitOut(['rev-list', '--max-count=400000', oid, '--'], { maxBufferBytes: 64 * 1024 * 1024 });
      this.mergedCache = { oid, set: new Set(out.split('\n').filter(Boolean)) };
    }
    const set = this.mergedCache.set;
    for (const c of commits) c.merged = set.has(c.hash);
  }

  /** The nearest tag that contains each commit (the first release it shipped in), via name-rev over tags. */
  private async labelTags(commits: GraphCommit[]): Promise<void> {
    for (let i = 0; i < commits.length; i += 150) {
      const chunk = commits.slice(i, i + 150);
      const out = await this.gitOut(['name-rev', '--name-only', '--tags', ...chunk.map((c) => c.hash)]);
      const lines = out.split('\n').map((l) => l.trim());
      chunk.forEach((c, k) => {
        const n = lines[k] ?? '';
        if (!n || n === 'undefined') return void (c.releasedIn = null);
        // "v1.2" / "v1.2^0" (annotated) is the tag itself; "v1.2~3" or "v1.2~3^2" is a commit inside it.
        const name = n.replace(/^tags\//, '').replace(/\^0$/, '');
        const tag = name.replace(/[~^].*$/, '');
        c.releasedIn = { tag, exact: tag === name };
      });
    }
  }

  /** Names each commit after the branch it was made on (name-rev; merge subjects for merged branches). */
  private async labelBranches(commits: GraphCommit[]): Promise<void> {
    const names: string[] = [];
    for (let i = 0; i < commits.length; i += 150) {
      const chunk = commits.slice(i, i + 150).map((c) => c.hash);
      const out = await this.gitOut(['name-rev', '--name-only', '--refs=refs/heads/*', '--refs=refs/remotes/*', '--exclude=refs/remotes/*/HEAD', ...chunk]);
      const lines = out.split('\n').map((l) => l.trim());
      for (let k = 0; k < chunk.length; k++) names.push(lines[k] ?? '');
    }
    const parsed = names.map(parseNameRev);
    const mergeRevs = [...new Set(parsed.map((p) => p.mergeRev).filter((r): r is string => !!r && !r.startsWith('-')))];
    const subjects = new Map<string, string>();
    for (let i = 0; i < mergeRevs.length; i += 100) {
      const chunk = mergeRevs.slice(i, i + 100);
      const out = await this.gitOut(['show', '-s', '--format=%s%x1e', ...chunk, '--']).catch(() => '');
      out
        .split('\x1e')
        .map((x) => x.trim())
        .forEach((subj, k) => k < chunk.length && subjects.set(chunk[k], subj));
    }
    commits.forEach((c, i) => {
      const p = parsed[i];
      const merged = p.mergeRev ? branchFromMergeSubject(subjects.get(p.mergeRev) ?? '') : null;
      c.branch = merged ?? p.tip;
    });
  }

  /** Light preview of merging `branch` into `base`: commit counts and touched files, no diffs. */
  async mergeForecast(branch: string, base: string): Promise<MergeForecast> {
    this.assertRevision(branch);
    this.assertRevision(base);
    const head = await this.tryRevParse(`${branch}^{commit}`);
    const baseOid = await this.tryRevParse(`${base}^{commit}`);
    if (!head || !baseOid) throw new AppError({ code: 'invalid-revision', title: 'Branch Not Found', message: `${head ? base : branch} does not exist.` });
    const mergeBase = await this.mergeBase(baseOid, head);
    const [behind, ahead] = (await this.gitOut(['rev-list', '--left-right', '--count', `${baseOid}...${head}`, '--']))
      .trim()
      .split(/\s+/)
      .map(Number);
    const files = ahead ? await this.statBetween(mergeBase ?? EMPTY_TREE, head) : [];
    const lastDate = (await this.gitOut(['log', '-1', '--format=%cI', head, '--'])).trim() || null;
    return {
      branch,
      base,
      related: !!mergeBase,
      ahead: ahead || 0,
      behind: behind || 0,
      files: files.map((f) => f.path),
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      lastDate,
    };
  }

  /** What `branch` adds on top of `base` (default: the main branch): its own commits and the combined diff. */
  async branchChanges(branch: string, base?: string): Promise<BranchChanges> {
    this.assertRevision(branch);
    const b = base ?? (await this.mainRef());
    if (!b) throw new AppError({ code: 'no-base', title: 'No Main Branch', message: 'Could not find a main branch to compare with. Choose a base branch.' });
    this.assertRevision(b);
    const head = await this.tryRevParse(`${branch}^{commit}`);
    const baseOid = await this.tryRevParse(`${b}^{commit}`);
    if (!head) throw new AppError({ code: 'invalid-revision', title: 'Branch Not Found', message: `${branch} does not exist.` });
    if (!baseOid) throw new AppError({ code: 'invalid-revision', title: 'Branch Not Found', message: `${b} does not exist.` });
    const mergeBase = await this.mergeBase(baseOid, head);
    const [behind, ahead] = (await this.gitOut(['rev-list', '--left-right', '--count', `${baseOid}...${head}`, '--']))
      .trim()
      .split(/\s+/)
      .map(Number);
    const commits = parseGraphLog(await this.gitOut(['log', '--decorate=short', `--format=${GRAPH_FORMAT}`, '--max-count=500', head, `^${baseOid}`, '--']));
    const from = mergeBase ?? EMPTY_TREE;
    const files = await this.statBetween(from, head);
    const diffs = parseUnifiedDiff(await this.gitOut(['diff', ...SAFE_DIFF, '-M', from, head, '--'], { maxBufferBytes: 200 * 1024 * 1024 }), { maxLinesPerFile: 5000 });
    return {
      branch,
      base: b,
      mergeBase,
      ahead: ahead || 0,
      behind: behind || 0,
      commits,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      diffs,
    };
  }

  // ---------------------------------------------------------------------
  // History actions (cherry-pick, reset, rebase, checkout, tag, worktree, patch)
  // ---------------------------------------------------------------------

  private async workingCounts(): Promise<{ staged: number; unstaged: number; untracked: number; conflicted: number }> {
    const s = await this.status();
    return { staged: s.staged.length, unstaged: s.unstaged.length, untracked: s.untracked.length, conflicted: s.conflicted.length };
  }

  private async requireNoOperation(): Promise<void> {
    const op = await this.operationInProgress();
    if (op) throw new AppError({ code: 'operation-in-progress', title: 'Finish the Current Operation', message: `A ${op} is in progress. Continue or abort it in the Conflicts tab first.`, actions: ['resolve-conflicts'] });
  }

  /** Commits in `range` (newest first), for previews. */
  private async commitsIn(args: string[], max = 200): Promise<GraphCommit[]> {
    return parseGraphLog(await this.gitOut(['log', '--decorate=short', `--format=${GRAPH_FORMAT}`, `--max-count=${max}`, ...args, '--']));
  }

  /** Commits that exist on no remote-tracking branch (i.e. never pushed). */
  private async unpushedAmong(hashes: string[]): Promise<Set<string>> {
    if (!hashes.length) return new Set();
    const out = await this.gitOut(['rev-list', '--max-count=2000', ...hashes, '--not', '--remotes', '--']).catch(() => '');
    return new Set(out.split('\n').filter(Boolean));
  }

  async historyCherryPick(hash: string, opts: { noCommit?: boolean; mainline?: number }): Promise<HistoryActionResult> {
    this.assertOid(hash);
    await this.requireNoOperation();
    const before = await this.tryRevParse('HEAD');
    const args = ['cherry-pick'];
    if (opts.noCommit) args.push('--no-commit');
    if (opts.mainline) args.push('-m', String(opts.mainline));
    args.push(hash);
    try {
      await this.git(args);
    } catch (err) {
      const st = await this.status();
      if (st.conflicted.length) return { outcome: 'conflicts', previousOid: before, newOid: await this.tryRevParse('HEAD'), conflicted: st.conflicted.map((c) => c.path), message: `Cherry-pick stopped on ${st.conflicted.length} conflicted file(s).` };
      throw err;
    }
    return { outcome: 'done', previousOid: before, newOid: await this.tryRevParse('HEAD'), conflicted: [], message: opts.noCommit ? 'Changes applied and staged — review and commit them in Changes.' : 'Commit copied onto the current branch.' };
  }

  async historyRevert(hash: string, opts: { noCommit?: boolean; mainline?: number }): Promise<HistoryActionResult> {
    this.assertOid(hash);
    await this.requireNoOperation();
    const before = await this.tryRevParse('HEAD');
    const args = ['revert', '--no-edit'];
    if (opts.noCommit) args.push('--no-commit');
    if (opts.mainline) args.push('-m', String(opts.mainline));
    args.push(hash);
    try {
      await this.git(args);
    } catch (err) {
      const st = await this.status();
      if (st.conflicted.length) return { outcome: 'conflicts', previousOid: before, newOid: await this.tryRevParse('HEAD'), conflicted: st.conflicted.map((c) => c.path), message: `Revert stopped on ${st.conflicted.length} conflicted file(s).` };
      throw err;
    }
    return { outcome: 'done', previousOid: before, newOid: await this.tryRevParse('HEAD'), conflicted: [], message: opts.noCommit ? 'Reverse changes staged — review and commit them.' : 'A new commit undoing that commit was created.' };
  }

  /** What resetting the current branch to `hash` would do, for every mode. */
  async resetPreview(hash: string): Promise<ResetPreview> {
    this.assertOid(hash);
    const st = await this.status();
    const head = st.headOid;
    if (!head) throw new AppError({ code: 'no-head', title: 'Nothing to Reset', message: 'This repository has no commits yet.' });
    const leaving = await this.commitsIn([head, `^${hash}`]);
    const arriving = await this.commitsIn([hash, `^${head}`], 50);
    const unpushed = await this.unpushedAmong(leaving.map((c) => c.hash));
    return {
      branch: st.branch,
      detached: st.detached,
      headOid: head,
      target: hash,
      isAncestor: await this.isAncestor(hash, head),
      leaving,
      arriving,
      unpushed: leaving.filter((c) => unpushed.has(c.hash)).map((c) => c.hash),
      upstream: st.upstream,
      working: { staged: st.staged.length, unstaged: st.unstaged.length, untracked: st.untracked.length, conflicted: st.conflicted.length },
      operation: st.operation,
    };
  }

  /**
   * Moves the current branch to `hash`. The old tip is always saved under refs/gitbaba/backups/, and
   * for a hard reset uncommitted changes are saved too (as a stash commit), so every reset can be undone.
   */
  async historyReset(hash: string, mode: ResetMode, expectedHead: string): Promise<ResetResult> {
    this.assertOid(hash);
    this.assertOid(expectedHead);
    await this.requireNoOperation();
    const head = await this.tryRevParse('HEAD');
    if (head !== expectedHead) throw new AppError({ code: 'stale', title: 'The Branch Moved', message: 'HEAD changed since you opened the reset preview. Review it again.' });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const backupRef = `refs/gitbaba/backups/reset-${stamp}`;
    await this.git(['update-ref', '-m', 'Git Baba: before reset', backupRef, head]);
    let wipRef: string | null = null;
    if (mode === 'hard') {
      const wip = (await this.gitOut(['stash', 'create', 'Git Baba: uncommitted changes before hard reset']).catch(() => '')).trim();
      if (wip) {
        wipRef = `${backupRef}-wip`;
        await this.git(['update-ref', '-m', 'Git Baba: uncommitted changes before reset', wipRef, wip]);
      }
    }
    await this.git(['reset', `--${mode}`, '-q', hash]);
    return { previousOid: head, newOid: hash, mode, backupRef, wipRef, untrackedKept: mode === 'hard' ? (await this.status()).untracked.length : 0 };
  }

  /** Puts the branch back where it was before a reset done here (and restores saved uncommitted changes). */
  async undoReset(previousOid: string, mode: ResetMode, wipRef: string | null): Promise<void> {
    this.assertOid(previousOid);
    await this.requireNoOperation();
    if (wipRef && !/^refs\/gitbaba\/backups\/reset-\d{14}-wip$/.test(wipRef)) throw new AppError({ code: 'invalid-revision', title: 'Invalid Backup', message: 'That backup reference is not one Git Baba created.' });
    if (mode === 'hard') {
      await this.git(['reset', '--hard', '-q', previousOid]);
      if (wipRef && (await this.tryRevParse(wipRef))) await this.git(['stash', 'apply', '--index', wipRef]).catch(() => this.git(['stash', 'apply', wipRef]));
    } else {
      // Soft/mixed/keep left the working files alone: moving the branch back is enough.
      await this.git(['reset', '--soft', '-q', previousOid]);
    }
  }

  async rebasePreview(onto: string): Promise<RebasePreview> {
    this.assertOid(onto);
    const st = await this.status();
    if (!st.headOid) throw new AppError({ code: 'no-head', title: 'Nothing to Rebase', message: 'This repository has no commits yet.' });
    const replay = await this.commitsIn([st.headOid, `^${onto}`, '--no-merges']);
    const merges = Number((await this.gitOut(['rev-list', '--count', '--merges', st.headOid, `^${onto}`, '--'])).trim()) || 0;
    const unpushedSet = await this.unpushedAmong(replay.map((c) => c.hash));
    const alreadyOn = await this.isAncestor(st.headOid, onto);
    return {
      branch: st.branch,
      detached: st.detached,
      headOid: st.headOid,
      onto,
      replay,
      mergesDropped: merges,
      publishedCount: replay.filter((c) => !unpushedSet.has(c.hash)).length,
      fastForward: alreadyOn,
      upToDate: await this.isAncestor(onto, st.headOid),
      working: { staged: st.staged.length, unstaged: st.unstaged.length, untracked: st.untracked.length, conflicted: st.conflicted.length },
    };
  }

  async historyRebase(onto: string, expectedHead: string): Promise<HistoryActionResult> {
    this.assertOid(onto);
    this.assertOid(expectedHead);
    await this.requireNoOperation();
    const before = await this.tryRevParse('HEAD');
    if (before !== expectedHead) throw new AppError({ code: 'stale', title: 'The Branch Moved', message: 'HEAD changed since you opened the rebase preview. Review it again.' });
    const w = await this.workingCounts();
    if (w.staged || w.unstaged) throw new AppError({ code: 'local-changes', title: 'Uncommitted Changes', message: 'Commit or stash your changes before rebasing.' });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    await this.git(['update-ref', '-m', 'Git Baba: before rebase', `refs/gitbaba/backups/rebase-${stamp}`, before!]);
    const conflicts = await this.rebase(onto);
    if (conflicts) {
      const st = await this.status();
      return { outcome: 'conflicts', previousOid: before, newOid: null, conflicted: st.conflicted.map((c) => c.path), message: 'The rebase stopped on a conflict. Resolve it, then continue (or abort to go back).' };
    }
    return { outcome: 'done', previousOid: before, newOid: await this.tryRevParse('HEAD'), conflicted: [], message: 'Your commits were replayed on top of the chosen commit.' };
  }

  async checkoutCommit(hash: string): Promise<void> {
    this.assertOid(hash);
    await this.requireNoOperation();
    await this.git(['switch', '--detach', hash]);
  }

  async commitPatch(hash: string): Promise<{ fileName: string; patch: string }> {
    this.assertOid(hash);
    const patch = await this.gitOut(['format-patch', '-1', '--stdout', '--no-signature', hash], { maxBufferBytes: 64 * 1024 * 1024 });
    const subject = (await this.gitOut(['show', '-s', '--format=%s', hash])).trim();
    const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 52) || 'commit';
    return { fileName: `${hash.slice(0, 8)}-${slug}.patch`, patch };
  }

  async createTagAt(hash: string, name: string, message?: string): Promise<void> {
    this.assertOid(hash);
    const res = await this.git(['check-ref-format', `refs/tags/${name}`], { okExitCodes: [1] });
    if (res.exitCode !== 0 || name.startsWith('-')) throw new AppError({ code: 'invalid-tag', title: 'Invalid Tag Name', message: `"${name}" is not a valid tag name.` });
    if (await this.tryRevParse(`refs/tags/${name}`)) throw new AppError({ code: 'tag-exists', title: 'Tag Already Exists', message: `A tag named ${name} already exists.` });
    if (message?.trim()) await this.git(['tag', '-a', name, '-m', message.trim(), hash]);
    else await this.git(['tag', name, hash]);
  }

  async addWorktree(dir: string, hash: string, newBranch?: string): Promise<{ path: string }> {
    this.assertOid(hash);
    if (newBranch) {
      const ok = await this.git(['check-ref-format', '--branch', newBranch], { okExitCodes: [128, 1] });
      if (ok.exitCode !== 0 || newBranch.startsWith('-')) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${newBranch}" is not a valid branch name.` });
      await this.git(['worktree', 'add', '-b', newBranch, '--', dir, hash]);
    } else {
      await this.git(['worktree', 'add', '--detach', '--', dir, hash]);
    }
    return { path: dir };
  }

  async worktrees(): Promise<{ path: string; head: string | null; branch: string | null }[]> {
    const out = await this.gitOut(['worktree', 'list', '--porcelain']).catch(() => '');
    return out
      .split('\n\n')
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => {
        const get = (k: string) => b.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? null;
        return { path: get('worktree') ?? '', head: get('HEAD'), branch: get('branch')?.replace(/^refs\/heads\//, '') ?? null };
      });
  }

  /** Web page of the commit on its GitHub-style remote, and whether the remote already has it. */
  async remoteCommitUrl(hash: string): Promise<{ url: string | null; remote: string | null; onRemote: boolean }> {
    this.assertOid(hash);
    const remotes = await this.remotes();
    const r = remotes.find((x) => x.name === 'origin') ?? remotes[0];
    if (!r) return { url: null, remote: null, onRemote: false };
    const parsed = parseRemoteUrl(r.fetchUrl);
    const onRemote = !!(await this.gitOut(['branch', '-r', '--contains', hash]).catch(() => '')).trim();
    if (!parsed.host || !parsed.owner || !parsed.repo) return { url: null, remote: r.name, onRemote };
    return { url: `https://${parsed.host}/${parsed.owner}/${parsed.repo}/commit/${hash}`, remote: r.name, onRemote };
  }

  // ---------------------------------------------------------------------
  // Transplant: bring only a branch's own commits onto another branch
  // ---------------------------------------------------------------------

  /** What `source` adds on top of `base`, and how it would land on `target`. */
  async transplantPreview(source: string, base: string, target: string): Promise<TransplantPreview> {
    for (const r of [source, base, target]) this.assertRevision(r);
    const sourceOid = await this.tryRevParse(`${source}^{commit}`);
    const baseOid = await this.tryRevParse(`${base}^{commit}`);
    const targetOid = await this.tryRevParse(`${target}^{commit}`);
    if (!sourceOid || !baseOid || !targetOid) throw new AppError({ code: 'invalid-revision', title: 'Branch Not Found', message: `${!sourceOid ? source : !baseOid ? base : target} does not exist.` });
    const own = parseGraphLog(await this.gitOut(['log', '--reverse', '--no-merges', '--decorate=short', `--format=${GRAPH_FORMAT}`, '--max-count=500', sourceOid, `^${baseOid}`, '--']));
    const merges = Number((await this.gitOut(['rev-list', '--count', '--merges', sourceOid, `^${baseOid}`, '--'])).trim()) || 0;
    // "git cherry": '-' marks a commit whose change is already in the target (e.g. picked before).
    const cherry = await this.gitOut(['cherry', targetOid, sourceOid, baseOid]).catch(() => '');
    const inTarget = new Set(cherry.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()));
    const filesOf = new Map<string, string[]>();
    if (own.length) {
      const out = await this.gitOut(['log', '--no-merges', '--format=%x1e%H', '--name-only', sourceOid, `^${baseOid}`, '--']);
      for (const rec of out.split('\x1e').filter(Boolean)) {
        const [h, ...files] = rec.split('\n').map((x) => x.trim()).filter(Boolean);
        filesOf.set(h, files);
      }
    }
    const leftBehind = Number((await this.gitOut(['rev-list', '--count', baseOid, `^${targetOid}`, '--'])).trim()) || 0;
    const st = await this.status();
    const leaf = source.replace(/^[^/]+\/(?=.*\/)/, '').split('/').pop() ?? 'changes';
    const tleaf = target.split('/').pop() ?? 'target';
    return {
      source,
      base,
      target,
      sourceOid,
      targetOid,
      commits: own.map((c) => ({ ...c, alreadyInTarget: inTarget.has(c.hash), files: filesOf.get(c.hash) ?? [] })),
      mergesSkipped: merges,
      leftBehind,
      files: [...new Set(own.flatMap((c) => filesOf.get(c.hash) ?? []))].sort(),
      suggestedBranch: `${leaf}-to-${tleaf}`,
      currentBranch: st.branch,
      dirty: st.staged.length + st.unstaged.length + st.conflicted.length,
      operation: st.operation,
    };
  }

  /**
   * Replays the chosen commits onto `target` with cherry-pick -x: into a new branch made from the target
   * (ready for a pull request) or directly onto the local target branch (whose old tip is backed up).
   */
  async transplant(opts: { target: string; commits: string[]; into: 'new-branch' | 'target'; newBranch?: string; expectedTarget: string; returnToCurrent: boolean }): Promise<TransplantResult> {
    this.assertRevision(opts.target);
    this.assertOid(opts.expectedTarget);
    if (!opts.commits.length) throw new AppError({ code: 'empty-selection', title: 'Nothing Selected', message: 'Choose at least one commit to bring over.' });
    opts.commits.forEach((c) => this.assertOid(c));
    const st = await this.status();
    if (st.operation) throw new AppError({ code: 'operation-in-progress', title: 'Finish the Current Operation', message: `A ${st.operation} is in progress. Continue or abort it first.`, actions: ['resolve-conflicts'] });
    if (st.staged.length + st.unstaged.length + st.conflicted.length) throw new AppError({ code: 'local-changes', title: 'Uncommitted Changes', message: 'Commit or stash your changes first — the transplant needs to switch branches.' });
    const targetOid = await this.tryRevParse(`${opts.target}^{commit}`);
    if (targetOid !== opts.expectedTarget) throw new AppError({ code: 'stale', title: 'The Target Moved', message: `${opts.target} changed since the preview. Review it again.` });
    const from = st.branch;
    let branch: string;
    let backupRef: string | null = null;
    if (opts.into === 'new-branch') {
      branch = (opts.newBranch ?? '').trim();
      if (!isValidBranchName(branch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${branch}" is not a valid branch name.` });
      if (await this.tryRevParse(`refs/heads/${branch}`)) throw new AppError({ code: 'branch-exists', title: 'Branch Exists', message: `A branch named ${branch} already exists.` });
      await this.git(['switch', '-c', branch, '--no-track', targetOid]);
    } else {
      branch = opts.target;
      if (!isValidBranchName(branch) || !(await this.tryRevParse(`refs/heads/${branch}`))) throw new AppError({ code: 'invalid-branch', title: 'Local Branch Needed', message: `Apply directly only onto a local branch. ${branch} is not one — use “new branch” instead.` });
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      backupRef = `refs/gitbaba/backups/transplant-${stamp}`;
      await this.git(['update-ref', '-m', 'Git Baba: before transplant', backupRef, targetOid]);
      if (from !== branch) await this.git(['switch', branch]);
    }
    let applied = 0;
    for (const c of opts.commits) {
      try {
        await this.git(['cherry-pick', '-x', '--allow-empty', c]);
        applied++;
      } catch (err) {
        const now = await this.status();
        if (now.conflicted.length) {
          return {
            outcome: 'conflicts',
            branch,
            applied,
            conflicted: now.conflicted.map((f) => f.path),
            newOid: await this.tryRevParse('HEAD'),
            returnedTo: null,
            backupRef,
            message: `Stopped at commit ${applied + 1} of ${opts.commits.length} on a conflict. Resolve it and continue — the rest${opts.commits.length - applied - 1 > 0 ? ` (${opts.commits.length - applied - 1} more)` : ''} must then be cherry-picked from Git History.`,
          };
        }
        throw err;
      }
    }
    const newOid = await this.tryRevParse('HEAD');
    let returnedTo: string | null = null;
    if (opts.returnToCurrent && from && from !== branch) {
      await this.git(['switch', from]);
      returnedTo = from;
    }
    return { outcome: 'done', branch, applied, conflicted: [], newOid, returnedTo, backupRef, message: `${applied} commit(s) brought onto ${branch}.` };
  }

  /**
   * Brings only chosen files / hunks / lines of `source`'s own changes (on top of `base`) onto `target`
   * as ONE new commit — into a new branch made from the target, or directly onto the local target.
   * The selection refers to the diff of `base...source` (graph:branchChanges(source, base)).
   */
  async transplantPick(opts: {
    source: string;
    base: string;
    target: string;
    into: 'new-branch' | 'target';
    newBranch?: string;
    expectedTarget: string;
    returnToCurrent: boolean;
    message: string;
    selection: { path: string; oldPath?: string; hunks?: { hunk: number; lines?: number[] }[] }[];
  }): Promise<TransplantResult> {
    for (const r of [opts.source, opts.base, opts.target]) this.assertRevision(r);
    this.assertOid(opts.expectedTarget);
    if (!opts.selection.length) throw new AppError({ code: 'empty-selection', title: 'Nothing Selected', message: 'Choose at least one file or line to bring over.' });
    if (!opts.message.trim()) throw new AppError({ code: 'no-message', title: 'Commit Message Needed', message: 'Write a message for the new commit.' });
    const sourceOid = await this.tryRevParse(`${opts.source}^{commit}`);
    const baseOid = await this.tryRevParse(`${opts.base}^{commit}`);
    if (!sourceOid || !baseOid) throw new AppError({ code: 'invalid-revision', title: 'Branch Not Found', message: `${!sourceOid ? opts.source : opts.base} does not exist.` });
    const from = (await this.mergeBase(baseOid, sourceOid)) ?? EMPTY_TREE;

    // Build one patch from the selected parts, before touching any branch.
    const parts: string[] = [];
    for (const s of opts.selection) {
      const paths = sanitizeRepoPaths(this.root, [s.path, ...(s.oldPath ? [s.oldPath] : [])]);
      let raw = await this.gitOut(['diff', ...SAFE_DIFF, '--no-renames', '-U3', from, sourceOid, '--', ...paths]);
      if (!raw.trim()) continue;
      if (/^Binary files /m.test(raw) || !s.hunks || s.oldPath) {
        // Whole file (also binary files and renames): take git's own patch for it.
        if (/^Binary files /m.test(raw)) raw = await this.gitOut(['diff', ...SAFE_DIFF, '--no-renames', '--binary', from, sourceOid, '--', ...paths]);
        parts.push(raw.endsWith('\n') ? raw : `${raw}\n`);
        continue;
      }
      const sel = new Map<number, Set<number> | 'all'>();
      for (const h of s.hunks) sel.set(h.hunk, h.lines ? new Set(h.lines) : 'all');
      const patch = buildPartialPatch(raw, sel, false);
      if (patch) parts.push(patch);
    }
    if (!parts.length) throw new AppError({ code: 'empty-selection', title: 'Nothing Selected', message: 'The selection contains no changes.' });
    const patch = parts.join('');

    const st = await this.status();
    if (st.operation) throw new AppError({ code: 'operation-in-progress', title: 'Finish the Current Operation', message: `A ${st.operation} is in progress. Continue or abort it first.`, actions: ['resolve-conflicts'] });
    if (st.staged.length + st.unstaged.length + st.conflicted.length) throw new AppError({ code: 'local-changes', title: 'Uncommitted Changes', message: 'Commit or stash your changes first — this needs to switch branches.' });
    const targetOid = await this.tryRevParse(`${opts.target}^{commit}`);
    if (targetOid !== opts.expectedTarget) throw new AppError({ code: 'stale', title: 'The Target Moved', message: `${opts.target} changed since the preview. Review it again.` });

    const from0 = st.branch;
    let branch: string;
    let backupRef: string | null = null;
    if (opts.into === 'new-branch') {
      branch = (opts.newBranch ?? '').trim();
      if (!isValidBranchName(branch)) throw new AppError({ code: 'invalid-branch', title: 'Invalid Branch Name', message: `"${branch}" is not a valid branch name.` });
      if (await this.tryRevParse(`refs/heads/${branch}`)) throw new AppError({ code: 'branch-exists', title: 'Branch Exists', message: `A branch named ${branch} already exists.` });
      await this.git(['switch', '-c', branch, '--no-track', targetOid]);
    } else {
      branch = opts.target;
      if (!isValidBranchName(branch) || !(await this.tryRevParse(`refs/heads/${branch}`))) throw new AppError({ code: 'invalid-branch', title: 'Local Branch Needed', message: `Apply directly only onto a local branch. ${branch} is not one — use “new branch” instead.` });
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      backupRef = `refs/gitbaba/backups/transplant-${stamp}`;
      await this.git(['update-ref', '-m', 'Git Baba: before transplant', backupRef, targetOid]);
      if (from0 !== branch) await this.git(['switch', branch]);
    }
    const applied = await this.git(['apply', '--index', '--3way', '--recount', '--whitespace=nowarn', '-'], { input: patch, okExitCodes: [1] });
    const now = await this.status();
    if (applied.exitCode !== 0 || now.conflicted.length) {
      return {
        outcome: 'conflicts',
        branch,
        applied: 0,
        conflicted: now.conflicted.map((f) => f.path),
        newOid: await this.tryRevParse('HEAD'),
        returnedTo: null,
        backupRef,
        message: `The selected changes do not fit ${opts.target} cleanly. Resolve the conflicted file(s) on ${branch}, then commit them in Changes.`,
      };
    }
    if (!now.staged.length) throw new AppError({ code: 'nothing-to-commit', title: 'Already There', message: `${opts.target} already contains the selected changes.` });
    await this.git(['commit', '-q', '-m', opts.message.trim(), '-m', `(changes picked from ${opts.source} @ ${sourceOid.slice(0, 12)})`]);
    const newOid = await this.tryRevParse('HEAD');
    let returnedTo: string | null = null;
    if (opts.returnToCurrent && from0 && from0 !== branch) {
      await this.git(['switch', from0]);
      returnedTo = from0;
    }
    return { outcome: 'done', branch, applied: 1, conflicted: [], newOid, returnedTo, backupRef, message: `Selected changes from ${opts.source} committed onto ${branch}.` };
  }

  // ---------------------------------------------------------------------
  // Code browser (read-only views of any branch / tag / commit)
  // ---------------------------------------------------------------------

  /** Commit id of a branch, tag or commit chosen in the code browser. */
  async codeCommit(ref: string): Promise<string> {
    this.assertRevision(ref);
    const oid = await this.tryRevParse(`${ref}^{commit}`);
    if (!oid) throw new AppError({ code: 'invalid-revision', title: 'Branch Not Found', message: `${ref} does not exist in this repository.` });
    return oid;
  }

  private cleanDir(dir: string): string {
    const d = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (d) sanitizeRepoPaths(this.root, [d]);
    return d;
  }

  async codeTree(ref: string, dir: string): Promise<CodeEntry[]> {
    if (!(await this.hasHead())) return [];
    const oid = await this.codeCommit(ref);
    const d = this.cleanDir(dir);
    const res = await this.git(['ls-tree', '-z', '-l', d ? `${oid}:${d}` : oid], { maxBufferBytes: 32 * 1024 * 1024 }).catch(() => null);
    if (!res) throw new AppError({ code: 'file-missing', title: 'Folder Not Found', message: `${d} does not exist on ${ref}.` });
    return parseLsTree(res.stdout, d);
  }

  async codeLastCommits(ref: string, paths: string[]): Promise<Record<string, CodeLastCommit | null>> {
    const oid = await this.codeCommit(ref);
    const queue = sanitizeRepoPaths(this.root, paths.slice(0, 200));
    const out: Record<string, CodeLastCommit | null> = {};
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
          const line = await this.gitOut(['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%aI', oid, '--', p]).catch(() => '');
          const [hash, subject, author, date] = line.trim().split('\x1f');
          out[p] = hash ? { hash, subject: subject ?? '', author: author ?? '', date: date ?? '' } : null;
        }
      }),
    );
    return out;
  }

  async codeFile(ref: string, relPath: string): Promise<FileAtCommit> {
    return this.fileAtCommit(await this.codeCommit(ref), relPath);
  }

  async codeSearch(ref: string, query: string): Promise<{ files: string[]; hits: CodeSearchHit[]; truncated: boolean }> {
    const oid = await this.codeCommit(ref);
    const q = query.toLowerCase();
    const all = (await this.gitOut(['ls-tree', '-r', '-z', '--name-only', oid], { maxBufferBytes: 64 * 1024 * 1024 })).split('\0').filter(Boolean);
    const files = all.filter((f) => f.toLowerCase().includes(q)).slice(0, 100);
    // Fixed-string, case-insensitive, text files only; never a regular expression from the user.
    const res = await this.git(['grep', '-n', '-z', '-I', '-F', '-i', '--no-color', '-e', query, oid, '--'], { okExitCodes: [1], maxBufferBytes: 32 * 1024 * 1024 }).catch(() => null);
    const { hits, truncated } = parseGrep(res?.stdout ?? '', 500);
    return { files, hits, truncated: truncated || !res };
  }

  async codeInfo(ref?: string): Promise<CodeInfo> {
    const refs = await this.graphRefs();
    const main = await this.mainRef();
    const defaultBranch = main ? main.replace(/^origin\//, '') : null;
    const chosen = ref ?? refs.current ?? defaultBranch ?? refs.branches[0] ?? 'HEAD';
    const base: CodeInfo = { ref: chosen, current: refs.current, defaultBranch, branches: refs.branches, remoteBranches: refs.remotes, tags: refs.tags, commitCount: 0, lastCommit: null, languages: {}, readme: null };
    if (!(await this.hasHead())) return base;
    const oid = await this.codeCommit(chosen);
    const [count, last, tree] = await Promise.all([
      this.gitOut(['rev-list', '--count', oid, '--']),
      this.gitOut(['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%aI', oid, '--']),
      this.gitOut(['ls-tree', '-r', '-z', '-l', oid], { maxBufferBytes: 128 * 1024 * 1024 }),
    ]);
    const [hash, subject, author, date] = last.trim().split('\x1f');
    const languages: Record<string, number> = {};
    let readme: string | null = null;
    for (const e of parseLsTree(tree, '')) {
      if (e.type !== 'file') continue;
      if (!e.path.includes('/') && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name) && (!readme || /\.md$/i.test(e.name))) readme = e.path;
      const lang = languageOf(e.path);
      if (lang && e.size) languages[lang] = (languages[lang] ?? 0) + e.size;
    }
    return { ...base, commitCount: Number(count.trim()) || 0, lastCommit: hash ? { hash, subject, author, date } : null, languages, readme };
  }

  async graphRefs(): Promise<{ current: string | null; branches: string[]; remotes: string[]; tags: string[] }> {
    if (!(await this.hasHead())) return { current: (await this.status()).branch, branches: [], remotes: [], tags: [] };
    const out = await this.gitOut(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    const refs = out.split('\n').filter(Boolean);
    return {
      current: (await this.status()).branch,
      branches: refs.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice(11)),
      remotes: refs.filter((r) => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')).map((r) => r.slice(13)),
      tags: refs.filter((r) => r.startsWith('refs/tags/')).map((r) => r.slice(10)),
    };
  }

  /** Most recently created tags (newest first) with the commit each one points at. */
  async recentTags(limit = 15): Promise<TagInfo[]> {
    const n = Math.min(Math.max(Math.floor(limit), 1), 100);
    // "*" fields describe the tagged commit of an annotated tag; lightweight tags carry the commit in %(objectname).
    const fmt = ['%(refname:short)', '%(objecttype)', '%(objectname)', '%(*objectname)', '%(creatordate:iso-strict)', '%(taggername)', '%(contents:subject)'].join('%1f');
    const out = await this.gitOut(['for-each-ref', '--sort=-creatordate', `--count=${n}`, `--format=${fmt}%1e`, 'refs/tags']);
    return out
      .split('\x1e')
      .map((r) => r.replace(/^\s+/, ''))
      .filter(Boolean)
      .map((r) => {
        const [name, type, obj, target, date, tagger, subject] = r.split('\x1f');
        const annotated = type === 'tag';
        return { name, annotated, commit: (annotated ? target : obj) || obj, date: date || null, tagger: annotated && tagger ? tagger : null, message: annotated && subject ? subject : null };
      })
      .filter((t) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(t.commit));
  }

  async graphAuthors(): Promise<{ name: string; email: string; commits: number }[]> {
    if (!(await this.hasHead())) return [];
    const out = await this.gitOut(['shortlog', '-sne', '--all', '--no-merges']);
    return out
      .split('\n')
      .map((l) => /^\s*(\d+)\t(.*?) <(.*)>$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ commits: Number(m[1]), name: m[2], email: m[3] }))
      .slice(0, 500);
  }

  /** Everyone who committed (all refs, no merges), with first/last commit dates. */
  async contributors(now = Date.now()): Promise<RepoContributor[]> {
    if (!(await this.hasHead())) return [];
    const out = await this.gitOut(['log', '--all', '--no-merges', '--format=%aN%x1f%aE%x1f%aI'], { maxBufferBytes: 200 * 1024 * 1024 });
    const byEmail = new Map<string, RepoContributor>();
    for (const line of out.split('\n')) {
      const [name, email, date] = line.split('\x1f');
      if (!date) continue;
      const key = email.toLowerCase();
      const c = byEmail.get(key);
      if (!c) byEmail.set(key, { name, email, commits: 1, firstCommit: date, lastCommit: date, status: 'active' });
      else {
        c.commits++;
        // Log is newest first: later lines are older.
        if (date < c.firstCommit) c.firstCommit = date;
        if (date > c.lastCommit) c.lastCommit = date;
      }
    }
    const day = 86_400_000;
    return [...byEmail.values()]
      .map((c) => ({
        ...c,
        status: (now - Date.parse(c.lastCommit) > 90 * day ? 'left' : now - Date.parse(c.firstCommit) <= 30 * day ? 'joined' : 'active') as RepoContributor['status'],
      }))
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 1000);
  }

  /** Full details of one commit, with per-file stats and the diff against its first parent. */
  async commitDetails(hash: string): Promise<CommitDetails> {
    this.assertOid(hash);
    const meta = await this.gitOut(['show', '-s', '--decorate=short', `--format=${GRAPH_FIELDS}%x1f%B%x1f%cn%x1f%cI%x1e`, hash, '--']);
    const fields = meta.replace(/\x1e\s*$/, '').split('\x1f');
    const [base] = parseGraphLog(`${fields.slice(0, 8).join('\x1f')}\x1e`);
    const body = (fields[8] ?? '').trim();
    const parent = base.parents[0] ?? EMPTY_TREE;
    const files = await this.statBetween(parent, hash);
    const diffs = parseUnifiedDiff(await this.gitOut(['diff', ...SAFE_DIFF, '-M', parent, hash, '--'], { maxBufferBytes: 200 * 1024 * 1024 }), { maxLinesPerFile: 5000 });
    return {
      ...base,
      body: body.startsWith(base.subject) ? body.slice(base.subject.length).trim() : body,
      committer: fields[9] ?? base.author,
      committerDate: (fields[10] ?? base.date).trim(),
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      diffs,
      isMerge: base.parents.length > 1,
    };
  }

  async compareCommits(from: string, to: string): Promise<CompareResult> {
    this.assertOid(from);
    this.assertOid(to);
    const [a] = parseGraphLog(await this.gitOut(['show', '-s', `--format=${GRAPH_FORMAT}`, from, '--']));
    const [b] = parseGraphLog(await this.gitOut(['show', '-s', `--format=${GRAPH_FORMAT}`, to, '--']));
    const files = await this.statBetween(from, to);
    const diffs = parseUnifiedDiff(await this.gitOut(['diff', ...SAFE_DIFF, '-M', from, to, '--'], { maxBufferBytes: 200 * 1024 * 1024 }), { maxLinesPerFile: 5000 });
    return { from: a, to: b, files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), diffs };
  }

  private async statBetween(from: string, to: string): Promise<CommitStatFile[]> {
    const [numstat, names] = await Promise.all([
      this.gitOut(['diff', ...SAFE_DIFF, '--numstat', '-z', '-M', from, to, '--']),
      this.gitOut(['diff', ...SAFE_DIFF, '--name-status', '-z', '-M', from, to, '--']),
    ]);
    return mergeNumstat(numstat, names);
  }

  /** Content of a file at a commit (read-only viewer; never written to disk). */
  async fileAtCommit(hash: string, relPath: string): Promise<FileAtCommit> {
    this.assertOid(hash);
    const [p] = sanitizeRepoPaths(this.root, [relPath]);
    const res = await this.git(['cat-file', '-p', `${hash}:${p}`], { maxBufferBytes: 8 * 1024 * 1024 }).catch(() => null);
    if (!res) throw new AppError({ code: 'file-missing', title: 'File Not in This Commit', message: `${p} does not exist in commit ${hash.slice(0, 8)}.` });
    const buf = Buffer.from(res.stdout, 'utf8');
    const binary = looksBinary(buf);
    const max = 1024 * 1024;
    return { path: p, hash, content: binary ? '' : res.stdout.slice(0, max), binary, truncated: res.stdout.length > max };
  }

  // ---------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------

  private assertOid(oid: string): void {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)) {
      throw new AppError({ code: 'invalid-revision', title: 'Invalid Commit', message: 'An invalid commit id was supplied.' });
    }
  }

  /** Accepts commit ids and ref names; refuses anything that could be read as an option. */
  private assertRevision(rev: string): void {
    if (!rev || rev.startsWith('-') || rev.length > 300 || /[\s\0~^:?*[\\]/.test(rev.replace(/\^\{commit\}$/, ''))) {
      throw new AppError({ code: 'invalid-revision', title: 'Invalid Revision', message: `"${rev}" is not a valid revision.` });
    }
  }
}
