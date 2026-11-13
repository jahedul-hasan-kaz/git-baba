import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Spinner } from '../components/Modal';
import type { PullResult } from '../../shared/types';
import { RepoSyncBar } from '../components/RepoSyncBar';
import { AddAccountDialog } from '../dialogs/AddAccountDialog';
import { FetchDialog } from '../dialogs/FetchDialog';
import { GitHubAppSetupDialog } from '../dialogs/GitHubAppSetupDialog';
import { PullDialog } from '../dialogs/PullDialog';
import { PushDialog } from '../dialogs/PushDialog';
import { QuickMergeHost } from '../dialogs/QuickMergeDialog';
import { useAsync } from '../hooks/useAsync';
import { call } from '../services/api';
import { useApp, type RepoTab } from '../state/AppState';
import { MissingWorktree } from './MissingWorktree';
import { RepoSettingsPage } from './RepoSettingsPage';

// Screens load on demand (smaller start-up bundle).
const WorkspacePage = lazy(() => import('./workspace/WorkspacePage').then((m) => ({ default: m.WorkspacePage })));
const CodePage = lazy(() => import('./code/CodePage').then((m) => ({ default: m.CodePage })));
const ConflictsPage = lazy(() => import('./ConflictsPage').then((m) => ({ default: m.ConflictsPage })));
const ActionsTab = lazy(() => import('./github/ActionsTab').then((m) => ({ default: m.ActionsTab })));
const PullRequestsTab = lazy(() => import('./github/PullRequestsTab').then((m) => ({ default: m.PullRequestsTab })));
const PullRequestPage = lazy(() => import('./PullRequestPage').then((m) => ({ default: m.PullRequestPage })));
import { FILTER_EVENT, requestClearFilter } from '../services/jump';
const SearchPalette = lazy(() => import('../components/search/SearchPalette').then((m) => ({ default: m.SearchPalette })));
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
  const { activeRepo, repoTab, setRepoTab, revision, bump, appSetupRepoId, requestAppSetup, activeAccount, accounts, setAccounts, refreshSession, refreshRepos, toast, setView } = useApp();
  const otherAccount = activeRepo?.account && activeRepo.account.id !== activeAccount?.id ? activeRepo.account : null;
  // The account this repository belongs to was signed out (or removed): ask to sign in to it again.
  const missingAccount = activeRepo?.missingAccount ?? null;
  const [signInMissing, setSignInMissing] = useState(false);
  // Opening a repository re-checks its account (it may have been signed out since the list was loaded).
  useEffect(() => {
    void refreshRepos().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepo?.id]);
  const [setupDismissed, setSetupDismissed] = useState(() => readDismissed(activeRepo?.id));
  const [dialog, setDialog] = useState<'fetch' | 'pull' | 'push' | null>(null);
  const lockedRef = useRef(false);
  lockedRef.current = !!otherAccount;
  // Other screens (e.g. the clean Changes screen) can open the sync dialogs.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<'fetch' | 'pull' | 'push'>).detail;
      if (lockedRef.current) return;
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

  const switchToOwner = async () => {
    if (!otherAccount) return;
    setAccounts(await call('accounts:setActive', { accountId: otherAccount.id }));
    await refreshSession().catch(() => undefined);
    toast(`Switched to ${otherAccount.login}`);
    bump();
  };
  // Another account's repository: everything but Settings stays locked until the user switches.
  // A GitHub repository opens only with a GitHub account shown (signed in) in the header.
  const noAccount = !!activeRepo?.github && !!accounts && !activeAccount;
  const locked = !!otherAccount || noAccount || !!missingAccount;

  const onMissingSignedIn = async (a: { id: string; login: string }) => {
    if (!missingAccount || a.login.toLowerCase() !== missingAccount.login.toLowerCase()) return;
    // Make it the account in use, so the repository opens straight away.
    setAccounts(await call('accounts:setActive', { accountId: a.id }));
    await Promise.all([refreshSession().catch(() => undefined), refreshRepos().catch(() => undefined)]);
    bump();
  };

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
          disabled={!activeRepo.exists || locked}
          onRefresh={() => bump()}
          onFetch={() => setDialog('fetch')}
          onPull={() => setDialog('pull')}
          onPush={() => setDialog('push')}
        />
      </div>

      {!activeRepo.exists && activeRepo.worktreeOf ? (
        <MissingWorktree key={activeRepo.id} repo={activeRepo} />
      ) : !activeRepo.exists ? (
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
          <div className="repo-banners">
          {otherAccount && repoTab === 'settings' && (
            <div className="banner warn">
              <span className="icon">⇄</span>
              <div className="grow">
                <strong>This repository belongs to {otherAccount.login}.</strong>{' '}
                {activeAccount ? `You are using ${activeAccount.login}. ` : ''}Switch to {otherAccount.login} to commit, push, pull and use pull requests or Actions here.
              </div>
              <button
                className="btn sm primary"
                onClick={() => void switchToOwner()}
              >
                Switch to {otherAccount.login}
              </button>
            </div>
          )}
          {activeRepo.github && !activeRepo.settings.githubApp && !setupDismissed && !locked && (
            <div className="banner info">
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
            <div className="banner warn">
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
          </div>
          <TabDock tabs={tabs} active={repoTab} onPick={setRepoTab} locked={locked} />
<Suspense fallback={<div className="content"><Spinner label="Loading…" /></div>}>
          {missingAccount ? (
            <div className="content">
              <div className="empty-state" style={{ textAlign: 'center', padding: '60px 20px' }}>
                <div style={{ fontSize: 36 }}>🔐</div>
                <h2>Sign in to {missingAccount.login} to open this repository</h2>
                <p className="muted">
                  {activeRepo.name}
                  {missingAccount.viaOrg ? ` (${missingAccount.viaOrg})` : ''} belongs to {missingAccount.login}, which is signed out of Git Baba. Your files are safe on this computer — sign in to{' '}
                  {missingAccount.login} again for changes, code, pull requests, Actions and syncing.
                </p>
                <button className="btn primary" onClick={() => setSignInMissing(true)}>
                  Sign in to {missingAccount.login}
                </button>
              </div>
            </div>
          ) : noAccount ? (
            <div className="content">
              <div className="empty-state" style={{ textAlign: 'center', padding: '60px 20px' }}>
                <div style={{ fontSize: 36 }}>🔐</div>
                <h2>Sign in to GitHub to open this repository</h2>
                <p className="muted">
                  {activeRepo.name} is on GitHub. Add your GitHub account once — Git Baba also picks up a sign-in already on this PC — and it stays signed in.
                </p>
                <button className="btn primary" onClick={() => setView('accounts')}>
                  Sign in to GitHub
                </button>
              </div>
            </div>
          ) : locked && otherAccount ? (
            <div className="content">
              <div className="empty-state" style={{ textAlign: 'center', padding: '60px 20px' }}>
                <div style={{ fontSize: 36 }}>🔒</div>
                <h2>Switch to {otherAccount.login} to open this repository</h2>
                <p className="muted">
                  {activeRepo.name} belongs to {otherAccount.login}
                  {activeAccount ? `, but you are using ${activeAccount.login}` : ''}. Changes, code, pull requests, Actions, settings and syncing are available once {otherAccount.login} is the active account.
                </p>
                <button className="btn primary" onClick={() => void switchToOwner()}>
                  ⇄ Switch to {otherAccount.login}
                </button>
              </div>
            </div>
          ) : (
          <>
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
          </>
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
      {signInMissing && missingAccount && (
        <AddAccountDialog
          expectLogin={missingAccount.login}
          expectApiBaseUrl={missingAccount.apiBaseUrl}
          onAdded={(a) => void onMissingSignedIn(a)}
          onClose={() => setSignInMissing(false)}
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
/** Visibility of GitHub repositories, by repo id: fetched once per session. */
const visibilityCache = new Map<string, 'private' | 'public'>();

const ICONS = {
  github: 'M12 2C6.48 2 2 6.58 2 12.22c0 4.5 2.87 8.32 6.84 9.67.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.36-3.37-1.36-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.350 1.11 2.92.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.030 1.64 1.03 2.76 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.81c0 .27.18.6.69.49A10.1 10.1 0 0 0 22 12.22C22 6.58 17.52 2 12 2z',
  cloud: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.1 4.5 4.5 0 0 0 7 18z',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
} as const;

function Ic({ d, fill }: { d: string; fill?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function RepoIdentity() {
  const { activeRepo, repos, selectRepo, toast, showError, ghKey } = useApp();
  const [vis, setVis] = useState<'private' | 'public' | null>(null);
  const repoId = activeRepo?.id;
  const isGh = !!activeRepo?.github;
  useEffect(() => {
    if (!repoId || !isGh) {
      setVis(null);
      return;
    }
    const known = visibilityCache.get(repoId);
    if (known) {
      setVis(known);
      return;
    }
    setVis(null);
    let live = true;
    call('gh:context', { repoId })
      .then((c) => {
        const v = c.isPrivate ? 'private' : 'public';
        visibilityCache.set(repoId, v);
        if (live) setVis(v);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repoId, isGh, ghKey]);
  if (!activeRepo) return null;
  const mainRepo = activeRepo.worktreeOf ? repos.find((r) => r.id === activeRepo.worktreeOf) : undefined;
  const c = deckColor(activeRepo.identity ?? activeRepo.name);
  const copy = (text: string, what: string) =>
    call('app:copyText', { text })
      .then(() => toast(`${what} copied`))
      .catch(showError);
  const web = activeRepo.github ? `https://github.com/${activeRepo.github.owner}/${activeRepo.github.repo}` : null;
  const remote = activeRepo.remoteUrl ?? activeRepo.identity;
  return (
    <div className="deck-id">
      <div className="deck-tile" style={{ ['--rc' as string]: c }}>
        {activeRepo.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '⎇'}
      </div>
      <div className="deck-main">
        <div className="deck-title">
          <h1 className="deck-name ellipsis" title={activeRepo.name}>
            {activeRepo.name}
          </h1>
          {vis && (
            <span className={`deck-vis ${vis}`} title={vis === 'private' ? 'Private repository: only people with access can see it' : 'Public repository: anyone can see it'}>
              <Ic d={vis === 'private' ? ICONS.lock : ICONS.globe} />
              {vis === 'private' ? 'Private' : 'Public'}
            </span>
          )}
          {!remote && (
            <span className="deck-vis local" title="This repository has no remote">
              Local only
            </span>
          )}
        </div>
        <div className="deck-acts">
          {mainRepo && (
            <button className="deck-chip wt-of" onClick={() => selectRepo(mainRepo.id)} title={`This folder is a worktree of ${mainRepo.name}\nClick to go back to the main folder`}>
              <span>🗂</span>
              <span className="ellipsis">worktree of {mainRepo.name}</span>
              <span className="deck-chip-go">↩</span>
            </button>
          )}
          {web && (
            <button className="deck-act" title={`Open on GitHub\n${web}`} onClick={() => void call('shell:openExternal', { url: web }).catch(showError)}>
              <Ic d={ICONS.github} fill />
              <span>GitHub</span>
            </button>
          )}
          {remote && (
            <button className="deck-act" title={`Copy remote URL\n${remote}`} onClick={() => copy(remote, 'Remote URL')}>
              <Ic d={web ? ICONS.copy : ICONS.cloud} />
              <span>{web ? 'Copy URL' : 'Remote'}</span>
            </button>
          )}
          {activeRepo.exists && (
            <button className="deck-act" title={`Show in folder\n${activeRepo.path}`} onClick={() => void call('graph:reveal', { repoId: activeRepo.id, path: '.' }).catch(showError)}>
              <Ic d={ICONS.folder} />
              <span>Folder</span>
            </button>
          )}
          <button className="deck-act icon-only" title={`Copy folder path\n${activeRepo.path}`} aria-label="Copy folder path" onClick={() => copy(activeRepo.path, 'Folder path')}>
            <Ic d={ICONS.copy} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Tab bar with icons, a sliding active indicator, counts and Ctrl+1…9 shortcuts. */
function TabDock({ tabs, active, onPick: pick, locked }: { tabs: [RepoTab, string, number | null, string][]; active: RepoTab; onPick: (t: RepoTab) => void; locked?: boolean }) {
  const isOff = (_t: RepoTab) => !!locked;
  const onPick = (t: RepoTab) => {
    if (!isOff(t)) pick(t);
  };
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
  const [searching, setSearching] = useState(false);
  const [filtered, setFiltered] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setFiltered(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(FILTER_EVENT, on);
    return () => window.removeEventListener(FILTER_EVENT, on);
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return (
    <div className="tabs dock" ref={ref} role="tablist">
      {tabs.map(([id, label, count, icon], i) => (
        <div
          key={id}
          data-tab={id}
          role="tab"
          aria-selected={active === id}
          aria-disabled={isOff(id)}
          className={`tab ${active === id ? 'active' : ''} ${id === 'conflicts' ? 'alert' : ''}`}
          style={isOff(id) ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
          onClick={() => onPick(id)}
          title={isOff(id) ? `Switch account to use ${label}` : i < 9 ? `${label} (Ctrl+${i + 1})` : label}
        >
          <span className="tab-ico">{icon}</span>
          {label}
          {count !== null && count > 0 && <span className={`tab-count ${id === 'conflicts' ? 'danger' : ''}`}>{count}</span>}
        </div>
      ))}
      {ink && <span className="tab-ink" style={{ transform: `translateX(${ink.left}px)`, width: ink.width }} />}
      {filtered && (
        <button className="tab-clear" onClick={requestClearFilter} title="Show all commits again">
          ✕ Clear search
        </button>
      )}
      <button className={`tab-search ${filtered ? 'after-clear' : ''}`} onClick={() => setSearching(true)} title="Search commits, code and tags (Ctrl+K)" aria-label="Search">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 21 21" />
        </svg>
        <span>Search</span>
        <kbd>Ctrl K</kbd>
      </button>
      {searching && (
        <Suspense fallback={null}>
          <SearchPalette onClose={() => setSearching(false)} />
        </Suspense>
      )}
    </div>
  );
}
