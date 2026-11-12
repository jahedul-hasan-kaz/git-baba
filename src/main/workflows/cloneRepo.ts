import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AccountCredentialInput, AuthInput, CloneRepoInput, CloneState, RepoSummary, WorkflowStep } from '../../shared/types';
import { authenticateAccount, type AccountAuthDeps } from '../accounts/accountAuth';
import type { AppContext } from '../context';
import type { ResolvedGitAuth } from '../git/credentials';
import { AppError, toFriendlyError } from '../git/errors';
import { GitService } from '../git/GitService';
import { httpsEquivalent, parseRemoteUrl, validateRemoteUrl } from '../git/remoteUrl';
import type { ResolvedAuth } from '../github/authResolver';
import { asFolderName, ValidationError } from '../util/validate';

const STEPS: [string, string][] = [
  ['authenticate', 'Authenticate'],
  ['verify-access', 'Verify repository access'],
  ['clone', 'Clone repository'],
  ['verify', 'Verify local repository'],
  ['add', 'Add to repository list'],
];

interface CloneFlow {
  id: string;
  url: string;
  owner: string | null;
  repoName: string | null;
  parent: string;
  folder: string;
  dest: string;
  accountId: string | null;
  git: ResolvedGitAuth | null;
  transportUrl?: string;
  cleanup: (() => Promise<void>) | null;
  abort: AbortController | null;
  state: CloneState;
}

/** Turns "owner/repo" into a GitHub URL; accepts full https/ssh URLs as they are. */
export function normalizeCloneTarget(input: string): { url: string; owner: string | null; repo: string | null } {
  const v = input.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(v)) {
    const [owner, repo] = v.replace(/\.git$/, '').split('/');
    return { url: `https://github.com/${owner}/${repo}.git`, owner, repo };
  }
  const check = validateRemoteUrl(v);
  if (!check.ok) throw new AppError({ code: 'invalid-url', title: 'Invalid Repository', message: `${check.reason} You can also type owner/repository.` });
  const parsed = parseRemoteUrl(v);
  return { url: v, owner: parsed.owner, repo: parsed.repo };
}

const PROGRESS_RE = /^(?:remote: )?([A-Za-z][A-Za-z ]+):\s+(\d{1,3})%/;

export class CloneWorkflows {
  private readonly flows = new Map<string, CloneFlow>();

  constructor(
    private readonly ctx: AppContext,
    /** Resolves non-account auth methods (SSH, GitHub App, PAT, Git identity) for a clone. */
    private readonly resolveOther: (url: string, auth: AuthInput) => Promise<ResolvedAuth>,
  ) {}

  private deps(): AccountAuthDeps {
    return { accounts: this.ctx.accounts, accountSecrets: this.ctx.accountSecrets, githubFor: (b) => this.ctx.githubFor(b) };
  }

  private emit(f: CloneFlow): CloneState {
    const snap: CloneState = JSON.parse(JSON.stringify(f.state));
    this.ctx.progress({ kind: 'clone', state: snap });
    return snap;
  }

  private get(id: string): CloneFlow {
    const f = this.flows.get(id);
    if (!f) throw new AppError({ code: 'workflow-missing', title: 'Clone Not Found', message: 'This clone is no longer active. Start again.' });
    return f;
  }

  private step(f: CloneFlow, id: string): WorkflowStep {
    return f.state.steps.find((s) => s.id === id)!;
  }

  start(input: CloneRepoInput, parent: string): CloneState {
    const target = normalizeCloneTarget(input.repository);
    const folder = asFolderName(input.folderName || target.repo || '');
    const dest = path.join(parent, folder);
    if (fs.existsSync(dest)) throw new AppError({ code: 'already-exists', title: 'Folder Already Exists', message: `${dest} already exists. Choose another folder name.` });
    const account = input.accountId ? this.ctx.accounts.get(input.accountId) : undefined;
    if (input.accountId && !account) throw new ValidationError('Unknown GitHub account');
    const id = crypto.randomBytes(12).toString('base64url');
    const f: CloneFlow = {
      id,
      url: target.url,
      owner: target.owner,
      repoName: target.repo,
      parent,
      folder,
      dest,
      accountId: account?.id ?? null,
      git: null,
      cleanup: null,
      abort: null,
      state: {
        workflowId: id,
        phase: 'awaiting-auth',
        steps: STEPS.map(([sid, label]) => ({ id: sid, label, status: 'pending' })),
        progress: null,
        summary: {
          repository: target.owner && target.repo ? `${target.owner}/${target.repo}` : target.url,
          owner: target.owner,
          account: account?.login ?? null,
          destination: dest,
          authentication: account ? `GitHub account ${account.login}` : 'Chosen in the next step',
        },
        repo: null,
        leftoverFolder: null,
      },
    };
    this.flows.set(id, f);
    return this.emit(f);
  }

  /** Authenticate (GitHub account token, or another method), verify access, then clone. */
  async authenticate(id: string, credential: AccountCredentialInput | null, other: AuthInput | null): Promise<CloneState> {
    const f = this.get(id);
    const s = this.step(f, 'authenticate');
    s.status = 'running';
    s.error = undefined;
    f.state.phase = 'running';
    this.emit(f);
    const access = this.step(f, 'verify-access');
    try {
      await this.release(f);
      if (credential) {
        if (credential.accountId !== f.accountId) throw new AppError({ code: 'account-mismatch', title: 'Wrong Account', message: 'Authenticate the account selected for this clone.' });
        const auth = await authenticateAccount(this.deps(), credential);
        const parsed = parseRemoteUrl(f.url);
        const https = parsed.httpPrefix ? { url: undefined, httpPrefix: parsed.httpPrefix } : (() => {
          const h = httpsEquivalent(parsed);
          if (!h) throw new AppError({ code: 'auth-not-applicable', title: 'Not a GitHub Repository', message: 'GitHub account authentication works for GitHub repositories only.' });
          return { url: h.url, httpPrefix: h.httpPrefix };
        })();
        f.git = { kind: 'basic', username: auth.account.login, password: auth.token, httpPrefix: https.httpPrefix };
        f.transportUrl = https.url;
        f.cleanup = async () => auth.release();
        s.status = 'done';
        s.detail = `Signed in as ${auth.verified.login}`;
        f.state.summary.authentication = `GitHub account ${auth.account.login}`;
        this.emit(f);
        // Verify access with the API before downloading anything.
        access.status = 'running';
        this.emit(f);
        if (!f.owner || !f.repoName) throw new AppError({ code: 'invalid-url', title: 'Unknown Repository', message: 'Could not determine owner/repository from the URL.' });
        const info = await auth.gh.getRepository(auth.token, f.owner, f.repoName);
        if (!info) {
          throw new AppError({
            code: 'repo-not-found',
            title: 'Repository Not Found',
            message: `${f.owner}/${f.repoName} does not exist, or ${auth.account.login} has no access to it.`,
            reasons: ['Check the owner and repository name', `Make sure ${auth.account.login} has access`, 'Fine-grained tokens must include this repository'],
            actions: ['review-auth'],
          });
        }
        access.status = 'done';
        access.detail = `${info.fullName} (${info.private ? 'private' : 'public'}) — read access verified`;
      } else if (other) {
        const r = await this.resolveOther(f.url, other);
        f.git = r.git;
        f.transportUrl = r.transportUrl;
        f.cleanup = r.cleanup;
        s.status = 'done';
        s.detail = r.description;
        f.state.summary.authentication = r.description;
        access.status = 'skipped';
        access.detail = 'Checked by the server while cloning';
      } else {
        throw new ValidationError('Choose how to authenticate');
      }
    } catch (err) {
      const failed = s.status === 'running' ? s : access;
      failed.status = 'failed';
      failed.error = toFriendlyError(err, failed.label);
      f.state.phase = 'awaiting-auth';
      await this.release(f);
      return this.emit(f);
    }
    await this.runClone(f);
    return this.emit(f);
  }

  private async runClone(f: CloneFlow): Promise<void> {
    const c = this.step(f, 'clone');
    c.status = 'running';
    c.error = undefined;
    f.state.phase = 'running';
    f.abort = new AbortController();
    this.emit(f);
    let lastEmit = 0;
    try {
      await GitService.clone(f.parent, f.url, f.folder, f.git!, f.transportUrl, {
        signal: f.abort.signal,
        onProgress: (line) => {
          const m = PROGRESS_RE.exec(line);
          f.state.progress = { text: line.replace(/^remote: /, ''), percent: m ? Number(m[2]) : null };
          const now = Date.now();
          if (now - lastEmit > 120) {
            lastEmit = now;
            this.emit(f);
          }
        },
      });
      c.status = 'done';
      c.detail = `Cloned into ${f.dest}`;
      f.state.progress = null;
    } catch (err) {
      const cancelled = f.abort.signal.aborted;
      c.status = 'failed';
      c.error = cancelled ? { code: 'cancelled', title: 'Clone Cancelled', message: 'The clone was stopped.', reasons: [], actions: [] } : toFriendlyError(err, 'Clone');
      f.state.phase = cancelled ? 'cancelled' : 'failed';
      f.state.progress = null;
      if (fs.existsSync(f.dest)) f.state.leftoverFolder = f.dest;
      this.ctx.recordOperation(null, 'Clone', cancelled ? 'CANCELLED' : 'FAILED', `${f.state.summary.repository} using ${f.state.summary.authentication}`);
      await this.release(f);
      return;
    } finally {
      f.abort = null;
    }
    await this.release(f); // credential removed from memory right after the network operation

    const v = this.step(f, 'verify');
    v.status = 'running';
    this.emit(f);
    try {
      const st = await new GitService(f.dest).status();
      v.status = 'done';
      v.detail = `Branch ${st.branch ?? 'detached'} · working tree ${st.unstaged.length + st.untracked.length === 0 ? 'clean' : 'has changes'}`;
    } catch (err) {
      v.status = 'failed';
      v.error = toFriendlyError(err, 'Verify');
      f.state.phase = 'failed';
      return;
    }

    const a = this.step(f, 'add');
    const real = fs.realpathSync.native(f.dest);
    const repo = this.ctx.repos.add(real);
    if (f.accountId) this.ctx.repos.updateSettings(repo.id, { accountId: f.accountId });
    a.status = 'done';
    a.detail = `${repo.name} added`;
    f.state.phase = 'done';
    f.state.repo = { id: repo.id } as RepoSummary; // filled in by the handler with a full summary
    this.ctx.recordOperation(repo, 'Clone', 'SUCCESS', `${f.state.summary.repository} using ${f.state.summary.authentication}`);
  }

  cancel(id: string): CloneState {
    const f = this.get(id);
    if (f.abort) f.abort.abort();
    else {
      void this.release(f);
      f.state.phase = 'cancelled';
    }
    return this.emit(f);
  }

  /** Removes the folder left by an interrupted clone — only after explicit confirmation. */
  removeLeftover(id: string): CloneState {
    const f = this.get(id);
    if (!f.state.leftoverFolder || f.state.phase === 'done') throw new ValidationError('There is no incomplete clone folder to remove');
    // Safety: only the exact folder this clone created (it did not exist when the clone started).
    fs.rmSync(f.dest, { recursive: true, force: true });
    f.state.leftoverFolder = null;
    return this.emit(f);
  }

  /** Lets the handler attach the full repository summary after a successful clone. */
  setRepo(id: string, repo: RepoSummary): CloneState {
    const f = this.get(id);
    f.state.repo = repo;
    const snap = this.emit(f);
    this.flows.delete(id);
    return snap;
  }

  private async release(f: CloneFlow): Promise<void> {
    const c = f.cleanup;
    f.cleanup = null;
    if (f.git && f.git.kind === 'basic') f.git = { ...f.git, password: '' };
    if (c) await c();
  }
}
