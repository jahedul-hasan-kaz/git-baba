import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionStatus } from '../../shared/github';
import type { AccountsState, AccountSummary, FriendlyError, RepoSummary } from '../../shared/types';
import { call, toFriendly } from '../services/api';

export type GlobalView = 'repo' | 'token' | 'history' | 'help' | 'welcome' | 'accounts';
export type RepoTab = 'changes' | 'code' | 'graph' | 'branches' | 'pr' | 'pulls' | 'actions' | 'conflicts' | 'settings';

export interface Toast {
  id: number;
  kind: 'success' | 'info' | 'warning';
  text: string;
}

interface AppInfo {
  version: string;
  platform: string;
  gitVersion: string | null;
  encryptionAvailable: boolean;
}

interface AppStateValue {
  info: AppInfo | null;
  repos: RepoSummary[];
  activeRepo: RepoSummary | null;
  activeRepoId: string | null;
  selectRepo: (id: string | null) => void;
  view: GlobalView;
  /** Switches the main screen. 'accounts' opens the account manager as a window over the current screen instead. */
  setView: (v: GlobalView) => void;
  accountsOpen: boolean;
  setAccountsOpen: (open: boolean) => void;
  /** The GitHub App token generator, shown as a window ('token' views open it). */
  tokenOpen: boolean;
  setTokenOpen: (open: boolean) => void;
  repoTab: RepoTab;
  setRepoTab: (t: RepoTab) => void;
  refreshRepos: () => Promise<void>;
  error: FriendlyError | null;
  showError: (err: unknown, onReviewAuth?: () => void) => void;
  reviewAuthHandler: (() => void) | null;
  clearError: () => void;
  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind']) => void;
  /** Incremented after any mutating operation so views reload. */
  revision: number;
  bump: () => void;
  /** Repository whose GitHub App setup dialog should be shown. */
  appSetupRepoId: string | null;
  requestAppSetup: (repoId: string | null) => void;
  accounts: AccountsState | null;
  /** In-memory GitHub session of the active account (null when no account). */
  session: SessionStatus | null;
  refreshSession: () => Promise<void>;
  /** Changes whenever the active account or its session changes, so GitHub views reload. */
  ghKey: string;
  /** Deep link into the Pull Requests tab (e.g. after creating a PR or from a Dependabot alert). */
  openPr: number | null;
  setOpenPr: (n: number | null) => void;
  /** Deep link into "Open a pull request" with the branches prefilled (e.g. from the merge dialog). */
  prDraft: { base: string; head: string } | null;
  setPrDraft: (d: { base: string; head: string } | null) => void;
  activeAccount: AccountSummary | null;
  refreshAccounts: () => Promise<void>;
  setAccounts: (s: AccountsState) => void;
}

const Ctx = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [view, setViewRaw] = useState<GlobalView>('welcome');
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const setView = useCallback((v: GlobalView) => {
    if (v === 'accounts') setAccountsOpen(true);
    else if (v === 'token') setTokenOpen(true);
    else {
      setAccountsOpen(false);
      setViewRaw(v);
    }
  }, []);
  const [repoTab, setRepoTabRaw] = useState<RepoTab>('changes');
  // Changes, branches & stash and the history graph live together in the Changes workspace now;
  // older links to the separate tabs land there.
  const setRepoTab = useCallback((t: RepoTab) => setRepoTabRaw(t === 'graph' || t === 'branches' ? 'changes' : t), []);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [reviewAuthHandler, setReviewAuthHandler] = useState<(() => void) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [revision, setRevision] = useState(0);
  const [appSetupRepoId, setAppSetupRepoId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountsState | null>(null);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [openPr, setOpenPr] = useState<number | null>(null);
  const [prDraft, setPrDraft] = useState<{ base: string; head: string } | null>(null);
  const toastId = useRef(0);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const showError = useCallback((err: unknown, onReviewAuth?: () => void) => {
    setError(toFriendly(err));
    setReviewAuthHandler(() => onReviewAuth ?? null);
  }, []);

  const refreshRepos = useCallback(async () => {
    try {
      setRepos(await call('repo:list'));
    } catch (err) {
      showError(err);
    }
  }, [showError]);

  const bump = useCallback(() => {
    setRevision((r) => r + 1);
    void refreshRepos();
  }, [refreshRepos]);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await call('session:status', {}));
    } catch {
      setSession(null);
    }
  }, []);

  const refreshAccounts = useCallback(async () => {
    try {
      setAccounts(await call('accounts:list'));
    } catch (err) {
      showError(err);
    }
  }, [showError]);

  useEffect(() => {
    void call('app:info').then(setInfo).catch(showError);
    void refreshRepos();
    void refreshAccounts();
  }, [refreshRepos, refreshAccounts, showError]);

  // Refresh when the window regains focus (files may have changed in an editor).
  useEffect(() => {
    const onFocus = () => bump();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [bump]);

  useEffect(() => {
    void refreshSession();
  }, [accounts?.activeAccountId, refreshSession]);

  const selectRepo = useCallback((id: string | null) => {
    setActiveRepoId(id);
    setViewRaw(id ? 'repo' : 'welcome');
    setRepoTab('changes');
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      info,
      repos,
      activeRepoId,
      activeRepo: repos.find((r) => r.id === activeRepoId) ?? null,
      selectRepo,
      view,
      setView,
      accountsOpen,
      setAccountsOpen,
      tokenOpen,
      setTokenOpen,
      repoTab,
      setRepoTab,
      refreshRepos,
      error,
      showError,
      reviewAuthHandler,
      clearError: () => {
        setError(null);
        setReviewAuthHandler(null);
      },
      toasts,
      toast,
      revision,
      bump,
      appSetupRepoId,
      requestAppSetup: setAppSetupRepoId,
      accounts,
      session,
      refreshSession,
      ghKey: `${accounts?.activeAccountId ?? 'none'}:${session?.active ? 'on' : 'off'}`,
      openPr,
      setOpenPr,
      prDraft,
      setPrDraft,
      activeAccount: accounts?.accounts.find((a) => a.active) ?? null,
      refreshAccounts,
      setAccounts: (s: AccountsState) => {
        setAccounts(s);
        void refreshRepos(); // account associations shown in the sidebar may change
      },
    }),
    [info, repos, activeRepoId, selectRepo, view, setView, accountsOpen, tokenOpen, repoTab, refreshRepos, error, showError, reviewAuthHandler, toasts, toast, revision, bump, appSetupRepoId, accounts, refreshAccounts, session, refreshSession, openPr, prDraft],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppStateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
