import { useEffect, useMemo, useRef, useState } from 'react';
import type { BranchChanges, FileDiff } from '../../shared/types';
import { fileIcon } from '../pages/history/CommitFilesExplorer';
import { call, toFriendly } from '../services/api';

/** 'all' = the whole file; otherwise hunk → chosen line indexes. */
export type FilePick = 'all' | Map<number, Set<number>>;
export type Picks = Map<string, FilePick>;

export type PickSelection = { path: string; oldPath?: string; hunks?: { hunk: number; lines?: number[] }[] }[];

/** Converts picks to the API selection (whole files stay whole: renames, binaries and fully-picked files). */
export function toSelection(picks: Picks, diffs: Map<string, FileDiff>): PickSelection {
  const out: PickSelection = [];
  for (const [path, p] of picks) {
    const d = diffs.get(path);
    if (!d) continue;
    const oldPath = d.status === 'renamed' && d.oldPath !== d.newPath ? d.oldPath : undefined;
    if (p === 'all' || !lineSplittable(d)) out.push({ path, oldPath });
    else {
      const hunks = [...p.entries()].filter(([, s]) => s.size).map(([hunk, s]) => ({ hunk, lines: [...s].sort((a, b) => a - b) }));
      if (hunks.length) out.push({ path, hunks });
    }
  }
  return out;
}

const lineSplittable = (d: FileDiff) => !d.binary && !d.truncated && d.status !== 'renamed' && d.status !== 'copied';
const changeLines = (d: FileDiff) => d.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add' || l.type === 'del').length, 0);
const pickedLines = (d: FileDiff, p: FilePick | undefined) => (!p ? 0 : p === 'all' ? changeLines(d) : [...p.values()].reduce((n, s) => n + s.size, 0));

interface Props {
  repoId: string;
  source: string;
  base: string;
  picks: Picks;
  setPicks: (fn: (p: Picks) => Picks) => void;
  onLoaded: (diffs: Map<string, FileDiff>, files: string[], head: string | null) => void;
  /** Already-loaded changes (skips the request). */
  preloaded?: BranchChanges | null;
  /** Fixed height for the two panes (the Merge Studio keeps its layout steady). */
  compact?: boolean;
}

/**
 * Choose exactly which files — and which lines inside them — of a branch's own changes to bring over.
 * Tick a file to take all of it, or open it and click / drag over lines (Shift+click for a range).
 */
export function PickChanges({ repoId, source, base, picks, setPicks, onLoaded, preloaded, compact }: Props) {
  const [data, setData] = useState<BranchChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const drag = useRef<{ hunk: number; on: boolean } | null>(null);
  const anchor = useRef<{ hunk: number; line: number } | null>(null);

  useEffect(() => {
    const ready = (d: BranchChanges) => {
      setData(d);
      const m = new Map(d.diffs.map((x) => [x.status === 'deleted' ? x.oldPath : x.newPath, x]));
      onLoaded(m, d.files.map((f) => f.path), d.commits[0]?.hash ?? null);
      setFocus((f) => (f && d.files.some((x) => x.path === f) ? f : d.files[0]?.path ?? null));
    };
    if (preloaded) return ready(preloaded);
    setData(null);
    call('graph:branchChanges', { repoId, branch: source, base })
      .then(ready)
      .catch((e) => setError(toFriendly(e).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, source, base, preloaded]);
  useEffect(() => {
    const up = () => (drag.current = null);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const diffs = useMemo(() => new Map((data?.diffs ?? []).map((x) => [x.status === 'deleted' ? x.oldPath : x.newPath, x])), [data]);
  const files = (data?.files ?? []).filter((f) => !q.trim() || f.path.toLowerCase().includes(q.trim().toLowerCase()));
  const d = focus ? diffs.get(focus) ?? null : null;
  const fp = focus ? picks.get(focus) : undefined;

  const setFile = (path: string, p: FilePick | null) =>
    setPicks((m) => {
      const n = new Map(m);
      if (p === null) n.delete(path);
      else n.set(path, p);
      return n;
    });
  const asMap = (dd: FileDiff, p: FilePick | undefined): Map<number, Set<number>> => {
    if (p && p !== 'all') return new Map([...p.entries()].map(([k, s]) => [k, new Set(s)]));
    const m = new Map<number, Set<number>>();
    if (p === 'all') dd.hunks.forEach((h, hi) => m.set(hi, new Set(h.lines.map((l, k) => (l.type === 'add' || l.type === 'del' ? k : -1)).filter((k) => k >= 0))));
    return m;
  };
  const normalise = (dd: FileDiff, m: Map<number, Set<number>>): FilePick | null => {
    const n = [...m.values()].reduce((a, s) => a + s.size, 0);
    if (!n) return null;
    return n === changeLines(dd) ? 'all' : m;
  };
  const setLines = (hi: number, ks: number[], on: boolean) => {
    if (!d || !focus) return;
    const m = asMap(d, fp);
    const s = m.get(hi) ?? new Set<number>();
    for (const k of ks) {
      const t = d.hunks[hi].lines[k]?.type;
      if (t !== 'add' && t !== 'del') continue;
      if (on) s.add(k);
      else s.delete(k);
    }
    m.set(hi, s);
    setFile(focus, normalise(d, m));
  };
  const hunkAll = (hi: number, on: boolean) => d && setLines(hi, d.hunks[hi].lines.map((_, k) => k), on);
  const isOn = (hi: number, k: number) => (fp === 'all' ? true : !!fp?.get(hi)?.has(k));

  const totalPicked = [...picks.entries()].reduce((n, [p, v]) => n + (diffs.get(p) ? pickedLines(diffs.get(p)!, v) : 0), 0);

  if (error) return <div className="banner danger small">{error}</div>;
  if (!data) return <div className="small muted mm-shimmer">Loading {source}’s own changes…</div>;
  if (!data.files.length) return <div className="mp-empty">{source} has no changes of its own on top of {base}.</div>;

  return (
    <div className={`pk ${compact ? 'compact' : ''}`}>
      <div className="pk-files">
        <div className="pk-files-head">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files…" spellCheck={false} />
          <button className="btn sm ghost" onClick={() => setPicks(() => (picks.size === data.files.length ? new Map() : new Map(data.files.map((f) => [f.path, 'all' as FilePick]))))}>
            {picks.size === data.files.length ? 'None' : 'All'}
          </button>
        </div>
        <div className="pk-list">
          {files.map((f) => {
            const dd = diffs.get(f.path);
            const p = picks.get(f.path);
            const state = !p ? 'none' : p === 'all' ? 'all' : 'some';
            return (
              <div key={f.path} className={`pk-file ${focus === f.path ? 'on' : ''}`} onClick={() => setFocus(f.path)} title={f.path}>
                <button
                  className={`pk-box ${state}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(f.path, state === 'all' ? null : 'all');
                  }}
                  title={state === 'all' ? 'Leave this file out' : 'Take the whole file'}
                >
                  {state === 'all' ? '✓' : state === 'some' ? '–' : ''}
                </button>
                <span className={`fx-st ${f.status}`}>{f.status[0].toUpperCase()}</span>
                <span className="fx-ico">{fileIcon(f.path)}</span>
                <span className="pk-name ellipsis">
                  {f.path.split('/').pop()}
                  {f.path.includes('/') && <span className="fx-dir"> {f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
                </span>
                {dd && state === 'some' && (
                  <span className="pk-count">
                    {pickedLines(dd, p)}/{changeLines(dd)}
                  </span>
                )}
                <span className="fx-num add">+{f.additions}</span>
                <span className="fx-num del">−{f.deletions}</span>
              </div>
            );
          })}
        </div>
        <div className="pk-total small">
          <strong>{picks.size}</strong> file{picks.size === 1 ? '' : 's'} · <strong>{totalPicked}</strong> changed line{totalPicked === 1 ? '' : 's'} picked
        </div>
      </div>

      <div className="pk-diff">
        {!d && <div className="mp-empty">Select a file to choose its lines.</div>}
        {d && (
          <>
            <div className="pk-diff-head">
              <span className="mono ellipsis grow">{focus}</span>
              <button className="btn sm" onClick={() => setFile(focus!, 'all')}>
                Take whole file
              </button>
              <button className="btn sm ghost" onClick={() => setFile(focus!, null)}>
                Leave out
              </button>
            </div>
            {!lineSplittable(d) && (
              <div className="banner info small" style={{ margin: 8 }}>
                {d.binary ? 'Binary file' : d.truncated ? 'Very large diff' : 'Renamed file'} — it can only be brought over as a whole.
              </div>
            )}
            <div className="pk-hunks">
              {d.hunks.map((h, hi) => {
                const changes = h.lines.filter((l) => l.type === 'add' || l.type === 'del').length;
                const got = h.lines.filter((l, k) => (l.type === 'add' || l.type === 'del') && isOn(hi, k)).length;
                return (
                  <div key={hi} className={`hd-hunk ${got ? 'has-sel' : ''}`}>
                    <div className="hd-hunk-head">
                      <span className="mono small grow ellipsis">{h.header}</span>
                      {lineSplittable(d) && (
                        <button className="hd-act" onClick={() => hunkAll(hi, got < changes)}>
                          {got < changes ? `✓ Take hunk` : '✕ Drop hunk'}
                        </button>
                      )}
                    </div>
                    <table className="diff hd-table">
                      <colgroup>
                        <col style={{ width: 22 }} />
                        <col style={{ width: 48 }} />
                        <col style={{ width: 48 }} />
                        <col style={{ width: 16 }} />
                        <col />
                      </colgroup>
                      <tbody>
                        {h.lines.map((l, k) => {
                          const change = l.type === 'add' || l.type === 'del';
                          const on = change && isOn(hi, k);
                          const can = change && lineSplittable(d);
                          return (
                            <tr
                              key={k}
                              className={`${l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : l.type === 'meta' ? 'meta' : ''} ${on ? 'picked' : ''} ${can ? 'pickable' : ''}`}
                              onMouseDown={(e) => {
                                if (!can || e.button !== 0) return;
                                e.preventDefault();
                                if (e.shiftKey && anchor.current?.hunk === hi) {
                                  const a = anchor.current.line;
                                  const ks = Array.from({ length: Math.abs(k - a) + 1 }, (_, n) => Math.min(a, k) + n);
                                  return setLines(hi, ks, true);
                                }
                                drag.current = { hunk: hi, on: !on };
                                anchor.current = { hunk: hi, line: k };
                                setLines(hi, [k], !on);
                              }}
                              onMouseEnter={() => can && drag.current?.hunk === hi && setLines(hi, [k], drag.current.on)}
                            >
                              <td className="hd-pick">{can ? <span className={`hd-box ${on ? 'on' : ''}`}>{on ? '✓' : ''}</span> : null}</td>
                              <td className="ln">{l.oldLine ?? ''}</td>
                              <td className="ln">{l.newLine ?? ''}</td>
                              <td className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
                              <td>{l.content}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
