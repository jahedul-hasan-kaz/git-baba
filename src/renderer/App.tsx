import { lazy, Suspense, useEffect, useRef } from 'react';
import { Modal, Spinner } from './components/Modal';
import { AppFooter } from './components/AppFooter';
import { AppHeader } from './components/AppHeader';
import { GlobalErrorDialog } from './components/ErrorPanel';
import { Sidebar } from './components/Sidebar';
import { AddAccountDialog } from './dialogs/AddAccountDialog';
import { TitleBar } from './components/TitleBar';
import { RepoView } from './pages/RepoView';
import { WelcomePage } from './pages/WelcomePage';
import { AppStateProvider, useApp } from './state/AppState';

// Screens load on demand (smaller start-up bundle).
const AccountCenter = lazy(() => import('./pages/account/AccountCenter').then((m) => ({ default: m.AccountCenter })));
const HelpPage = lazy(() => import('./pages/HelpPage').then((m) => ({ default: m.HelpPage })));
const OperationHistoryPage = lazy(() => import('./pages/OperationHistoryPage').then((m) => ({ default: m.OperationHistoryPage })));
const TokenPage = lazy(() => import('./pages/TokenPage').then((m) => ({ default: m.TokenPage })));

function Main() {
  const { view, activeRepo, toasts, accountsOpen, setAccountsOpen, tokenOpen, setTokenOpen, session, activeAccount } = useApp();
  // Manage accounts is for a signed-in account: without one, the sign-in window opens instead.
  const signedIn = !!session?.active;
  // Signing out from inside Manage accounts closes it (rather than turning it into a sign-in prompt).
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (wasSignedIn.current && !signedIn && accountsOpen) setAccountsOpen(false);
    wasSignedIn.current = signedIn;
  }, [signedIn, accountsOpen, setAccountsOpen]);
  return (
    <div className="shell">
      <TitleBar />
      <AppHeader />
      <div className="app">
        <Sidebar />
        <main className="main">
<Suspense fallback={<div className="content"><Spinner label="Loading…" /></div>}>
          {view === 'repo' && activeRepo && <RepoView key={activeRepo.id} />}
          {(view === 'welcome' || (view === 'repo' && !activeRepo)) && <WelcomePage />}
          {view === 'history' && <OperationHistoryPage />}
          {view === 'help' && <HelpPage />}
</Suspense>
        </main>
      </div>
      <AppFooter />
      {tokenOpen && (
        <Modal title="Create GitHub App token" icon="🧩" size="wide" onClose={() => setTokenOpen(false)}>
          <div className="token-modal">
            <Suspense fallback={<Spinner label="Loading…" />}>
              <TokenPage />
            </Suspense>
          </div>
        </Modal>
      )}
      {accountsOpen && !signedIn && <AddAccountDialog account={activeAccount ?? undefined} onClose={() => setAccountsOpen(false)} />}
      {accountsOpen && signedIn && (
        <Modal title="Manage accounts" icon="👤" size="wide" onClose={() => setAccountsOpen(false)}>
          <div className="acct-modal">
            <Suspense fallback={<Spinner label="Loading…" />}>
              <AccountCenter />
            </Suspense>
          </div>
        </Modal>
      )}
      <GlobalErrorDialog />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  return (
    <AppStateProvider>
      <Main />
    </AppStateProvider>
  );
}
