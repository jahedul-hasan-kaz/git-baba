import { useEffect, useState } from 'react';
import type { RepoSettingsPatch } from '../../shared/api';
import type { RemoteInfo } from '../../shared/types';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useAsync } from '../hooks/useAsync';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

import { Select } from '../components/Select';
export function RepoSettingsPage() {
  const { activeRepo, revision, bump, showError, toast, selectRepo, info, requestAppSetup, accounts } = useApp();
  const repo = activeRepo!;
  const repoId = repo.id;
  const identity = useAsync(() => (repo.exists ? call('git:identity', { repoId }) : Promise.resolve(null)), [repoId, revision]);
  const remotes = useAsync(() => (repo.exists ? call('git:remotes', { repoId }) : Promise.resolve([] as RemoteInfo[])), [repoId, revision]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [remoteName, setRemoteName] = useState('origin');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [confirm, setConfirm] = useState<'remove-repo' | { remote: string } | null>(null);

  useEffect(() => {
    setName(identity.data?.name ?? '');
    setEmail(identity.data?.email ?? '');
  }, [identity.data]);
  useEffect(() => {
    setApiBaseUrl(repo.settings.apiBaseUrl ?? '');
  }, [repo.settings]);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast(success);
    } catch (err) {
      showError(err);
    }
    bump();
  };

  const update = (settings: RepoSettingsPatch, msg = 'Settings saved') =>
    act(() => call('repo:updateSettings', { repoId, settings }), msg);

  return (
    <div className="page">
      {repo.exists && (
        <>
          <div className="card">
            <h3>GitHub account</h3>
            <p className="small muted">The app-level account used for this repository's GitHub operations (pull requests, token checks). It does not change the repository's remote or Git credentials.</p>
            <div className="row mb">
              <Select kind="account"
                value={repo.settings.accountId ?? ''}
                onChange={(e) => act(() => call('repo:setAccount', { repoId, accountId: e.target.value || null }), 'Repository account updated')}
                style={{ maxWidth: 360 }}
              >
                <option value="">{repo.account && !repo.settings.accountId ? `Detected: ${repo.account.login}` : 'None'}</option>
                {accounts?.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.login}
                  </option>
                ))}
              </Select>
              <span className="small muted">{repo.identity ?? 'no GitHub remote'}</span>
            </div>
          </div>

          <div className="card">
            <h3>Git identity (this repository)</h3>
            <div className="grid-2">
              <div className="field">
                <label>Name (user.name)</label>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label>Email (user.email)</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>
            <div className="row">
              <span className="small muted grow">
                Signing: {identity.data?.signingKey ? `${identity.data.gpgFormat ?? 'openpgp'} key configured` : 'not configured'}
                {identity.data?.commitGpgSign ? ' · commit.gpgsign=true' : ''}
              </span>
              <button className="btn" disabled={!name || !email} onClick={() => act(() => call('git:setIdentity', { repoId, name, email }), 'Identity saved')}>
                Save identity
              </button>
            </div>
          </div>

          <div className="card">
            <h3>Remotes</h3>
            <table className="list mb">
              <tbody>
                {(remotes.data ?? []).map((r) => (
                  <tr key={r.name}>
                    <td>
                      <strong>{r.name}</strong>
                    </td>
                    <td className="mono small">{r.pushUrl}</td>
                    <td>
                      <span className="badge">{r.protocol}</span> {r.isGitHub && <span className="badge info">GitHub</span>}
                      {r.hasEmbeddedCredentials && <span className="badge danger">credentials in URL!</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn sm"
                        onClick={() => {
                          setRemoteName(r.name);
                          setRemoteUrl(r.pushUrl.includes('[REDACTED]') ? '' : r.pushUrl);
                        }}
                      >
                        Edit
                      </button>{' '}
                      <button className="btn sm danger" onClick={() => setConfirm({ remote: r.name })}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {remotes.data?.some((r) => r.hasEmbeddedCredentials) && (
              <div className="banner danger small">
                <span className="icon">⚠</span>
                <div>A remote URL contains embedded credentials, stored in plain text in .git/config. Replace it with a URL without credentials.</div>
              </div>
            )}
            <div className="row">
              <input style={{ width: 140 }} value={remoteName} onChange={(e) => setRemoteName(e.target.value)} placeholder="origin" />
              <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" spellCheck={false} />
              <button className="btn primary" disabled={!remoteName || !remoteUrl} onClick={() => act(() => call('git:setRemote', { repoId, name: remoteName, url: remoteUrl }), `Remote ${remoteName} saved`)}>
                Add / update
              </button>
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h3>Safety settings</h3>
        <label className="check">
          <input type="checkbox" checked={repo.settings.runHooks} onChange={(e) => update({ runHooks: e.target.checked })} />
          <div>
            <strong>Run repository Git hooks</strong>
            <div className="small muted">Off by default. Hooks (pre-commit, pre-push, post-checkout…) are scripts from the repository and run with your permissions.</div>
          </div>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={repo.settings.allowSavedCredentials}
            disabled={!info?.encryptionAvailable}
            onChange={(e) => update({ allowSavedCredentials: e.target.checked }, e.target.checked ? 'Saved credentials enabled' : 'Saved credentials disabled and deleted')}
          />
          <div>
            <strong>Allow saving credentials for this repository</strong>
            <div className="small muted">
              {info?.encryptionAvailable
                ? 'Tokens/keys are only saved when you tick "save" in an auth dialog, encrypted with your OS keychain, isolated to this repository, and still require confirmation for every operation. Turning this off deletes them.'
                : 'Unavailable: no OS-level encryption (keychain) was found on this system.'}
            </div>
          </div>
        </label>
        <div className="row mt">
          <span className="small grow">
            Saved now: PAT {repo.savedSecrets.pat ? '✅' : '—'} · GitHub App key {repo.savedSecrets.githubAppKey ? '✅' : '—'}
          </span>
          <button className="btn sm danger" disabled={!repo.savedSecrets.pat && !repo.savedSecrets.githubAppKey} onClick={() => act(() => call('repo:forgetSecrets', { repoId }), 'Saved credentials deleted')}>
            Forget saved credentials
          </button>
        </div>
      </div>

      <div className="card">
        <h3>GitHub App</h3>
        {repo.settings.githubApp ? (
          <div className="row mb">
            <span className="grow">
              <span className="badge ok">linked</span> App <strong>{repo.settings.githubApp.appId}</strong> ·{' '}
              <strong>
                {repo.settings.githubApp.owner}/{repo.settings.githubApp.repo}
              </strong>
              {repo.settings.githubApp.installationId && <span className="muted"> · installation {repo.settings.githubApp.installationId}</span>}
              {repo.savedSecrets.githubAppKey && <span className="badge info" style={{ marginLeft: 6 }}>key saved (encrypted)</span>}
            </span>
          </div>
        ) : (
          <p className="small muted">
            {repo.github
              ? `Not linked. Link your GitHub App to ${repo.github.owner}/${repo.github.repo} so auth dialogs don't ask for the App ID, owner and repository each time.`
              : 'This repository has no GitHub remote.'}
          </p>
        )}
        <div className="row mb">
          <button className="btn primary" disabled={!repo.github} onClick={() => requestAppSetup(repoId)}>
            {repo.settings.githubApp ? 'Change / re-validate…' : 'Set up GitHub App…'}
          </button>
          {repo.settings.githubApp && (
            <button className="btn" onClick={() => update({ githubApp: null }, 'GitHub App unlinked')}>
              Unlink
            </button>
          )}
        </div>
        <div className="field">
          <label>GitHub Enterprise API URL (optional)</label>
          <div className="row">
            <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://github.example.com/api/v3" />
            <button className="btn" onClick={() => update({ apiBaseUrl: apiBaseUrl || null })}>
              Save
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>SSH key</h3>
        {repo.settings.sshKeyPath ? (
          <div className="row">
            <span className="grow small">
              Remembered key file: <span className="mono">{repo.settings.sshKeyPath}</span>
              <div className="muted">Only the path is stored. The passphrase is asked for every operation.</div>
            </span>
            <button className="btn sm" onClick={() => update({ sshKeyPath: null }, 'SSH key path forgotten')}>
              Forget
            </button>
          </div>
        ) : (
          <p className="small muted">No SSH key remembered. In a push or fetch dialog choose SSH, provide your public key, and tick “Remember this key”.</p>
        )}
      </div>

      <div className="card" style={{ borderColor: 'rgba(255,107,107,0.4)' }}>
        <h3>Remove from Git Baba</h3>
        <p className="small muted">Removes the repository from the app and deletes credentials saved for it. Files on disk are not touched.</p>
        <button className="btn danger" onClick={() => setConfirm('remove-repo')}>
          Remove repository from app…
        </button>
      </div>

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
            await act(() => call('git:removeRemote', { repoId, name: confirm.remote, confirmed: true }), `Remote ${confirm.remote} removed`);
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
