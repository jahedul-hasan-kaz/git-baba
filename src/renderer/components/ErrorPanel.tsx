import type { ErrorAction, FriendlyError } from '../../shared/types';
import { Modal } from './Modal';
import { useApp } from '../state/AppState';

const ACTION_LABELS: Record<ErrorAction, string> = {
  'review-auth': 'Review Authentication',
  retry: 'Try Again',
  pull: 'Pull (Review) First',
  'resolve-conflicts': 'Resolve Conflicts',
  'set-identity': 'Configure Identity',
  'open-settings': 'Open Repository Settings',
};

interface Props {
  error: FriendlyError;
  onAction?: (action: ErrorAction) => void;
  /** Actions this context can actually handle; others are hidden. */
  available?: ErrorAction[];
}

/** Friendly error with reasons, action buttons and an expandable technical section. */
export function ErrorPanel({ error, onAction, available }: Props) {
  const actions = error.actions.filter((a) => !available || available.includes(a));
  return (
    <div className="error-panel">
      <h3>⚠ {error.title}</h3>
      <p>{error.message}</p>
      {error.reasons.length > 0 && (
        <>
          <div className="small muted">Possible reasons:</div>
          <ul>
            {error.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {onAction && actions.length > 0 && (
        <div className="row wrap mt">
          {actions.map((a) => (
            <button key={a} className="btn sm" onClick={() => onAction(a)}>
              {ACTION_LABELS[a]}
            </button>
          ))}
        </div>
      )}
      {error.technical && (
        <details className="technical">
          <summary>Technical details</summary>
          <pre>{error.technical}</pre>
        </details>
      )}
    </div>
  );
}

/** App-level error dialog for errors raised outside a dedicated dialog. */
export function GlobalErrorDialog() {
  const { error, clearError, reviewAuthHandler, setRepoTab, setView, activeRepoId } = useApp();
  if (!error) return null;
  const handle = (a: ErrorAction) => {
    clearError();
    if (a === 'review-auth') reviewAuthHandler?.();
    if (activeRepoId) {
      if (a === 'resolve-conflicts') {
        setView('repo');
        setRepoTab('conflicts');
      }
      if (a === 'set-identity' || a === 'open-settings') {
        setView('repo');
        setRepoTab('settings');
      }
    }
  };
  const available: ErrorAction[] = ['resolve-conflicts', 'set-identity', 'open-settings'];
  if (reviewAuthHandler) available.push('review-auth');
  return (
    <Modal title={error.title} icon="⚠" onClose={clearError} size="narrow" footer={<button className="btn" onClick={clearError}>Close</button>}>
      <ErrorPanel error={error} onAction={handle} available={available} />
    </Modal>
  );
}
