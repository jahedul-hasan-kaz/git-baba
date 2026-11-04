import { useCallback, useEffect, useRef, useState } from 'react';
import type { LabelGate, PrCheck, PrDetails, RepoMetadata } from '../../../../shared/github';
import { useGh, useMutation } from '../../../components/github/common';
import { call } from '../../../services/api';

interface Props {
  repoId: string;
  pr: PrDetails;
  metadata: RepoMetadata | null;
  canWrite: boolean;
  /** Checks of the pull request's latest commit. */
  checks: PrCheck[];
  /** Reloads the pull request (its labels changed). */
  onChanged: () => void;
  /** Reloads the checks list. */
  onRefreshChecks: () => void;
}

const WATCH_MS = 90_000;
const POLL_MS = 5_000;

/**
 * Workflows such as a "guard" that need a label on the pull request. The labels the workflow looks for are
 * read from its YAML; adding one here starts (or re-runs) the workflow and the checks are watched until it
 * has finished, so the pull request moves on without leaving the app.
 */
export function LabelGates({ repoId, pr, metadata, canWrite, checks, onChanged, onRefreshChecks }: Props) {
  const gates = useGh(() => call('gh:labelGates', { repoId, ref: pr.headRefOid }), [repoId, pr.headRefOid]);
  const { busy, run } = useMutation();
  const [working, setWorking] = useState<string | null>(null);
  const [note, setNote] = useState<{ gate: string; text: string; tone: 'ok' | 'info' | 'warn' } | null>(null);
  const [watching, setWatching] = useState<{ until: number; startedAt: number; workflow: string } | null>(null);
  const refreshRef = useRef(onRefreshChecks);
  refreshRef.current = onRefreshChecks;

  const have = new Set(pr.labels.map((l) => l.name.toLowerCase()));
  const statusOf = (g: LabelGate) => {
    const mine = checks.filter((c) => c.workflow === g.name);
    return {
      failed: mine.some((c) => c.status === 'failed'),
      active: mine.some((c) => c.status === 'running' || c.status === 'pending'),
      passed: mine.length > 0 && mine.every((c) => c.status === 'passed' || c.status === 'skipped' || c.status === 'neutral'),
      any: mine.length > 0,
    };
  };

  // Keep checking the workflow after a label change until it settles (or the watch window ends).
  useEffect(() => {
    if (!watching) return;
    const t = window.setInterval(() => {
      if (Date.now() > watching.until) {
        setWatching(null);
        return;
      }
      refreshRef.current();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [watching]);

  const gate = watching ? (gates.data ?? []).find((g) => g.name === watching.workflow) : null;
  const watchedStatus = gate ? statusOf(gate) : null;
  useEffect(() => {
    if (!watching || !watchedStatus) return;
    // Settled: finished and at least one poll after the label was added.
    if (!watchedStatus.active && watchedStatus.any && Date.now() - watching.startedAt > POLL_MS + 1500) {
      setWatching(null);
      setNote({
        gate: watching.workflow,
        tone: watchedStatus.passed ? 'ok' : 'warn',
        text: watchedStatus.passed ? `✓ ${watching.workflow} passed — the pull request can move on.` : `${watching.workflow} finished but still failed. Open its logs below to see why.`,
      });
      onChanged();
    }
  }, [watching, watchedStatus?.active, watchedStatus?.passed, watchedStatus?.any]); // eslint-disable-line react-hooks/exhaustive-deps

  const repoHasLabel = useCallback((name: string) => (metadata?.labels ?? []).some((l) => l.name.toLowerCase() === name.toLowerCase()), [metadata]);

  const setLabels = async (labels: string[]) => {
    await call('gh:prLabels', { repoId, number: pr.number, labels });
  };

  const addLabel = async (g: LabelGate, label: string) => {
    setWorking(`${g.workflowId}:${label}`);
    setNote(null);
    try {
      const done = await run(async () => {
        if (metadata && !repoHasLabel(label)) await call('gh:labelCreate', { repoId, name: label, color: 'ededed', description: `Required by the ${g.name} workflow` });
        await setLabels([...pr.labels.map((l) => l.name), label]);
        return true;
      }, `Added label “${label}”`);
      if (!done) return;
      onChanged();

      if (g.reactsToLabeling) {
        setNote({ gate: g.name, tone: 'info', text: `GitHub starts “${g.name}” automatically because it listens for label changes. Watching it…` });
      } else {
        // The workflow does not listen for labels: start its previous run again.
        const runs = await run(() => call('gh:runs', { repoId, workflowId: g.workflowId, branch: pr.headRefName }));
        const latest = runs?.runs.find((x) => x.sha === pr.headRefOid) ?? runs?.runs[0];
        if (latest && latest.status === 'completed') {
          await run(() => call('gh:runAction', { repoId, runId: latest.id, action: latest.conclusion === 'success' ? 'rerun' : 'rerun-failed', confirmed: true }), `Re-running ${g.name}`);
          setNote({
            gate: g.name,
            tone: 'info',
            text: `Re-running “${g.name}”. Re-runs reuse the original event data, so if the workflow reads labels from the event it may still fail — add “labeled” to its pull_request types to make this automatic.`,
          });
        } else {
          setNote({ gate: g.name, tone: 'warn', text: `Label added, but “${g.name}” has no finished run to repeat and does not listen for label changes. Push a commit or start it from the Actions tab.` });
        }
      }
      setWatching({ until: Date.now() + WATCH_MS, startedAt: Date.now(), workflow: g.name });
      setTimeout(() => refreshRef.current(), 2500);
    } finally {
      setWorking(null);
    }
  };

  const removeLabel = async (g: LabelGate, label: string) => {
    setWorking(`${g.workflowId}:${label}`);
    try {
      const ok = await run(() => setLabels(pr.labels.map((l) => l.name).filter((n) => n.toLowerCase() !== label.toLowerCase())).then(() => true), `Removed label “${label}”`);
      if (ok) {
        onChanged();
        if (g.reactsToLabeling) setWatching({ until: Date.now() + WATCH_MS, startedAt: Date.now(), workflow: g.name });
        setTimeout(() => refreshRef.current(), 2500);
      }
    } finally {
      setWorking(null);
    }
  };

  const rerun = async (g: LabelGate) => {
    setWorking(`${g.workflowId}:rerun`);
    try {
      const runs = await run(() => call('gh:runs', { repoId, workflowId: g.workflowId, branch: pr.headRefName }));
      const latest = runs?.runs.find((x) => x.sha === pr.headRefOid) ?? runs?.runs[0];
      if (!latest) return;
      await run(() => call('gh:runAction', { repoId, runId: latest.id, action: 'rerun-failed', confirmed: true }), `Re-running ${g.name}`);
      setWatching({ until: Date.now() + WATCH_MS, startedAt: Date.now(), workflow: g.name });
      setTimeout(() => refreshRef.current(), 2500);
    } finally {
      setWorking(null);
    }
  };

  const items = (gates.data ?? [])
    .map((g) => {
      const missing = g.requiredLabels.filter((l) => !have.has(l.toLowerCase()));
      const blocking = g.blockingLabels.filter((l) => have.has(l.toLowerCase()));
      return { g, missing, blocking, st: statusOf(g) };
    })
    // Only gates that need something from the user, are being watched, or have a result worth explaining.
    .filter((x) => x.missing.length > 0 || x.blocking.length > 0 || (x.st.failed && x.g.requiredLabels.length > 0) || watching?.workflow === x.g.name || note?.gate === x.g.name);

  if (items.length === 0) return null;

  return (
    <div className="label-gates fade-in">
      {items.map(({ g, missing, blocking, st }) => {
        const isWatching = watching?.workflow === g.name;
        const state = st.active || isWatching ? 'warn' : st.passed && missing.length === 0 && blocking.length === 0 ? 'ok' : 'danger';
        return (
          <div key={g.workflowId} className={`label-gate ${state}`}>
            <div className="label-gate-head">
              <span className="label-gate-icon">🏷</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <strong>{g.name}</strong>
                <div className="small muted">
                  {missing.length > 0
                    ? `This workflow needs ${missing.length > 1 ? 'one of these labels' : 'a label'} on the pull request.`
                    : blocking.length > 0
                      ? 'A label on this pull request blocks the workflow.'
                      : st.failed
                        ? 'The required label is present but the workflow still failed.'
                        : 'Label requirement met.'}
                  {isWatching && ' Waiting for it to run…'}
                </div>
              </div>
              <span className="mono small muted ellipsis">{g.path.replace('.github/workflows/', '')}</span>
            </div>

            {missing.length > 0 && (
              <div className="label-gate-actions">
                {missing.map((l) => (
                  <button
                    key={l}
                    className="btn sm primary"
                    disabled={!canWrite || busy || working !== null}
                    title={canWrite ? (repoHasLabel(l) ? `Add “${l}” to this pull request` : `“${l}” does not exist in the repository yet — it will be created`) : 'Changing labels needs write access'}
                    onClick={() => void addLabel(g, l)}
                  >
                    {working === `${g.workflowId}:${l}` ? 'Adding…' : `＋ ${l}`}
                    {g.reactsToLabeling ? '' : ' & re-run'}
                  </button>
                ))}
                {!g.reactsToLabeling && <span className="small muted">This workflow does not listen for label changes, so it is re-run after the label is added.</span>}
              </div>
            )}

            {blocking.length > 0 && (
              <div className="label-gate-actions">
                {blocking.map((l) => (
                  <button key={l} className="btn sm" disabled={!canWrite || busy || working !== null} onClick={() => void removeLabel(g, l)}>
                    − Remove “{l}”
                  </button>
                ))}
              </div>
            )}

            {missing.length === 0 && blocking.length === 0 && st.failed && !isWatching && (
              <div className="label-gate-actions">
                <button className="btn sm" disabled={!canWrite || busy || working !== null} onClick={() => void rerun(g)}>
                  ⟳ Re-run workflow
                </button>
              </div>
            )}

            {note?.gate === g.name && <div className={`small label-gate-note ${note.tone}`}>{note.text}</div>}
          </div>
        );
      })}
    </div>
  );
}
