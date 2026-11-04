import { useEffect, useState } from 'react';
import type { GhRepoContext, RepoMetadata } from '../../../shared/github';
import type { FriendlyError } from '../../../shared/types';
import { ErrorPanel } from '../../components/ErrorPanel';
import { LabelChip, Picker, relTime } from '../../components/github/common';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';
import type { ApiMap } from '../../../shared/api';
import { MergeBranchesDialog, PublishBranchDialog } from '../../dialogs/BranchDialogs';
import { PullRequestPage } from '../PullRequestPage';
import { PrFixAssistant } from './PrFixAssistant';

type Compare = ApiMap['gh:prCompare']['res'];

interface Props {
  repoId: string;
  ctx: GhRepoContext;
  metadata: RepoMetadata | null;
  initialBase?: string;
  initialHead?: string;
  onCancel: () => void;
  onCreated: (n: number) => void;
  /** A branch was published from here; the branch list should be reloaded. */
  onBranchesChanged?: () => void;
}

export function CreatePr({ repoId, ctx, metadata, initialBase, initialHead, onCancel, onCreated, onBranchesChanged }: Props) {
  const { activeRepo, toast, showError } = useApp();
  const branches = metadata?.branches ?? [];
  const [base, setBase] = useState(initialBase || ctx.defaultBranch);
  const [head, setHead] = useState(initialHead ?? '');
  const [recheck, setRecheck] = useState(0);
  const [fix, setFix] = useState<'bridge' | 'publish' | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [compareError, setCompareError] = useState<FriendlyError | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [fixing, setFixing] = useState(false);

  // Default the compare branch to the checked-out branch when it exists on GitHub.
  useEffect(() => {
    if (!head && activeRepo?.branch && branches.includes(activeRepo.branch) && activeRepo.branch !== base) setHead(activeRepo.branch);
  }, [branches, activeRepo?.branch, head, base]);

  useEffect(() => {
    setCompare(null);
    setCompareError(null);
    if (!base || !head || base === head) return;
    const t = setTimeout(() => {
      call('gh:prCompare', { repoId, base, head })
        .then((c) => {
          setCompare(c);
          if (!title && c.commits.length === 1) setTitle(c.commits[0].message);
          else if (!title) setTitle(head.replace(/[-_/]+/g, ' ').replace(/^\w/, (x) => x.toUpperCase()));
        })
        .catch((err) => setCompareError(toFriendly(err)));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, base, head, recheck]);

  if (legacy) {
    return (
      <div>
        <div className="banner info" style={{ margin: '12px 18px 0' }}>
          <span className="icon">ℹ</span>
          <div className="grow">Creating with a GitHub App installation token or a personal access token (the original flow).</div>
          <button className="btn sm" onClick={() => setLegacy(false)}>
            Back
          </button>
        </div>
        <PullRequestPage />
      </div>
    );
  }

  const blockers: string[] = [];
  if (!head) blockers.push('Choose the branch with your changes (compare).');
  if (head && head === base) blockers.push('The base and compare branches must be different.');
  if (compare && compare.totalCommits === 0) blockers.push(`There is nothing to compare: ${head} has no commits that are not in ${base}.`);
  if (compare?.existingPr) blockers.push(`A pull request already exists for ${head} → ${base}: #${compare.existingPr.number}.`);
  // Diagnosed problem from comparing, or from a failed create attempt.
  const problemCode = compare?.problem?.code ?? (error?.code === 'unrelated-histories' ? 'unrelated' : error?.code === 'head-missing' ? 'head-missing' : null);
  if (compare?.problem) blockers.push(`${compare.problem.title} — see above.`);
  if (!title.trim()) blockers.push('Enter a title.');

  /** Returns the error (null on success) so the fix assistant can retry and react. */
  const create = async (): Promise<FriendlyError | null> => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('gh:prCreate', { repoId, title: title.trim(), body, base, head, draft, reviewers, assignees, labels, milestone });
      if (r.warnings.length) toast(`Pull request #${r.number} created, but: ${r.warnings.join('; ')}`, 'warning');
      else toast(`Pull request #${r.number} created`);
      onCreated(r.number);
      return null;
    } catch (err) {
      const f = toFriendly(err);
      setError(f);
      // A token problem: walk the user through fixing it right away.
      if (f.code === 'pat-permission' || f.code === 'forbidden') setFixing(true);
      return f;
    } finally {
      setBusy(false);
    }
  };

  /** Same pull request through the user's own `gh` login, for when the account token is not allowed to create it. */
  const createWithCli = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await call('gh:prCreateCli', { repoId, title: title.trim(), body, base, head, draft, reviewers, assignees, labels });
      setError(null);
      toast(`Pull request #${r.number} created with GitHub CLI`);
      onCreated(r.number);
      return true;
    } catch (err) {
      showError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const canTryCli = error?.code === 'pat-permission' || error?.code === 'forbidden';

  const branchOptions = branches.map((b) => ({ value: b, label: b }));
  return (
    <div className="content">
      <div className="page" style={{ maxWidth: 1200 }}>
        <div className="row mb">
          <h2 className="grow" style={{ margin: 0 }}>
            Open a pull request
          </h2>
          <button className="btn sm ghost" onClick={() => setLegacy(true)} title="The original create flow with GitHub App / PAT authentication">
            Use GitHub App / PAT instead
          </button>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="card row wrap">
          <span className="small muted">base:</span>
          <Picker title="Choose a base branch" options={branchOptions} selected={[base]} onChange={(v) => v[0] && setBase(v[0])} trigger={<span className="branch-pill">{base} ▾</span>} />
          <span>←</span>
          <span className="small muted">compare:</span>
          <Picker title="Choose a compare branch" options={branchOptions} selected={head ? [head] : []} onChange={(v) => setHead(v[0] ?? '')} trigger={<span className="branch-pill">{head || 'choose branch'} ▾</span>} />
          <span className="spacer" />
          {compare && compare.totalCommits > 0 && !compare.existingPr && <span className="text-ok small">✓ {compare.aheadBy} commit(s) ahead{compare.behindBy ? `, ${compare.behindBy} behind` : ''} of {base}</span>}
        </div>
        {branches.length === 0 && <div className="banner warn small">No branches were found on GitHub. Push your branch first.</div>}
        {compareError && <ErrorPanel error={compareError} onAction={() => setRecheck((n) => n + 1)} available={['retry']} />}
        {(compare?.problem || problemCode) && (
          <div className={`banner ${problemCode === 'no-access' ? 'danger' : 'warn'}`}>
            <span className="icon">{problemCode === 'unrelated' ? '⑂' : '⚠'}</span>
            <div className="grow">
              <div className="row" style={{ gap: 6 }}>
                <strong className="grow">{compare?.problem?.title ?? error?.title}</strong>
                <span className={`badge ${problemCode === 'no-access' ? 'danger' : problemCode === 'unrelated' ? 'warn' : 'info'}`}>
                  {problemCode === 'no-access' ? 'Authentication / permission' : problemCode === 'unrelated' ? 'Branch history' : 'Remote state'}
                </span>
              </div>
              <div className="small">{compare?.problem?.message ?? error?.message}</div>
              <div className="row mt">
                {problemCode === 'unrelated' &&
                  (compare?.local.baseExists !== false ? (
                    <button className="btn sm primary" onClick={() => setFix('bridge')}>
                      Fix: prepare a merge branch &amp; continue
                    </button>
                  ) : (
                    <span className="small muted">Check out {base} locally (Branches &amp; Stash → Remote branches) to prepare a merge branch.</span>
                  ))}
                {problemCode === 'head-missing' &&
                  (compare?.local.headExists ? (
                    <button className="btn sm primary" onClick={() => setFix('publish')}>
                      Fix: publish {head} to GitHub
                    </button>
                  ) : (
                    <span className="small muted">{head} does not exist locally either. Choose another compare branch.</span>
                  ))}
                <button className="btn sm ghost" onClick={() => setRecheck((n) => n + 1)}>
                  ⟳ Re-check
                </button>
              </div>
            </div>
          </div>
        )}
        {fix === 'bridge' && (
          <MergeBranchesDialog
            repoId={repoId}
            source={compare?.local.headExists ? head : `origin/${head}`}
            target={base}
            initialMode="bridge"
            onClose={() => setFix(null)}
            onDone={() => setFix(null)}
            onBridgeReady={(b) => {
              onBranchesChanged?.();
              setHead(b);
              setError(null);
              toast(`Merge branch ${b} published — the pull request now goes from ${b} into ${base}`);
            }}
          />
        )}
        {fix === 'publish' && (
          <PublishBranchDialog
            repoId={repoId}
            name={head}
            base={head}
            onClose={() => setFix(null)}
            onDone={() => {
              setFix(null);
              setError(null);
              onBranchesChanged?.();
              setRecheck((n) => n + 1);
            }}
          />
        )}
        {compare?.existingPr && (
          <div className="banner warn">
            <span className="icon">⚠</span>
            <div className="grow">
              A pull request already exists: <strong>#{compare.existingPr.number}</strong> {compare.existingPr.title}
            </div>
            <button className="btn sm" onClick={() => onCreated(compare.existingPr!.number)}>
              View pull request
            </button>
          </div>
        )}
        {error && !problemCode && <ErrorPanel error={error} />}
        {canTryCli && (
          <div className="banner warn">
            <span className="icon">🩺</span>
            <div className="grow">
              <strong>Git Baba can help you fix this.</strong> It checks your token and the GitHub CLI, then guides you step by step — asking only for what the fix needs.
            </div>
            <button className="btn sm primary" onClick={() => setFixing(true)}>
              Fix this for me
            </button>
          </div>
        )}
        {fixing && (
          <PrFixAssistant
            repoId={repoId}
            base={base}
            head={head}
            createWithCli={createWithCli}
            retry={create}
            useGitHubApp={() => setLegacy(true)}
            onClose={() => setFixing(false)}
          />
        )}

        <div className="pr-create-grid">
          <div>
            <div className="field">
              <label>Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
            </div>
            <div className="field">
              <label>Description</label>
              <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe what this pull request changes and why. Use “Closes #123” to link issues." />
            </div>
            <label className="check">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Create as draft (cannot be merged until marked ready)
            </label>
            {compare && compare.commits.length > 0 && (
              <div className="card mt">
                <h4>
                  {compare.totalCommits} commit(s) · {compare.files} file(s) changed
                </h4>
                {compare.commits.map((c) => (
                  <div key={c.sha} className="small">
                    <span className="mono muted">{c.sha.slice(0, 7)}</span> {c.message} <span className="muted">— {c.author}, {relTime(c.date)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="pr-sidebar">
            <SidebarPicker title="Reviewers" options={(metadata?.assignableUsers ?? []).map((u) => ({ value: u.login, label: u.login }))} values={reviewers} onChange={setReviewers} />
            <SidebarPicker title="Assignees" options={(metadata?.assignableUsers ?? []).map((u) => ({ value: u.login, label: u.login }))} values={assignees} onChange={setAssignees} />
            <div className="sidebar-block">
              <Picker title="Labels" multi options={(metadata?.labels ?? []).map((l) => ({ value: l.name, label: l.name, color: l.color }))} selected={labels} onChange={setLabels} />
              <div className="row wrap">{labels.length ? labels.map((l) => <LabelChip key={l} label={metadata?.labels.find((x) => x.name === l) ?? { name: l, color: '888888' }} />) : <span className="small muted">None yet</span>}</div>
            </div>
            <div className="sidebar-block">
              <Picker title="Milestone" options={(metadata?.milestones ?? []).map((m) => ({ value: String(m.number), label: m.title }))} selected={milestone ? [String(milestone)] : []} allowClear onChange={(v) => setMilestone(v[0] ? Number(v[0]) : null)} />
              <span className="small muted">{metadata?.milestones.find((m) => m.number === milestone)?.title ?? 'No milestone'}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <h4>What will happen</h4>
          <ul className="small" style={{ margin: 0 }}>
            <li>
              A {draft ? 'draft ' : ''}pull request is opened in <strong>{ctx.owner}/{ctx.name}</strong> to merge <strong>{head || '…'}</strong> into <strong>{base}</strong>, as <strong>{ctx.account}</strong>.
            </li>
            {(reviewers.length > 0 || assignees.length > 0 || labels.length > 0 || milestone) && <li>Then reviewers, assignees, labels and milestone are applied (each reported separately if GitHub refuses one).</li>}
            <li>Nothing is merged and no code is pushed.</li>
          </ul>
          {blockers.length > 0 && (
            <ul className="small text-danger" style={{ margin: '8px 0 0' }}>
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <div className="row mt">
            <span className="spacer" />
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || blockers.length > 0} onClick={() => void create()}>
              {busy ? 'Creating…' : draft ? 'Create draft pull request' : 'Create pull request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarPicker({ title, options, values, onChange }: { title: string; options: { value: string; label: string }[]; values: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="sidebar-block">
      <Picker title={title} multi options={options} selected={values} onChange={onChange} />
      <span className="small muted">{values.length ? values.join(', ') : 'None yet'}</span>
    </div>
  );
}
