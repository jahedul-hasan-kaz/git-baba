import { useState } from 'react';
import type { AccountSummary } from '../../shared/types';
import { Avatar } from '../components/github/common';
import { Modal } from '../components/Modal';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

/**
 * Asks which account to sign out of. Signing out ends its session, forgets its saved sign-in and takes it
 * out of the account menu. Its repositories stay on this computer; opening one asks to sign in to it again.
 */
export function SignOutDialog({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const { accounts, setAccounts, refreshSession, refreshRepos, toast, showError } = useApp();
  const list = accounts?.accounts ?? [];
  const [pick, setPick] = useState<string | null>(initial ?? accounts?.activeAccountId ?? list[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const chosen = list.find((a) => a.id === pick) ?? null;
  const next = chosen?.active ? list.find((a) => a.id !== chosen.id) : null;

  const go = async (a: AccountSummary) => {
    setBusy(true);
    try {
      setAccounts(await call('accounts:signOut', { accountId: a.id }));
      await Promise.all([refreshSession().catch(() => undefined), refreshRepos().catch(() => undefined)]);
      toast(`Signed out of ${a.login}${next ? ` — now using ${next.login}` : ''}`, 'info');
      onClose();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Sign out"
      icon="⎋"
      size="narrow"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" disabled={!chosen || busy} onClick={() => chosen && void go(chosen)}>
            {busy ? 'Signing out…' : chosen ? `Sign out of ${chosen.login}` : 'Sign out'}
          </button>
        </>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        Which account do you want to sign out of?
      </p>
      <div className="so-list" role="radiogroup" aria-label="Account to sign out">
        {list.map((a) => (
          <button key={a.id} role="radio" aria-checked={pick === a.id} className={`so-item ${pick === a.id ? 'on' : ''}`} onClick={() => setPick(a.id)} disabled={busy}>
            <span className="so-radio" aria-hidden />
            <Avatar login={a.login} size={28} />
            <span className="grow so-text">
              <strong>{a.login}</strong>
              <span className="small muted">{a.name ?? (a.apiBaseUrl ? new URL(a.apiBaseUrl).host : 'github.com')}</span>
            </span>
            {a.active && <span className="badge">in use</span>}
          </button>
        ))}
      </div>
      {chosen && (
        <div className="so-note small">
          <div>• {chosen.login} is removed from the account menu and its saved sign-in is forgotten.</div>
          <div>• Its repositories stay on this computer. Opening one asks you to sign in to {chosen.login} again.</div>
          {chosen.active && <div>• {next ? `${next.login} becomes the account in use.` : 'No account will be in use until you sign in again.'}</div>}
        </div>
      )}
    </Modal>
  );
}
