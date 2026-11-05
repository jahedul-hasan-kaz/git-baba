import { useEffect, useState } from 'react';
import type { FriendlyError, RemoteChangeCheck } from '../../shared/types';
import { ErrorPanel } from '../components/ErrorPanel';
import { Modal, Spinner } from '../components/Modal';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';

const LEVEL_ICON: Record<RemoteChangeCheck['checks'][number]['level'], string> = { ok: '✓', info: 'ℹ', warn: '⚠', error: '✕' };

/**
 * Validates a remote change before it is saved: URL format, credentials in the URL, same or different
 * repository, protocol switch, account and GitHub App consequences, and whether the remote answers with
 * the current Git setup. Nothing changes until the user confirms.
 */
export function RemoteChangeDialog({ repoId, name, url, onClose, onSaved }: { repoId: string; name: string; url: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [check, setCheck] = useState<RemoteChangeCheck | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    call('git:checkRemoteChange', { repoId, name, url })
      .then((c) => live && setCheck(c))
      .catch((err) => live && setError(toFriendly(err)));
    return () => {
      live = false;
    };
  }, [repoId, name, url]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('git:setRemote', { repoId, name, url });
      toast(check?.isNew ? `Remote ${name} added` : `${name} now points to ${check?.to.owner ? `${check.to.owner}/${check.to.repo}` : url}`);
      onSaved();
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const warn = check?.checks.some((c) => c.level === 'warn');
  const label = !check ? 'Checking…' : check.isNew ? `Add ${name}` : warn ? `Change ${name} anyway` : `Change ${name}`;

  return (
    <Modal
      title={check?.isNew ? `Add remote ${name}` : `Change ${name}`}
      icon="☁"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={`btn ${warn ? 'attention' : 'primary'}`} disabled={!check?.ok || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : label}
          </button>
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      <div className="remote-diff">
        <div className={`remote-end ${check?.from ? '' : 'empty'}`}>
          <div className="small muted">{check?.isNew ? 'Not set' : 'Now'}</div>
          {check?.from ? (
            <>
              <strong>{check.from.owner ? `${check.from.owner}/${check.from.repo}` : check.from.host ?? 'local'}</strong>
              <div className="mono small">{check.from.url}</div>
              <span className="badge">{check.from.protocol}</span>
            </>
          ) : (
            <strong className="muted">—</strong>
          )}
        </div>
        <span className="remote-arrow">→</span>
        <div className="remote-end next">
          <div className="small muted">After</div>
          <strong>{check?.to.owner ? `${check.to.owner}/${check.to.repo}` : (check?.to.host ?? url)}</strong>
          <div className="mono small">{check?.to.url ?? url}</div>
          {check && <span className="badge info">{check.to.protocol}</span>}
        </div>
      </div>

      {!check && !error && <Spinner label="Checking the URL and asking the remote (read-only)…" />}
      {check && (
        <ul className="check-list">
          {check.checks.map((c, i) => (
            <li key={i} className={`check-${c.level}`}>
              <span className="check-ico">{LEVEL_ICON[c.level]}</span>
              <div>
                <strong>{c.title}</strong>
                <div className="small muted">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {check?.ok && <p className="small muted">Only this repository’s Git configuration changes. Nothing is sent to the remote.</p>}
    </Modal>
  );
}
