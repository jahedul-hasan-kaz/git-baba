import { useEffect, useRef, useState } from 'react';
import type { GhRepoContext, PrDetails } from '../../../../shared/github';
import { Avatar } from '../../../components/github/common';
import { ConfirmDialog } from '../../../dialogs/ConfirmDialog';
import { call, toFriendly } from '../../../services/api';
import { useApp } from '../../../state/AppState';
import { isTokenProblem, useGhCli } from './ghCli';
import { awaitsApproval, useApprovedOnly } from './approvalGate';
import { mergeVerdict } from './mergeVerdict';

/** Five-block "+/−" bar, as GitHub shows next to a diff. */
export function DiffStat({ add, del }: { add: number; del: number }) {
  const total = add + del;
  const green = total ? Math.round((add / total) * 5) : 0;
  return (
    <span className="diffstat" title={`${add} additions, ${del} deletions`}>
      <span className="text-ok">+{add.toLocaleString()}</span> <span className="text-danger">−{del.toLocaleString()}</span>{' '}
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={!total ? '' : i < green ? 'add' : 'del'} />
      ))}
    </span>
  );
}

function stateOf(pr: PrDetails): { cls: string; icon: string; label: string } {
  if (pr.state === 'MERGED') return { cls: 'merged', icon: '⇋', label: 'Merged' };
  if (pr.state === 'CLOSED') return { cls: 'closed', icon: '⊘', label: 'Closed' };
  if (pr.isDraft) return { cls: 'draft', icon: '✎', label: 'Draft' };
  return { cls: 'open', icon: '⇄', label: 'Open' };
}

function reviewOf(pr: PrDetails): { cls: string; label: string } | null {
  if (pr.state !== 'OPEN') return null;
  if (pr.reviewDecision === 'APPROVED') return { cls: 'ok', label: '✓ Approved' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { cls: 'danger', label: '✕ Changes requested' };
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { cls: 'warn', label: '● Review pending' };
  return null;
}

interface Props {
  repoId: string;
  pr: PrDetails;
  ctx: GhRepoContext;
  onRefresh: () => void;
  onShowMerge: () => void;
  onBack: () => void;
}

export function PrHero({ repoId, pr, ctx, onRefresh, onShowMerge, onBack }: Props) {
  const { toast, showError } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [titleCliOffer, setTitleCliOffer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<null | 'checkout' | 'close' | 'reopen' | 'ready' | 'draft'>(null);
  const cli = useGhCli(repoId, pr.number, onRefresh);
  const menuBox = useRef<HTMLDivElement>(null);
  const st = stateOf(pr);
  const review = reviewOf(pr);
  const verdict = mergeVerdict(pr);
  const [approvedOnly] = useApprovedOnly(`${ctx.owner}/${ctx.name}`);
  const gated = awaitsApproval(approvedOnly, pr);
  const headLabel = `${pr.headRepository && pr.headRepository !== `${ctx.owner}/${ctx.name}` ? `${pr.headRepository}:` : ''}${pr.headRefName}`;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuBox.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const saveTitle = async () => {
    if (editing === null || !editing.trim() || editing.trim() === pr.title) return setEditing(null);
    setSaving(true);
    try {
      await call('gh:prEdit', { repoId, number: pr.number, title: editing.trim() });
      toast('Title updated');
      setEditing(null);
      onRefresh();
    } catch (err) {
      const f = toFriendly(err);
      if (isTokenProblem(f.code)) setTitleCliOffer(true);
      showError(err);
    } finally {
      setSaving(false);
    }
  };

  const copy = (text: string, what: string) => void call('app:copyText', { text }).then(() => toast(`${what} copied`), showError);

  return (
    <div className="pr-hero fade-in">
      <header className="run-top">
        <nav className="prc-crumbs" aria-label="Breadcrumb">
          <button className="prc-crumb back" onClick={onBack} title="Back to pull requests">
            <span className="prc-crumb-ico">⇄</span> Pull requests
          </button>
          <span className="prc-crumb here" aria-current="page">
            #{pr.number}
          </span>
        </nav>
        <span className="spacer" />
        {verdict.tone === 'ok' && pr.state === 'OPEN' && !gated ? (
          <button className="merge-cta" onClick={onShowMerge} title={verdict.detail}>
            <span className="merge-cta-ico">⇋</span> Merge pull request
          </button>
        ) : (
          <button className={`verdict-chip ${gated && verdict.tone === 'ok' ? 'warn' : verdict.tone}`} onClick={onShowMerge} title={gated ? 'This repository merges only approved pull requests' : verdict.detail}>
            {gated && verdict.tone === 'ok' ? '● Waiting for approval' : `${verdict.icon} ${verdict.title}`}
          </button>
        )}
      </header>

      {editing !== null ? (
        <div className="title-edit">
          <input
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveTitle();
              if (e.key === 'Escape') setEditing(null);
            }}
            autoFocus
            maxLength={256}
          />
          <button className="btn primary" disabled={saving || !editing.trim()} onClick={() => void saveTitle()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {titleCliOffer && (
            <button
              className="btn"
              disabled={!!cli.busy || !editing.trim()}
              onClick={() =>
                void cli.run('edit-title', { title: editing.trim() }, 'Title updated with GitHub CLI').then((ok) => {
                  if (ok) {
                    setEditing(null);
                    setTitleCliOffer(false);
                  }
                })
              }
            >
              Save with GitHub CLI
            </button>
          )}
          <button className="btn cancel" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <span className="small muted">Enter to save · Esc to cancel</span>
        </div>
      ) : (
        <h1 className={`pr-title ${pr.viewerCanUpdate ? 'editable' : ''}`} onDoubleClick={() => pr.viewerCanUpdate && setEditing(pr.title)} title={pr.viewerCanUpdate ? 'Double-click to edit the title' : undefined}>
          {pr.title} <span className="muted">#{pr.number}</span>
          {pr.viewerCanUpdate && (
            <button className="btn sm ghost title-pencil" onClick={() => setEditing(pr.title)} aria-label="Edit title">
              ✎
            </button>
          )}
        </h1>
      )}

      <div className="pr-flow">
        <span className={`state-pill ${st.cls}`}>
          {st.icon} {st.label}
        </span>
        {review && <span className={`badge ${review.cls}`}>{review.label}</span>}
        <Avatar login={pr.author?.login} size={20} />
        <span>
          <strong>{pr.author?.login ?? 'ghost'}</strong> {pr.merged ? 'merged' : pr.state === 'CLOSED' ? 'proposed' : 'wants to merge'}{' '}
          <strong>
            {pr.commits} commit{pr.commits === 1 ? '' : 's'}
          </strong>{' '}
          into
        </span>
        <span className="branch-pill big" title="Base branch">
          {pr.baseRefName}
        </span>
        <span className="flow-arrow">←</span>
        <span className="branch-pill big head" title="Compare branch — click to copy" onClick={() => copy(pr.headRefName, 'Branch name')}>
          {headLabel} ⧉
        </span>
      </div>



      {confirm && (
        <ConfirmDialog
          title={{ checkout: 'Check Out Pull Request', close: 'Close Pull Request', reopen: 'Reopen Pull Request', ready: 'Mark Ready for Review', draft: 'Convert to Draft' }[confirm]}
          explanation={
            confirm === 'checkout' ? (
              <>
                Runs <code>gh pr checkout {pr.number}</code>: fetches <strong>{pr.headRefName}</strong> and switches your working copy to it.
              </>
            ) : (
              <>Runs the change through your GitHub CLI login.</>
            )
          }
          impact={confirm === 'checkout' ? 'Uncommitted changes stay in place; gh stops if they would be overwritten.' : 'No code is merged, pushed or deleted.'}
          confirmLabel="Run with GitHub CLI"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const msg = { checkout: `Checked out #${pr.number}`, close: 'Pull request closed', reopen: 'Pull request reopened', ready: 'Marked ready for review', draft: 'Converted to draft' }[confirm];
            await cli.run(confirm, {}, msg);
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
