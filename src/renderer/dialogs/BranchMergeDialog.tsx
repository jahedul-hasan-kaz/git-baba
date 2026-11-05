import { useCallback, useEffect, useState } from 'react';
import type { BranchMergePreview, BranchMergeResult, ErrorAction, FriendlyError, MergeConflictStrategy, MergeIssue, MergeIssueCategory } from '../../shared/types';
import { ErrorPanel } from '../components/ErrorPanel';
import { Modal, Spinner } from '../components/Modal';
import { ResultCard } from '../components/ResultCard';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';
import type { MergeMethod } from '../../shared/github';
import { METHOD_TEXT, MethodGlyph } from '../pages/github/MergeDialog';
import { BranchAuth, Footer, Result, useAuthState } from './branchDialogParts';

/** What each method does to the target, in local terms. */
const LOCAL_METHOD: Record<MergeMethod, string> = {
  merge: 'Keeps every commit and joins the histories with a merge commit (fast-forwards when possible).',
  squash: 'Combines all the changes into one new commit on the target — tidy history, single undo point.',
  rebase: 'Replays each commit on top of the target one by one — a straight, linear history, no merge commit.',
};

/** Plain-language categories, so the user always knows what kind of problem it is. */
const CATEGORY: Record<MergeIssueCategory, { label: string; cls: string }> = {
  history: { label: 'Branch history', cls: 'warn' },
  'git-conflict': { label: 'Git conflict', cls: 'danger' },
  'working-tree': { label: 'Your working folder', cls: 'warn' },
  remote: { label: 'Remote state', cls: 'info' },
  'github-restriction': { label: 'GitHub restriction', cls: 'danger' },
  auth: { label: 'Authentication / permission', cls: 'danger' },
};

/** Classifies a failure so it is never shown as a bare "merge failed". */
export function categorizeError(e: FriendlyError): { category: MergeIssueCategory; hint: string } {
  if (['protected-branch', 'repository-rules', 'default-branch-delete'].includes(e.code)) {
    return { category: 'github-restriction', hint: 'GitHub enforces branch protection / rulesets here. Git Baba never bypasses them — merge into a new branch and open a pull request instead.' };
  }
  if (['auth-failed', 'permission-denied', 'ssh-auth', 'ssh-passphrase', 'auth-input', 'repo-mismatch', 'account-mismatch', 'session-required', 'session-expired', 'forbidden'].includes(e.code)) {
    return { category: 'auth', hint: 'Check the authentication method and that this account / app may write to the repository.' };
  }
  if (['push-rejected', 'diverged', 'publish-unverified', 'no-upstream'].includes(e.code)) {
    return { category: 'remote', hint: 'The remote changed since your last fetch. Fetch & re-check, then try again.' };
  }
  if (['conflict', 'unresolved'].includes(e.code)) return { category: 'git-conflict', hint: 'Resolve the conflicts in the Conflicts tab.' };
  if (['local-changes', 'operation-in-progress'].includes(e.code)) return { category: 'working-tree', hint: 'Commit or stash your changes, or finish the current operation.' };
  if (e.code === 'unrelated-histories') return { category: 'history', hint: 'Tick "Merge anyway" or prepare a merge branch for a pull request.' };
  return { category: 'remote', hint: '' };
}

type Mode = 'direct' | 'bridge';

interface Props {
  repoId: string;
  source: string;
  target: string;
  initialMode?: Mode;
  onClose: () => void;
  onDone: () => void;
  /** Called when a merge branch was published (so a pull-request form can switch to it). */
  onBridgeReady?: (bridge: string) => void;
  /** Reports the merge outcome (used by the multi-branch merge queue to stop on conflicts). */
  onResult?: (result: BranchMergeResult) => void;
  /** Position in a multi-branch merge queue, shown in the title. */
  queue?: { index: number; total: number };
  /** Opened from the simple Merge window, where the mode (direct / new branch + PR) was already chosen: hide those choices. */
  decided?: boolean;
}

/** Detect → Explain → Fix → Re-check → Merge or open a pull request. */
export function MergeBranchesDialog({ repoId, source, target, initialMode = 'direct', onClose, onDone, onBridgeReady, onResult, queue, decided }: Props) {
  const { setRepoTab, setPrDraft, toast } = useApp();
  const [preview, setPreview] = useState<BranchMergePreview | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [bridge, setBridge] = useState('');
  const [push, setPush] = useState(true);
  const [returnToCurrent, setReturnToCurrent] = useState(true);
  const [mergeAnyway, setMergeAnyway] = useState(false);
  const [strategy, setStrategy] = useState<MergeConflictStrategy>('stop');
  const [result, setResult] = useState<BranchMergeResult | null>(null);
  const [method, setMethod] = useState<MergeMethod>('merge');
  const [message, setMessage] = useState('');
  const { auth, authKey, onAuth, resetAuth } = useAuthState();

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = await call('git:mergePreview', { repoId, source, target });
      setPreview(p);
      setPush(!!p.remote);
      setBridge((b) => b || p.suggestedBridge);
    } catch (err) {
      setPreview(null);
      setError(toFriendly(err));
    }
  }, [repoId, source, target]);
  useEffect(() => {
    void load();
  }, [load]);

  // ---- Fixes ----
  const fetchAndRecheck = async () => {
    if (!auth.input) return;
    setBusy('fetch');
    try {
      await call('git:fetch', { repoId, auth: auth.input });
      toast('Fetched the latest remote state — re-checking');
      await load();
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      // One-time secrets (loaded App keys, generated tokens) are consumed; refresh the form.
      if (auth.input?.method === 'github-app') resetAuth();
      setBusy(null);
    }
  };

  const fastForwardTarget = async () => {
    setBusy('ff');
    try {
      const r = await call('git:fastForwardBranch', { repoId, branch: target });
      toast(`${target} moved forward ${r.from.slice(0, 7)} → ${r.to.slice(0, 7)} — re-checking`);
      await load();
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(null);
    }
  };

  const openPullRequest = (head: string) => {
    setPrDraft({ base: target, head: head.replace(new RegExp(`^${preview?.remote?.name ?? 'origin'}/`), '') });
    onDone();
    setRepoTab('pulls');
  };

  const run = async () => {
    if (!preview || !auth.input) return;
    setBusy('merge');
    setError(null);
    try {
      const r = await call('git:mergeExecute', {
        repoId,
        confirmationId: preview.confirmationId,
        auth: auth.input,
        push: mode === 'bridge' ? true : push && !!preview.remote,
        returnToCurrent,
        allowUnrelated: preview.state === 'unrelated' ? mergeAnyway : undefined,
        conflictStrategy: strategy,
        bridge: mode === 'bridge' ? bridge.trim() : undefined,
        method,
        message: method === 'rebase' ? undefined : message.trim() || undefined,
      });
      setResult(r);
      onResult?.(r);
      if (r.bridge && r.pushed) onBridgeReady?.(r.bridge);
    } catch (err) {
      setError(toFriendly(err));
      if (auth.input.method !== 'ssh') resetAuth();
      await load();
    } finally {
      setBusy(null);
    }
  };

  // ---- Result ----
  if (result && !result.pushError) {
    const conflicts = result.outcome === 'conflicts';
    const into = result.bridge ?? target;
    return (
      <ResultCard
        tone={conflicts ? 'warn' : 'ok'}
        title={conflicts ? `${result.conflicted.length} file${result.conflicted.length === 1 ? '' : 's'} need your decision` : <>Merged {source} into {into}</>}
        subtitle={result.message}
        chips={[
          <>
            ⎇ {source} → {into}
          </>,
          ...(result.verifiedRemoteOid ? [<>☁ published &amp; verified</>] : []),
          ...(result.returnedTo ? [<>back on {result.returnedTo}</>] : []),
          ...(conflicts ? result.conflicted.slice(0, 3).map((f) => (
            <span key={f} className="mono" title={f}>
              ! {f.split('/').pop()}
            </span>
          )) : []),
        ]}
        sha={conflicts ? null : result.newOid}
        actions={[
          ...(conflicts ? [{ label: 'Resolve conflicts now', primary: true, run: () => (onDone(), setRepoTab('conflicts')) }] : []),
          ...(result.bridge && result.pushed ? [{ label: `⇄ Open pull request → ${target}`, primary: true, run: () => openPullRequest(result.bridge!) }] : []),
          // Merged locally into the branch you are on, not published yet: push it from here.
          ...(!conflicts && !result.pushed && !result.bridge && preview?.remote && preview.currentBranch === target
            ? [{ label: `⬆ Push ${target}`, primary: true, run: () => (onDone(), window.dispatchEvent(new CustomEvent('gb:repo-dialog', { detail: 'push' }))) }]
            : []),
        ]}
        note={`Signed in with ${result.authDescription}`}
        onClose={onDone}
      />
    );
  }

  if (result) {
    const ok = result.outcome !== 'conflicts' && !result.pushError;
    const pe = result.pushError ? categorizeError(result.pushError) : null;
    return (
      <Result title={result.outcome === 'conflicts' ? 'Merge Needs Your Decisions' : ok ? 'Merge Complete' : 'Merged Locally — Publishing Failed'} ok={ok} onDone={onDone}>
        <div className={`banner ${result.outcome === 'conflicts' || result.pushError ? 'warn' : 'ok'}`}>
          <span className="icon">{result.outcome === 'conflicts' ? '⚠' : '✓'}</span>
          <div>
            <strong>{result.message}</strong>
            {result.newOid && <div className="small mono">HEAD of {result.bridge ?? target}: {result.newOid.slice(0, 12)}</div>}
            {result.verifiedRemoteOid && <div className="small">Remote verified at {result.verifiedRemoteOid.slice(0, 12)}.</div>}
            {result.returnedTo && <div className="small">You are back on {result.returnedTo}.</div>}
            <div className="small">Authentication: {result.authDescription}</div>
          </div>
        </div>
        {result.outcome === 'conflicts' && (
          <>
            <div className="card small mono" style={{ maxHeight: 160, overflow: 'auto' }}>
              {result.conflicted.map((f) => (
                <div key={f}>! {f}</div>
              ))}
            </div>
            <button
              className="btn primary"
              onClick={() => {
                onDone();
                setRepoTab('conflicts');
              }}
            >
              Resolve conflicts now
            </button>
          </>
        )}
        {result.pushError && pe && (
          <>
            <div className="row small mb">
              <span className={`badge ${CATEGORY[pe.category].cls}`}>{CATEGORY[pe.category].label}</span>
              <span className="muted">{pe.hint}</span>
            </div>
            <ErrorPanel error={result.pushError} />
            <p className="small muted">The merge commit stays on {result.bridge ?? target} locally. Fix the problem, then publish it with ⬆ Push….</p>
            {pe.category === 'github-restriction' && !result.bridge && (
              <button
                className="btn primary"
                onClick={() => {
                  setResult(null);
                  setMode('bridge');
                  void load();
                }}
              >
                Merge into a new branch &amp; open a pull request instead
              </button>
            )}
          </>
        )}
        {result.bridge && result.pushed && (
          <button className="btn primary" onClick={() => openPullRequest(result.bridge!)}>
            Open pull request {result.bridge} → {target}
          </button>
        )}
      </Result>
    );
  }

  const issues = preview?.issues ?? [];
  const blockers = issues.filter((i) => i.severity === 'blocker' && !(i.fix === 'merge-anyway' && mergeAnyway));
  const needsConflictChoice = !!preview?.predictedConflicts?.length;
  const bridgeInvalid = mode === 'bridge' && !/^[A-Za-z0-9._/-]+$/.test(bridge.trim());
  const canRun = !!preview && preview.state !== 'up-to-date' && blockers.length === 0 && !bridgeInvalid && (mode === 'direct' || !!preview.remote);
  // A pull request needs the source on GitHub: a local branch with a remote counterpart, or a remote branch itself.
  const sourceOnRemote = !!preview?.sourceRemote?.exists || (!!preview && !preview.sourceRemote && preview.source.includes('/'));

  const fixButton = (i: MergeIssue) => {
    switch (i.fix) {
      case 'fetch':
        return (
          <button className="btn sm" disabled={!auth.input || !!busy} title={auth.input ? '' : 'Choose an authentication method first'} onClick={fetchAndRecheck}>
            {busy === 'fetch' ? 'Fetching…' : 'Fetch & re-check'}
          </button>
        );
      case 'fast-forward-target':
        return (
          <button className="btn sm primary" disabled={!!busy} onClick={fastForwardTarget}>
            {busy === 'ff' ? 'Updating…' : `Fix: update ${target} from remote`}
          </button>
        );
      case 'commit-or-stash':
        return (
          <button
            className="btn sm"
            onClick={() => {
              onClose();
              setRepoTab('changes');
            }}
          >
            Go to Changes
          </button>
        );
      case 'bridge-pr':
        return (
          <button className="btn sm" onClick={() => setMode('bridge')}>
            Use a merge branch &amp; pull request
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      title={`${queue ? `Step ${queue.index + 1} of ${queue.total} · ` : ''}Merge ${source} → ${target}`}
      onClose={onClose}
      locked={!!busy}
      footer={
        <Footer
          auth={auth}
          busy={busy === 'merge'}
          disabled={!canRun || !!busy}
          label={`${method === 'squash' ? 'Squash' : method === 'rebase' ? 'Rebase' : 'Merge'}${mode === 'bridge' ? ' & publish branch' : ` into ${target}`}`}
          busyLabel="Merging…"
          onCancel={onClose}
          onRun={run}
        />
      }
    >
      {error &&
        (() => {
          const c = categorizeError(error);
          return (
            <>
              <div className="row small mb">
                <span className={`badge ${CATEGORY[c.category].cls}`}>{CATEGORY[c.category].label}</span>
                {c.hint && <span className="muted">{c.hint}</span>}
              </div>
              <ErrorPanel error={error} onAction={(a: ErrorAction) => (a === 'review-auth' ? resetAuth() : a === 'retry' ? void load() : undefined)} available={['review-auth', 'retry']} onSwitched={() => { resetAuth(); void load(); }} />
            </>
          );
        })()}
      {!preview && !error && <Spinner label="Analysing both branches: history, merge base, conflicts and remote state…" />}
      {preview && (
        <div className="bm">
          {/* What happens, in one line: source —(commits)→ target, plus the history shape. */}
          <div className="bm-flow">
            <span className="branch-pill" title={preview.sourceOid}>
              {source}
            </span>
            <span className="bm-wire">
              <span className="bm-wire-label">
                {preview.sourceOnly} commit{preview.sourceOnly === 1 ? '' : 's'} · {preview.files.length} file{preview.files.length === 1 ? '' : 's'}
              </span>
            </span>
            <span className="branch-pill" title={preview.targetOid}>
              {target}
            </span>
            <span className="spacer" />
            {preview.state === 'up-to-date' && <span className="badge ok">up to date</span>}
            {preview.state === 'fast-forward' && <span className="badge info" title="No merge commit is needed">fast-forward</span>}
            {preview.state === 'merge' && (
              <span className="badge" title={`Common ancestor ${preview.mergeBase?.slice(0, 8)} · ${preview.targetOnly} commit(s) only on ${target}`}>
                diverged · {preview.targetOnly} on {target}
              </span>
            )}
            {preview.state === 'unrelated' && <span className="badge danger">no common history</span>}
          </div>

          {issues.length === 0 ? (
            <div className="bm-ready small">
              <span className="text-ok">✓</span> {preview.state === 'up-to-date' ? `${target} already contains everything from ${source}. Nothing to merge.` : 'No problems found — ready to merge.'}
              {preview.account && <span className="muted"> · as {preview.account.login}</span>}
            </div>
          ) : (
              issues.map((i) => (
                <div key={i.id} className={`banner ${i.severity === 'blocker' ? (i.fix === 'merge-anyway' && mergeAnyway ? 'warn' : 'danger') : i.severity === 'warning' ? 'warn' : 'info'} small`}>
                  <span className="icon">{i.severity === 'blocker' ? '⛔' : i.severity === 'warning' ? '⚠' : 'ℹ'}</span>
                  <div className="grow">
                    <div className="row" style={{ gap: 6 }}>
                      <strong className="grow">{i.title}</strong>
                      <span className={`badge ${CATEGORY[i.category].cls}`}>{CATEGORY[i.category].label}</span>
                    </div>
                    <div>{i.explanation}</div>
                    {i.id === 'conflicts' && preview.predictedConflicts && (
                      <div className="mono" style={{ fontSize: 11, maxHeight: 90, overflow: 'auto', margin: '4px 0' }}>
                        {preview.predictedConflicts.map((f) => (
                          <div key={f}>! {f}</div>
                        ))}
                      </div>
                    )}
                    {i.fix === 'merge-anyway' && (
                      <label className="check">
                        <input type="checkbox" checked={mergeAnyway} onChange={(e) => setMergeAnyway(e.target.checked)} />
                        <span>
                          <strong>Merge anyway</strong> — I understand the histories are unrelated: files that exist on both sides with different content become conflicts I decide, and
                          the result joins two separate histories.
                        </span>
                      </label>
                    )}
                    <div className="row mt">{fixButton(i)}</div>
                  </div>
                </div>
              ))
            )}
          {preview.remote && (
            <div className="row bm-links">
              <button className="btn sm ghost" disabled={!auth.input || !!busy} onClick={fetchAndRecheck} title={auth.input ? 'Fetch with the chosen authentication and analyse again' : 'Choose an authentication method first'}>
                ⟳ Fetch &amp; re-check
              </button>
              {!decided && preview.state !== 'unrelated' && preview.state !== 'up-to-date' && sourceOnRemote && (
                <button className="btn sm ghost" onClick={() => openPullRequest(source)}>
                  ⇄ Pull request instead
                </button>
              )}
            </div>
          )}

          {!decided && (
          <div className="bm-modes" role="radiogroup" aria-label="How to merge">
            <button role="radio" aria-checked={mode === 'direct'} className={`bm-mode ${mode === 'direct' ? 'on' : ''}`} onClick={() => setMode('direct')}>
              <strong>⤵ Into {target}</strong>
              <span className="small muted">{preview.remote ? 'merge, then publish (verified)' : 'local only — no remote'}</span>
            </button>
            <button role="radio" aria-checked={mode === 'bridge'} className={`bm-mode ${mode === 'bridge' ? 'on' : ''}`} disabled={!preview.remote} onClick={() => setMode('bridge')}>
              <strong>
                ⇄ New branch + PR {(preview.state === 'unrelated' || (preview.remote?.behindRemote ?? 0) > 0) && <span className="badge ok">recommended</span>}
              </strong>
              <span className="small muted">{target} untouched; reviewed on GitHub</span>
            </button>
          </div>
          )}
          {mode === 'bridge' && !decided && (
            <div className="field bm-bridge">
              <input value={bridge} onChange={(e) => setBridge(e.target.value)} spellCheck={false} aria-label="New branch name" title={`Created from ${target}; ${source} is merged into it, then it is published and a pull request opens`} />
              {bridgeInvalid && <div className="small text-danger">Use letters, digits, “.”, “_”, “-” and “/”.</div>}
            </div>
          )}

          {preview.state !== 'up-to-date' && (
            <>
              <div className="mg-methods" role="radiogroup" aria-label="Merge method">
                {(['merge', 'squash', 'rebase'] as MergeMethod[]).map((m) => {
                  const off = m === 'rebase' && preview.state === 'unrelated';
                  return (
                    <button
                      key={m}
                      role="radio"
                      aria-checked={method === m}
                      className={`mg-method ${method === m ? 'on' : ''}`}
                      disabled={off}
                      onClick={() => setMethod(m)}
                      title={off ? 'No common history to rebase onto' : METHOD_TEXT[m][0]}
                    >
                      <MethodGlyph m={m} />
                      <span>{m === 'merge' ? 'Merge commit' : m === 'squash' ? 'Squash' : 'Rebase'}</span>
                    </button>
                  );
                })}
              </div>
              <div className="small muted mg-method-desc">
                {LOCAL_METHOD[method]}
                {method === 'merge' && preview.state === 'fast-forward' && ' Here no merge commit is needed — the branch just moves forward.'}
              </div>
              {method !== 'rebase' && !(method === 'merge' && preview.state === 'fast-forward') && (
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  aria-label="Commit message"
                  placeholder={method === 'squash' ? `Squashed merge of '${source}' into ${target}` : `Merge branch '${source}' into ${target}`}
                />
              )}
            </>
          )}

          {needsConflictChoice && (
            <div className="bm-conf">
              <div className="small">
                <strong className="text-warn">⚠ {preview.predictedConflicts!.length} conflicting file{preview.predictedConflicts!.length === 1 ? '' : 's'}</strong> — when a part conflicts:
              </div>
              <div className="segmented">
                {(
                  [
                    ['stop', 'Ask me', 'Stop and open the Conflicts tab: decide per block, per file or in the editor. Nothing is published until you finish.'],
                    ['prefer-target', `Keep ${target}`, `Conflicting parts silently keep ${target}'s lines; other changes from ${source} are still merged.`],
                    ['prefer-source', `Take ${source}`, `Conflicting parts silently take ${source}'s lines, replacing ${target}'s.`],
                  ] as [MergeConflictStrategy, string, string][]
                ).map(([v, l, d]) => (
                  <button key={v} className={strategy === v ? 'on' : ''} onClick={() => setStrategy(v)} title={d}>
                    {l}
                  </button>
                ))}
              </div>
              {strategy !== 'stop' && <div className="small text-warn">Automatic resolution can drop changes without showing them — review the result before publishing important branches.</div>}
            </div>
          )}

          {!decided && (
          <div className="bm-opts">
            {mode === 'direct' && preview.remote && (
              <label className={`bm-opt ${push ? 'on' : ''}`} title={`Push ${target} to ${preview.remote.name}/${preview.remote.remoteBranch} and verify it arrived`}>
                <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> ☁ Publish {target}
              </label>
            )}
            {preview.currentBranch && (mode === 'bridge' || preview.currentBranch !== target) && (
              <label className={`bm-opt ${returnToCurrent ? 'on' : ''}`}>
                <input type="checkbox" checked={returnToCurrent} onChange={(e) => setReturnToCurrent(e.target.checked)} /> ↩ Back to {preview.currentBranch}
              </label>
            )}
          </div>
          )}
          {blockers.length > 0 && <div className="small text-danger">Fix the ⛔ item(s) above to continue.</div>}

          <BranchAuth repoId={repoId} ctx={preview} remoteUrl={preview.remote?.url ?? null} authKey={authKey} onChange={onAuth} hideTitle asLabel="Merge as" account={preview.account?.login ?? null} />
        </div>
      )}
    </Modal>
  );
}
