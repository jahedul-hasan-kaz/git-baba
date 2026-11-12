import { useEffect, useMemo, useRef, useState } from 'react';
import type { GhRepoContext, RepoMetadata } from '../../../shared/github';
import type { BranchChanges, BranchInfo, FriendlyError } from '../../../shared/types';
import { DiffViewer } from '../../components/DiffViewer';
import { ErrorPanel } from '../../components/ErrorPanel';
import { relTime } from '../../components/github/common';
import { BranchPicker, type PickerItem } from '../../components/BranchPicker';
import { Markdown } from '../../components/Markdown';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';
import type { ApiMap } from '../../../shared/api';
import { MergeBranchesDialog, PublishBranchDialog } from '../../dialogs/BranchDialogs';
import { PullRequestPage } from '../PullRequestPage';
import { PrFixAssistant } from './PrFixAssistant';
import { Hourglass } from '../../components/Hourglass';

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
    // The checked-out branch is the source by default (an unpublished one gets the "publish" fix).
    if (!head && !initialHead && activeRepo?.branch && activeRepo.branch !== base) setHead(activeRepo.branch);
  }, [activeRepo?.branch, head, base, initialHead]);

  // Last-commit details from the local clone, so the pickers can show and sort by recent activity.
  const [local, setLocal] = useState<BranchInfo[]>([]);
  useEffect(() => {
    let live = true;
    call('git:branches', { repoId })
      .then((b) => live && setLocal(b))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repoId, recheck]);
  const pickerItems = useMemo((): PickerItem[] => {
    const byName = new Map<string, BranchInfo>();
    for (const b of local) if (b.remote) byName.set(b.name.replace(/^[^/]+\//, ''), b);
    for (const b of local) if (!b.remote) byName.set(b.name, b); // local wins: it has ahead/behind
    const names = new Set([...branches, ...(activeRepo?.branch ? [activeRepo.branch] : [])]);
    return [...names].map((name) => {
      const b = byName.get(name);
      return {
        name,
        current: name === activeRepo?.branch,
        subject: b?.subject,
        date: b?.date,
        oid: b?.oid,
        remote: !branches.includes(name) ? false : !local.some((x) => !x.remote && x.name === name),
        label: branches.includes(name) ? undefined : `${name} (not on GitHub yet)`,
      };
    });
  }, [local, branches, activeRepo?.branch]);

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

  // ---- changed files, read from the local clone (no GitHub call) ----
  const [tab, setTab] = useState<CreateTab>('write');
  const [changes, setChanges] = useState<BranchChanges | null>(null);
  const [changesNote, setChangesNote] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [selFile, setSelFile] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChanges(null);
    setChangesNote(null);
    setSelFile(null);
    if (!base || !head || base === head) return;
    let live = true;
    const t = setTimeout(async () => {
      // Prefer the remote-tracking refs (what GitHub compares), then local branches of the same name.
      for (const [b, h] of [
        [`origin/${base}`, `origin/${head}`],
        [`origin/${base}`, head],
        [base, head],
      ]) {
        try {
          const c = await call('graph:branchChanges', { repoId, branch: h, base: b });
          if (!live) return;
          setChanges(c);
          setSelFile(c.files[0]?.path ?? null);
          return;
        } catch {
          // try the next pair
        }
      }
      if (live) setChangesNote(`${head} is not in your local clone yet — fetch to see its file changes here.`);
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [repoId, base, head, recheck]);

  useEffect(() => {
    if (!splitOpen) return;
    const close = (e: MouseEvent) => !splitRef.current?.contains(e.target as Node) && setSplitOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [splitOpen]);

  const shownFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    return (changes?.files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
  }, [changes, fileFilter]);
  const shownIdx = shownFiles.findIndex((f) => f.path === selFile);
  const selDiff = changes?.diffs.find((d) => d.newPath === selFile || d.oldPath === selFile) ?? null;
  const maxDelta = Math.max(1, ...(changes?.files ?? []).map((f) => Math.max(f.additions, f.deletions)));
  // Top-level areas touched, largest first: where the change lands.
  const areas = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of changes?.files ?? []) {
      const dir = f.path.includes('/') ? f.path.split('/').slice(0, f.path.split('/').length > 2 ? 2 : 1).join('/') : '(root)';
      m.set(dir, (m.get(dir) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [changes]);

  // j / k step through files while the Files tab is open.
  useEffect(() => {
    if (tab !== 'files') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = shownFiles.findIndex((f) => f.path === selFile);
      const next = shownFiles[Math.max(0, Math.min(shownFiles.length - 1, i + (e.key === 'j' ? 1 : -1)))];
      if (next) setSelFile(next.path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, shownFiles, selFile]);

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
  const insert = (snippet: string) => {
    setBody((b) => `${b}${b && !b.endsWith('\n') ? '\n\n' : ''}${snippet}`);
    setTab('write');
    setPreview(false);
  };
  const typeMatch = /^(\w+)(\([^)]*\))?!?:\s*/.exec(title);
  const titleType = typeMatch && TITLE_TYPES.some((t) => t.key === typeMatch[1]) ? typeMatch[1] : null;
  const setType = (t: string) => setTitle((cur) => (titleType === t ? cur.replace(/^(\w+)(\([^)]*\))?!?:\s*/, '') : `${t}: ${cur.replace(/^(\w+)(\([^)]*\))?!?:\s*/, '')}`));
  const suggestions = [...new Set((compare?.commits ?? []).map((c) => c.message.split('\n')[0]).filter((m) => m && m !== title))].slice(0, 3);
  const nFiles = changes?.files.length ?? compare?.files ?? 0;

  return (
    <div className="content prc">
      <div className="prc-scroll">
      <header className="prc-top">
        <nav className="prc-crumbs" aria-label="Breadcrumb">
          <button className="prc-crumb back" onClick={onCancel} title="Back to pull requests">
            <span className="prc-crumb-ico">⇄</span> Pull requests
          </button>
          <span className="prc-crumb here" aria-current="page">
            <span className="prc-crumb-ico">＋</span> New pull request
          </span>
          {head && (
            <span className="prc-crumb tail ellipsis" title={`${head} → ${base}`}>
              {head} → {base}
            </span>
          )}
        </nav>
        <span className="spacer" />
        <a className="prc-alt small" onClick={() => setLegacy(true)} title="The original create flow with GitHub App / PAT authentication">
          Use GitHub App or token instead
        </a>
      </header>

      <section className="prc-rail">
        <div className="prc-end from">
          <span className="prc-end-k">Merge</span>
          <div className="prc-bp head">
            <BranchPicker value={head} onChange={setHead} items={pickerItems} placeholder="Choose the branch with your changes…" recentKey="pr-head" title="Merge from" />
          </div>
        </div>
        <div className="prc-wire">
          <span className={`prc-wire-line ${compare && compare.totalCommits > 0 ? 'live' : ''}`} />
          <div className="prc-wire-chips">
            {comparing && <span className="prc-chip">Comparing…</span>}
            {compare && (
              <>
                <span className="prc-chip ok" title={`${compare.aheadBy} commit(s) on ${head} not in ${base}`}>
                  ↑ {compare.aheadBy}
                </span>
                <button className="prc-swap" onClick={() => head && (setBase(head), setHead(base))} title="Swap base and compare">
                  ⇄
                </button>
                <span className={`prc-chip ${compare.behindBy ? 'warn' : ''}`} title={`${compare.behindBy} commit(s) on ${base} not in ${head}`}>
                  ↓ {compare.behindBy}
                </span>
              </>
            )}
            {!comparing && !compare && (
              <button className="prc-swap" onClick={() => head && (setBase(head), setHead(base))} disabled={!head} title="Swap base and compare">
                ⇄
              </button>
            )}
          </div>
        </div>
        <div className="prc-end into">
          <span className="prc-end-k">into</span>
          <div className="prc-bp base">
            <BranchPicker value={base} onChange={(v) => v && setBase(v)} items={pickerItems.filter((i) => branches.includes(i.name))} placeholder="Choose a base branch…" recentKey="pr-base" title="Merge into" />
          </div>
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
                  <Hourglass /> Re-check
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

      <section className="prc-headline">
        <div className={`prc-title-wrap ${title.trim() ? '' : 'is-blank'}`}>
          <div className="prc-typepick">
            <button
              className={`prc-type-pill ${titleType ? 'on' : ''}`}
              style={{ ['--tc' as string]: TITLE_TYPES.find((t) => t.key === titleType)?.color ?? 'var(--text-3)' }}
              onClick={() => setTypeOpen((o) => !o)}
              onBlur={() => setTimeout(() => setTypeOpen(false), 120)}
              title="Kind of change — adds a prefix such as “feat:” to the title"
              aria-haspopup="menu"
              aria-expanded={typeOpen}
            >
              {titleType ?? 'type'} <span className="prc-caret">▾</span>
            </button>
            {typeOpen && (
              <div className="prc-type-menu pop-in" role="menu">
                {TITLE_TYPES.map((t) => (
                  <button
                    key={t.key}
                    role="menuitemradio"
                    aria-checked={titleType === t.key}
                    className={`prc-type ${titleType === t.key ? 'on' : ''}`}
                    style={{ ['--tc' as string]: t.color }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setType(t.key);
                      setTypeOpen(false);
                    }}
                  >
                    <span className="mono">{t.key}</span>
                    <span className="small muted">{t.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <input className="prc-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name this pull request" maxLength={256} spellCheck />
          <span className={`prc-count ${title.length > 72 ? 'warn' : ''}`} title="Short titles read best in lists and notifications">
            {title.length}/72
          </span>
        </div>
        {suggestions.length > 0 && (
          <div className="prc-suggest small">
            <span className="muted">From commits</span>
            {suggestions.map((s) => (
              <button key={s} onClick={() => setTitle(s)} title={`Use as the title: ${s}`}>
                {s}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="prc-work">
        <nav className="prd-tabs prc-tabs" role="tablist">
          {(
            [
              ['write', '✎', 'Description', null],
              ['files', '▤', 'Files changed', nFiles],
              ['commits', '◉', 'Commits', compare?.totalCommits ?? 0],
            ] as [CreateTab, string, string, number | null][]
          ).map(([id, icon, label, n]) => (
            <button key={id} role="tab" className={`prd-tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              <span className="prd-tab-ico">{icon}</span>
              {label}
              {n !== null && <span className="prd-tab-n">{n}</span>}
            </button>
          ))}
          {changes && (
            <span className="prc-churn small">
              <span className="text-ok">+{changes.additions.toLocaleString()}</span> <span className="text-danger">−{changes.deletions.toLocaleString()}</span>
            </span>
          )}
        </nav>

        {tab === 'write' && (
          <div className="prc-write">
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
                <div className="prc-snips">
                  <button onClick={() => insert('## Summary\n- ')}>＋ Summary</button>
                  <button onClick={() => insert('## Testing\n- [ ] ')}>＋ Testing</button>
                  <button onClick={() => insert('## Notes for reviewers\n')}>＋ Reviewer notes</button>
                  {compare && compare.commits.length > 0 && <button onClick={() => insert(compare.commits.map((c) => `- ${c.message.split('\n')[0]}`).join('\n'))}>＋ Commit list</button>}
                </div>
              </div>
              {preview ? (
                <div className="prc-preview">{body.trim() ? <Markdown source={body} onLink={(href) => /^https?:\/\//i.test(href) && void call('shell:openExternal', { url: href }).catch(() => undefined)} /> : <span className="muted small">Nothing to preview.</span>}</div>
              ) : (
                <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changes, and why? Markdown supported — use the buttons above for a quick structure." />
              )}
            </div>
            <aside className="prc-side">
              <section className="prd-card">
                <div className="prd-card-head">
                  <strong>Impact</strong>
                  {changes && <span className="small muted">{changes.files.length} files</span>}
                </div>
                {!changes && <div className="small muted">{changesNote ?? (head ? 'Reading the changes…' : 'Pick a branch to see what it brings.')}</div>}
                {changes && (
                  <>
                    <div className="prd-churn">
                      <span className="text-ok">+{changes.additions.toLocaleString()}</span>
                      <span className="prd-churn-bar">
                        <i className="add" style={{ flex: changes.additions }} />
                        <i className="del" style={{ flex: changes.deletions }} />
                      </span>
                      <span className="text-danger">−{changes.deletions.toLocaleString()}</span>
                    </div>
                    <ul className="prc-areas">
                      {areas.map(([dir, n]) => (
                        <li key={dir}>
                          <button onClick={() => (setFileFilter(dir === '(root)' ? '' : `${dir}/`), setTab('files'))}>
                            <span className="ellipsis mono">{dir}</span>
                            <span className="prc-area-bar">
                              <i style={{ width: `${(n / areas[0][1]) * 100}%` }} />
                            </span>
                            <span className="small muted">{n}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
              <section className="prd-card">
                <div className="prd-card-head">
                  <strong>Reviewers</strong>
                  <span className="small muted">read-only</span>
                </div>
                <p className="small muted" style={{ margin: 0 }}>
                  GitHub requests reviewers from your branch rules and CODEOWNERS when the pull request opens. They appear on the pull request.
                </p>
              </section>
            </aside>
          </div>
        )}

        {tab === 'files' && (
          <div className="prc-files">
            {!changes ? (
              <div className="prc-files-empty muted small">{changesNote ?? (head ? 'Reading the changes…' : 'Pick a branch to see its changes.')}</div>
            ) : (
              <>
                <div className="prc-tree">
                  <input className="prc-tree-filter" value={fileFilter} onChange={(e) => setFileFilter(e.target.value)} placeholder="Filter files…" spellCheck={false} />
                  <div className="prc-tree-list">
                    {shownFiles.map((f) => (
                      <button key={f.path} className={`prc-file ${f.path === selFile ? 'on' : ''}`} onClick={() => setSelFile(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                        <span className={`prc-fstat ${f.status}`}>{STATUS_MARK[f.status] ?? 'M'}</span>
                        <span className="prc-fname">
                          <span className="ellipsis">{f.path.split('/').pop()}</span>
                          <span className="ellipsis small muted">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                        </span>
                        <span className="prc-fdelta">
                          {f.binary ? (
                            <span className="small muted">bin</span>
                          ) : (
                            <>
                              <i className="add" style={{ width: Math.min(28, Math.ceil(f.additions / maxDelta * 28)) }} />
                              <i className="del" style={{ width: Math.min(28, Math.ceil(f.deletions / maxDelta * 28)) }} />
                            </>
                          )}
                        </span>
                      </button>
                    ))}
                    {shownFiles.length === 0 && <div className="small muted" style={{ padding: 10 }}>No files match.</div>}
                  </div>
                </div>
                <div className="prc-diff">
                  {selDiff ? (
                    <>
                      <div className="prc-diff-head">
                        <span className={`prc-fstat ${selDiff.status}`}>{STATUS_MARK[selDiff.status] ?? 'M'}</span>
                        <span className="mono ellipsis">{selDiff.newPath || selDiff.oldPath}</span>
                        <span className="spacer" />
                        <span className="small">
                          <span className="text-ok">+{selDiff.additions}</span> <span className="text-danger">−{selDiff.deletions}</span>
                        </span>
                        <button className="btn sm ghost" disabled={shownIdx <= 0} onClick={() => setSelFile(shownFiles[shownIdx - 1].path)} title="Previous file (k)">
                          ↑
                        </button>
                        <button className="btn sm ghost" disabled={shownIdx >= shownFiles.length - 1} onClick={() => setSelFile(shownFiles[shownIdx + 1].path)} title="Next file (j)">
                          ↓
                        </button>
                      </div>
                      <DiffViewer diff={selDiff} hideHeader />
                    </>
                  ) : (
                    <div className="prc-files-empty muted small">Select a file to see its changes.</div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'commits' && (
          <div className="prc-commit-list">
            {!compare || compare.commits.length === 0 ? (
              <div className="prc-files-empty muted small">{comparing ? 'Comparing branches…' : 'No commits to show yet.'}</div>
            ) : (
              <ol className="prc-commits">
                {compare.commits.map((c) => (
                  <li key={c.sha}>
                    <i />
                    <div className="prc-commit">
                      <span>{c.message.split('\n')[0]}</span>
                      <span className="small muted">
                        <span className="mono">{c.sha.slice(0, 7)}</span> · {c.author} · {relTime(c.date)}
                      </span>
                    </div>
                    <button className="btn sm ghost" onClick={() => setTitle(c.message.split('\n')[0])} title="Use as the pull request title">
                      Use as title
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

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
          <button className="btn cancel" onClick={onCancel}>
            Cancel
          </button>
          <div className="prc-split" ref={splitRef}>
            <button className={`btn primary ${draft ? 'is-draft' : ''}`} disabled={busy || blockers.length > 0} onClick={() => void create()} title={blockers.join('\n')}>
              {busy ? 'Creating…' : draft ? '✎ Create draft' : 'Create pull request'}
            </button>
            <button className={`btn primary prc-split-caret ${draft ? 'is-draft' : ''}`} onClick={() => setSplitOpen((o) => !o)} aria-label="Choose how to open it" disabled={busy}>
              ▾
            </button>
            {splitOpen && (
              <div className="prc-split-menu pop-in" role="menu">
                {(
                  [
                    [false, 'Ready for review', 'Opens now and notifies reviewers.'],
                    [true, 'Draft', 'Shares the work in progress; it can’t be merged until marked ready.'],
                  ] as [boolean, string, string][]
                ).map(([d, l, hint]) => (
                  <button
                    key={l}
                    role="menuitemradio"
                    aria-checked={draft === d}
                    className={draft === d ? 'on' : ''}
                    onClick={() => {
                      setDraft(d);
                      setSplitOpen(false);
                    }}
                  >
                    <span className="prc-split-check">{draft === d ? '✓' : ''}</span>
                    <span>
                      <strong>{l}</strong>
                      <span className="small muted">{hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type CreateTab = 'write' | 'files' | 'commits';

const TITLE_TYPES: { key: string; hint: string; color: string }[] = [
  { key: 'feat', hint: 'A new feature', color: '#3fb950' },
  { key: 'fix', hint: 'A bug fix', color: '#f85149' },
  { key: 'refactor', hint: 'Code change that neither fixes a bug nor adds a feature', color: '#a371f7' },
  { key: 'perf', hint: 'A performance improvement', color: '#d29922' },
  { key: 'docs', hint: 'Documentation only', color: '#58a6ff' },
  { key: 'test', hint: 'Tests only', color: '#39c5cf' },
  { key: 'chore', hint: 'Build, tooling or maintenance', color: '#8b949e' },
];

const STATUS_MARK: Record<string, string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C', typechange: 'T' };
