import { useEffect, useState } from 'react';
import type { AuthContext, ErrorAction, FileDiff, FriendlyError, PullPreview, PullResult, PullStrategy } from '../../shared/types';
import { AuthMethodPicker, type AuthSelection } from '../components/AuthMethodPicker';
import { DiffViewer } from '../components/DiffViewer';
import { Stepper } from '../components/Stepper';
import { ErrorPanel } from '../components/ErrorPanel';
import { ResultCard } from '../components/ResultCard';
import { Modal, Spinner } from '../components/Modal';
import { SecurityReportView } from '../components/SecurityReportView';
import { call, toFriendly } from '../services/api';
import { ownerRepoFromUrl } from '../services/format';
import { useApp } from '../state/AppState';

interface Props {
  repoId: string;
  onClose: () => void;
  onDone: (result: PullResult | null) => void;
}

type Step = 'auth' | 'fetching' | 'review' | 'pulling' | 'result';

const FLOW = ['Fetch remote changes', 'Inspect incoming changes', 'Run suspicious-code checks', 'Show files + warnings', 'Ask for confirmation', 'Merge / rebase'];

/** Pull = fetch → scan → review → explicit confirmation → integrate the exact reviewed commit. */
export function PullDialog({ repoId, onClose, onDone }: Props) {
  const { repos, info } = useApp();
  const repo = repos.find((r) => r.id === repoId);
  const [step, setStep] = useState<Step>('auth');
  const [options, setOptions] = useState<(AuthContext & { remoteUrl: string | null }) | null>(null);
  const [auth, setAuth] = useState<AuthSelection>({ input: null, summary: '' });
  const [authKey, setAuthKey] = useState(0);
  const [preview, setPreview] = useState<PullPreview | null>(null);
  const [strategy, setStrategy] = useState<PullStrategy>('ff-only');
  const [ack, setAck] = useState(false);
  const [tab, setTab] = useState<'security' | 'commits' | 'files'>('security');
  const [selected, setSelected] = useState<FileDiff | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [result, setResult] = useState<PullResult | null>(null);

  useEffect(() => {
    call('repo:authOptions', { repoId, purpose: 'fetch' })
      .then(setOptions)
      .catch((err) => setError(toFriendly(err)));
  }, [repoId]);

  const fetchAndReview = async () => {
    if (!auth.input) return;
    setStep('fetching');
    setError(null);
    try {
      const p = await call('pull:prepare', { repoId, auth: auth.input });
      setPreview(p);
      setStrategy(p.canFastForward ? 'ff-only' : 'merge');
      setTab(p.report.status === 'NO_ISSUES_DETECTED' ? 'files' : 'security');
      setSelected(p.files[0] ?? null);
      setStep('review');
    } catch (err) {
      setError(toFriendly(err));
      setAuthKey((k) => k + 1);
      setStep('auth');
    }
  };

  const cancel = async () => {
    if (preview && step === 'review') await call('pull:cancel', { repoId, reviewId: preview.reviewId }).catch(() => undefined);
    onClose();
  };

  const pull = async () => {
    if (!preview) return;
    setStep('pulling');
    setError(null);
    try {
      setResult(await call('pull:execute', { repoId, reviewId: preview.reviewId, strategy, acknowledgedRisk: ack }));
      setStep('result');
    } catch (err) {
      setError(toFriendly(err));
      setStep('auth');
      setPreview(null);
    }
  };

  const openFile = (path: string) => {
    setTab('files');
    setSelected(preview?.files.find((f) => f.newPath === path || f.oldPath === path) ?? null);
  };

  const needsAck = !!preview && preview.report.status !== 'NO_ISSUES_DETECTED';

  if (step === 'result' && result) {
    const conflicts = result.outcome === 'conflicts';
    const n = preview?.commits.length ?? 0;
    const titles: Record<string, string> = {
      'fast-forward': `Pulled ${n} commit${n === 1 ? '' : 's'}`,
      merged: `Merged ${n} incoming commit${n === 1 ? '' : 's'}`,
      rebased: 'Rebased onto the remote',
      'up-to-date': 'Already up to date',
      conflicts: 'The pull stopped on conflicts',
    };
    return (
      <ResultCard
        tone={conflicts ? 'warn' : 'ok'}
        title={titles[result.outcome] ?? 'Pull finished'}
        subtitle={result.message}
        chips={preview ? [<>⎇ {preview.upstream} → {preview.branch}</>] : []}
        sha={conflicts ? null : preview?.targetOid}
        actions={conflicts ? [{ label: 'Resolve conflicts', primary: true, run: () => onDone(result) }] : []}
        onClose={() => onDone(result)}
      />
    );
  }

  const footer =
    step === 'auth' || step === 'fetching' ? (
      <>
        <button className="btn cancel" onClick={onClose} disabled={step === 'fetching'}>
          Cancel
        </button>
        <button className="btn primary" onClick={fetchAndReview} disabled={!auth.input || step === 'fetching'}>
          {step === 'fetching' ? 'Fetching & scanning…' : 'Fetch & Review'}
        </button>
      </>
    ) : (
      <>
        {needsAck && (
          <label className="check grow">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I reviewed the flagged changes and want to continue</span>
          </label>
        )}
        <button className="btn cancel" onClick={cancel} disabled={step === 'pulling'}>
          Cancel
        </button>
        <button className="btn" onClick={() => setTab('files')} disabled={step === 'pulling'}>
          Review Changes
        </button>
        <button className={`btn ${preview?.report.status === 'REVIEW_REQUIRED' ? 'danger solid' : 'primary'}`} onClick={pull} disabled={step === 'pulling' || (needsAck && !ack) || !preview || preview.upToDate}>
          {step === 'pulling' ? 'Pulling…' : 'Continue Pull'}
        </button>
      </>
    );

  return (
    <Modal title="Pull with Security Review" onClose={cancel} size="wide" locked={step === 'fetching' || step === 'pulling'} footer={footer}>
      <Stepper
        steps={[
          { label: 'Authenticate', detail: auth.summary ? auth.summary.slice(0, 28) : undefined },
          { label: 'Fetch & scan', detail: preview ? `${preview.commits.length} commit(s)` : undefined },
          { label: 'Review', detail: preview ? (preview.report.status === 'REVIEW_REQUIRED' ? 'flagged' : 'looks clean') : undefined },
          { label: 'Pull' },
        ]}
        current={{ auth: 0, fetching: 1, review: 2, pulling: 3, result: 4 }[step]}
        busy={step === 'fetching' || step === 'pulling'}
        failed={error && step === 'auth' ? 0 : undefined}
        canSelect={(i) => step === 'review' && i === 0}
        onSelect={() => {
          setAck(false);
          setStep('auth');
        }}
      />
      {error && <ErrorPanel error={error} onAction={(a: ErrorAction) => a === 'review-auth' && setAuthKey((k) => k + 1)} available={['review-auth']} onSwitched={() => { setError(null); setAuthKey((k) => k + 1); }} />}

      {(step === 'auth' || step === 'fetching') && (
        <div className="grid-2" style={{ gap: 20, alignItems: 'start' }}>
          <div>
            <p>Before anything changes in your working copy, Git Baba downloads the remote changes and inspects them.</p>
            <div className="flow">
              Pull requested
              {FLOW.map((f) => (
                <div key={f}>
                  {'      ↓'}
                  <br />
                  {f}
                </div>
              ))}
            </div>
            <p className="small muted mt">Fetching does not modify your files. Only the exact commit you review can be merged afterwards.</p>
          </div>
          <div>
            <h3>Authentication for fetch</h3>
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
          </div>
        </div>
      )}

      {(step === 'review' || step === 'pulling') && preview && (
        <>
          {preview.upToDate ? (
            <div className="banner ok">
              <span className="icon">✓</span>
              <div>
                <strong>Already up to date.</strong> {preview.branch} already contains {preview.upstream}.
              </div>
            </div>
          ) : (
            <>
              <dl className="kv mb">
                <dt>Repository</dt>
                <dd>{preview.repoName}</dd>
                <dt>Integrate</dt>
                <dd>
                  <span className="mono">{preview.upstream}</span> @ <span className="mono small">{preview.targetOid.slice(0, 10)}</span> → <strong>{preview.branch}</strong>
                </dd>
                <dt>Incoming</dt>
                <dd>
                  {preview.commits.length} commit(s), {preview.files.length} file(s)
                </dd>
                {preview.localChangeCount > 0 && (
                  <>
                    <dt>Local changes</dt>
                    <dd>
                      <span className="badge warn">{preview.localChangeCount} uncommitted file(s)</span> Git will stop rather than overwrite them.
                    </dd>
                  </>
                )}
              </dl>
              <div className="tabs" style={{ padding: 0, background: 'transparent', marginBottom: 10 }}>
                <div className={`tab ${tab === 'security' ? 'active' : ''}`} onClick={() => setTab('security')}>
                  Security <span className={`badge ${preview.report.status === 'REVIEW_REQUIRED' ? 'danger' : preview.report.status === 'REVIEW_RECOMMENDED' ? 'warn' : 'ok'}`}>{preview.report.findings.length}</span>
                </div>
                <div className={`tab ${tab === 'commits' ? 'active' : ''}`} onClick={() => setTab('commits')}>
                  Commits <span className="badge">{preview.commits.length}</span>
                </div>
                <div className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
                  Changed files <span className="badge">{preview.files.length}</span>
                </div>
              </div>
              {tab === 'security' && <SecurityReportView report={preview.report} onOpenFile={openFile} />}
              {tab === 'commits' && (
                <table className="list">
                  <tbody>
                    {preview.commits.map((c) => (
                      <tr key={c.hash}>
                        <td className="mono small">{c.shortHash}</td>
                        <td>{c.subject}</td>
                        <td className="muted small">{c.author}</td>
                        <td className="muted small">{new Date(c.date).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'files' && (
                <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 10, minHeight: 300 }}>
                  <div style={{ maxHeight: 420, overflow: 'auto', borderRight: '1px solid var(--border)' }}>
                    {preview.files.map((f) => {
                      const p = f.status === 'deleted' ? f.oldPath : f.newPath;
                      const flagged = preview.report.flaggedFiles.includes(p);
                      return (
                        <div key={p} className={`file-row ${selected === f ? 'selected' : ''}`} onClick={() => setSelected(f)}>
                          <span className={`kind ${f.status}`}>{f.status[0].toUpperCase()}</span>
                          <span className="path mono">
                            <bdi>{p}</bdi>
                          </span>
                          {flagged && <span className="badge warn">!</span>}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ maxHeight: 420, overflow: 'auto' }}>
                    <DiffViewer diff={selected} />
                  </div>
                </div>
              )}
              <h3 className="mt">Integration strategy</h3>
              {preview.unrelated && (
                <div className="banner warn">
                  <span className="icon">⚠</span>
                  <div className="small">
                    <strong>{preview.branch} and {preview.upstream} have no commit in common.</strong> This usually means the remote repository was created with its own first
                    commit (a README or license) while you started a separate history here. <strong>Merge</strong> joins both histories and keeps every file; files that exist on
                    both sides with different content become conflicts you can resolve.
                  </div>
                </div>
              )}
              {(
                [
                  ['ff-only', 'Fast-forward only', 'Move your branch forward to the reviewed commit. Fails safely if your branch has its own new commits.', !preview.canFastForward],
                  ['merge', 'Merge', 'Create a merge commit combining your commits with the incoming ones. Conflicts can be resolved in the app.', false],
                  ['rebase', 'Rebase', 'Replay your local commits on top of the incoming commits. Rewrites your local (unpushed) commits.', false],
                ] as [PullStrategy, string, string, boolean][]
              ).map(([value, label, desc, disabled]) => (
                <label key={value} className={`radio-card ${strategy === value ? 'selected' : ''}`} style={disabled ? { opacity: 0.5 } : undefined}>
                  <input type="radio" checked={strategy === value} disabled={disabled} onChange={() => setStrategy(value)} />
                  <div>
                    <strong>{label}</strong>
                    <div className="small muted">{desc}</div>
                  </div>
                </label>
              ))}
            </>
          )}
        </>
      )}
      {step === 'pulling' && <Spinner label="Integrating the reviewed commit…" />}
    </Modal>
  );
}
