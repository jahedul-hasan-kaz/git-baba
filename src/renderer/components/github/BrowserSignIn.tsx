import { useEffect, useRef, useState } from 'react';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';
import { Spinner } from '../Modal';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'code'; loginId: string; code: string; url: string }
  | { kind: 'done'; login: string | null }
  | { kind: 'error'; message: string };

/**
 * "Sign in with GitHub" through the browser (GitHub's device flow, run by the GitHub CLI).
 * The user types their username, password and 2FA / one-time code on github.com — GitHub does not
 * allow apps to collect passwords, so Git Baba only shows the short device code.
 */
export function BrowserSignIn({ repoId, onDone, compact }: { repoId: string; onDone: () => void; compact?: boolean }) {
  const { toast, showError } = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [cli, setCli] = useState<{ installed: boolean; loggedIn: boolean; login: string | null; host: string } | null>(null);
  const live = useRef(true);

  const check = () =>
    call('gh:cliStatus', { repoId })
      .then((s) => live.current && setCli(s))
      .catch(() => live.current && setCli({ installed: false, loggedIn: false, login: null, host: 'github.com' }));

  useEffect(() => {
    live.current = true;
    void check();
    return () => {
      live.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  // Never leave a sign-in process running when the card goes away.
  const running = phase.kind === 'code' ? phase.loginId : null;
  useEffect(() => () => void (running && call('gh:browserLoginCancel', { loginId: running }).catch(() => undefined)), [running]);

  const start = async () => {
    setPhase({ kind: 'starting' });
    try {
      const r = await call('gh:browserLoginStart', { repoId });
      setPhase({ kind: 'code', ...r });
      void call('app:copyText', { text: r.code }).catch(() => undefined);
      void call('shell:openExternal', { url: r.url }).catch(() => undefined);
      const res = await call('gh:browserLoginWait', { loginId: r.loginId });
      if (!live.current) return;
      if (res.ok) {
        setPhase({ kind: 'done', login: res.login });
        toast(`Signed in to GitHub${res.login ? ` as ${res.login}` : ''}`);
        setTimeout(onDone, 700);
      } else setPhase({ kind: 'error', message: res.message || 'Sign-in was not completed.' });
    } catch (err) {
      if (live.current) setPhase({ kind: 'error', message: toFriendly(err).message });
    }
  };

  const cancel = () => {
    if (phase.kind === 'code') void call('gh:browserLoginCancel', { loginId: phase.loginId }).catch(showError);
    setPhase({ kind: 'idle' });
  };

  return (
    <div className={`bsi ${compact ? 'compact' : ''}`}>
      <div className="bsi-head">
        <span className="bsi-logo">🐙</span>
        <div className="grow">
          <strong>Sign in with GitHub</strong>
          <div className="small muted">Use your username, password and two-factor code on github.com. Git Baba never sees them.</div>
        </div>
        {cli?.loggedIn && phase.kind === 'idle' && <span className="badge ok">signed in{cli.login ? ` as ${cli.login}` : ''}</span>}
      </div>

      {phase.kind === 'idle' &&
        (cli && !cli.installed ? (
          <div className="bsi-body">
            <p className="small">Browser sign-in uses the free GitHub CLI. Install it once, then come back.</p>
            <div className="row">
              <button className="btn primary" onClick={() => void call('shell:openExternal', { url: 'https://cli.github.com/' })}>
                Install GitHub CLI ↗
              </button>
              <button className="btn" onClick={() => void check()}>
                I installed it — check again
              </button>
            </div>
          </div>
        ) : (
          <div className="bsi-body">
            <button className="btn primary bsi-go" onClick={() => void start()} disabled={!cli}>
              {cli?.loggedIn ? 'Sign in again / switch account' : 'Sign in with GitHub in your browser'}
            </button>
          </div>
        ))}

      {phase.kind === 'starting' && (
        <div className="bsi-body">
          <Spinner label="Asking GitHub for a sign-in code…" />
        </div>
      )}

      {phase.kind === 'code' && (
        <div className="bsi-body fade-in">
          <ol className="bsi-steps">
            <li>
              Your browser opened <strong>{phase.url.replace(/^https:\/\//, '')}</strong>.{' '}
              <a onClick={() => void call('shell:openExternal', { url: phase.url })}>Open it again</a>
            </li>
            <li>
              Enter this code (already copied):
              <div className="bsi-code" onClick={() => void call('app:copyText', { text: phase.code }).then(() => toast('Code copied'))} title="Click to copy">
                {phase.code.split('').map((ch, i) => (
                  <span key={i} className={ch === '-' ? 'dash' : ''}>
                    {ch}
                  </span>
                ))}
              </div>
            </li>
            <li>Sign in with your password and one-time code, then click “Authorize”.</li>
          </ol>
          <div className="row">
            <span className="pulse-dot" />
            <span className="small muted grow">Waiting for you to finish on GitHub…</span>
            <button className="btn sm cancel" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="bsi-body fade-in">
          <div className="bsi-done">✓ Signed in{phase.login ? ` as ${phase.login}` : ''}. Loading…</div>
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="bsi-body fade-in">
          <div className="small text-danger mb">{phase.message}</div>
          <button className="btn primary" onClick={() => void start()}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
