import { useEffect, useMemo, useState } from 'react';
import type { BranchChanges } from '../../../shared/types';
import { PickChanges, type Picks } from '../../dialogs/PickChanges';
import { CommitPicker } from './CommitPicker';
import { call, toFriendly } from '../../services/api';
import { branchColor } from '../BranchPicker';
import { relative } from '../FileDiffList';

type Load = { status: 'loading' } | { status: 'ok'; data: BranchChanges } | { status: 'error'; message: string };

interface Props {
  repoId: string;
  sources: string[];
  target: string;
  /** source → base branch, for sources that bring only their own changes. */
  own: Record<string, string>;
  revision: number;
  focus?: string | null;
  /** Chosen files / lines per "source|base" key (missing = everything). */
  picks: Record<string, Picks>;
  setPicks: (key: string, fn: (p: Picks) => Picks) => void;
  /** Reports every file a source would change, so a partial choice can be told from "everything". */
  onFiles: (key: string, files: string[], head: string | null) => void;
  /** How each source is narrowed down: by files & lines (default) or by commits. */
  modes: Record<string, 'files' | 'commits'>;
  setMode: (key: string, mode: 'files' | 'commits') => void;
  /** Ticked commit hashes per "source|base" key. */
  commitSel: Record<string, Set<string>>;
  setCommitSel: (key: string, fn: (s: Set<string>) => Set<string>) => void;
  onCommits: (key: string, all: string[], head: string) => void;
}

/** Key of a source's selection: it is only valid for the same base it was made against. */
export const pickKey = (source: string, base: string) => `${source}|${base}`;

/**
 * Exactly what would land in the target: for each source the commits and the combined diff since it
 * split from the target (or, in "own changes" mode, from the branch it was made from), and an "All"
 * view of every file touched across sources.
 */
export function MergePreview({ repoId, sources, target, own, revision, focus, picks, setPicks, onFiles, modes, setMode, commitSel, setCommitSel, onCommits }: Props) {
  const [tab, setTab] = useState<string>(focus ?? sources[0] ?? '__all');
  const [cache, setCache] = useState<Record<string, Load>>({});
  const [showCommits, setShowCommits] = useState(false);

  useEffect(() => {
    if (focus) setTab(focus);
  }, [focus]);
  useEffect(() => {
    if (tab !== '__all' && !sources.includes(tab)) setTab(sources[0] ?? '__all');
  }, [sources, tab]);
  useEffect(() => setCache({}), [revision, repoId, target]);

  const key = (b: string) => `${b}|${own[b] ?? ''}`;
  const baseOf = (b: string) => (own[b] !== undefined ? own[b] : target);
  const need = tab === '__all' ? sources : sources.filter((b) => b === tab);

  useEffect(() => {
    for (const b of need) {
      const k = key(b);
      const base = baseOf(b);
      if (cache[k] || !base) continue;
      setCache((c) => ({ ...c, [k]: { status: 'loading' } }));
      call('graph:branchChanges', { repoId, branch: b, base })
        .then((data) => setCache((c) => ({ ...c, [k]: { status: 'ok', data } })))
        .catch((e) => setCache((c) => ({ ...c, [k]: { status: 'error', message: toFriendly(e).message } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [need.join('\u0000'), own, target, cache]);

  const combined = useMemo(() => {
    if (tab !== '__all') return null;
    const files = new Map<string, { add: number; del: number; by: string[]; status: string }>();
    for (const b of sources) {
      const l = cache[key(b)];
      if (l?.status !== 'ok') continue;
      for (const f of l.data.files) {
        const e = files.get(f.path) ?? { add: 0, del: 0, by: [], status: f.status };
        e.add += f.additions;
        e.del += f.deletions;
        e.by.push(b);
        files.set(f.path, e);
      }
    }
    return [...files.entries()].sort((a, b) => b[1].by.length - a[1].by.length || a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sources, cache, own]);

  if (!target) return <div className="mp-empty">Choose a target to see what would land in it.</div>;
  if (!sources.length) return <div className="mp-empty">Add a source branch to preview its changes.</div>;

  const cur = tab === '__all' ? null : cache[key(tab)];
  const loadingAll = tab === '__all' && sources.some((b) => cache[key(b)]?.status === 'loading' || !cache[key(b)]);

  return (
    <div className="mp">
      <div className="mp-tabs">
        {sources.length > 1 && (
          <button className={`mp-tab ${tab === '__all' ? 'on' : ''}`} onClick={() => setTab('__all')}>
            ✦ All sources
          </button>
        )}
        {sources.map((b) => {
          const l = cache[key(b)];
          return (
            <button key={b} className={`mp-tab ${tab === b ? 'on' : ''}`} style={{ ['--bc' as string]: branchColor(b) }} onClick={() => setTab(b)} title={own[b] !== undefined ? `Only ${b}'s own changes (on top of ${own[b] || '…'})` : `Everything ${b} brings into ${target}`}>
              <span className="mp-dot" />
              <span className="ellipsis mono">{b}</span>
              {own[b] !== undefined && <span title="own changes only">🎯</span>}
              {l?.status === 'ok' && <span className="mp-n">{l.data.files.length}</span>}
            </button>
          );
        })}
      </div>

      {tab === '__all' && (
        <div className="mp-all">
          {loadingAll && <div className="small muted mm-shimmer">Analysing every source…</div>}
          {combined && combined.length === 0 && !loadingAll && <div className="mp-empty">Nothing new would land in {target}.</div>}
          {combined && combined.length > 0 && (
            <>
              <div className="small muted mb">
                {combined.length} file(s) would change in <strong>{target}</strong>
                {combined.some(([, e]) => e.by.length > 1) && <span className="text-warn"> · ⚡ files changed by more than one source are listed first</span>}
              </div>
              <div className="mp-table">
                {combined.map(([path, e]) => (
                  <div key={path} className={`mp-row ${e.by.length > 1 ? 'hot' : ''}`}>
                    <span className={`fx-st ${e.status}`}>{e.status[0].toUpperCase()}</span>
                    <span className="mono ellipsis grow" title={path}>
                      {path}
                    </span>
                    <span className="mp-by">
                      {e.by.map((b) => (
                        <button key={b} className="mp-by-dot" style={{ background: branchColor(b) }} title={`${b} — open its diff`} onClick={() => setTab(b)} />
                      ))}
                    </span>
                    <span className="fx-num add">+{e.add}</span>
                    <span className="fx-num del">−{e.del}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab !== '__all' && (
        <div className="mp-one">
          {own[tab] === '' && <div className="mp-empty">Choose the branch {tab} was made from to preview its own changes.</div>}
          {cur?.status === 'loading' && <div className="small muted mm-shimmer">Comparing {tab} with {baseOf(tab)}…</div>}
          {cur?.status === 'error' && <div className="banner danger small">{cur.message}</div>}
          {cur?.status === 'ok' && (
            <>
              <div className="mp-sum">
                <span>
                  <strong>{cur.data.ahead}</strong> commit{cur.data.ahead === 1 ? '' : 's'}
                </span>
                <span>{cur.data.files.length} files</span>
                <span className="text-ok">+{cur.data.additions}</span>
                <span className="text-danger">−{cur.data.deletions}</span>
                <span className="muted small">
                  {own[tab] !== undefined ? `only ${tab}'s own changes, on top of ${own[tab]}` : `everything ${tab} brings into ${target}`}
                  {cur.data.behind > 0 && own[tab] === undefined ? ` · ${target} is ${cur.data.behind} commit(s) ahead (kept)` : ''}
                </span>
                <span className="spacer" />
                {cur.data.commits.length > 0 && (
                  <button className="btn sm ghost" onClick={() => setShowCommits((s) => !s)}>
                    {showCommits ? 'Hide' : 'Show'} commits
                  </button>
                )}
              </div>
              {showCommits && (
                <div className="mp-commits">
                  {cur.data.commits.map((c) => (
                    <div key={c.hash} className="mp-commit">
                      <span className="mono small muted">{c.shortHash}</span>
                      <span className="ellipsis grow">{c.subject}</span>
                      <span className="small muted">
                        {c.author} · {relative(c.date)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {cur.data.files.length === 0 ? (
                <div className="mp-empty">✓ {target} already has everything from {tab}.</div>
              ) : (
                <>
                  <div className="mp-how">
                    <span className="small muted">Choose what to merge by</span>
                    <div className="seg">
                      <button className={(modes[pickKey(tab, baseOf(tab))] ?? 'files') === 'files' ? 'on' : ''} onClick={() => setMode(pickKey(tab, baseOf(tab)), 'files')} title="Tick files, or individual lines">
                        ✂ Files &amp; lines
                      </button>
                      <button className={modes[pickKey(tab, baseOf(tab))] === 'commits' ? 'on' : ''} onClick={() => setMode(pickKey(tab, baseOf(tab)), 'commits')} title="Tick the commits to bring over">
                        🧩 Commits
                      </button>
                    </div>
                  </div>
                  <div className="mp-pick-hint small">
                    {modes[pickKey(tab, baseOf(tab))] === 'commits' ? (
                      <>☑ Tick the commits you want. <strong>Review merge</strong> then brings only those into {target}.</>
                    ) : (
                      <>☑ Untick files — or click / drag over lines — to leave them out. <strong>Review merge</strong> then brings only what is ticked into {target}.</>
                    )}
                  </div>
                  {modes[pickKey(tab, baseOf(tab))] === 'commits' ? (
                    <CommitPicker
                      repoId={repoId}
                      source={tab}
                      base={baseOf(tab)}
                      target={target}
                      revision={revision}
                      selected={commitSel[pickKey(tab, baseOf(tab))] ?? new Set()}
                      setSelected={(fn) => setCommitSel(pickKey(tab, baseOf(tab)), fn)}
                      onLoaded={(all, head) => {
                        const k = pickKey(tab, baseOf(tab));
                        const fresh = !commitSel[k];
                        onCommits(k, all, head);
                        if (fresh) setCommitSel(k, () => new Set(all));
                      }}
                    />
                  ) : (
                  <PickChanges
                    repoId={repoId}
                    source={tab}
                    base={baseOf(tab)}
                    preloaded={cur.data}
                    compact
                    picks={picks[pickKey(tab, baseOf(tab))] ?? new Map()}
                    setPicks={(fn) => setPicks(pickKey(tab, baseOf(tab)), fn)}
                    onLoaded={(_, files, head) => {
                      const k = pickKey(tab, baseOf(tab));
                      onFiles(k, files, head);
                      // Everything is ticked until the user leaves something out.
                      if (!picks[k]) setPicks(k, () => new Map(files.map((f) => [f, 'all' as const])));
                    }}
                  />
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
