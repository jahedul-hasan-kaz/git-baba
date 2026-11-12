import { useCallback, useEffect, useState } from 'react';
import type { CommitInfo, CommitPreview, FriendlyError, SigningMethod } from '../../shared/types';
import { ErrorPanel } from '../components/ErrorPanel';
import { KindIcon } from '../components/FileList';
import { Modal, Spinner } from '../components/Modal';
import { call, toFriendly } from '../services/api';

interface Props {
  repoId: string;
  mode: 'commit' | 'continue';
  initialMessage?: string;
  onClose: () => void;
  onDone: (commit: CommitInfo | null) => void;
}

/**
 * Every commit (and every merge/rebase continuation, which also creates commits)
 * goes through this dialog: review files, identity and signing method, then confirm.
 */
const SIGN_ICON: Record<SigningMethod, string> = { none: '✎', gpg: '🔏', ssh: '🔑', x509: '📜' };

export function CommitDialog({ repoId, mode, initialMessage = '', onClose, onDone }: Props) {
  const [preview, setPreview] = useState<CommitPreview | null>(null);
  const [message, setMessage] = useState(initialMessage);
  const [signing, setSigning] = useState<SigningMethod>('none');
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CommitInfo | 'continued' | null>(null);
  const [idName, setIdName] = useState('');
  const [idEmail, setIdEmail] = useState('');
  const [asAccount, setAsAccount] = useState(false); // chosen once when loaded; read-only in the dialog

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = mode === 'commit' ? await call('commit:prepare', { repoId }) : await call('conflict:prepareContinue', { repoId });
      setPreview(p);
      setSigning(p.defaultSigning);
      setIdName(p.identity.name ?? '');
      setIdEmail(p.identity.email ?? '');
      // Default to the account's identity when the git identity is clearly someone else's.
      const a = p.accountAuthor;
      const mine = !!a && [p.identity.name, p.identity.email].some((v) => (v ?? '').toLowerCase().includes(a.login.toLowerCase()));
      setAsAccount(!!a && !mine);
    } catch (err) {
      setError(toFriendly(err));
    }
  }, [repoId, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const identityMissing = !!preview && (!preview.identity.name || !preview.identity.email);

  const saveIdentity = async () => {
    setBusy(true);
    try {
      await call('git:setIdentity', { repoId, name: idName, email: idEmail });
      await load();
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'commit') {
        const c = await call('commit:execute', { repoId, confirmationId: preview.confirmationId, message, signing, authorAccount: asAccount && !!preview.accountAuthor });
        // The composer may be unmounted after a commit, so drop the saved draft here or it comes back later.
        try {
          localStorage.removeItem(`gb.draft.${repoId}`);
        } catch {
          /* drafts are a convenience */
        }
        setDone(c);
      } else {
        await call('conflict:continue', { repoId, confirmationId: preview.confirmationId, signing });
        setDone('continued');
      }
    } catch (err) {
      setError(toFriendly(err));
      // The confirmation id is single-use; prepare a fresh review.
      await load();
    } finally {
      setBusy(false);
    }
  };

  const opName = preview?.operation === 'rebase' ? 'rebase' : 'merge';
  const title = mode === 'commit' ? 'Confirm Commit' : `Confirm: Continue ${opName}`;

  if (done) {
    return (
      <Modal title={title} icon="✓" onClose={() => onDone(done === 'continued' ? null : done)} size="narrow" footer={<button className="btn primary" onClick={() => onDone(done === 'continued' ? null : done)}>Done</button>}>
        <div className="banner ok">
          <span className="icon">✓</span>
          <div>
            {done === 'continued' ? (
              <strong>The {opName} was completed.</strong>
            ) : (
              <>
                <strong>Commit created</strong>
                <div className="mono">
                  {done.shortHash} {done.subject}
                </div>
              </>
            )}
          </div>
        </div>
        <p className="small muted">Nothing was sent to the remote. Use Push when you are ready to share these changes.</p>
      </Modal>
    );
  }

  const canConfirm = !!preview && (!identityMissing || (asAccount && !!preview.accountAuthor)) && (mode === 'continue' || message.trim().length > 0) && !busy;

  return (
    <Modal
      title={title}
      icon="⚠"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={confirm} disabled={!canConfirm}>
            {busy ? 'Committing…' : mode === 'commit' ? 'Authenticate & Commit' : `Confirm & Continue ${opName}`}
          </button>
        </>
      }
    >
      <div className="banner info">
        <span className="icon">ℹ</span>
        <div>
          {mode === 'commit' ? 'You are about to create a Git commit.' : `Continuing the ${opName} will create commit(s).`} Please confirm the credentials/authentication method that should be used.
        </div>
      </div>
      {error && <ErrorPanel error={error} onSwitched={() => void load()} />}
      {!preview && !error && <Spinner label="Preparing review…" />}
      {preview && (
        <>
          <dl className="kv mb">
            <dt>Repository</dt>
            <dd>{preview.repoName}</dd>
            <dt>Branch</dt>
            <dd>{preview.branch ?? 'detached HEAD'}</dd>
            <dt>Author</dt>
            <dd>
              {/* The author is decided for you (your GitHub account, or this repository's Git identity) and cannot be changed here. */}
              {asAccount && preview.accountAuthor ? (
                <span className="cd-author" title="The author is fixed for this commit">
                  <span className="cd-lock" aria-hidden>🔒</span>
                  <strong>{preview.accountAuthor.name}</strong> <span className="muted">&lt;{preview.accountAuthor.email}&gt;</span>
                  <span className="badge">GitHub account · {preview.accountAuthor.login}</span>
                </span>
              ) : identityMissing ? (
                <span className="badge danger">not configured</span>
              ) : (
                <span className="cd-author" title="The author is fixed for this commit">
                  <span className="cd-lock" aria-hidden>🔒</span>
                  <strong>{preview.identity.name}</strong> <span className="muted">&lt;{preview.identity.email}&gt;</span>
                </span>
              )}
            </dd>
            <dt>Repository hooks</dt>
            <dd>{preview.hooksEnabled ? <span className="badge warn">enabled — pre-commit/commit-msg hooks will run</span> : <span className="badge ok">disabled</span>}</dd>
            <dt>Expected result</dt>
            <dd>
              A new {mode === 'continue' ? `${opName} ` : ''}commit on <strong>{preview.branch ?? 'HEAD'}</strong> containing {preview.files.length} staged file(s). Nothing is pushed.
            </dd>
          </dl>

          {identityMissing && !(asAccount && preview.accountAuthor) && (
            <div className="card">
              <h3>Configure Git identity for this repository</h3>
              <div className="grid-2">
                <div className="field">
                  <label>Name</label>
                  <input value={idName} onChange={(e) => setIdName(e.target.value)} />
                </div>
                <div className="field">
                  <label>Email</label>
                  <input value={idEmail} onChange={(e) => setIdEmail(e.target.value)} />
                </div>
              </div>
              <button className="btn" onClick={saveIdentity} disabled={busy || !idName || !idEmail}>
                Save identity
              </button>
            </div>
          )}

          <h4>Files involved ({preview.files.length})</h4>
          <div className="card" style={{ maxHeight: 150, overflow: 'auto', padding: '8px 12px' }}>
            {preview.files.map((f) => (
              <div key={f.path} className="row mono small">
                <KindIcon kind={f.kind} /> {f.path}
              </div>
            ))}
            {preview.files.length === 0 && <span className="muted small">No staged changes (merge result only).</span>}
          </div>

          {mode === 'commit' && (
            <div className="field">
              <label>Commit message</label>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} placeholder="Summarise the change in the first line" autoFocus />
            </div>
          )}
          <div className="mg-as mb">
            <span className="small muted">Commit as</span>
            <div className="segmented">
              {preview.signingOptions.map((o) => (
                <button key={o.method} className={signing === o.method ? 'on' : ''} onClick={() => setSigning(o.method)} title={o.description}>
                  {SIGN_ICON[o.method]} {o.label}
                  {o.method === preview.defaultSigning && o.method !== 'none' && <span className="as-dot" title="Configured for this repository" />}
                </button>
              ))}
            </div>
          </div>
          <div className="small muted auth-as-desc">{preview.signingOptions.find((o) => o.method === signing)?.description} Commits are local — you sign in when you push.</div>
        </>
      )}
    </Modal>
  );
}
