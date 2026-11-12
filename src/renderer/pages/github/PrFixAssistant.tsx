import { useCallback, useEffect, useState } from 'react';
import type { PrAccessDiagnosis } from '../../../shared/github';
import type { FriendlyError } from '../../../shared/types';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Modal, Spinner } from '../../components/Modal';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';

interface Props {
  repoId: string;
  base: string;
  head: string;
  /** Each returns true when the pull request was created. */
  createWithCli: () => Promise<boolean>;
  retry: () => Promise<FriendlyError | null>;
  useGitHubApp: () => void;
  onClose: () => void;
}

type Fix = 'cli' | 'token' | 'app' | 'admin';

/** Fine-grained token page with the needed settings filled in (GitHub ignores parameters it does not know). */
function tokenUrl(d: PrAccessDiagnosis): string {
  const q = new URLSearchParams({
    name: `Git Baba – ${d.name}`.slice(0, 40),
    description: `Pull requests from Git Baba for ${d.owner}/${d.name}`,
    expires_in: '90',
    contents: 'write',
    pull_requests: 'write',
    metadata: 'read',
  });
  if (d.ownerType === 'Organization' || d.owner === d.login) q.set('target_name', d.owner);
  return `https://${d.host}/settings/personal-access-tokens/new?${q.toString()}`;
}

function Check({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return (
    <div className="diag-row">
      <span className={ok ? 'text-ok' : warn ? 'text-warn' : 'text-danger'}>{ok ? '✓' : warn ? '!' : '✗'}</span>
      <div className="grow">{children}</div>
    </div>
  );
}

/**
 * Walks the user from "Token Not Allowed Here" to a created pull request: diagnoses the cause,
 * offers every way out, and asks only for what the chosen fix needs.
 */
export function PrFixAssistant({ repoId, base, head, createWithCli, retry, useGitHubApp, onClose }: Props) {
  const { session, refreshSession, toast, showError } = useApp();
  const [diag, setDiag] = useState<PrAccessDiagnosis | null>(null);
  const [diagError, setDiagError] = useState<FriendlyError | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const remember = true;
  const [tokenStep, setTokenStep] = useState<1 | 2>(1);
  const [stillFailing, setStillFailing] = useState<FriendlyError | null>(null);

  const diagnose = useCallback(async () => {
    setDiagError(null);
    try {
      const d = await call('gh:prAccessDiagnose', { repoId });
      setDiag(d);
      return d;
    } catch (err) {
      setDiagError(toFriendly(err));
      return null;
    }
  }, [repoId]);

  useEffect(() => {
    void diagnose().then((d) => d && setFix((f) => f ?? (d.cli.loggedIn ? 'cli' : 'token')));
  }, [diagnose]);

  const copy = (text: string, what: string) => void call('app:copyText', { text }).then(() => toast(`${what} copied`), showError);
  const open = (url: string) => void call('shell:openExternal', { url }).catch(showError);

  const runCli = async () => {
    setBusy(true);
    const ok = await createWithCli();
    setBusy(false);
    if (ok) onClose();
  };

  const useNewToken = async () => {
    if (!session) return;
    setBusy(true);
    setStillFailing(null);
    try {
      await call('session:signIn', { credential: { accountId: session.accountId, token: token.trim(), remember } });
      setToken('');
      await refreshSession();
      const err = await retry();
      if (!err) {
        toast('Token updated and pull request created');
        return onClose();
      }
      setStillFailing(err);
      await diagnose();
    } catch (err) {
      setStillFailing(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const seesRepo = diag?.repoStatus === 200;
  const canWrite = diag?.role === 'admin' || diag?.role === 'maintain' || diag?.role === 'write';
  const adminText = diag
    ? `Hi! Could you approve my fine-grained personal access token for ${diag.owner}? I need "Pull requests: Read and write" and "Contents: Read and write" on ${diag.owner}/${diag.name} so I can open pull requests from Git Baba (GitHub user: ${diag.login}). Organisation settings → Personal access tokens → Pending requests.`
    : '';

  return (
    <Modal
      size="wide"
      icon="🩺"
      title="Fix pull request access"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <span className="small muted grow">
            {head} → {base}
          </span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
        </>
      }
    >
      {diagError && <ErrorPanel error={diagError} />}
      {!diag && !diagError && <Spinner label="Checking your token, the repository and the GitHub CLI…" />}
      {diag && (
        <div className="fade-in">
          <h3>What Git Baba found</h3>
          <div className="card diag-card">
            <Check ok={diag.tokenKind === 'classic'} warn>
              Signed in as <strong>{diag.login}</strong> with a <strong>{diag.tokenKind}</strong> token.
            </Check>
            <Check ok={seesRepo}>
              {seesRepo ? (
                <>
                  The token can see <code>
                    {diag.owner}/{diag.name}
                  </code>
                  .
                </>
              ) : (
                <>
                  The token <strong>cannot see</strong>{' '}
                  <code>
                    {diag.owner}/{diag.name}
                  </code>{' '}
                  (HTTP {diag.repoStatus}
                  {diag.repoMessage ? `: ${diag.repoMessage}` : ''}). Its resource owner is probably not <strong>{diag.owner}</strong>, the repository is not selected, or {diag.owner} has not approved the token yet.
                </>
              )}
            </Check>
            {seesRepo && (
              <Check ok={canWrite}>
                Your role: <strong>{diag.role ?? 'unknown'}</strong>
                {canWrite ? ' — enough to open pull requests.' : ' — opening pull requests needs write access. Ask an owner to raise it.'}
              </Check>
            )}
            {seesRepo && canWrite && (
              <Check ok={false}>
                So the token itself is missing <strong>Pull requests: Read and write</strong> for this repository.
              </Check>
            )}
            <Check ok={diag.cli.loggedIn} warn={diag.cli.installed}>
              GitHub CLI:{' '}
              {diag.cli.loggedIn
                ? `installed${diag.cli.version ? ` (${diag.cli.version})` : ''} and signed in${diag.cli.login ? ` as ${diag.cli.login}` : ''}.`
                : diag.cli.installed
                  ? 'installed, but not signed in.'
                  : 'not installed.'}
            </Check>
          </div>

          <h3 className="mt">Choose how to fix it</h3>
          <div className="fix-options">
            <FixCard id="cli" active={fix} set={setFix} icon="⌨" title="Use the GitHub CLI" badge={diag.cli.loggedIn ? 'Fastest' : null} sub="Creates this pull request with your gh login. Nothing to paste.">
              {diag.cli.loggedIn ? (
                <>
                  <p className="small">
                    Git Baba runs <code>gh pr create</code> for you with the title, description, reviewers and labels from the form. gh keeps its own login; Git Baba never sees that token.
                  </p>
                  <button className="btn primary" disabled={busy} onClick={() => void runCli()}>
                    {busy ? 'Creating…' : 'Create pull request with gh'}
                  </button>
                </>
              ) : (
                <ol className="fix-steps">
                  {!diag.cli.installed && (
                    <li>
                      Install the GitHub CLI.{' '}
                      <button className="btn sm" onClick={() => open('https://cli.github.com/')}>
                        Open cli.github.com ↗
                      </button>
                    </li>
                  )}
                  <li>
                    In a terminal, sign in: <code>gh auth login --hostname {diag.host}</code>{' '}
                    <button className="btn sm ghost" onClick={() => copy(`gh auth login --hostname ${diag.host}`, 'Command')}>
                      ⧉
                    </button>
                  </li>
                  <li>
                    <button className="btn sm primary" onClick={() => void diagnose()}>
                      I'm done — check again
                    </button>
                  </li>
                </ol>
              )}
            </FixCard>

            <FixCard id="token" active={fix} set={setFix} icon="🔑" title="Give Git Baba a token that is allowed" badge={!diag.cli.loggedIn ? 'Recommended' : null} sub="Fixes it permanently for this account. Git Baba asks for the new token.">
              {tokenStep === 1 ? (
                <ol className="fix-steps">
                  <li>
                    Open GitHub's token page. Git Baba fills in what is needed:
                    <ul className="small">
                      <li>
                        Resource owner: <strong>{diag.owner}</strong>
                      </li>
                      <li>
                        Repository access: <strong>Only select repositories → {diag.name}</strong> (pick it yourself)
                      </li>
                      <li>
                        Permissions: <strong>Pull requests: Read and write</strong>, <strong>Contents: Read and write</strong>
                      </li>
                    </ul>
                    <button className="btn sm primary" onClick={() => open(tokenUrl(diag))}>
                      Open token page on GitHub ↗
                    </button>
                  </li>
                  <li>Click “Generate token” and copy it.</li>
                  {diag.ownerType === 'Organization' && <li className="small muted">If {diag.owner} requires approval, the token stays “pending” until an owner approves it — see “Ask an organisation owner”.</li>}
                  <li>
                    <button className="btn sm" onClick={() => setTokenStep(2)}>
                      I have the new token →
                    </button>
                  </li>
                </ol>
              ) : (
                <div className="stack">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Paste the new token for {diag.login}</label>
                    <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_… or ghp_…" autoFocus spellCheck={false} autoComplete="off" />
                    <span className="hint">Checked against GitHub first. It must belong to {diag.login}. Saved encrypted in the OS keychain so you stay signed in.</span>
                  </div>
                  {stillFailing && <ErrorPanel error={stillFailing} />}
                  <div className="row">
                    <button className="btn ghost" onClick={() => setTokenStep(1)} disabled={busy}>
                      ← Back
                    </button>
                    <span className="spacer" />
                    <button className="btn primary" disabled={busy || token.trim().length < 20 || !session} onClick={() => void useNewToken()}>
                      {busy ? 'Verifying…' : 'Use this token & create pull request'}
                    </button>
                  </div>
                </div>
              )}
            </FixCard>

            <FixCard id="app" active={fix} set={setFix} icon="🤖" title="Use a GitHub App" sub="If your organisation installs a GitHub App for this repository.">
              <p className="small">Git Baba will ask for the App ID and its private key (.pem), create a short-lived installation token, and revoke it afterwards.</p>
              <button
                className="btn primary"
                onClick={() => {
                  onClose();
                  useGitHubApp();
                }}
              >
                Continue with a GitHub App…
              </button>
            </FixCard>

            <FixCard id="admin" active={fix} set={setFix} icon="✉" title="Ask an organisation owner" sub="When the token is pending approval or your role is too low.">
              <pre className="admin-msg">{adminText}</pre>
              <div className="row">
                <button className="btn sm" onClick={() => copy(adminText, 'Message')}>
                  ⧉ Copy message
                </button>
                <button className="btn sm ghost" onClick={() => open(`https://${diag.host}/${diag.owner}/${diag.name}`)}>
                  Open repository ↗
                </button>
              </div>
            </FixCard>
          </div>
          <p className="small muted mt">An SSH key would not help here: SSH can push your branch, but GitHub only creates pull requests through its API, which needs a token, a GitHub App or the gh CLI.</p>
        </div>
      )}
    </Modal>
  );
}

function FixCard({ id, active, set, icon, title, sub, badge, children }: { id: Fix; active: Fix | null; set: (f: Fix) => void; icon: string; title: string; sub: string; badge?: string | null; children: React.ReactNode }) {
  const open = active === id;
  return (
    <div className={`fix-card ${open ? 'open' : ''}`}>
      <div className="fix-head" onClick={() => set(id)}>
        <span className="fix-icon">{icon}</span>
        <div className="grow">
          <div>
            <strong>{title}</strong> {badge && <span className="badge ok">{badge}</span>}
          </div>
          <div className="small muted">{sub}</div>
        </div>
        <span className="muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="fix-body">{children}</div>}
    </div>
  );
}
