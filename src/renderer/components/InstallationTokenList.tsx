import { useCallback, useEffect, useState } from 'react';
import type { InstallationTokenRecord, TokenSource, TokenStatus } from '../../shared/types';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

const STATUS: Record<TokenStatus, { label: string; cls: string; help: string }> = {
  active: { label: 'Active', cls: 'warn', help: 'Valid on GitHub right now. Revoke it when you no longer need it.' },
  revoked: { label: 'Revoked', cls: 'ok', help: 'GitHub confirmed the revocation. The token can no longer be used.' },
  expired: { label: 'Expired', cls: '', help: "Past GitHub's 1-hour lifetime; it no longer works." },
  'revoke-failed': { label: 'Revoke failed', cls: 'danger', help: 'GitHub could not be reached to revoke it. Retry, or it stops working when it expires.' },
};

const SOURCE: Record<TokenSource, string> = {
  'token-page': 'Generated on this page',
  dialog: 'Generated in an auth dialog',
  operation: 'Created for one operation',
  pasted: 'Pasted by you',
};

function remaining(iso: string, now: number): string {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  if (s <= 0) return 'expired';
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

/**
 * Installation tokens of this session with live status. GitHub has no API to list
 * installation tokens and Git Baba never stores them on disk, so this is every token
 * this app generated or used since it started. Only masked values are shown.
 */
export function InstallationTokenList({ reloadKey }: { reloadKey: number }) {
  const { toast, showError } = useApp();
  const [tokens, setTokens] = useState<InstallationTokenRecord[] | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<InstallationTokenRecord | 'all' | null>(null);
  const [filter, setFilter] = useState<'all' | 'active'>('all');

  const load = useCallback(async () => {
    try {
      setTokens(await call('github:tokenList'));
    } catch (err) {
      showError(err);
    }
  }, [showError]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Live countdown; reload periodically so automatic revocations and expiries show up.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void load(), 5000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [load]);

  const live = (t: InstallationTokenRecord): TokenStatus => (t.status === 'active' && new Date(t.expiresAt).getTime() <= now ? 'expired' : t.status);
  const list = tokens ?? [];
  const revocable = list.filter((t) => live(t) === 'active' || live(t) === 'revoke-failed');
  const finished = list.filter((t) => live(t) === 'revoked' || live(t) === 'expired');
  const shown = filter === 'active' ? revocable : list;

  const revokeOne = async (t: InstallationTokenRecord) => {
    setBusy(t.id);
    try {
      const r = await call('github:tokenRevoke', { id: t.id, confirmed: true });
      if (r.status === 'revoked') toast(`Token ${t.masked} revoked on GitHub`);
      else toast(`Could not reach GitHub to revoke ${t.masked}. Try again; it expires within the hour regardless.`, 'warning');
    } catch (err) {
      showError(err);
    } finally {
      setBusy(null);
      await load();
    }
  };

  const revokeAll = async () => {
    setBusy('all');
    try {
      const r = await call('github:tokenRevokeAll', { confirmed: true });
      setTokens(r.tokens);
      if (r.failed) toast(`${r.revoked} revoked, ${r.failed} could not be revoked (GitHub unreachable). Retry them, or they expire within the hour.`, 'warning');
      else toast(r.revoked ? `All ${r.revoked} active token(s) revoked` : 'No active tokens to revoke', r.revoked ? 'success' : 'info');
    } catch (err) {
      showError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <div className="row mb">
        <h3 className="grow" style={{ margin: 0 }}>
          Installation tokens <span className="badge">{list.length}</span> {revocable.length > 0 && <span className="badge warn">{revocable.length} active</span>}
        </h3>
        <div className="segmented">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          <button className={filter === 'active' ? 'on' : ''} onClick={() => setFilter('active')}>
            Active
          </button>
        </div>
        <button className="btn sm ghost" onClick={() => void load()} title="Refresh">
          ⟳
        </button>
        {finished.length > 0 && (
          <button className="btn sm" disabled={!!busy} onClick={() => call('github:tokenClearFinished').then(setTokens).catch(showError)} title="Remove revoked and expired tokens from this list">
            Clear finished
          </button>
        )}
        <button className="btn sm danger" disabled={!!busy || revocable.length === 0} onClick={() => setConfirm('all')}>
          {busy === 'all' ? 'Revoking…' : `Revoke all${revocable.length ? ` (${revocable.length})` : ''}`}
        </button>
      </div>
      <p className="small muted">
        Every installation token Git Baba generated or used since it started. Tokens are never saved to disk and GitHub cannot list them, so after a restart this list starts empty. Only masked
        values are shown here.
      </p>

      {tokens === null ? (
        <div className="small muted">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="empty small">{filter === 'active' ? '✓ No active installation tokens.' : 'No installation tokens in this session yet.'}</div>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Token</th>
              <th>Status</th>
              <th>Repository &amp; permissions</th>
              <th>Created</th>
              <th>GitHub expiry</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => {
              const st = live(t);
              const info = STATUS[st];
              return (
                <tr key={t.id}>
                  <td>
                    <span className="mono">{t.masked}</span>
                    <div className="small muted">
                      {SOURCE[t.source]}
                      {t.appId ? ` · App ${t.appId}` : ''}
                      {t.usedFor.length ? ` · used for ${t.usedFor.join(', ')}` : ''}
                    </div>
                  </td>
                  <td title={info.help}>
                    <span className={`badge ${info.cls}`}>{st === 'revoked' ? '✓ ' : ''}{info.label}</span>
                    {t.revokedAt && st === 'revoked' && <div className="small muted">{new Date(t.revokedAt).toLocaleTimeString()}</div>}
                    {st === 'revoke-failed' && t.lastError && <div className="small text-danger">{t.lastError}</div>}
                  </td>
                  <td className="small">
                    {t.repositories.join(', ') || '—'}
                    <div className="muted">
                      {Object.entries(t.permissions)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(', ') || '—'}
                    </div>
                  </td>
                  <td className="small muted">{new Date(t.createdAt).toLocaleTimeString()}</td>
                  <td className="small muted">{st === 'active' || st === 'revoke-failed' ? `in ${remaining(t.expiresAt, now)}` : new Date(t.expiresAt).toLocaleTimeString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    {(st === 'active' || st === 'revoke-failed') && (
                      <button className="btn sm danger" disabled={!!busy} onClick={() => setConfirm(t)}>
                        {busy === t.id ? 'Revoking…' : st === 'revoke-failed' ? 'Retry revoke' : 'Revoke'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm === 'all' ? 'Revoke All Active Tokens' : 'Revoke Installation Token'}
          explanation={
            confirm === 'all' ? (
              <>Revokes all {revocable.length} active installation token(s) on GitHub.</>
            ) : (
              <>
                Revokes <span className="mono">{confirm.masked}</span> ({confirm.repositories.join(', ') || 'repository unknown'}) on GitHub.
              </>
            )
          }
          impact="Anything still using the token (another tool, a script, a dialog that is open) stops working immediately. This cannot be undone — generate a new token if you need one."
          affected={confirm === 'all' ? revocable.map((t) => `${t.masked} — ${t.repositories.join(', ')}`) : undefined}
          confirmLabel={confirm === 'all' ? `Revoke ${revocable.length} token(s)` : 'Revoke token'}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm;
            setConfirm(null);
            if (c === 'all') await revokeAll();
            else await revokeOne(c);
          }}
        />
      )}
    </div>
  );
}
