import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowJob } from '../../../../shared/github';
import { duration } from '../../../components/github/common';
import { call, toFriendly } from '../../../services/api';
import { useApp } from '../../../state/AppState';
import { elapsed, RunIcon, runState } from './shared';
import { Hourglass } from '../../../components/Hourglass';

type Step = WorkflowJob['steps'][number];

interface LogLine {
  n: number;
  ts: number | null;
  text: string;
  kind: 'plain' | 'cmd' | 'error' | 'warning' | 'notice' | 'debug' | 'group' | 'endgroup';
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function parse(text: string): LogLine[] {
  const raw = text.replace(/\r/g, '').split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  return raw.map((line, n) => {
    const m = TS_RE.exec(line);
    const ts = m ? Date.parse(m[1]) : null;
    let t = (m ? line.slice(m[0].length) : line).replace(ANSI_RE, '');
    let kind: LogLine['kind'] = 'plain';
    const k = /^##\[(group|endgroup|error|warning|notice|debug|command)\]/.exec(t);
    if (k) {
      kind = k[1] === 'command' ? 'cmd' : (k[1] as LogLine['kind']);
      t = t.slice(k[0].length);
    } else if (/^::(error|warning|notice)/.test(t)) {
      kind = t.startsWith('::error') ? 'error' : t.startsWith('::warning') ? 'warning' : 'notice';
      t = t.replace(/^::\w+[^:]*::/, '');
    } else if (/^\[command\]/.test(t)) {
      kind = 'cmd';
      t = t.slice(9);
    } else if (/\b(Error:|ERROR\b|error:|FAILED\b|Exception\b|exit code [1-9])/.test(t)) kind = 'error';
    return { n, ts, text: t, kind };
  });
}

/** Assigns each log line to the step whose time window contains it (step times have second precision). */
function splitBySteps(lines: LogLine[], steps: Step[]): Map<number, LogLine[]> {
  const out = new Map<number, LogLine[]>();
  const wins = steps
    .filter((s) => s.startedAt)
    .map((s) => ({
      n: s.number,
      start: Math.floor(Date.parse(s.startedAt!) / 1000) * 1000,
      end: s.completedAt ? Math.floor(Date.parse(s.completedAt) / 1000) * 1000 + 999 : Infinity,
    }));
  let cur = wins[0]?.n ?? steps[0]?.number ?? 1;
  for (const l of lines) {
    if (l.ts !== null && wins.length) {
      let hit: number | null = null;
      for (const w of wins) if (l.ts >= w.start && l.ts <= w.end) hit = w.n; // latest matching window wins
      if (hit === null) for (const w of wins) if (l.ts >= w.start) hit = w.n;
      if (hit !== null) cur = hit;
    }
    const arr = out.get(cur) ?? [];
    arr.push(l);
    out.set(cur, arr);
  }
  return out;
}

/** Maps exact step files to the job's steps by number, then by name. */
function matchExact(exact: { number: number | null; name: string; text: string }[], steps: Step[]): Map<number, LogLine[]> {
  const out = new Map<number, LogLine[]>();
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  let offset = 0;
  for (const e of exact) {
    const step = (e.number !== null ? steps.find((s) => s.number === e.number) : undefined) ?? steps.find((s) => norm(s.name) === norm(e.name)) ?? steps.find((s) => norm(e.name).includes(norm(s.name)) || norm(s.name).includes(norm(e.name)));
    const lines = parse(e.text).map((l) => ({ ...l, n: l.n + offset }));
    offset += lines.length;
    if (!step) continue;
    out.set(step.number, [...(out.get(step.number) ?? []), ...lines]);
  }
  return out;
}

type Annotation = { level: 'failure' | 'warning' | 'notice'; title: string | null; message: string; path: string | null; line: number | null };

/** GitHub's annotations for the job (errors, warnings, notices) — collapsible, like on github.com. */
function Annotations({ repoId, jobId, done }: { repoId: string; jobId: number; done: boolean }) {
  const [items, setItems] = useState<Annotation[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    call('gh:jobAnnotations', { repoId, jobId })
      .then((a) => live && setItems(a))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [repoId, jobId, done]);
  if (!items || items.length === 0) return null;
  const n = (l: Annotation['level']) => items.filter((a) => a.level === l).length;
  const parts = [n('failure') && `${n('failure')} error${n('failure') === 1 ? '' : 's'}`, n('warning') && `${n('warning')} warning${n('warning') === 1 ? '' : 's'}`, n('notice') && `${n('notice')} notice${n('notice') === 1 ? '' : 's'}`].filter(Boolean);
  return (
    <div className={`annotations ${n('failure') ? 'has-errors' : ''}`}>
      <button className="annotations-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`step-caret ${open ? 'open' : ''}`}>▸</span>
        <strong>Annotations</strong>
        <span className="small muted">{parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}</span>
      </button>
      {open && (
        <div className="annotations-list">
          {items.map((a, i) => (
            <div key={i} className={`annotation ${a.level}`}>
              <span className="annotation-ico">{a.level === 'failure' ? '✕' : a.level === 'warning' ? '⚠' : 'ℹ'}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                {a.title && <strong>{a.title}</strong>}
                <div className="annotation-msg">{a.message}</div>
                {a.path && (
                  <div className="small muted mono">
                    {a.path}
                    {a.line ? `:${a.line}` : ''}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  repoId: string;
  /** Run the job belongs to (enables the run-archive and GitHub CLI fallbacks). */
  runId?: number;
  job: WorkflowJob;
  now: number;
}

/**
 * Every step of a job as an expandable section with its own log — like github.com, plus: the failed step
 * opens by itself at its first error, per-step search with match navigation, error / warning counters,
 * collapsible ::group:: blocks, follow-the-tail while running, and copy of a step's log.
 */
export function StepLogs({ repoId, runId, job, now }: Props) {
  const { toast } = useApp();
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [exact, setExact] = useState<{ number: number | null; name: string; text: string }[] | null>(null);
  const [source, setSource] = useState<{ kind: 'job' | 'archive' | 'gh-cli'; note: string | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const autoOpened = useRef<string | null>(null);
  const running = job.status !== 'completed';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await call('gh:jobLogs', { repoId, jobId: job.id, runId, jobName: job.name });
      setText(r.text);
      setTruncated(r.truncated);
      setExact(r.steps);
      setSource({ kind: r.source, note: r.note });
      setNote(null);
    } catch (err) {
      setNote(running ? 'GitHub publishes the full log as the job runs — sections fill in as output arrives.' : toFriendly(err).message);
    } finally {
      setLoading(false);
    }
  }, [repoId, job.id, job.name, runId, running]);

  useEffect(() => {
    setText(null);
    setNote(null);
    setOpen(new Set());
    autoOpened.current = null;
  }, [job.id]);

  // Logs are shown once the job has finished executing (loaded once, when it completes).
  useEffect(() => {
    if (running) return;
    void load();
  }, [load, running]);

  const lines = useMemo(() => (text ? parse(text) : []), [text]);
  // Exact per-step files (run archive / GitHub CLI) beat splitting one log by timestamps.
  const byStep = useMemo(() => (exact ? matchExact(exact, job.steps) : splitBySteps(lines, job.steps)), [exact, lines, job.steps]);

  // Open the failed step — or follow the running one — automatically.
  useEffect(() => {
    const target = job.steps.find((s) => s.conclusion === 'failure') ?? job.steps.find((s) => s.status === 'in_progress');
    if (!target) return;
    const key = `${job.id}:${target.number}`;
    if (autoOpened.current === key) return;
    autoOpened.current = key;
    setOpen((o) => new Set([...o, target.number]));
  }, [job.id, job.steps]);

  const toggle = useCallback(
    (n: number) =>
      setOpen((o) => {
        const x = new Set(o);
        if (x.has(n)) x.delete(n);
        else x.add(n);
        return x;
      }),
    [],
  );
  const copy = useCallback((t: string) => void call('app:copyText', { text: t }).then(() => toast('Step log copied')), [toast]);
  const totalErrors = useMemo(() => lines.filter((l) => l.kind === 'error').length, [lines]);

  return (
    <div className="step-logs">
      <div className="step-logs-bar">
        <span className="small muted">
          {job.steps.length} steps
          {lines.length ? ` · ${lines.length.toLocaleString()} log lines` : ''}
          {totalErrors > 0 && <span className="text-danger"> · {totalErrors} error line(s)</span>}
        </span>
        {loading && <span className="live-dot" title="Fetching the log…" />}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setOpen(new Set(job.steps.map((s) => s.number)))}>
          Expand all
        </button>
        <button className="btn sm ghost" onClick={() => setOpen(new Set())}>
          Collapse all
        </button>
      </div>
      <Annotations repoId={repoId} jobId={job.id} done={!running} />
      {source && source.kind !== 'job' && (
        <div className="small muted step-logs-note" title={source.note ?? ''}>
          {source.kind === 'archive' ? '📦 Loaded from the run’s log archive (exact per-step output).' : '⌨ Loaded through your GitHub CLI login.'}
          {source.note ? ' The direct job log was not available.' : ''}
        </div>
      )}
      {truncated && <div className="banner info small">Only the last 512 KB of this job’s log are shown — early steps may be incomplete.</div>}
      {note && text === null && !running && (
        <div className="banner danger small">
          <span className="icon">⚠</span>
          <div className="grow">Could not load this job’s log: {note}</div>
          <button className="btn sm" onClick={() => void load()}>
            <Hourglass /> Retry
          </button>
        </div>
      )}
      {running && (
        <div className="logs-wait">
          <span className="logs-wait-spin" />
          <div>
            <strong>Logs appear when this job finishes.</strong>
            <div className="small muted">Follow progress in the step timeline above — each step’s output opens here as soon as the job completes.</div>
          </div>
        </div>
      )}

      <div className="step-list">
        {job.steps.map((s) => (
          <StepSection key={s.number} step={s} lines={byStep.get(s.number) ?? EMPTY} open={open.has(s.number)} onToggle={toggle} now={now} haveLog={text !== null} loading={loading} problem={note} onRetry={load} onCopy={copy} />
        ))}
        {job.steps.length === 0 && <div className="small muted step-logs-note">Steps appear once the job starts.</div>}
      </div>
    </div>
  );
}

const EMPTY: LogLine[] = [];

const StepSection = memo(function StepSection({
  step,
  lines,
  open,
  onToggle,
  now,
  haveLog,
  loading,
  problem,
  onRetry,
  onCopy,
}: {
  step: Step;
  lines: LogLine[];
  open: boolean;
  onToggle: (n: number) => void;
  now: number;
  haveLog: boolean;
  loading: boolean;
  problem: string | null;
  onRetry: () => void;
  onCopy: (text: string) => void;
}) {
  const st = runState(step.status, step.conclusion);
  const t = elapsed(step.startedAt ?? null, step.completedAt ?? null, now);
  const errors = useMemo(() => lines.filter((l) => l.kind === 'error').length, [lines]);
  const warnings = useMemo(() => lines.filter((l) => l.kind === 'warning').length, [lines]);
  return (
    <div className={`step-sec ${st} ${open ? 'open' : ''}`}>
      <button className="step-sec-head" onClick={() => onToggle(step.number)} aria-expanded={open}>
        <span className={`step-caret ${open ? 'open' : ''}`}>▸</span>
        <RunIcon status={step.status} conclusion={step.conclusion} size={16} />
        <span className="step-sec-name ellipsis">{step.name}</span>
        {errors > 0 && <span className="step-badge err">✕ {errors}</span>}
        {warnings > 0 && <span className="step-badge warn">⚠ {warnings}</span>}
        {haveLog && lines.length > 0 && (
          <span className="step-badge" title="Log lines">
            {lines.length}
          </span>
        )}
        <span className={`step-sec-time ${st === 'running' ? 'live' : ''}`}>{t !== null && st !== 'queued' ? duration(t) : ''}</span>
      </button>
      {open && <StepBody step={step} lines={lines} haveLog={haveLog} loading={loading} problem={problem} onRetry={onRetry} onCopy={onCopy} />}
    </div>
  );
});

function StepBody({ step, lines, haveLog, loading, problem, onRetry, onCopy }: { step: Step; lines: LogLine[]; haveLog: boolean; loading: boolean; problem: string | null; onRetry: () => void; onCopy: (text: string) => void }) {
  const [q, setQ] = useState('');
  const [hitIdx, setHitIdx] = useState(0);
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const [follow, setFollow] = useState(step.status === 'in_progress');
  const [wrap, setWrap] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const query = q.trim().toLowerCase();

  // Group membership (##[group] … ##[endgroup]).
  const rows = useMemo(() => {
    const out: (LogLine & { group: number | null })[] = [];
    let g: number | null = null;
    for (const l of lines) {
      if (l.kind === 'group') {
        g = l.n;
        out.push({ ...l, group: null });
      } else if (l.kind === 'endgroup') g = null;
      else out.push({ ...l, group: g });
    }
    return out;
  }, [lines]);
  const hits = useMemo(() => (query ? rows.filter((r) => r.text.toLowerCase().includes(query)).map((r) => r.n) : []), [rows, query]);
  const firstError = useMemo(() => rows.find((r) => r.kind === 'error')?.n ?? null, [rows]);

  const scrollTo = useCallback((n: number) => {
    const box = boxRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-n="${n}"]`);
    if (box && el) box.scrollTop = Math.max(0, el.offsetTop - 60);
  }, []);

  // A failed step opens at its first error.
  useEffect(() => {
    if (step.conclusion === 'failure' && firstError !== null) requestAnimationFrame(() => scrollTo(firstError));
  }, [step.conclusion, firstError, scrollTo]);
  // Follow the tail while running.
  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [rows.length, follow]);
  useEffect(() => {
    setHitIdx(0);
    if (hits.length) requestAnimationFrame(() => scrollTo(hits[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const go = (d: number) => {
    if (!hits.length) return;
    const i = (hitIdx + d + hits.length) % hits.length;
    setHitIdx(i);
    scrollTo(hits[i]);
  };

  if (!haveLog) {
    return (
      <div className="step-body pending">
        {step.status === 'in_progress' ? (
          <span className="step-wait">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
            Running — this step’s log opens here once the job has finished.
          </span>
        ) : step.status === 'completed' && !loading && !problem ? (
          <span className="step-wait">✓ Finished — the log is shown when the whole job completes.</span>
        ) : step.status === 'completed' ? (
          problem && !loading ? (
            <span className="step-problem">
              <span className="text-danger">Could not load the log: {problem}</span>
              <button className="btn sm" onClick={onRetry}>
                <Hourglass /> Retry
              </button>
            </span>
          ) : (
            <span className="step-wait">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              Loading the log…
            </span>
          )
        ) : (
          'Waiting to start.'
        )}
      </div>
    );
  }

  const visible = rows.filter((r) => r.group === null || !closed.has(r.group));
  const plain = () =>
    lines
      .filter((l) => l.kind !== 'endgroup')
      .map((l) => l.text)
      .join('\n');

  return (
    <div className="step-body">
      <div className="step-tools">
        <div className="step-search">
          <span>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go(e.shiftKey ? -1 : 1)} placeholder="Search this step (Enter / Shift+Enter)" spellCheck={false} />
          {query && (
            <span className="small muted nowrap">
              {hits.length ? `${hitIdx + 1}/${hits.length}` : '0 matches'}
              <button className="mini" onClick={() => go(-1)} aria-label="Previous match">
                ↑
              </button>
              <button className="mini" onClick={() => go(1)} aria-label="Next match">
                ↓
              </button>
            </span>
          )}
        </div>
        {firstError !== null && (
          <button className="btn sm ghost text-danger" onClick={() => scrollTo(firstError)}>
            ⤓ First error
          </button>
        )}
        <label className="check small nowrap">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> wrap
        </label>
        {step.status === 'in_progress' && (
          <label className="check small nowrap">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
          </label>
        )}
        <button className="btn sm ghost" onClick={() => onCopy(plain())} title="Copy this step's log">
          ⧉ Copy
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="step-body pending">No output for this step.</div>
      ) : (
        <div className={`step-log ${wrap ? 'wrap' : ''}`} ref={boxRef}>
          {visible.slice(0, 15000).map((r) =>
            r.kind === 'group' ? (
              <div
                key={r.n}
                data-n={r.n}
                className="sl group"
                onClick={() =>
                  setClosed((c) => {
                    const x = new Set(c);
                    if (x.has(r.n)) x.delete(r.n);
                    else x.add(r.n);
                    return x;
                  })
                }
              >
                <span className="ln">{r.n + 1}</span>
                <span className="tx">
                  {closed.has(r.n) ? '▸' : '▾'} {r.text}
                </span>
              </div>
            ) : (
              <div key={r.n} data-n={r.n} className={`sl ${r.kind} ${r.group !== null ? 'in-group' : ''} ${query && r.text.toLowerCase().includes(query) ? 'hit' : ''} ${hits[hitIdx] === r.n ? 'current' : ''}`}>
                <span className="ln">{r.n + 1}</span>
                <span className="tx">{r.text || ' '}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
