import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GhRepoContext, Workflow, WorkflowRun } from '../../../shared/github';
import { ErrorPanel } from '../../components/ErrorPanel';
import { duration, relTime, Skeleton, useGh, useMutation } from '../../components/github/common';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';
import { DispatchDialog } from './actions/DispatchDialog';
import { RunDetail } from './actions/RunDetail';
import { elapsed, indexTags, openUrl, RunIcon, runState, STATE_LABEL, TagChip, tagsForRun, useTicker, type RunState } from './actions/shared';
import { WorkflowStudio, type StudioTarget } from './actions/WorkflowStudio';
import { GitHubRepoShell } from './GitHubRepoShell';

import { Select } from '../../components/Select';
import { Hourglass } from '../../components/Hourglass';
export function ActionsTab() {
  return <GitHubRepoShell what="GitHub Actions">{(ctx, repoId) => <Actions key={repoId} repoId={repoId} ctx={ctx} />}</GitHubRepoShell>;
}

/** Kept for other views that show a plain status. */
export function RunStatus({ status, conclusion }: { status: string; conclusion: string | null }) {
  const s = runState(status, conclusion);
  return (
    <span className="row" style={{ gap: 6, display: 'inline-flex' }}>
      <RunIcon status={status} conclusion={conclusion} size={14} /> {STATE_LABEL[s]}
    </span>
  );
}

type StatusFilter = '' | 'in_progress' | 'queued' | 'success' | 'failure' | 'cancelled';
const STATUS_CHIPS: { id: StatusFilter; label: string; match: (s: RunState) => boolean }[] = [
  { id: '', label: 'All', match: () => true },
  { id: 'in_progress', label: 'In progress', match: (s) => s === 'running' },
  { id: 'queued', label: 'Queued', match: (s) => s === 'queued' || s === 'waiting' },
  { id: 'success', label: 'Success', match: (s) => s === 'success' },
  { id: 'failure', label: 'Failed', match: (s) => s === 'failure' },
  { id: 'cancelled', label: 'Cancelled', match: (s) => s === 'cancelled' },
];
const LIVE_MS = 5000;

function Actions({ repoId, ctx }: { repoId: string; ctx: GhRepoContext }) {
  const { toast } = useApp();
  const workflows = useGh(() => call('gh:workflows', { repoId }), [repoId]);
  const tags = useGh(() => call('gh:repoTags', { repoId }), [repoId]);
  const meta = useGh(() => call('gh:prMetadata', { repoId }), [repoId]);
  const [wf, setWf] = useState<Workflow | null>(null);
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [dispatch, setDispatch] = useState<Workflow | null>(null);
  const [studio, setStudio] = useState<StudioTarget | 'gallery' | null>(null);
  const [bulk, setBulk] = useState<{ kind: 'cancel' | 'rerun'; runs: WorkflowRun[] } | null>(null);
  const { busy, run } = useMutation();
  useEffect(() => setPage(1), [wf, branch, status]);

  const runs = useGh(() => call('gh:runs', { repoId, workflowId: wf?.id, branch: branch || undefined, status: status || undefined, page }), [repoId, wf?.id, branch, status, page]);
  const canWrite = ctx.permissions.canWrite;
  const branches = meta.data?.branches ?? [];
  const { bySha, names } = useMemo(() => indexTags(tags.data), [tags.data]);

  const list = runs.data?.runs ?? [];
  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      list
        .map((r) => ({ r, tags: tagsForRun(r, bySha, names), state: runState(r.status, r.conclusion) }))
        .filter(({ r, tags: t }) => (!tagFilter || t.includes(tagFilter)) && (!q || `${r.title} ${r.name} ${r.branch ?? ''} ${r.actor ?? ''} ${r.event} #${r.runNumber} ${t.join(' ')}`.toLowerCase().includes(q))),
    [list, bySha, names, tagFilter, q],
  );
  const active = list.filter((r) => r.status !== 'completed');
  const failed = list.filter((r) => r.status === 'completed' && (r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out'));
  const now = useTicker(active.length > 0);

  // Live list while anything runs.
  const reload = runs.reload;
  useEffect(() => {
    if (active.length === 0 || openRun || studio) return;
    const t = window.setInterval(() => void reload(), LIVE_MS);
    return () => window.clearInterval(t);
  }, [active.length, openRun, studio, reload]);

  const onChanged = useCallback(() => {
    void runs.reload();
    void workflows.reload();
  }, [runs, workflows]);

  if (studio) {
    return (
      <WorkflowStudio
        repoId={repoId}
        ctx={ctx}
        branches={branches}
        initial={studio === 'gallery' ? null : studio}
        onClose={() => setStudio(null)}
        onCommitted={() => {
          setStudio(null);
          setTimeout(() => void workflows.reload(), 2000);
        }}
      />
    );
  }
  if (openRun) return <RunDetail repoId={repoId} runId={openRun} canWrite={canWrite} tags={tags.data} onBack={() => setOpenRun(null)} onChanged={onChanged} />;

  const wfLast = (w: Workflow) => (w.lastRun ? runState(w.lastRun.status, w.lastRun.conclusion) : null);

  return (
    <div className="split-page actions-page">
      <div className="sub-nav">
        <button className="btn sm primary block mb" disabled={!canWrite} title={canWrite ? 'Create a workflow from a template, the Marketplace, or from scratch' : 'Requires write access'} onClick={() => setStudio('gallery')}>
          ＋ New workflow
        </button>
        <div className={`sub-nav-item ${!wf ? 'active' : ''}`} onClick={() => setWf(null)}>
          All workflows
        </div>
        {workflows.loading && !workflows.data && <Skeleton rows={4} />}
        {workflows.error && <div className="small text-danger" style={{ padding: 10 }}>{workflows.error.message}</div>}
        {(workflows.data ?? []).map((w) => {
          const s = wfLast(w);
          return (
            <div key={w.id} className={`sub-nav-item ${wf?.id === w.id ? 'active' : ''}`} onClick={() => setWf(w)} title={`${w.path}${s ? `\nLast run: ${STATE_LABEL[s]}` : ''}`}>
              {s ? <span className={`wf-dot ${s}`} /> : <span className="wf-dot none" />}
              <span className="ellipsis grow">{w.name}</span>
              {w.state !== 'active' && <span className="badge">{w.state.replace(/_/g, ' ')}</span>}
            </div>
          );
        })}
      </div>

      <div className="content" style={{ minWidth: 0 }}>
        <div className="row mb">
          <h2 className="grow" style={{ margin: 0 }}>
            {wf ? wf.name : 'All workflows'}
          </h2>
          {wf && (
            <>
              <span className="mono small muted">{wf.path}</span>
              <button className="btn sm ghost" disabled={!canWrite} onClick={() => setStudio({ path: wf.path, branch: ctx.defaultBranch })}>
                ✎ Edit
              </button>
              <button className="btn sm ghost" onClick={() => openUrl(wf.url)}>
                ↗
              </button>
              <button className="btn sm primary" disabled={!canWrite} title={canWrite ? 'Run this workflow manually (workflow_dispatch)' : 'Requires write access'} onClick={() => setDispatch(wf)}>
                ▶ Run workflow
              </button>
            </>
          )}
          <button className="btn sm" onClick={() => void runs.reload()} title="Refresh">
            <Hourglass />
          </button>
        </div>

        <div className="actions-filters">
          <div className="actions-search">
            <span>⌕</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by name, title, tag, branch, actor, #run…" spellCheck={false} />
            {search && (
              <button className="ft-clear" style={{ position: 'static', transform: 'none' }} onClick={() => setSearch('')}>
                ×
              </button>
            )}
          </div>
          <Select kind="branch" value={branch} onChange={(e) => setBranch(e.target.value)} title="Branch" style={{ width: 'auto', maxWidth: 200 }}>
            <option value="">All branches</option>
            {(branches.length ? branches : [ctx.defaultBranch]).map((b) => (
              <option key={b} value={b}>
                ⎇ {b}
              </option>
            ))}
          </Select>
          <Select kind="tag" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} title="Tag" style={{ width: 'auto', maxWidth: 180 }}>
            <option value="">All tags</option>
            {(tags.data ?? []).slice(0, 200).map((t) => (
              <option key={t.name} value={t.name}>
                🏷 {t.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="status-chips">
          {STATUS_CHIPS.map((c) => {
            const n = c.id ? list.filter((r) => c.match(runState(r.status, r.conclusion))).length : list.length;
            return (
              <button key={c.id || 'all'} className={`status-chip ${c.id || 'all'} ${status === c.id ? 'on' : ''}`} onClick={() => setStatus(c.id)}>
                {c.id === 'in_progress' && n > 0 && <span className="live-dot" />}
                {c.label}
                {status === '' && <span className="n">{n}</span>}
              </button>
            );
          })}
          <span className="spacer" />
          {active.length > 0 && (
            <button className="btn sm danger" disabled={!canWrite || busy} onClick={() => setBulk({ kind: 'cancel', runs: active })}>
              ⏹ Cancel all running ({active.length})
            </button>
          )}
          {failed.length > 0 && (
            <button className="btn sm" disabled={!canWrite || busy} onClick={() => setBulk({ kind: 'rerun', runs: failed })}>
              <Hourglass /> Re-run all failed ({failed.length})
            </button>
          )}
        </div>

        {runs.error && <ErrorPanel error={runs.error} />}
        {runs.loading && !runs.data && <Skeleton rows={6} />}
        {runs.data && rows.length === 0 && <div className="empty">{list.length ? 'No run matches these filters.' : 'No workflow runs yet.'}</div>}
        <div className="run-list">
          {rows.map(({ r, tags: rt, state }) => {
            const t = elapsed(r.startedAt ?? r.createdAt, r.status === 'completed' ? r.updatedAt : null, now);
            return (
              <div key={r.id} className={`run-row ${state}`} onClick={() => setOpenRun(r.id)}>
                <RunIcon status={r.status} conclusion={r.conclusion} size={20} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="run-row-title">
                    <strong className="ellipsis">{r.title || r.name}</strong>
                    {rt.map((tag) => (
                      <TagChip key={tag} name={tag} />
                    ))}
                  </div>
                  <div className="small muted run-row-meta">
                    <span>
                      {r.name} #{r.runNumber}
                      {r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}
                    </span>
                    <span>· {r.event.replace(/_/g, ' ')}</span>
                    {r.branch && !rt.includes(r.branch) && <span className="branch-pill">{r.branch}</span>}
                    {r.actor && <span>· {r.actor}</span>}
                    <span>· {relTime(r.createdAt)}</span>
                  </div>
                </div>
                <div className="run-row-right">
                  <span className={`run-time ${state === 'running' ? 'live' : ''}`}>{duration(t)}</span>
                  <span className="run-row-actions" onClick={(e) => e.stopPropagation()}>
                    {r.status !== 'completed' ? (
                      <button className="btn sm ghost" disabled={!canWrite || busy} title="Cancel this run" onClick={() => setBulk({ kind: 'cancel', runs: [r] })}>
                        ⏹
                      </button>
                    ) : (
                      <button className="btn sm ghost" disabled={!canWrite || busy} title="Re-run this run" onClick={() => setBulk({ kind: 'rerun', runs: [r] })}>
                        <Hourglass />
                      </button>
                    )}
                    <button className="btn sm ghost" title="Open on GitHub" onClick={() => openUrl(r.url)}>
                      ↗
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {runs.data && (page > 1 || runs.data.hasMore) && (
          <div className="row mt">
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Newer
            </button>
            <span className="small muted">Page {page}</span>
            <button className="btn sm" disabled={!runs.data.hasMore} onClick={() => setPage((p) => p + 1)}>
              Older →
            </button>
          </div>
        )}
      </div>

      {dispatch && (
        <DispatchDialog
          repoId={repoId}
          ctx={ctx}
          workflow={dispatch}
          branches={branches}
          tags={tags.data}
          onClose={() => setDispatch(null)}
          onStarted={(id) => {
            void runs.reload();
            if (id) setOpenRun(id);
            else toast('Workflow started — it appears in the list in a moment');
          }}
        />
      )}
      {bulk && (
        <ConfirmDialog
          title={bulk.kind === 'cancel' ? (bulk.runs.length > 1 ? `Cancel ${bulk.runs.length} running runs` : 'Cancel run') : bulk.runs.length > 1 ? `Re-run ${bulk.runs.length} runs` : 'Re-run run'}
          explanation={
            <>
              {bulk.kind === 'cancel' ? 'Stops' : 'Starts again'}:{' '}
              {bulk.runs
                .slice(0, 5)
                .map((r) => `${r.name} #${r.runNumber}`)
                .join(', ')}
              {bulk.runs.length > 5 ? ` and ${bulk.runs.length - 5} more` : ''}.
            </>
          }
          impact={bulk.kind === 'cancel' ? 'Running jobs are stopped; partial results (and partial deployments) may remain.' : 'Failed jobs are re-run (all jobs for successful runs). Uses Actions minutes and may repeat deployment steps.'}
          confirmLabel={bulk.kind === 'cancel' ? 'Cancel' : 'Re-run'}
          danger={bulk.kind === 'cancel'}
          onCancel={() => setBulk(null)}
          onConfirm={async () => {
            const items = bulk.runs;
            setBulk(null);
            let ok = 0;
            for (const r of items) {
              const action = bulk.kind === 'cancel' ? 'cancel' : r.conclusion === 'success' ? 'rerun' : 'rerun-failed';
              const done = await run(() => call('gh:runAction', { repoId, runId: r.id, action, confirmed: true }).then(() => true));
              if (done) ok++;
            }
            toast(`${bulk.kind === 'cancel' ? 'Cancellation requested for' : 'Re-run started for'} ${ok} of ${items.length} run(s)`);
            setTimeout(() => void runs.reload(), 1500);
          }}
        />
      )}
    </div>
  );
}
