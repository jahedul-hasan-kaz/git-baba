import { useEffect, useState } from 'react';
import type { AuthContext, FriendlyError } from '../../shared/types';
import { AuthMethodPicker, type AuthSelection } from '../components/AuthMethodPicker';
import { ErrorPanel } from '../components/ErrorPanel';
import { Modal, Spinner } from '../components/Modal';
import { call, toFriendly } from '../services/api';
import { ownerRepoFromUrl } from '../services/format';
import { useApp } from '../state/AppState';

export function FetchDialog({ repoId, onClose, onDone }: { repoId: string; onClose: () => void; onDone: () => void }) {
  const { repos, info, toast } = useApp();
  const repo = repos.find((r) => r.id === repoId);
  const [options, setOptions] = useState<(AuthContext & { remoteUrl: string | null }) | null>(null);
  const [auth, setAuth] = useState<AuthSelection>({ input: null, summary: '' });
  const [authKey, setAuthKey] = useState(0);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('repo:authOptions', { repoId, purpose: 'fetch' })
      .then(setOptions)
      .catch((err) => setError(toFriendly(err)));
  }, [repoId]);

  const run = async () => {
    if (!auth.input) return;
    setBusy(true);
    setError(null);
    try {
      const res = await call('git:fetch', { repoId, auth: auth.input });
      toast(`Fetched from ${res.remote}. Your files were not changed.`);
      onDone();
    } catch (err) {
      setError(toFriendly(err));
      setAuthKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Fetch Remote Changes"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={run} disabled={!auth.input || busy}>
            {busy ? 'Fetching…' : 'Fetch'}
          </button>
        </>
      }
    >
      <p>Fetch downloads new commits and branches from {options?.remoteUrl ?? 'the remote'}. It does not modify your files or branches.</p>
      {error && <ErrorPanel error={error} onAction={() => setAuthKey((k) => k + 1)} available={['review-auth']} />}
      {!options ? (
        <Spinner />
      ) : (
        <AuthMethodPicker
          key={authKey}
          options={options.authOptions}
          githubApp={options.githubApp}
          savedSshKey={options.savedSshKey}
          repoId={repoId}
          purpose="fetch"
          remoteOwnerRepo={ownerRepoFromUrl(options.remoteUrl)}
          canSave={!!repo?.settings.allowSavedCredentials && !!info?.encryptionAvailable}
          onChange={setAuth}
        />
      )}
    </Modal>
  );
}
