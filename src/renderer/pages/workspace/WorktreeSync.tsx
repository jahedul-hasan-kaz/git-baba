import { useMemo, useState } from 'react';
import type { BranchInfo, WorktreeInfo, WorktreeLine, WorktreeSyncMode, WorktreeSyncResult } from '../../../shared/types';
import { BranchPicker, toPickerItems } from '../../components/BranchPicker';
import { relative } from '../../components/FileDiffList';
import { Modal } from '../../components/Modal';
import { call } from '../../services/api';
import { authorColor, initials } from '../history/graphStyle';

const folderOf = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
export type SyncSource = 'base' | 'upstream';
export const lineOf = (w: WorktreeInfo, s: SyncSource): WorktreeLine | undefined => (s === 'base' ? w.drift?.base : w.drift?.upstream);
/** Worktrees that are behind on `source` and can be synced from here. */
export const behindOn = (list: WorktreeInfo[], s: SyncSource) => list.filter((w) => !w.prunable && !!w.branch && (lineOf(w, s)?.behind ?? 0) > 0);

/** Stacked author avatars with a "+n" tail: who moved the line forward. */
export function Authors({ line, max = 3 }: { line: WorktreeLine; max?: number }) {
  if (!line.authors.length) return null;
  const shown = line.authors.slice(0, max);
  return (
    <span className="wd-authors" title={line.authors.map((a) => `${a.name} · ${a.count} commit${a.count === 1 ? '' : 's'}`).join('\n')}>
      {shown.map((a) => (
        <span key={a.name} className="wd-av" style={{ background: authorColor(a.name) }}>
          {initials(a.name)}
        </span>
      ))}
    </span>
  );
}

/**
 * What a worktree is missing, at a glance: new commits on the branch it follows (e.g. develop, from
 * teammates or another worktree) and on its own remote branch. Each chip opens the sync for that line.
 */
export function DriftChips({ w, compact, onSync }: { w: WorktreeInfo; compact?: boolean; onSync: (s: SyncSource) => void }) {
  const d = w.drift;
  if (!d || w.prunable || !w.branch) return null;
  const chip = (s: SyncSource, l: WorktreeLine | undefined) => {
    if (!l) return null;
    const label = s === 'base' ? l.name : 'remote';
    if (l.behind === 0) {
      if (compact || s === 'upstream') return null;
      return (
        <span key={s} className="wd-chip ok" title={`Has everything from ${l.ref}${l.ahead ? ` · ${l.ahead} commit(s) of its own` : ''}`}>
          ✓ {label}
        </span>
      );
    }
    return (
      <button
        key={s}
        className={`wd-chip behind ${s}`}
        onClick={(e) => {
          e.stopPropagation();
          onSync(s);
        }}
        title={`${l.behind} new commit${l.behind === 1 ? '' : 's'} on ${l.ref}${l.latest ? `\nNewest: ${l.latest.subject} — ${l.latest.author}, ${relative(l.latest.date)}` : ''}\nClick to bring them in`}
      >
        <span className="wd-arrow">⇣</span>
        {l.behind}
        {!compact && <span className="wd-from">{s === 'base' ? `from ${label}` : 'on remote'}</span>}
        {!compact && <Authors line={l} max={2} />}
      </button>
    );
  };
  const out = [chip('base', d.base), chip('upstream', d.upstream)].filter(Boolean);
  return out.length ? <span className="wd-chips">{out}</span> : null;
}

type RowState = { status: 'waiting' | 'running' } | { status: 'done'; result: WorktreeSyncResult } | { status: 'error'; message: string };

/**
 * Sync one or several worktrees with the line they follow. Every worktree is updated in its own folder; uncommitted
 * work is stashed and restored; a conflict rolls that worktree back (or is kept there to resolve, if chosen).
 */
export function SyncDialog(props: {
  repoId: string;
  worktrees: WorktreeInfo[];
  source: SyncSource;
  branches: BranchInfo[];
  onClose: () => void;
  onChanged: () => void;
  onOpen: (w: WorktreeInfo) => void;
}) {
  const { repoId, worktrees, source, branches, onClose, onChanged, onOpen } = props;
  const single = worktrees.length === 1 ? worktrees[0] : null;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(worktrees.map((w) => w.path)));
  const [mode, setMode] = useState<WorktreeSyncMode>('merge');
  const [onConflict, setOnConflict] = useState<'abort' | 'keep'>(single ? 'keep' : 'abort');
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);
  const [editingBase, setEditingBase] = useState(false);
  const [baseError, setBaseError] = useState<string | null>(null);
  const done = Object.values(rows).some((r) => r.status === 'done' || r.status === 'error') && !running;

  const line = single ? lineOf(single, source) : undefined;
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of worktrees) for (const a of lineOf(w, source)?.authors ?? []) m.set(a.name, (m.get(a.name) ?? 0) + a.count);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [worktrees, source]);
  const anyAhead = worktrees.some((w) => picked.has(w.path) && (lineOf(w, source)?.ahead ?? 0) > 0);
  const targets = worktrees.filter((w) => picked.has(w.path));
  const refs = [...new Set(worktrees.map((w) => lineOf(w, source)?.ref).filter(Boolean))];

  const go = async () => {
    setRunning(true);
    setRows(Object.fromEntries(targets.map((w) => [w.path, { status: 'waiting' } as RowState])));
    for (const w of targets) {
      setRows((r) => ({ ...r, [w.path]: { status: 'running' } }));
      try {
        const result = await call('git:worktreeSync', { repoId, path: w.path, source, mode, onConflict, confirmed: true });
        setRows((r) => ({ ...r, [w.path]: { status: 'done', result } }));
      } catch (err) {
        setRows((r) => ({ ...r, [w.path]: { status: 'error', message: err instanceof Error ? err.message : String(err) } }));
      }
    }
    setRunning(false);
    onChanged();
  };

  const setBase = async (base: string | null) => {
    if (!single) return;
    setBaseError(null);
    try {
      await call('git:worktreeSetBase', { repoId, path: single.path, base });
      setEditingBase(false);
      onChanged();
      onClose();
    } catch (err) {
      setBaseError(err instanceof Error ? err.message : String(err));
    }
  };

  const title = single ? `Update ${folderOf(single.path)}` : `Update ${worktrees.length} Worktrees`;
  const what = source === 'base' ? (single?.drift?.base?.name ?? 'their base branch') : 'their remote branch';

  return (
    <Modal
      title={title}
      icon="⇣"
      size="wide"
      onClose={onClose}
      locked={running}
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <span className="small muted grow">Compared with what was last fetched. Fetch first to include the very latest pushes.</span>
            <button className="btn cancel" onClick={onClose} disabled={running}>
              Cancel
            </button>
            <button className="btn primary" disabled={running || targets.length === 0} onClick={() => void go()}>
              {running ? 'Updating…' : targets.length > 1 ? `Update ${targets.length} worktrees` : 'Bring changes in'}
            </button>
          </>
        )
      }
    >
      <div className="ws-flow">
        <div className="ws-flow-src">
          <span className="ws-flow-k">{source === 'base' ? 'Follows' : 'Remote branch'}</span>
          <strong className="mono">{refs.length === 1 ? refs[0] : `${refs.length} branches`}</strong>
          {single && source === 'base' && !editingBase && !running && !done && (
            <button className="link small" onClick={() => setEditingBase(true)}>
              change
            </button>
          )}
        </div>
        <span className="ws-flow-arrow" aria-hidden>
          <i />
          <b>{worktrees.reduce((n, w) => n + (lineOf(w, source)?.behind ?? 0), 0)} new</b>
        </span>
        <div className="ws-flow-dst">
          <span className="ws-flow-k">Into</span>
          <strong>{single ? folderOf(single.path) : `${targets.length} of ${worktrees.length} worktrees`}</strong>
        </div>
      </div>

      {editingBase && single && (
        <div className="ws-base card">
          <div className="small mb">
            Which branch should <strong>{single.branch}</strong> keep up with? Saved for this branch in every worktree.
          </div>
          <BranchPicker value={single.drift?.base?.name ?? ''} onChange={(b) => void setBase(b)} items={toPickerItems(branches.filter((b) => b.name !== single.branch))} placeholder="Choose a branch…" recentKey="worktree-base" />
          <div className="row mt">
            {single.drift?.baseChosen && (
              <button className="btn sm" onClick={() => void setBase(null)}>
                Use the default branch
              </button>
            )}
            <button className="btn sm cancel" onClick={() => setEditingBase(false)}>
              Cancel
            </button>
          </div>
          {baseError && <div className="small text-danger mt">{baseError}</div>}
        </div>
      )}

      {totals.length > 0 && (
        <div className="ws-who">
          <span className="small muted">New work by</span>
          {totals.slice(0, 6).map(([n, c]) => (
            <span key={n} className="ws-person">
              <span className="wd-av" style={{ background: authorColor(n) }}>
                {initials(n)}
              </span>
              {n}
              <span className="muted">· {c}</span>
            </span>
          ))}
        </div>
      )}
      {line?.latest && (
        <div className="ws-latest small">
          Newest: <strong>{line.latest.subject}</strong> <span className="muted">— {line.latest.author}, {relative(line.latest.date)}</span>
        </div>
      )}

      {!single && (
        <div className="ws-list">
          {worktrees.map((w) => {
            const l = lineOf(w, source);
            const r = rows[w.path];
            return (
              <label key={w.path} className={`ws-item ${r ? r.status : ''}`}>
                <input
                  type="checkbox"
                  disabled={running || done}
                  checked={picked.has(w.path)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(w.path);
                      else n.delete(w.path);
                      return n;
                    })
                  }
                />
                <span className="grow ellipsis">
                  <strong>{folderOf(w.path)}</strong> <span className="muted small">⎇ {w.branch}</span>
                </span>
                {(w.changes ?? 0) > 0 && <span className="wt-state dirty" title="Uncommitted changes are stashed and put back">✎ {w.changes}</span>}
                <span className="small muted">
                  ⇣{l?.behind ?? 0} from {l?.ref}
                </span>
                <RowStatus r={r} w={w} onOpen={onOpen} />
              </label>
            );
          })}
        </div>
      )}

      {single && rows[single.path] && (
        <div className="ws-list">
          <div className={`ws-item ${rows[single.path].status}`}>
            <span className="grow">{folderOf(single.path)}</span>
            <RowStatus r={rows[single.path]} w={single} onOpen={onOpen} />
          </div>
          {(() => {
            const r = rows[single.path];
            if (r.status === 'error') return <div className="small text-danger ws-msg">{r.message}</div>;
            if (r.status !== 'done') return null;
            return (
              <div className="small ws-msg">
                {r.result.message}
                {r.result.conflicts.length > 0 && (
                  <ul className="mono muted ws-files">
                    {r.result.conflicts.slice(0, 8).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {!done && (
        <div className="ws-opts">
          <div className="field">
            <label>How</label>
            <div className="ws-choice">
              <button className={mode === 'merge' ? 'on' : ''} onClick={() => setMode('merge')} disabled={running}>
                <strong>Merge</strong>
                <span>Keeps your commits as they are and adds a merge commit. Safe for branches others use.</span>
              </button>
              <button className={mode === 'rebase' ? 'on' : ''} onClick={() => setMode('rebase')} disabled={running}>
                <strong>Rebase</strong>
                <span>Replays your commits on top for a straight history. Best for branches only you use.</span>
              </button>
            </div>
            {!anyAhead && <div className="small muted mt">Nothing of its own on top yet, so this is a clean fast-forward either way.</div>}
          </div>
          <div className="field">
            <label>If something conflicts</label>
            <div className="ws-choice">
              <button className={onConflict === 'abort' ? 'on' : ''} onClick={() => setOnConflict('abort')} disabled={running}>
                <strong>Roll back</strong>
                <span>Leave that worktree exactly as it was and tell me which files clash.</span>
              </button>
              <button className={onConflict === 'keep' ? 'on' : ''} onClick={() => setOnConflict('keep')} disabled={running}>
                <strong>Let me resolve</strong>
                <span>Keep the conflict in that worktree so you can open it and fix it.</span>
              </button>
            </div>
          </div>
          {worktrees.some((w) => (w.changes ?? 0) > 0) && (
            <div className="banner info small">
              <span className="icon">ℹ</span>
              <div>Uncommitted changes are set aside before updating and put back afterwards — nothing is lost.</div>
            </div>
          )}
          <div className="small muted">
            Updates {what} into {single ? 'this worktree' : 'each selected worktree'}, in its own folder. Nothing is pushed.
          </div>
        </div>
      )}
    </Modal>
  );
}

function RowStatus({ r, w, onOpen }: { r: RowState | undefined; w: WorktreeInfo; onOpen: (w: WorktreeInfo) => void }) {
  if (!r) return null;
  if (r.status === 'waiting') return <span className="ws-st muted">waiting</span>;
  if (r.status === 'running') return <span className="ws-st mm-shimmer">updating…</span>;
  if (r.status === 'error') return <span className="ws-st text-danger" title={r.message}>✕ failed</span>;
  if (r.status !== 'done') return null;
  const res = r.result;
  if (res.status === 'conflict')
    return (
      <span className="ws-st text-warn" title={`${res.message}\n${res.conflicts.join('\n')}`}>
        ⚠ {res.kept ? 'resolve' : 'rolled back'} · {res.conflicts.length} file{res.conflicts.length === 1 ? '' : 's'}
        {res.kept && !w.current && (
          <button
            className="link small"
            onClick={(e) => {
              e.preventDefault();
              onOpen(w);
            }}
          >
            open
          </button>
        )}
      </span>
    );
  if (res.status === 'skipped') return <span className="ws-st muted" title={res.message}>skipped</span>;
  return <span className="ws-st text-ok" title={res.message}>✓ {res.status === 'synced' ? `+${res.commits}` : 'up to date'}</span>;
}
