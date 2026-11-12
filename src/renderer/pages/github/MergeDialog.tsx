import { useEffect, useRef, useState } from 'react';
import type { MergeAuthInput, MergeMethod, MergeResult, PreMergeReport, RequirementState } from '../../../shared/github';
import type { FriendlyError, KeyHandleInfo } from '../../../shared/types';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Modal, Spinner } from '../../components/Modal';
import { HoldToConfirm, ResultCard } from '../../components/ResultCard';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';

const ICON: Record<RequirementState, [string, string]> = {
  passed: ['✓', 'text-ok'],
  failed: ['✕', 'text-danger'],
  pending: ['●', 'text-warn'],
  warning: ['⚠', 'text-warn'],
  info: ['ℹ', 'muted'],
};

export const METHOD_TEXT: Record<MergeMethod, [string, string]> = {
  merge: ['Create a merge commit', 'All commits are added to the base branch via a merge commit.'],
  squash: ['Squash and merge', 'The commits are combined into one commit on the base branch.'],
  rebase: ['Rebase and merge', 'The commits are rebased and added to the base branch individually.'],
};

interface Props {
  repoId: string;
  number: number;
  onClose: () => void;
  onMerged: (r: MergeResult) => void;
}

/**
 * Pre-merge validation → method → authentication → explicit confirmation → merge.
 * The merge button is never disabled by failing requirements: GitHub decides, and its
 * actual response (success or the real reason for refusal) is shown.
 */
export function MergeDialog({ repoId, number, onClose, onMerged }: Props) {
  const { repos } = useApp();
  const repo = repos.find((r) => r.id === repoId);
  const [report, setReport] = useState<PreMergeReport | null>(null);
  const [loadError, setLoadError] = useState<FriendlyError | null>(null);
  const [method, setMethod] = useState<MergeMethod>('merge');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [auth, setAuth] = useState<'session' | 'github-app'>('session');
  const [appId, setAppId] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [keyMode, setKeyMode] = useState<'file' | 'paste' | 'saved'>('file');
  const [pem, setPem] = useState('');
  const [keyInfo, setKeyInfo] = useState<KeyHandleInfo | null>(null);
  /** null = automatic (open when a requirement failed). */
  const [checksOpen, setChecksOpen] = useState<boolean | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const keyRef = useRef<string | null>(null);

  const savedKey = !!repo?.settings.allowSavedCredentials && !!repo?.savedSecrets.githubAppKey;

  const load = async () => {
    setLoadError(null);
    setReport(null);
    try {
      const r = await call('gh:preMerge', { repoId, number });
      setReport(r);
      setMethod(r.defaultMethod);
      setTitle(`${r.title} (#${r.prNumber})`);
      if (r.githubApp) {
        setAppId(r.githubApp.appId);
        setInstallationId(repo?.settings.githubApp?.installationId ?? '');
      }
      // Use what Security & access already configured: a linked GitHub App with its saved key merges without asking.
      const appOk = r.authOptions.some((o) => o.id === 'github-app' && o.available);
      if (r.githubApp && appOk && savedKey) {
        setAuth('github-app');
        setKeyMode('saved');
      }
    } catch (err) {
      setLoadError(toFriendly(err));
    }
  };

  useEffect(() => {
    void load();
    return () => {
      if (keyRef.current) void call('github:discardKey', { handle: keyRef.current }).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, number]);

  const loadKey = async () => {
    try {
      const k = await call('github:loadKeyFile');
      if (k) {
        keyRef.current = k.handle;
        setKeyInfo(k);
      }
    } catch (err) {
      setError(toFriendly(err));
    }
  };

  const appReady = auth !== 'github-app' || (/^\d+$/.test(appId) && ((keyMode === 'file' && !!keyInfo) || (keyMode === 'paste' && pem.includes('PRIVATE KEY')) || (keyMode === 'saved' && savedKey)));

  const merge = async () => {
    if (!report) return;
    setBusy(true);
    setError(null);
    const authInput: MergeAuthInput =
      auth === 'session'
        ? { method: 'session' }
        : {
            method: 'github-app',
            appId,
            installationId: installationId || undefined,
            ...(keyMode === 'file' ? { keyHandle: keyInfo?.handle } : keyMode === 'paste' ? { privateKey: pem } : { useSavedKey: true }),
          };
    try {
      const r = await call('gh:merge', { repoId, number, method, sha: report.headOid, title: method === 'rebase' ? undefined : title, message: method === 'rebase' ? undefined : message, auth: authInput, confirmed: true });
      keyRef.current = null; // consumed
      setPem('');
      setResult(r);
      onMerged(r);
    } catch (err) {
      const f = toFriendly(err);
      setError(f);
      if (auth === 'github-app' && keyMode === 'file') {
        keyRef.current = null; // single use — load again
        setKeyInfo(null);
      }
      if (f.code === 'head-changed') void load();
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const gh = repo?.github;
    return (
      <ResultCard
        tone={result.merged ? 'ok' : 'warn'}
        title={result.merged ? <>Merged #{number} into {report?.baseRefName ?? 'the base branch'}</> : 'Merge not completed'}
        subtitle={result.merged ? `${METHOD_TEXT[method][0]} on GitHub. Your local copy is unchanged until you pull.` : result.message}
        chips={report ? [<>⎇ {report.headRefName} → {report.baseRefName}</>] : []}
        sha={result.sha}
        actions={[
          ...(result.merged ? [{ label: '⬇ Pull into local', primary: true, run: () => (onClose(), window.dispatchEvent(new CustomEvent('gb:repo-dialog', { detail: 'pull' }))) }] : []),
          ...(gh ? [{ label: 'View on GitHub ↗', run: () => void call('shell:openExternal', { url: `https://github.com/${gh.owner}/${gh.repo}/pull/${number}` }).catch(() => undefined) }] : []),
        ]}
        note={`Signed in with ${result.authDescription}`}
        onClose={onClose}
      />
    );
  }

  const failed = report?.requirements.filter((r) => r.state === 'failed') ?? [];
  const passed = report?.requirements.filter((r) => r.state === 'passed').length ?? 0;
  const total = report?.requirements.length ?? 0;
  const showChecks = checksOpen ?? failed.length > 0;
  const canMerge = !!report && !busy && appReady && report.state === 'OPEN';
  const as = auth === 'session' ? `@${report?.account ?? ''}` : `GitHub App ${appId || '…'}`;
  return (
    <Modal
      title={`Merge pull request #${number}`}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <span className="small muted grow ellipsis mg-sum">
            {report ? (
              <>
                {METHOD_TEXT[method][0]} · <strong>{report.headRefName}</strong> → <strong>{report.baseRefName}</strong> as {as}
              </>
            ) : null}
          </span>
          <button className="btn cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {busy ? (
            <button className="btn primary" disabled>
              Merging…
            </button>
          ) : (
            <HoldToConfirm label={failed.length ? 'Hold to merge anyway' : 'Hold to merge'} danger={failed.length > 0} disabled={!canMerge} onConfirm={merge} />
          )}
        </>
      }
    >
      {loadError && <ErrorPanel error={loadError} onAction={() => load()} available={['retry']} />}
      {!report && !loadError && <Spinner label="Checking the current GitHub state…" />}
      {report && (
        <div className="mg">
          <div className="mg-flow">
            <span className="mg-pr">#{report.prNumber}</span>
            <strong className="ellipsis grow" title={report.title}>
              {report.title}
            </strong>
            <span className="mg-branches mono">
              {report.headRefName} <span className="mg-arrow">⟶</span> {report.baseRefName}
            </span>
            <span className="mono small muted" title="The exact commit that will be merged">
              @{report.headOid.slice(0, 7)}
            </span>
          </div>
          {report.state === 'MERGED' && <div className="banner ok small">This pull request is already merged.</div>}
          {report.state === 'CLOSED' && <div className="banner danger small">This pull request is closed. Reopen it before merging.</div>}

          {/* Readiness: one compact meter; details on demand (open automatically when something failed). */}
          <button className={`mg-meter ${failed.length ? 'bad' : passed === total ? 'good' : 'mid'}`} onClick={() => setChecksOpen(!showChecks)} aria-expanded={showChecks}>
            <span className="mg-dots">
              {report.requirements.map((r) => (
                <i key={r.id} className={r.state} title={`${r.label}: ${r.state}`} />
              ))}
            </span>
            <span className="grow">
              {failed.length ? `${failed.length} requirement${failed.length === 1 ? '' : 's'} not met` : `${passed}/${total} checks passed`}
              {report.rules.length ? ` · ${report.rules.length} branch rule${report.rules.length === 1 ? '' : 's'}` : ''}
            </span>
            <span className="muted small">{showChecks ? 'Hide ▴' : 'Details ▾'}</span>
          </button>
          {showChecks && (
            <div className="mg-checks">
              {report.requirements.map((r) => (
                <div key={r.id} className="mg-check">
                  <span className={ICON[r.state][1]}>{ICON[r.state][0]}</span>
                  <strong>{r.label}</strong>
                  <span className="small muted grow">{r.detail}</span>
                </div>
              ))}
              {report.rules.map((r, i) => (
                <div key={`rule-${i}`} className="mg-check">
                  <span className="muted">§</span>
                  <span className="badge info">{r.source}</span>
                  <span className="small grow">{r.description}</span>
                </div>
              ))}
              {!report.rulesReadable && <div className="small muted">Branch rules could not be read with this account; GitHub still enforces them.</div>}
              {failed.length > 0 && <div className="small text-warn">You can still try — if GitHub refuses, its exact reason appears here and nothing changes.</div>}
            </div>
          )}

          <div className="mg-methods" role="radiogroup" aria-label="Merge method">
            {(['merge', 'squash', 'rebase'] as MergeMethod[]).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={method === m}
                className={`mg-method ${method === m ? 'on' : ''}`}
                disabled={!report.mergeMethods[m]}
                onClick={() => setMethod(m)}
                title={report.mergeMethods[m] ? METHOD_TEXT[m][1] : 'Not allowed in this repository’s settings.'}
              >
                <MethodGlyph m={m} />
                <span>{m === 'merge' ? 'Merge commit' : m === 'squash' ? 'Squash' : 'Rebase'}</span>
              </button>
            ))}
          </div>
          <div className="small muted mg-method-desc">{METHOD_TEXT[method][1]}</div>

          {method !== 'rebase' && (
            <div className="mg-msg">
              <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Commit message" placeholder="Commit message" />
              {showBody || message ? (
                <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Extended description (optional)" />
              ) : (
                <button className="cc-addbody" onClick={() => setShowBody(true)}>
                  + Add description
                </button>
              )}
            </div>
          )}

          <div className="mg-as">
            <span className="small muted">Merge as</span>
            <div className="segmented">
              {report.authOptions.map((o) => (
                <button key={o.id} className={auth === o.id ? 'on' : ''} disabled={!o.available} onClick={() => setAuth(o.id as 'session' | 'github-app')} title={o.available ? o.description : o.reason}>
                  {o.id === 'session' ? `👤 ${report.account}` : `🤖 ${o.label}`}
                </button>
              ))}
            </div>
          </div>
          {auth === 'github-app' && (
              <div className="auth-form">
                <div className="grid-2">
                  <div className="field">
                    <label>GitHub App ID</label>
                    <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="123456" />
                  </div>
                  <div className="field">
                    <label>Installation ID (optional)</label>
                    <input value={installationId} onChange={(e) => setInstallationId(e.target.value)} placeholder="auto-detect" />
                  </div>
                </div>
                <div className="row mb">
                  {savedKey && (
                    <button className={`btn sm ${keyMode === 'saved' ? 'primary' : ''}`} onClick={() => setKeyMode('saved')}>
                      Use saved key
                    </button>
                  )}
                  <button className={`btn sm ${keyMode === 'file' ? 'primary' : ''}`} onClick={() => setKeyMode('file')}>
                    Load .pem
                  </button>
                  <button className={`btn sm ${keyMode === 'paste' ? 'primary' : ''}`} onClick={() => setKeyMode('paste')}>
                    Paste key
                  </button>
                </div>
                {keyMode === 'file' && (
                  <div className="row">
                    <button className="btn sm" onClick={loadKey}>
                      Choose .pem file…
                    </button>
                    <span className="small">{keyInfo ? `${keyInfo.fileName} · ${keyInfo.fingerprint.slice(0, 22)}…` : 'Kept in memory only; never displayed.'}</span>
                  </div>
                )}
                {keyMode === 'paste' && <textarea className="code" rows={4} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN RSA PRIVATE KEY-----" spellCheck={false} autoComplete="off" />}
                <p className="small muted mt">
                  A token for <strong>{report.githubApp ? `${report.githubApp.owner}/${report.githubApp.repo}` : 'this repository'}</strong> only (contents + pull requests: write) is generated, used for this merge, and revoked immediately.
                </p>
              </div>
            )}

          {error && <ErrorPanel error={error} />}
        </div>
      )}
    </Modal>
  );
}

/** Tiny history diagrams for the three merge methods. */
export function MethodGlyph({ m }: { m: MergeMethod }) {
  const dot = (x: number, y: number, k: string) => <circle key={k} cx={x} cy={y} r="2.6" />;
  return (
    <svg className="mg-glyph" viewBox="0 0 44 20" width="44" height="20" aria-hidden>
      <path d="M2 14 H42" className="base" />
      {m === 'merge' && (
        <>
          <path d="M8 14 C12 4, 18 4, 22 4 H28 C32 4, 34 10, 36 14" className="side" />
          {[dot(8, 14, 'a'), dot(22, 4, 'b'), dot(28, 4, 'c'), dot(36, 14, 'd')]}
        </>
      )}
      {m === 'squash' && (
        <>
          <path d="M8 14 C12 4, 16 4, 20 4 H24" className="side ghost" />
          {[dot(8, 14, 'a'), dot(34, 14, 'b')]}
          <rect x="30" y="10" width="8" height="8" rx="2" className="sq" />
        </>
      )}
      {m === 'rebase' && <>{[dot(8, 14, 'a'), dot(20, 14, 'b'), dot(28, 14, 'c'), dot(36, 14, 'd')]}</>}
    </svg>
  );
}
