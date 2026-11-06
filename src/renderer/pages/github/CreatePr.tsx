import { useEffect, useState } from 'react';
import type { GhRepoContext, RepoMetadata } from '../../../shared/github';
import type { FriendlyError } from '../../../shared/types';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Avatar, Picker, relTime } from '../../components/github/common';
import { Markdown } from '../../components/Markdown';
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
  const [preview, setPreview] = useState(false);
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
      const r = await call('gh:prCreate', { repoId, title: title.trim(), body, base, head, draft, reviewers: [], assignees: [], labels: [], milestone: null });
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
      const r = await call('gh:prCreateCli', { repoId, title: title.trim(), body, base, head, draft, reviewers: [], assignees: [], labels: [] });
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
  const comparing = !!head && head !== base && !compare && !compareError;
  // Readiness checklist shown in the action bar; each item mirrors a blocker.
  const checks: { label: string; state: 'ok' | 'wait' | 'bad' }[] = [
    { label: 'Branches chosen', state: head && head !== base ? 'ok' : 'bad' },
    { label: compare ? `${compare.totalCommits} commit${compare.totalCommits === 1 ? '' : 's'} to merge` : 'Commits to merge', state: comparing ? 'wait' : compare && compare.totalCommits > 0 ? 'ok' : 'bad' },
    { label: 'No open pull request yet', state: comparing ? 'wait' : compare?.existingPr ? 'bad' : compare ? 'ok' : 'bad' },
    { label: 'Histories line up', state: comparing ? 'wait' : compare?.problem || problemCode ? 'bad' : compare ? 'ok' : 'bad' },
    { label: 'Title', state: title.trim() ? 'ok' : 'bad' },
  ];
  const ready = checks.filter((c) => c.state === 'ok').length;
  const authors = compare ? [...new Set(compare.commits.map((c) => c.author))] : [];
  const insert = (snippet: string) => setBody((b) => `${b}${b && !b.endsWith('\n') ? '\n\n' : ''}${snippet}`);

  return (
    <div className="content prc">
      <header className="prc-head">
        <button className="btn sm ghost" onClick={onCancel}>
          ← Pull requests
        </button>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setLegacy(true)} title="The original create flow with GitHub App / PAT authentication">
          Use GitHub App / PAT instead
        </button>
      </header>
      <h1 className="prc-title">Open a pull request</h1>

      <section className="prc-route">
        <div className="prc-branch">
          <span className="prc-branch-k">from</span>
          <Picker title="Choose a compare branch" options={branchOptions} selected={head ? [head] : []} onChange={(v) => setHead(v[0] ?? '')} trigger={<span className="prc-token head">{head || 'choose branch'} ▾</span>} />
        </div>
        <div className="prc-track">
          <span className={`prc-track-line ${compare && compare.totalCommits > 0 ? 'live' : ''}`} />
          <button className="prc-swap" onClick={() => head && (setBase(head), setHead(base))} disabled={!head} title="Swap base and compare">
            ⇄
          </button>
          <span className="prc-track-note small">
            {comparing ? 'Comparing…' : compare ? `${compare.aheadBy} ahead · ${compare.behindBy} behind` : ' '}
          </span>
        </div>
        <div className="prc-branch">
          <span className="prc-branch-k">into</span>
          <Picker title="Choose a base branch" options={branchOptions} selected={[base]} onChange={(v) => v[0] && setBase(v[0])} trigger={<span className="prc-token base">{base} ▾</span>} />
        </div>
      </section>

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

      <div className="prc-grid">
        <section className="prc-compose">
          <input className="prc-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Give it a clear title…" maxLength={256} />
          <div className="prc-editor">
            <div className="prc-editor-bar">
              <div className="segmented sm">
                <button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>
                  Write
                </button>
                <button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
                  Preview
                </button>
              </div>
              <span className="spacer" />
              {!preview && (
                <div className="prc-snips">
                  <button onClick={() => insert('## Summary\n- ')}>＋ Summary</button>
                  <button onClick={() => insert('## Testing\n- [ ] ')}>＋ Testing</button>
                  <button onClick={() => insert('## Notes for reviewers\n')}>＋ Reviewer notes</button>
                  {compare && compare.commits.length > 0 && <button onClick={() => insert(compare.commits.map((c) => `- ${c.message.split('\n')[0]}`).join('\n'))}>＋ Commit list</button>}
                </div>
              )}
            </div>
            {preview ? (
              <div className="prc-preview">{body.trim() ? <Markdown source={body} onLink={(href) => /^https?:\/\//i.test(href) && void call('shell:openExternal', { url: href }).catch(() => undefined)} /> : <span className="muted small">Nothing to preview.</span>}</div>
            ) : (
              <textarea rows={11} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What does this change and why? Markdown supported." />
            )}
          </div>
          <div className="prc-mode" role="radiogroup">
            <button role="radio" aria-checked={!draft} className={!draft ? 'on' : ''} onClick={() => setDraft(false)}>
              <strong>Ready for review</strong>
              <span className="small muted">Reviewers are notified right away</span>
            </button>
            <button role="radio" aria-checked={draft} className={draft ? 'on draft' : ''} onClick={() => setDraft(true)}>
              <strong>✎ Draft</strong>
              <span className="small muted">Can't be merged until marked ready</span>
            </button>
          </div>
        </section>

        <aside className="prc-side">
          <section className="prd-card">
            <div className="prd-card-head">
              <strong>Changes</strong>
              {compare && (
                <span className="small muted">
                  {compare.files} file{compare.files === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {comparing && <div className="small muted">Comparing branches…</div>}
            {!comparing && !compare && <div className="small muted">Pick a branch to see what it brings.</div>}
            {compare && compare.commits.length > 0 && (
              <ol className="prc-commits">
                {compare.commits.map((c) => (
                  <li key={c.sha}>
                    <i />
                    <div className="prc-commit">
                      <span className="ellipsis">{c.message.split('\n')[0]}</span>
                      <span className="small muted">
                        <span className="mono">{c.sha.slice(0, 7)}</span> · {c.author} · {relTime(c.date)}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section className="prd-card">
            <div className="prd-card-head">
              <strong>Reviewers</strong>
              <span className="small muted">read-only</span>
            </div>
            <p className="small muted" style={{ margin: '0 0 10px' }}>
              GitHub requests reviewers from your branch rules and CODEOWNERS once the pull request opens.
            </p>
            {authors.length > 0 && (
              <>
                <div className="small muted mb">People with commits here</div>
                <div className="prc-authors">
                  {authors.slice(0, 6).map((a) => (
                    <span key={a} className="prc-author" title={a}>
                      <Avatar login={a.includes('@') ? undefined : a} size={22} />
                      <span className="ellipsis small">{a}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>
        </aside>
      </div>

      <div className="prc-dock">
        <div className="prc-ready">
          <span className="prc-ready-ring" style={{ ['--p' as string]: `${(ready / checks.length) * 100}%` }}>
            {ready}/{checks.length}
          </span>
          <ul>
            {checks.map((c) => (
              <li key={c.label} className={c.state}>
                {c.state === 'ok' ? '✓' : c.state === 'wait' ? '…' : '○'} {c.label}
              </li>
            ))}
          </ul>
        </div>
        <div className="prc-dock-actions">
          <span className="small muted prc-dock-note">
            Opens in <strong>{ctx.owner}/{ctx.name}</strong> as <strong>{ctx.account}</strong> · nothing is merged or pushed
          </span>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || blockers.length > 0} onClick={() => void create()} title={blockers.join('\n')}>
            {busy ? 'Creating…' : draft ? 'Create draft' : 'Create pull request'}
          </button>
        </div>
      </div>
    </div>
  );
}
