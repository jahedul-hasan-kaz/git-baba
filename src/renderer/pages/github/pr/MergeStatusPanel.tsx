import { forwardRef, useState } from 'react';
import type { GhRepoContext, PrDetails } from '../../../../shared/github';
import { Avatar, relTime } from '../../../components/github/common';
import { ConfirmDialog } from '../../../dialogs/ConfirmDialog';
import { useGhCli } from './ghCli';
import { mergeVerdict } from './mergeVerdict';

import { Select } from '../../../components/Select';
type Row = { tone: 'ok' | 'warn' | 'danger' | 'muted'; icon: string; title: string; detail?: React.ReactNode; action?: React.ReactNode };

interface Props {
  repoId: string;
  pr: PrDetails;
  ctx: GhRepoContext;
  onMerge: () => void;
  onRefresh: () => void;
  onShowChecks: () => void;
}

/**
 * Merge status at a glance: one verdict, then every rule GitHub applies (checks, reviews, conflicts,
 * up to date, draft). Merging goes through the pre-merge dialog, which re-checks the branch rules.
 */
export const MergeStatusPanel = forwardRef<HTMLDivElement, Props>(function MergeStatusPanel({ repoId, pr, ctx, onMerge, onRefresh, onShowChecks }, ref) {
  const v = mergeVerdict(pr);
  const cli = useGhCli(repoId, pr.number, onRefresh);
  const methods = (['merge', 'squash', 'rebase'] as const).filter((m) => ctx.mergeMethods[m]);
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>(methods[0] ?? 'merge');
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [confirmCli, setConfirmCli] = useState(false);
  const s = pr.checksSummary;

  if (pr.state !== 'OPEN') {
    return (
      <div ref={ref} className={`merge-panel ${v.tone}`}>
        <div className="merge-panel-head">
          <span className="merge-icon">{v.icon}</span>
          <div className="grow">
            <div className="merge-title">{pr.state === 'MERGED' ? 'Pull request successfully merged' : 'This pull request is closed'}</div>
            <div className="small">
              {pr.state === 'MERGED' ? (
                <>
                  {pr.mergedBy && <Avatar login={pr.mergedBy} size={16} />} {pr.mergedBy ?? 'Someone'} merged {pr.commits} commit(s) into <span className="branch-pill">{pr.baseRefName}</span> {relTime(pr.mergedAt)}
                  {pr.mergeCommitOid && (
                    <>
                      {' '}
                      as <span className="mono">{pr.mergeCommitOid.slice(0, 7)}</span>
                    </>
                  )}
                </>
              ) : (
                <>Closed {relTime(pr.closedAt)} without merging.</>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const reviewers = pr.latestReviews.filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED');
  const rows: Row[] = [
    {
      tone: s.total === 0 ? 'muted' : s.failed ? 'danger' : s.pending ? 'warn' : 'ok',
      icon: s.total === 0 ? '–' : s.failed ? '✕' : s.pending ? '●' : '✓',
      title: s.total === 0 ? 'No checks reported' : s.failed ? `${s.failed} of ${s.total} checks failing` : s.pending ? `${s.pending} of ${s.total} checks still running` : `All ${s.total} checks passed`,
      detail: s.total > 0 && (
        <span className="check-bar" title={`${s.passed} passed · ${s.failed} failed · ${s.pending} pending`}>
          <i className="ok" style={{ flex: s.passed }} />
          <i className="danger" style={{ flex: s.failed }} />
          <i className="warn" style={{ flex: s.pending }} />
        </span>
      ),
      action: s.total > 0 && (
        <button className="btn sm ghost" onClick={onShowChecks}>
          View checks →
        </button>
      ),
    },
    {
      tone: pr.reviewDecision === 'APPROVED' ? 'ok' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'danger' : pr.reviewDecision === 'REVIEW_REQUIRED' ? 'warn' : 'muted',
      icon: pr.reviewDecision === 'APPROVED' ? '✓' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '✕' : pr.reviewDecision === 'REVIEW_REQUIRED' ? '●' : '–',
      title: pr.reviewDecision === 'APPROVED' ? 'Changes approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : pr.reviewDecision === 'REVIEW_REQUIRED' ? 'Approving review required' : 'No review required by the rules',
      detail: reviewers.length > 0 && (
        <span className="reviewer-faces">
          {reviewers.map((r) => (
            <span key={r.author} className={`face ${r.state === 'APPROVED' ? 'ok' : 'danger'}`} title={`${r.author}: ${r.state === 'APPROVED' ? 'approved' : 'requested changes'}`}>
              <Avatar login={r.author} size={18} />
            </span>
          ))}
          {pr.requestedReviewers.length > 0 && <span className="small muted">waiting on {pr.requestedReviewers.join(', ')}</span>}
        </span>
      ),
    },
    {
      tone: pr.mergeable === 'CONFLICTING' ? 'danger' : pr.mergeable === 'MERGEABLE' ? 'ok' : 'warn',
      icon: pr.mergeable === 'CONFLICTING' ? '✕' : pr.mergeable === 'MERGEABLE' ? '✓' : '●',
      title: pr.mergeable === 'CONFLICTING' ? `Conflicts with ${pr.baseRefName}` : pr.mergeable === 'MERGEABLE' ? 'No conflicts with the base branch' : 'Checking for conflicts…',
      detail: pr.mergeable === 'CONFLICTING' && <span className="small">Merge {pr.baseRefName} into {pr.headRefName} locally (Branches tab) and resolve them in the Conflicts tab.</span>,
    },
    {
      tone: pr.mergeStateStatus === 'BEHIND' ? 'warn' : 'ok',
      icon: pr.mergeStateStatus === 'BEHIND' ? '↓' : '✓',
      title: pr.mergeStateStatus === 'BEHIND' ? `Out of date with ${pr.baseRefName}` : `Up to date with ${pr.baseRefName}`,
    },
  ];
  if (pr.isDraft) rows.push({ tone: 'warn', icon: '✎', title: 'Draft — not ready for review', action: <button className="btn sm" disabled={!!cli.busy} onClick={() => void cli.run('ready', {}, 'Marked ready for review')}>{cli.busy === 'ready' ? 'Marking…' : 'Ready for review'}</button> });

  return (
    <div ref={ref} className={`merge-panel ${v.tone}`}>
      <div className="merge-panel-head">
        <span className="merge-icon">{v.icon}</span>
        <div className="grow">
          <div className="merge-title">{v.title}</div>
          <div className="small">{v.detail}</div>
        </div>
      </div>
      <div className="merge-rows">
        {rows.map((r, i) => (
          <div key={i} className="merge-row">
            <span className={`mr-icon ${r.tone}`}>{r.icon}</span>
            <div className="grow">
              <div>{r.title}</div>
              {r.detail}
            </div>
            {r.action}
          </div>
        ))}
      </div>
      <div className="merge-actions">
        <button className={`btn ${v.tone === 'ok' ? 'primary' : ''}`} onClick={onMerge} disabled={pr.isDraft} title="Runs a pre-merge check against the branch rules, then asks you to authenticate and confirm">
          ⇋ Merge pull request…
        </button>
        <span className="merge-or">or with GitHub CLI</span>
        <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} style={{ width: 'auto' }} disabled={pr.isDraft}>
          {methods.map((m) => (
            <option key={m} value={m}>
              {m === 'merge' ? 'Create a merge commit' : m === 'squash' ? 'Squash and merge' : 'Rebase and merge'}
            </option>
          ))}
        </Select>
        <label className="check small" style={{ margin: 0 }}>
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> delete branch
        </label>
        <button className="btn" disabled={pr.isDraft || !!cli.busy} onClick={() => setConfirmCli(true)}>
          {cli.busy === 'merge' ? 'Merging…' : 'Merge with gh'}
        </button>
      </div>
      <div className="small muted merge-foot">GitHub enforces the branch rules either way: a blocked pull request stays unmerged unless you are allowed to bypass them.</div>

      {confirmCli && (
        <ConfirmDialog
          title="Merge with GitHub CLI"
          danger={v.tone !== 'ok'}
          explanation={
            <>
              Runs <code>gh pr merge {pr.number} --{method}{deleteBranch ? ' --delete-branch' : ''}</code>: merges <strong>{pr.headRefName}</strong> into <strong>{pr.baseRefName}</strong>.
            </>
          }
          impact={v.tone === 'ok' ? `${pr.commits} commit(s) land on ${pr.baseRefName}.` : `Current status: ${v.title}. ${v.detail} GitHub refuses the merge unless the rules allow it.`}
          confirmLabel="Merge"
          onCancel={() => setConfirmCli(false)}
          onConfirm={async () => {
            await cli.run('merge', { method, deleteBranch }, `#${pr.number} merged`);
            setConfirmCli(false);
          }}
        />
      )}
    </div>
  );
});
