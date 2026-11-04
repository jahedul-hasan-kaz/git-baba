import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AccountCredentialInput, CreateRepoInput, CreateRepoState, FriendlyError, GitHubAccount, WorkflowStep } from '../../shared/types';
import { authenticateAccount, describeScopes, type AccountAuthDeps, type AuthenticatedAccount } from '../accounts/accountAuth';
import type { AppContext } from '../context';
import { AppError, toFriendlyError } from '../git/errors';
import { GitService } from '../git/GitService';
import { parseRemoteUrl } from '../git/remoteUrl';
import type { RepoInfo } from '../github/GitHubService';
import { asFolderName, asGitHubName, ValidationError } from '../util/validate';

const STEP_LABELS: [string, string][] = [
  ['authenticate', 'Authenticate GitHub'],
  ['validate-account', 'Validate account'],
  ['validate-name', 'Validate repository name'],
  ['create-github', 'Create GitHub repository'],
  ['init-local', 'Create local Git repository'],
  ['configure-remote', 'Configure remote'],
  ['status-check', 'Initial status check'],
  ['ready', 'Ready'],
];
const GITHUB_STEPS = new Set(['authenticate', 'validate-account', 'create-github', 'configure-remote']);
const TOKEN_TTL_MS = 30 * 60_000;

interface Workflow {
  id: string;
  input: CreateRepoInput;
  localPath: string;
  account: GitHubAccount | null;
  personal: boolean;
  auth: AuthenticatedAccount | null;
  authExpiry: NodeJS.Timeout | null;
  github: RepoInfo | null;
  /** An existing repository found by the name check; only adopted through the explicit "use existing" fix. */
  candidate: RepoInfo | null;
  /** We sent the create request at least once (used to adopt a repo whose response was lost). */
  createAttempted: boolean;
  /** The GitHub repository was created by this workflow (vs. an existing one the user chose to use). */
  createdByUs: boolean;
  allowNestedInit: boolean;
  state: CreateRepoState;
}

/**
 * Repository creation as an explicit state machine. Each step inspects the current
 * state before acting, so a retry never creates duplicates, and a failure stops at
 * that step with a clear reason and targeted fixes.
 */
export class CreateRepoWorkflows {
  private readonly flows = new Map<string, Workflow>();

  constructor(private readonly ctx: AppContext) {}

  private deps(): AccountAuthDeps {
    return { accounts: this.ctx.accounts, accountSecrets: this.ctx.accountSecrets, githubFor: (b) => this.ctx.githubFor(b) };
  }

  private emit(wf: Workflow): CreateRepoState {
    const snapshot: CreateRepoState = JSON.parse(JSON.stringify(wf.state));
    this.ctx.progress({ kind: 'create', state: snapshot });
    return snapshot;
  }

  private get(id: string): Workflow {
    const wf = this.flows.get(id);
    if (!wf) throw new AppError({ code: 'workflow-missing', title: 'Workflow Not Found', message: 'This repository creation is no longer active. Start again.' });
    return wf;
  }

  private step(wf: Workflow, id: string): WorkflowStep {
    return wf.state.steps.find((s) => s.id === id)!;
  }

  start(input: CreateRepoInput, localParent: string): CreateRepoState {
    const name = asGitHubName(input.name, 'Repository name');
    if (name.endsWith('.git')) throw new ValidationError('Repository name must not end with ".git"');
    const folder = input.folderName ? asFolderName(input.folderName) : undefined;
    const localPath = folder ? path.join(localParent, folder) : localParent;
    let account: GitHubAccount | null = null;
    let personal = false;
    let owner = input.owner;
    if (!input.localOnly) {
      if (!input.accountId) throw new ValidationError('Select a GitHub account');
      account = this.ctx.accounts.get(input.accountId) ?? null;
      if (!account) throw new AppError({ code: 'unknown-account', title: 'Account Not Found', message: 'Add the GitHub account first.' });
      owner = asGitHubName(input.owner, 'Owner');
      personal = owner.toLowerCase() === account.login.toLowerCase();
    }
    const id = crypto.randomBytes(12).toString('base64url');
    const steps: WorkflowStep[] = STEP_LABELS.map(([sid, label]) => ({
      id: sid,
      label,
      status: input.localOnly && GITHUB_STEPS.has(sid) ? 'skipped' : 'pending',
    }));
    const wf: Workflow = {
      id,
      input: { ...input, name, folderName: folder },
      localPath,
      account,
      personal,
      auth: null,
      authExpiry: null,
      github: null,
      candidate: null,
      createAttempted: false,
      createdByUs: false,
      allowNestedInit: false,
      state: {
        workflowId: id,
        phase: input.localOnly ? 'running' : 'awaiting-auth',
        steps,
        summary: { account: account?.login ?? null, owner, name, visibility: input.visibility, localPath, localOnly: input.localOnly },
        githubUrl: null,
        repoId: null,
        incomplete: null,
        fixes: [],
      },
    };
    this.flows.set(id, wf);
    if (input.localOnly) void this.run(wf);
    return this.emit(wf);
  }

  /** Authenticates the selected account for this workflow, then continues automatically. */
  async authenticate(id: string, credential: AccountCredentialInput): Promise<CreateRepoState> {
    const wf = this.get(id);
    if (!wf.account || credential.accountId !== wf.account.id) {
      throw new AppError({ code: 'account-mismatch', title: 'Wrong Account', message: `This repository is being created with ${wf.account?.login ?? 'another account'}. Authenticate that account.` });
    }
    const s = this.step(wf, 'authenticate');
    s.status = 'running';
    s.error = undefined;
    wf.state.phase = 'running';
    this.emit(wf);
    try {
      this.dropAuth(wf);
      wf.auth = await authenticateAccount(this.deps(), credential);
      // Keep the token only while this workflow may still need it.
      wf.authExpiry = setTimeout(() => this.dropAuth(wf), TOKEN_TTL_MS);
      wf.authExpiry.unref?.();
      s.status = 'done';
      s.detail = `Signed in as ${wf.auth.verified.login} (${describeScopes(wf.auth.verified.scopes)})`;
    } catch (err) {
      this.fail(wf, 'authenticate', toFriendlyError(err, 'Authenticate'));
      wf.state.phase = 'awaiting-auth';
      return this.emit(wf);
    }
    await this.run(wf);
    return this.emit(wf);
  }

  /** Re-runs the failed step (after inspecting the current state) and continues. */
  async retry(id: string): Promise<CreateRepoState> {
    const wf = this.get(id);
    if (!wf.input.localOnly && !wf.auth && this.needsGitHub(wf)) {
      wf.state.phase = 'awaiting-auth';
      const s = this.step(wf, 'authenticate');
      s.status = 'pending';
      s.detail = 'Authenticate again to continue (credentials are not kept longer than needed).';
      return this.emit(wf);
    }
    await this.run(wf);
    return this.emit(wf);
  }

  async fix(id: string, fixId: string): Promise<CreateRepoState> {
    const wf = this.get(id);
    if (fixId === 'replace-remote' && wf.github) {
      const git = new GitService(wf.localPath);
      await git.setRemote('origin', wf.github.cloneUrl);
    } else if (fixId === 'use-existing' && wf.candidate) {
      wf.github = wf.candidate;
      wf.state.githubUrl = wf.candidate.htmlUrl;
      const s = this.step(wf, 'create-github');
      s.status = 'done';
      s.detail = `Using the existing repository ${wf.github.fullName}`;
      const v = this.step(wf, 'validate-name');
      v.status = 'done';
      v.error = undefined;
    } else if (fixId === 'init-nested') {
      wf.allowNestedInit = true;
    } else {
      throw new ValidationError('That fix is not available');
    }
    wf.state.fixes = [];
    await this.run(wf);
    return this.emit(wf);
  }

  cancel(id: string): CreateRepoState {
    const wf = this.get(id);
    this.dropAuth(wf);
    wf.state.phase = 'cancelled';
    // Nothing is deleted: explain what already exists so the user can decide.
    const made: string[] = [];
    if (wf.createdByUs && wf.github) made.push(`GitHub repository ${wf.github.fullName}`);
    if (this.step(wf, 'init-local').status === 'done') made.push(`local repository at ${wf.localPath}`);
    wf.state.incomplete = made.length ? `Cancelled. Already created and left untouched: ${made.join(' and ')}.` : 'Cancelled. Nothing was created.';
    const snapshot = this.emit(wf);
    this.flows.delete(id);
    return snapshot;
  }

  state(id: string): CreateRepoState {
    return JSON.parse(JSON.stringify(this.get(id).state));
  }

  // -------------------------------------------------------------------

  private needsGitHub(wf: Workflow): boolean {
    return wf.state.steps.some((s) => GITHUB_STEPS.has(s.id) && s.id !== 'authenticate' && (s.status === 'pending' || s.status === 'failed'));
  }

  private dropAuth(wf: Workflow): void {
    if (wf.authExpiry) clearTimeout(wf.authExpiry);
    wf.authExpiry = null;
    wf.auth?.release();
    wf.auth = null;
  }

  private fail(wf: Workflow, stepId: string, error: FriendlyError, fixes: { id: string; label: string }[] = []): void {
    const s = this.step(wf, stepId);
    s.status = 'failed';
    s.error = error;
    wf.state.phase = 'failed';
    wf.state.fixes = fixes;
    if (wf.createdByUs && wf.github && ['init-local', 'configure-remote', 'status-check'].includes(stepId)) {
      wf.state.incomplete = `The GitHub repository ${wf.github.fullName} was created successfully, but the local repository could not be set up. Retrying continues the local setup — the GitHub repository will not be created again.`;
    } else if (this.step(wf, 'init-local').status === 'done' && stepId === 'create-github') {
      wf.state.incomplete = 'The local repository exists, but the GitHub repository could not be created.';
    }
  }

  private async run(wf: Workflow): Promise<void> {
    wf.state.phase = 'running';
    wf.state.fixes = [];
    for (const s of wf.state.steps) {
      if (s.status === 'done' || s.status === 'skipped') continue;
      if (s.id === 'authenticate') {
        if (!wf.auth) {
          wf.state.phase = 'awaiting-auth';
          return;
        }
        s.status = 'done';
        continue;
      }
      s.status = 'running';
      s.error = undefined;
      this.emit(wf);
      try {
        const ok = await this.exec(wf, s);
        if (!ok) {
          this.emit(wf); // the step recorded its own failure
          return;
        }
        s.status = 'done';
      } catch (err) {
        this.fail(wf, s.id, toFriendlyError(err, s.label));
        this.emit(wf);
        return;
      }
      this.emit(wf);
    }
    wf.state.phase = 'done';
    wf.state.incomplete = null;
    this.dropAuth(wf); // credential removed from memory as soon as the workflow completes
    this.ctx.recordOperation(this.ctx.repos.get(wf.state.repoId ?? '') ?? null, 'Create repository', 'SUCCESS', `${wf.state.summary.localOnly ? '' : `${wf.state.summary.owner}/`}${wf.state.summary.name} at ${wf.localPath}`);
    // A local-only workflow runs in the background, so the window learns it finished only from this event.
    this.emit(wf);
  }

  /** Executes one step. Returns false when the step failed with a handled reason. */
  private async exec(wf: Workflow, s: WorkflowStep): Promise<boolean> {
    const { owner, name } = wf.state.summary;
    switch (s.id) {
      case 'validate-account': {
        const auth = wf.auth!;
        if (wf.personal) {
          s.detail = `Owner ${owner} is your personal account`;
        } else {
          const member = auth.verified.orgs.some((o) => o.toLowerCase() === owner.toLowerCase()) || (await auth.gh.getOrgMembership(auth.token, owner))?.state === 'active';
          if (!member && auth.verified.scopes !== null) {
            this.fail(wf, s.id, {
              code: 'not-org-member',
              title: 'Not a Member of the Organisation',
              message: `${auth.verified.login} is not an active member of "${owner}" (or the token lacks the read:org scope).`,
              reasons: ['Check the organisation name', 'Accept the organisation invitation on GitHub', 'Add the read:org scope to the token'],
              actions: ['review-auth'],
            });
            return false;
          }
          s.detail = member ? `${auth.verified.login} is a member of ${owner}` : `Membership of ${owner} could not be read with a fine-grained token; GitHub checks it when creating`;
        }
        const scopes = auth.verified.scopes;
        if (scopes !== null) {
          const canCreate = scopes.includes('repo') || (wf.input.visibility === 'public' && scopes.includes('public_repo'));
          if (!canCreate) {
            this.fail(wf, s.id, {
              code: 'missing-scope',
              title: 'Token Cannot Create Repositories',
              message: `This classic token has the scopes [${scopes.join(', ') || 'none'}]. Creating a ${wf.input.visibility} repository needs "${wf.input.visibility === 'public' ? 'public_repo or repo' : 'repo'}".`,
              reasons: [],
              actions: ['review-auth'],
            });
            return false;
          }
          s.detail += ' · repository creation permission verified';
        } else {
          s.detail += ' · fine-grained token: needs "Administration: write" — verified by GitHub on creation';
        }
        return true;
      }
      case 'validate-name': {
        if (wf.input.localOnly) {
          s.detail = `Local folder ${wf.localPath}`;
          return true;
        }
        const auth = wf.auth!;
        const existing = await auth.gh.getRepository(auth.token, owner, name);
        if (existing && !wf.github) {
          wf.candidate = existing;
          const canUse = existing.canPush !== false;
          this.fail(
            wf,
            s.id,
            {
              code: 'repo-exists',
              title: 'Repository Already Exists',
              message: `${existing.fullName} already exists on GitHub${existing.private ? ' (private)' : ''}. Choose another name, or use the existing repository.`,
              reasons: [],
              actions: [],
            },
            canUse ? [{ id: 'use-existing', label: `Use existing ${existing.fullName}` }] : [],
          );
          return false;
        }
        s.detail = `${owner}/${name} is available`;
        return true;
      }
      case 'create-github': {
        const auth = wf.auth!;
        if (wf.github) {
          s.detail = `${wf.github.fullName} already exists — not created again`;
          return true;
        }
        // Inspect before creating: a previous attempt may have succeeded even if the response was lost.
        if (wf.createAttempted) {
          const found = await auth.gh.getRepository(auth.token, owner, name);
          if (found) {
            wf.github = found;
            wf.createdByUs = true;
            wf.state.githubUrl = found.htmlUrl;
            s.detail = `${found.fullName} was created by the previous attempt`;
            return true;
          }
        }
        wf.createAttempted = true;
        wf.github = await auth.gh.createRepository(auth.token, { owner, personal: wf.personal, name, private: wf.input.visibility === 'private', description: wf.input.description });
        wf.createdByUs = true;
        wf.state.githubUrl = wf.github.htmlUrl;
        s.detail = `${wf.github.fullName} (${wf.github.private ? 'private' : 'public'})`;
        return true;
      }
      case 'init-local': {
        fs.mkdirSync(wf.localPath, { recursive: true });
        const top = await GitService.findTopLevel(wf.localPath);
        if (top && path.resolve(top).toLowerCase() === path.resolve(wf.localPath).toLowerCase()) {
          s.detail = 'Folder is already a Git repository — kept as is';
          return true;
        }
        if (top && !wf.allowNestedInit) {
          this.fail(
            wf,
            s.id,
            {
              code: 'nested-repo',
              title: 'Folder Is Inside Another Repository',
              message: `${wf.localPath} is inside the existing repository ${top}. Creating a repository inside another one is usually a mistake.`,
              reasons: [],
              actions: [],
            },
            [{ id: 'init-nested', label: 'Create it anyway' }],
          );
          return false;
        }
        await GitService.init(wf.localPath, 'main');
        s.detail = `git init (branch main) in ${wf.localPath}`;
        return true;
      }
      case 'configure-remote': {
        const git = new GitService(wf.localPath);
        const target = wf.github!.cloneUrl;
        const origin = (await git.remotes()).find((r) => r.name === 'origin');
        if (origin) {
          const same = sameRepo(origin.fetchUrl, target);
          if (same) {
            s.detail = `origin already points to ${wf.github!.fullName}`;
            return true;
          }
          this.fail(
            wf,
            s.id,
            {
              code: 'remote-exists',
              title: 'Unable to Configure the GitHub Remote',
              message: `The remote "origin" already exists and points to ${origin.fetchUrl}.`,
              reasons: ['The folder was already connected to another repository'],
              actions: [],
            },
            [{ id: 'replace-remote', label: `Point origin to ${wf.github!.fullName}` }],
          );
          return false;
        }
        await git.setRemote('origin', target);
        s.detail = `origin → ${target}`;
        return true;
      }
      case 'status-check': {
        const git = new GitService(wf.localPath);
        const st = await git.status();
        const real = fs.realpathSync.native(wf.localPath);
        const repo = this.ctx.repos.add(real);
        if (wf.account) this.ctx.repos.updateSettings(repo.id, { accountId: wf.account.id });
        wf.state.repoId = repo.id;
        const changes = st.untracked.length + st.unstaged.length + st.staged.length;
        s.detail = `Branch ${st.branch ?? 'main'} · ${changes} file(s) ready to be committed · added to Git Baba`;
        return true;
      }
      case 'ready':
        s.detail = wf.input.localOnly ? 'Local repository created' : `Repository created${wf.github ? ` — ${wf.github.htmlUrl}` : ''}`;
        return true;
    }
    return true;
  }
}

function sameRepo(a: string, b: string): boolean {
  const pa = parseRemoteUrl(a);
  const pb = parseRemoteUrl(b);
  return !!pa.host && pa.host === pb.host && (pa.owner ?? '').toLowerCase() === (pb.owner ?? '').toLowerCase() && (pa.repo ?? '').toLowerCase() === (pb.repo ?? '').toLowerCase();
}
