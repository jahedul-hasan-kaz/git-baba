import { useEffect, useState } from 'react';
import type { RepoTag, WorkflowRun } from '../../../../shared/github';
import { call } from '../../../services/api';
import { useApp } from '../../../state/AppState';

export type RunState = 'running' | 'queued' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'waiting';

export function runState(status: string, conclusion: string | null): RunState {
  if (status === 'in_progress') return 'running';
  if (status === 'waiting' || status === 'action_required' || status === 'requested') return 'waiting';
  if (status !== 'completed') return 'queued';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return 'failure';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'skipped') return 'skipped';
  if (conclusion === 'action_required') return 'waiting';
  return 'neutral';
}

export const STATE_LABEL: Record<RunState, string> = {
  running: 'In progress',
  queued: 'Queued',
  waiting: 'Waiting',
  success: 'Success',
  failure: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  neutral: 'Neutral',
};

/** Animated status glyph: spinning ring while running, pulse while queued, a check that pops on success. */
export function RunIcon({ status, conclusion, size = 18 }: { status: string; conclusion: string | null; size?: number }) {
  const s = runState(status, conclusion);
  return (
    <span className={`run-ico ${s}`} style={{ width: size, height: size }} title={STATE_LABEL[s]} aria-label={STATE_LABEL[s]}>
      {s === 'running' ? (
        <svg viewBox="0 0 20 20" width={size} height={size}>
          <circle cx="10" cy="10" r="7.5" className="track" />
          <circle cx="10" cy="10" r="7.5" className="arc" />
          <circle cx="10" cy="10" r="2.6" className="core" />
        </svg>
      ) : s === 'success' ? (
        <svg viewBox="0 0 20 20" width={size} height={size}>
          <circle cx="10" cy="10" r="9" className="disc" />
          <path d="M5.8 10.4l2.8 2.8 5.6-6" className="tick" />
        </svg>
      ) : s === 'failure' ? (
        <svg viewBox="0 0 20 20" width={size} height={size}>
          <circle cx="10" cy="10" r="9" className="disc" />
          <path d="M6.8 6.8l6.4 6.4M13.2 6.8l-6.4 6.4" className="cross" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width={size} height={size}>
          <circle cx="10" cy="10" r="7.5" className="ring" />
          {s === 'cancelled' && <path d="M5 15L15 5" className="slash" />}
        </svg>
      )}
    </span>
  );
}

/** Re-renders every `ms` while `active` — for live timers. */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [active, ms]);
  return now;
}

/** Elapsed time of a run: live while it runs, final once completed. */
export function elapsed(start: string | null, end: string | null, now: number): number | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : now;
  return e >= s ? e - s : null;
}

/** Tags pointing at the run's commit, plus the tag itself when the run was triggered by pushing a tag. */
export function tagsForRun(run: WorkflowRun, bySha: Map<string, string[]>, tagNames: Set<string>): string[] {
  const out = new Set(bySha.get(run.sha) ?? []);
  if (run.branch && tagNames.has(run.branch)) out.add(run.branch);
  return [...out];
}

export function indexTags(tags: RepoTag[] | null | undefined) {
  const bySha = new Map<string, string[]>();
  for (const t of tags ?? []) bySha.set(t.sha, [...(bySha.get(t.sha) ?? []), t.name]);
  return { bySha, names: new Set((tags ?? []).map((t) => t.name)) };
}

/** A tag chip that copies its name on click. */
export function TagChip({ name }: { name: string }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`run-tag ${copied ? 'copied' : ''}`}
      title={`Tag ${name} — click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        void call('app:copyText', { text: name }).then(() => {
          setCopied(true);
          toast(`Copied tag ${name}`);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      <span className="run-tag-ico">{copied ? '✓' : '🏷'}</span>
      <span className="run-tag-name">{name}</span>
      <span className="run-tag-copy">{copied ? 'copied' : '⧉'}</span>
    </button>
  );
}

export const openUrl = (url: string) => void call('shell:openExternal', { url }).catch(() => undefined);
