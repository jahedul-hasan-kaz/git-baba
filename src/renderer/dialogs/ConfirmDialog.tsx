import { useState, type ReactNode } from 'react';
import { Modal } from '../components/Modal';

interface Props {
  title: string;
  /** What the operation does. */
  explanation: ReactNode;
  /** What will change / be lost. */
  impact: ReactNode;
  affected?: string[];
  confirmLabel: string;
  danger?: boolean;
  /** Require typing a word to confirm very destructive actions. */
  typeToConfirm?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  onReview?: () => void;
}

/** Explanation → Impact → Confirmation, with Cancel always available. */
export function ConfirmDialog({ title, explanation, impact, affected, confirmLabel, danger, typeToConfirm, onConfirm, onCancel, onReview }: Props) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = !!typeToConfirm && typed !== typeToConfirm;
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      icon="⚠"
      onClose={onCancel}
      size="narrow"
      locked={busy}
      footer={
        <>
          <button className="btn cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {onReview && (
            <button className="btn" onClick={onReview} disabled={busy}>
              Review Changes
            </button>
          )}
          <button className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={confirm} disabled={blocked || busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {danger && (
        <div className="banner danger">
          <span className="icon">⚠</span>
          <div>
            <strong>WARNING</strong>
            <div>{impact}</div>
          </div>
        </div>
      )}
      <h4>What this does</h4>
      <div className="mb">{explanation}</div>
      {!danger && (
        <>
          <h4>Impact</h4>
          <div className="mb">{impact}</div>
        </>
      )}
      {affected && affected.length > 0 && (
        <>
          <h4>Affected files: {affected.length}</h4>
          <div className="card mono small" style={{ maxHeight: 160, overflow: 'auto' }}>
            {affected.map((f) => (
              <div key={f}>{f}</div>
            ))}
          </div>
        </>
      )}
      {typeToConfirm && (
        <div className="field">
          <label>
            Type <code>{typeToConfirm}</code> to confirm
          </label>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} />
        </div>
      )}
    </Modal>
  );
}
