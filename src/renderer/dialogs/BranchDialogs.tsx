import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  BranchDeletePreview,
  BranchDeleteResult,
  BranchPublishPreview,
  BranchPublishResult,
  BranchSwitchPreview,
  ErrorAction,
  FriendlyError,
  SwitchFileState,
  SwitchStrategy,
} from '../../shared/types';
import { BranchAuth, Footer, Result, useAuthState } from './branchDialogParts';
import { ErrorPanel } from '../components/ErrorPanel';
import { Modal, Spinner } from '../components/Modal';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';
import { PublishChanges } from './PublishChanges';

export { MergeBranchesDialog } from './BranchMergeDialog';

// ---------------------------------------------------------------------------
// Switch branches (with uncommitted changes)
// ---------------------------------------------------------------------------

const STATE_INFO: Record<SwitchFileState, { label: string; cls: string; help: string }> = {
  safe: { label: 'comes along', cls: 'ok', help: 'Unchanged on the target branch — your edit simply comes along.' },
  merges: { label: 'merges cleanly', cls: 'info', help: 'Changed on the target branch too, but your edits merge without overlapping.' },
  conflict: { label: 'conflict', cls: 'danger', help: 'Your edits and the target branch overlap — you decide line by line.' },
  blocked: { label: 'exists on target', cls: 'warn', help: 'This untracked file of yours also exists on the target branch.' },
};

export function SwitchBranchDialog({ repoId, target, kind, onClose, onDone }: { repoId: string; target: string; kind: 'local' | 'remote'; onClose: () => void; onDone: () => void }) {
  const { toast, setRepoTab, selectRepo, showError } = useApp();
  /** Another worktree folder that already has this branch checked out (Git allows one folder per branch). */
  const [heldBy, setHeldBy] = useState<string | null>(null);
  const [preview, setPreview] = useState<BranchSwitchPreview | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [strategy, setStrategy] = useState<SwitchStrategy>('carry');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<SwitchFileState | 'all'>('all');

  const execute = useCallback(
    async (p: BranchSwitchPreview, s: SwitchStrategy) => {
      setBusy(true);
      setError(null);
      try {
        const r = await call('git:switchExecute', { repoId, confirmationId: p.confirmationId, strategy: s });
        toast(r.message, r.outcome === 'conflicts' ? 'warning' : r.outcome === 'stashed' ? 'info' : 'success');
        onDone();
        if (r.outcome === 'conflicts') setRepoTab('conflicts');
      } catch (err) {
        setError(toFriendly(err));
        setBusy(false);
      }
    },
    [repoId, toast, onDone, setRepoTab],
  );

  useEffect(() => {
    const local = kind === 'local' ? target : null;
    (local ? call('git:worktrees', { repoId }).catch(() => []) : Promise.resolve([]))
      .then((list) => {
        const holder = list.find((w) => w.branch === local && !w.current && !w.prunable);
        if (holder) {
          setHeldBy(holder.path);
          return null;
        }
        return call('git:switchPreview', { repoId, target, kind });
      })
      .then((p) => {
        if (!p) return;
        setPreview(p);
        setStrategy(p.recommended);
        // Nothing uncommitted: there is nothing to decide, switch right away.
        if (p.files.length === 0) void execute(p, 'carry');
      })
      .catch((err) => setError(toFriendly(err)));
  }, [repoId, target, kind, execute]);

  if (heldBy) {
    const openIt = () =>
      call('git:worktreeOpen', { repoId, path: heldBy })
        .then((r) => {
          selectRepo(r.id);
          onClose();
        })
        .catch(showError);
    return (
      <Modal
        title={`${target} is open in another worktree`}
        onClose={onClose}
        footer={
          <>
            <button className="btn cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void openIt()}>
              Open that worktree
            </button>
          </>
        }
      >
        <p>
          <strong>{target}</strong> is already checked out in <code>{heldBy}</code>. Git lets a branch be checked out in only one folder at a time, so this folder can't switch to it.
        </p>
        <p className="small muted">
          To work on {target}, open that worktree. To bring {target}'s commits into the branch here instead, merge it (Merge Studio) — no switch is needed. Nothing was changed.
        </p>
      </Modal>
    );
  }

  if (preview && preview.files.length === 0 && !error) return <Modal title={`Switching to ${preview.target}`} onClose={onClose} locked><Spinner label="Switching…" /></Modal>;

  const counts = (preview?.files ?? []).reduce<Record<SwitchFileState, number>>((acc, f) => ({ ...acc, [f.state]: acc[f.state] + 1 }), { safe: 0, merges: 0, conflict: 0, blocked: 0 });
  const shown = (preview?.files ?? []).filter((f) => filter === 'all' || f.state === filter);
  const options: { id: SwitchStrategy; title: string; body: ReactNode; disabled: string | null }[] = preview
    ? [
        {
          id: 'carry',
          title: 'Bring my changes along',
          body: 'Plain switch. Your uncommitted files stay exactly as they are.',
          disabled: preview.canCarry ? null : `Not possible: ${counts.merges + counts.conflict + counts.blocked} file(s) differ on ${preview.target} and Git would refuse to overwrite them.`,
        },
        {
          id: 'stash-apply',
          title: 'Stash, switch and re-apply my changes',
          body:
            counts.conflict > 0 ? (
              <>
                Your changes are merged into {preview.target}. <strong>{counts.conflict} file(s) will conflict</strong> — you resolve them interactively in the Conflicts tab. A backup stash is kept until you finish, so you can undo at any time.
              </>
            ) : (
              <>Your changes are merged into {preview.target}{counts.merges ? ` (${counts.merges} file(s) merge automatically)` : ''}. A backup stash protects them during the switch.</>
            ),
          disabled: preview.canReapply ? null : `Not possible automatically: ${counts.blocked} untracked file(s) also exist on ${preview.target}.`,
        },
        {
          id: 'stash',
          title: 'Stash my changes and switch',
          body: <>Your changes are saved in a named stash and {preview.target} opens clean. Apply or pop the stash later from Branches & Stash.</>,
          disabled: null,
        },
      ]
    : [];
  const chosenDisabled = options.find((o) => o.id === strategy)?.disabled;

  return (
    <Modal
      title={preview ? `Switch ${preview.current ?? 'detached HEAD'} → ${preview.target}` : 'Switch branch'}
      onClose={onClose}
      locked={busy}
      size="wide"
      footer={
        <>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              onClose();
              setRepoTab('changes');
            }}
          >
            Commit them first instead
          </button>
          <span className="spacer" />
          <button className="btn cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!preview || busy || !!chosenDisabled} onClick={() => preview && execute(preview, strategy)}>
            {busy ? 'Switching…' : `Switch to ${preview?.target ?? target}`}
          </button>
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      {!preview && !error && <Spinner label="Checking your uncommitted changes against the target branch…" />}
      {preview && (
        <div className="grid-2" style={{ gap: 20, alignItems: 'start' }}>
          <div>
            <div className="banner warn small">
              <span className="icon">⚠</span>
              <div>
                You have <strong>{preview.files.length} uncommitted file(s)</strong> on {preview.current ?? 'detached HEAD'}. Nothing is lost whichever option you choose — Git Baba checked how each file fares on{' '}
                <strong>{preview.target}</strong> without changing anything.
              </div>
            </div>
            <dl className="kv mb">
              <dt>Target</dt>
              <dd>
                <span className="branch-pill">{preview.target}</span> <span className="mono small muted">{preview.targetOid.slice(0, 10)}</span> {preview.targetSubject}
              </dd>
              {preview.createsLocalFrom && (
                <>
                  <dt>Creates</dt>
                  <dd>
                    local branch {preview.target} tracking {preview.createsLocalFrom}
                  </dd>
                </>
              )}
            </dl>
            <div className="row wrap mb" style={{ gap: 6 }}>
              <button className={`chip-filter ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
                All {preview.files.length}
              </button>
              {(Object.keys(STATE_INFO) as SwitchFileState[])
                .filter((s) => counts[s] > 0)
                .map((s) => (
                  <button key={s} className={`chip-filter ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)} title={STATE_INFO[s].help}>
                    <span className={`badge ${STATE_INFO[s].cls}`}>{STATE_INFO[s].label}</span> {counts[s]}
                  </button>
                ))}
            </div>
            <div className="card" style={{ maxHeight: 260, overflow: 'auto', padding: 6 }}>
              {shown.map((f) => (
                <div key={f.path} className="row small" style={{ padding: '3px 4px' }} title={STATE_INFO[f.state].help}>
                  <span className="mono grow ellipsis">
                    {f.path} {f.kind === 'untracked' ? <span className="muted">(new)</span> : f.staged ? <span className="muted">(staged)</span> : null}
                  </span>
                  <span className={`badge ${STATE_INFO[f.state].cls}`}>{STATE_INFO[f.state].label}</span>
                </div>
              ))}
            </div>
            {!preview.predictionAvailable && <div className="small muted mt">Conflict prediction is not available with this Git version; files changed on both sides are treated as possible conflicts.</div>}
          </div>
          <div>
            <h3>How should your changes be handled?</h3>
            {options.map((o) => (
              <label key={o.id} className={`radio-card ${strategy === o.id ? 'selected' : ''}`} style={o.disabled ? { opacity: 0.55 } : undefined}>
                <input type="radio" checked={strategy === o.id} disabled={!!o.disabled} onChange={() => setStrategy(o.id)} />
                <div>
                  <strong>{o.title}</strong> {preview.recommended === o.id && <span className="badge ok">recommended</span>}
                  <div className="small muted">{o.disabled ?? o.body}</div>
                </div>
              </label>
            ))}
            {preview.files.some((f) => f.staged) && strategy !== 'carry' && <div className="small muted">Note: after re-applying, previously staged files are unstaged (their content is unchanged).</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Create & publish a branch
// ---------------------------------------------------------------------------

export function PublishBranchDialog({ repoId, name, base, onClose, onDone }: { repoId: string; name: string; base: string; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<BranchPublishPreview | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchTo, setSwitchTo] = useState(true);
  const [commitPending, setCommitPending] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [result, setResult] = useState<BranchPublishResult | null>(null);
  const { auth, authKey, onAuth, resetAuth } = useAuthState();

  const load = useCallback(async () => {
    setError(null);
    try {
      setPreview(await call('git:publishPreview', { repoId, name, base: base || undefined }));
    } catch (err) {
      setPreview(null);
      setError(toFriendly(err));
    }
  }, [repoId, name, base]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    if (!preview || !auth.input) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await call('git:publishExecute', {
          repoId,
          confirmationId: preview.confirmationId,
          auth: auth.input,
          switchTo: switchTo || commitPending,
          commitMessage: commitPending ? commitMessage.trim() : undefined,
        }),
      );
    } catch (err) {
      setError(toFriendly(err));
      if (auth.input.method !== 'ssh') resetAuth();
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Result title="Branch Published" ok onDone={onDone}>
        <div className="banner ok">
          <span className="icon">✓</span>
          <div>
            <strong>
              {result.branch} was created and published to {result.remote}/{result.branch}.
            </strong>
            <div className="small">
              Remote verified at <span className="mono">{result.verifiedRemoteOid.slice(0, 12)}</span> (same as the local branch). Upstream tracking is set.
            </div>
            {result.committed && (
              <div className="small">
                Committed your pending changes as <span className="mono">{result.committed.shortHash}</span> “{result.committed.subject}”.
              </div>
            )}
            <div className="small">Authentication: {result.authDescription}</div>
          </div>
        </div>
      </Result>
    );
  }

  const commitInvalid = commitPending && !commitMessage.trim();
  return (
    <Modal
      title={`Create & Publish ${name}`}
      onClose={onClose}
      locked={busy}
      size="wide"
      footer={<Footer auth={auth} busy={busy} disabled={!preview || commitInvalid} label="Create & Publish" busyLabel="Publishing…" onCancel={onClose} onRun={run} />}
    >
      {error && <ErrorPanel error={error} onAction={(a: ErrorAction) => (a === 'review-auth' ? resetAuth() : a === 'retry' ? void run() : undefined)} available={['review-auth', 'retry']} onSwitched={() => { resetAuth(); void load(); }} />}
      {!preview && !error && <Spinner label="Preparing…" />}
      {preview && (
        <div className="grid-2" style={{ gap: 20, alignItems: 'start' }}>
          <div className="pb">
            <div className="pb-route">
              <div className="pb-end">
                <span className="pb-k">From</span>
                <span className="branch-pill">{preview.base}</span>
                <span className="small muted ellipsis" title={preview.baseSubject}>
                  <span className="mono">{preview.baseOid.slice(0, 7)}</span> {preview.baseSubject}
                </span>
              </div>
              <span className="pb-arrow" aria-hidden>
                <i />
              </span>
              <div className="pb-end mid">
                <span className="pb-k">New branch</span>
                <span className="branch-pill pb-new">{name}</span>
                {preview.localExists && <span className="small muted">exists locally — reused</span>}
              </div>
              <span className="pb-arrow" aria-hidden>
                <i />
              </span>
              <div className="pb-end right">
                <span className="pb-k">Publish to</span>
                <span className="pb-remote">☁ {preview.remote?.name}/{name}</span>
                <span className="small muted ellipsis">{preview.account?.login ? `as ${preview.account.login}` : 'no account associated'}</span>
              </div>
            </div>

            {preview.remoteTrackingExists && (
              <div className="banner warn small">
                <span className="icon">⚠</span>
                <div>
                  {preview.remote?.name}/{name} already exists (as of your last fetch). Publishing only succeeds if it is a fast-forward — nothing is overwritten.
                </div>
              </div>
            )}

            {preview.pendingFiles.length > 0 && (
              <PublishChanges
                repoId={repoId}
                branch={name}
                canCommit={preview.canCommitPending}
                include={commitPending}
                onInclude={setCommitPending}
                message={commitMessage}
                onMessage={setCommitMessage}
                onUndone={() => void load()}
                disabled={busy}
              />
            )}

            <ol className="pb-steps">
              <li>
                <b>{preview.localExists ? 'Reuse' : 'Create'}</b> {name} at <span className="mono">{preview.baseOid.slice(0, 7)}</span> and check it contains the base
              </li>
              {commitPending && (
                <li>
                  <b>Commit</b> {preview.pendingFiles.length} change{preview.pendingFiles.length === 1 ? '' : 's'} on {name}
                </li>
              )}
              <li>
                <b>Push</b> to {preview.remote?.name}/{name} and set upstream tracking
              </li>
              <li>
                <b>Verify</b> the remote points at the same commit — success is only reported then
              </li>
            </ol>
            <label className="check small">
              <input type="checkbox" checked={switchTo || commitPending} disabled={commitPending} onChange={(e) => setSwitchTo(e.target.checked)} /> Switch to {name} afterwards
              {commitPending && <span className="muted"> (needed to commit there)</span>}
            </label>
          </div>
          <BranchAuth repoId={repoId} ctx={preview} remoteUrl={preview.remote?.url ?? null} authKey={authKey} onChange={onAuth} />
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Delete a branch (local and/or remote)
// ---------------------------------------------------------------------------

export function DeleteBranchDialog({ repoId, branch, kind, onClose, onDone }: { repoId: string; branch: string; kind: 'local' | 'remote'; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<BranchDeletePreview | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteLocal, setDeleteLocal] = useState(kind === 'local');
  const [deleteRemote, setDeleteRemote] = useState(kind === 'remote');
  const [force, setForce] = useState(false);
  const [typed, setTyped] = useState('');
  const [sure, setSure] = useState(false);
  const [result, setResult] = useState<BranchDeleteResult | null>(null);
  const { auth, authKey, onAuth, resetAuth } = useAuthState();

  const load = useCallback(async () => {
    setError(null);
    try {
      setPreview(await call('git:deletePreview', { repoId, branch, kind }));
    } catch (err) {
      setPreview(null);
      setError(toFriendly(err));
    }
  }, [repoId, branch, kind]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    if (!preview || !auth.input) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await call('git:deleteExecute', { repoId, confirmationId: preview.confirmationId, auth: auth.input, deleteLocal, deleteRemote, force, confirmed: true }));
    } catch (err) {
      const f = toFriendly(err);
      if (f.code === 'branch-not-merged') setForce(true);
      setError(f);
      if (auth.input.method !== 'ssh') resetAuth();
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Result title="Branch Deleted" ok onDone={onDone}>
        <div className="banner ok">
          <span className="icon">✓</span>
          <div>
            {result.messages.map((m) => (
              <div key={m}>{m}</div>
            ))}
            {result.authDescription && <div className="small">Authentication: {result.authDescription}</div>}
          </div>
        </div>
      </Result>
    );
  }

  const local = preview?.local;
  const remote = preview?.remote;
  const lostCommits = remote && deleteRemote ? (deleteLocal ? remote.uniqueCommitsWithLocal : remote.uniqueCommits) : 0;
  const localUnmerged = !!local && deleteLocal && !local.merged;
  const needsTyping = (localUnmerged && force) || lostCommits > 0;
  const confirmName = local?.name ?? remote?.branch ?? branch;
  const nothing = !deleteLocal && !deleteRemote;
  const blocked = nothing || (deleteLocal && !!local?.current) || (deleteRemote && !!remote?.isDefault) || (localUnmerged && !force) || !sure || (needsTyping && typed !== confirmName);

  return (
    <Modal
      title="Delete Branch"
      icon="⚠"
      onClose={onClose}
      locked={busy}
      size="wide"
      footer={<Footer auth={auth} busy={busy} disabled={!preview || blocked} label="Authenticate & Delete" busyLabel="Deleting…" onCancel={onClose} onRun={run} danger />}
    >
      {error && <ErrorPanel error={error} onAction={(a: ErrorAction) => (a === 'review-auth' ? resetAuth() : a === 'retry' ? void run() : undefined)} available={['review-auth', 'retry']} onSwitched={() => { resetAuth(); void load(); }} />}
      {!preview && !error && <Spinner label="Checking the branch…" />}
      {preview && (
        <div className="grid-2" style={{ gap: 20, alignItems: 'start' }}>
          <div>
            <h3>Branch to delete</h3>
            {local && (
              <label className={`radio-card ${deleteLocal ? 'selected' : ''}`}>
                <input type="checkbox" checked={deleteLocal} disabled={local.current} onChange={(e) => setDeleteLocal(e.target.checked)} />
                <div>
                  <strong>Local branch</strong> <span className="branch-pill">{local.name}</span> <span className="mono small muted">{local.oid.slice(0, 10)}</span>
                  {local.current && <div className="small text-danger">This branch is checked out. Switch to another branch first.</div>}
                  {!local.current && !local.merged && <div className="small text-warn">Has commits that are not merged into the current branch or its upstream.</div>}
                  {local.upstream && <div className="small muted">tracks {local.upstream}</div>}
                </div>
              </label>
            )}
            {remote && (
              <label className={`radio-card ${deleteRemote ? 'selected' : ''}`}>
                <input type="checkbox" checked={deleteRemote} disabled={remote.isDefault} onChange={(e) => setDeleteRemote(e.target.checked)} />
                <div>
                  <strong>Remote branch</strong>{' '}
                  <span className="branch-pill">
                    {remote.name}/{remote.branch}
                  </span>{' '}
                  <span className="small muted">{remote.url}</span>
                  {remote.isDefault && <div className="small text-danger">This is the repository's default branch and cannot be deleted here.</div>}
                  {!remote.oid && <div className="small muted">Not in your last fetch — it may already be gone on the remote.</div>}
                  <div className="small muted">Deleted on the server with the authentication you choose. Protected branches are refused by the server.</div>
                </div>
              </label>
            )}
            {!remote && kind === 'local' && <div className="small muted mb">This branch has no remote counterpart (as of your last fetch). Only the local branch can be deleted.</div>}
            {localUnmerged && (
              <label className="check text-warn">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Force delete — I accept that its unmerged commits may be lost
              </label>
            )}
            {lostCommits > 0 && (
              <div className="banner danger small">
                <span className="icon">⚠</span>
                <div>{lostCommits} commit(s) exist only on what you are deleting and will no longer be on any branch.</div>
              </div>
            )}
            {needsTyping && (
              <div className="field">
                <label>
                  Type <span className="mono">{confirmName}</span> to confirm
                </label>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> Delete{' '}
              {[deleteLocal && local ? `local ${local.name}` : null, deleteRemote && remote ? `${remote.name}/${remote.branch}` : null].filter(Boolean).join(' and ') || 'nothing selected'}
            </label>
            <p className="small muted">Files in your working folder are not changed. The remote branch is deleted first; if the server refuses, nothing local is touched.</p>
          </div>
          <BranchAuth repoId={repoId} ctx={preview} remoteUrl={remote?.url ?? null} authKey={authKey} onChange={onAuth} />
        </div>
      )}
    </Modal>
  );
}
