import type { ReactNode } from 'react';
import type { GhRepoContext } from '../../../shared/github';
import { BrowserSignIn } from '../../components/github/BrowserSignIn';
import { ErrorPanel } from '../../components/ErrorPanel';
import { GhContextBar, SessionGate, Skeleton, useGh } from '../../components/github/common';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';

/** Errors that a different credential can fix (no session, token without access). */
const NEEDS_CONNECT = new Set(['session-required', 'session-expired', 'no-account', 'not-found', 'forbidden', 'pat-permission', 'sso-required']);

/**
 * Common frame for repository-scoped GitHub tabs. Git Baba reaches GitHub with the signed-in
 * account's token, or — when that cannot read the repository — with the user's GitHub CLI login.
 * Only when neither works does it ask the user to connect.
 */
export function GitHubRepoShell({ what, children, extra }: { what: string; children: (ctx: GhRepoContext, repoId: string) => ReactNode; extra?: ReactNode }) {
  const { activeRepo } = useApp();
  if (!activeRepo) return null;
  if (!activeRepo.github) {
    return (
      <div className="content">
        <div className="empty">
          <h3>Not a GitHub repository</h3>
          <p className="muted">{what} need an “origin” remote on github.com (or your GitHub Enterprise host). Add one in the Settings tab.</p>
        </div>
      </div>
    );
  }
  return (
    <Inner repoId={activeRepo.id} extra={extra} what={what}>
      {children}
    </Inner>
  );
}

function Inner({ repoId, children, extra, what }: { repoId: string; children: (ctx: GhRepoContext, repoId: string) => ReactNode; extra?: ReactNode; what: string }) {
  const { session, activeAccount } = useApp();
  const ctx = useGh(() => call('gh:context', { repoId }), [repoId, session?.active]);
  if (ctx.error) {
    if (NEEDS_CONNECT.has(ctx.error.code)) return <ConnectGitHub repoId={repoId} what={what} reason={ctx.error.message} onConnected={() => void ctx.reload()} hasAccount={!!activeAccount} />;
    return (
      <div className="content">
        <ErrorPanel error={ctx.error} onAction={() => ctx.reload()} available={['retry']} />
      </div>
    );
  }
  if (!ctx.data) {
    return (
      <div className="content">
        <Skeleton rows={6} />
      </div>
    );
  }
  return (
    <>
      <GhContextBar ctx={ctx.data} extra={extra} />
      {children(ctx.data, repoId)}
    </>
  );
}

/** Shown only when no credential can read the repository: browser sign-in first, a token as the alternative. */
export function ConnectGitHub({ repoId, what, reason, onConnected, hasAccount }: { repoId: string; what: string; reason?: string; onConnected: () => void; hasAccount: boolean }) {
  const { setView } = useApp();
  return (
    <div className="content">
      <div className="connect-page fade-in">
        <div className="connect-hero">
          <div className="connect-icon">🔗</div>
          <h2>Connect to GitHub</h2>
          <p className="muted">{what} need access to this repository on GitHub.</p>
          {reason && <p className="small muted connect-reason">{reason}</p>}
        </div>
        <div className="connect-grid">
          <div className="connect-card recommended">
            <span className="badge ok connect-badge">Recommended</span>
            <BrowserSignIn repoId={repoId} onDone={onConnected} />
          </div>
          <div className="connect-card">
            <div className="bsi-head">
              <span className="bsi-logo">🔑</span>
              <div className="grow">
                <strong>Use a personal access token</strong>
                <div className="small muted">For a fine-grained token, allow Pull requests and Contents for this repository.</div>
              </div>
            </div>
            {hasAccount ? (
              <SessionGate what={what}>
                <div className="small muted bsi-body">
                  Your account is signed in, but its token cannot read this repository. Update the token on the{' '}
                  <a onClick={() => setView('accounts')}>Accounts</a> page, or sign in with GitHub instead.
                </div>
              </SessionGate>
            ) : (
              <div className="bsi-body">
                <button className="btn" onClick={() => setView('accounts')}>
                  Add an account with a token
                </button>
              </div>
            )}
          </div>
        </div>
        <p className="small muted center">An SSH key can push code, but GitHub only shows pull requests to a signed-in account or token.</p>
      </div>
    </div>
  );
}
