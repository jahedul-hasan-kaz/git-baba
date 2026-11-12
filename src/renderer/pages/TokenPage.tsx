import { useEffect, useRef, useState } from 'react';
import type { TokenPermissionPreset } from '../../shared/api';
import type { RegisteredApp } from '../../shared/github';
import type { FriendlyError, GeneratedTokenInfo, KeyHandleInfo } from '../../shared/types';
import { ErrorPanel } from '../components/ErrorPanel';
import { InstallationTokenList } from '../components/InstallationTokenList';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';

import { Select } from '../components/Select';
const PRESETS: { value: TokenPermissionPreset; label: string; short: string; icon: string }[] = [
  { value: 'contents-read', label: 'Contents: read (clone / fetch)', short: 'Read code', icon: '👁' },
  { value: 'contents-write', label: 'Contents: write (push)', short: 'Push code', icon: '⬆' },
  { value: 'pull-requests-write', label: 'Pull requests: write + Contents: read', short: 'Pull requests', icon: '⇄' },
];

export function TokenPage() {
  const { toast, activeRepo } = useApp();
  const [appId, setAppId] = useState(activeRepo?.settings.githubApp?.appId ?? '');
  const [owner, setOwner] = useState(activeRepo?.settings.githubApp?.owner ?? '');
  const [repo, setRepo] = useState(activeRepo?.settings.githubApp?.repo ?? '');
  const [installationId, setInstallationId] = useState(activeRepo?.settings.githubApp?.installationId ?? '');
  const [apiBaseUrl, setApiBaseUrl] = useState(activeRepo?.settings.apiBaseUrl ?? '');
  const [keyMode, setKeyMode] = useState<'file' | 'paste'>('file');
  const [pem, setPem] = useState('');
  const [keyInfo, setKeyInfo] = useState<KeyHandleInfo | null>(null);
  const [preset, setPreset] = useState<TokenPermissionPreset>('contents-read');
  const [clearAfter, setClearAfter] = useState(120);
  const [validation, setValidation] = useState<string | null>(null);
  const [token, setToken] = useState<GeneratedTokenInfo | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped after generate/revoke so the token list refreshes at once. */
  const [listKey, setListKey] = useState(0);
  const keyHandleRef = useRef<string | null>(null);
  const tokenHandleRef = useRef<string | null>(null);
  const [apps, setApps] = useState<RegisteredApp[] | null>(null);
  const [usingApp, setUsingApp] = useState<string | null>(null);

  useEffect(() => {
    call('gh:appsList')
      .then(setApps)
      .catch(() => setApps([]));
  }, []);

  /** Fills the form from a registered App and loads its saved key (held in memory for 15 minutes). */
  const pickApp = async (a: RegisteredApp) => {
    setError(null);
    setValidation(null);
    setAppId(a.appId);
    setApiBaseUrl(a.apiBase === 'https://api.github.com' ? '' : a.apiBase);
    if (!owner && a.owner) setOwner(a.owner);
    setUsingApp(a.id);
    if (!a.hasKey) {
      setKeyMode('file');
      return;
    }
    try {
      const k = await call('accounts:appKeyHandle', { id: a.id });
      if (keyHandleRef.current) void call('github:discardKey', { handle: keyHandleRef.current });
      keyHandleRef.current = k.handle;
      setKeyMode('file');
      setKeyInfo(k);
    } catch (err) {
      setError(toFriendly(err));
    }
  };

  // Countdown; when it reaches zero the token disappears from the UI (and main-process memory).
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [token]);

  useEffect(() => {
    if (token && now >= new Date(token.clearsAt).getTime()) {
      setToken(null);
      setRevealed(null);
      tokenHandleRef.current = null;
      toast('Token cleared from memory and revoked', 'info');
    }
  }, [now, token, toast]);

  // Leaving the page drops the loaded key and the token.
  useEffect(
    () => () => {
      if (keyHandleRef.current) void call('github:discardKey', { handle: keyHandleRef.current }).catch(() => undefined);
      if (tokenHandleRef.current) void call('github:discardToken', { handle: tokenHandleRef.current }).catch(() => undefined);
    },
    [],
  );

  const keyPayload = () => (keyMode === 'file' ? { keyHandle: keyInfo?.handle } : { privateKey: pem });
  const keyReady = keyMode === 'file' ? !!keyInfo : pem.includes('PRIVATE KEY');

  const loadKey = async () => {
    try {
      const k = await call('github:loadKeyFile');
      if (k) {
        if (keyHandleRef.current) void call('github:discardKey', { handle: keyHandleRef.current });
        keyHandleRef.current = k.handle;
        setKeyInfo(k);
      }
    } catch (err) {
      setError(toFriendly(err));
    }
  };

  const validate = async () => {
    setBusy(true);
    setError(null);
    setValidation(null);
    try {
      const r = await call('github:validateApp', { appId, owner: owner || undefined, repo: repo || undefined, apiBaseUrl: apiBaseUrl || undefined, ...keyPayload() });
      if (r.installationId) setInstallationId(r.installationId);
      setValidation(
        `✓ Authenticated as GitHub App "${r.appName}".` +
          (r.installationId
            ? ` Installed on ${r.installationAccount} (installation ${r.installationId}). Permissions: ${Object.entries(r.permissions ?? {})
                .map(([k, v]) => `${k}:${v}`)
                .join(', ')}`
            : ''),
      );
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tokenHandleRef.current) await call('github:discardToken', { handle: tokenHandleRef.current });
      const t = await call('github:generateToken', {
        appId,
        owner,
        repo,
        installationId: installationId || undefined,
        apiBaseUrl: apiBaseUrl || undefined,
        preset,
        clearAfterSeconds: clearAfter,
        ...keyPayload(),
      });
      tokenHandleRef.current = t.handle;
      setToken(t);
      setListKey((k) => k + 1);
      setRevealed(null);
      setNow(Date.now());
      // The private key is no longer needed: clear it from the form and from memory.
      setPem('');
      if (keyHandleRef.current) void call('github:discardKey', { handle: keyHandleRef.current });
      keyHandleRef.current = null;
      setKeyInfo(null);
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (!token) return;
    try {
      const { token: value } = await call('github:revealToken', { handle: token.handle });
      setRevealed(value);
      setTimeout(() => setRevealed(null), 15_000);
    } catch (err) {
      setError(toFriendly(err));
    }
  };

  const copy = async () => {
    if (!token) return;
    try {
      await call('github:copyToken', { handle: token.handle, clearClipboardAfterSeconds: 30 });
      toast('Token copied. The clipboard is cleared in 30 seconds.');
    } catch (err) {
      setError(toFriendly(err));
    }
  };

  const revoke = async () => {
    if (!token) return;
    try {
      const r = await call('github:revokeToken', { handle: token.handle });
      toast(r.revoked ? 'Token revoked on GitHub' : 'Token removed from memory (revocation request failed)', r.revoked ? 'success' : 'warning');
    } catch (err) {
      setError(toFriendly(err));
    }
    tokenHandleRef.current = null;
    setToken(null);
    setRevealed(null);
    setListKey((k) => k + 1);
  };

  const secondsLeft = token ? Math.max(0, Math.round((new Date(token.clearsAt).getTime() - now) / 1000)) : 0;

  return (
    <div className="content">
      <div className="page ax-tok" style={{ maxWidth: 900 }}>
        <div className="ax-tok-head">
          <div className="ax-tok-ico">🧩</div>
          <div className="grow">
            <h1>GitHub App tokens</h1>
            <div className="small muted">
              A short-lived token (max. 1 hour) that acts as your <strong>GitHub App</strong> on one repository — for scripts, CI or other tools. Push and pull-request dialogs already make
              these for you automatically.
            </div>
          </div>
        </div>
        {error && <ErrorPanel error={error} />}

        <div className="ax-tok-apps">
          <div className="ax-tok-label">Your registered apps</div>
          {apps === null ? (
            <div className="small muted">Loading…</div>
          ) : apps.length === 0 ? (
            <div className="small muted">None yet — enter an App ID below. Register apps once in Account → Settings → Credentials &amp; Apps to reuse their keys here.</div>
          ) : (
            <div className="ax-app-cards">
              {apps.map((a) => (
                <button key={a.id} className={`ax-app-card ${usingApp === a.id ? 'on' : ''}`} onClick={() => void pickApp(a)} title={a.hasKey ? 'Use this app and its saved key' : 'Use this app (load its .pem file next)'}>
                  <span className="ax-app-av">{(a.name || a.slug || '?').slice(0, 1).toUpperCase()}</span>
                  <span className="ax-app-text">
                    <strong>{a.name || a.slug}</strong>
                    <span className="small muted">
                      ID {a.appId}
                      {a.owner ? ` · ${a.owner}` : ''}
                    </span>
                  </span>
                  <span className={`ax-chip ${a.hasKey ? 'ok' : 'muted'}`}>{a.hasKey ? '🔑 key saved' : 'no key'}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card ax-tok-form">
          <section>
            <div className="ax-tok-num">1</div>
            <div className="grow">
              <div className="ax-tok-sec-title">App &amp; private key</div>
              <div className="ax-tok-grid">
                <div className="field">
                  <label>App ID</label>
                  <input
                    value={appId}
                    onChange={(e) => {
                      setAppId(e.target.value);
                      setUsingApp(null);
                    }}
                    placeholder="123456"
                    inputMode="numeric"
                  />
                </div>
                <div className="field">
                  <label>Private key</label>
                  <div className="ax-seg">
                    <button type="button" className={keyMode === 'file' ? 'on' : ''} onClick={() => setKeyMode('file')}>
                      .pem file
                    </button>
                    <button type="button" className={keyMode === 'paste' ? 'on' : ''} onClick={() => setKeyMode('paste')}>
                      Paste
                    </button>
                  </div>
                </div>
              </div>
              {keyMode === 'file' ? (
                <div className="ax-key-row">
                  {keyInfo ? (
                    <span className="ax-key-chip">
                      🔑 {keyInfo.fileName} <span className="mono muted">{keyInfo.fingerprint.slice(0, 23)}…</span>
                    </span>
                  ) : (
                    <span className="small muted">Held in memory only — cleared after 15 minutes or after use. Never written to disk or logs.</span>
                  )}
                  <button className="btn sm" onClick={loadKey}>
                    {keyInfo ? 'Change…' : 'Choose .pem file…'}
                  </button>
                </div>
              ) : (
                <textarea className="code" rows={4} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN RSA PRIVATE KEY-----" spellCheck={false} autoComplete="off" />
              )}
              <details className="ax-tok-adv">
                <summary className="small">GitHub Enterprise Server{apiBaseUrl ? ` · ${apiBaseUrl}` : ''}</summary>
                <div className="field mt">
                  <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://github.example.com/api/v3" />
                </div>
              </details>
            </div>
          </section>

          <section>
            <div className="ax-tok-num">2</div>
            <div className="grow">
              <div className="ax-tok-sec-title">Repository</div>
              <div className="ax-tok-grid three">
                <div className="field">
                  <label>Owner</label>
                  <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="my-company" />
                </div>
                <div className="field">
                  <label>Repository</label>
                  <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="backend" />
                </div>
                <div className="field">
                  <label>Installation ID</label>
                  <input value={installationId} onChange={(e) => setInstallationId(e.target.value)} placeholder="auto-detected" />
                </div>
              </div>
            </div>
          </section>

          <section>
            <div className="ax-tok-num">3</div>
            <div className="grow">
              <div className="ax-tok-sec-title">Access</div>
              <div className="ax-tok-access">
                <div className="ax-seg" role="radiogroup" aria-label="Permissions">
                  {PRESETS.map((p) => (
                    <button key={p.value} type="button" role="radio" aria-checked={preset === p.value} className={preset === p.value ? 'on' : ''} onClick={() => setPreset(p.value)} title={p.label}>
                      {p.icon} {p.short}
                    </button>
                  ))}
                </div>
                <span className="small muted ax-clear">
                  Clear after
                  <Select value={clearAfter} onChange={(e) => setClearAfter(Number(e.target.value))}>
                    {[30, 60, 120, 300, 600].map((s) => (
                      <option key={s} value={s}>
                        {s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? 's' : ''}`}
                      </option>
                    ))}
                  </Select>
                </span>
              </div>
              <div className="small muted">{PRESETS.find((p) => p.value === preset)!.label} — on this repository only.</div>
            </div>
          </section>

          {validation && <div className="banner ok small">{validation}</div>}
          <div className="ax-tok-actions">
            <span className="small muted grow">{!appId ? 'Enter the App ID' : !keyReady ? 'Add the private key' : !owner || !repo ? 'Enter owner and repository' : '✓ Ready'}</span>
            <button className="btn" onClick={validate} disabled={busy || !appId || !keyReady}>
              Check app
            </button>
            <button className="btn primary" onClick={generate} disabled={busy || !appId || !keyReady || !owner || !repo}>
              {busy ? 'Working…' : 'Generate token'}
            </button>
          </div>
        </div>

        {token && (
          <div className="card ax-tok-result">
            <div className="row mb">
              <strong className="grow">Installation token</strong>
              <span className="badge warn">clears in {secondsLeft}s</span>
            </div>
            <div className="token-box mb">{revealed ?? token.maskedToken}</div>
            <dl className="kv mb">
              <dt>Repository</dt>
              <dd>{token.repositories.join(', ')}</dd>
              <dt>Permissions</dt>
              <dd>
                {Object.entries(token.permissions)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ')}
              </dd>
              <dt>GitHub expiry</dt>
              <dd>{new Date(token.expiresAt).toLocaleString()} (revoked earlier when cleared here)</dd>
              <dt>Installation</dt>
              <dd>{token.installationId}</dd>
            </dl>
            <div className="row">
              <button className="btn primary" onClick={copy}>
                Copy token
              </button>
              <button className="btn" onClick={reveal} disabled={!!revealed}>
                {revealed ? 'Visible for 15s' : 'Reveal'}
              </button>
              <span className="spacer" />
              <button className="btn danger" onClick={revoke}>
                Revoke now
              </button>
            </div>
          </div>
        )}

        <InstallationTokenList reloadKey={listKey} />
      </div>
    </div>
  );
}
