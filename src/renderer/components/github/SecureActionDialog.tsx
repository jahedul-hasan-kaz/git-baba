import { useCallback, useState, type ReactNode } from 'react';
import type { ApiAuthInput } from '../../../shared/github';
import type { FriendlyError } from '../../../shared/types';
import { call, toFriendly } from '../../services/api';
import { ErrorPanel } from '../ErrorPanel';
import { Modal } from '../Modal';
import { ApiAuthPicker } from './ApiAuthPicker';

interface Props {
  title: string;
  icon?: string;
  /** What will happen, shown above the authentication. */
  children?: ReactNode;
  /** Shown as a warning banner. */
  impact?: ReactNode;
  danger?: boolean;
  confirmLabel: string;
  /** Repository the credential is for ('' for account-wide operations). */
  repoId: string;
  needs: string;
  methods?: ApiAuthInput['method'][];
  /** When set, the user must type this text exactly before confirming. */
  typeToConfirm?: string;
  /** Extra precondition from the caller's own fields. */
  ready?: boolean;
  onClose: () => void;
  onConfirm: (auth: ApiAuthInput) => Promise<void>;
}

/**
 * Every sensitive change goes through this: what happens → impact → authenticate for this one operation
 * (like a push) → optional typed confirmation → act. Errors stay in the dialog so the user can fix and retry.
 */
export function SecureActionDialog({ title, icon, children, impact, danger, confirmLabel, repoId, needs, methods, typeToConfirm, ready = true, onClose, onConfirm }: Props) {
  const [auth, setAuth] = useState<{ input: ApiAuthInput | null; summary: string }>({ input: null, summary: '' });
  const onAuth = useCallback((input: ApiAuthInput | null, summary: string) => setAuth({ input, summary }), []);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const typedOk = !typeToConfirm || typed === typeToConfirm;

  const go = async () => {
    if (!auth.input) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(auth.input);
      onClose();
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      icon={icon}
      size="wide"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <span className="small muted grow">{auth.summary ? `As ${auth.summary}` : 'Choose how to authenticate'}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={busy || !auth.input || !typedOk || !ready} onClick={() => void go()}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      {children}
      {impact && (
        <div className={`banner ${danger ? 'danger' : 'warn'} small`}>
          <span className="icon">⚠</span>
          <div>{impact}</div>
        </div>
      )}
      <h4 style={{ margin: '14px 0 8px' }}>Authenticate this change</h4>
      <ApiAuthPicker repoId={repoId} purpose={title.toLowerCase()} needs={needs} methods={methods} onChange={onAuth} />
      {typeToConfirm && (
        <div className={`field mt ${typed && !typedOk ? 'invalid' : ''}`}>
          <label>
            Type <strong className="mono">{typeToConfirm}</strong> to confirm
          </label>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" />
        </div>
      )}
    </Modal>
  );
}

export const openExternal = (url: string) => void call('shell:openExternal', { url }).catch(() => undefined);
