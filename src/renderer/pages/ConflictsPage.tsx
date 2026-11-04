import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseConflictMarkers, resolveConflicts, type ConflictChoice } from '../../shared/conflicts';
import type { ConflictFile, ConflictOverview, RepoStatus, SwitchSession } from '../../shared/types';
import { KindIcon } from '../components/FileList';
import { Modal, Spinner } from '../components/Modal';
import { CommitDialog } from '../dialogs/CommitDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

type OverviewFile = ConflictOverview['files'][number];

/** Short, readable state of one file in the list. */
function fileState(f: OverviewFile): { label: string; cls: string; help: string } {
  if (f.state === 'resolved') return { label: 'resolved', cls: 'ok', help: 'Marked as resolved. Undo reopens the conflict.' };
  if (f.changed && !f.hasMarkers) return { label: 'ready to mark', cls: 'info', help: 'A version was accepted and no markers remain. Mark it as resolved (or Undo).' };
  if (f.changed) return { label: 'in progress', cls: 'warn', help: 'Some blocks are decided, others still have markers.' };
  return { label: 'conflict', cls: 'danger', help: 'Not decided yet.' };
}

export function ConflictsPage({ status, switchSession = null }: { status: RepoStatus | null; switchSession?: SwitchSession | null }) {
  const { activeRepo, showError, bump, toast, setRepoTab } = useApp();
  const repoId = activeRepo!.id;
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<ConflictFile | null>(null);
  const [editor, setEditor] = useState<string | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [overview, setOverview] = useState<ConflictOverview | null>(null);
  const [bulk, setBulk] = useState<'ours' | 'theirs' | null>(null);
  const [lastAction, setLastAction] = useState<{ path: string; text: string } | null>(null);

  const conflicted = status?.conflicted ?? [];
  const op = status?.operation ?? null;
  // Conflicts from re-applying uncommitted changes after a branch switch (no merge/rebase is running).
  const session = !op ? switchSession : null;
  // The real names behind "current" and "incoming".
  const current = session ? session.to : (overview?.current ?? status?.branch ?? 'current');
  const incoming = session ? `your changes from ${session.from ?? 'detached HEAD'}` : (overview?.incoming ?? 'incoming');
  const labelOurs = (_l?: string) => current;
  const labelTheirs = (_l?: string) => incoming;

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await call('conflict:overview', { repoId }));
    } catch {
      setOverview(null);
    }
  }, [repoId]);

  // Reload names and file states whenever the repository status changes.
  useEffect(() => {
    void loadOverview();
  }, [loadOverview, status]);

  const files = overview?.files ?? conflicted.map((c) => ({ path: c.path, state: 'conflicted' as const, conflictCode: c.conflictCode ?? null, changed: false, hasMarkers: true, canUndo: false }));
  const open = files.filter((f) => f.state === 'conflicted');
  const resolved = files.filter((f) => f.state === 'resolved');
  const selectedInfo = files.find((f) => f.path === selected) ?? null;

  useEffect(() => {
    if (!selected && files.length) setSelected((open[0] ?? files[0]).path);
    if (selected && !files.some((f) => f.path === selected)) setSelected(open[0]?.path ?? files[0]?.path ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, conflicted.length]);

  const loadFile = useCallback(async () => {
    if (!selected || selectedInfo?.state === 'resolved') {
      setFile(null);
      return;
    }
    try {
      setFile(await call('conflict:get', { repoId, path: selected }));
      setEditor(null);
    } catch (err) {
      showError(err);
    }
  }, [repoId, selected, selectedInfo?.state, showError]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  const segments = useMemo(() => (file ? parseConflictMarkers(file.content) : []), [file]);
  const remaining = segments.filter((s) => s.type === 'conflict').length;

  const run = async (fn: () => Promise<unknown>, success?: string, action?: { path: string; text: string }) => {
    setBusy(true);
    try {
      await fn();
      if (success) toast(success);
      if (action) setLastAction(action);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
      bump();
      await loadOverview();
      await loadFile();
    }
  };

  const undo = (path: string) =>
    run(() => call('conflict:undo', { repoId, path }), `${path} is conflicted again — the original conflict was restored`, { path, text: 'Original conflict restored.' }).then(() => setSelected(path));

  const markAll = () =>
    run(async () => {
      const r = await call('conflict:markAllResolved', { repoId });
      toast(r.remaining.length ? `${r.resolved.length} marked resolved; ${r.remaining.length} still contain conflict markers` : `${r.resolved.length} file(s) marked resolved`, r.remaining.length ? 'warning' : 'success');
    });
  const markable = open.filter((f) => !f.hasMarkers);

  const applyChoice = (choice: Record<number, ConflictChoice> | ConflictChoice) => {
    const what = typeof choice === 'string' ? 'Kept both versions in every block.' : `Block ${Number(Object.keys(choice)[0]) + 1}: ${Object.values(choice)[0] === 'ours' ? `kept ${current}` : Object.values(choice)[0] === 'theirs' ? `took ${incoming}` : 'kept both'}.`;
    return run(() => call('conflict:write', { repoId, path: file!.path, content: resolveConflicts(file!.content, choice) }), undefined, { path: file!.path, text: what });
  };

  if (!status) return <div className="content"><Spinner /></div>;

  if (!op && conflicted.length === 0 && !session && resolved.length === 0) {
    return (
      <div className="content">
        <div className="empty">
          ✓ No merge or rebase in progress and no conflicts.{' '}
          <button className="btn sm" onClick={() => setRepoTab('changes')}>
            Back to changes
          </button>
        </div>
      </div>
    );
  }

  const opLabel = op ?? 'operation';

  return (
    <div className="content flush">
      <div className="split">
        <div className="left">
          {session ? (
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
              <h3>Bringing your changes to {session.to}</h3>
              <p className="small muted">
                {conflicted.length > 0
                  ? `Your changes from ${session.from ?? 'detached HEAD'} overlap with ${session.to} in ${conflicted.length} file(s). Decide block by block, then mark each file resolved.`
                  : 'All conflicts are resolved. Finish to keep the result as normal uncommitted changes.'}
              </p>
              <p className="small muted">
                {session.stashExists ? '🛟 Your original changes are kept in a backup stash until you finish, so Undo is always possible.' : '⚠ The backup stash no longer exists — Undo is not available.'}
              </p>
              <div className="row">
                <button className="btn primary" disabled={conflicted.length > 0 || busy} onClick={() => setFinishOpen(true)}>
                  Finish…
                </button>
                <button className="btn" disabled={busy || !session.stashExists} onClick={() => setUndoOpen(true)}>
                  Undo…
                </button>
              </div>
            </div>
          ) : op ? (
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
              <h3>{opLabel.charAt(0).toUpperCase() + opLabel.slice(1)} in progress</h3>
              <p className="small muted">
                {conflicted.length > 0
                  ? `${conflicted.length} file(s) need your decision. Nothing is overwritten automatically.`
                  : 'All conflicts are resolved. Continue to finish, or abort to restore the previous state.'}
              </p>
              <div className="row">
                <button className="btn primary" disabled={conflicted.length > 0 || busy} onClick={() => setContinueOpen(true)}>
                  Continue {opLabel}…
                </button>
                <button className="btn danger" disabled={busy} onClick={() => setConfirmAbort(true)}>
                  Abort {opLabel}…
                </button>
              </div>
            </div>
          ) : (
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
              <h3>Conflicted files</h3>
              <p className="small muted">These conflicts came from applying a stash. Resolve each file and mark it resolved; the stash itself is kept until you drop it.</p>
            </div>
          )}
          <div className="sides-bar">
            <span className="side-chip ours" title="Current: what your working branch had">
              <span className="dot-ours" /> Current <strong>{current}</strong>
            </span>
            <span className="muted">⇄</span>
            <span className="side-chip theirs" title="Incoming: what is being brought in">
              <span className="dot-theirs" /> Incoming <strong>{incoming}</strong>
            </span>
          </div>

          {open.length > 0 && (
            <div className="bulk-bar">
              <div className="small muted mb">All {open.length} unresolved file(s) at once:</div>
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="btn sm theirs-btn" disabled={busy} onClick={() => setBulk('theirs')} title={`Use ${incoming}'s version of every conflicted file`}>
                  ⬇ Accept all incoming ({incoming})
                </button>
                <button className="btn sm ours-btn" disabled={busy} onClick={() => setBulk('ours')} title={`Keep ${current}'s version of every conflicted file`}>
                  ⬆ Keep all current ({current})
                </button>
                <button className="btn sm" disabled={busy || markable.length === 0} onClick={markAll} title="Mark every file without conflict markers as resolved">
                  ✓ Mark {markable.length || 'all'} resolved
                </button>
              </div>
            </div>
          )}

          <div className="file-section">
            <div className="file-section-header">
              Unresolved <span className={`badge ${open.length ? 'danger' : 'ok'}`}>{open.length}</span>
            </div>
            {open.length === 0 && <div className="small muted" style={{ padding: '6px 12px' }}>Nothing left to decide.</div>}
            {open.map((f) => {
              const s = fileState(f);
              return (
                <div key={f.path} className={`file-row ${selected === f.path ? 'selected' : ''}`} onClick={() => setSelected(f.path)} title={s.help}>
                  <KindIcon kind="conflicted" />
                  <span className="path mono">
                    <bdi>{f.path}</bdi>
                  </span>
                  <span className={`badge ${s.cls}`}>{s.label}</span>
                  {f.changed && f.canUndo && (
                    <button
                      className="btn sm ghost icon-btn"
                      title="Undo: restore the original conflict"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void undo(f.path);
                      }}
                    >
                      ↶
                    </button>
                  )}
                </div>
              );
            })}
            {resolved.length > 0 && (
              <>
                <div className="file-section-header">
                  Resolved <span className="badge ok">{resolved.length}</span>
                </div>
                {resolved.map((f) => (
                  <div key={f.path} className={`file-row ${selected === f.path ? 'selected' : ''}`} onClick={() => setSelected(f.path)}>
                    <span className="text-ok">✓</span>
                    <span className="path mono">
                      <bdi>{f.path}</bdi>
                    </span>
                    <button
                      className="btn sm ghost"
                      title="Undo: reopen this conflict exactly as it was"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void undo(f.path);
                      }}
                    >
                      ↶ Undo
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="right" style={{ padding: 16 }}>
          {selectedInfo?.state === 'resolved' && (
            <div className="card">
              <div className="row mb">
                <h2 className="grow mono" style={{ margin: 0 }}>
                  {selectedInfo.path}
                </h2>
                <span className="badge ok">✓ resolved</span>
              </div>
              <p className="small">This file is marked as resolved and will be part of the result. Changed your mind? Undo reopens the conflict exactly as it was — markers and both versions included.</p>
              <button className="btn" disabled={busy} onClick={() => undo(selectedInfo.path)}>
                ↶ Undo — reopen this conflict
              </button>
            </div>
          )}
          {!file && open.length > 0 && selectedInfo?.state !== 'resolved' && <Spinner />}
          {file && (
            <>
              <div className="row mb">
                <h2 className="grow mono" style={{ margin: 0 }}>
                  {file.path}
                </h2>
                <span className={`badge ${remaining ? 'danger' : 'ok'}`}>{remaining ? `${remaining} conflict block(s) left` : 'no markers left'}</span>
              </div>
              <div className="card">
                <dl className="kv">
                  <dt>Conflict reason</dt>
                  <dd>{file.explanation}</dd>
                  <dt>
                    <span className="dot-ours" /> Current
                  </dt>
                  <dd>
                    <strong>{current}</strong>
                  </dd>
                  <dt>
                    <span className="dot-theirs" /> Incoming
                  </dt>
                  <dd>
                    <strong>{incoming}</strong>
                  </dd>
                </dl>
              </div>

              {lastAction?.path === file.path && selectedInfo?.changed && (
                <div className="banner info small">
                  <span className="icon">✎</span>
                  <div className="grow">
                    {lastAction.text} {remaining === 0 ? 'No conflict markers remain — mark it as resolved, or undo.' : `${remaining} block(s) still to decide.`}
                  </div>
                  {selectedInfo.canUndo && (
                    <button className="btn sm" disabled={busy} onClick={() => undo(file.path)}>
                      ↶ Undo
                    </button>
                  )}
                  {remaining === 0 && (
                    <button className="btn sm primary" disabled={busy} onClick={() => run(() => call('conflict:markResolved', { repoId, path: file.path }), `${file.path} marked as resolved`)}>
                      ✓ Mark as resolved
                    </button>
                  )}
                </div>
              )}

              <div className="row wrap mb">
                <button
                  className="btn ours-btn"
                  disabled={busy}
                  onClick={() => run(() => call('conflict:takeSide', { repoId, path: file.path, side: 'ours' }), `Kept ${current}'s version of ${file.path}`, { path: file.path, text: `Kept ${current}'s version.` })}
                >
                  ⬆ Accept current ({current})
                </button>
                <button
                  className="btn theirs-btn"
                  disabled={busy}
                  onClick={() => run(() => call('conflict:takeSide', { repoId, path: file.path, side: 'theirs' }), `Took ${incoming}'s version of ${file.path}`, { path: file.path, text: `Took ${incoming}'s version.` })}
                >
                  ⬇ Accept incoming ({incoming})
                </button>
                {file.hasMarkers && (
                  <button className="btn" disabled={busy} onClick={() => applyChoice('both')}>
                    Accept both (all blocks)
                  </button>
                )}
                <button className="btn" disabled={busy || file.binary} onClick={() => setEditor(file.content)}>
                  Open manual editor
                </button>
                {selectedInfo?.changed && selectedInfo.canUndo && (
                  <button className="btn ghost" disabled={busy} onClick={() => undo(file.path)} title="Restore the original conflict of this file">
                    ↶ Undo changes
                  </button>
                )}
                <span className="spacer" />
                <button className="btn primary" disabled={busy || remaining > 0} title={remaining > 0 ? 'Decide every conflict block first' : ''} onClick={() => run(() => call('conflict:markResolved', { repoId, path: file.path }), `${file.path} marked as resolved`)}>
                  ✓ Mark as resolved
                </button>
              </div>

              {file.binary && <div className="banner warn">Binary file — choose the current or incoming version.</div>}
              {!file.binary && !file.hasMarkers && editor === null && !selectedInfo?.changed && (
                <div className="banner info">
                  <span className="icon">ℹ</span>
                  <div>This file has no conflict markers ({file.conflictCode}: e.g. deleted on one side). Choose a whole-file action, or edit it, then mark it as resolved.</div>
                </div>
              )}

              {editor !== null ? (
                <div className="card">
                  <h3>Manual editor</h3>
                  <p className="small muted">Edit the final content. Remove every conflict marker line (&lt;&lt;&lt;&lt;&lt;&lt;&lt;, =======, &gt;&gt;&gt;&gt;&gt;&gt;&gt;) before saving.</p>
                  <textarea className="code" rows={22} value={editor} onChange={(e) => setEditor(e.target.value)} spellCheck={false} />
                  <div className="row mt">
                    <button className="btn" onClick={() => setEditor(null)}>
                      Cancel
                    </button>
                    <button className="btn primary" disabled={busy} onClick={() => run(() => call('conflict:write', { repoId, path: file.path, content: editor }), 'Saved')}>
                      Save file
                    </button>
                  </div>
                </div>
              ) : (
                segments.map((seg, i) =>
                  seg.type === 'common' ? (
                    <div key={i} className="common-text">
                      {seg.text.length > 600 ? `${seg.text.slice(0, 300)}\n…\n${seg.text.slice(-300)}` : seg.text}
                    </div>
                  ) : (
                    <div key={i} className="conflict-block">
                      <div className="sides">
                        <div className="side ours">
                          <div className="side-label">Current · {labelOurs(seg.oursLabel)}</div>
                          {seg.ours || <span className="muted">(empty)</span>}
                        </div>
                        <div className="side theirs">
                          <div className="side-label">Incoming · {labelTheirs(seg.theirsLabel)}</div>
                          {seg.theirs || <span className="muted">(empty)</span>}
                        </div>
                      </div>
                      <div className="actions">
                        <span className="small muted grow">Conflict {seg.index + 1}</span>
                        <button className="btn sm ours-btn" disabled={busy} onClick={() => applyChoice({ [seg.index]: 'ours' })}>
                          Accept current ({current})
                        </button>
                        <button className="btn sm theirs-btn" disabled={busy} onClick={() => applyChoice({ [seg.index]: 'theirs' })}>
                          Accept incoming ({incoming})
                        </button>
                        <button className="btn sm" disabled={busy} onClick={() => applyChoice({ [seg.index]: 'both' })}>
                          Accept both
                        </button>
                      </div>
                    </div>
                  ),
                )
              )}
            </>
          )}
          {!file && conflicted.length === 0 && (
            <div className="empty">
              All files are resolved. Click <strong>{session ? 'Finish' : `Continue ${opLabel}`}</strong> to finish.
            </div>
          )}
        </div>
      </div>

      {confirmAbort && (
        <ConfirmDialog
          title={`Abort ${opLabel}`}
          explanation={<>Stops the {opLabel} and restores your branch and files to exactly how they were before it started.</>}
          impact={<>Any conflict resolutions you made during this {opLabel} are discarded. Commits that existed before are not affected.</>}
          affected={conflicted.map((c) => c.path)}
          confirmLabel={`Abort ${opLabel}`}
          danger
          onCancel={() => setConfirmAbort(false)}
          onConfirm={async () => {
            try {
              await call('conflict:abort', { repoId, confirmed: true });
              toast(`${opLabel} aborted — repository restored`, 'info');
              setRepoTab('changes');
            } catch (err) {
              showError(err);
            }
            setConfirmAbort(false);
            bump();
          }}
        />
      )}
      {bulk && (
        <BulkAcceptDialog
          side={bulk}
          name={bulk === 'theirs' ? incoming : current}
          files={open.map((f) => f.path)}
          onClose={() => setBulk(null)}
          onConfirm={(markResolved) => {
            const side = bulk;
            setBulk(null);
            void run(async () => {
              const r = await call('conflict:takeSideAll', { repoId, side, markResolved, confirmed: true });
              const who = side === 'theirs' ? incoming : current;
              if (r.skipped.length) toast(`${r.changed.length} file(s) now use ${who}'s version; ${r.skipped.length} could not be changed (${r.skipped[0].path}: ${r.skipped[0].reason})`, 'warning');
              else toast(`${r.changed.length} file(s) now use ${who}'s version${markResolved ? ' and are marked resolved' : ''}. Undo is available per file.`);
            });
          }}
        />
      )}
      {finishOpen && session && <FinishSwitchDialog repoId={repoId} session={session} onClose={() => setFinishOpen(false)} />}
      {undoOpen && session && <UndoSwitchDialog repoId={repoId} session={session} onClose={() => setUndoOpen(false)} />}
      {continueOpen && (
        <CommitDialog
          repoId={repoId}
          mode="continue"
          onClose={() => setContinueOpen(false)}
          onDone={() => {
            setContinueOpen(false);
            toast(`${opLabel} completed`);
            bump();
            setRepoTab('changes');
          }}
        />
      )}
    </div>
  );
}

function BulkAcceptDialog({ side, name, files, onClose, onConfirm }: { side: 'ours' | 'theirs'; name: string; files: string[]; onClose: () => void; onConfirm: (markResolved: boolean) => void }) {
  const [markResolved, setMarkResolved] = useState(true);
  return (
    <Modal
      title={side === 'theirs' ? `Accept All Incoming (${name})` : `Keep All Current (${name})`}
      icon={side === 'theirs' ? '⬇' : '⬆'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn primary ${side === 'theirs' ? 'theirs-btn' : 'ours-btn'}`} onClick={() => onConfirm(markResolved)}>
            Use {name} for {files.length} file(s)
          </button>
        </>
      }
    >
      <p>
        Every unresolved file below gets <strong>{name}</strong>'s complete version. The other side's changes in these files are dropped{side === 'theirs' ? '' : ' from the result'}.
      </p>
      <div className="card small mono" style={{ maxHeight: 180, overflow: 'auto' }}>
        {files.map((f) => (
          <div key={f}>{f}</div>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={markResolved} onChange={(e) => setMarkResolved(e.target.checked)} /> Also mark them as resolved
      </label>
      <p className="small muted">Nothing is committed yet. Each file keeps an Undo (↶) that restores its original conflict, even after it was marked resolved.</p>
    </Modal>
  );
}

function FinishSwitchDialog({ repoId, session, onClose }: { repoId: string; session: SwitchSession; onClose: () => void }) {
  const { showError, toast, bump, setRepoTab } = useApp();
  const [dropBackup, setDropBackup] = useState(true);
  const [busy, setBusy] = useState(false);
  const finish = async () => {
    setBusy(true);
    try {
      const r = await call('git:switchFinish', { repoId, dropBackup });
      toast(`Done — your changes are now uncommitted changes on ${session.to}${r.droppedBackup ? '' : ' (backup stash kept)'}`);
      onClose();
      bump();
      setRepoTab('changes');
    } catch (err) {
      showError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Finish Bringing Your Changes"
      size="narrow"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={finish} disabled={busy}>
            {busy ? 'Finishing…' : 'Finish'}
          </button>
        </>
      }
    >
      <p>
        Your resolved files stay on <strong>{session.to}</strong> as ordinary uncommitted changes (nothing is committed). Review them in the Changes tab and commit when ready.
      </p>
      <label className="check">
        <input type="checkbox" checked={dropBackup} onChange={(e) => setDropBackup(e.target.checked)} /> Delete the backup stash of the original changes
      </label>
      {!dropBackup && <p className="small muted">The backup stays in Branches & Stash until you drop it.</p>}
    </Modal>
  );
}

function UndoSwitchDialog({ repoId, session, onClose }: { repoId: string; session: SwitchSession; onClose: () => void }) {
  const { showError, toast, bump, setRepoTab } = useApp();
  const [returnToSource, setReturnToSource] = useState(!!session.from);
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      const r = await call('git:switchUndo', { repoId, returnToSource, confirmed: true });
      toast(r.message, r.restored ? 'success' : 'warning');
      onClose();
      bump();
      setRepoTab(r.restored ? 'changes' : 'conflicts');
    } catch (err) {
      showError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Undo Bringing Your Changes"
      icon="↩"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={undo} disabled={busy}>
            {busy ? 'Undoing…' : 'Undo'}
          </button>
        </>
      }
    >
      <p>
        The partly merged files on <strong>{session.to}</strong> are discarded — including any resolutions you made here. Your <strong>original changes are safe</strong> in the backup stash.
      </p>
      {session.from && (
        <label className={`radio-card ${returnToSource ? 'selected' : ''}`}>
          <input type="radio" checked={returnToSource} onChange={() => setReturnToSource(true)} />
          <div>
            <strong>Go back to {session.from} with my changes</strong>
            <div className="small muted">Switches back and restores your changes exactly as they were before the switch.</div>
          </div>
        </label>
      )}
      <label className={`radio-card ${!returnToSource ? 'selected' : ''}`}>
        <input type="radio" checked={!returnToSource} onChange={() => setReturnToSource(false)} />
        <div>
          <strong>Stay on {session.to} with a clean working tree</strong>
          <div className="small muted">Your changes remain in the stash; apply or pop them later from Branches & Stash.</div>
        </div>
      </label>
    </Modal>
  );
}
