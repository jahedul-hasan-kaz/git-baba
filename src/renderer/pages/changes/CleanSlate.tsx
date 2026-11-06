import type { RepoStatus } from '../../../shared/types';
import { useApp } from '../../state/AppState';
import { isPublished } from '../../../shared/publish';

const openDialog = (d: 'fetch' | 'pull' | 'push') => window.dispatchEvent(new CustomEvent('gb:repo-dialog', { detail: d }));
/** Opens the New Branch window of the workspace rail. */
export const requestNewBranch = (from?: string) => window.dispatchEvent(new CustomEvent('gb:new-branch', { detail: from ?? '' }));

/** The Changes tab when there is nothing to commit: that it is clean, and where the branch stands with its remote. */
export function CleanSlate({ status, compact }: { repoId: string; status: RepoStatus; compact?: boolean; onOpenCommit?: (hash: string) => void }) {
  const { setRepoTab, activeRepo } = useApp();
  const published = isPublished(status);
  const sync = !status.branch
    ? { tone: 'warn', icon: '⎋', title: 'Detached HEAD', text: 'You are not on a branch. Create one to keep any new work.', action: { label: '⎇ Create a branch', run: () => requestNewBranch() } }
    : !status.headOid
      ? { tone: 'info', icon: '✦', title: 'No commits yet', text: `${status.branch} is brand new. Add a file, then commit it to start the history.`, action: { label: '＋ Add a file', run: () => setRepoTab('code') } }
    : activeRepo && !activeRepo.remoteUrl
      ? { tone: 'info', icon: '☁', title: 'No remote yet', text: `${status.branch} lives only on this computer. Add a remote (such as an empty GitHub repository) to back it up and share it.`, action: { label: '＋ Add a remote', run: () => setRepoTab('settings') } }
    : !published
      ? {
          tone: 'info',
          icon: '☁',
          title: 'Not published yet',
          text: status.upstreamGone ? `${status.upstream} is not on the remote yet (empty repository or deleted there). Publish to create it.` : `${status.branch} exists only on this computer.`,
          action: { label: '⬆ Publish branch', run: () => openDialog('push') },
        }
      : status.ahead && status.behind
        ? { tone: 'warn', icon: '⇅', title: 'Diverged', text: `${status.ahead} to push and ${status.behind} to pull — pull first to combine them.`, action: { label: '⬇ Pull', run: () => openDialog('pull') } }
        : status.ahead
          ? { tone: 'accent', icon: '⬆', title: `${status.ahead} commit${status.ahead === 1 ? '' : 's'} ready to push`, text: `Committed locally, not on ${status.upstream} yet.`, action: { label: `⬆ Push ${status.ahead}`, run: () => openDialog('push') } }
          : status.behind
            ? { tone: 'warn', icon: '⬇', title: `${status.behind} new commit${status.behind === 1 ? '' : 's'} to pull`, text: `${status.upstream} has moved on.`, action: { label: `⬇ Pull ${status.behind}`, run: () => openDialog('pull') } }
            : { tone: 'ok', icon: '✓', title: 'In sync', text: `Same as ${status.upstream}.`, action: { label: '⬇ Fetch', run: () => openDialog('fetch') } };

  return (
    <div className={`cs ${compact ? 'compact' : ''}`}>
      <div className="cs-hero">
        <div className="cs-orb" aria-hidden>
          <span className="cs-ring r1" />
          <span className="cs-ring r2" />
          <span className="cs-core">✓</span>
        </div>
        <div>
          <h2 className="cs-title">All clear{status.branch ? <> on <span className="cs-branch">⎇ {status.branch}</span></> : ''}</h2>
          <p className="muted">No uncommitted changes.</p>
        </div>
      </div>

      <section className={`cs-card cs-sync cs-solo ${sync.tone}`}>
        <div className="cs-sync-row">
          <span className="cs-sync-ico">{sync.icon}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <strong>{sync.title}</strong>
            <div className="small muted">{sync.text}</div>
          </div>
          <button className={`btn ${sync.tone === 'ok' ? '' : 'primary'}`} onClick={sync.action.run}>
            {sync.action.label}
          </button>
        </div>
      </section>
    </div>
  );
}
