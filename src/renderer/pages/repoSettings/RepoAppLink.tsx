import { ErrorPanel } from '../../components/ErrorPanel';
import { Skeleton, useGh, useMutation } from '../../components/github/common';
import { openExternal } from '../../components/github/SecureActionDialog';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';
import { Hourglass } from '../../components/Hourglass';

/**
 * Link this repository to a GitHub App registered at account level (Account → Settings → Credentials & Apps).
 * Shows whether the App is installed on the repository and installs it with one click if not.
 */
export function RepoAppLink({ repoId }: { repoId: string }) {
  const { setView, bump, activeRepo } = useApp();
  const status = useGh(() => call('gh:adminAppStatus', { repoId }), [repoId]);
  const { busy, run } = useMutation();
  const legacy = activeRepo?.settings.githubApp && !activeRepo.settings.githubApp.registryId ? activeRepo.settings.githubApp : null;

  if (status.error) return <ErrorPanel error={status.error} />;
  if (!status.data) return <Skeleton rows={3} />;
  const { linked, apps } = status.data;
  const reload = () => {
    void status.reload();
    bump();
  };

  return (
    <div>
      {linked ? (
        <div className={`app-link-hero ${linked.installed ? 'ok' : 'warn'}`}>
          <span className="app-logo big">{linked.name[0]?.toUpperCase()}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 6 }}>
              <strong>{linked.name}</strong>
              <span className="badge">App {linked.appId}</span>
              {linked.installed ? <span className="badge ok">✓ installed on this repository</span> : <span className="badge warn">not installed here</span>}
            </div>
            <div className="small muted">
              {linked.installed
                ? `Installation ${linked.installed.id} on ${linked.installed.account}. Push, fetch and PR dialogs can use the App key stored in your account — no key prompt.`
                : 'Linked, but GitHub has no installation of this App that covers the repository yet.'}
            </div>
          </div>
          {!linked.installed && (
            <button className="btn primary" onClick={() => openExternal(`${linked.htmlUrl}/installations/new`)}>
              Install on GitHub ↗
            </button>
          )}
          <button className="btn sm ghost" onClick={() => void status.reload()} title="Check the installation again">
            <Hourglass />
          </button>
          <button className="btn sm" disabled={busy} onClick={() => void run(() => call('gh:adminUnlinkApp', { repoId }), 'GitHub App unlinked').then(reload)}>
            Unlink
          </button>
        </div>
      ) : (
        <p className="small muted">
          Not linked to an account-level App. {legacy ? `This repository has its own App setup (App ${legacy.appId}); linking an account App replaces it.` : ''}
        </p>
      )}

      <h4 className="mt">Your GitHub Apps</h4>
      {apps.length === 0 && (
        <div className="empty small">
          No Apps registered yet. <a onClick={() => setView('accounts')}>Register one in Account → Settings → Credentials & Apps</a>.
        </div>
      )}
      <div className="app-list">
        {apps.map((a) => (
          <div key={a.id} className={`app-card ${linked?.id === a.id ? 'open' : ''}`}>
            <div className="app-card-head">
              <span className="app-logo">{a.name[0]?.toUpperCase()}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <strong>{a.name}</strong> <span className="badge">App {a.appId}</span>
                <div className="small muted">
                  by {a.owner} · {Object.keys(a.permissions).length} permission(s)
                </div>
              </div>
              {linked?.id === a.id ? (
                <span className="badge ok">linked</span>
              ) : (
                <button
                  className="btn sm primary"
                  disabled={busy || !a.hasKey}
                  onClick={() =>
                    void run(() => call('gh:adminLinkApp', { repoId, registryId: a.id })).then((r) => {
                      if (r) reload();
                    })
                  }
                >
                  Link to this repository
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="small muted mt">Linking stores only a reference. The private key stays encrypted once, in your account’s App registry.</div>
    </div>
  );
}
