import { useEffect, useState } from 'react';
import type { CommitInfo, ResetPreview } from '../../../shared/types';
import { relative } from '../../components/FileDiffList';
import { Modal } from '../../components/Modal';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';
import { authorColor, initials } from '../history/graphStyle';

interface Undone {
  /** Branch tip before the undo — redo moves the branch back here. */
  previousOid: string;
  count: number;
  subjects: string[];
}

interface Props {
  repoId: string;
  /** Outgoing commits, newest first (the commits the push would send). */
  commits: CommitInfo[];
  disabled?: boolean;
  onChanged: () => void;
}

const REDO_KEY = (repoId: string) => `gb.undo.${repoId}`;
export const DRAFT_EVENT = 'gb:draft-restored';

/** Puts a message into the Changes composer draft (only if the draft is empty). */
function restoreDraft(repoId: string, msg: string): boolean {
  try {
    const key = `gb.draft.${repoId}`;
    if ((localStorage.getItem(key) ?? '').trim()) return false;
    localStorage.setItem(key, msg);
  } catch {
    return false;
  }
  window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: { repoId, message: msg } }));
  return true;
}

/**
 * Outgoing commits as a stack you can unwind before pushing: undo the last commit (or several at once)
 * and get their changes back as staged files with the message restored in Changes — then redo if you
 * change your mind. Nothing is pushed; a backup of the branch tip is always kept.
 */
export function UndoCommits({ repoId, commits, disabled, onChanged }: Props) {
  const { toast, showError } = useApp();
  const [hover, setHover] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ upto: number; preview: ResetPreview } | null>(null);
  const [stack, setStack] = useState<Undone[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(REDO_KEY(repoId)) ?? '[]') as Undone[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(REDO_KEY(repoId), JSON.stringify(stack));
    } catch {
      /* redo is a convenience for this window */
    }
  }, [stack, repoId]);

  // Undoing commits 0..upto moves the branch to the parent of commit `upto`.
  const start = async (upto: number) => {
    setBusy(true);
    try {
      const d = await call('graph:commit', { repoId, hash: commits[upto].hash });
      const target = d.parents[0];
      if (!target) return toast('The first commit of a repository cannot be undone', 'warning');
      const preview = await call('history:resetPreview', { repoId, hash: target });
      const pushed = preview.leaving.filter((c) => !preview.unpushed.includes(c.hash));
      if (pushed.length || preview.operation) setAsk({ upto, preview });
      else await undo(upto, preview);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (upto: number, preview: ResetPreview) => {
    setBusy(true);
    try {
      const undone = commits.slice(0, upto + 1);
      const details = await Promise.all(undone.map((c) => call('graph:commit', { repoId, hash: c.hash })));
      const r = await call('history:reset', { repoId, hash: preview.target, mode: 'soft', expectedHead: preview.headOid, confirmed: true });
      const msg =
        details.length === 1
          ? details[0].body
            ? `${details[0].subject}\n\n${details[0].body}`
            : details[0].subject
          : `${details[details.length - 1].subject}\n\n${details
              .slice()
              .reverse()
              .map((d) => `- ${d.subject}`)
              .join('\n')}`;
      const restored = restoreDraft(repoId, msg);
      setStack((s) => [...s, { previousOid: r.previousOid, count: undone.length, subjects: undone.map((c) => c.subject) }]);
      toast(`${undone.length === 1 ? 'Commit' : `${undone.length} commits`} undone — changes are back in Staged${restored ? ', message restored in Changes' : ''}`);
      setAsk(null);
      onChanged();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const redo = async () => {
    const last = stack[stack.length - 1];
    if (!last) return;
    setBusy(true);
    try {
      await call('history:undoReset', { repoId, previousOid: last.previousOid, mode: 'soft', wipRef: null, confirmed: true });
      setStack((s) => s.slice(0, -1));
      toast(`Redone: ${last.count === 1 ? last.subjects[0] : `${last.count} commits`} restored`);
      onChanged();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const last = stack[stack.length - 1];
  const off = busy || disabled;
  const shown = commits.slice(0, 12);

  return (
    <div className="uc">
      {last && (
        <div className="uc-snack" role="status">
          <span className="uc-snack-ico">↶</span>
          <span className="grow ellipsis" title={last.subjects.join('\n')}>
            Undid {last.count === 1 ? <strong>{last.subjects[0]}</strong> : <strong>{last.count} commits</strong>} — changes are back in Staged
          </span>
          <button className="uc-snack-btn" disabled={off} onClick={redo} title="Put the commit(s) back exactly as they were">
            ↷ Redo
          </button>
        </div>
      )}
      <div className="uc-list" onMouseLeave={() => setHover(null)}>
        {commits.length === 0 && (
          <div className="uc-empty">
            <span>✓</span>
            <div>
              <strong>No commits to push</strong>
              <div className="small muted">{last ? 'Redo above, or commit your staged changes again.' : 'Everything on this branch is already on the remote.'}</div>
            </div>
          </div>
        )}
        {shown.map((c, i) => {
          const covered = hover !== null && i <= hover;
          return (
            <div key={c.hash} className={`uc-row ${covered ? 'covered' : ''} ${i === 0 ? 'tip' : ''}`} onMouseEnter={() => setHover(i)}>
              <span className="uc-rail" />
              <span className="uc-avatar" style={{ background: authorColor(c.email || c.author) }} title={c.author}>
                {initials(c.author)}
              </span>
              <div className="uc-text">
                <div className="ellipsis uc-subject" title={c.subject}>
                  {c.subject}
                </div>
                <div className="uc-meta">
                  <span className="mono">{c.shortHash}</span>
                  <span>{c.author}</span>
                  <span>{relative(c.date)}</span>
                  {i === 0 && <span className="uc-latest">latest</span>}
                </div>
              </div>
              <button
                className="uc-undo"
                disabled={off}
                title={i === 0 ? 'Undo this commit — its changes go back to Staged, the message back to the composer' : `Undo the newest ${i + 1} commits — their changes go back to Staged so you can recommit them as one`}
                onClick={() => void start(i)}
              >
                ↶ {i === 0 ? 'Undo' : `Undo ${i + 1}`}
              </button>
            </div>
          );
        })}
        {commits.length > 12 && <div className="uc-more small muted">…and {commits.length - 12} older commit{commits.length - 12 === 1 ? '' : 's'}</div>}
      </div>
      {commits.length > 0 && (
        <div className="uc-tip small muted">
          {hover !== null && hover > 0 ? (
            <>
              <strong className="text-warn">{hover + 1} commits</strong> would be undone together — nothing is lost, and you can redo.
            </>
          ) : (
            <>Hover a commit to undo it before pushing. Changes return to Staged · always redoable.</>
          )}
        </div>
      )}

      {ask && (
        <Modal
          title="These Commits Were Already Pushed"
          icon="⚠"
          onClose={() => setAsk(null)}
          locked={busy}
          footer={
            <>
              <button className="btn" onClick={() => setAsk(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy || !!ask.preview.operation} onClick={() => void undo(ask.upto, ask.preview)}>
                Undo anyway
              </button>
            </>
          }
        >
          {ask.preview.operation ? (
            <div className="banner danger small">A {ask.preview.operation} is in progress. Finish or abort it first.</div>
          ) : (
            <p>
              {ask.preview.leaving.length - ask.preview.unpushed.length} of these commit(s) already exist on a remote branch. Undoing them rewrites history there would need a force push. Prefer “Revert” in Git History for
              shared commits.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
