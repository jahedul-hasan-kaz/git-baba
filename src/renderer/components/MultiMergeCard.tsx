import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BranchInfo, BranchMergeResult, BranchOrigin, MergeForecast, TransplantPreview } from '../../shared/types';
import { TransplantDialog } from '../dialogs/TransplantDialog';
import { BranchShelf } from './merge/BranchShelf';
import { MergePreview, pickKey } from './merge/MergePreview';
import type { Picks } from '../dialogs/PickChanges';
import { MergeBranchesDialog } from '../dialogs/BranchDialogs';
import { Modal } from './Modal';
import { BranchPicker, toPickerItems } from './BranchPicker';
import { MERGE_STUDIO_EVENT, takeMergeStudioRequest } from '../services/mergeStudio';
import { call } from '../services/api';
import { useApp } from '../state/AppState';
import { relative } from './FileDiffList';

const DRAG_MIME = 'application/x-gitbaba-branch';
const COLORS = ['#5b8cff', '#3ecf8e', '#f5b84a', '#ff6b6b', '#b18cff', '#6cc4ff', '#ff9f6b', '#9fd36b'];
/** Same stable colour per branch name as the Git History page. */
const branchColor = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};

type StepState = 'pending' | 'running' | 'done' | 'up-to-date' | 'conflicts' | 'failed' | 'skipped';

const STATE_LABEL: Record<StepState, { icon: string; text: string }> = {
  pending: { icon: '○', text: 'waiting' },
  running: { icon: '◐', text: 'merging…' },
  done: { icon: '✓', text: 'merged' },
  'up-to-date': { icon: '✓', text: 'already in' },
  conflicts: { icon: '⚠', text: 'conflicts' },
  failed: { icon: '⚠', text: 'publish failed' },
  skipped: { icon: '↷', text: 'skipped' },
};

type Forecast = { status: 'loading' } | { status: 'ok'; data: MergeForecast & { own?: TransplantPreview } } | { status: 'error' };

interface Props {
  repoId: string;
  local: BranchInfo[];
  remote: BranchInfo[];
  currentName: string | null;
  sources: string[];
  setSources: (fn: (s: string[]) => string[]) => void;
  target: string;
  setTarget: (t: string) => void;
  onChanged: () => void;
  /** Only the studio window (opened through requestMergeStudio); no summary card on the page. */
  headless?: boolean;
}

interface Wire {
  name: string;
  d: string;
  width: number;
  /** The card is scrolled out of the visible part of the source list. */
  hidden: boolean;
}

/**
 * Merge several source branches into one target, one after another. The stage shows each source
 * flowing into the target with a live forecast (commits, files, overlaps between sources). Each
 * step is still the regular reviewed merge (diagnosis, conflict choice, authentication); the queue
 * stops at the first step that needs attention and can be resumed.
 */
export function MultiMergeCard({ repoId, local, remote, currentName, sources, setSources, target, setTarget, onChanged, headless }: Props) {
  const { revision, toast, showError, repos, selectRepo } = useApp();
  /** The branch a temporary integration branch was made from (to merge it back when ready). */
  const [integrationFrom, setIntegrationFrom] = useState<Record<string, string>>({});
  /** Release branch name being typed (null: the name field is closed). */
  const [releaseName, setReleaseName] = useState<string | null>(null);
  const startIntegration = async (kind: 'integration' | 'release', chosen?: string) => {
    const base = target;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const suggested = kind === 'release' ? `release/${stamp}` : `integration/${base.replace(/[^A-Za-z0-9._-]+/g, '-')}-${stamp}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    if (kind === 'release' && chosen === undefined) {
      // Electron has no window.prompt: ask inline instead.
      setReleaseName(suggested);
      return;
    }
    const name = (chosen ?? suggested).trim();
    if (!name) return;
    setReleaseName(null);
    try {
      // Local only: nothing is pushed, no tag is made and no workflow runs until you publish it yourself.
      await call('git:createBranch', { repoId, name, startPoint: base, switchTo: false });
      setIntegrationFrom((m) => ({ ...m, [name]: base }));
      setTarget(name);
      onChanged();
      toast(`Created ${name} from ${base} (local only). Merge the selected features into it; ${base} stays untouched.`);
    } catch (err) {
      showError(err);
    }
  };
  /** Validate in its own worktree folder, so no existing folder has to switch branches. */
  const validateInWorktree = async (branch: string) => {
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) return;
    const dir = `${repo.path.replace(/[\/]+$/, '')}-${branch.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
    try {
      const w = await call('git:worktreeAdd', { repoId, path: dir, branch, create: false });
      const opened = await call('git:worktreeOpen', { repoId, path: w.path });
      selectRepo(opened.id);
    } catch (err) {
      showError(err);
    }
  };
  const integrationBase = integrationFrom[target] ?? null;
  const [dragFrom, setDragFrom] = useState<{ name: string; index: number | null } | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [overTarget, setOverTarget] = useState(false);
  const [overLane, setOverLane] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [hotFile, setHotFile] = useState<string | null>(null);
  const [queue, setQueue] = useState<{ order: string[]; target: string; index: number; states: StepState[]; open: boolean } | null>(null);
  const [forecasts, setForecasts] = useState<Record<string, Forecast>>({});
  const [wires, setWires] = useState<Wire[]>([]);
  const [burst, setBurst] = useState(0);
  const lastResult = useRef<BranchMergeResult | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => takeMergeStudioRequest());
  useEffect(() => {
    const on = () => takeMergeStudioRequest() && setOpen(true);
    window.addEventListener(MERGE_STUDIO_EVENT, on);
    return () => window.removeEventListener(MERGE_STUDIO_EVENT, on);
  }, []);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());

  // Default source: the branch you are on.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !currentName) return;
    seeded.current = true;
    setSources((s) => (s.length ? s : [currentName]));
  }, [currentName, setSources]);

  const localNames = useMemo(() => new Set(local.map((b) => b.name)), [local]);

  // ---- Live forecast per source (refreshed when the repository changes) ----
  const [own, setOwn] = useState<Record<string, string>>({});
  const [previewOpen, setPreviewOpen] = useState(true);
  // Files / lines ticked in the preview, per "source|base"; plus every file and the source tip they were made on.
  const [picks, setPicksAll] = useState<Record<string, Picks>>({});
  const [pickInfo, setPickInfo] = useState<Record<string, { files: string[]; head: string | null }>>({});
  const setPicks = (key: string, fn: (p: Picks) => Picks) => setPicksAll((all) => ({ ...all, [key]: fn(all[key] ?? new Map()) }));
  const baseFor = (b: string) => (own[b] !== undefined ? own[b] : target);
  // Narrowing by commits instead of files & lines.
  const [modes, setModes] = useState<Record<string, 'files' | 'commits'>>({});
  const [commitSel, setCommitSelAll] = useState<Record<string, Set<string>>>({});
  const [commitInfo, setCommitInfo] = useState<Record<string, { all: string[]; head: string }>>({});
  const setCommitSel = (key: string, fn: (s: Set<string>) => Set<string>) => setCommitSelAll((all) => ({ ...all, [key]: fn(all[key] ?? new Set()) }));
  const modeOf = (b: string) => modes[pickKey(b, baseFor(b))] ?? 'files';
  /** The user ticked only some commits of this source: only those may be merged. */
  const partialCommits = (b: string): string[] | null => {
    if (modeOf(b) !== 'commits') return null;
    const k = pickKey(b, baseFor(b));
    const sel = commitSel[k];
    const info = commitInfo[k];
    if (!sel || !info) return null;
    return info.all.every((h) => sel.has(h)) ? null : info.all.filter((h) => sel.has(h));
  };
  /** The user left something out for this source: only the ticked parts may be merged. */
  const partial = (b: string): Picks | null => {
    if (modeOf(b) === 'commits') return null;
    const k = pickKey(b, baseFor(b));
    const p = picks[k];
    const info = pickInfo[k];
    if (!p || !info) return null;
    const whole = info.files.every((f) => p.get(f) === 'all') && p.size === info.files.length;
    return whole ? null : p;
  };
  const [previewFocus, setPreviewFocus] = useState<string | null>(null);
  const [origins, setOrigins] = useState<Record<string, BranchOrigin>>({});
  useEffect(() => {
    call('git:branchOrigins', { repoId }).then(setOrigins).catch(() => setOrigins({}));
  }, [repoId, revision]);
  const toggleOwn = (b: string) =>
    setOwn((o) => {
      const n = { ...o };
      if (n[b] !== undefined) delete n[b];
      else n[b] = origins[b]?.from && origins[b].from !== b ? origins[b].from : '';
      return n;
    });
  const fkey = (b: string) => (own[b] !== undefined ? `${b}|own:${own[b]}→${target}` : `${b}→${target}`);
  useEffect(() => setForecasts({}), [revision, repoId]);
  useEffect(() => {
    if (!target) return;
    for (const b of sources) {
      const k = fkey(b);
      if (b === target || forecasts[k]) continue;
      if (own[b] !== undefined) {
        if (!own[b]) continue; // choose the base branch first
        setForecasts((f) => ({ ...f, [k]: { status: 'loading' } }));
        call('git:transplantPreview', { repoId, source: b, base: own[b], target })
          .then((tp) => {
            const fresh = tp.commits.filter((c) => !c.alreadyInTarget);
            const data = { branch: b, base: target, related: true, ahead: fresh.length, behind: 0, files: tp.files, additions: 0, deletions: 0, lastDate: tp.commits[tp.commits.length - 1]?.date ?? null, own: tp };
            setForecasts((f) => ({ ...f, [k]: { status: 'ok', data } }));
          })
          .catch(() => setForecasts((f) => ({ ...f, [k]: { status: 'error' } })));
        continue;
      }
      setForecasts((f) => ({ ...f, [k]: { status: 'loading' } }));
      call('graph:mergeForecast', { repoId, branch: b, base: target })
        .then((data) => setForecasts((f) => ({ ...f, [k]: { status: 'ok', data } })))
        .catch(() => setForecasts((f) => ({ ...f, [k]: { status: 'error' } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, target, repoId, forecasts, own]);
  const fc = (b: string): MergeForecast | null => {
    const f = forecasts[fkey(b)];
    return f?.status === 'ok' ? f.data : null;
  };

  // Files that more than one source changes: the likely places for conflicts between them.
  const hotspots = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const b of sources) for (const file of fc(b)?.files ?? []) by.set(file, [...(by.get(file) ?? []), b]);
    return [...by.entries()].filter(([, bs]) => bs.length > 1).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, forecasts, target]);
  const overlapOf = (b: string) => hotspots.filter(([, bs]) => bs.includes(b)).length;
  const totals = useMemo(() => {
    const files = new Set<string>();
    let commits = 0;
    let add = 0;
    let del = 0;
    for (const b of sources) {
      const f = fc(b);
      if (!f) continue;
      commits += f.ahead;
      add += f.additions;
      del += f.deletions;
      f.files.forEach((x) => files.add(x));
    }
    return { commits, files: files.size, add, del };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, forecasts, target]);
  const maxAhead = Math.max(1, ...sources.map((b) => fc(b)?.ahead ?? 0));

  // ---- Source list editing ----
  const add = (name: string, at?: number) =>
    setSources((s) => {
      const rest = s.filter((x) => x !== name);
      const i = at === undefined ? rest.length : Math.max(0, Math.min(at, rest.length));
      return [...rest.slice(0, i), name, ...rest.slice(i)];
    });
  const remove = (name: string) => setSources((s) => s.filter((x) => x !== name));
  const move = (name: string, delta: number) =>
    setSources((s) => {
      const i = s.indexOf(name);
      const j = i + delta;
      if (i === -1 || j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const chooseTarget = (name: string) => {
    if (!localNames.has(name)) return;
    setTarget(name);
    remove(name);
    setBurst((b) => b + 1);
  };
  /** Isolated, small branches first; branches that overlap others last, so any conflict comes as late as possible. */
  const smartOrder = () =>
    setSources((s) =>
      [...s].sort((a, b) => {
        const fa = fc(a);
        const fb = fc(b);
        const nothingA = fa?.ahead === 0 ? 0 : 1;
        const nothingB = fb?.ahead === 0 ? 0 : 1;
        return nothingA - nothingB || overlapOf(a) - overlapOf(b) || (fa?.files.length ?? 0) - (fb?.files.length ?? 0) || (fa?.ahead ?? 0) - (fb?.ahead ?? 0);
      }),
    );
  const dropEmpty = () => setSources((s) => s.filter((b) => fc(b)?.ahead !== 0));

  // ---- FLIP: cards glide to their new place when the order changes ----
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    cardRefs.current.forEach((el, name) => {
      const r = el.getBoundingClientRect();
      next.set(name, r);
      const prev = prevRects.current.get(name);
      if (prev && Math.abs(prev.top - r.top) > 1) {
        el.animate([{ transform: `translateY(${prev.top - r.top}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    prevRects.current = next;
  }, [sources]);

  // ---- Wires from every source card into the target node ----
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const tgt = targetRef.current;
    const lane = laneRef.current;
    if (!stage || !tgt || !lane) return;
    const s = stage.getBoundingClientRect();
    const t = tgt.getBoundingClientRect();
    const o = orbRef.current?.getBoundingClientRect() ?? t;
    const l = lane.getBoundingClientRect();
    const tx = t.left - s.left;
    const ty = o.top - s.top + o.height / 2;
    const top = l.top - s.top + 4;
    const bottom = l.bottom - s.top - 4;
    const out: Wire[] = [];
    sources.forEach((name, i) => {
      const el = cardRefs.current.get(name);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = r.right - s.left;
      const raw = r.top - s.top + r.height / 2;
      const y = Math.max(top, Math.min(bottom, raw));
      // Spread the arrival points a little so the ribbons fan into the node.
      const spread = sources.length > 1 ? (i - (sources.length - 1) / 2) * Math.min(10, 40 / sources.length) : 0;
      const mx = (x + tx) / 2;
      const ahead = fc(name)?.ahead ?? 0;
      out.push({ name, d: `M${x} ${y} C ${mx} ${y}, ${mx} ${ty + spread}, ${tx} ${ty + spread}`, width: 2 + Math.round((Math.min(ahead, maxAhead) / maxAhead) * 5), hidden: y !== raw });
    });
    setWires(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, forecasts, target, maxAhead, open]);
  useLayoutEffect(() => {
    measure();
    const t = setTimeout(measure, 280); // after the FLIP glide
    return () => clearTimeout(t);
  }, [measure]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [measure]);

  // ---- Queue ----
  const running = !!queue && queue.index < queue.order.length && queue.states.some((s) => s === 'pending' || s === 'running');
  const valid = sources.length > 0 && !!target && !sources.includes(target) && sources.every((b) => own[b] !== '');

  const start = (order = sources, tgt = target) => {
    if (!order.length || !tgt) return;
    lastResult.current = null;
    setQueue({ order, target: tgt, index: 0, states: order.map((_, i) => (i === 0 ? 'running' : 'pending')), open: true });
  };

  const advance = (state: StepState, stop: boolean) => {
    if (state === 'done') setBurst((b) => b + 1);
    setQueue((q) => {
      if (!q) return q;
      const states = [...q.states];
      states[q.index] = state;
      const next = q.index + 1;
      if (!stop && next >= q.order.length && q.order.length === 1) return null;
      if (stop || next >= q.order.length) return { ...q, states, index: stop ? q.index : next, open: false };
      states[next] = 'running';
      return { ...q, states, index: next, open: true };
    });
    onChanged();
  };

  const onStepDone = () => {
    const r = lastResult.current;
    lastResult.current = null;
    if (!r) return advance('skipped', true); // e.g. a pull request was opened instead
    if (r.outcome === 'conflicts') return advance('conflicts', true);
    if (r.pushError) return advance('failed', true);
    advance(r.outcome === 'up-to-date' ? 'up-to-date' : 'done', false);
  };

  const resume = () =>
    setQueue((q) => {
      if (!q) return q;
      const i = q.states.findIndex((s, k) => k >= q.index && (s === 'pending' || s === 'running' || s === 'skipped'));
      if (i === -1) return q;
      const states = [...q.states];
      states[i] = 'running';
      return { ...q, index: i, states, open: true };
    });
  const skipCurrent = () =>
    setQueue((q) => {
      if (!q) return q;
      const states = [...q.states];
      states[q.index] = 'skipped';
      const next = states.findIndex((s, k) => k > q.index && s === 'pending');
      if (next === -1) return { ...q, states, open: false };
      states[next] = 'running';
      return { ...q, states, index: next, open: true };
    });

  const stateOf = (name: string): StepState | null => {
    if (!queue || queue.target !== target) return null;
    const i = queue.order.indexOf(name);
    return i === -1 ? null : queue.states[i];
  };
  const paused = !!queue && !queue.open && queue.states.some((s) => s === 'pending' || s === 'running' || s === 'skipped');
  const finished = !!queue && !queue.open && !paused;
  const doneCount = queue ? queue.states.filter((s) => s === 'done' || s === 'up-to-date').length : 0;
  const progress = queue ? doneCount / queue.order.length : 0;

  // ---- Drag & drop ----
  const readDrag = (e: React.DragEvent) => e.dataTransfer.getData(DRAG_MIME);
  const allowDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return true;
  };
  const dragProps = (name: string, index: number | null) => ({
    draggable: !running,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, name);
      e.dataTransfer.effectAllowed = 'move';
      setDragFrom({ name, index });
    },
    onDragEnd: () => {
      setDragFrom(null);
      setOverIndex(null);
      setOverTarget(false);
      setOverLane(false);
    },
  });

  const wireClass = (name: string) => {
    const st = stateOf(name);
    const f = fc(name);
    return [
      'mm-wire',
      st ?? '',
      f && f.ahead === 0 ? 'empty' : '',
      hover && hover !== name ? 'dim' : '',
      wires.find((w) => w.name === name)?.hidden ? 'offscreen' : '',
      hover === name ? 'hot' : '',
      hotFile && !fc(name)?.files.includes(hotFile) ? 'dim' : '',
      dragFrom?.name === name ? 'dim' : '',
    ].join(' ');
  };
  const R = 30;
  const C = 2 * Math.PI * R;

  function footer() {
    return (
        <div className="row grow" style={{ flexWrap: 'wrap' }}>
          {sources.includes(target) && <span className="small text-danger">The target cannot also be a source.</span>}
          {paused && queue && (
            <span className="small text-warn">
              Paused at {queue.order[queue.index]} — {STATE_LABEL[queue.states[queue.index]].text}.
            </span>
          )}
          {finished && queue && (
            <span className="small text-ok">
              Queue finished: {doneCount} of {queue.order.length} merged into {queue.target}.
            </span>
          )}
          <span className="spacer" />
          {paused && (
            <>
              <button className="btn sm" onClick={() => setQueue(null)}>
                Cancel queue
              </button>
              {queue!.states[queue!.index] === 'pending' && queue!.order.length > 1 ? (
                <button className="btn sm" onClick={skipCurrent}>
                  Skip {queue!.order[queue!.index]}
                </button>
              ) : null}
              <button className="btn sm primary" onClick={resume}>
                Continue
              </button>
            </>
          )}
          {finished && (
            <button className="btn sm" onClick={() => setQueue(null)}>
              Clear status
            </button>
          )}
          {!paused && (
            <button className="btn primary mm-go" disabled={!valid || running} onClick={() => start()}>
              {sources.length > 1 ? `Review ${sources.length} merges…` : 'Review merge…'}
            </button>
          )}
        </div>
    );
  }

  const summary = (
    <div className="card mm-card">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>
          Merge branches
        </h3>
        {queue && (
          <span className={`mm-state ${paused ? 'conflicts' : finished ? 'done' : 'running'}`}>
            {paused ? `⏸ paused ${doneCount}/${queue.order.length}` : finished ? `✓ ${doneCount}/${queue.order.length} merged` : `◐ merging ${doneCount + 1}/${queue.order.length}`}
          </span>
        )}
      </div>
      <p className="small muted">Merge one or several branches into a target in the Merge Studio: drag &amp; drop, live preview, overlap hotspots and a reviewed, authenticated step for every branch.</p>
      <div className="mm-sum" onClick={() => setOpen(true)} role="button" tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(true)}>
        <div className="mm-sum-stack">
          {sources.length === 0 && <span className="muted small">No sources yet</span>}
          {sources.slice(0, 4).map((n) => (
            <span key={n} className="mm-chip static" style={{ ['--bc' as string]: branchColor(n) }} title={n}>
              <span className="mm-dot" /> {n}
            </span>
          ))}
          {sources.length > 4 && <span className="mm-chip static more">+{sources.length - 4} more</span>}
        </div>
        <span className="mm-sum-arrow">➜</span>
        <span className={`mm-chip static target ${target ? '' : 'empty'}`} style={target ? { ['--bc' as string]: branchColor(target) } : undefined}>
          {target ? (
            <>
              <span className="mm-dot" /> {target}
            </>
          ) : (
            'choose target'
          )}
        </span>
        <span className="spacer" />
        {target && sources.length > 0 && !queue && (
          <span className="small muted">
            {totals.commits} commits · {totals.files} files{hotspots.length ? ` · ⚡ ${hotspots.length} overlaps` : ''}
          </span>
        )}
      </div>
      <div className="row mt">
        <span className="spacer" />
        <button className="btn primary mm-go" onClick={() => setOpen(true)}>
          ✨ Open Merge Studio{sources.length > 1 ? ` (${sources.length} sources)` : ''}
        </button>
      </div>
    </div>
  );

  const studio = (
    <Modal title="Merge Studio" icon="⎇" size="wide" onClose={() => setOpen(false)} locked={!!queue?.open} footer={footer()}>
      <div className="row">
        <p className="small muted grow" style={{ margin: 0 }}>
          Drag branches into <strong>Sources</strong> (drag or <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> to reorder — they merge top to bottom) and onto the <strong>Target</strong>. Every step is still reviewed and
          authenticated.
        </p>
        {sources.length > 1 && (
          <>
            <button className="btn sm ghost" disabled={running || !target} onClick={smartOrder} title="Isolated, small branches first; branches that touch the same files as others go last">
              ✨ Smart order
            </button>
            {sources.some((b) => fc(b)?.ahead === 0) && (
              <button className="btn sm ghost" disabled={running} onClick={dropEmpty} title="Remove sources that bring nothing new into the target">
                ⌫ Drop up-to-date
              </button>
            )}
          </>
        )}
        {sources.length > 0 && !running && (
          <button className="btn sm ghost" onClick={() => setSources(() => [])} title="Remove all sources">
            Clear
          </button>
        )}
      </div>
      <div className="mm-studio">
        <aside className="mm-studio-shelf">
          <BranchShelf
            branches={[...local, ...remote]}
            used={new Set([...sources, ...(target ? [target] : [])])}
            target={target}
            disabled={running}
            onAdd={(names) => names.forEach((n) => add(n))}
            onTarget={chooseTarget}
            dragProps={(n) => dragProps(n, null)}
          />
        </aside>
        <div className="mm-studio-main">
      <div className="mm-stage" ref={stageRef}>
        <svg className="mm-wires" aria-hidden>
          <defs>
            <filter id="mm-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {target &&
            wires.map((w) => {
              const st = stateOf(w.name);
              const c = st === 'done' || st === 'up-to-date' ? 'var(--ok)' : st === 'conflicts' || st === 'failed' ? 'var(--warn)' : branchColor(w.name);
              const flowing = st === 'running' || hover === w.name || (!queue && overlapOf(w.name) === 0 && (fc(w.name)?.ahead ?? 0) > 0);
              return (
                <g key={w.name} className={wireClass(w.name)}>
                  <path d={w.d} stroke={c} strokeWidth={w.width + 6} className="mm-wire-halo" />
                  <path d={w.d} stroke={c} strokeWidth={w.width} className="mm-wire-core" />
                  {flowing && (
                    <>
                      {[0, 0.6, 1.2].map((delay) => (
                        <circle key={delay} r={st === 'running' ? 3.5 : 2.5} fill={c} filter="url(#mm-glow)">
                          <animateMotion dur={st === 'running' ? '1.1s' : '2.4s'} begin={`${delay}s`} repeatCount="indefinite" path={w.d} />
                        </circle>
                      ))}
                    </>
                  )}
                </g>
              );
            })}
        </svg>

        <div
          ref={laneRef}
          onScroll={measure}
          className={`mm-lane ${overLane ? 'over' : ''}`}
          onDragOver={(e) => allowDrop(e) && setOverLane(true)}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOverLane(false)}
          onDrop={(e) => {
            e.preventDefault();
            const n = readDrag(e);
            setOverLane(false);
            if (n) add(n, overIndex ?? undefined);
            setOverIndex(null);
            if (n === target) setTarget('');
          }}
        >
          <div className="mm-lane-title">
            Sources · merge from <span className="mm-count">{sources.length}</span>
          </div>
          {sources.length === 0 && <div className="mm-empty small muted">Drop branches here, or click one below</div>}
          {sources.map((name, i) => {
            const st = stateOf(name);
            const f = forecasts[fkey(name)];
            const data = f?.status === 'ok' ? f.data : null;
            const overlaps = overlapOf(name);
            const col = branchColor(name);
            return (
              <div
                key={name}
                ref={(el) => {
                  if (el) cardRefs.current.set(name, el);
                  else cardRefs.current.delete(name);
                }}
                tabIndex={0}
                className={`mm-src ${dragFrom?.name === name ? 'dragging' : ''} ${overIndex === i && dragFrom?.name !== name ? 'insert' : ''} ${st ? `st-${st}` : ''} ${data?.ahead === 0 ? 'empty' : ''} ${hover && hover !== name ? 'dim' : ''} ${hotFile && data && !data.files.includes(hotFile) ? 'dim' : ''}`}
                style={{ ['--bc' as string]: col }}
                {...dragProps(name, i)}
                onDragOver={(e) => allowDrop(e) && overIndex !== i && setOverIndex(i)}
                onMouseEnter={() => setHover(name)}
                onMouseLeave={() => setHover(null)}
                onKeyDown={(e) => {
                  if (running) return;
                  if (e.altKey && e.key === 'ArrowUp') {
                    e.preventDefault();
                    move(name, -1);
                  } else if (e.altKey && e.key === 'ArrowDown') {
                    e.preventDefault();
                    move(name, 1);
                  } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    remove(name);
                  }
                }}
              >
                <div className="mm-src-top">
                  <span className="mm-order">{i + 1}</span>
                  <span className="mm-dot" />
                  <span className="mono ellipsis grow mm-name" title={name}>
                    {name}
                  </span>
                  {name === currentName && <span className="badge info">current</span>}
                  {!localNames.has(name) && <span className="badge">remote</span>}
                  {st && (
                    <span className={`mm-state ${st}`}>
                      {STATE_LABEL[st].icon} {STATE_LABEL[st].text}
                    </span>
                  )}
                  {target && (
                    <button
                      className="cmp-x"
                      title="Preview what this source brings"
                      onClick={() => {
                        setPreviewOpen(true);
                        setPreviewFocus(null);
                        setTimeout(() => setPreviewFocus(name), 0);
                        setTimeout(() => document.querySelector('.mp-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                      }}
                    >
                      👁
                    </button>
                  )}
                  {!running && (
                    <button className="cmp-x" title="Remove (Del)" onClick={() => remove(name)}>
                      ✕
                    </button>
                  )}
                </div>
                {!running && (
                  <div className="mm-mode" onMouseDown={(e) => e.stopPropagation()} draggable={false} onDragStart={(e) => e.preventDefault()}>
                    <button className={`mm-mode-btn ${own[name] === undefined ? 'on' : ''}`} onClick={() => own[name] !== undefined && toggleOwn(name)} title="Normal merge: everything this branch contains that the target lacks">
                      ⤵ Everything
                    </button>
                    <button className={`mm-mode-btn own ${own[name] !== undefined ? 'on' : ''}`} onClick={() => own[name] === undefined && toggleOwn(name)} title="Bring only the commits this branch added on top of the branch it was made from">
                      🎯 Only its own changes
                    </button>
                    {own[name] !== undefined && (
                      <span className="mm-mode-base">
                        <span className="small muted">made from</span>
                        <BranchPicker
                          compact
                          value={own[name]}
                          onChange={(v) => setOwn((o) => ({ ...o, [name]: v }))}
                          items={toPickerItems([...local, ...remote]).filter((x) => x.name !== name)}
                          placeholder="choose base…"
                          recentKey="transplant-base"
                        />
                        {origins[name] && origins[name].from === own[name] && (
                          <span className="small muted" title={origins[name].source === 'reflog' ? 'Recorded by Git when the branch was created' : 'Worked out from the branch history'}>
                            {origins[name].source === 'reflog' ? '✓ detected' : '~ guessed'}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )}
                <div className="mm-src-stats">
                  {own[name] === '' && target && <span className="text-warn">choose the branch {name} was made from</span>}
                  {target &&
                    (() => {
                      const cs = partialCommits(name);
                      if (!cs) return null;
                      const info = commitInfo[pickKey(name, baseFor(name))];
                      return (
                        <span className="mm-picked" title="Only the ticked commits are merged — change it in “What lands”">
                          🧩 {cs.length}/{info?.all.length ?? '?'} commits selected
                        </span>
                      );
                    })()}
                  {target &&
                    (() => {
                      const sel = partial(name);
                      if (!sel) return null;
                      const info = pickInfo[pickKey(name, baseFor(name))];
                      const n = [...sel.values()].length;
                      const lines = [...sel.values()].some((v) => v !== 'all');
                      return (
                        <span className="mm-picked" title="Only the ticked files / lines are merged — change it in “What lands”">
                          ✂ {n}/{info?.files.length ?? '?'} files{lines ? ' · some lines' : ''} selected
                        </span>
                      );
                    })()}
                  {data?.own && (
                    <span className="mm-own" title={`A normal merge would also bring ${data.own.leftBehind} commit(s) from ${data.own.base}`}>
                      🎯 {data.own.commits.length} own commit{data.own.commits.length === 1 ? '' : 's'} · ✂ leaves {data.own.leftBehind} {data.own.base} commit{data.own.leftBehind === 1 ? '' : 's'} behind
                    </span>
                  )}
                  {!target && <span className="muted">choose a target to preview</span>}
                  {target && f?.status === 'loading' && <span className="mm-shimmer">analysing…</span>}
                  {target && f?.status === 'error' && <span className="text-warn">preview unavailable</span>}
                  {data && !data.related && <span className="text-danger">⛔ no shared history</span>}
                  {data && data.related && data.ahead === 0 && <span className="muted">✓ nothing new for {target}</span>}
                  {data && data.ahead > 0 && (
                    <>
                      <span className="mm-meter" title={`${data.ahead} commit(s) to bring in`}>
                        <span style={{ width: `${Math.max(6, (data.ahead / maxAhead) * 100)}%` }} />
                      </span>
                      <span>
                        <strong>{data.ahead}</strong> commit{data.ahead === 1 ? '' : 's'}
                      </span>
                      <span>{data.files.length} files</span>
                      {!data.own && <span className="text-ok">+{data.additions}</span>}
                      {!data.own && <span className="text-danger">−{data.deletions}</span>}
                      {overlaps > 0 && (
                        <span className="mm-risk" title={`${overlaps} file(s) also changed by another source — a conflict between sources is possible`}>
                          ⚡ {overlaps} overlap{overlaps === 1 ? '' : 's'}
                        </span>
                      )}
                      {data.behind > 0 && <span className="muted" title={`${target} has ${data.behind} commit(s) this branch does not`}>· {data.behind} behind</span>}
                    </>
                  )}
                  {data?.lastDate && <span className="muted mm-when">{relative(data.lastDate)}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mm-gap" />

        <div
          ref={targetRef}
          className={`mm-target ${overTarget ? (dragFrom && localNames.has(dragFrom.name) ? 'over' : 'reject') : ''} ${target ? 'filled' : ''} ${running ? 'live' : ''}`}
          style={target ? { ['--bc' as string]: branchColor(target) } : undefined}
          onDragOver={(e) => allowDrop(e) && setOverTarget(true)}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOverTarget(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOverTarget(false);
            const n = readDrag(e);
            if (n) chooseTarget(n);
          }}
        >
          <div className="mm-lane-title">Target · merge into</div>
          <div className="mm-orb-wrap" ref={orbRef}>
            <svg className="mm-orb" viewBox="0 0 76 76" width={76} height={76}>
              <circle cx={38} cy={38} r={R} className="mm-orb-track" />
              {queue && <circle cx={38} cy={38} r={R} className="mm-orb-progress" strokeDasharray={`${C * progress} ${C}`} transform="rotate(-90 38 38)" />}
            </svg>
            <div key={burst} className={`mm-orb-core ${burst ? 'pop' : ''}`}>
              {target ? '⎇' : '?'}
            </div>
          </div>
          <BranchPicker
            value={target}
            disabled={running}
            onChange={chooseTarget}
            items={toPickerItems(local).map((b) => (sources.includes(b.name) ? { ...b, subject: 'Currently a source — picking it moves it to the target' } : b))}
            placeholder="Choose a local branch…"
            recentKey="merge-target"
          />
          {target && sources.length > 0 ? (
            <div className="mm-absorb small">
              {queue ? (
                <span>
                  {doneCount} / {queue.order.length} merged
                </span>
              ) : (
                <>
                  absorbs <strong>{totals.commits}</strong> commits · <strong>{totals.files}</strong> files <span className="text-ok">+{totals.add}</span> <span className="text-danger">−{totals.del}</span>
                </>
              )}
            </div>
          ) : (
            <div className="small muted mt">{overTarget && dragFrom && !localNames.has(dragFrom.name) ? 'Only a local branch can be the target' : 'or drop a local branch here'}</div>
          )}
          {target && !queue && !integrationBase && releaseName !== null && (
            <form
              className="row mt"
              style={{ gap: 6, justifyContent: 'center' }}
              onSubmit={(e) => {
                e.preventDefault();
                void startIntegration('release', releaseName);
              }}
            >
              <input autoFocus value={releaseName} onChange={(e) => setReleaseName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setReleaseName(null)} placeholder="release/…" spellCheck={false} style={{ maxWidth: 220 }} title={`Release branch name, created from ${target}`} />
              <button className="btn sm primary" type="submit" disabled={!releaseName.trim()}>
                Create
              </button>
              <button className="btn sm ghost" type="button" onClick={() => setReleaseName(null)}>
                Cancel
              </button>
            </form>
          )}
          {target && !queue && !integrationBase && releaseName === null && (
            <div className="row mt" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="btn sm ghost" onClick={() => void startIntegration('integration')} title={`Creates a temporary branch from ${target} and makes it the target; ${target} stays untouched`}>
                ⎇ Temporary integration branch
              </button>
              <button className="btn sm ghost" onClick={() => void startIntegration('release')} title={`Creates a named release branch from ${target} and makes it the target; ${target} stays untouched`}>
                🏷 Release branch
              </button>
            </div>
          )}
          {integrationBase && !queue && (
            <div className="small mt">
              <span className="muted">Made from {integrationBase} (local only). </span>
              <button className="btn sm ghost" onClick={() => void validateInWorktree(target)} title={`Opens ${target} in its own worktree folder to build and test it; no other folder changes branch`}>
                ✓ Validate in its own worktree
              </button>
              <span className="muted"> then </span>
              <button
                className="btn sm"
                onClick={() => {
                  setSources(() => [target]);
                  setTarget(integrationBase);
                }}
                title={`Sets up merging ${target} into ${integrationBase}`}
              >
                merge it into {integrationBase}
              </button>
            </div>
          )}
        </div>
      </div>

      {hotspots.length > 0 && (
        <div className="mm-hot">
          <div className="row small">
            <strong className="grow">⚡ Overlap hotspots — files changed by more than one source</strong>
            <span className="muted">hover a file to trace it</span>
          </div>
          <div className="mm-hot-list">
            {hotspots.slice(0, 12).map(([file, bs]) => (
              <div key={file} className={`mm-hot-row ${hotFile === file ? 'on' : ''}`} onMouseEnter={() => setHotFile(file)} onMouseLeave={() => setHotFile(null)}>
                <span className="mono ellipsis grow" title={file}>
                  {file}
                </span>
                {bs.map((b) => (
                  <span key={b} className="mm-hot-dot" style={{ background: branchColor(b) }} title={b} />
                ))}
                <span className="small muted">{bs.length}×</span>
              </div>
            ))}
            {hotspots.length > 12 && <div className="small muted">+{hotspots.length - 12} more</div>}
          </div>
        </div>
      )}

      <section className={`mp-section ${previewOpen ? 'open' : ''}`}>
        <button className="mp-section-head" onClick={() => setPreviewOpen((o) => !o)} aria-expanded={previewOpen}>
          <span className="cb-caret">{previewOpen ? '▾' : '▸'}</span>
          <strong>👁 What lands in {target || 'the target'}</strong>
          <span className="small muted">the exact commits and line changes each source brings</span>
        </button>
        {previewOpen && (
          <MergePreview
            repoId={repoId}
            sources={sources}
            target={target}
            own={own}
            revision={revision}
            focus={previewFocus}
            picks={picks}
            setPicks={setPicks}
            onFiles={(k, files, head) => setPickInfo((x) => ({ ...x, [k]: { files, head } }))}
            modes={modes}
            setMode={(k, m) => setModes((x) => ({ ...x, [k]: m }))}
            commitSel={commitSel}
            setCommitSel={setCommitSel}
            onCommits={(k, all, head) => setCommitInfo((x) => ({ ...x, [k]: { all, head } }))}
          />
        )}
      </section>
        </div>
      </div>
    </Modal>
  );

  return (
    <>
      {!headless && summary}
      {open && studio}
      {queue?.open && (own[queue.order[queue.index]] !== undefined || !!partial(queue.order[queue.index]) || !!partialCommits(queue.order[queue.index])) && (() => {
        const src = queue.order[queue.index];
        const sel = partial(src);
        const cs = partialCommits(src);
        const k = pickKey(src, baseFor(src));
        return (
        <TransplantDialog
          key={`tp:${queue.index}:${src}:${sel ? 'pick' : cs ? 'commits' : 'own'}`}
          repoId={repoId}
          source={src}
          base={baseFor(src)}
          target={queue.target}
          localTargets={local.map((b) => b.name)}
          queue={queue.order.length > 1 ? { index: queue.index, total: queue.order.length } : undefined}
          initialPicks={sel ?? undefined}
          initialPicksHead={sel ? pickInfo[k]?.head ?? null : undefined}
          initialCommits={cs ?? undefined}
          initialCommitsHead={cs ? commitInfo[k]?.head : undefined}
          onClose={() => {
            setQueue((q) => {
              if (!q || q.order.length === 1) return null;
              const states = [...q.states];
              states[q.index] = 'pending';
              return { ...q, states, open: false };
            });
            onChanged();
          }}
          onDone={(r) => (!r ? advance('skipped', true) : r.outcome === 'conflicts' ? advance('conflicts', true) : advance('done', false))}
        />
        );
      })()}
      {queue?.open && own[queue.order[queue.index]] === undefined && !partial(queue.order[queue.index]) && !partialCommits(queue.order[queue.index]) && (
        <MergeBranchesDialog
          key={`${queue.index}:${queue.order[queue.index]}`}
          repoId={repoId}
          source={queue.order[queue.index]}
          target={queue.target}
          queue={queue.order.length > 1 ? { index: queue.index, total: queue.order.length } : undefined}
          onResult={(r) => (lastResult.current = r)}
          onClose={() => {
            // Closed without merging: pause here so the user can continue, skip or cancel.
            setQueue((q) => {
              if (!q || q.order.length === 1) return null;
              const states = [...q.states];
              states[q.index] = 'pending';
              return { ...q, states, open: false };
            });
            onChanged();
          }}
          onDone={onStepDone}
        />
      )}
    </>
  );
}
