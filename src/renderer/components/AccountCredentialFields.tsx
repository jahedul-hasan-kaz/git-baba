import { useEffect, useState } from 'react';
import type { AccountCredentialInput, AccountSummary, CliAccountsStatus } from '../../shared/types';
import { detectTokenKind } from '../../shared/tokenKind';
import { AddAccountDialog } from '../dialogs/AddAccountDialog';
import { call } from '../services/api';

interface Props {
  account: AccountSummary;
  encryptionAvailable: boolean;
  /** What the token is needed for, e.g. "create this repository". */
  purpose: string;
  onChange: (credential: AccountCredentialInput | null) => void;
  /** How long the token is kept in memory; defaults to a single operation. */
  retention?: string;
}

type Source = 'remembered' | 'cli' | 'token';

/** gh status per API base, shared by every form for a short while (running gh takes ~0.5 s). */
const cliCache = new Map<string, { at: number; p: Promise<CliAccountsStatus | null> }>();
function cliStatusFor(apiBaseUrl: string | undefined, fresh = false): Promise<CliAccountsStatus | null> {
  const k = apiBaseUrl ?? '';
  const hit = cliCache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = call('accounts:cliStatus', { apiBaseUrl }).catch(() => null);
  cliCache.set(k, { at: Date.now(), p });
  return p;
}

/**
 * Credential for ONE operation of a specific GitHub account. Sources, best first:
 *  - the credential the user explicitly chose to remember (OS keychain),
 *  - the GitHub CLI's sign-in for this login (after "Sign in with browser"; read in main only),
 *  - a token typed now (used for this operation and kept encrypted in the OS keychain so the account stays signed in).
 */
export function AccountCredentialFields({ account, encryptionAvailable, purpose, onChange, retention = 'used for this operation, then removed from memory' }: Props) {
  const [cli, setCli] = useState<CliAccountsStatus | null>(null);
  const [source, setSource] = useState<Source>(account.remembered ? 'remembered' : 'token');
  const [token, setToken] = useState('');
  const remember = true; // always kept (OS keychain) so the account stays signed in
  const [browser, setBrowser] = useState(false);
  const cliHas = !!cli?.logins.some((l) => l.toLowerCase() === account.login.toLowerCase());

  useEffect(() => {
    let alive = true;
    void cliStatusFor(account.apiBaseUrl).then((s) => {
      if (!alive) return;
      setCli(s);
      // Prefer the GitHub CLI sign-in over typing a token when nothing is remembered.
      if (s?.logins.some((l) => l.toLowerCase() === account.login.toLowerCase())) setSource((cur) => (cur === 'token' && !account.remembered ? 'cli' : cur));
    });
    return () => {
      alive = false;
    };
  }, [account.apiBaseUrl, account.login, account.remembered]);

  useEffect(() => {
    if (source === 'remembered' && account.remembered) onChange({ accountId: account.id, useRemembered: true });
    else if (source === 'cli' && cliHas) onChange({ accountId: account.id, useCli: true, remember });
    else if (source === 'token' && token.trim()) onChange({ accountId: account.id, token: token.trim(), remember });
    else onChange(null);
  }, [source, token, account, onChange, cliHas]);

  const sources: { id: Source; label: string; show: boolean }[] = [
    { id: 'remembered', label: '🔑 Remembered', show: account.remembered },
    { id: 'cli', label: '🌐 Browser sign-in', show: cliHas },
    { id: 'token', label: '🎫 Token', show: true },
  ];
  const visible = sources.filter((s) => s.show);
  const kind = detectTokenKind(token);

  return (
    <div className="auth-form">
      <div className="row mb">
        <span className="badge info">GitHub account</span>
        <strong>{account.login}</strong>
        {account.name && <span className="muted small">{account.name}</span>}
        {account.method === 'ssh' && <span className="badge warn" title="Added with an SSH key — GitHub’s API needs a token or browser sign-in">SSH only</span>}
      </div>
      {visible.length > 1 && (
        <div className="ax-seg mb" role="radiogroup" aria-label="Credential">
          {visible.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={source === s.id} className={source === s.id ? 'on' : ''} onClick={() => setSource(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      {source === 'remembered' && account.remembered && <div className="small muted">Signed in as {account.login} (saved in the OS keychain).</div>}
      {source === 'cli' && cliHas && (
        <div className="small muted">
          Uses the GitHub CLI sign-in of {account.login} on {cli?.host}. Git Baba checks it belongs to {account.login}; {retention}.
        </div>
      )}
      {source === 'token' && (
        <div className="field">
          <label>Personal access token for {account.login}</label>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… or github_pat_…" autoComplete="off" spellCheck={false} autoFocus />
          {kind && kind.kind !== 'classic' && kind.kind !== 'fine-grained' ? (
            <span className={`ax-kind ${kind.usable ? 'ok' : 'bad'}`}>
              {kind.usable ? '✓' : '✕'} {kind.label} — {kind.hint}
            </span>
          ) : (
            <span className="hint">
              {kind ? `${kind.label} · ` : ''}Needed to {purpose}. It is checked against GitHub to make sure it belongs to {account.login}, {retention}.
            </span>
          )}
          {cli && (
            <span className="hint">
              No token at hand?{' '}
              <button type="button" className="ax-linkbtn" onClick={() => setBrowser(true)}>
                Sign in with browser instead
              </button>
            </span>
          )}
        </div>
      )}
      {browser && (
        <AddAccountDialog
          account={account}
          initial="browser"
          onClose={() => setBrowser(false)}
          onAdded={() => {
            void cliStatusFor(account.apiBaseUrl, true).then((s) => {
              setCli(s);
              setSource('cli');
            });
          }}
        />
      )}
    </div>
  );
}
