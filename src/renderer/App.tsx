import { lazy, Suspense } from 'react';
import { Spinner } from './components/Modal';
import { AppFooter } from './components/AppFooter';
import { AppHeader } from './components/AppHeader';
import { GlobalErrorDialog } from './components/ErrorPanel';
import { Sidebar } from './components/Sidebar';
import { RepoView } from './pages/RepoView';
import { WelcomePage } from './pages/WelcomePage';
import { AppStateProvider, useApp } from './state/AppState';

// Screens load on demand (smaller start-up bundle).
const AccountCenter = lazy(() => import('./pages/account/AccountCenter').then((m) => ({ default: m.AccountCenter })));
const HelpPage = lazy(() => import('./pages/HelpPage').then((m) => ({ default: m.HelpPage })));
const OperationHistoryPage = lazy(() => import('./pages/OperationHistoryPage').then((m) => ({ default: m.OperationHistoryPage })));
const TokenPage = lazy(() => import('./pages/TokenPage').then((m) => ({ default: m.TokenPage })));

function Main() {
  const { view, activeRepo, toasts } = useApp();
  return (
    <div className="shell">
      <AppHeader />
      <div className="app">
        <Sidebar />
        <main className="main">
<Suspense fallback={<div className="content"><Spinner label="Loading…" /></div>}>
          {view === 'repo' && activeRepo && <RepoView key={activeRepo.id} />}
          {(view === 'welcome' || (view === 'repo' && !activeRepo)) && <WelcomePage />}
          {view === 'token' && <TokenPage />}
          {view === 'accounts' && <AccountCenter />}
          {view === 'history' && <OperationHistoryPage />}
          {view === 'help' && <HelpPage />}
</Suspense>
        </main>
      </div>
      <AppFooter />
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
