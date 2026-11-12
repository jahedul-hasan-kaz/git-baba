import { useEffect, useRef, useState } from 'react';
import type { GhRepoContext, PrDetails } from '../../../../shared/github';
import { Avatar, relTime } from '../../../components/github/common';
import { ConfirmDialog } from '../../../dialogs/ConfirmDialog';
import { call, toFriendly } from '../../../services/api';
import { useApp } from '../../../state/AppState';
import { isTokenProblem, useGhCli } from './ghCli';
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
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <button className="btn sm ghost" onClick={onBack}>
          ← Pull requests
        </button>
        <span className="spacer" />
        <div className="gh-menu" ref={menuBox}>
          <button className="btn sm" onClick={() => setMenu((m) => !m)} title="Run actions with your GitHub CLI login">
            ⌨ GitHub CLI ▾
          </button>
          {menu && (
            <div className="gh-menu-list pop-in" onClick={() => setMenu(false)}>
              <div className="gh-menu-title">Runs gh with your own login</div>
              <button onClick={() => setConfirm('checkout')}>⎇ Check out this pull request locally</button>
              {pr.state === 'OPEN' && pr.isDraft && <button onClick={() => setConfirm('ready')}>✓ Mark ready for review</button>}
              {pr.state === 'OPEN' && !pr.isDraft && <button onClick={() => setConfirm('draft')}>✎ Convert to draft</button>}
              {pr.state === 'OPEN' && <button onClick={() => setConfirm('close')}>⊘ Close pull request</button>}
              {pr.state === 'CLOSED' && <button onClick={() => setConfirm('reopen')}>↺ Reopen pull request</button>}
              <div className="gh-menu-sep" />
              <div className="gh-menu-title">Copy a command</div>
              <button onClick={() => copy(`gh pr checkout ${pr.number}`, 'Command')}>
                <code>gh pr checkout {pr.number}</code>
              </button>
              <button onClick={() => copy(`gh pr diff ${pr.number}`, 'Command')}>
                <code>gh pr diff {pr.number}</code>
              </button>
              <button onClick={() => copy(`gh pr checks ${pr.number} --watch`, 'Command')}>
                <code>gh pr checks {pr.number} --watch</code>
              </button>
              <button onClick={() => copy(`gh pr view ${pr.number} --web`, 'Command')}>
                <code>gh pr view {pr.number} --web</code>
              </button>
            </div>
          )}
        </div>
        <button className="btn sm" onClick={() => call('shell:openExternal', { url: pr.url }).catch(() => undefined)}>
          Open on GitHub ↗
        </button>
      </div>

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

      <div className="pr-stats">
        <span className="pr-stat">
          <strong>{pr.commits}</strong> commits
        </span>
        <span className="pr-stat">
          <strong>{pr.changedFiles}</strong> files
        </span>
        <span className="pr-stat">
          <DiffStat add={pr.additions} del={pr.deletions} />
        </span>
        <span className="pr-stat muted">
          opened {relTime(pr.createdAt)} · updated {relTime(pr.updatedAt)}
        </span>
        <span className="spacer" />
        <button className={`verdict-chip ${verdict.tone}`} onClick={onShowMerge} title={verdict.detail}>
          {verdict.icon} {verdict.title}
        </button>
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
