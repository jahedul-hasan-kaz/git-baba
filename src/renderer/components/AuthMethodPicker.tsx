import { useCallback, useEffect, useRef, useState } from 'react';
import type { TokenPermissionPreset } from '../../shared/api';
import type { AuthInput, AuthMethod, AuthOption, GeneratedTokenInfo, GitHubAppConfig, KeyHandleInfo, SavedSshKey, SshKeyInput } from '../../shared/types';
import { call } from '../services/api';
import { useApp } from '../state/AppState';
import { SshKeyFields } from './SshKeyFields';
import { remoteAuthDefault, type DefaultSource } from '../../shared/authDefaults';

export interface AuthSelection {
  input: AuthInput | null;
  /** Human description of the credential, without the secret. */
  summary: string;
}

interface Props {
  options: AuthOption[];
  githubApp?: GitHubAppConfig;
  /** owner/repo of the remote, used to prefill and to explain isolation. */
  remoteOwnerRepo?: { owner: string; repo: string } | null;
  canSave: boolean;
  savedSshKey?: SavedSshKey | null;
  /** Repository the operation is for (enables the saved App key for instant token generation). */
  repoId?: string;
  purpose: 'push' | 'fetch' | 'pr' | 'clone';
  onChange: (sel: AuthSelection) => void;
  /** "Merge as …" row with segmented buttons (same look as the pull-request merge), instead of the method tree. */
  asLabel?: string;
  /** GitHub login shown on the account-token button in the `asLabel` row. */
  account?: string | null;
}

const SOURCE_NOTE: Partial<Record<DefaultSource, string>> = {
  'github-app': 'Preselected: the GitHub App linked to this repository',
  'repo-setting': 'Preselected from this repository’s Security & access settings',
  remembered: 'Preselected: already set up for this repository',
};

const AS_VERB: Record<Props['purpose'], string> = { push: 'Push as', fetch: 'Sign in as', pr: 'Create as', clone: 'Clone as' };
const AS_ICON: Record<AuthMethod, string> = { pat: '👤', 'github-app': '🤖', ssh: '🔑', system: '💻', none: '○' };

const PRESET: Record<Props['purpose'], TokenPermissionPreset> = {
  push: 'contents-write',
  fetch: 'contents-read',
  clone: 'contents-read',
  pr: 'pull-requests-write',
};

function mask(v: string): string {
  if (!v) return '';
  return v.length <= 8 ? '••••••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

/**
 * Lets the user choose and fill in the authentication method for ONE operation.
 * Only methods applicable to the repository are listed. Secrets live in local
 * component state only and disappear when the dialog closes.
 */
export function AuthMethodPicker({ options, githubApp, remoteOwnerRepo, canSave, savedSshKey = null, repoId, purpose, onChange, asLabel, account: accountProp }: Props) {
  const { showError, toast, activeAccount, session, repos } = useApp();
  // Default to the account the repository belongs to.
  const account = accountProp !== undefined ? accountProp : (repos.find((r) => r.id === repoId)?.account?.login ?? null);
  // The repository's account is the active one and signed in: git can use that sign-in directly
  // (instead of whatever Git Credential Manager has cached for github.com).
  const accountReady = !!account && !!activeAccount && activeAccount.login.toLowerCase() === account.toLowerCase() && (!!session?.active || activeAccount.remembered) && options.some((o) => o.method === 'pat');
  // Preselect what the repository is configured for (GitHub App > repository setting > already set up > Git identity).
  const repoRecord = repos.find((r) => r.id === repoId);
  const preset = remoteAuthDefault({
    available: options.map((o) => o.method),
    githubAppLinked: !!githubApp,
    preference: repoRecord?.settings.remoteAuth,
    sshKeyRemembered: !!savedSshKey,
    patSaved: !!options.find((o) => o.method === 'pat')?.hasSaved,
  });
  const [method, setMethod] = useState<AuthMethod | null>(preset.method);
  const [useAcct, setUseAcct] = useState(true);
  // SSH
  const [ssh, setSsh] = useState<{ input: SshKeyInput | null; summary: string }>({ input: null, summary: '' });
  const onSsh = useCallback((input: SshKeyInput | null, summary: string) => setSsh({ input, summary }), []);
  // PAT
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [useSavedPat, setUseSavedPat] = useState(() => !!options.find((o) => o.method === 'pat')?.hasSaved);
  const [savePat, setSavePat] = useState(false);
  // GitHub App
  const [editingApp, setEditingApp] = useState(!githubApp);
  const [appId, setAppId] = useState(githubApp?.appId ?? '');
  const [owner, setOwner] = useState(githubApp?.owner ?? remoteOwnerRepo?.owner ?? '');
  const [repo, setRepo] = useState(githubApp?.repo ?? remoteOwnerRepo?.repo ?? '');
  const [installationId, setInstallationId] = useState(githubApp?.installationId ?? '');
  const [rememberApp, setRememberApp] = useState(true);
  const [tokenMode, setTokenMode] = useState<'generate' | 'existing'>('generate');
  const [existingToken, setExistingToken] = useState('');
  const [generated, setGenerated] = useState<GeneratedTokenInfo | null>(null);
  const [generating, setGenerating] = useState(false);
  const savedKeyAvailable = !!options.find((o) => o.method === 'github-app')?.hasSaved;
  const [keyMode, setKeyMode] = useState<'file' | 'paste' | 'saved'>(savedKeyAvailable ? 'saved' : 'file');
  const [pem, setPem] = useState('');
  const [keyInfo, setKeyInfo] = useState<KeyHandleInfo | null>(null);
  const [saveKey, setSaveKey] = useState(false);
  const keyHandleRef = useRef<string | null>(null);
  const tokenHandleRef = useRef<string | null>(null);

  // Drop unused secrets from main-process memory when the picker goes away.
  useEffect(
    () => () => {
      if (keyHandleRef.current) void call('github:discardKey', { handle: keyHandleRef.current }).catch(() => undefined);
      if (tokenHandleRef.current) void call('github:discardToken', { handle: tokenHandleRef.current }).catch(() => undefined);
    },
    [],
  );

  const appChanged = !githubApp || githubApp.appId !== appId.trim() || githubApp.owner !== owner.trim() || githubApp.repo !== repo.trim();
  const appBase = { method: 'github-app' as const, appId: appId.trim(), owner: owner.trim(), repo: repo.trim(), installationId: installationId.trim() || undefined };
  const keyFields = keyMode === 'saved' ? { useSavedKey: true } : keyMode === 'file' && keyInfo ? { keyHandle: keyInfo.handle } : keyMode === 'paste' && pem.includes('PRIVATE KEY') ? { privateKey: pem } : null;

  useEffect(() => {
    let sel: AuthSelection = { input: null, summary: '' };
    switch (method) {
      case 'ssh':
        if (ssh.input) sel = { input: { method: 'ssh', ...ssh.input }, summary: ssh.summary };
        break;
      case 'pat':
        if (accountReady && useAcct) sel = { input: { method: 'pat', useAccount: true }, summary: `GitHub account ${account} (signed in)` };
        else if (useSavedPat) sel = { input: { method: 'pat', useSaved: true, username: username || undefined }, summary: 'Saved personal access token (encrypted on this computer)' };
        else if (token.trim())
          sel = {
            input: { method: 'pat', token: token.trim(), username: username.trim() || undefined, saveForRepo: savePat },
            summary: `Personal access token ${mask(token.trim())}${username ? ` as ${username}` : ''}`,
          };
        break;
      case 'github-app': {
        if (tokenMode === 'existing') {
          if (generated) sel = { input: { method: 'github-app', tokenMode, tokenHandle: generated.handle, appId: '', owner: '', repo: '' }, summary: `Installation token ${generated.maskedToken} (generated now)` };
          else if (existingToken.trim()) sel = { input: { method: 'github-app', tokenMode, existingToken: existingToken.trim(), appId: '', owner: '', repo: '' }, summary: `Installation token ${mask(existingToken.trim())}` };
          break;
        }
        if (appBase.appId && appBase.owner && appBase.repo && keyFields) {
          sel = {
            input: { ...appBase, tokenMode, ...keyFields, saveKeyForRepo: keyMode === 'paste' && saveKey, rememberApp: appChanged && rememberApp },
            summary: `GitHub App ${appBase.appId} → new installation token for ${appBase.owner}/${appBase.repo} (revoked after use)`,
          };
        }
        break;
      }
      case 'system':
        sel = { input: { method: 'system' }, summary: 'Git identity only — your existing Git setup (no credentials entered here)' };
        break;
      case 'none':
        sel = { input: { method: 'none' }, summary: 'None (local remote)' };
        break;
    }
    onChange(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountReady, useAcct, account, method, ssh, username, token, useSavedPat, savePat, appId, owner, repo, installationId, keyMode, pem, keyInfo, saveKey, rememberApp, tokenMode, existingToken, generated, onChange]);

  const loadKey = async () => {
    try {
      const info = await call('github:loadKeyFile');
      if (info) {
        if (keyHandleRef.current) void call('github:discardKey', { handle: keyHandleRef.current }).catch(() => undefined);
        keyHandleRef.current = info.handle;
        setKeyInfo(info);
      }
    } catch (err) {
      showError(err);
    }
  };

  const generateNow = async () => {
    if (!keyFields) return;
    setGenerating(true);
    try {
      if (tokenHandleRef.current) await call('github:discardToken', { handle: tokenHandleRef.current }).catch(() => undefined);
      const t = await call('github:generateToken', {
        appId: appBase.appId,
        owner: appBase.owner,
        repo: appBase.repo,
        installationId: appBase.installationId,
        preset: PRESET[purpose],
        clearAfterSeconds: 600,
        repoId,
        ...keyFields,
      });
      tokenHandleRef.current = t.handle;
      setGenerated(t);
      if (t.installationId) setInstallationId(t.installationId);
      toast('Installation token generated. It is used for this operation and revoked automatically within 10 minutes.', 'info');
    } catch (err) {
      showError(err);
    } finally {
      setGenerating(false);
    }
  };

  const copyGenerated = async () => {
    if (!generated) return;
    try {
      await call('github:copyToken', { handle: generated.handle, clearClipboardAfterSeconds: 30 });
      toast('Token copied. The clipboard is cleared in 30 seconds.');
    } catch (err) {
      showError(err);
    }
  };

  if (options.length === 0) {
    return <div className="banner warn">No authentication method is applicable to this repository's remote.</div>;
  }

  const current = options.find((o) => o.method === method);
  const patOption = options.find((o) => o.method === 'pat');

  const appFields = (
    <>
      {githubApp && !editingApp ? (
        <div className="row mb">
          <span className="small grow">
            <span className="badge ok">saved for this repo</span> App <strong>{githubApp.appId}</strong> ·{' '}
            <strong>
              {githubApp.owner}/{githubApp.repo}
            </strong>
            {githubApp.installationId && <span className="muted"> · installation {githubApp.installationId}</span>}
          </span>
          <button className="btn sm ghost" onClick={() => setEditingApp(true)}>
            Edit
          </button>
        </div>
      ) : (
        <>
          <div className="grid-2">
            <div className="field">
              <label>GitHub App ID</label>
              <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="123456" spellCheck={false} />
            </div>
            <div className="field">
              <label>Installation ID (optional)</label>
              <input value={installationId} onChange={(e) => setInstallationId(e.target.value)} placeholder="auto-detect" spellCheck={false} />
            </div>
            <div className="field">
              <label>Owner</label>
              <input value={owner} onChange={(e) => setOwner(e.target.value)} spellCheck={false} />
            </div>
            <div className="field">
              <label>Repository</label>
              <input value={repo} onChange={(e) => setRepo(e.target.value)} spellCheck={false} />
            </div>
          </div>
          {repoId && appChanged && (
            <label className="check small">
              <input type="checkbox" checked={rememberApp} onChange={(e) => setRememberApp(e.target.checked)} />
              <span>Remember App ID, owner and repository for this repository (not the key)</span>
            </label>
          )}
        </>
      )}
      <div className="field">
        <label>Private key</label>
        <div className="row">
          {savedKeyAvailable && (
            <button className={`btn sm ${keyMode === 'saved' ? 'primary' : ''}`} onClick={() => setKeyMode('saved')}>
              Use saved key
            </button>
          )}
          <button className={`btn sm ${keyMode === 'file' ? 'primary' : ''}`} onClick={() => setKeyMode('file')}>
            Load .pem file
          </button>
          <button className={`btn sm ${keyMode === 'paste' ? 'primary' : ''}`} onClick={() => setKeyMode('paste')}>
            Paste key
          </button>
        </div>
      </div>
      {keyMode === 'file' && (
        <div className="row mb">
          <button className="btn" onClick={loadKey}>
            Choose .pem file…
          </button>
          {keyInfo ? (
            <span className="small">
              {keyInfo.fileName} · <span className="mono">{keyInfo.fingerprint.slice(0, 24)}…</span>
            </span>
          ) : (
            <span className="small muted">Read by the app and kept in memory only (max 15 minutes).</span>
          )}
        </div>
      )}
      {keyMode === 'paste' && (
        <>
          <textarea className="code" rows={4} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN RSA PRIVATE KEY-----" spellCheck={false} autoComplete="off" />
          {canSave && (
            <label className="check small">
              <input type="checkbox" checked={saveKey} onChange={(e) => setSaveKey(e.target.checked)} />
              <span>Save this private key encrypted for this repository only</span>
            </label>
          )}
        </>
      )}
    </>
  );

  return (
    <div>
      <div className="mg-as mb">
        <span className="small muted">{asLabel ?? AS_VERB[purpose]}</span>
        <div className="segmented">
          {options.map((o) => (
            <button key={o.method} className={method === o.method ? 'on' : ''} onClick={() => setMethod(o.method)} title={o.description}>
              {AS_ICON[o.method]} {o.method === 'pat' && account ? account : o.method === 'github-app' ? 'GitHub App' : o.label}
              {(o.hasSaved || (o.method === 'ssh' && savedSshKey) || (o.method === 'github-app' && githubApp)) && <span className="as-dot" title="Saved for this repository" />}
            </button>
          ))}
        </div>
      </div>
      {method === preset.method && SOURCE_NOTE[preset.source] && <p className="small auth-preset-note">✓ {SOURCE_NOTE[preset.source]}</p>}
      {current && method !== 'ssh' && <p className="small muted auth-as-desc">{current.description}</p>}
      {current?.viaHttps && (
        <div className="banner info small">
          <span className="icon">ℹ</span>
          <div>
            This remote uses SSH. With a token, this one operation goes over HTTPS to <span className="mono">{current.viaHttps}</span>. Your remote URL is not changed.
          </div>
        </div>
      )}

      {method === 'ssh' && (
        <>
          {current?.viaSsh && (
            <div className="banner info small">
              <span className="icon">ℹ</span>
              <div>
                This remote uses HTTPS. With SSH, this one operation goes to <span className="mono">{current.viaSsh}</span>. Your remote URL is not changed.
              </div>
            </div>
          )}
          <SshKeyFields savedKey={savedSshKey} onChange={onSsh} />
        </>
      )}

      {method === 'pat' && (
        <div className="auth-form">
          {accountReady && (
            <label className="check">
              <input type="checkbox" checked={useAcct} onChange={(e) => setUseAcct(e.target.checked)} />
              <span>
                Use <strong>{account}</strong>’s sign-in <span className="muted small">(recommended — no token to paste, and not the login Windows Credential Manager has cached)</span>
              </span>
            </label>
          )}
          {!(accountReady && useAcct) && patOption?.hasSaved && (
            <label className="check">
              <input type="checkbox" checked={useSavedPat} onChange={(e) => setUseSavedPat(e.target.checked)} />
              <span>Use the token saved for this repository</span>
            </label>
          )}
          {!(accountReady && useAcct) && !useSavedPat && (
            <>
              <div className="grid-2">
                <div className="field">
                  <label>Username</label>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="x-access-token (GitHub default)" autoComplete="off" spellCheck={false} />
                </div>
                <div className="field">
                  <label>Personal access token</label>
                  <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… or github_pat_…" autoComplete="off" spellCheck={false} />
                </div>
              </div>
              {canSave && (
                <label className="check small">
                  <input type="checkbox" checked={savePat} onChange={(e) => setSavePat(e.target.checked)} />
                  <span>Save this token encrypted for this repository only (you will still confirm every operation)</span>
                </label>
              )}
            </>
          )}
        </div>
      )}

      {method === 'github-app' && (
        <div className="auth-form">
          <label className={`radio-card ${tokenMode === 'generate' ? 'selected' : ''}`}>
            <input type="radio" checked={tokenMode === 'generate'} onChange={() => setTokenMode('generate')} />
            <div>
              <strong>Generate a token for this operation (recommended)</strong>
              <div className="small muted">Created from your GitHub App, limited to this repository and the minimum permission, used directly by Git and revoked right afterwards.</div>
            </div>
          </label>
          <label className={`radio-card ${tokenMode === 'existing' ? 'selected' : ''}`}>
            <input type="radio" checked={tokenMode === 'existing'} onChange={() => setTokenMode('existing')} />
            <div>
              <strong>Use an installation token</strong>
              <div className="small muted">Paste a token you already have, or generate one now and review it before continuing.</div>
            </div>
          </label>

          {tokenMode === 'generate' && <div className="mt">{appFields}</div>}

          {tokenMode === 'existing' && (
            <div className="mt">
              {generated ? (
                <div className="card" style={{ marginBottom: 8 }}>
                  <div className="row">
                    <span className="token-box grow">{generated.maskedToken}</span>
                    <button className="btn sm" onClick={copyGenerated}>
                      Copy
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        if (tokenHandleRef.current) void call('github:discardToken', { handle: tokenHandleRef.current }).catch(() => undefined);
                        tokenHandleRef.current = null;
                        setGenerated(null);
                      }}
                    >
                      Discard
                    </button>
                  </div>
                  <div className="small muted mt">
                    {Object.entries(generated.permissions)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', ')}{' '}
                    · {generated.repositories.join(', ')} · auto-revoked {new Date(generated.clearsAt).toLocaleTimeString()}
                  </div>
                </div>
              ) : (
                <>
                  <div className="field">
                    <label>Installation token</label>
                    <input type="password" value={existingToken} onChange={(e) => setExistingToken(e.target.value)} placeholder="ghs_…" autoComplete="off" spellCheck={false} />
                  </div>
                  <details>
                    <summary className="small" style={{ cursor: 'pointer' }}>
                      Don't have one? Generate it now from your GitHub App
                    </summary>
                    <div className="mt">
                      {appFields}
                      <button className="btn primary" onClick={generateNow} disabled={generating || !keyFields || !appBase.appId || !appBase.owner || !appBase.repo}>
                        {generating ? 'Generating…' : 'Generate token now'}
                      </button>
                    </div>
                  </details>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {method === 'system' && (
        <div className="auth-form small">
          Git pushes exactly as it would from your terminal: an SSH remote uses your ssh-agent or default <code>~/.ssh</code> keys, an HTTPS remote uses Git Credential Manager. No
          credentials are entered here. If that setup needs a passphrase that is not loaded in ssh-agent, choose <strong>SSH</strong> instead.
        </div>
      )}
    </div>
  );
}
