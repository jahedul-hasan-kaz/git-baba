import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiAuthInput } from '../../../shared/github';
import type { AccountCredentialInput, KeyHandleInfo } from '../../../shared/types';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';
import { AccountCredentialFields } from '../AccountCredentialFields';

type Method = ApiAuthInput['method'];

interface Props {
  repoId: string;
  /** What the credential is used for, e.g. "run this workflow". */
  purpose: string;
  /** What a token needs, shown as a hint. */
  needs: string;
  onChange: (auth: ApiAuthInput | null, summary: string) => void;
  /** Methods to offer (default: all three). Account-wide operations cannot use a GitHub App. */
  methods?: Method[];
}

function mask(v: string): string {
  return v.length <= 8 ? '••••••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

/**
 * Authentication for one sensitive GitHub operation, chosen per operation like a push:
 * re-confirm the signed-in account with its token, a personal access token, or a GitHub App.
 * Secrets stay in this component's state and are sent only with the operation.
 */
export function ApiAuthPicker({ repoId, purpose, needs, onChange, methods }: Props) {
  const { activeAccount, accounts, repos } = useApp();
  const repo = repos.find((r) => r.id === repoId);
  const account = accounts?.accounts.find((a) => a.id === activeAccount?.id) ?? null;
  const [credential, setCredential] = useState<AccountCredentialInput | null>(null);
  const onCred = useCallback((c: AccountCredentialInput | null) => setCredential(c), []);
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [appId, setAppId] = useState(repo?.settings.githubApp?.appId ?? '');
  const [installationId, setInstallationId] = useState(repo?.settings.githubApp?.installationId ?? '');
  const savedKey = !!repo?.settings.allowSavedCredentials && !!repo?.savedSecrets?.githubAppKey;
  const [keyMode, setKeyMode] = useState<'file' | 'paste' | 'saved'>(savedKey ? 'saved' : 'file');
  // Preselect what Security & access configured: the linked GitHub App with its saved key, else the signed-in account.
  const appPreset = !!repo?.settings.githubApp && savedKey && (!methods || methods.includes('github-app'));
  const [method, setMethod] = useState<Method>(appPreset ? 'github-app' : account ? 'session' : 'pat');
  const [keyInfo, setKeyInfo] = useState<KeyHandleInfo | null>(null);
  const [pem, setPem] = useState('');
  const keyRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (keyRef.current) void call('github:discardKey', { handle: keyRef.current }).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (method === 'session') onChange(credential ? { method: 'session', credential } : null, account ? `GitHub account ${account.login} (token re-verified)` : '');
    else if (method === 'pat') onChange(token.trim() ? { method: 'pat', token: token.trim() } : null, token.trim() ? `Personal access token ${mask(token.trim())}` : '');
    else {
      const key = keyMode === 'saved' && savedKey ? { useSavedKey: true } : keyMode === 'file' && keyInfo ? { keyHandle: keyInfo.handle } : keyMode === 'paste' && pem.includes('PRIVATE KEY') ? { privateKey: pem } : null;
      onChange(/^\d+$/.test(appId) && key ? { method: 'github-app', appId, installationId: installationId || undefined, ...key } : null, `GitHub App ${appId} installation token (revoked after use)`);
    }
  }, [method, credential, token, appId, installationId, keyMode, keyInfo, pem, savedKey, account, onChange]);

  const loadKey = async () => {
    const k = await call('github:loadKeyFile').catch(() => null);
    if (k) {
      keyRef.current = k.handle;
      setKeyInfo(k);
    }
  };

  const allOpts: [Method, string, string][] = [
    ['session', account ? `Signed-in account (${account.login})` : 'Signed-in account', 'Re-enter (or use the remembered) token of the account to confirm it is you.'],
    ['pat', 'Personal access token', `A token with ${needs}.`],
    ['github-app', 'GitHub App', 'A short-lived installation token for this repository only, revoked right after.'],
  ];
  const opts = allOpts.filter(([id]) => !methods || methods.includes(id));

  return (
    <div className="api-auth">
      <div className="api-auth-opts" style={{ gridTemplateColumns: `repeat(${opts.length}, 1fr)` }}>
        {opts.map(([id, label, desc]) => (
          <label key={id} className={`radio-card ${method === id ? 'selected' : ''} ${id === 'session' && !account ? 'disabled' : ''}`}>
            <input type="radio" checked={method === id} onChange={() => setMethod(id)} disabled={id === 'session' && !account} />
            <div>
              <strong>{label}</strong>
              <div className="small muted">{desc}</div>
            </div>
          </label>
        ))}
      </div>
      {appPreset && method === 'github-app' && <p className="small auth-preset-note">✓ Preselected from this repository’s Security &amp; access settings</p>}
      <div className="auth-panel">
        {method === 'session' && account && <AccountCredentialFields key={account.id} account={account} encryptionAvailable={!!accounts?.encryptionAvailable} purpose={purpose} onChange={onCred} />}
        {method === 'pat' && (
          <div className="field">
            <label>
              Personal access token <span className="req">*</span>
            </label>
            <div className="row">
              <input className="grow mono" type={show ? 'text' : 'password'} value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… or github_pat_…" autoComplete="off" spellCheck={false} />
              <button type="button" className="btn sm ghost" onClick={() => setShow((s) => !s)}>
                {show ? '🙈' : '👁'}
              </button>
            </div>
            <div className="hint">Needs {needs}. Used for this operation only, never stored.</div>
          </div>
        )}
        {method === 'github-app' && (
          <>
            <div className="grid-2">
              <div className="field">
                <label>
                  App ID <span className="req">*</span>
                </label>
                <input value={appId} onChange={(e) => setAppId(e.target.value.trim())} placeholder="123456" spellCheck={false} />
              </div>
              <div className="field">
                <label>Installation ID (optional)</label>
                <input value={installationId} onChange={(e) => setInstallationId(e.target.value.trim())} placeholder="auto-detect" spellCheck={false} />
              </div>
            </div>
            <div className="row mb">
              {savedKey && (
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
            {keyMode === 'file' && (
              <div className="row">
                <button className="btn" onClick={() => void loadKey()}>
                  Choose .pem file…
                </button>
                <span className="small muted">{keyInfo ? `${keyInfo.fileName} · ${keyInfo.fingerprint.slice(0, 20)}…` : 'Read once, kept in memory only.'}</span>
              </div>
            )}
            {keyMode === 'paste' && <textarea className="code" rows={4} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN RSA PRIVATE KEY-----" spellCheck={false} autoComplete="off" />}
          </>
        )}
      </div>
    </div>
  );
}
