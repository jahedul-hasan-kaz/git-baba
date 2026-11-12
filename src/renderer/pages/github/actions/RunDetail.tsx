import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepoTag, WorkflowJob } from '../../../../shared/github';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { duration, relTime, Skeleton, useGh, useMutation } from '../../../components/github/common';
import { Modal } from '../../../components/Modal';
import { ConfirmDialog } from '../../../dialogs/ConfirmDialog';
import { call } from '../../../services/api';
import { useApp } from '../../../state/AppState';
import { StepLogs } from './StepLogs';
import { PipelineGraph, StepTimeline } from './PipelineGraph';
import { elapsed, indexTags, RunIcon, runState, STATE_LABEL, TagChip, tagsForRun, useTicker } from './shared';
import { Hourglass } from '../../../components/Hourglass';

const POLL_MS = 3000;

type RunAction = 'rerun' | 'rerun-failed' | 'cancel';

interface Props {
  repoId: string;
  runId: number;
  canWrite: boolean;
  tags: RepoTag[] | null;
  onBack: () => void;
  onChanged: () => void;
}

/**
 * One workflow run, live: status hero with a running clock, a job progress bar, the job list and the
 * selected job's step timeline (the running step is animated), logs with search, and cancel / re-run.
 * Polls every few seconds while anything is still running and celebrates when it turns green.
 */
export function RunDetail({ repoId, runId, canWrite, tags, onBack, onChanged }: Props) {
  const { toast } = useApp();
  const data = useGh(() => call('gh:runJobs', { repoId, runId }), [repoId, runId]);
  const [action, setAction] = useState<RunAction | null>(null);
  const [rerunJob, setRerunJob] = useState<WorkflowJob | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [logs, setLogs] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const { busy, run } = useMutation();
  const prevState = useRef<string | null>(null);

  const r = data.data?.run;
  const jobs = data.data?.jobs ?? [];
  const live = !!r && r.status !== 'completed';
  const now = useTicker(live || jobs.some((j) => j.status !== 'completed'));

  // Live updates while the run is in progress (and once more right after it finishes).
  const reload = data.reload;
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(t);
  }, [live, reload]);

  // Celebrate the transition to success; notify on failure.
  useEffect(() => {
    if (!r) return;
    const s = runState(r.status, r.conclusion);
    if (prevState.current && prevState.current !== s && (prevState.current === 'running' || prevState.current === 'queued')) {
      if (s === 'success') {
        setCelebrate(true);
        toast(`✓ ${r.name} #${r.runNumber} succeeded`);
        setTimeout(() => setCelebrate(false), 2600);
      } else if (s === 'failure') toast(`${r.name} #${r.runNumber} failed`, 'info');
      onChanged();
    }
    prevState.current = s;
  }, [r, toast, onChanged]);

  // Follow the job that is running (until the user picks one).
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || jobs.length === 0) return;
    const running = jobs.find((j) => j.status === 'in_progress') ?? jobs.find((j) => j.conclusion === 'failure') ?? jobs[0];
    setSelected(running.id);
  }, [jobs]);

  const { bySha, names } = useMemo(() => indexTags(tags), [tags]);

  if (data.error && !data.data) {
    return (
      <div className="content">
        <button className="btn sm ghost mb" onClick={onBack}>
          ← All runs
        </button>
        <ErrorPanel error={data.error} />
      </div>
    );
  }
  if (!r) return <div className="content"><Skeleton rows={6} /></div>;

  const state = runState(r.status, r.conclusion);
  const done = r.status === 'completed';
  const failed = done && (state === 'failure' || state === 'cancelled');
  const job = jobs.find((j) => j.id === selected) ?? null;
  const runTags = tagsForRun(r, bySha, names);
  const total = elapsed(r.startedAt ?? r.createdAt, done ? r.updatedAt : null, now);

  return (
    <div className="content run-detail">
      <header className="run-top">
        <nav className="prc-crumbs" aria-label="Breadcrumb">
          <button className="prc-crumb back" onClick={onBack} title="Back to all runs">
            <span className="prc-crumb-ico">▶</span> All runs
          </button>
          <span className="prc-crumb here ellipsis" aria-current="page" title={`${r.name} #${r.runNumber}`}>
            {r.name} #{r.runNumber}
          </span>
        </nav>
        <span className="spacer" />
        {live && <span className="live-dot" title="Updating live" />}
        {!done && (
          <button className="btn sm danger" disabled={!canWrite || busy} onClick={() => setAction('cancel')} title={canWrite ? 'Stop every job of this run' : 'Requires write access'}>
            ⏹ Cancel run
          </button>
        )}
        {failed && (
          <button className="btn sm" disabled={!canWrite || busy} onClick={() => setAction('rerun-failed')}>
            <Hourglass /> Re-run failed jobs
          </button>
        )}
        {job && job.status === 'completed' && (
          <button className="btn sm" disabled={!canWrite || busy} onClick={() => setRerunJob(job)} title={`Re-run only ${job.name}`}>
            <Hourglass /> Re-run job
          </button>
        )}
        <button className="btn sm ghost" disabled={data.loading} onClick={() => void reload()} title="Refresh">
          <Hourglass />
        </button>
      </header>

      <div className={`run-hero ${state} ${celebrate ? 'celebrate' : ''}`}>
        {celebrate && (
          <div className="confetti" aria-hidden>
            {Array.from({ length: 18 }, (_, i) => (
              <i key={i} style={{ ['--i' as string]: i }} />
            ))}
          </div>
        )}
        <RunIcon status={r.status} conclusion={r.conclusion} size={40} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="run-hero-title ellipsis">
            {r.title} <span className="muted">#{r.runNumber}</span>
          </div>
          <div className="run-hero-meta">
            <span className={`run-state-pill ${state}`}>{STATE_LABEL[state]}</span>
            <span>{r.name}</span>
            <span>· {r.event.replace(/_/g, ' ')}</span>
            {r.branch && <span className="branch-pill">{r.branch}</span>}
            <button className="sha-chip" title="Copy commit id" onClick={() => void call('app:copyText', { text: r.sha }).then(() => toast('Commit id copied'))}>
              {r.sha.slice(0, 7)}
            </button>
            {runTags.map((t) => (
              <TagChip key={t} name={t} />
            ))}
            {r.actor && <span>· by {r.actor}</span>}
            {r.attempt > 1 && <span>· attempt {r.attempt}</span>}
          </div>
        </div>
        <div className="run-clock">
          <div className={`run-clock-time ${live ? 'live' : ''}`}>{duration(total)}</div>
          <div className="small muted">{live ? 'elapsed' : `finished ${relTime(r.updatedAt)}`}</div>
        </div>
      </div>

      <PipelineGraph
        jobs={jobs}
        selected={selected}
        now={now}
        onSelect={(id) => {
          picked.current = true;
          setSelected(id);
        }}
      />

      <div className="run-body wide">
        <div className="run-steps">
          {!job ? (
            <div className="empty small">Select a job to see its steps.</div>
          ) : (
            <>
              <div className="run-steps-head">
                <RunIcon status={job.status} conclusion={job.conclusion} size={22} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong className="ellipsis">{job.name}</strong>
                  <div className="small muted">
                    {job.labels?.length ? `runs on ${job.labels.join(', ')}` : ''}
                    {job.runnerName ? ` · ${job.runnerName}` : ''}
                  </div>
                </div>
                <button
                  className="btn sm"
                  disabled={busy || job.status !== 'completed'}
                  title={job.status === 'completed' ? 'Show the job log' : 'Logs are available when the job finishes'}
                  onClick={() => void run(() => call('gh:jobLogs', { repoId, jobId: job.id, runId, jobName: job.name })).then((l) => l && setLogs({ name: job.name, ...l }))}
                >
                  ≡ Logs
                </button>
              </div>
              {job.status === 'completed' ? (
                <>
                  <StepTimeline job={job} now={now} />
                  <StepLogs repoId={repoId} runId={runId} job={job} now={now} />
                </>
              ) : (
                <div className="empty small">The log appears here when this job finishes.</div>
              )}
            </>
          )}
        </div>
      </div>

      {logs && <LogViewer logs={logs} onClose={() => setLogs(null)} />}
      {action && (
        <ConfirmDialog
          title={action === 'cancel' ? 'Cancel workflow run' : action === 'rerun' ? 'Re-run all jobs' : 'Re-run failed jobs'}
          explanation={
            <>
              {action === 'cancel' ? 'Stops' : 'Starts again'} run #{r.runNumber} of “{r.name}” on {r.branch ?? 'its ref'}.
            </>
          }
          impact={action === 'cancel' ? 'Running jobs are stopped; partial results (and partial deployments) may remain.' : 'Uses Actions minutes and may repeat deployment or publishing steps defined in the workflow.'}
          confirmLabel={action === 'cancel' ? 'Cancel run' : 'Re-run'}
          danger={action === 'cancel'}
          onCancel={() => setAction(null)}
          onConfirm={async () => {
            await run(() => call('gh:runAction', { repoId, runId, action, confirmed: true }), action === 'cancel' ? 'Cancellation requested' : 'Re-run started');
            setAction(null);
            picked.current = false;
            setTimeout(() => void data.reload(), 1500);
            onChanged();
          }}
        />
      )}
      {rerunJob && (
        <ConfirmDialog
          title="Re-run job"
          explanation={<>Starts “{rerunJob.name}” again (jobs it depends on are not re-run).</>}
          impact="Uses Actions minutes and may repeat deployment steps in this job."
          confirmLabel="Re-run job"
          onCancel={() => setRerunJob(null)}
          onConfirm={async () => {
            await run(() => call('gh:rerunJob', { repoId, jobId: rerunJob.id, confirmed: true }), 'Job re-run started');
            setRerunJob(null);
            setTimeout(() => void data.reload(), 1500);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** Log viewer: line numbers, collapsible ::group:: sections, error lines highlighted, search with match count. */
function LogViewer({ logs, onClose }: { logs: { name: string; text: string; truncated: boolean }; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [stamps, setStamps] = useState(false);
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const lines = useMemo(() => logs.text.replace(/\r/g, '').split('\n'), [logs.text]);
  const q = query.trim().toLowerCase();
  const strip = (l: string) => (stamps ? l : l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''));

  const rows: { n: number; text: string; group?: boolean; inGroup: number | null; err: boolean }[] = [];
  let group: number | null = null;
  lines.forEach((raw, i) => {
    const l = strip(raw);
    if (/##\[group\]/.test(l)) {
      group = i;
      rows.push({ n: i, text: l.replace(/.*##\[group\]/, ''), group: true, inGroup: null, err: false });
    } else if (/##\[endgroup\]/.test(l)) group = null;
    else rows.push({ n: i, text: l.replace(/##\[(error|warning|notice)\]/, (_, k: string) => `${k.toUpperCase()}: `), inGroup: group, err: /##\[error\]|\berror\b/i.test(l) });
  });
  const shown = rows.filter((x) => (x.group || x.inGroup === null || !closed.has(x.inGroup) || (q && x.text.toLowerCase().includes(q))) && (!q || x.group || x.text.toLowerCase().includes(q)));
  const matches = q ? rows.filter((x) => x.text.toLowerCase().includes(q)).length : 0;

  return (
    <Modal title={`Logs — ${logs.name}`} size="wide" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {logs.truncated && <div className="banner info small">Only the last 512 KB are shown.</div>}
      <div className="row mb">
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the log…" spellCheck={false} />
        {q && <span className="small muted nowrap">{matches} match(es)</span>}
        <label className="check small nowrap">
          <input type="checkbox" checked={stamps} onChange={(e) => setStamps(e.target.checked)} /> timestamps
        </label>
        <button className="btn sm ghost" onClick={() => setClosed(new Set(rows.filter((x) => x.group).map((x) => x.n)))}>
          Collapse groups
        </button>
        <button className="btn sm ghost" onClick={() => setClosed(new Set())}>
          Expand
        </button>
      </div>
      <div className="log-pro">
        {shown.slice(0, 20000).map((x) =>
          x.group ? (
            <div
              key={x.n}
              className="log-line group"
              onClick={() =>
                setClosed((s) => {
                  const n = new Set(s);
                  if (n.has(x.n)) n.delete(x.n);
                  else n.add(x.n);
                  return n;
                })
              }
            >
              <span className="ln">{x.n + 1}</span>
              <span className="txt">
                {closed.has(x.n) ? '▸' : '▾'} {x.text}
              </span>
            </div>
          ) : (
            <div key={x.n} className={`log-line ${x.err ? 'err' : ''} ${q && x.text.toLowerCase().includes(q) ? 'hit' : ''}`}>
              <span className="ln">{x.n + 1}</span>
              <span className="txt">{x.text}</span>
            </div>
          ),
        )}
      </div>
    </Modal>
  );
}
