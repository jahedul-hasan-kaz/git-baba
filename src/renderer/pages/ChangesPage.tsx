import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { FileChange, FileDiff, FriendlyError, RepoStatus } from '../../shared/types';
import { ErrorPanel } from '../components/ErrorPanel';
import { KindIcon, fileKey } from '../components/FileList';
import { Spinner } from '../components/Modal';
import { CommitDialog } from '../dialogs/CommitDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { call } from '../services/api';
import { useApp } from '../state/AppState';
import { CommitComposer } from './changes/CommitComposer';
import { CleanSlate } from './changes/CleanSlate';
import { HunkDiff, type PartialAction } from './changes/HunkDiff';
import { fileIcon } from './history/CommitFilesExplorer';

interface Props {
  status: RepoStatus | null;
  reload: () => Promise<void>;
  error: FriendlyError | null;
  /**
   * Inside the Changes workspace: only the file lanes and the composer render here; a picked
   * file's diff opens in `diffHost` (over the graph), and `clean` replaces the empty screen.
   */
  docked?: { diffHost: HTMLElement | null; clean: ReactNode };
}

type LaneId = 'conflicted' | 'changes' | 'staged';
const DRAG_MIME = 'application/x-gitbaba-files';
const GROUP_KEY = 'gb.changes.grouped';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function ChangesPage({ status, reload, error, docked }: Props) {
  const { activeRepo, showError, bump, toast, setRepoTab } = useApp();
  const repoId = activeRepo!.id;
  const [selected, setSelected] = useState<FileChange | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [commitOpen, setCommitOpen] = useState(false);
  const [discard, setDiscard] = useState<string[] | null>(null);
  const [discardLines, setDiscardLines] = useState<{ path: string; selection: { hunk: number; lines?: number[] }[]; count: number } | null>(null);
  const [stageThenCommit, setStageThenCommit] = useState(false);
  const [filter, setFilter] = useState('');
  const [grouped, setGrouped] = useState(() => {
    try {
      return localStorage.getItem(GROUP_KEY) !== 'flat';
    } catch {
      return true;
    }
  });
  const [collapsed, setCollapsed] = useState<Set<LaneId>>(new Set());
  const [dropLane, setDropLane] = useState<LaneId | null>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<{ staged: Record<string, [number, number]>; unstaged: Record<string, [number, number]> }>({ staged: {}, unstaged: {} });
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_KEY, grouped ? 'grouped' : 'flat');
    } catch {
      /* convenience only */
    }
  }, [grouped]);

  useEffect(() => {
    if (!status) return;
    call('git:changeStats', { repoId }).then(setStats).catch(() => undefined);
  }, [status, repoId]);

  // Keep the selection valid when status changes (a staged file keeps focus as it moves lanes).
  useEffect(() => {
    if (!status || !selected) return;
    const all = [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked];
    const still = all.find((f) => fileKey(f) === fileKey(selected)) ?? all.find((f) => f.path === selected.path) ?? null;
    if (!still) {
      setSelected(null);
      setDiff(null);
    } else if (still !== selected) setSelected(still);
    setPicked((p) => new Set([...p].filter((k) => all.some((f) => fileKey(f) === k))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const loadDiff = useCallback(
    (f: FileChange | null) => {
      if (!f) return;
      let cancelled = false;
      setDiffLoading(true);
      call('git:diffFile', { repoId, path: f.path, area: f.area })
        .then((d) => !cancelled && setDiff(d))
        .catch((err) => !cancelled && showError(err))
        .finally(() => !cancelled && setDiffLoading(false));
      return () => {
        cancelled = true;
      };
    },
    [repoId, showError],
  );
  useEffect(() => loadDiff(selected), [selected, loadDiff, status]);

  const act = async (fn: () => Promise<unknown>, moved?: string[]) => {
    setBusy(true);
    try {
      await fn();
      if (moved?.length) {
        setFlash(new Set(moved));
        setTimeout(() => setFlash(new Set()), 900);
      }
    } catch (err) {
      showError(err);
    }
    setBusy(false);
    await reload();
    bump();
  };

  const lanes = useMemo(() => {
    if (!status) return [];
    const q = filter.trim().toLowerCase();
    const f = (list: FileChange[]) => (q ? list.filter((x) => x.path.toLowerCase().includes(q)) : list);
    const out: { id: LaneId; title: string; files: FileChange[]; total: number }[] = [];
    if (status.conflicted.length) out.push({ id: 'conflicted', title: 'Conflicts', files: f(status.conflicted), total: status.conflicted.length });
    out.push({ id: 'changes', title: 'Changes', files: f([...status.unstaged, ...status.untracked]), total: status.unstaged.length + status.untracked.length });
    out.push({ id: 'staged', title: 'Staged', files: f(status.staged), total: status.staged.length });
    return out;
  }, [status, filter]);
  const flat = useMemo(() => lanes.flatMap((l) => (collapsed.has(l.id) ? [] : l.files)), [lanes, collapsed]);

  // Docked: Esc closes the file diff and brings the graph back.
  const isDocked = !!docked;
  useEffect(() => {
    if (!isDocked || !selected) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-backdrop, .dt, .cm, .ctx-menu')) return;
      setSelected(null);
      setDiff(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [isDocked, selected]);

  if (error) return <div className="content"><ErrorPanel error={error} /></div>;
  if (!status) return <div className="content"><Spinner label="Reading repository status…" /></div>;

  const unstagedAll = [...status.unstaged.map((f) => f.path), ...status.untracked.map((f) => f.path)];
  const total = status.staged.length + unstagedAll.length + status.conflicted.length;
  const nothing = total === 0;
  // Nothing to commit: a full-width overview instead of an empty two-pane layout.
  if (nothing) return docked ? <div className="ws-clean">{docked.clean}</div> : <div className="content flush"><CleanSlate repoId={repoId} status={status} /></div>;
  const statOf = (f: FileChange) => (f.area === 'staged' ? stats.staged[f.path] : stats.unstaged[f.path]);
  const sum = (rec: Record<string, [number, number]>) => Object.values(rec).reduce((a, [x, y]) => ({ add: a.add + x, del: a.del + y }), { add: 0, del: 0 });
  const stagedStats = sum(stats.staged);
  const maxChange = Math.max(1, ...Object.values(stats.unstaged).map(([a, d]) => a + d), ...Object.values(stats.staged).map(([a, d]) => a + d));
  const progress = total ? status.staged.length / (status.staged.length + unstagedAll.length) || 0 : 0;

  const pickedFiles = flat.filter((f) => picked.has(fileKey(f)));
  const pickedStageable = pickedFiles.filter((f) => f.area === 'unstaged' || f.area === 'untracked').map((f) => f.path);
  const pickedUnstageable = pickedFiles.filter((f) => f.area === 'staged').map((f) => f.path);

  const stage = (paths: string[]) => paths.length && act(() => call('git:stage', { repoId, paths }), paths);
  const unstage = (paths: string[]) => paths.length && act(() => call('git:unstage', { repoId, paths }), paths);
  const toggleStage = (f: FileChange) => (f.area === 'staged' ? unstage([f.path]) : f.area === 'conflicted' ? setRepoTab('conflicts') : stage([f.path]));

  const clickRow = (f: FileChange, e: React.MouseEvent) => {
    const k = fileKey(f);
    if (e.ctrlKey || e.metaKey) {
      setPicked((p) => {
        const n = new Set(p);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      });
      setAnchor(k);
      return;
    }
    if (e.shiftKey && anchor) {
      const a = flat.findIndex((x) => fileKey(x) === anchor);
      const b = flat.findIndex((x) => fileKey(x) === k);
      if (a !== -1 && b !== -1) setPicked(new Set(flat.slice(Math.min(a, b), Math.max(a, b) + 1).map(fileKey)));
      return;
    }
    setPicked(new Set([k]));
    setAnchor(k);
    setSelected(f);
  };

  const onBoardKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
    const i = selected ? flat.findIndex((f) => fileKey(f) === fileKey(selected)) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        setSelected(next);
        setPicked(new Set([fileKey(next)]));
        setAnchor(fileKey(next));
        boardRef.current?.querySelector(`[data-key="${CSS.escape(fileKey(next))}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === ' ' && selected) {
      e.preventDefault();
      if (pickedFiles.length > 1) {
        void stage(pickedStageable);
        void unstage(pickedUnstageable);
      } else void toggleStage(selected);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && selected.area !== 'staged' && selected.area !== 'conflicted') {
      e.preventDefault();
      setDiscard(pickedFiles.length > 1 ? pickedFiles.filter((f) => f.area !== 'staged').map((f) => f.path) : [selected.path]);
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      setPicked(new Set(flat.map(fileKey)));
    } else if (e.key === 'Escape') setPicked(new Set());
  };

  const dragStart = (f: FileChange, e: React.DragEvent) => {
    const keys = picked.has(fileKey(f)) ? pickedFiles : [f];
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(keys.map((x) => ({ path: x.path, area: x.area }))));
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropOn = (lane: LaneId, e: React.DragEvent) => {
    e.preventDefault();
    setDropLane(null);
    let items: { path: string; area: FileChange['area'] }[] = [];
    try {
      items = JSON.parse(e.dataTransfer.getData(DRAG_MIME) || '[]');
    } catch {
      return;
    }
    if (lane === 'staged') void stage(items.filter((x) => x.area === 'unstaged' || x.area === 'untracked').map((x) => x.path));
    if (lane === 'changes') void unstage(items.filter((x) => x.area === 'staged').map((x) => x.path));
  };

  const applyPartial = (action: PartialAction, selection: { hunk: number; lines?: number[] }[]) => {
    if (!selected) return;
    if (action === 'discard') {
      const count = selection.reduce((n, s) => n + (s.lines ? s.lines.length : (diff?.hunks[s.hunk]?.lines.filter((l) => l.type !== 'context' && l.type !== 'meta').length ?? 0)), 0);
      return setDiscardLines({ path: selected.path, selection, count });
    }
    void act(async () => {
      const r = await call('git:applySelection', { repoId, path: selected.path, action, selection });
      toast(`${action === 'stage' ? 'Staged' : 'Unstaged'} ${r.lines} line(s) of ${baseOf(selected.path)}`);
    });
  };
  const applyWhole = (action: PartialAction) => {
    if (!selected) return;
    if (action === 'discard') return setDiscard([selected.path]);
    void (action === 'stage' ? stage([selected.path]) : unstage([selected.path]));
  };

  const row = (f: FileChange, lane: LaneId) => {
    const k = fileKey(f);
    const st = statOf(f);
    const isSel = selected && fileKey(selected) === k;
    return (
      <div
        key={k}
        data-key={k}
        className={`cb-row ${isSel ? 'focus' : ''} ${picked.has(k) ? 'picked' : ''} ${flash.has(f.path) ? 'flash' : ''}`}
        onClick={(e) => clickRow(f, e)}
        draggable={lane !== 'conflicted'}
        onDragStart={(e) => dragStart(f, e)}
        title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
      >
        <button
          className={`cb-toggle ${f.area === 'staged' ? 'on' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            void toggleStage(f);
          }}
          title={f.area === 'staged' ? 'Unstage (Space)' : f.area === 'conflicted' ? 'Resolve in Conflicts' : 'Stage (Space)'}
          disabled={busy}
        >
          {f.area === 'staged' ? '✓' : f.area === 'conflicted' ? '!' : ''}
        </button>
        <KindIcon kind={f.kind} />
        <span className="cb-ico">{fileIcon(f.path)}</span>
        <span className="cb-name ellipsis">
          {baseOf(f.path)}
          {!grouped && dirOf(f.path) && <span className="cb-dir"> {dirOf(f.path)}</span>}
        </span>
        {st && (
          <span className="cb-stat">
            <span className="text-ok">+{st[0]}</span> <span className="text-danger">−{st[1]}</span>
            <span className="fx-bar" style={{ width: Math.max(6, Math.round(((st[0] + st[1]) / maxChange) * 40)) }}>
              <span className="fx-bar-add" style={{ width: `${st[0] + st[1] ? (st[0] / (st[0] + st[1])) * 100 : 0}%` }} />
              <span className="fx-bar-del" style={{ width: `${st[0] + st[1] ? (st[1] / (st[0] + st[1])) * 100 : 0}%` }} />
            </span>
          </span>
        )}
        <span className="cb-actions" onClick={(e) => e.stopPropagation()}>
          {lane === 'changes' && (
            <button title={f.area === 'untracked' ? 'Delete this new file' : 'Discard changes'} onClick={() => setDiscard([f.path])}>
              ↺
            </button>
          )}
          <button title="Copy path" onClick={() => call('app:copyText', { text: f.path }).then(() => toast('Path copied')).catch(showError)}>
            ⧉
          </button>
          <button title="Show in folder" onClick={() => call('graph:reveal', { repoId, path: f.path }).catch(showError)}>
            📂
          </button>
        </span>
      </div>
    );
  };

  const laneBody = (lane: { id: LaneId; files: FileChange[] }) => {
    if (!grouped) return lane.files.map((f) => row(f, lane.id));
    const groups = new Map<string, FileChange[]>();
    for (const f of [...lane.files].sort((a, b) => a.path.localeCompare(b.path))) groups.set(dirOf(f.path), [...(groups.get(dirOf(f.path)) ?? []), f]);
    return [...groups.entries()].map(([dir, files]) => (
      <div key={dir || '.'} className="cb-group">
        {dir && (
          <div className="cb-dirhead">
            <span>📂</span>
            <span className="ellipsis grow">{dir}</span>
            <span className="cb-count">{files.length}</span>
          </div>
        )}
        {files.map((f) => row(f, lane.id))}
      </div>
    ));
  };

  const blockedReason = status.conflicted.length
    ? 'Resolve the conflicts before committing.'
    : !message.trim()
      ? 'Write a summary to commit.'
      : status.staged.length === 0 && unstagedAll.length === 0
        ? 'Nothing to commit.'
        : null;
  const primaryLabel =
    status.staged.length === 0 && unstagedAll.length > 0 ? `Stage all ${unstagedAll.length} & review commit…` : `Review & commit ${status.staged.length} file${status.staged.length === 1 ? '' : 's'}`;

  return (
    <div className={`content flush ${docked ? 'ws-dock-wrap' : ''}`}>
      <div className={`split cb-split ${docked ? 'ws-dock' : ''}`}>
        <div className="left cb-left" ref={boardRef} tabIndex={0} onKeyDown={onBoardKey}>
          <div className="cb-head">
            <svg className="cb-ring" viewBox="0 0 36 36" width={36} height={36} aria-hidden>
              <circle cx={18} cy={18} r={15} className="cb-ring-track" />
              <circle cx={18} cy={18} r={15} className="cb-ring-fill" strokeDasharray={`${progress * 94.25} 94.25`} transform="rotate(-90 18 18)" />
            </svg>
            <div className="grow">
              <div className="cb-title">{nothing ? 'Working tree clean' : `${status.staged.length} of ${total} staged`}</div>
              <div className="small muted">
                ⎇ {status.branch ?? 'detached HEAD'}
                {status.ahead ? ` · ↑${status.ahead}` : ''}
                {status.behind ? ` · ↓${status.behind}` : ''}
              </div>
            </div>
            <div className="seg">
              <button className={grouped ? 'on' : ''} onClick={() => setGrouped(true)} title="Group by folder">
                🗂
              </button>
              <button className={!grouped ? 'on' : ''} onClick={() => setGrouped(false)} title="Flat list">
                ☰
              </button>
            </div>
          </div>
          {!nothing && <input className="cb-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter changed files…" spellCheck={false} />}

          <div className="cb-lanes">
            {nothing && (
              <div className="cb-clean">
                <div className="cb-clean-ico">✓</div>
                <div>Nothing to commit — your files match the last commit.</div>
              </div>
            )}
            {!nothing &&
              lanes.map((lane) => (
                <div
                  key={lane.id}
                  className={`cb-lane ${lane.id} ${dropLane === lane.id ? 'drop' : ''}`}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(DRAG_MIME) || lane.id === 'conflicted') return;
                    e.preventDefault();
                    if (dropLane !== lane.id) setDropLane(lane.id);
                  }}
                  onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropLane(null)}
                  onDrop={(e) => dropOn(lane.id, e)}
                >
                  <div className="cb-lane-head">
                    <button
                      className="cb-caret"
                      onClick={() =>
                        setCollapsed((c) => {
                          const n = new Set(c);
                          if (n.has(lane.id)) n.delete(lane.id);
                          else n.add(lane.id);
                          return n;
                        })
                      }
                    >
                      {collapsed.has(lane.id) ? '▸' : '▾'}
                    </button>
                    <span className="cb-lane-title">{lane.title}</span>
                    <span className="cb-count">{lane.files.length !== lane.total ? `${lane.files.length}/${lane.total}` : lane.total}</span>
                    <span className="spacer" />
                    {lane.id === 'conflicted' && (
                      <button className="btn sm" onClick={() => setRepoTab('conflicts')}>
                        Resolve…
                      </button>
                    )}
                    {lane.id === 'changes' && lane.total > 0 && (
                      <>
                        <button className="btn sm ghost danger" onClick={() => setDiscard(unstagedAll)} title="Discard all unstaged changes">
                          ↺ all
                        </button>
                        <button className="btn sm" disabled={busy} onClick={() => act(() => call('git:stageAll', { repoId }), unstagedAll)}>
                          Stage all ⤵
                        </button>
                      </>
                    )}
                    {lane.id === 'staged' && lane.total > 0 && (
                      <button className="btn sm ghost" disabled={busy} onClick={() => act(() => call('git:unstageAll', { repoId }), status.staged.map((f) => f.path))}>
                        ⤴ Unstage all
                      </button>
                    )}
                  </div>
                  {!collapsed.has(lane.id) && (
                    <div className="cb-lane-body">
                      {lane.files.length === 0 && <div className="cb-empty">{lane.id === 'staged' ? 'Drag files here, or press Space on a file, to stage it' : filter ? 'No match' : 'No unstaged changes'}</div>}
                      {laneBody(lane)}
                    </div>
                  )}
                </div>
              ))}
          </div>

          {pickedFiles.length > 1 && (
            <div className="cb-bulk">
              <strong>{pickedFiles.length}</strong> selected
              <span className="spacer" />
              {pickedStageable.length > 0 && (
                <button className="btn sm primary" disabled={busy} onClick={() => void stage(pickedStageable)}>
                  Stage {pickedStageable.length}
                </button>
              )}
              {pickedUnstageable.length > 0 && (
                <button className="btn sm" disabled={busy} onClick={() => void unstage(pickedUnstageable)}>
                  Unstage {pickedUnstageable.length}
                </button>
              )}
              {pickedStageable.length > 0 && (
                <button className="btn sm danger" onClick={() => setDiscard(pickedStageable)}>
                  Discard
                </button>
              )}
              <button className="btn sm ghost" onClick={() => setPicked(new Set())} title="Clear (Esc)">
                ✕
              </button>
            </div>
          )}

          {!nothing && (
            <CommitComposer
              repoId={repoId}
              message={message}
              setMessage={setMessage}
              stagedPaths={status.staged.map((f) => f.path)}
              stagedStats={stagedStats}
              branch={status.branch}
              canCommit={!blockedReason}
              primaryLabel={primaryLabel}
              blockedReason={blockedReason}
              onCommit={() => (status.staged.length === 0 ? setStageThenCommit(true) : setCommitOpen(true))}
            />
          )}
        </div>
        {docked ? (
          selected &&
          docked.diffHost &&
          createPortal(
            <div className="ws-diff">
              <div className="ws-diff-bar">
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    setSelected(null);
                    setDiff(null);
                  }}
                  title="Close the diff and show the graph (Esc)"
                >
                  ✕
                </button>
                <span className={`ws-diff-area ${selected.area}`}>{selected.area === 'staged' ? 'Staged' : selected.area === 'untracked' ? 'New file' : selected.area === 'conflicted' ? 'Conflict' : 'Unstaged'}</span>
                <span className="mono ellipsis grow" title={selected.path}>
                  {dirOf(selected.path) && <span className="muted">{dirOf(selected.path)}/</span>}
                  <strong>{baseOf(selected.path)}</strong>
                </span>
                {statOf(selected) && (
                  <span className="small mono">
                    <span className="text-ok">+{statOf(selected)![0]}</span> <span className="text-danger">−{statOf(selected)![1]}</span>
                  </span>
                )}
                <span className="small muted">
                  {flat.findIndex((f) => fileKey(f) === fileKey(selected)) + 1}/{flat.length}
                </span>
              </div>
              <div className="ws-diff-body">
                {diffLoading && !diff && <Spinner />}
                {diff && <HunkDiff file={selected} diff={diff} busy={busy} onApply={applyPartial} onWhole={applyWhole} />}
                {!diffLoading && !diff && <div className="empty">No textual changes for this file.</div>}
              </div>
            </div>,
            docked.diffHost,
          )
        ) : (
        <div className="right cb-right">
          {!selected && (
            <div className="cb-placeholder">
              <div className="cb-placeholder-ico">✋</div>
              <h3>Pick a file to review</h3>
              <p className="small muted">
                Stage whole files, single hunks or just the lines you choose. Drag files between <strong>Changes</strong> and <strong>Staged</strong>.
              </p>
              <div className="cb-keys small">
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> move
                </span>
                <span>
                  <kbd>Space</kbd> stage / unstage
                </span>
                <span>
                  <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+click multi-select
                </span>
                <span>
                  <kbd>Del</kbd> discard
                </span>
                <span>
                  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> commit
                </span>
              </div>
            </div>
          )}
          {selected && diffLoading && !diff && (
            <div className="content">
              <Spinner />
            </div>
          )}
          {selected && diff && <HunkDiff file={selected} diff={diff} busy={busy} onApply={applyPartial} onWhole={applyWhole} />}
          {selected && !diffLoading && !diff && <div className="empty">No textual changes for this file.</div>}
        </div>
        )}
      </div>

      {commitOpen && (
        <CommitDialog
          repoId={repoId}
          mode="commit"
          initialMessage={message}
          onClose={() => setCommitOpen(false)}
          onDone={(c) => {
            setCommitOpen(false);
            if (c) {
              setMessage('');
              toast(`Committed ${c.shortHash}: ${c.subject}`);
            }
            void reload();
            bump();
          }}
        />
      )}
      {stageThenCommit && (
        <ConfirmDialog
          title="Stage Files for Commit"
          explanation="Nothing is staged yet. These changed files will be staged so they can be included in the commit. You will review the commit and confirm it in the next step."
          impact="Only the staging area changes. Your files are not modified, and nothing is committed or pushed yet."
          affected={unstagedAll}
          confirmLabel={`Stage ${unstagedAll.length} file(s) & continue`}
          onCancel={() => setStageThenCommit(false)}
          onConfirm={async () => {
            try {
              await call('git:stage', { repoId, paths: unstagedAll });
              await reload();
              bump();
              setStageThenCommit(false);
              setCommitOpen(true);
            } catch (err) {
              setStageThenCommit(false);
              showError(err);
            }
          }}
        />
      )}
      {discardLines && (
        <ConfirmDialog
          title="Discard Selected Changes"
          danger
          explanation={
            <>
              Removes {discardLines.count} changed line(s) from <strong className="mono">{discardLines.path}</strong> in your working folder. The exact patch is saved in the app’s data folder first, so it can be
              re-applied.
            </>
          }
          impact="Your file is edited; the rest of its changes stay."
          affected={[discardLines.path]}
          confirmLabel={`Discard ${discardLines.count} line(s)`}
          onCancel={() => setDiscardLines(null)}
          onConfirm={async () => {
            const d = discardLines;
            setDiscardLines(null);
            await act(async () => {
              const r = await call('git:applySelection', { repoId, path: d.path, action: 'discard', selection: d.selection, confirmed: true });
              toast(`Discarded ${r.lines} line(s). Patch saved: ${r.backupFile}`, 'info');
            });
          }}
        />
      )}
      {discard && (
        <ConfirmDialog
          title="Discard Changes"
          danger
          explanation={
            <>
              Restores the selected tracked files to their last committed version and deletes the selected untracked files. A backup copy of each file is saved in the app's data folder before anything is
              removed.
            </>
          }
          impact="This operation will overwrite local changes. Git cannot undo it."
          affected={discard}
          confirmLabel={`Discard ${discard.length} file(s)`}
          onCancel={() => setDiscard(null)}
          onReview={() => {
            const f = [...status.unstaged, ...status.untracked].find((x) => x.path === discard[0]);
            if (f) setSelected(f);
            setDiscard(null);
          }}
          onConfirm={async () => {
            try {
              const res = await call('git:discard', { repoId, paths: discard, confirmed: true });
              toast(`Discarded ${discard.length} file(s). Backup: ${res.backupDir}`, 'info');
            } catch (err) {
              showError(err);
            }
            setDiscard(null);
            await reload();
            bump();
          }}
        />
      )}
    </div>
  );
}
