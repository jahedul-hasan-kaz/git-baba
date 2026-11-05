import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Spinner } from '../components/Modal';
import type { PullResult } from '../../shared/types';
import { RepoSyncBar } from '../components/RepoSyncBar';
import { FetchDialog } from '../dialogs/FetchDialog';
import { GitHubAppSetupDialog } from '../dialogs/GitHubAppSetupDialog';
import { PullDialog } from '../dialogs/PullDialog';
import { PushDialog } from '../dialogs/PushDialog';
import { QuickMergeHost } from '../dialogs/QuickMergeDialog';
import { useAsync } from '../hooks/useAsync';
import { call } from '../services/api';
import { useApp, type RepoTab } from '../state/AppState';
import { RepoSettingsPage } from './RepoSettingsPage';

// Screens load on demand (smaller start-up bundle).
const WorkspacePage = lazy(() => import('./workspace/WorkspacePage').then((m) => ({ default: m.WorkspacePage })));
const CodePage = lazy(() => import('./code/CodePage').then((m) => ({ default: m.CodePage })));
const ConflictsPage = lazy(() => import('./ConflictsPage').then((m) => ({ default: m.ConflictsPage })));
const ActionsTab = lazy(() => import('./github/ActionsTab').then((m) => ({ default: m.ActionsTab })));
const PullRequestsTab = lazy(() => import('./github/PullRequestsTab').then((m) => ({ default: m.PullRequestsTab })));
const PullRequestPage = lazy(() => import('./PullRequestPage').then((m) => ({ default: m.PullRequestPage })));
const RepoSettingsShell = lazy(() => import('./repoSettings/RepoSettingsShell').then((m) => ({ default: m.RepoSettingsShell })));

// "Not now" for the GitHub App banner is a per-viewer convenience; storage may be unavailable.
function readDismissed(repoId: string | undefined): boolean {
  try {
    return !!repoId && localStorage.getItem(`gg-app-setup-dismissed:${repoId}`) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(repoId: string): void {
  try {
    localStorage.setItem(`gg-app-setup-dismissed:${repoId}`, '1');
  } catch {
    // ignore
  }
}

export function RepoView() {
  const { activeRepo, repoTab, setRepoTab, revision, bump, appSetupRepoId, requestAppSetup, activeAccount, setAccounts, refreshSession, toast } = useApp();
  const otherAccount = activeRepo?.account && activeRepo.account.id !== activeAccount?.id ? activeRepo.account : null;
  const [setupDismissed, setSetupDismissed] = useState(() => readDismissed(activeRepo?.id));
  const [dialog, setDialog] = useState<'fetch' | 'pull' | 'push' | null>(null);
  // Other screens (e.g. the clean Changes screen) can open the sync dialogs.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<'fetch' | 'pull' | 'push'>).detail;
      if (d === 'fetch' || d === 'pull' || d === 'push') setDialog(d);
    };
    window.addEventListener('gb:repo-dialog', on);
    return () => window.removeEventListener('gb:repo-dialog', on);
  }, []);
  const repoId = activeRepo?.id ?? '';
  const status = useAsync(() => (repoId && activeRepo?.exists ? call('git:status', { repoId }) : Promise.resolve(null)), [repoId, revision, activeRepo?.exists]);
  // Edits made outside the app (editor, build tools, another terminal) show up without a click:
  // while the window is visible, quietly re-read the status and apply it only when it changed.
  const setStatusData = status.setData;
  const lastSig = useRef('');
  useEffect(() => {
    if (!repoId || !activeRepo?.exists) return;
    let stop = false;
    let busy = false;
    lastSig.current = JSON.stringify(status.data);
    const tick = async () => {
      if (busy || stop || document.hidden || !document.hasFocus()) return;
      busy = true;
      try {
        const next = await call('git:status', { repoId });
        const sig = JSON.stringify(next);
        if (!stop && sig !== lastSig.current) {
          lastSig.current = sig;
          setStatusData(next);
        }
      } catch {
        /* transient (index busy, repo mid-operation): the next tick retries */
      } finally {
        busy = false;
      }
    };
    const t = window.setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, activeRepo?.exists, revision]);
  // A branch switch whose re-applied changes still need conflict resolution.
  const switchSession = useAsync(() => (repoId && activeRepo?.exists ? call('git:switchSession', { repoId }) : Promise.resolve(null)), [repoId, revision, activeRepo?.exists]);

  if (!activeRepo) return null;
  const st = status.data;
  const conflictCount = st?.conflicted.length ?? 0;
  const inOperation = !!st?.operation || !!switchSession.data;

  const tabs: [RepoTab, string, number | null, string][] = [
    ['changes', 'Changes', st ? st.staged.length + st.unstaged.length + st.untracked.length : null, '✎'],
    ['code', 'Code', null, '</>'],
    ['pulls', 'Pull Requests', null, '⇄'],
    ['actions', 'Actions', null, '▶'],
    ...(inOperation || conflictCount > 0 ? ([['conflicts', 'Conflicts', conflictCount, '⚠']] as [RepoTab, string, number, string][]) : []),
    ['settings', 'Settings', null, '⚙'],
  ];

  const onPullDone = (r: PullResult | null) => {
    setDialog(null);
    bump();
    if (r?.outcome === 'conflicts') setRepoTab('conflicts');
  };

  return (
    <>
      <div className="topbar deck">
        <RepoIdentity />
        {st?.operation && <span className="badge danger">{st.operation} in progress</span>}
        <RepoSyncBar
          repoId={repoId}
          isGitHub={!!activeRepo.github}
          hasRemote={!!activeRepo.remoteUrl}
          status={st ?? null}
          loading={status.loading}
          inOperation={inOperation}
          disabled={!activeRepo.exists}
          onRefresh={() => bump()}
          onFetch={() => setDialog('fetch')}
          onPull={() => setDialog('pull')}
          onPush={() => setDialog('push')}
        />
      </div>

      {!activeRepo.exists ? (
        <div className="content">
          <div className="banner danger">
            <span className="icon">⚠</span>
            <div>
              <strong>Repository folder missing</strong>
              <div>{activeRepo.path} no longer exists. Remove it from the app in Settings, or restore the folder.</div>
            </div>
          </div>
          <RepoSettingsPage />
        </div>
      ) : (
        <>
          {otherAccount && (
            <div className="banner warn" style={{ margin: '10px 18px 0' }}>
              <span className="icon">⇄</span>
              <div className="grow">
                <strong>This repository belongs to {otherAccount.login}.</strong>{' '}
                {activeAccount ? `You are using ${activeAccount.login}. ` : ''}Switch to {otherAccount.login} to commit, push, pull and use pull requests or Actions here.
              </div>
              <button
                className="btn sm primary"
                onClick={async () => {
                  setAccounts(await call('accounts:setActive', { accountId: otherAccount.id }));
                  await refreshSession().catch(() => undefined);
                  toast(`Switched to ${otherAccount.login}`);
                  bump();
                }}
              >
                Switch to {otherAccount.login}
              </button>
            </div>
          )}
          {activeRepo.github && !activeRepo.settings.githubApp && !setupDismissed && (
            <div className="banner info" style={{ margin: '10px 18px 0' }}>
              <span className="icon">🔑</span>
              <div className="grow">
                <strong>GitHub repository: {activeRepo.github.owner}/{activeRepo.github.repo}.</strong> Link your GitHub App once so push and PR dialogs don't ask for the App ID, owner and repository
                again.
              </div>
              <button className="btn sm primary" onClick={() => requestAppSetup(activeRepo.id)}>
                Set up GitHub App
              </button>
              <button
                className="btn sm ghost"
                onClick={() => {
                  writeDismissed(activeRepo.id);
                  setSetupDismissed(true);
                }}
              >
                Not now
              </button>
            </div>
          )}
          {inOperation && repoTab !== 'conflicts' && (
            <div className="banner warn" style={{ margin: '10px 18px 0' }}>
              <span className="icon">⚠</span>
              <div className="grow">
                {switchSession.data && !st?.operation
                  ? `Your changes from ${switchSession.data.from ?? 'detached HEAD'} are being brought to ${switchSession.data.to}`
                  : `A ${st?.operation} is in progress`}
                {conflictCount ? ` with ${conflictCount} conflicted file(s)` : ''}.
              </div>
              <button className="btn sm" onClick={() => setRepoTab('conflicts')}>
                Open conflict resolution
              </button>
            </div>
          )}
          <TabDock tabs={tabs} active={repoTab} onPick={setRepoTab} />
<Suspense fallback={<div className="content"><Spinner label="Loading…" /></div>}>
          {repoTab === 'changes' && <WorkspacePage status={st} reload={status.reload} error={status.error} />}
          {repoTab === 'code' && <CodePage key={repoId} />}
          {repoTab === 'pr' && <PullRequestPage />}
          {repoTab === 'pulls' && <PullRequestsTab />}
          {repoTab === 'actions' && <ActionsTab />}
          {repoTab === 'conflicts' && <ConflictsPage status={st} switchSession={switchSession.data ?? null} />}
          {repoTab === 'settings' && (
            <div className="content">
              <RepoSettingsShell />
            </div>
          )}
</Suspense>
        </>
      )}

      {dialog === 'fetch' && (
        <FetchDialog
          repoId={repoId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            bump();
          }}
        />
      )}
      {appSetupRepoId === activeRepo.id && <GitHubAppSetupDialog repo={activeRepo} onClose={() => requestAppSetup(null)} />}
      <QuickMergeHost repoId={repoId} />
      {dialog === 'pull' && <PullDialog repoId={repoId} onClose={() => setDialog(null)} onDone={onPullDone} />}
      {dialog === 'push' && (
        <PushDialog
          repoId={repoId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            bump();
          }}
          onRequestPull={() => setDialog('pull')}
        />
      )}
    </>
  );
}

const DECK_COLORS = ['#5b8cff', '#3ecf8e', '#f5b84a', '#ff6b6b', '#b18cff', '#6cc4ff', '#ff9f6b', '#9fd36b'];
const deckColor = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DECK_COLORS[h % DECK_COLORS.length];
};

/** Repository identity: monogram tile, name and interactive chips (remote, account, owner, folder). */
function RepoIdentity() {
  const { activeRepo, toast, showError } = useApp();
  if (!activeRepo) return null;
  const c = deckColor(activeRepo.identity ?? activeRepo.name);
  const copy = (text: string, what: string) =>
    call('app:copyText', { text })
      .then(() => toast(`${what} copied`))
      .catch(showError);
  const web = activeRepo.github ? `https://github.com/${activeRepo.github.owner}/${activeRepo.github.repo}` : null;
  return (
    <div className="deck-id">
      <div className="deck-tile" style={{ ['--rc' as string]: c }}>
        {activeRepo.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '⎇'}
      </div>
      <div className="deck-main">
        <h1 className="deck-name ellipsis" title={activeRepo.name}>
          {activeRepo.name}
        </h1>
        <div className="deck-chips">
          {activeRepo.identity || activeRepo.remoteUrl ? (
            <button
              className="deck-chip"
              title={web ? 'Open on GitHub (right-click to copy)' : 'Copy remote URL'}
              onClick={() => (web ? void call('shell:openExternal', { url: web }).catch(showError) : copy(activeRepo.remoteUrl ?? '', 'Remote URL'))}
              onContextMenu={(e) => {
                e.preventDefault();
                copy(activeRepo.remoteUrl ?? activeRepo.identity ?? '', 'Remote URL');
              }}
            >
              <span>{activeRepo.github ? '🐙' : '☁'}</span>
              <span className="ellipsis">{activeRepo.identity ?? activeRepo.remoteUrl}</span>
              {web && <span className="deck-chip-go">↗</span>}
            </button>
          ) : (
            <span className="deck-chip warn">☁ no remote</span>
          )}
          <button className="deck-chip path" onClick={() => copy(activeRepo.path, 'Folder path')} title={`${activeRepo.path}\nClick to copy`}>
            <span>📁</span>
            <span className="ellipsis">{activeRepo.path}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Tab bar with icons, a sliding active indicator, counts and Ctrl+1…9 shortcuts. */
function TabDock({ tabs, active, onPick }: { tabs: [RepoTab, string, number | null, string][]; active: RepoTab; onPick: (t: RepoTab) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!el) return setInk(null);
    setInk({ left: el.offsetLeft, width: el.offsetWidth });
  }, [active, tabs.length]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && tabs[n - 1]) {
        e.preventDefault();
        onPick(tabs[n - 1][0]);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [tabs, onPick]);
  useEffect(() => {
    const on = () => {
      const el = ref.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
      if (el) setInk({ left: el.offsetLeft, width: el.offsetWidth });
    };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [active]);
  return (
    <div className="tabs dock" ref={ref} role="tablist">
      {tabs.map(([id, label, count, icon], i) => (
        <div
          key={id}
          data-tab={id}
          role="tab"
          aria-selected={active === id}
          className={`tab ${active === id ? 'active' : ''} ${id === 'conflicts' ? 'alert' : ''}`}
          onClick={() => onPick(id)}
          title={i < 9 ? `${label} (Ctrl+${i + 1})` : label}
        >
          <span className="tab-ico">{icon}</span>
          {label}
          {count !== null && count > 0 && <span className={`tab-count ${id === 'conflicts' ? 'danger' : ''}`}>{count}</span>}
        </div>
      ))}
      {ink && <span className="tab-ink" style={{ transform: `translateX(${ink.left}px)`, width: ink.width }} />}
    </div>
  );
}
