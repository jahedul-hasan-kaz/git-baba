import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { layoutGraph, type GraphRow } from '../../shared/graphLayout';
import type { CommitDetails, CommitStatFile, CompareResult, FriendlyError, GraphCommit, HistoryQuery, HistoryScope, RepoStatus } from '../../shared/types';
import { ChangesPage } from './ChangesPage';
import { CleanSlate } from './changes/CleanSlate';
import { relative } from '../components/FileDiffList';
import { ErrorPanel } from '../components/ErrorPanel';
import { Spinner } from '../components/Modal';
import { announceFilter, CLEAR_EVENT, JUMP_EVENT, takeJump } from '../services/jump';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';

import { Select } from '../components/Select';
import { useCommitActions, type CommitAction } from './history/CommitActions';
import { CommitFilesExplorer } from './history/CommitFilesExplorer';
import { CommitMenu, type CompareKind } from './history/CommitMenu';
import { authorColor, initials } from './history/graphStyle';
import { RefActionsContext, RefChip, type RefActions } from './history/RefChip';
import { Modal } from '../components/Modal';
import { SwitchBranchDialog } from '../dialogs/BranchDialogs';

const ROW_H = 58;
const LANE_W = 20;
const COLORS = ['#5b8cff', '#3ecf8e', '#f5b84a', '#ff6b6b', '#b18cff', '#6cc4ff', '#ff9f6b', '#9fd36b'];
const laneX = (i: number) => i * LANE_W + LANE_W / 2;
const color = (i: number) => COLORS[i % COLORS.length];
/** Stable colour per branch name, so the same branch reads the same everywhere in the list. */
const branchColor = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};

function BranchChip({ name }: { name: string; title?: string }) {
  const remote = /^[^/]+\/./.test(name) && name.startsWith('origin/');
  return <RefChip name={name} kind={remote ? 'remote' : 'made-on'} color={branchColor(name)} title={`Made on ${name} — click for actions`} />;
}

function MergedMark({ main }: { main: string }) {
  return (
    <span className="merged-mark" title={`Already merged into ${main}`}>
      ✓ in {main.replace(/^origin\//, '')}
    </span>
  );
}

/** One row of the commit graph: lane lines in, an author-avatar node, and edges out to the parents. */
function GraphCell({ row, width, commit, isHead, wipAbove, hot }: { row: GraphRow; width: number; commit: GraphCommit; isHead: boolean; wipAbove: boolean; hot: boolean }) {
  const mid = ROW_H / 2;
  const els: ReactElement[] = [];
  row.before.forEach((v, i) => {
    if (!v) return;
    if (v === row.hash) els.push(<path key={`in${i}`} d={`M${laneX(i)} 0 C ${laneX(i)} ${mid * 0.6}, ${laneX(row.lane)} ${mid * 0.4}, ${laneX(row.lane)} ${mid}`} stroke={color(i)} />);
    else if (row.after[i] === v) els.push(<line key={`pass${i}`} x1={laneX(i)} y1={0} x2={laneX(i)} y2={ROW_H} stroke={color(i)} />);
    else els.push(<line key={`end${i}`} x1={laneX(i)} y1={0} x2={laneX(i)} y2={mid} stroke={color(i)} />);
  });
  row.parentLanes.forEach((j, k) =>
    els.push(<path key={`out${k}`} d={`M${laneX(row.lane)} ${mid} C ${laneX(row.lane)} ${mid + mid * 0.6}, ${laneX(j)} ${mid + mid * 0.4}, ${laneX(j)} ${ROW_H}`} stroke={color(j)} />),
  );
  if (wipAbove) els.push(<line key="wip" x1={laneX(row.lane)} y1={0} x2={laneX(row.lane)} y2={mid} stroke={color(row.lane)} strokeDasharray="3 3" />);
  const cx = laneX(row.lane);
  const c = color(row.lane);
  return (
    <svg width={width} height={ROW_H} className={`graph-cell ${hot ? 'hot' : ''}`} fill="none" strokeWidth={2}>
      {els}
      {isHead && <circle cx={cx} cy={mid} r={12.5} className="g-head-halo" stroke={c} />}
      {row.isMerge ? (
        <>
          <circle cx={cx} cy={mid} r={6} fill="var(--bg)" stroke={c} strokeWidth={2.5} />
          <circle cx={cx} cy={mid} r={2} fill={c} />
        </>
      ) : (
        <g className="g-node">
          <circle cx={cx} cy={mid} r={9.5} fill={authorColor(commit.email || commit.author)} stroke={c} strokeWidth={2} />
          <text x={cx} y={mid + 3} textAnchor="middle" className="g-initials">
            {initials(commit.author)}
          </text>
        </g>
      )}
    </svg>
  );
}

/** Tags created on a commit, as interactive chips (the first `max`; the rest behind a "+N" toggle). */
function TagChips({ refs, max = 2 }: { refs: string[]; max?: number }) {
  const [all, setAll] = useState(false);
  const tags = refs.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
  if (tags.length === 0) return null;
  const shown = all ? tags : tags.slice(0, max);
  return (
    <>
      {shown.map((t) => (
        <RefChip key={t} name={t} kind="tag" color="#f5b84a" />
      ))}
      {tags.length > max && (
        <span
          className="rchip more"
          title={all ? 'Show fewer' : tags.slice(max).join('\n')}
          onClick={(e) => {
            e.stopPropagation();
            setAll((a) => !a);
          }}
        >
          {all ? '−' : `+${tags.length - max}`}
        </span>
      )}
    </>
  );
}

/** The release a commit first shipped in (nearest tag containing it). Hidden when the tag sits on the commit itself. */
function ReleaseChip({ info, full }: { info: GraphCommit['releasedIn']; full?: boolean }) {
  if (!info || (info.exact && !full)) return null;
  return (
    <span className="release-chip" title={info.exact ? `Tagged ${info.tag}` : `First released in ${info.tag} — the nearest tag that contains this commit`}>
      📦 {info.exact ? info.tag : `in ${info.tag}`}
    </span>
  );
}

type Slot = 'A' | 'B';
const DRAG_MIME = 'application/x-gitbaba-commit';

/** Drop target for one side of a comparison. */
function CompareSlot({ slot, commit, active, onDropHash, onClear }: { slot: Slot; commit: GraphCommit | null; active: boolean; onDropHash: (hash: string) => void; onClear: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`cmp-slot ${commit ? 'filled' : ''} ${over ? 'over' : ''} ${active ? 'armed' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const h = e.dataTransfer.getData(DRAG_MIME);
        if (h) onDropHash(h);
      }}
    >
      <span className={`cmp-letter ${slot}`}>{slot}</span>
      {commit ? (
        <div className="cmp-body">
          <div className="mono small">{commit.shortHash}</div>
          <div className="ellipsis small">{commit.subject}</div>
        </div>
      ) : (
        <div className="cmp-body muted small">{slot === 'A' ? 'Drop the base (older) commit here' : 'Drop the commit to compare with'}</div>
      )}
      {commit && (
        <button className="cmp-x" title="Clear" onClick={onClear}>
          ✕
        </button>
      )}
    </div>
  );
}

/** Branch refs as interactive chips: "main" + "origin/main" become one chip with a cloud, HEAD is filled. */
function RefPills({ refs, laneColor, remotes, max = 2 }: { refs: string[]; laneColor: string; remotes: Set<string>; max?: number }) {
  const [all, setAll] = useState(false);
  const groups = new Map<string, { local: boolean; remotes: string[]; head: boolean }>();
  for (const r of refs) {
    if (r.startsWith('tag: ') || r === 'HEAD' || r.endsWith('/HEAD')) continue;
    const head = r.startsWith('HEAD -> ');
    const name = r.replace(/^HEAD -> /, '');
    const slash = name.indexOf('/');
    const isRemote = !head && slash > 0 && remotes.has(name.slice(0, slash));
    const key = isRemote ? name.slice(slash + 1) : name;
    const g = groups.get(key) ?? { local: false, remotes: [], head: false };
    if (isRemote) g.remotes.push(name.slice(0, slash));
    else g.local = true;
    g.head ||= head;
    groups.set(key, g);
  }
  const list = [...groups.entries()].sort((a, b) => Number(b[1].head) - Number(a[1].head));
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, max);
  return (
    <>
      {shown.map(([name, g]) =>
        g.local ? (
          <RefChip key={name} name={name} kind="local" head={g.head} remotes={g.remotes} color={laneColor} />
        ) : (
          <RefChip key={name} name={`${g.remotes[0]}/${name}`} kind="remote" color={laneColor} />
        ),
      )}
      {list.length > max && (
        <span
          className="rchip more"
          title={all ? 'Show fewer' : list.slice(max).map(([n]) => n).join('\n')}
          onClick={(e) => {
            e.stopPropagation();
            setAll((a) => !a);
          }}
        >
          {all ? '−' : `+${list.length - max}`}
        </span>
      )}
    </>
  );
}

/** Where to jump in the graph (a branch or tag picked in the workspace rail). */
export interface GraphFocus {
  oid: string;
  ref: string;
  /** Bumped on every request, so picking the same ref twice still jumps. */
  n: number;
}

interface Props {
  /**
   * Inside the Changes workspace: the right pane also hosts the working changes ("WIP"), whose
   * file diff opens over the graph, and the head / dirty state comes from the live status.
   */
  workspace?: {
    status: RepoStatus | null;
    reload: () => Promise<void>;
    error: FriendlyError | null;
    focus: GraphFocus | null;
  };
}

export function GitHistoryPage({ workspace }: Props = {}) {
  const { activeRepo, revision, bump, toast, showError } = useApp();
  const repoId = activeRepo!.id;
  const ws = workspace ?? null;
  const [refs, setRefs] = useState<{ current: string | null; branches: string[]; remotes: string[]; tags: string[] } | null>(null);
  const [authors, setAuthors] = useState<{ name: string; email: string; commits: number }[]>([]);
  // The workspace shows every branch by default (like a repository map) and remembers the choice.
  const [scope, setScopeRaw] = useState<string>(() => {
    if (!ws) return 'current';
    try {
      const s = localStorage.getItem('gb.ws.scope');
      return s === 'current' || s === 'all' || s === 'remotes' || s === 'tags' ? s : 'all';
    } catch {
      return 'all';
    }
  });
  const setScope = (s: string) => {
    setScopeRaw(s);
    if (ws && !s.startsWith('ref:'))
      try {
        localStorage.setItem('gb.ws.scope', s);
      } catch {
        /* per-viewer convenience */
      }
  };
  // Workspace: the right pane shows the working changes until a commit is opened.
  const [wip, setWip] = useState(!!ws);
  const [diffHost, setDiffHost] = useState<HTMLDivElement | null>(null);
  const pendingFocus = useRef<GraphFocus | null>(null);
  const [author, setAuthor] = useState('');
  const [sinceDays, setSinceDays] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [slots, setSlots] = useState<[string | null, string | null]>([null, null]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const pair = slots.filter((h): h is string => !!h);
  const [comparison, setComparison] = useState<CompareResult | null>(null);
  const [mainRef, setMainRef] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; commit: GraphCommit } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<'sidebar' | 'modal'>(() => {
    try {
      return localStorage.getItem('gb.history.placement') === 'modal' ? 'modal' : 'sidebar';
    } catch {
      return 'sidebar';
    }
  });
  const [paneW, setPaneW] = useState<number>(() => {
    try {
      // The workspace keeps the graph wider by default: the rail already takes room on the left.
      return Number(localStorage.getItem(ws ? 'gb.ws.paneW' : 'gb.history.paneW')) || (ws ? 40 : 54);
    } catch {
      return 54;
    }
  });
  const [modalOpen, setModalOpen] = useState(false);
  const [switching, setSwitching] = useState<{ target: string; kind: 'local' | 'remote' } | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [head, setHead] = useState<{ oid: string | null; dirty: number; branch: string | null; detached: boolean }>({ oid: null, dirty: 0, branch: null, detached: false });
  const [hoverBranch, setHoverBranch] = useState<string | null>(null);
  const [remoteNames, setRemoteNames] = useState<Set<string>>(new Set(['origin']));
  const { setRepoTab } = useApp();

  useEffect(() => {
    try {
      localStorage.setItem(ws ? 'gb.ws.paneW' : 'gb.history.paneW', String(Math.round(paneW)));
    } catch {
      /* per-viewer convenience */
    }
  }, [paneW]);

  useEffect(() => {
    const take = () => {
      const j = takeJump('commit', repoId);
      if (!j) return;
      setSearchInput(j.hash);
      setSearch(j.hash);
      setWip(false);
      setSelected(j.hash);
      if (placement === 'modal') setModalOpen(true);
    };
    take();
    window.addEventListener(JUMP_EVENT, take);
    return () => window.removeEventListener(JUMP_EVENT, take);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  // The tab bar shows "Clear search" while a filter is on.
  useEffect(() => {
    announceFilter(!!search);
  }, [search]);
  useEffect(() => {
    const clear = () => {
      setSearchInput('');
      setSearch('');
    };
    window.addEventListener(CLEAR_EVENT, clear);
    return () => {
      window.removeEventListener(CLEAR_EVENT, clear);
      announceFilter(false);
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    call('graph:refs', { repoId })
      .then((r) => {
        setRefs(r);
        setRemoteNames(new Set(r.remotes.map((x) => x.split('/')[0])));
      })
      .catch(() => setRefs(null));
    call('graph:authors', { repoId }).then(setAuthors).catch(() => setAuthors([]));
    if (ws) return;
    call('git:status', { repoId })
      .then((st) => setHead({ oid: st.headOid, dirty: st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length, branch: st.branch, detached: st.detached }))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, revision]);

  // Workspace: head and the working-changes count follow the live status (refreshed in the background).
  const wsStatus = ws?.status ?? null;
  useEffect(() => {
    if (!wsStatus) return;
    const st = wsStatus;
    setHead({ oid: st.headOid, dirty: st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length, branch: st.branch, detached: st.detached });
  }, [wsStatus]);
  // A new commit moves HEAD: reload the graph so it shows up straight away.
  const lastHead = useRef<string | null>(null);
  useEffect(() => {
    if (!ws || !head.oid) return;
    if (lastHead.current && lastHead.current !== head.oid) bump();
    lastHead.current = head.oid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head.oid]);

  const query = useMemo<HistoryQuery>(() => {
    const [kind, ref] = scope.includes(':') ? scope.split(/:(.+)/) : [scope];
    return { scope: (ref ? 'ref' : kind) as HistoryScope, ref, author: author || undefined, sinceDays: sinceDays ?? undefined, search: search || undefined, limit: 300 };
  }, [scope, author, sinceDays, search]);

  const load = useCallback(
    async (append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const r = await call('graph:log', { repoId, query: { ...query, skip: append ? commits.length : 0 } });
        setCommits((c) => (append ? [...c, ...r.commits] : r.commits));
        setHasMore(r.hasMore);
        setMainRef(r.mainRef);
      } catch (err) {
        setError(toFriendly(err));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoId, query],
  );

  useEffect(() => {
    void load(false);
  }, [load, revision]);

  useEffect(() => {
    if (!selected) return setDetails(null);
    let cancelled = false;
    setDetailsLoading(true);
    call('graph:commit', { repoId, hash: selected })
      .then((d) => !cancelled && setDetails(d))
      .catch((err) => !cancelled && showError(err))
      .finally(() => !cancelled && setDetailsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected, repoId, showError]);

  const actions = useCommitActions({ repoId, current: head.detached ? null : head.branch, branches: refs?.branches ?? [], tags: refs?.tags ?? [], onChanged: bump });
  const runAction = (a: CommitAction, c: GraphCommit, opts?: { mode?: string }) => void actions.run(a, c, opts);

  const { rows, maxLanes } = useMemo(() => layoutGraph(commits), [commits]);
  const graphWidth = Math.min(maxLanes, 12) * LANE_W + 6;
  const index = selected ? commits.findIndex((c) => c.hash === selected) : -1;

  const navigate = useCallback(
    (delta: number) => {
      const next = commits[Math.max(0, Math.min(commits.length - 1, (index === -1 ? -1 : index) + delta))];
      if (!next) return;
      setWip(false);
      setSelected(next.hash);
      setComparison(null);
      const el = listRef.current?.querySelector(`[data-hash="${next.hash}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    },
    [commits, index],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'SELECT') return;
      // Keys already handled by the working-changes board, the diff or the rail stay there.
      if (e.defaultPrevented || (e.target as HTMLElement).closest?.('.cb-left, .ws-diff-host, .ws-rail')) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        navigate(1);
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        navigate(-1);
      }
      if (document.querySelector('.modal-backdrop, .cm')) return;
      if (ws && e.key === 'w' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        return openWip();
      }
      const c = index >= 0 ? commits[index] : null;
      if (!c || e.ctrlKey || e.metaKey || e.altKey) return;
      const keys: Record<string, CommitAction> = { c: 'copy-sha', b: 'branch', t: 'tag', p: 'cherry-pick' };
      if (keys[e.key]) {
        e.preventDefault();
        runAction(keys[e.key], c);
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = listRef.current?.querySelector(`[data-hash="${c.hash}"]`)?.getBoundingClientRect();
        if (r) setMenu({ x: r.left + 120, y: r.top + r.height / 2, commit: c });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, index, commits]);

  // A branch or tag picked in the rail: open its tip commit, showing that ref if it is not loaded.
  const openFocus = useCallback(
    (f: GraphFocus) => {
      if (!commits.some((c) => c.hash === f.oid)) return false;
      setWip(false);
      setSelected(f.oid);
      setComparison(null);
      if (placement === 'modal') setModalOpen(true);
      requestAnimationFrame(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-hash="${f.oid}"]`);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el?.classList.remove('ws-ping');
        void el?.offsetWidth;
        el?.classList.add('ws-ping');
      });
      return true;
    },
    [commits, placement],
  );
  const focus = ws?.focus ?? null;
  useEffect(() => {
    if (!focus) return;
    if (!openFocus(focus)) {
      pendingFocus.current = focus;
      setScopeRaw(`ref:${focus.ref}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);
  useEffect(() => {
    const f = pendingFocus.current;
    if (f && !loading && openFocus(f)) pendingFocus.current = null;
  }, [commits, loading, openFocus]);

  const openWip = () => {
    setWip(true);
    setSelected(null);
    setComparison(null);
    setModalOpen(false);
  };

  const clickCommit = (hash: string) => {
    setWip(false);
    if (compareMode) {
      setSlots(([a, b]) => (a === hash ? [null, b] : b === hash ? [a, null] : !a ? [hash, b] : [a, hash]));
      return;
    }
    setSelected(hash);
    setComparison(null);
    if (placement === 'modal') setModalOpen(true);
  };

  const pos = (h: string) => commits.findIndex((c) => c.hash === h);
  /** Older of the two first, so the diff reads "from A to B". */
  const oriented = (x: string, y: string): [string, string] => (pos(x) >= pos(y) ? [x, y] : [y, x]);

  const runCompare = async (a = slots[0], b = slots[1]) => {
    if (!a || !b || a === b) return;
    try {
      setComparison(await call('graph:compare', { repoId, from: a, to: b }));
      setSelected(null);
      setWip(false);
      if (placement === 'modal') setModalOpen(true);
    } catch (err) {
      showError(err);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await call('app:copyText', { text });
      toast(`${what} copied`);
    } catch (err) {
      showError(err);
    }
  };

  // Both sides filled (by click, drag or drop): compare straight away.
  useEffect(() => {
    if (compareMode && slots[0] && slots[1] && slots[0] !== slots[1]) void runCompare(slots[0], slots[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareMode, slots[0], slots[1]]);

  const dropToSlot = (slot: Slot, hash: string) => {
    setCompareMode(true);
    setSlots(([a, b]) => (slot === 'A' ? [hash, b === hash ? null : b] : [a === hash ? null : a, hash]));
  };
  const exitCompare = () => {
    setCompareMode(false);
    setSlots([null, null]);
    setComparison(null);
  };
  const compareFromMenu = (k: CompareKind, c: GraphCommit) => {
    if (k === 'A' || k === 'B') return dropToSlot(k, c.hash);
    const other = k === 'selected' ? selected : k === 'head' ? head.oid : c.parents[0];
    if (!other) return;
    exitCompare();
    // Older side first: the parent, or whichever of the two is lower in the list.
    const [a, b] = k === 'parent' ? [other, c.hash] : pos(other) === -1 ? [c.hash, other] : oriented(other, c.hash);
    void runCompare(a, b);
  };
  const slotCommit = (h: string | null | undefined) => (h ? commits.find((c) => c.hash === h) ?? null : null);

  // Commits between the two compared ones, highlighted as a range in the list.
  const range = useMemo(() => {
    if (!comparison) return null;
    const i = commits.findIndex((c) => c.hash === comparison.from.hash);
    const j = commits.findIndex((c) => c.hash === comparison.to.hash);
    if (i === -1 || j === -1) return null;
    return { lo: Math.min(i, j), hi: Math.max(i, j) };
  }, [comparison, commits]);

  useEffect(() => {
    if (!compareMode) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !menu && exitCompare();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compareMode, menu]);

  const mainShort = mainRef?.replace(/^origin\//, '') ?? null;
  const onMain = (c: GraphCommit) => !!c.branch && (c.branch === mainRef || c.branch === mainShort);
  const selectedCommit = selected ? commits.find((c) => c.hash === selected) ?? null : null;

  const countBy = (files: CommitStatFile[], s: CommitStatFile['status']) => files.filter((f) => f.status === s).length;

  const refActions: RefActions = {
    filter: (r) => setScope(`ref:${r}`),
    switchTo: (name, kind) => setSwitching({ target: name, kind }),
    copy: (text, what) => void copy(text, what),
    current: head.detached ? null : head.branch,
  };

  const wipPane = ws && wip && (
    <ChangesPage
      status={ws.status}
      reload={ws.reload}
      error={ws.error}
      docked={{
        diffHost,
        clean: ws.status ? (
          <CleanSlate
            repoId={repoId}
            status={ws.status}
            compact
            onOpenCommit={(hash) => {
              if (commits.some((c) => c.hash === hash)) clickCommit(hash);
            }}
          />
        ) : null,
      }}
    />
  );

  const showSide = placement === 'sidebar' || (!!ws && wip);
  const pane = (
    <>
          {ws && !wip && (comparison || !details) && (
            <button className="ws-back" onClick={openWip} title="Back to your working changes (W)">
              <span className="ws-back-ico">✎</span>
              <span className="grow">
                {head.dirty ? (
                  <>
                    <strong>{head.dirty}</strong> working change{head.dirty === 1 ? '' : 's'} on {head.branch ?? 'HEAD'}
                  </>
                ) : (
                  <>Working tree clean on {head.branch ?? 'HEAD'}</>
                )}
              </span>
              <span className="small muted">← back</span>
            </button>
          )}
          {comparison && (
            <>
              <div className="row mb">
                <h2 className="grow" style={{ margin: 0 }}>
                  Compare
                </h2>
                <button className="btn sm" title="Swap direction (B → A)" onClick={() => (compareMode ? setSlots([comparison.to.hash, comparison.from.hash]) : void runCompare(comparison.to.hash, comparison.from.hash))}>
                  ⇄ Swap
                </button>
                <button className="btn sm" onClick={exitCompare}>
                  Close comparison
                </button>
              </div>
              <div className="card">
                <div className="mono">
                  {comparison.from.shortHash} <span className="muted">{comparison.from.subject}</span>
                </div>
                <div className="muted small">vs</div>
                <div className="mono">
                  {comparison.to.shortHash} <span className="muted">{comparison.to.subject}</span>
                </div>
                {range && (
                  <div className="small muted mt">
                    {range.hi - range.lo} commit(s) apart — the range is highlighted in the list
                    {slotCommit(comparison.from.hash)?.releasedIn?.tag !== slotCommit(comparison.to.hash)?.releasedIn?.tag && (
                      <>
                        {' '}· {slotCommit(comparison.from.hash)?.releasedIn?.tag ?? 'unreleased'} → {slotCommit(comparison.to.hash)?.releasedIn?.tag ?? 'unreleased'}
                      </>
                    )}
                  </div>
                )}
                {range && range.hi > range.lo && (
                  <div className="range-ribbon" title="Commits in this range — click one to open it">
                    <span className="cmp-letter A">A</span>
                    <div className="range-track">
                      {commits
                        .slice(range.lo, range.hi + 1)
                        .reverse()
                        .slice(0, 40)
                        .map((c) => (
                          <button
                            key={c.hash}
                            className="range-dot"
                            style={{ background: authorColor(c.email || c.author) }}
                            title={`${c.shortHash} · ${c.subject}\n${c.author} · ${relative(c.date)}`}
                            onClick={() => {
                              exitCompare();
                              setSelected(c.hash);
                            }}
                          >
                            {initials(c.author)}
                          </button>
                        ))}
                      {range.hi - range.lo + 1 > 40 && <span className="small muted">+{range.hi - range.lo + 1 - 40}</span>}
                    </div>
                    <span className="cmp-letter B">B</span>
                  </div>
                )}
                <div className="row mt">
                  <span className="badge">{comparison.files.length} files changed</span>
                  <span className="badge ok">+{comparison.additions}</span>
                  <span className="badge danger">−{comparison.deletions}</span>
                  <span className="small muted">
                    {countBy(comparison.files, 'added')} added · {countBy(comparison.files, 'deleted')} removed · {countBy(comparison.files, 'modified')} modified · {countBy(comparison.files, 'renamed')} renamed
                  </span>
                </div>
              </div>
              <CommitFilesExplorer repoId={repoId} files={comparison.files} diffs={comparison.diffs} atCommit={comparison.to.hash} dockHost={diffHost} context={`Compare ${comparison.from.shortHash} → ${comparison.to.shortHash}`} />
            </>
          )}
          {!comparison && !selected && !wip && <div className="empty">Select a commit to see its details. Use ↑ / ↓ to move between commits.</div>}
          {!comparison && selected && detailsLoading && !details && <Spinner label="Loading commit…" />}
          {!comparison && details && (
            <>
              <div className="cd-head">
                {selectedCommit && (
                  <div className="cd-bar">
                    <button className="cab" onClick={() => navigate(-1)} disabled={index <= 0} title="Newer commit (↑)">
                      <span className="cab-ico">↑</span>
                    </button>
                    <button className="cab" onClick={() => navigate(1)} disabled={index === -1 || index >= commits.length - 1} title="Older commit (↓)">
                      <span className="cab-ico">↓</span>
                    </button>
                    <span className="spacer" />
                    {ws && (
                      <button className={`cd-wip ${head.dirty ? 'dirty' : ''}`} onClick={openWip} title={`Back to your working changes on ${head.branch ?? 'HEAD'} (W)`}>
                        <span className="cd-wip-ico">←</span>
                        <span className="cd-wip-label">Working changes</span>
                        <span className="cd-wip-count">{head.dirty || '✓'}</span>
                      </button>
                    )}
                    <button
                      className="cab more"
                      title="Cherry-pick, branch, tag, checkout, reset, rebase… (right-click a commit)"
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setMenu({ x: r.left - 180, y: r.bottom + 4, commit: selectedCommit });
                      }}
                    >
                      <span className="cab-ico">⋯</span>
                    </button>
                  </div>
                )}
                <h2 className={`commit-title ${showInfo ? '' : 'ellipsis'}`} title={details.subject} onClick={() => setShowInfo((v) => !v)}>
                  {details.subject}
                </h2>
                <div className="commit-summary">
                  <span className="cd-avatar" style={{ background: authorColor(details.email || details.author) }}>
                    {initials(details.author)}
                  </span>
                  <span className="ellipsis" title={details.email}>{details.author}</span>
                  <span className="muted">{relative(details.date)}</span>
                  <button className="cd-sha mono" onClick={() => copy(details.hash, 'Commit SHA')} title="Copy full SHA (C)">
                    {details.hash.slice(0, 7)} <span className="cd-sha-ico">⧉</span>
                  </button>
                  <span className="mono">
                    <span className="text-ok">+{details.additions}</span> <span className="text-danger">−{details.deletions}</span>
                  </span>
                  {selectedCommit?.merged && <span className="text-ok" title={`${mainRef} contains this commit`}>✓ {mainShort}</span>}
                  <span className="ref-group">
                    <RefPills refs={details.refs} laneColor={branchColor(selectedCommit?.branch ?? details.hash)} remotes={remoteNames} max={2} />
                    <TagChips refs={details.refs} max={2} />
                  </span>
                  <button className={`cd-more ${showInfo ? 'on' : ''}`} onClick={() => setShowInfo((v) => !v)} title="Message, parents, release and more">
                    Details <span className="cd-caret">▾</span>
                  </button>
                </div>
              </div>
              {showInfo && (
                <div className="cd-info">
                  {details.body && <pre className="commit-body compact">{details.body}</pre>}
                  <div className="cd-tiles">
                    <button className="cd-tile wide" onClick={() => copy(details.hash, 'Commit SHA')} title="Copy full SHA">
                      <span className="cd-k">Commit</span>
                      <span className="cd-v mono ellipsis">{details.hash}</span>
                      <span className="cd-act">⧉</span>
                    </button>
                    <button className="cd-tile" onClick={() => copy(details.email, 'Email')} title={`Copy ${details.email}`}>
                      <span className="cd-k">Author</span>
                      <span className="cd-v ellipsis">{details.author}</span>
                      <span className="cd-sub ellipsis">{details.email}</span>
                    </button>
                    <div className="cd-tile" title={new Date(details.date).toLocaleString()}>
                      <span className="cd-k">Date</span>
                      <span className="cd-v">{relative(details.date)}</span>
                      <span className="cd-sub ellipsis">{new Date(details.date).toLocaleString()}</span>
                    </div>
                    {details.committer !== details.author && (
                      <div className="cd-tile">
                        <span className="cd-k">Committer</span>
                        <span className="cd-v ellipsis">{details.committer}</span>
                      </div>
                    )}
                    {selectedCommit?.branch && (
                      <div className="cd-tile">
                        <span className="cd-k">Made on</span>
                        <span className="cd-v">
                          <BranchChip name={selectedCommit.branch} />
                        </span>
                      </div>
                    )}
                    {mainRef && selectedCommit?.merged !== undefined && (
                      <div className={`cd-tile ${selectedCommit.merged ? 'ok' : 'warn'}`} title={selectedCommit.merged ? `${mainRef} contains this commit` : `Not merged into ${mainRef} yet`}>
                        <span className="cd-k">In {mainShort}</span>
                        <span className="cd-v">{selectedCommit.merged ? '✓ Merged' : 'Not yet'}</span>
                      </div>
                    )}
                    <div className="cd-tile">
                      <span className="cd-k">Release</span>
                      <span className="cd-v">{selectedCommit?.releasedIn ? <ReleaseChip info={selectedCommit.releasedIn} full /> : <span className="muted">Unreleased</span>}</span>
                    </div>
                    <div className="cd-tile">
                      <span className="cd-k">{details.parents.length > 1 ? 'Parents' : 'Parent'}</span>
                      <span className="cd-v cd-parents">
                        {details.parents.length === 0 ? (
                          <span className="muted">First commit</span>
                        ) : (
                          details.parents.map((p) => {
                            const loaded = commits.some((c) => c.hash === p);
                            return (
                              <button key={p} className="cd-link mono" disabled={!loaded} onClick={() => setSelected(p)} title={loaded ? 'Go to parent' : 'Not in the loaded list'}>
                                {p.slice(0, 7)} →
                              </button>
                            );
                          })
                        )}
                      </span>
                      {details.isMerge && <span className="cd-sub">diff vs first parent</span>}
                    </div>
                    <div className="cd-tile">
                      <span className="cd-k">Changes</span>
                      <span className="cd-v mono">
                        {details.files.length} <span className="muted">files</span> <span className="text-ok">+{details.additions}</span> <span className="text-danger">−{details.deletions}</span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
              <CommitFilesExplorer repoId={repoId} files={details.files} diffs={details.diffs} atCommit={details.hash} dockHost={diffHost} context={`${details.hash.slice(0, 7)} · ${details.subject} — ${details.author}`} />
            </>
          )}
    </>
  );

  return (
    <RefActionsContext.Provider value={refActions}>
    <div className="content flush" style={{ flexDirection: 'column' }}>
      <div className={`history-toolbar ${ws ? 'ws-toolbar' : ''}`}>
        {ws && (
          <button className={`ws-wip-pill ${wip ? 'on' : ''} ${head.dirty ? 'dirty' : ''}`} onClick={openWip} title="Your working changes: stage, review and commit (W)">
            <span>✎</span> Working changes
            {head.dirty > 0 && <span className="ws-wip-count">{head.dirty}</span>}
          </button>
        )}
        {!ws && <label className="small muted">Branch</label>}
        <Select kind="ref" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="current">Current branch{refs?.current ? ` (${refs.current})` : ''}</option>
          <option value="all">All branches, remotes & tags</option>
          <option value="remotes">Remote branches</option>
          <option value="tags">Tags</option>
          {refs?.branches.length ? (
            <optgroup label="Branches">
              {refs.branches.map((b) => (
                <option key={b} value={`ref:${b}`}>
                  {b}
                </option>
              ))}
            </optgroup>
          ) : null}
          {refs?.remotes.length ? (
            <optgroup label="Remote branches">
              {refs.remotes.map((b) => (
                <option key={b} value={`ref:${b}`}>
                  {b}
                </option>
              ))}
            </optgroup>
          ) : null}
          {refs?.tags.length ? (
            <optgroup label="Tags">
              {refs.tags.map((t) => (
                <option key={t} value={`ref:${t}`}>
                  {t}
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        {!ws && <label className="small muted">Author</label>}
        <Select kind="account" value={author} onChange={(e) => setAuthor(e.target.value)}>
          <option value="">All</option>
          {authors.map((a) => (
            <option key={a.email} value={a.email}>
              {a.name} ({a.commits})
            </option>
          ))}
        </Select>
        {!ws && <label className="small muted">Date</label>}
        <Select value={sinceDays ?? ''} onChange={(e) => setSinceDays(e.target.value ? Number(e.target.value) : null)}>
          <option value="">All</option>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last year</option>
        </Select>
        <span className="grow" />
        <button
          className={`btn sm ${compareMode ? 'primary' : ''}`}
          onClick={() => (compareMode ? exitCompare() : setCompareMode(true))}
          title="Compare two commits — click them, or drag any commit onto another"
        >
          ⇄ Compare
        </button>
        <div className="seg" title="Where commit details open">
          {(
            [
              ['sidebar', '▥', 'Details in a resizable sidebar'],
              ['modal', '⧉', 'Details in a pop-up window (list uses the full width)'],
            ] as ['sidebar' | 'modal', string, string][]
          ).map(([v, ico, t]) => (
            <button
              key={v}
              className={placement === v ? 'on' : ''}
              title={t}
              onClick={() => {
                setPlacement(v);
                setModalOpen(v === 'modal' && !!(selected || comparison));
                try {
                  localStorage.setItem('gb.history.placement', v);
                } catch {
                  /* per-viewer convenience */
                }
              }}
            >
              {ico}
            </button>
          ))}
        </div>
      </div>
      {actions.undoBar}
      {(compareMode || dragging) && (
        <div className={`cmp-tray ${dragging ? 'dragging' : ''}`}>
          <CompareSlot slot="A" commit={slotCommit(slots[0])} active={compareMode && !slots[0]} onDropHash={(h) => dropToSlot('A', h)} onClear={() => setSlots(([, y]) => [null, y])} />
          <button className="btn sm ghost cmp-swap" title="Swap A and B" disabled={!slots[0] && !slots[1]} onClick={() => setSlots(([x, y]) => [y, x])}>
            ⇄
          </button>
          <CompareSlot slot="B" commit={slotCommit(slots[1])} active={compareMode && !!slots[0] && !slots[1]} onDropHash={(h) => dropToSlot('B', h)} onClear={() => setSlots(([x]) => [x, null])} />
          <div className="cmp-hint small muted grow">
            {dragging
              ? 'Drop on A or B — or straight onto another commit to compare the two'
              : pair.length < 2
                ? 'Click commits or drag them here · drag a commit onto another to compare instantly · Esc to exit'
                : 'Comparing — drop another commit to change a side'}
          </div>
          {compareMode && (
            <button className="btn sm" onClick={exitCompare}>
              Done
            </button>
          )}
        </div>
      )}
      <div className="split hist-split" ref={splitRef} style={{ gridTemplateColumns: showSide ? `minmax(360px, ${100 - paneW}%) 6px minmax(${ws ? 340 : 0}px, 1fr)` : '1fr' }}>
        <div className={ws ? 'ws-center' : 'left-wrap'}>
        <div className="left" ref={listRef}>
          {error && (
            <div style={{ padding: 12 }}>
              <ErrorPanel error={error} />
            </div>
          )}
          {!loading && commits.length === 0 && !error && (ws && !ws.status?.headOid ? (
            <div className="ws-genesis">
              <div className="ws-genesis-dot" aria-hidden />
              <strong>No commits yet</strong>
              <span className="small muted">
                {head.dirty > 0
                  ? `${head.dirty} file${head.dirty === 1 ? '' : 's'} ready — stage and commit ${head.dirty === 1 ? 'it' : 'them'} on the right to start the history of ${ws.status?.branch ?? 'this branch'}.`
                  : 'Add or create files in this folder; they appear here, ready for the first commit.'}
              </span>
            </div>
          ) : (
            <div className="empty">No commits match these filters.</div>
          ))}
          {head.dirty > 0 && (commits[0]?.hash === head.oid || !!ws) && (
            <div
              className={`commit-row wip-row ${ws && wip ? 'selected' : ''}`}
              style={{ height: ROW_H }}
              onClick={() => (ws ? openWip() : setRepoTab('changes'))}
              title={ws ? 'Review, stage and commit your working changes (W)' : 'Open Changes to review and commit'}
            >
              <svg width={graphWidth} height={ROW_H} className="graph-cell" fill="none" strokeWidth={2}>
                {commits[0]?.hash === head.oid && <line x1={laneX(rows[0]?.lane ?? 0)} y1={ROW_H / 2} x2={laneX(rows[0]?.lane ?? 0)} y2={ROW_H} stroke={color(rows[0]?.lane ?? 0)} strokeDasharray="3 3" />}
                <circle cx={laneX(rows[0]?.lane ?? 0)} cy={ROW_H / 2} r={9} className="g-wip" stroke={color(rows[0]?.lane ?? 0)} />
              </svg>
              <div className="commit-text">
                <div className="commit-subject ellipsis">
                  <span className="wip-pill">✎ {head.dirty}</span>
                  <em className="subject-text">Working changes</em>
                </div>
                <div className="small muted commit-meta">uncommitted on {head.branch ?? 'detached HEAD'} · click to review &amp; commit</div>
              </div>
            </div>
          )}
          {commits.map((c, i) => (
            <div
              key={c.hash}
              data-hash={c.hash}
              className={`commit-row ${c.hash === head.oid ? 'is-head' : ''} ${hoverBranch && c.branch === hoverBranch ? 'lane-hl' : ''} ${selected === c.hash ? 'selected' : ''} ${pair.includes(c.hash) ? 'paired' : ''} ${range && i >= range.lo && i <= range.hi ? 'in-range' : ''} ${dragging === c.hash ? 'drag-src' : ''} ${dropOn === c.hash ? 'drop-on' : ''}`}
              style={{ height: ROW_H }}
              onClick={() => clickCommit(c.hash)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, c.hash);
                e.dataTransfer.setData('text/plain', c.hash);
                e.dataTransfer.effectAllowed = 'link';
                setDragging(c.hash);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropOn(null);
              }}
              onDragOver={(e) => {
                if (!dragging || dragging === c.hash) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'link';
                if (dropOn !== c.hash) setDropOn(c.hash);
              }}
              onDragLeave={() => dropOn === c.hash && setDropOn(null)}
              onDrop={(e) => {
                e.preventDefault();
                const h = e.dataTransfer.getData(DRAG_MIME);
                setDropOn(null);
                setDragging(null);
                if (!h || h === c.hash) return;
                setCompareMode(true);
                setSlots(oriented(h, c.hash));
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, commit: c });
              }}
              onMouseEnter={() => c.branch && setHoverBranch(c.branch)}
              onMouseLeave={() => setHoverBranch(null)}
            >
              <GraphCell row={rows[i]} width={graphWidth} commit={c} isHead={c.hash === head.oid} wipAbove={i === 0 && head.dirty > 0 && c.hash === head.oid} hot={!!hoverBranch && c.branch === hoverBranch} />
              <div className="commit-text">
                <div className="commit-subject ellipsis">
                  {compareMode && (slots[0] === c.hash || slots[1] === c.hash) && <span className={`cmp-letter sm ${slots[0] === c.hash ? 'A' : 'B'}`}>{slots[0] === c.hash ? 'A' : 'B'}</span>}
                  {c.refs.length > 0 && (
                    <span className="ref-group">
                      <RefPills refs={c.refs} laneColor={color(rows[i].lane)} remotes={remoteNames} />
                      <TagChips refs={c.refs} />
                    </span>
                  )}
                  <span className="subject-text">{c.subject}</span>
                </div>
                <div className="small muted commit-meta">
                  {/* The tip already carries the branch as a ref chip: no second chip for the same name. */}
                  {c.branch && !c.refs.some((r) => r.replace(/^HEAD -> /, '') === c.branch) && <BranchChip name={c.branch} />}
                  {c.merged && mainRef && !onMain(c) && <MergedMark main={mainRef} />}
                  <ReleaseChip info={c.releasedIn} />
                  <span className="ellipsis">
                    {c.author} · {relative(c.date)}
                  </span>
                  {c.parents.length > 1 && <span className="badge">merge</span>}
                  <span className="mono commit-sha">{c.shortHash}</span>
                </div>
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button title={`Cherry-pick onto ${head.branch ?? 'HEAD'} (P)`} disabled={c.hash === head.oid} onClick={() => runAction('cherry-pick', c)}>
                  🍒
                </button>
                <button title="Compare with HEAD" disabled={c.hash === head.oid || !head.oid} onClick={() => compareFromMenu('head', c)}>
                  ⇄
                </button>
                <button title="Copy SHA (C)" onClick={() => runAction('copy-sha', c)}>
                  ⧉
                </button>
                <button
                  title="More actions (right-click)"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu({ x: r.left - 200, y: r.bottom + 4, commit: c });
                  }}
                >
                  ⋯
                </button>
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ padding: 12 }}>
              <Spinner label="Loading history…" />
            </div>
          )}
          {hasMore && !loading && (
            <div style={{ padding: 12 }}>
              <button className="btn block" onClick={() => load(true)}>
                Load more commits
              </button>
            </div>
          )}
        </div>
        {/* A changed file (working or committed) opens here, over the graph, so the diff gets the room it needs. */}
        <div className="ws-diff-host" ref={setDiffHost} />
        </div>

        {showSide && (
          <>
            <div
              className="hist-resizer"
              title="Drag to resize · double-click to reset"
              onDoubleClick={() => setPaneW(ws ? 40 : 54)}
              onMouseDown={(e) => {
                e.preventDefault();
                const box = splitRef.current?.getBoundingClientRect();
                if (!box) return;
                const move = (ev: MouseEvent) => setPaneW(Math.max(28, Math.min(72, ((box.right - ev.clientX) / box.width) * 100)));
                const up = () => {
                  window.removeEventListener('mousemove', move);
                  window.removeEventListener('mouseup', up);
                  document.body.classList.remove('resizing');
                };
                document.body.classList.add('resizing');
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', up);
              }}
            />
            {ws && wip ? (
              <div className="right ws-pane">{wipPane}</div>
            ) : (
              <div className="right" style={{ padding: 16 }}>
                {pane}
              </div>
            )}
          </>
        )}
      </div>
      {placement === 'modal' && modalOpen && (comparison || selected) && (
        <Modal
          title={comparison ? 'Compare commits' : selectedCommit ? `${selectedCommit.shortHash} · ${selectedCommit.subject}` : 'Commit'}
          icon={comparison ? '⇄' : '◉'}
          size="wide"
          onClose={() => setModalOpen(false)}
        >
          <div className="hist-modal-body">{pane}</div>
        </Modal>
      )}
      {menu && (
        <CommitMenu
          x={menu.x}
          y={menu.y}
          commit={menu.commit}
          current={head.detached ? null : head.branch}
          headHash={head.oid}
          selected={selected}
          onAction={(a, opts) => runAction(a, menu.commit, opts)}
          onCompare={(k) => compareFromMenu(k, menu.commit)}
          onClose={() => setMenu(null)}
        />
      )}
      {actions.dialog}
      {switching && (
        <SwitchBranchDialog
          repoId={repoId}
          target={switching.target}
          kind={switching.kind}
          onClose={() => setSwitching(null)}
          onDone={() => {
            setSwitching(null);
            bump();
          }}
        />
      )}
    </div>
    </RefActionsContext.Provider>
  );
}
