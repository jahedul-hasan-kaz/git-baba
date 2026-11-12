import { useEffect, useMemo, useState } from 'react';
import type { FileDiff, FriendlyError, TransplantPreview, TransplantResult } from '../../shared/types';
import { PickChanges, toSelection, type Picks } from './PickChanges';
import { ErrorPanel } from '../components/ErrorPanel';
import { relative } from '../components/FileDiffList';
import { Modal, Spinner } from '../components/Modal';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';

interface Props {
  repoId: string;
  source: string;
  /** The branch `source` was made from; its commits are left out. */
  base: string;
  target: string;
  localTargets: string[];
  queue?: { index: number; total: number };
  /** Start in "pick files & lines" with this selection (from the Merge Studio preview). */
  initialPicks?: Picks;
  /** Tip of `source` the selection was made on; if the branch moved since, the selection is discarded. */
  initialPicksHead?: string | null;
  /** Start in "whole commits" with only these commits ticked (from the Merge Studio preview). */
  initialCommits?: string[];
  /** Tip of `source` when the commits were chosen; if it moved, the choice is discarded. */
  initialCommitsHead?: string | null;
  onClose: () => void;
  onDone: (r: TransplantResult | null) => void;
}

/**
 * "Only this branch's changes": replays just the commits `source` added on top of `base` onto `target`,
 * so the rest of `base` (e.g. everything still in QA) does not come along.
 */
export function TransplantDialog({ repoId, source, base, target, localTargets, queue, initialPicks, initialPicksHead, initialCommits, initialCommitsHead, onClose, onDone }: Props) {
  const { setRepoTab, setPrDraft } = useApp();
  const [p, setP] = useState<TransplantPreview | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [into, setInto] = useState<'new-branch' | 'target'>('new-branch');
  const [name, setName] = useState('');
  const [back, setBack] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openFiles, setOpenFiles] = useState<string | null>(null);
  const [result, setResult] = useState<TransplantResult | null>(null);
  const canDirect = localTargets.includes(target);
  const [mode, setMode] = useState<'commits' | 'pick'>(initialPicks ? 'pick' : 'commits');
  const [picks, setPicks] = useState<Picks>(() => initialPicks ?? new Map());
  const sameBase = base === target;
  /** Set when the selection came from the Merge Studio: only those files / lines may be applied. */
  const locked = !!initialPicks || !!initialCommits;
  const [stale, setStale] = useState(false);
  const [pickDiffs, setPickDiffs] = useState<Map<string, FileDiff>>(new Map());
  const [message, setMessage] = useState('');

  useEffect(() => {
    call('git:transplantPreview', { repoId, source, base, target })
      .then((x) => {
        setP(x);
        if (initialCommits) {
          // Keep exactly the commits chosen in the Merge Studio — unless the branch moved since.
          if (initialCommitsHead !== undefined && initialCommitsHead !== x.sourceOid) {
            setPick(new Set());
            setStale(true);
          } else setPick(new Set(x.commits.filter((c) => initialCommits.includes(c.hash)).map((c) => c.hash)));
        } else setPick(new Set(x.commits.filter((c) => !c.alreadyInTarget).map((c) => c.hash)));
        setName(x.suggestedBranch);
      })
      .catch((e) => setError(toFriendly(e)));
  }, [repoId, source, base, target]);

  const chosen = useMemo(() => (p ? p.commits.filter((c) => pick.has(c.hash)) : []), [p, pick]);
  const files = useMemo(() => [...new Set(chosen.flatMap((c) => c.files))], [chosen]);
  const nameOk = into === 'target' || /^[A-Za-z0-9._/-]+$/.test(name.trim());
  const pickSel = useMemo(() => toSelection(picks, pickDiffs), [picks, pickDiffs]);
  const defaultMsg = `Bring ${pickSel.length === 1 ? pickSel[0].path.split('/').pop() : `${pickSel.length} files`} from ${source}`;
  const blocked = !p || !!p.operation || p.dirty > 0 || !nameOk || (mode === 'commits' ? chosen.length === 0 : pickSel.length === 0);

  const run = async () => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'pick') {
        setResult(
          await call('git:transplantPick', {
            repoId,
            source,
            base,
            target,
            into,
            newBranch: into === 'new-branch' ? name.trim() : undefined,
            expectedTarget: p.targetOid,
            returnToCurrent: back,
            message: message.trim() || defaultMsg,
            selection: pickSel,
            confirmed: true,
          }),
        );
        return;
      }
      const r = await call('git:transplant', {
        repoId,
        target,
        commits: chosen.map((c) => c.hash), // oldest first
        into,
        newBranch: into === 'new-branch' ? name.trim() : undefined,
        expectedTarget: p.targetOid,
        returnToCurrent: back,
        confirmed: true,
      });
      setResult(r);
    } catch (e) {
      setError(toFriendly(e));
    } finally {
      setBusy(false);
    }
  };

  const title = `${queue ? `Step ${queue.index + 1} of ${queue.total} · ` : ''}${initialPicks ? `Selected changes of ${source}` : initialCommits ? `Selected commits of ${source}` : `Only ${source}’s changes`} → ${target}`;

  if (result) {
    const ok = result.outcome === 'done';
    return (
      <Modal title={ok ? 'Changes Brought Over' : 'Stopped on a Conflict'} icon={ok ? '🎯' : '⚠'} onClose={() => onDone(result)} footer={<button className="btn primary" onClick={() => onDone(result)}>Done</button>}>
        <div className={`banner ${ok ? 'ok' : 'warn'}`}>
          <span className="icon">{ok ? '✓' : '⚠'}</span>
          <div className="grow">
            <strong>{result.message}</strong>
            {result.newOid && (
              <div className="small mono">
                {result.branch} is now at {result.newOid.slice(0, 10)}
              </div>
            )}
            {result.returnedTo && <div className="small">You are back on {result.returnedTo}.</div>}
            {result.backupRef && <div className="small muted">Previous tip of {target} saved as {result.backupRef.replace('refs/gitbaba/backups/', '')}.</div>}
          </div>
        </div>
        {!ok && (
          <button
            className="btn primary mt"
            onClick={() => {
              onDone(result);
              setRepoTab('conflicts');
            }}
          >
            Resolve conflicts now
          </button>
        )}
        {ok && into === 'new-branch' && (
          <div className="tp-next">
            <div className="small muted">Next: publish {result.branch} with ⬆ Push, then open a pull request into {target.replace(/^origin\//, '')}.</div>
            <button
              className="btn"
              onClick={() => {
                setPrDraft({ base: target.replace(/^origin\//, ''), head: result.branch });
                onDone(result);
                setRepoTab('pulls');
              }}
            >
              ⇄ Prepare pull request
            </button>
          </div>
        )}
        {ok && into === 'target' && <p className="small muted">Nothing was pushed. Review {target} in Git History, then publish it with ⬆ Push.</p>}
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      icon="🎯"
      size="wide"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <span className="small muted grow">
            {mode === 'pick'
              ? pickSel.length
                ? `${pickSel.length} file(s) — committed as one new commit`
                : 'Tick files or pick lines to bring over'
              : chosen.length
                ? `${chosen.length} commit(s) · ${files.length} file(s) — cherry-picked with “(cherry picked from …)” notes`
                : 'Choose at least one commit'}
          </span>
          <button className="btn cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={blocked || busy} onClick={run}>
            {busy
              ? 'Bringing over…'
              : mode === 'pick'
                ? `Bring selected changes into ${into === 'new-branch' ? name.trim() || 'new branch' : target}`
                : `Bring ${chosen.length} commit${chosen.length === 1 ? '' : 's'} into ${into === 'new-branch' ? name.trim() || 'new branch' : target}`}
          </button>
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      {!p && !error && <Spinner label={`Finding what ${source} changed on top of ${base}…`} />}
      {p && (
        <>
          <div className="tp-map">
            <div className="tp-node base">
              <div className="small muted">left out</div>
              <strong className="mono ellipsis">⎇ {base}</strong>
              <div className="tp-count bad">{sameBase ? 'the target itself' : `⛔ ${p.leftBehind} commit${p.leftBehind === 1 ? '' : 's'} stay out`}</div>
            </div>
            <div className="tp-edge cut" aria-hidden>
              ✂
            </div>
            <div className="tp-node own">
              <div className="small muted">only these</div>
              <strong className="mono ellipsis">⎇ {source}</strong>
              <div className="tp-count good">
                {mode === 'pick' ? `✂ ${pickSel.length} file${pickSel.length === 1 ? '' : 's'} picked` : `✓ ${chosen.length} of ${p.commits.length} own commit${p.commits.length === 1 ? '' : 's'}`}
              </div>
            </div>
            <div className="tp-edge" aria-hidden>
              ➜
            </div>
            <div className="tp-node target">
              <div className="small muted">into</div>
              <strong className="mono ellipsis">⎇ {into === 'new-branch' ? name || 'new branch' : target}</strong>
              <div className="small muted">{into === 'new-branch' ? `new, from ${target}` : 'directly'}</div>
            </div>
          </div>

          {locked ? (
            <div className="banner info small">
              <span className="icon">✂</span>
              <div>
                {initialCommits
                  ? `Only the commits you ticked in the Merge Studio are brought into ${target}. Adjust the ticks below if needed — anything unticked stays out.`
                  : `Only the files and lines you ticked in the Merge Studio are brought into ${target}, as one new commit. Adjust the selection below if needed — anything unticked stays out.`}
              </div>
            </div>
          ) : (
          <div className="tp-modes">
            <button className={`tp-mode ${mode === 'commits' ? 'on' : ''}`} onClick={() => setMode('commits')}>
              <strong>🧩 Whole commits</strong>
              <span className="small muted">Replay {source}’s commits as they are</span>
            </button>
            <button className={`tp-mode ${mode === 'pick' ? 'on' : ''}`} onClick={() => setMode('pick')}>
              <strong>✂ Pick files &amp; lines</strong>
              <span className="small muted">Take only the files — or the lines — you choose, as one new commit</span>
            </button>
          </div>
          )}
          {stale && <div className="banner warn small">⚠ {source} changed since you made your selection, so it was cleared to avoid applying the wrong changes. Choose again.</div>}
          {p.operation && <div className="banner danger small">A {p.operation} is in progress. Finish or abort it first.</div>}
          {p.dirty > 0 && <div className="banner danger small">You have {p.dirty} uncommitted change(s). Commit or stash them first — this needs to switch branches.</div>}
          {p.commits.length === 0 && <div className="banner info small">{source} has no commits of its own on top of {base}.</div>}
          {p.mergesSkipped > 0 && <div className="banner warn small">{p.mergesSkipped} merge commit(s) on {source} are skipped; only regular commits are replayed.</div>}

          {mode === 'pick' && <PickChanges
              repoId={repoId}
              source={source}
              base={base}
              picks={picks}
              setPicks={setPicks}
              onLoaded={(m, _files, head) => {
                setPickDiffs(m);
                if (locked && initialPicksHead !== undefined && head !== initialPicksHead) {
                  setPicks(() => new Map());
                  setStale(true);
                }
              }}
            />}
          <div className={mode === 'pick' ? 'tp-dest-row' : 'grid-2'} style={{ gap: 16, alignItems: 'start' }}>
            {mode === 'commits' && (
            <div>
              <div className="row">
                <h4 className="grow" style={{ margin: 0 }}>
                  {source}’s own commits
                </h4>
                {p.commits.length > 1 && (
                  <button className="btn sm ghost" onClick={() => setPick(new Set(pick.size === p.commits.length ? [] : p.commits.map((c) => c.hash)))}>
                    {pick.size === p.commits.length ? 'None' : 'All'}
                  </button>
                )}
              </div>
              <div className="tp-commits">
                {p.commits.map((c, i) => (
                  <div key={c.hash} className={`tp-commit ${pick.has(c.hash) ? 'on' : ''}`}>
                    <label className="tp-commit-row">
                      <input
                        type="checkbox"
                        checked={pick.has(c.hash)}
                        onChange={() =>
                          setPick((s) => {
                            const n = new Set(s);
                            if (n.has(c.hash)) n.delete(c.hash);
                            else n.add(c.hash);
                            return n;
                          })
                        }
                      />
                      <span className="tp-n">{i + 1}</span>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="ellipsis tp-subj">{c.subject}</span>
                        <span className="small muted">
                          <span className="mono">{c.shortHash}</span> · {c.author} · {relative(c.date)}
                        </span>
                      </span>
                      {c.alreadyInTarget && <span className="badge ok" title={`${target} already has this change`}>in {target}</span>}
                      <button className="btn sm ghost" type="button" onClick={(e) => (e.preventDefault(), setOpenFiles(openFiles === c.hash ? null : c.hash))}>
                        {c.files.length} file{c.files.length === 1 ? '' : 's'}
                      </button>
                    </label>
                    {openFiles === c.hash && (
                      <div className="tp-files mono small">
                        {c.files.map((f) => (
                          <div key={f}>{f}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            )}
            <div>
              <h4 style={{ marginTop: mode === 'pick' ? 12 : 0 }}>Where should they go?</h4>
              <label className={`radio-card ${into === 'new-branch' ? 'selected' : ''}`}>
                <input type="radio" checked={into === 'new-branch'} onChange={() => setInto('new-branch')} />
                <div className="grow">
                  <strong>A new branch from {target}</strong> <span className="badge ok">recommended</span>
                  <div className="small muted">{target} itself is not touched. Publish the new branch and open a pull request — reviews and checks apply as usual.</div>
                  {into === 'new-branch' && <input className="mt mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />}
                  {!nameOk && <div className="small text-danger">Use letters, digits, “.”, “_”, “-” and “/”.</div>}
                </div>
              </label>
              <label className={`radio-card ${into === 'target' ? 'selected' : ''}`} style={!canDirect ? { opacity: 0.5 } : undefined} title={canDirect ? '' : `${target} is not a local branch`}>
                <input type="radio" checked={into === 'target'} disabled={!canDirect} onChange={() => setInto('target')} />
                <div>
                  <strong>Directly onto {target}</strong>
                  <div className="small muted">Adds the commits to your local {target} (a backup of its tip is kept). Nothing is pushed.</div>
                </div>
              </label>
              {p.currentBranch && (
                <label className="check">
                  <input type="checkbox" checked={back} onChange={(e) => setBack(e.target.checked)} /> Switch back to {p.currentBranch} afterwards
                </label>
              )}
              {mode === 'pick' ? (
                <div className="field mt">
                  <label>Commit message</label>
                  <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={defaultMsg} />
                  <div className="small muted">A note “changes picked from {source}” is added below it.</div>
                </div>
              ) : (
                <>
                  <h4>Files that come over ({files.length})</h4>
                  <div className="tp-files mono small">
                    {files.slice(0, 40).map((f) => (
                      <div key={f}>{f}</div>
                    ))}
                    {files.length > 40 && <div className="muted">…and {files.length - 40} more</div>}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
