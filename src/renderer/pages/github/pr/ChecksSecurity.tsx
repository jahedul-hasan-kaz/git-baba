import { useEffect, useMemo, useState } from 'react';
import type { CodeScanningAlert, PrCheck, PrDetails, RefChecks, RepoMetadata, SecurityList } from '../../../../shared/github';
import type { FriendlyError } from '../../../../shared/types';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { duration, relTime, SeverityBadge, Skeleton, useGh, useMutation } from '../../../components/github/common';
import { Modal } from '../../../components/Modal';
import { ConfirmDialog } from '../../../dialogs/ConfirmDialog';
import { call, toFriendly } from '../../../services/api';
import { CHECK_STATE } from './CommitsTimeline';
import { LabelGates } from './LabelGates';

import { Select } from '../../../components/Select';
import { Hourglass } from '../../../components/Hourglass';
const CHECK_ICON: Record<PrCheck['status'], [string, string, string]> = {
  passed: ['✓', 'ok', 'Passed'],
  failed: ['✕', 'danger', 'Failed'],
  pending: ['○', 'warn', 'Queued'],
  running: ['◌', 'warn', 'Running'],
  cancelled: ['⊘', 'muted', 'Cancelled'],
  skipped: ['⤼', 'muted', 'Skipped'],
  neutral: ['–', 'muted', 'Neutral'],
};

/** Workflows and checks that are about code security (scanners, dependency review, secrets). */
const SECURITY_RE = /codeql|code[\s-]?scan|security|secur|sast|dast|snyk|trivy|semgrep|sonar|gitleaks|secret|dependency[\s-]?review|dependabot|grype|bandit|checkmarx|veracode|ossf|scorecard|zap/i;
const isSecurity = (c: PrCheck) => SECURITY_RE.test(`${c.workflow ?? ''} ${c.name}`);

type Target = { kind: 'pr' } | { kind: 'commit'; oid: string } | { kind: 'branch'; name: string };

interface Props {
  repoId: string;
  pr: PrDetails;
  metadata: RepoMetadata | null;
  canWrite: boolean;
  initialCommit: string | null;
  /** The pull request changed (e.g. a label was added). */
  onChanged: () => void;
}

/**
 * Checks and code-security status of the pull request — or of any of its commits, or any branch.
 * Grouped by workflow, security workflows called out, plus open code scanning alerts for the ref.
 */
export function ChecksSecurity({ repoId, pr, metadata, canWrite, initialCommit, onChanged }: Props) {
  const [target, setTarget] = useState<Target>(initialCommit && initialCommit !== pr.headRefOid ? { kind: 'commit', oid: initialCommit } : { kind: 'pr' });
  const [only, setOnly] = useState<'all' | 'security' | 'failed'>('all');
  const [data, setData] = useState<RefChecks | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [logs, setLogs] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const [rerun, setRerun] = useState<PrCheck | null>(null);
  const { busy, run } = useMutation();
  const commits = useGh(() => call('gh:prCommits', { repoId, number: pr.number }), [repoId, pr.number, pr.headRefOid]);

  useEffect(() => {
    if (initialCommit) setTarget(initialCommit === pr.headRefOid ? { kind: 'pr' } : { kind: 'commit', oid: initialCommit });
  }, [initialCommit, pr.headRefOid]);

  const ref = target.kind === 'pr' ? pr.headRefOid : target.kind === 'commit' ? target.oid : target.name;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    call('gh:refChecks', { repoId, ref, prNumber: target.kind === 'branch' ? undefined : pr.number })
      .then((d) => live && setData(d))
      .catch((err) => {
        if (!live) return;
        setData(null);
        setError(toFriendly(err));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [repoId, ref, target.kind, pr.number, tick]);

  // Code scanning analyses branches and the pull request merge ref, not single commits.
  const alertRef = target.kind === 'branch' ? `refs/heads/${target.name}` : `refs/pull/${pr.number}/merge`;
  const [alerts, setAlerts] = useState<SecurityList<CodeScanningAlert> | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setAlerts(null);
    setAlertsError(null);
    call('gh:codeScanning', { repoId, state: 'open', ref: alertRef })
      .then((a) => live && setAlerts(a))
      .catch((err) => live && setAlertsError(toFriendly(err).message));
    return () => {
      live = false;
    };
  }, [repoId, alertRef, tick]);

  const checks = data?.checks ?? [];
  const counts = useMemo(() => {
    const c = { passed: 0, failed: 0, running: 0, other: 0, security: 0, securityFailed: 0 };
    for (const k of checks) {
      if (k.status === 'passed') c.passed++;
      else if (k.status === 'failed') c.failed++;
      else if (k.status === 'running' || k.status === 'pending') c.running++;
      else c.other++;
      if (isSecurity(k)) {
        c.security++;
        if (k.status === 'failed') c.securityFailed++;
      }
    }
    return c;
  }, [checks]);

  const shown = checks.filter((c) => (only === 'security' ? isSecurity(c) : only === 'failed' ? c.status === 'failed' : true));
  const groups = useMemo(() => {
    const m = new Map<string, PrCheck[]>();
    for (const c of shown) {
      const key = c.workflow ?? (c.kind === 'status' ? 'Commit statuses' : 'Other checks');
      m.set(key, [...(m.get(key) ?? []), c]);
    }
    // Failing groups first, then security, then the rest.
    return [...m.entries()].sort((a, b) => Number(b[1].some((c) => c.status === 'failed')) - Number(a[1].some((c) => c.status === 'failed')) || Number(b[1].some(isSecurity)) - Number(a[1].some(isSecurity)));
  }, [shown]);

  const overall = data?.state ? CHECK_STATE[data.state] : null;
  const branchNames = metadata?.branches ?? [];

  return (
    <div className="fade-in">
      <div className="target-bar">
        <div className="segmented">
          <button className={target.kind === 'pr' ? 'on' : ''} onClick={() => setTarget({ kind: 'pr' })}>
            Latest commit
          </button>
          <button className={target.kind === 'commit' ? 'on' : ''} onClick={() => setTarget({ kind: 'commit', oid: commits.data?.commits[0]?.oid ?? pr.headRefOid })}>
            A commit
          </button>
          <button className={target.kind === 'branch' ? 'on' : ''} onClick={() => setTarget({ kind: 'branch', name: pr.headRefName })}>
            A branch
          </button>
        </div>
        {target.kind === 'commit' && (
          <Select kind="commit" value={target.oid} onChange={(e) => setTarget({ kind: 'commit', oid: e.target.value })} className="target-select">
            {(commits.data?.commits ?? [])
              .slice()
              .reverse()
              .map((c) => (
                <option key={c.oid} value={c.oid}>
                  {c.checkState ? `${CHECK_STATE[c.checkState]?.icon ?? '–'} ` : '– '}
                  {c.shortOid} · {c.headline.slice(0, 70)}
                </option>
              ))}
          </Select>
        )}
        {target.kind === 'branch' && (
          <Select kind="branch" value={target.name} onChange={(e) => setTarget({ kind: 'branch', name: e.target.value })} className="target-select">
            {[...new Set([pr.headRefName, pr.baseRefName, ...branchNames])].map((b) => (
              <option key={b} value={b}>
                {b}
                {b === pr.headRefName ? ' (compare)' : b === pr.baseRefName ? ' (base)' : ''}
              </option>
            ))}
          </Select>
        )}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setTick((t) => t + 1)}>
          <Hourglass /> Refresh
        </button>
      </div>

      {target.kind === 'pr' && <LabelGates repoId={repoId} pr={pr} metadata={metadata} canWrite={canWrite} checks={checks} onChanged={onChanged} onRefreshChecks={() => setTick((t) => t + 1)} />}

      {error && <ErrorPanel error={error} />}
      {loading && !data && <Skeleton rows={4} />}

      {data && (
        <div className={loading ? 'is-loading' : ''}>
          <div className={`checks-hero ${overall?.cls ?? 'muted'}`}>
            <span className="checks-hero-icon">{overall?.icon ?? '–'}</span>
            <div className="grow">
              <div className="merge-title">{overall?.label ?? 'No checks ran on this commit'}</div>
              <div className="small">
                <span className="mono">{data.oid.slice(0, 7)}</span> {data.headline} {data.date && <span className="muted">· {relTime(data.date)}</span>}
              </div>
            </div>
            <div className="checks-counts">
              <span className="text-ok">✓ {counts.passed}</span>
              <span className="text-danger">✕ {counts.failed}</span>
              <span className="text-warn">◌ {counts.running}</span>
              {counts.other > 0 && <span className="muted">– {counts.other}</span>}
            </div>
          </div>
          {checks.length > 0 && (
            <span className="check-bar wide">
              <i className="ok" style={{ flex: counts.passed }} />
              <i className="danger" style={{ flex: counts.failed }} />
              <i className="warn" style={{ flex: counts.running }} />
              <i className="muted" style={{ flex: counts.other }} />
            </span>
          )}

          <div className={`security-strip ${counts.securityFailed ? 'danger' : counts.security ? 'ok' : 'muted'}`}>
            <span>🛡</span>
            <div className="grow">
              {counts.security === 0 ? (
                <>No code-security workflow ran on this {target.kind === 'branch' ? 'branch head' : 'commit'} (CodeQL, dependency review, secret scanning…).</>
              ) : counts.securityFailed ? (
                <>
                  <strong>{counts.securityFailed}</strong> of {counts.security} security check(s) failed.
                </>
              ) : (
                <>All {counts.security} security check(s) passed.</>
              )}
            </div>
            <div className="segmented sm">
              {(['all', 'security', 'failed'] as const).map((o) => (
                <button key={o} className={only === o ? 'on' : ''} onClick={() => setOnly(o)}>
                  {o === 'all' ? `All ${checks.length}` : o === 'security' ? `Security ${counts.security}` : `Failed ${counts.failed}`}
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 && <div className="empty small">{checks.length ? 'Nothing matches this filter.' : 'No checks reported for this commit.'}</div>}
          {groups.map(([wf, list]) => {
            const failed = list.some((c) => c.status === 'failed');
            const running = list.some((c) => c.status === 'running' || c.status === 'pending');
            return (
              <div key={wf} className={`wf-group ${failed ? 'danger' : running ? 'warn' : 'ok'}`}>
                <div className="wf-group-head">
                  <span className={`mr-icon ${failed ? 'danger' : running ? 'warn' : 'ok'}`}>{failed ? '✕' : running ? '◌' : '✓'}</span>
                  <strong className="grow">{wf}</strong>
                  {list.some(isSecurity) && <span className="badge info">🛡 security</span>}
                  <span className="small muted">
                    {list.length} job{list.length === 1 ? '' : 's'}
                  </span>
                </div>
                {list.map((c) => {
                  const [icon, cls, label] = CHECK_ICON[c.status];
                  return (
                    <div key={c.id} className="wf-job">
                      <span className={`mr-icon ${cls} ${c.status === 'running' ? 'spin' : ''}`}>{icon}</span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="ellipsis">
                          {c.name} {c.isRequired && <span className="badge warn">required</span>}
                        </div>
                        <div className="small muted">
                          {label}
                          {c.startedAt ? ` · started ${relTime(c.startedAt)}` : ''}
                          {c.startedAt && c.completedAt ? ` · took ${duration(new Date(c.completedAt).getTime() - new Date(c.startedAt).getTime())}` : ''}
                        </div>
                      </div>
                      {c.jobId && (
                        <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('gh:jobLogs', { repoId, jobId: c.jobId!, runId: c.runId ?? undefined, jobName: c.name })).then((r) => r && setLogs({ name: c.name, ...r }))}>
                          Logs
                        </button>
                      )}
                      {c.jobId && (c.status === 'failed' || c.status === 'cancelled' || c.status === 'passed') && (
                        <button className="btn sm ghost" disabled={!canWrite} title={canWrite ? 'Re-run this job' : 'Re-running needs write access'} onClick={() => setRerun(c)}>
                          Re-run
                        </button>
                      )}
                      {c.detailsUrl && (
                        <button className="btn sm ghost" onClick={() => call('shell:openExternal', { url: c.detailsUrl! }).catch(() => undefined)}>
                          ↗
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      <div className="card mt">
        <h3>
          🛡 Open code scanning alerts <span className="small muted mono">{alertRef}</span>
        </h3>
        {alertsError ? (
          <div className="small muted">{alertsError}</div>
        ) : !alerts ? (
          <Skeleton rows={2} />
        ) : alerts.unavailable ? (
          <div className="small muted">{alerts.unavailable}</div>
        ) : alerts.items.length === 0 ? (
          <div className="small text-ok">✓ No open alerts for this {target.kind === 'branch' ? 'branch' : 'pull request'}.</div>
        ) : (
          <div className="alert-list">
            {alerts.items.slice(0, 20).map((a) => (
              <div key={a.number} className="alert-row" onClick={() => call('shell:openExternal', { url: a.url }).catch(() => undefined)}>
                <SeverityBadge severity={a.securitySeverity ?? a.severity} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">{a.rule.description || a.rule.name}</div>
                  <div className="small muted mono ellipsis">
                    {a.path}
                    {a.startLine ? `:${a.startLine}` : ''} · {a.tool}
                  </div>
                </div>
                <span className="muted">↗</span>
              </div>
            ))}
            {alerts.hasMore && <div className="small muted">More alerts on GitHub.</div>}
          </div>
        )}
        {target.kind === 'commit' && <div className="small muted mt">Code scanning reports per branch or pull request, so these alerts are for the pull request as a whole.</div>}
      </div>

      {logs && (
        <Modal title={`Logs — ${logs.name}`} size="wide" onClose={() => setLogs(null)} footer={<button className="btn" onClick={() => setLogs(null)}>Close</button>}>
          {logs.truncated && <div className="banner info small">Only the last 512 KB are shown.</div>}
          <pre className="log-view">{logs.text}</pre>
        </Modal>
      )}
      {rerun && (
        <ConfirmDialog
          title="Re-run Check"
          explanation={<>Starts “{rerun.name}” again on GitHub Actions.</>}
          impact="It uses Actions minutes and may run deployment steps defined in the workflow."
          confirmLabel="Re-run"
          onCancel={() => setRerun(null)}
          onConfirm={async () => {
            await run(() => call('gh:rerunJob', { repoId, jobId: rerun.jobId!, confirmed: true }), 'Re-run requested');
            setRerun(null);
            setTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}
