import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowJob } from '../../../../shared/github';
import { duration } from '../../../components/github/common';
import { elapsed, RunIcon, runState, STATE_LABEL } from './shared';

/**
 * Jobs grouped into stages. GitHub's job API does not expose `needs`, so stages are inferred from timing:
 * a job belongs after every job that had already finished when it started (jobs not started yet go last).
 */
export function inferStages(jobs: WorkflowJob[]): WorkflowJob[][] {
  const t = (s: string | null) => (s ? Date.parse(s) : NaN);
  const started = jobs.filter((j) => j.startedAt).sort((a, b) => t(a.startedAt) - t(b.startedAt));
  const pending = jobs.filter((j) => !j.startedAt);
  const col = new Map<number, number>();
  for (const j of started) {
    let c = 0;
    for (const o of started) {
      if (o === j || !o.completedAt) continue;
      // Finished (within a second) before this job started → this job waited for it.
      if (t(o.completedAt) <= t(j.startedAt) + 1000 && t(o.startedAt) < t(j.startedAt) - 1000) c = Math.max(c, (col.get(o.id) ?? 0) + 1);
    }
    col.set(j.id, c);
  }
  const stages: WorkflowJob[][] = [];
  for (const j of started) (stages[col.get(j.id)!] ??= []).push(j);
  const compact = stages.filter(Boolean);
  if (pending.length) compact.push(pending);
  return compact;
}

interface Props {
  jobs: WorkflowJob[];
  selected: number | null;
  now: number;
  onSelect: (id: number) => void;
}

/** Pipeline view: stage columns of job cards joined by flowing connectors; the running job pulses. */
export function PipelineGraph({ jobs, selected, now, onSelect }: Props) {
  const stages = useMemo(() => inferStages(jobs), [jobs]);
  const box = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<{ d: string; state: string }[]>([]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      const pos = (id: number) => el.querySelector<HTMLElement>(`[data-job="${id}"]`)?.getBoundingClientRect();
      const out: { d: string; state: string }[] = [];
      for (let s = 0; s < stages.length - 1; s++) {
        for (const a of stages[s]) {
          const ra = pos(a.id);
          if (!ra) continue;
          for (const z of stages[s + 1]) {
            const rz = pos(z.id);
            if (!rz) continue;
            const x1 = ra.right - b.left + el.scrollLeft;
            const y1 = ra.top - b.top + ra.height / 2;
            const x2 = rz.left - b.left + el.scrollLeft;
            const y2 = rz.top - b.top + rz.height / 2;
            const mx = (x1 + x2) / 2;
            out.push({ d: `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, state: runState(z.status, z.conclusion) });
          }
        }
      }
      setLinks(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stages]);

  if (!jobs.length) return <div className="small muted pad">Waiting for jobs to start…</div>;

  return (
    <div className="pipe" ref={box}>
      <svg className="pipe-links" aria-hidden>
        {links.map((l, i) => (
          <path key={i} d={l.d} className={`pipe-link ${l.state}`} />
        ))}
      </svg>
      {stages.map((stage, si) => {
        const done = stage.every((j) => j.status === 'completed');
        const bad = stage.some((j) => j.conclusion === 'failure');
        return (
          <div key={si} className="pipe-stage">
            <div className={`pipe-stage-head ${bad ? 'failure' : done ? 'success' : 'running'}`}>
              <span className="pipe-stage-n">{si + 1}</span>
              {stage.every((j) => !j.startedAt) ? 'Pending' : `Stage ${si + 1}`}
              <span className="pipe-stage-count">{stage.length}</span>
            </div>
            {stage.map((j) => {
              const st = runState(j.status, j.conclusion);
              const t = elapsed(j.startedAt, j.completedAt, now);
              const stepDone = j.steps.filter((s) => s.status === 'completed').length;
              const pct = j.steps.length ? stepDone / j.steps.length : st === 'success' ? 1 : 0;
              return (
                <button key={j.id} data-job={j.id} className={`pipe-job ${st} ${selected === j.id ? 'selected' : ''}`} onClick={() => onSelect(j.id)} title={`${j.name} — ${STATE_LABEL[st]}`}>
                  <span className="pipe-ring" style={{ ['--p' as string]: pct }}>
                    <RunIcon status={j.status} conclusion={j.conclusion} size={18} />
                  </span>
                  <span className="pipe-job-text">
                    <span className="ellipsis pipe-job-name">{j.name}</span>
                    <span className="small muted">
                      {st === 'running' && j.steps.length ? `step ${Math.min(stepDone + 1, j.steps.length)}/${j.steps.length}` : STATE_LABEL[st]}
                      {t !== null ? ` · ${duration(t)}` : ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Steps of a job as a Gantt strip: each bar's width is its share of the job's time. */
export function StepTimeline({ job, now }: { job: WorkflowJob; now: number }) {
  const steps = job.steps;
  const start = job.startedAt ? Date.parse(job.startedAt) : null;
  const end = job.completedAt ? Date.parse(job.completedAt) : now;
  if (!start || !steps.length) return null;
  const span = Math.max(1000, end - start);
  return (
    <div className="gantt" aria-label="Step timeline">
      {steps.map((s) => {
        const a = s.startedAt ? Date.parse(s.startedAt) : null;
        const b = s.completedAt ? Date.parse(s.completedAt) : a ? now : null;
        const st = runState(s.status, s.conclusion);
        if (a === null || b === null) return <span key={s.number} className={`gantt-bar ${st} ghost`} style={{ flex: 0.4 }} title={`${s.name} — ${STATE_LABEL[st]}`} />;
        return (
          <span
            key={s.number}
            className={`gantt-bar ${st}`}
            style={{ flex: Math.max(0.4, ((b - a) / span) * 100) }}
            title={`${s.number}. ${s.name} — ${STATE_LABEL[st]} · ${duration(Math.max(0, b - a))}`}
          />
        );
      })}
    </div>
  );
}
