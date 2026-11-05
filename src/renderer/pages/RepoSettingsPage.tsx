import { useState } from 'react';
import type { RemoteInfo } from '../../shared/types';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { RemoteChangeDialog } from '../dialogs/RemoteChangeDialog';
import { useAsync } from '../hooks/useAsync';
import { call } from '../services/api';
import { useApp } from '../state/AppState';
import { REMOTE_LABEL, SIGN_LABEL, SOURCE_TEXT } from './repoSettings/RepoAccess';

/**
 * General: an at-a-glance, read-only view of who this repository commits and pushes as, with the remotes
 * (origin changes are checked before they are saved) and removing the repository from the app.
 * Credentials, the GitHub App and signing are chosen under Security & access.
 */
export function RepoSettingsPage({ onManageAccess }: { onManageAccess?: () => void }) {
  const { activeRepo, revision, bump, showError, toast, selectRepo } = useApp();
  const repo = activeRepo!;
  const repoId = repo.id;
  const identity = useAsync(() => (repo.exists ? call('git:identity', { repoId }) : Promise.resolve(null)), [repoId, revision]);
  const remotes = useAsync(() => (repo.exists ? call('git:remotes', { repoId }) : Promise.resolve([] as RemoteInfo[])), [repoId, revision]);
  const access = useAsync(() => (repo.exists ? call('repo:accessOverview', { repoId }) : Promise.resolve(null)), [repoId, revision]);
  const [remoteName, setRemoteName] = useState('origin');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [pendingRemote, setPendingRemote] = useState<{ name: string; url: string } | null>(null);
  const [confirm, setConfirm] = useState<'remove-repo' | { remote: string } | null>(null);

  const copy = (text: string, what: string) =>
    call('app:copyText', { text })
      .then(() => toast(`${what} copied`))
      .catch(showError);

  const id = identity.data;
  const a = access.data;
  const app = repo.settings.githubApp;

  return (
    <div className="page general">
      {repo.exists && (
        <>
          {/* Who you are here */}
          <div className="gen-hero">
            <div className="gen-person">
              <span className="gen-avatar">{(id?.name ?? '?')[0]?.toUpperCase()}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="gen-k">Commits as</div>
                <div className="gen-name">{id?.name ?? <span className="muted">No user.name</span>}</div>
                <button className="gen-mail" onClick={() => id?.email && void copy(id.email, 'Email')} disabled={!id?.email} title="Copy email">
                  {id?.email ?? 'No user.email'} {id?.email && <span className="muted">⧉</span>}
                </button>
              </div>
            </div>
            <div className="gen-facts">
              <Fact k="GitHub account" v={repo.account?.login ?? 'Not linked to an account'} hint={repo.settings.accountId ? 'chosen' : repo.account ? 'detected from the remote' : undefined} />
              <Fact k="Repository" v={repo.identity ?? 'Local only'} />
              <Fact k="Folder" v={repo.path} mono onClick={() => void copy(repo.path, 'Folder path')} />
            </div>
          </div>
          {(!id?.name || !id?.email) && (
            <div className="banner warn small">
              <span className="icon">⚠</span>
              <div>
                Git has no {!id?.name && 'user.name'}
                {!id?.name && !id?.email && ' or '}
                {!id?.email && 'user.email'} for this repository. Set it with <code>git config user.name / user.email</code>, or commit as your GitHub account from the commit dialog.
              </div>
            </div>
          )}

          {/* Security & access, read-only */}
          <div className="card">
            <div className="row mb">
              <h3 className="grow" style={{ margin: 0 }}>
                Security &amp; access
              </h3>
              {onManageAccess && (
                <button className="btn sm" onClick={onManageAccess}>
                  Manage →
                </button>
              )}
            </div>
            {!a ? (
              <div className="small muted">Reading your setup…</div>
            ) : (
              <div className="gen-access">
                <AccessTile icon="⇅" k="Push · pull · merge" v={a.effective.remote.method ? REMOTE_LABEL[a.effective.remote.method] : 'No method available'} s={SOURCE_TEXT[a.effective.remote.source]} onClick={onManageAccess} />
                <AccessTile icon="🤖" k="GitHub App" v={app ? `App ${app.appId}` : 'Not linked'} s={app ? `${app.owner}/${app.repo}` : repo.github ? 'link one under Security & access' : 'not a GitHub repository'} on={!!app} onClick={onManageAccess} />
                <AccessTile icon="✎" k="Commit signing" v={SIGN_LABEL[a.effective.commit.method]} s={SOURCE_TEXT[a.effective.commit.source]} on={a.effective.commit.method !== 'none'} onClick={onManageAccess} />
                <AccessTile
                  icon="🔑"
                  k="Saved here"
                  v={[a.detected.sshKeyPath && 'SSH key', a.detected.patSaved && 'Token', a.detected.githubAppKeySaved && 'App key'].filter(Boolean).join(' · ') || 'Nothing saved'}
                  s={a.detected.credentialHelper ? `git uses ${a.detected.credentialHelper}` : 'no credential helper'}
                  onClick={onManageAccess}
                />
              </div>
            )}
          </div>

          {/* Remotes */}
          <div className="card">
            <div className="row mb">
              <h3 className="grow" style={{ margin: 0 }}>
                Remotes
              </h3>
              {!editing && (
                <button
                  className="btn sm"
                  onClick={() => {
                    setEditing(true);
                    setRemoteName((remotes.data ?? []).some((r) => r.name === 'origin') ? 'upstream' : 'origin');
                    setRemoteUrl('');
                  }}
                >
                  + Add remote
                </button>
              )}
            </div>
            <div className="gen-remotes">
              {(remotes.data ?? []).map((r) => (
                <div key={r.name} className="gen-remote">
                  <span className="gen-remote-ico">{r.isGitHub ? '🐙' : '☁'}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <strong>{r.name}</strong>
                      <span className="badge">{r.protocol}</span>
                      {r.hasEmbeddedCredentials && <span className="badge danger">credentials in URL!</span>}
                    </div>
                    <div className="mono small muted ellipsis" title={r.pushUrl}>
                      {r.pushUrl}
                    </div>
                  </div>
                  <button
                    className="btn sm"
                    onClick={() => {
                      setEditing(true);
                      setRemoteName(r.name);
                      setRemoteUrl(r.pushUrl.includes('[REDACTED]') ? '' : r.pushUrl);
                    }}
                  >
                    Change
                  </button>
                  <button className="btn sm ghost danger-text" onClick={() => setConfirm({ remote: r.name })} title={`Remove ${r.name}`}>
                    ✕
                  </button>
                </div>
              ))}
              {remotes.data?.length === 0 && <div className="empty small">No remotes yet. Add one to push and pull.</div>}
            </div>
            {editing && (
              <div className="gen-remote-edit">
                <input style={{ width: 130 }} value={remoteName} onChange={(e) => setRemoteName(e.target.value)} placeholder="origin" spellCheck={false} />
                <input className="grow" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git" spellCheck={false} autoFocus />
                <button className="btn primary" disabled={!remoteName.trim() || !remoteUrl.trim()} onClick={() => setPendingRemote({ name: remoteName.trim(), url: remoteUrl.trim() })}>
                  {(remotes.data ?? []).some((r) => r.name === remoteName.trim()) ? `Check & change ${remoteName.trim()}` : 'Check & add'}
                </button>
                <button className="btn ghost" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <div className="gen-remove">
        <div className="grow">
          <strong>Remove from Git Baba</strong>
          <div className="small muted">Takes {repo.name} off the sidebar and deletes credentials saved for it. Your files and history stay on disk.</div>
        </div>
        <button className="btn danger" onClick={() => setConfirm('remove-repo')}>
          Remove…
        </button>
      </div>

      {pendingRemote && (
        <RemoteChangeDialog
          repoId={repoId}
          name={pendingRemote.name}
          url={pendingRemote.url}
          onClose={() => setPendingRemote(null)}
          onSaved={() => {
            setPendingRemote(null);
            setEditing(false);
            setRemoteUrl('');
            bump();
          }}
        />
      )}
      {confirm === 'remove-repo' && (
        <ConfirmDialog
          title="Remove Repository from App"
          explanation={
            <>
              Removes <strong>{repo.name}</strong> from the sidebar and deletes any credentials saved for it.
            </>
          }
          impact={<>Your files, commits and the .git folder at {repo.path} are not changed.</>}
          confirmLabel="Remove from app"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await call('repo:remove', { repoId });
              selectRepo(null);
              toast(`${repo.name} removed from the app`, 'info');
            } catch (err) {
              showError(err);
            }
            setConfirm(null);
            bump();
          }}
        />
      )}
      {confirm && typeof confirm === 'object' && (
        <ConfirmDialog
          title="Remove Remote"
          explanation={
            <>
              Removes the remote <strong>{confirm.remote}</strong> and its remote-tracking branches from this repository's configuration.
            </>
          }
          impact="You will not be able to fetch from or push to it until it is added again. Nothing on the server is deleted."
          confirmLabel="Remove remote"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await call('git:removeRemote', { repoId, name: confirm.remote, confirmed: true });
              toast(`Remote ${confirm.remote} removed`);
            } catch (err) {
              showError(err);
            }
            setConfirm(null);
            bump();
          }}
        />
      )}
    </div>
  );
}

function Fact({ k, v, hint, mono, onClick }: { k: string; v: string; hint?: string; mono?: boolean; onClick?: () => void }) {
  return (
    <div className={`gen-fact ${onClick ? 'clickable' : ''}`} onClick={onClick} title={onClick ? 'Click to copy' : undefined}>
      <div className="gen-k">{k}</div>
      <div className={`gen-v ellipsis ${mono ? 'mono' : ''}`} title={v}>
        {v}
      </div>
      {hint && <div className="gen-hint">{hint}</div>}
    </div>
  );
}

function AccessTile({ icon, k, v, s, on, onClick }: { icon: string; k: string; v: string; s: string; on?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={`gen-tile ${on ? 'on' : ''}`} onClick={onClick} disabled={!onClick}>
      <span className="gen-tile-ico">{icon}</span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="gen-k">{k}</span>
        <span className="gen-tile-v ellipsis">{v}</span>
        <span className="gen-hint ellipsis">{s}</span>
      </span>
    </button>
  );
}
