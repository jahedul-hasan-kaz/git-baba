import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountCredentialInput, CreateRepoState, DirectorySelection, FriendlyError, RepoSummary } from '../../shared/types';
import { AccountCredentialFields } from '../components/AccountCredentialFields';
import { Stepper } from '../components/Stepper';
import { ErrorPanel } from '../components/ErrorPanel';
import { Modal } from '../components/Modal';
import { WorkflowSteps } from '../components/WorkflowSteps';
import { call, onProgress, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';
import { AddAccountDialog } from './AddAccountDialog';

import { Select } from '../components/Select';
type Stage = 'info' | 'summary' | 'workflow';

/**
 * Create Repository: information → summary → authenticate (at the point of creation) →
 * state-machine progress with retry / fix / cancel for each step.
 */
export function CreateRepoWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (r: RepoSummary) => void }) {
  const { accounts, activeAccount, repos, bump, toast, refreshRepos } = useApp();
  const [stage, setStage] = useState<Stage>('info');
  const [folder, setFolder] = useState<DirectorySelection | null>(null);
  const [subfolder, setSubfolder] = useState('');
  const [localOnly, setLocalOnly] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(activeAccount?.id ?? accounts?.accounts[0]?.id ?? null);
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<FriendlyError | null>(null);
  const [state, setState] = useState<CreateRepoState | null>(null);
  const [credential, setCredential] = useState<AccountCredentialInput | null>(null);
  const [credKey, setCredKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const onCred = useCallback((c: AccountCredentialInput | null) => setCredential(c), []);

  const account = accounts?.accounts.find((a) => a.id === accountId) ?? null;
  const owners = useMemo(() => (account ? [account.login, ...account.orgs] : []), [account]);

  useEffect(() => {
    if (account && !owners.includes(owner)) setOwner(account.login);
  }, [account, owners, owner]);

  // Live step updates pushed from the main process.
  useEffect(
    () =>
      onProgress((e) => {
        if (e.kind === 'create') setState((cur) => (cur && cur.workflowId === e.state.workflowId ? e.state : cur));
      }),
    [],
  );

  useEffect(() => {
    if (state?.phase === 'done' && state.repoId) {
      void refreshRepos().then(() => bump());
    }
  }, [state?.phase, state?.repoId, refreshRepos, bump]);

  const pickFolder = async () => {
    try {
      const p = await call('dialog:pickDirectory', { purpose: 'create' });
      if (p) {
        setFolder(p);
        if (!name) setName(p.path.split(/[\\/]/).pop() ?? '');
      }
    } catch (err) {
      setError(toFriendly(err));
    }
  };

  const localPath = folder ? (subfolder ? `${folder.path}${folder.path.endsWith('\\') || folder.path.endsWith('/') ? '' : '\\'}${subfolder}` : folder.path) : '';
  const nameValid = /^[A-Za-z0-9._-]{1,100}$/.test(name) && !name.endsWith('.git');
  const infoComplete = !!folder && nameValid && (localOnly || (!!account && !!owner));

  const start = async () => {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      const s = await call('create:start', {
        input: { selectionId: folder.selectionId, folderName: subfolder.trim() || undefined, accountId: localOnly ? null : accountId, name, owner: localOnly ? '' : owner, visibility, description: description.trim() || undefined, localOnly },
      });
      setFolder(null); // selection ids are single use
      setState(s);
      setStage('workflow');
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const wf = async (fn: () => Promise<CreateRepoState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const authenticate = () =>
    wf(async () => {
      const s = await call('create:authenticate', { workflowId: state!.workflowId, credential: credential! });
      setCredKey((k) => k + 1); // the typed token is cleared from the form after each attempt
      return s;
    });

  const finish = () => {
    const r = state?.repoId ? repos.find((x) => x.id === state.repoId) : null;
    if (r) {
      onCreated(r);
      toast(`${r.name} is ready. Review its files in Changes and make the first commit.`);
    }
    onClose();
  };

  const cancelWorkflow = async () => {
    if (state && state.phase !== 'done' && state.phase !== 'cancelled') {
      try {
        setState(await call('create:cancel', { workflowId: state.workflowId }));
        return;
      } catch {
        // workflow already gone
      }
    }
    onClose();
  };

  // ------------------------------------------------------------------

  if (stage === 'info' || stage === 'summary') {
    return (
      <Modal
        title="Create Repository"
        onClose={onClose}
        locked={busy}
        footer={
          stage === 'info' ? (
            <>
              <button className="btn cancel" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={!infoComplete} onClick={() => setStage('summary')}>
                Continue
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setStage('info')} disabled={busy}>
                Back
              </button>
              <button className="btn cancel" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={start} disabled={busy}>
                {busy ? 'Starting…' : 'Continue'}
              </button>
            </>
          )
        }
      >
        <Stepper steps={['Repository information', 'Summary', 'Authenticate', 'Create'].map((label) => ({ label }))} current={stage === 'info' ? 0 : 1} />
        {error && <ErrorPanel error={error} />}
        {stage === 'info' ? (
          <>
            <label className="check">
              <input type="checkbox" checked={!localOnly} onChange={(e) => setLocalOnly(!e.target.checked)} />
              <span>
                <strong>Create the repository on GitHub</strong> <span className="muted small">(untick for a local-only repository)</span>
              </span>
            </label>
            <div className="grid-2 mt">
              <div className="field">
                <label>Local project folder</label>
                <div className="row">
                  <button className="btn" onClick={pickFolder}>
                    Choose…
                  </button>
                  <span className="small ellipsis grow">{folder?.path ?? 'not selected'}</span>
                </div>
              </div>
              <div className="field">
                <label>New subfolder (optional)</label>
                <input value={subfolder} onChange={(e) => setSubfolder(e.target.value)} placeholder="leave empty to use the folder itself" />
              </div>
            </div>
            {!localOnly && (
              <div className="grid-2">
                <div className="field">
                  <label>GitHub account</label>
                  {accounts?.accounts.length ? (
                    <Select kind="account" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)}>
                      {accounts.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.login}
                          {a.active ? ' (default)' : ''}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <button className="btn" onClick={() => setAddingAccount(true)}>
                      + Add GitHub Account
                    </button>
                  )}
                </div>
                <div className="field">
                  <label>Owner / organisation</label>
                  <Select kind="account" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!account}>
                    {owners.map((o, i) => (
                      <option key={o} value={o}>
                        {o}
                        {i === 0 ? ' (personal)' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
            <div className="grid-2">
              <div className="field">
                <label>Repository name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="agent-management" spellCheck={false} />
                {name && !nameValid && <span className="hint" style={{ color: 'var(--danger)' }}>Use letters, numbers, “.”, “-” or “_”.</span>}
              </div>
              {!localOnly && (
                <div className="field">
                  <label>Visibility</label>
                  <Select value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}>
                    <option value="private" data-icon="🔒" data-desc="Only you and people you invite">Private</option>
                    <option value="public" data-icon="🌐" data-desc="Anyone on the internet can see it">Public</option>
                  </Select>
                </div>
              )}
            </div>
            {!localOnly && (
              <div className="field">
                <label>Description (optional)</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={350} />
              </div>
            )}
          </>
        ) : (
          <div className="card">
            <h3>Create Repository</h3>
            <dl className="kv">
              {!localOnly && (
                <>
                  <dt>GitHub Account</dt>
                  <dd>{account?.login}</dd>
                  <dt>Owner</dt>
                  <dd>{owner === account?.login ? `${owner} (personal)` : owner}</dd>
                </>
              )}
              <dt>Repository</dt>
              <dd>{name}</dd>
              {!localOnly && (
                <>
                  <dt>Visibility</dt>
                  <dd>{visibility === 'private' ? 'Private' : 'Public'}</dd>
                </>
              )}
              <dt>Local Folder</dt>
              <dd className="mono small">{localPath}</dd>
              <dt>Type</dt>
              <dd>{localOnly ? 'Local repository only (no GitHub)' : 'GitHub repository + local repository'}</dd>
            </dl>
            {!localOnly && <p className="small muted mt">Next you authenticate {account?.login}. Nothing is created before that.</p>}
          </div>
        )}
        {addingAccount && <AddAccountDialog onClose={() => setAddingAccount(false)} onAdded={(a) => setAccountId(a.id)} />}
      </Modal>
    );
  }

  // ------------------------------------------------------------------ workflow
  const s = state!;
  const awaitingAuth = s.phase === 'awaiting-auth';
  const done = s.phase === 'done';
  const failed = s.phase === 'failed';
  const cancelled = s.phase === 'cancelled';

  return (
    <Modal
      title="Create Repository"
      size="wide"
      onClose={done || cancelled ? (done ? finish : onClose) : cancelWorkflow}
      locked={busy || s.phase === 'running'}
      footer={
        <>
          {s.githubUrl && (
            <button className="btn ghost" onClick={() => call('shell:openExternal', { url: s.githubUrl! }).catch(() => undefined)}>
              Open on GitHub
            </button>
          )}
          <span className="spacer" />
          {done && (
            <button className="btn primary" onClick={finish}>
              Open Repository
            </button>
          )}
          {cancelled && (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
          {failed && (
            <>
              <button className="btn cancel" onClick={cancelWorkflow} disabled={busy}>
                Cancel
              </button>
              {s.fixes.map((f) => (
                <button key={f.id} className="btn" onClick={() => wf(() => call('create:fix', { workflowId: s.workflowId, fixId: f.id }))} disabled={busy}>
                  {f.label}
                </button>
              ))}
              <button className="btn primary" onClick={() => wf(() => call('create:retry', { workflowId: s.workflowId }))} disabled={busy}>
                {s.incomplete ? 'Retry Local Setup' : 'Retry'}
              </button>
            </>
          )}
          {awaitingAuth && (
            <>
              <button className="btn cancel" onClick={cancelWorkflow} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={authenticate} disabled={busy || !credential}>
                {busy ? 'Authenticating…' : 'Authenticate'}
              </button>
            </>
          )}
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      <dl className="kv mb">
        {s.summary.account && (
          <>
            <dt>Account</dt>
            <dd>{s.summary.account}</dd>
          </>
        )}
        <dt>Repository</dt>
        <dd>{s.summary.localOnly ? s.summary.name : `${s.summary.owner}/${s.summary.name} (${s.summary.visibility})`}</dd>
        <dt>Local folder</dt>
        <dd className="mono small">{s.summary.localPath}</dd>
      </dl>

      {awaitingAuth && account && (
        <div className="card">
          <h3>🔐 Authentication Required</h3>
          <p className="small">
            To create this repository, GitHub authentication is required. <strong>Account:</strong> {account.login} · <strong>Required permission:</strong> create repository
            {s.summary.owner !== account.login ? ` in ${s.summary.owner}` : ''}.
          </p>
          <AccountCredentialFields key={credKey} account={account} encryptionAvailable={!!accounts?.encryptionAvailable} purpose="create this repository" onChange={onCred} />
        </div>
      )}

      {s.incomplete && (
        <div className={`banner ${cancelled ? 'info' : 'warn'}`}>
          <span className="icon">{cancelled ? 'ℹ' : '⚠'}</span>
          <div>
            {!cancelled && <strong>Repository Creation Incomplete. </strong>}
            {s.incomplete}
          </div>
        </div>
      )}
      {done && (
        <div className="banner ok">
          <span className="icon">✓</span>
          <div>
            <strong>Repository created successfully.</strong> It was added to your repository list. Review its files in Changes and make the first commit when you are ready.
          </div>
        </div>
      )}
      <WorkflowSteps steps={s.steps} onReviewAuth={awaitingAuth ? () => setCredKey((k) => k + 1) : undefined} />
    </Modal>
  );
}
