import { useEffect, useRef, useState } from 'react';
import type { FriendlyError, KeyHandleInfo, RepoSummary } from '../../shared/types';
import { ErrorPanel } from '../components/ErrorPanel';
import { Modal } from '../components/Modal';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';

/**
 * Links a GitHub App to one repository. App ID, owner, repository and installation are
 * remembered so later push/fetch/PR dialogs only need the private key (or the saved key).
 */
export function GitHubAppSetupDialog({ repo, onClose }: { repo: RepoSummary; onClose: () => void }) {
  const { info, bump, toast } = useApp();
  const existing = repo.settings.githubApp;
  const [appId, setAppId] = useState(existing?.appId ?? '');
  const [installationId, setInstallationId] = useState(existing?.installationId ?? '');
  const [keyMode, setKeyMode] = useState<'none' | 'file' | 'paste'>('file');
  const [keyInfo, setKeyInfo] = useState<KeyHandleInfo | null>(null);
  const [pem, setPem] = useState('');
  const [validate, setValidate] = useState(true);
  const [saveKey, setSaveKey] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ appName?: string; installationId?: string; permissions?: Record<string, string> } | null>(null);
  const keyHandleRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (keyHandleRef.current) void call('github:discardKey', { handle: keyHandleRef.current }).catch(() => undefined);
    },
    [],
  );

  const hasKey = (keyMode === 'file' && !!keyInfo) || (keyMode === 'paste' && pem.includes('PRIVATE KEY'));

  const loadKey = async () => {
    try {
      const k = await call('github:loadKeyFile');
      if (k) {
        if (keyHandleRef.current) void call('github:discardKey', { handle: keyHandleRef.current }).catch(() => undefined);
        keyHandleRef.current = k.handle;
        setKeyInfo(k);
      }
    } catch (err) {
      setError(toFriendly(err));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await call('repo:setupGitHubApp', {
        repoId: repo.id,
        appId,
        installationId: installationId || undefined,
        keyHandle: keyMode === 'file' ? keyInfo?.handle : undefined,
        privateKey: keyMode === 'paste' ? pem : undefined,
        validate: hasKey && validate,
        saveKey: hasKey && saveKey,
      });
      keyHandleRef.current = null; // consumed by the main process
      setPem('');
      setResult(res);
      bump();
      toast('GitHub App linked to this repository');
    } catch (err) {
      setError(toFriendly(err));
      // A loaded key is single-use; ask for it again.
      keyHandleRef.current = null;
      setKeyInfo(null);
    } finally {
      setBusy(false);
    }
  };

  if (!repo.github) {
    return (
      <Modal title="Set up GitHub App" onClose={onClose} size="narrow" footer={<button className="btn" onClick={onClose}>Close</button>}>
        <div className="banner warn">
          <span className="icon">⚠</span>
          <div>This repository does not have a GitHub remote. Add one in Settings → Remotes first.</div>
        </div>
      </Modal>
    );
  }

  if (result) {
    return (
      <Modal title="GitHub App Linked" icon="✓" onClose={onClose} size="narrow" footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <div className="banner ok">
          <span className="icon">✓</span>
          <div>
            <strong>
              App {appId} is linked to {repo.github.owner}/{repo.github.repo}.
            </strong>
            {result.appName && <div>Authenticated as “{result.appName}”.</div>}
            {result.installationId && <div>Installation {result.installationId} found.</div>}
            {result.permissions && (
              <div className="small">
                Permissions:{' '}
                {Object.entries(result.permissions)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ')}
              </div>
            )}
          </div>
        </div>
        {result.permissions && result.permissions.contents !== 'write' && (
          <div className="banner warn small">
            <span className="icon">⚠</span>
            <div>The installation does not grant “Contents: write”, so pushes with the App will be rejected. Update the App's permissions on GitHub.</div>
          </div>
        )}
        <p className="small muted">Push, fetch and pull-request dialogs will now pre-select the GitHub App and only ask for the private key{saveKey ? ' (or use the saved one)' : ''}.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Set up GitHub App for this repository"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Not now
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !/^\d+$/.test(appId.trim())}>
            {busy ? 'Saving…' : hasKey && validate ? 'Validate & Save' : 'Save'}
          </button>
        </>
      }
    >
      <p>
        Link a GitHub App to <strong>{repo.name}</strong> once, so you don't have to enter the App ID, owner and repository for every push. The private key is never stored unless you choose to save it
        encrypted.
      </p>
      {error && <ErrorPanel error={error} />}
      <div className="grid-2">
        <div className="field">
          <label>Owner</label>
          <input value={repo.github.owner} disabled />
          <span className="hint">From the remote URL — credentials stay tied to this repository.</span>
        </div>
        <div className="field">
          <label>Repository</label>
          <input value={repo.github.repo} disabled />
        </div>
        <div className="field">
          <label>GitHub App ID</label>
          <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="123456" autoFocus spellCheck={false} />
        </div>
        <div className="field">
          <label>Installation ID (optional)</label>
          <input value={installationId} onChange={(e) => setInstallationId(e.target.value)} placeholder="detected when validating" spellCheck={false} />
        </div>
      </div>

      <div className="field">
        <label>Private key (optional — to validate now and/or save it)</label>
        <div className="row">
          <button className={`btn sm ${keyMode === 'file' ? 'primary' : ''}`} onClick={() => setKeyMode('file')}>
            Load .pem file
          </button>
          <button className={`btn sm ${keyMode === 'paste' ? 'primary' : ''}`} onClick={() => setKeyMode('paste')}>
            Paste key
          </button>
          <button className={`btn sm ${keyMode === 'none' ? 'primary' : ''}`} onClick={() => setKeyMode('none')}>
            Skip
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
              {keyInfo.fileName} · <span className="mono">{keyInfo.fingerprint}</span>
            </span>
          ) : (
            <span className="small muted">Held in memory only.</span>
          )}
        </div>
      )}
      {keyMode === 'paste' && <textarea className="code mb" rows={5} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN RSA PRIVATE KEY-----" spellCheck={false} autoComplete="off" />}
      {hasKey && (
        <>
          <label className="check">
            <input type="checkbox" checked={validate} onChange={(e) => setValidate(e.target.checked)} />
            <span>Validate with GitHub now (checks the key, finds the installation and its permissions)</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={saveKey} disabled={!info?.encryptionAvailable} onChange={(e) => setSaveKey(e.target.checked)} />
            <span>
              Save the private key encrypted for this repository only{' '}
              <span className="muted small">
                {info?.encryptionAvailable ? '— dialogs can then use it without loading the file; you still confirm every push' : '(unavailable: no OS keychain)'}
              </span>
            </span>
          </label>
        </>
      )}
    </Modal>
  );
}
