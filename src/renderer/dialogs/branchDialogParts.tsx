import { useCallback, useState, type ReactNode } from 'react';
import type { AuthContext } from '../../shared/types';
import { AuthMethodPicker, type AuthSelection } from '../components/AuthMethodPicker';
import { Modal } from '../components/Modal';
import { ownerRepoFromUrl } from '../services/format';
import { useApp } from '../state/AppState';

/** Same authentication step as push: Unsigned / SSH / GitHub App installation token, chosen every time. */
export function BranchAuth({ repoId, ctx, remoteUrl, authKey, onChange, hideTitle, asLabel, account }: { repoId: string; ctx: AuthContext; remoteUrl: string | null; authKey: number; onChange: (a: AuthSelection) => void; hideTitle?: boolean; asLabel?: string; account?: string | null }) {
  const { repos, info } = useApp();
  const repo = repos.find((r) => r.id === repoId);
  return (
    <div>
      {!hideTitle && <h3>Authentication</h3>}
      <AuthMethodPicker
        key={authKey}
        options={ctx.authOptions}
        githubApp={ctx.githubApp}
        savedSshKey={ctx.savedSshKey}
        repoId={repoId}
        purpose="push"
        remoteOwnerRepo={remoteUrl ? ownerRepoFromUrl(remoteUrl) : null}
        canSave={!!repo?.settings.allowSavedCredentials && !!info?.encryptionAvailable}
        onChange={onChange}
        asLabel={asLabel}
        account={account}
      />
    </div>
  );
}

export function useAuthState() {
  const [auth, setAuth] = useState<AuthSelection>({ input: null, summary: '' });
  const [authKey, setAuthKey] = useState(0);
  const onAuth = useCallback((a: AuthSelection) => setAuth(a), []);
  return { auth, authKey, onAuth, resetAuth: () => setAuthKey((k) => k + 1) };
}

export function Footer({ auth, busy, disabled, label, busyLabel, onCancel, onRun, danger }: { auth: AuthSelection; busy: boolean; disabled: boolean; label: string; busyLabel: string; onCancel: () => void; onRun: () => void; danger?: boolean }) {
  return (
    <>
      <span className="small muted grow">{auth.input ? `Credential: ${auth.summary}` : 'Choose and fill in an authentication method to continue.'}</span>
      <button className="btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      <button className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={onRun} disabled={disabled || !auth.input || busy}>
        {busy ? busyLabel : label}
      </button>
    </>
  );
}

export function Result({ title, ok, children, onDone }: { title: string; ok: boolean; children: ReactNode; onDone: () => void }) {
  return (
    <Modal title={title} icon={ok ? '✓' : '⚠'} onClose={onDone} footer={<button className="btn primary" onClick={onDone}>Done</button>}>
      {children}
    </Modal>
  );
}
