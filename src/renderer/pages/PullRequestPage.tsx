import { useEffect, useState } from 'react';
import type { FileDiff, FriendlyError, PrPreview, PrResult } from '../../shared/types';
import { AuthMethodPicker, type AuthSelection } from '../components/AuthMethodPicker';
import { DiffViewer } from '../components/DiffViewer';
import { ErrorPanel } from '../components/ErrorPanel';
import { Spinner } from '../components/Modal';
import { useAsync } from '../hooks/useAsync';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';

import { Select } from '../components/Select';
export function PullRequestPage() {
  const { activeRepo, revision, info, showError } = useApp();
  const repoId = activeRepo!.id;
  const branches = useAsync(() => call('git:branches', { repoId }), [repoId, revision]);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState<PrPreview | null>(null);
  const [selected, setSelected] = useState<FileDiff | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [auth, setAuth] = useState<AuthSelection>({ input: null, summary: '' });
  const [authKey, setAuthKey] = useState(0);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PrResult | null>(null);

  const local = branches.data?.filter((b) => !b.remote) ?? [];
  const remoteNames = [...new Set((branches.data ?? []).filter((b) => b.remote).map((b) => b.name.split('/').slice(1).join('/')))];

  useEffect(() => {
    if (!branches.data) return;
    const current = branches.data.find((b) => b.current);
    if (!source && current) setSource(current.name);
    if (!target) setTarget(remoteNames.includes('main') ? 'main' : remoteNames.includes('master') ? 'master' : remoteNames[0] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches.data]);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const p = await call('pr:prepare', { repoId, source, target });
      setPreview(p);
      setSelected(p.files[0] ?? null);
      if (!title && p.commits.length) setTitle(p.commits.length === 1 ? p.commits[0].subject : source.replace(/[-_/]/g, ' '));
    } catch (err) {
      setPreview(null);
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!preview || !auth.input) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await call('pr:create', { repoId, source: preview.source, target: preview.target, title, body, draft, auth: auth.input }));
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setAuthKey((k) => k + 1);
      setBusy(false);
    }
  };

  return (
    <div className="content">
      <div className="page" style={{ maxWidth: 1300 }}>
        <div className="card">
          <h3>Create Pull Request</h3>
          <div className="row wrap">
            <div className="field" style={{ minWidth: 240 }}>
              <label>Source branch (changes from)</label>
              <Select kind="branch" value={source} onChange={(e) => setSource(e.target.value)}>
                {local.map((b) => (
                  <option key={b.name}>{b.name}</option>
                ))}
              </Select>
            </div>
            <span style={{ fontSize: 20, marginTop: 10 }}>→</span>
            <div className="field" style={{ minWidth: 240 }}>
              <label>Target branch (merge into)</label>
              <Select kind="branch" value={target} onChange={(e) => setTarget(e.target.value)}>
                {remoteNames.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </Select>
            </div>
            <button className="btn" style={{ marginTop: 8 }} onClick={prepare} disabled={busy || !source || !target}>
              {busy && !preview ? 'Checking…' : 'Compare & Validate'}
            </button>
          </div>
          <p className="small muted">Target branches come from your last fetch. Fetch first to make sure they are up to date.</p>
        </div>

        {error && <ErrorPanel error={error} onAction={(a) => a === 'review-auth' && setAuthKey((k) => k + 1)} available={['review-auth']} />}
        {busy && !preview && <Spinner />}

        {result && (
          <div className="banner ok">
            <span className="icon">✓</span>
            <div className="grow">
              <strong>
                Pull request #{result.number} created: {result.title}
              </strong>
              <div>
                <a onClick={() => call('shell:openExternal', { url: result.url }).catch(showError)}>{result.url}</a>
              </div>
            </div>
          </div>
        )}

        {preview && !result && (
          <>
            {preview.blockers.map((b) => (
              <div key={b} className="banner danger">
                <span className="icon">⛔</span>
                <div>{b}</div>
              </div>
            ))}
            {preview.warnings.map((w) => (
              <div key={w} className="banner warn">
                <span className="icon">⚠</span>
                <div>{w}</div>
              </div>
            ))}
            <div className="card">
              <h3>
                {preview.owner}/{preview.repo}: {preview.source} → {preview.target}
                <span className="badge info" style={{ marginLeft: 8 }}>Account: {preview.account?.login ?? 'none'}</span>
              </h3>
              <div className="row">
                <span className="badge">{preview.commits.length} commit(s)</span>
                <span className="badge">{preview.files.length} file(s)</span>
                <span className="badge ok">+{preview.files.reduce((n, f) => n + f.additions, 0)}</span>
                <span className="badge danger">−{preview.files.reduce((n, f) => n + f.deletions, 0)}</span>
              </div>
              <h4 className="mt">Commits</h4>
              <div style={{ maxHeight: 160, overflow: 'auto' }}>
                {preview.commits.map((c) => (
                  <div key={c.hash} className="small">
                    <span className="mono muted">{c.shortHash}</span> {c.subject} <span className="muted">— {c.author}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', minHeight: 300 }}>
                <div style={{ borderRight: '1px solid var(--border)', maxHeight: 460, overflow: 'auto' }}>
                  {preview.files.map((f) => {
                    const p = f.status === 'deleted' ? f.oldPath : f.newPath;
                    return (
                      <div key={p} className={`file-row ${selected === f ? 'selected' : ''}`} onClick={() => setSelected(f)}>
                        <span className={`kind ${f.status}`}>{f.status[0].toUpperCase()}</span>
                        <span className="path mono">
                          <bdi>{p}</bdi>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ maxHeight: 460, overflow: 'auto' }}>
                  <DiffViewer diff={selected} />
                </div>
              </div>
            </div>

            {preview.blockers.length === 0 && (
              <div className="grid-2" style={{ gap: 20, alignItems: 'start' }}>
                <div className="card">
                  <div className="field">
                    <label>Title</label>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Description</label>
                    <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="What does this change do and why?" />
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Create as draft
                  </label>
                </div>
                <div className="card">
                  <h3>Authentication</h3>
                  <AuthMethodPicker
                    key={authKey}
                    options={preview.authOptions}
                    githubApp={preview.githubApp}
                    savedSshKey={preview.savedSshKey}
                    repoId={repoId}
                    purpose="pr"
                    remoteOwnerRepo={{ owner: preview.owner, repo: preview.repo }}
                    canSave={!!activeRepo?.settings.allowSavedCredentials && !!info?.encryptionAvailable}
                    onChange={setAuth}
                  />
                  <button className="btn primary block mt" onClick={create} disabled={busy || !title.trim() || !auth.input}>
                    {busy ? 'Creating…' : 'Authenticate & Create Pull Request'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
