import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiAuthInput, DispatchInput, GhRepoContext, RepoTag, Workflow } from '../../../../shared/github';
import type { FriendlyError } from '../../../../shared/types';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { ApiAuthPicker } from '../../../components/github/ApiAuthPicker';
import { Modal, Spinner } from '../../../components/Modal';
import { call, toFriendly } from '../../../services/api';

import { Select } from '../../../components/Select';
interface Props {
  repoId: string;
  ctx: GhRepoContext;
  workflow: Workflow;
  branches: string[];
  tags: RepoTag[] | null;
  onClose: () => void;
  /** Called with the new run (when GitHub reports it) so the caller can open it live. */
  onStarted: (runId: number | null) => void;
}

/**
 * Run a workflow (workflow_dispatch) in two steps: 1) choose the branch or tag and fill in the inputs,
 * 2) review exactly what will run and authenticate for this one operation — like a push — then start it
 * and hand over to the live run view.
 */
export function DispatchDialog({ repoId, ctx, workflow, branches, tags, onClose, onStarted }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [ref, setRef] = useState(ctx.defaultBranch);
  const [refQuery, setRefQuery] = useState('');
  const [info, setInfo] = useState<{ dispatchable: boolean; inputs: DispatchInput[] } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<FriendlyError | null>(null);
  const [auth, setAuth] = useState<{ input: ApiAuthInput | null; summary: string }>({ input: null, summary: '' });
  const onAuth = useCallback((input: ApiAuthInput | null, summary: string) => setAuth({ input, summary }), []);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'locating'>('idle');

  useEffect(() => {
    setInfo(null);
    setError(null);
    const t = setTimeout(() => {
      call('gh:dispatchInfo', { repoId, path: workflow.path, ref })
        .then((i) => {
          setInfo(i);
          setValues((prev) => Object.fromEntries(i.inputs.map((x) => [x.name, prev[x.name] ?? x.default ?? (x.type === 'boolean' ? 'false' : (x.options[0] ?? ''))])));
        })
        .catch((err) => setError(toFriendly(err)));
    }, 250);
    return () => clearTimeout(t);
  }, [repoId, workflow.path, ref]);

  const refs = useMemo(() => {
    const q = refQuery.trim().toLowerCase();
    const b = (branches.length ? branches : [ctx.defaultBranch]).filter((x) => !q || x.toLowerCase().includes(q));
    const t = (tags ?? []).map((x) => x.name).filter((x) => !q || x.toLowerCase().includes(q));
    return { b: b.slice(0, 80), t: t.slice(0, 40) };
  }, [branches, tags, ctx.defaultBranch, refQuery]);

  const missing = (info?.inputs ?? []).filter((i) => i.required && !values[i.name]?.trim());
  const isProd = /prod|release|deploy|publish|live/i.test(`${workflow.name} ${workflow.path} ${Object.values(values).join(' ')}`);

  const submit = async () => {
    if (!auth.input) return;
    setBusy(true);
    setError(null);
    setPhase('starting');
    try {
      const timer = setTimeout(() => setPhase('locating'), 900);
      const res = await call('gh:dispatch', { repoId, workflowId: workflow.id, ref, inputs: values, auth: auth.input, confirmed: true });
      clearTimeout(timer);
      onStarted(res.runId);
      onClose();
    } catch (err) {
      setError(toFriendly(err));
      setPhase('idle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Run “${workflow.name}”`}
      icon="▶"
      size="wide"
      onClose={onClose}
      locked={busy}
      footer={
        step === 1 ? (
          <>
            <span className="small muted grow">{missing.length ? `Fill in: ${missing.map((m) => m.name).join(', ')}` : ''}</span>
            <button className="btn cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!info?.dispatchable || missing.length > 0} onClick={() => setStep(2)}>
              Review & authenticate →
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setStep(1)} disabled={busy}>
              ← Back
            </button>
            <span className="spacer" />
            <button className="btn cancel" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className={`btn ${isProd ? 'danger' : 'primary'}`} disabled={busy || !auth.input || !understood} onClick={() => void submit()}>
              {phase === 'starting' ? 'Starting…' : phase === 'locating' ? 'Waiting for the run…' : `▶ Run workflow on ${ref}`}
            </button>
          </>
        )
      }
    >
      <div className="wizard-steps">
        <span className={step === 1 ? 'on' : 'done'}>1 · Branch & inputs</span>
        <span className="line" />
        <span className={step === 2 ? 'on' : ''}>2 · Review & authenticate</span>
      </div>
      {error && <ErrorPanel error={error} />}

      {step === 1 && (
        <div className="dispatch-grid">
          <div className="ref-picker">
            <label className="small muted">Use workflow from</label>
            <input value={refQuery} onChange={(e) => setRefQuery(e.target.value)} placeholder="Find a branch or tag…" spellCheck={false} />
            <div className="ref-list">
              <div className="dropdown-title">Branches</div>
              {refs.b.map((b) => (
                <div key={b} className={`dropdown-item ${ref === b ? 'active' : ''}`} onClick={() => setRef(b)}>
                  <span className="ctx-ico">⎇</span>
                  <span className="grow ellipsis mono">{b}</span>
                  {b === ctx.defaultBranch && <span className="badge">default</span>}
                </div>
              ))}
              {refs.t.length > 0 && <div className="dropdown-title">Tags</div>}
              {refs.t.map((t) => (
                <div key={t} className={`dropdown-item ${ref === t ? 'active' : ''}`} onClick={() => setRef(t)}>
                  <span className="ctx-ico">🏷</span>
                  <span className="grow ellipsis mono">{t}</span>
                </div>
              ))}
              {refs.b.length + refs.t.length === 0 && <div className="small muted pad">No branch or tag matches.</div>}
            </div>
          </div>
          <div>
            <div className="small muted mb">
              Workflow file <span className="mono">{workflow.path}</span> at <span className="branch-pill">{ref}</span>
            </div>
            {!info && !error && <Spinner label="Reading workflow inputs…" />}
            {info && !info.dispatchable && <div className="banner warn small">This workflow has no “workflow_dispatch” trigger on {ref}, so it cannot be started manually. Pick another branch, or add the trigger.</div>}
            {info?.dispatchable && info.inputs.length === 0 && <div className="small muted">This workflow takes no inputs.</div>}
            {info?.inputs.map((i) => (
              <div key={i.name} className={`field ${i.required && !values[i.name]?.trim() ? 'invalid' : ''}`}>
                <label>
                  {i.description || i.name} {i.required && <span className="req">*</span>} <span className="mono small muted">{i.name}</span>
                </label>
                {i.type === 'boolean' ? (
                  <label className="check">
                    <input type="checkbox" checked={values[i.name] === 'true'} onChange={(e) => setValues((v) => ({ ...v, [i.name]: String(e.target.checked) }))} /> {i.name}
                  </label>
                ) : i.options.length ? (
                  <Select value={values[i.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}>
                    {i.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </Select>
                ) : (
                  <input value={values[i.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} spellCheck={false} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <>
          <div className="card mb">
            <dl className="kv">
              <dt>Workflow</dt>
              <dd>
                {workflow.name} <span className="mono small muted">{workflow.path}</span>
              </dd>
              <dt>Repository</dt>
              <dd>
                {ctx.owner}/{ctx.name}
              </dd>
              <dt>Ref</dt>
              <dd>
                <span className="branch-pill">{ref}</span>
              </dd>
              {Object.keys(values).length > 0 && (
                <>
                  <dt>Inputs</dt>
                  <dd>
                    {Object.entries(values).map(([k, v]) => (
                      <div key={k} className="small">
                        <span className="mono muted">{k}</span> = <strong className="mono">{v || '""'}</strong>
                      </div>
                    ))}
                  </dd>
                </>
              )}
              <dt>Authentication</dt>
              <dd>{auth.summary || <span className="muted">choose below</span>}</dd>
            </dl>
          </div>
          {isProd && (
            <div className="banner warn small">
              <span className="icon">⚠</span>
              <div>This looks like a deployment or release workflow. It runs with the repository's secrets and may change live environments.</div>
            </div>
          )}
          <h4 style={{ margin: '12px 0 8px' }}>Authenticate this run</h4>
          <ApiAuthPicker repoId={repoId} purpose="run this workflow" needs="“Actions: write” (fine-grained) or the “repo” / “workflow” scope (classic)" onChange={onAuth} />
          <label className="check mt">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>
              I reviewed the ref and inputs. Start <strong>{workflow.name}</strong> on <strong>{ref}</strong>.
            </span>
          </label>
        </>
      )}
    </Modal>
  );
}
