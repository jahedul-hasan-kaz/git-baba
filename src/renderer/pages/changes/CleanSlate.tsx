import { useEffect, useState } from 'react';
import type { GraphCommit, RepoStatus } from '../../../shared/types';
import { relative } from '../../components/FileDiffList';
import { call } from '../../services/api';
import { requestQuickMerge } from '../../services/quickMerge';
import { useApp } from '../../state/AppState';
import { isPublished } from '../../../shared/publish';
import { authorColor, initials } from '../history/graphStyle';

const TIPS = [
  ['✋', 'Stage only the lines you want', 'Open a changed file and click or drag over lines to stage just those.'],
  ['🎯', 'Merge only what matters', 'The Merge Studio can bring just one branch’s own commits — or chosen files and lines — into another.'],
  ['⟲', 'Every reset can be undone', 'Git History keeps a backup before resets and rebases, with an Undo right after.'],
  ['⌨', 'Keyboard first', 'Ctrl+1…9 switches tabs. In Changes: Space stages, Ctrl+Enter commits.'],
  ['↶', 'Fix the last commit', 'Not pushed yet? Undo it from the Push window — its changes come back staged.'],
];

const openDialog = (d: 'fetch' | 'pull' | 'push') => window.dispatchEvent(new CustomEvent('gb:repo-dialog', { detail: d }));
/** Opens the New Branch window of the workspace rail. */
export const requestNewBranch = (from?: string) => window.dispatchEvent(new CustomEvent('gb:new-branch', { detail: from ?? '' }));

/** The Changes tab when there is nothing to commit: where you stand, what to do next, recent activity. */
export function CleanSlate({ repoId, status, compact, onOpenCommit }: { repoId: string; status: RepoStatus; compact?: boolean; onOpenCommit?: (hash: string) => void }) {
  const { setRepoTab, revision, activeRepo } = useApp();
  const [commits, setCommits] = useState<GraphCommit[] | null>(null);
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));

  useEffect(() => {
    call('graph:log', { repoId, query: { scope: 'current', limit: 6 } })
      .then((r) => setCommits(r.commits))
      .catch(() => setCommits([]));
  }, [repoId, revision]);
  useEffect(() => {
    const t = window.setInterval(() => setTip((x) => (x + 1) % TIPS.length), 7000);
    return () => window.clearInterval(t);
  }, []);

  const last = commits?.[0] ?? null;
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

  const [ti, tt, tx] = TIPS[tip];

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
          <p className="muted">Your working folder matches the last commit. Edit any file and it appears here, ready to review and stage.</p>
        </div>
      </div>

      <div className="cs-grid">
        <section className={`cs-card cs-sync ${sync.tone}`}>
          <div className="cs-card-label">Sync</div>
          <div className="cs-sync-row">
            <span className="cs-sync-ico">{sync.icon}</span>
            <div className="grow">
              <strong>{sync.title}</strong>
              <div className="small muted">{sync.text}</div>
            </div>
          </div>
          <button className="btn primary block mt" onClick={sync.action.run}>
            {sync.action.label}
          </button>
        </section>

        <section className="cs-card">
          <div className="cs-card-label">Last commit</div>
          {!commits && <div className="small muted mm-shimmer">Loading…</div>}
          {commits && !last && <div className="small muted">No commits yet — your first commit starts the history.</div>}
          {last && (
            <>
              <div className="cs-last">
                <span className="cs-avatar" style={{ background: authorColor(last.email || last.author) }}>
                  {initials(last.author)}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="cs-last-subj ellipsis">{last.subject}</div>
                  <div className="small muted">
                    <span className="mono">{last.shortHash}</span> · {last.author} · {relative(last.date)}
                  </div>
                </div>
              </div>
              <button className="btn block mt" onClick={() => (onOpenCommit ? onOpenCommit(last.hash) : setRepoTab('changes'))}>
                ◉ Show in the graph
              </button>
            </>
          )}
        </section>

        <section className="cs-card">
          <div className="cs-card-label">Next steps</div>
          <div className="cs-actions">
            <button onClick={() => requestNewBranch()}>
              <span>⎇</span>New branch
            </button>
            <button onClick={() => requestQuickMerge({ source: status.branch ?? undefined })}>
              <span>⤵</span>Merge
            </button>
            <button onClick={() => setRepoTab('pulls')}>
              <span>⇄</span>Pull requests
            </button>
            <button onClick={() => setRepoTab('code')}>
              <span>&lt;/&gt;</span>Browse code
            </button>
          </div>
        </section>

        <section className="cs-card cs-wide">
          <div className="cs-card-label">Recent on {status.branch ?? 'HEAD'}</div>
          <div className="cs-timeline">
            {(commits ?? []).map((c, i) => (
              <button key={c.hash} className="cs-tl-row" style={{ ['--d' as string]: `${i * 60}ms` }} onClick={() => (onOpenCommit ? onOpenCommit(c.hash) : setRepoTab('changes'))} title="Show in the graph">
                <span className="cs-tl-dot" style={{ background: authorColor(c.email || c.author) }}>
                  {initials(c.author)}
                </span>
                <span className="ellipsis grow">{c.subject}</span>
                <span className="small muted nowrap">{relative(c.date)}</span>
              </button>
            ))}
            {commits && commits.length === 0 && <div className="small muted">Nothing yet.</div>}
          </div>
        </section>

        <section className="cs-card cs-tip" key={tip}>
          <div className="cs-card-label">Did you know</div>
          <div className="cs-tip-body">
            <span className="cs-tip-ico">{ti}</span>
            <div>
              <strong>{tt}</strong>
              <div className="small muted">{tx}</div>
            </div>
          </div>
          <div className="cs-dots">
            {TIPS.map((_, i) => (
              <button key={i} className={i === tip ? 'on' : ''} onClick={() => setTip(i)} aria-label={`Tip ${i + 1}`} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
