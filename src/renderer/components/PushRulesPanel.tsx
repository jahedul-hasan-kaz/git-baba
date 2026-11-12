import { useEffect, useState } from 'react';
import type { DropFilePreview, DropFileResult, PushRuleReport, PushRuleViolation } from '../../shared/types';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';
import { ErrorPanel } from './ErrorPanel';
import { Modal, Spinner } from './Modal';
import { Hourglass } from './Hourglass';

const KIND: Record<PushRuleReport['kind'], string> = {
  ruleset: 'Repository ruleset',
  'branch-protection': 'Branch protection',
  'push-protection': 'Secret scanning push protection',
  'file-size': 'GitHub file size limit',
};

const STATUS: Record<PushRuleViolation['status'], { label: string; cls: string } | null> = {
  unchecked: null,
  resolved: { label: '✓ fixed locally', cls: 'ok' },
  'still-present': { label: 'still present', cls: 'danger' },
  'remote-only': { label: 'GitHub decides', cls: 'info' },
};

const open = (url: string) => void call('shell:openExternal', { url }).catch(() => undefined);

interface Props {
  repoId: string;
  report: PushRuleReport;
  /** History changed (or was restored): reload the push review. */
  onHistoryChanged: () => Promise<void>;
  onPushToBranch: () => void;
  onRequestPull?: () => void;
}

/** Push → Rule detected → Explain → Identify → Fix (with confirmation) → Re-check → Push again. */
export function PushRulesPanel({ repoId, report: initial, onHistoryChanged, onPushToBranch, onRequestPull }: Props) {
  const { toast, showError } = useApp();
  const [report, setReport] = useState(initial);
  const [drop, setDrop] = useState<string | null>(null);
  const [undo, setUndo] = useState<DropFileResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => setReport(initial), [initial]);

  const recheck = async (r: PushRuleReport = report) => {
    setChecking(true);
    try {
      setReport(await call('push:recheck', { repoId, report: r }));
    } catch (err) {
      showError(err);
    } finally {
      setChecking(false);
    }
  };

  const commitOf = (h: string) => report.commits.find((c) => c.hash === h || c.hash.startsWith(h));
  const localOpen = report.violations.filter((v) => v.locallyFixable && v.status !== 'resolved');
  const remoteRules = report.violations.filter((v) => !v.locallyFixable);
  const allLocalFixed = report.violations.some((v) => v.locallyFixable) && localOpen.length === 0;

  return (
    <div className="rules-panel">
      <div className="banner danger">
        <span className="icon">⛔</span>
        <div className="grow">
          <strong>GitHub refused this push — {report.violations.length} rule(s) not met.</strong>
          <div className="small">
            {KIND[report.kind]} on <span className="mono">{report.remoteBranch || report.ref}</span>. Nothing was changed on GitHub; your local commits are untouched.
          </div>
        </div>
        {report.rulesUrl && (
          <button className="btn sm" onClick={() => open(report.rulesUrl!)}>
            Review rules on GitHub
          </button>
        )}
      </div>

      {allLocalFixed && (
        <div className="banner ok small">
          <span className="icon">✓</span>
          <div className="grow">
            Everything that can be fixed locally is fixed{remoteRules.length ? ` (${remoteRules.length} rule(s) can only be checked by GitHub)` : ''}. Push again — GitHub validates the new commits and stays the final authority.
          </div>
        </div>
      )}

      {report.violations.map((v, i) => {
        const st = STATUS[v.status];
        return (
          <div key={`${v.id}-${i}`} className={`rule-card ${v.status === 'resolved' ? 'resolved' : ''}`}>
            <div className="row" style={{ gap: 6 }}>
              <strong className="grow">
                {i + 1}. {v.title}
              </strong>
              <span className={`badge ${v.locallyFixable ? 'warn' : 'info'}`}>{v.locallyFixable ? 'You can fix this' : 'Needs a different route / permission'}</span>
              {st && <span className={`badge ${st.cls}`}>{st.label}</span>}
            </div>
            <div className="small github-quote">GitHub: “{v.githubMessage}”</div>
            <p className="small">{v.explanation}</p>
            <div className="small">
              <strong>What needs to change:</strong> {v.needed}
            </div>

            {v.files.length > 0 && (
              <div className="rule-files">
                {v.files.map((f) => {
                  const c = f.commit ? commitOf(f.commit) : null;
                  return (
                    <div key={`${f.path}-${f.commit}-${f.line}`} className="row small">
                      <span className="mono grow ellipsis">
                        📄 {f.path}
                        {f.line ? `:${f.line}` : ''}
                        {f.sizeMb ? ` · ${f.sizeMb} MB` : ''}
                        {f.commit && <span className="muted"> · commit {f.commit.slice(0, 8)}{c ? ` “${c.subject}”` : ''}</span>}
                      </span>
                      {v.fixes.includes('drop-file') && v.status !== 'resolved' && (
                        <button className="btn sm danger" disabled={!report.canRewrite} title={report.canRewrite ? '' : 'Finish the current merge/rebase first'} onClick={() => setDrop(f.path)}>
                          Undo this file's change…
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {v.locallyFixable && v.files.length === 0 && v.status !== 'resolved' && (
              <div className="small text-warn mt">GitHub did not name the file and none could be identified locally. See GitHub's message and the rules page.</div>
            )}
            {v.commits.length > 0 && (
              <div className="rule-files">
                {v.commits.slice(0, 8).map((h) => {
                  const c = commitOf(h);
                  return (
                    <div key={h} className="small mono">
                      ● {h.slice(0, 8)} {c ? <span className="muted">{c.subject} — {c.email}</span> : null}
                    </div>
                  );
                })}
                {v.commits.length > 8 && <div className="small muted">… and {v.commits.length - 8} more</div>}
              </div>
            )}

            <div className="row wrap mt" style={{ gap: 6 }}>
              {v.fixes.includes('unblock-secret') && v.unblockUrl && (
                <button className="btn sm" onClick={() => open(v.unblockUrl!)} title="Only for false positives or test values — anyone with read access could see it">
                  It's a false positive — allow on GitHub…
                </button>
              )}
              {v.fixes.includes('push-to-branch') && (
                <button className="btn sm primary" onClick={onPushToBranch}>
                  Push to a new branch &amp; open a pull request…
                </button>
              )}
              {v.fixes.includes('pull-first') && onRequestPull && (
                <button className="btn sm primary" onClick={onRequestPull}>
                  Pull (Review) first…
                </button>
              )}
            </div>
            {v.fixes.includes('sign-commits') && <div className="small muted mt">How: set up GPG signing (GitHub → Settings → SSH and GPG keys), then recreate the listed unpushed commits with “GPG signed” in the commit dialog.</div>}
            {v.fixes.includes('rebase') && <div className="small muted mt">How: instead of merging the remote branch into yours, rebase onto it (or squash the merge through a pull request).</div>}
            {v.fixes.includes('reword') && <div className="small muted mt">How: the listed commits must be recreated with a compliant message / identity before pushing.</div>}
            {v.whoCanFix && (v.fixes.includes('admin') || !v.locallyFixable) && (
              <div className="small muted mt">
                <strong>Who can change the rule:</strong> {v.whoCanFix}
              </div>
            )}
          </div>
        );
      })}

      <div className="row mt">
        <button className="btn sm" disabled={checking} onClick={() => recheck()}>
          {checking ? 'Checking…' : <><Hourglass /> Re-check locally</>}
        </button>
        <button className="btn sm ghost" onClick={() => setShowRaw((s) => !s)}>
          {showRaw ? 'Hide' : 'Show'} GitHub's full message
        </button>
      </div>
      {showRaw && <pre className="log-view mt">{report.raw.join('\n')}</pre>}

      {undo && (
        <div className="banner info small mt">
          <span className="icon">↶</span>
          <div className="grow">
            Removed <span className="mono">{undo.path}</span> from your unpushed commits ({undo.rewritten} commit(s) recreated{undo.dropped ? `, ${undo.dropped} empty commit(s) dropped` : ''}). Your working copy of the file is unchanged.
          </div>
          <button
            className="btn sm"
            onClick={async () => {
              try {
                await call('push:undoDropFile', { repoId, path: undo.path, backupRef: undo.backupRef });
                toast('Original commits restored');
                setUndo(null);
                await onHistoryChanged();
                await recheck();
              } catch (err) {
                showError(err);
              }
            }}
          >
            Undo
          </button>
        </div>
      )}

      {drop && (
        <DropFileDialog
          repoId={repoId}
          path={drop}
          onClose={() => setDrop(null)}
          onDone={async (r) => {
            setDrop(null);
            setUndo(r);
            toast(`${r.path} removed from the unpushed commits — re-checking`);
            await onHistoryChanged();
            await recheck();
          }}
        />
      )}
    </div>
  );
}

function DropFileDialog({ repoId, path, onClose, onDone }: { repoId: string; path: string; onClose: () => void; onDone: (r: DropFileResult) => void }) {
  const [preview, setPreview] = useState<DropFilePreview | null>(null);
  const [error, setError] = useState<ReturnType<typeof toFriendly> | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('push:dropFilePreview', { repoId, path })
      .then(setPreview)
      .catch((err) => setError(toFriendly(err)));
  }, [repoId, path]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await call('push:dropFile', { repoId, path, confirmed: true }));
    } catch (err) {
      setError(toFriendly(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="This change is preventing the push"
      icon="⚠"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Keep it — cancel
          </button>
          <button className="btn danger solid" disabled={busy || !sure || !preview || preview.commits.length === 0} onClick={run}>
            {busy ? 'Working…' : 'Yes, undo it in the commits'}
          </button>
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      {!preview && !error && <Spinner label="Finding the commits that change this file…" />}
      {preview && (
        <>
          <p>
            <span className="mono">
              <strong>{preview.path}</strong>
            </span>{' '}
            is changed by {preview.commits.length} of your {preview.totalUnpushed} unpushed commit(s). <strong>Do you want to undo its change?</strong>
          </p>
          {preview.commits.length === 0 ? (
            <div className="banner info small">None of the unpushed commits change this file anymore — nothing to undo. Re-check and push again.</div>
          ) : (
            <>
              <div className="card small" style={{ maxHeight: 160, overflow: 'auto' }}>
                {preview.commits.map((c) => (
                  <div key={c.hash}>
                    <span className="mono muted">{c.shortHash}</span> {c.subject} <span className="badge">{c.change}</span>
                    {preview.emptied.includes(c.hash) && <span className="badge warn">will be dropped (only this file)</span>}
                  </div>
                ))}
              </div>
              <h4 className="mt">What happens</h4>
              <ul className="small">
                <li>
                  These commits are recreated with {preview.path} {preview.restoredTo === 'remote-version' ? 'as it is on the remote' : 'not added'} — same messages, authors and dates. All their other changes are kept.
                </li>
                {preview.emptied.length > 0 && <li>{preview.emptied.length} commit(s) that only changed this file disappear.</li>}
                <li>
                  {preview.workingCopyExists ? (
                    <>
                      <strong>Your file on disk is not touched.</strong> It shows up as an uncommitted change, so you can fix it (e.g. remove the secret) and commit it again — or discard it later from the Changes tab.
                    </>
                  ) : (
                    'The file does not exist in your working folder.'
                  )}
                </li>
                <li>Unrelated staged and unstaged changes are preserved. Commits already on GitHub are never changed.</li>
                {preview.signedCommits > 0 && <li className="text-warn">{preview.signedCommits} of these commits were signed; the recreated commits are not signed.</li>}
                <li>The old commits are kept as a backup — you can Undo this afterwards.</li>
              </ul>
              <label className="check">
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I understand — remove the change to {preview.path} from these unpushed commits
              </label>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
