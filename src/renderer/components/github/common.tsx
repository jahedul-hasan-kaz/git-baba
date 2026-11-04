import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CheckState, GhLabel, GhRepoContext } from '../../../shared/github';
import type { AccountCredentialInput, FriendlyError } from '../../../shared/types';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';
import { AccountCredentialFields } from '../AccountCredentialFields';
import { ErrorPanel } from '../ErrorPanel';

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/** Loads GitHub data; reloads when deps change or the active account/session changes. */
export function useGh<T>(fn: () => Promise<T>, deps: unknown[]) {
  const { ghKey } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await fn();
      if (my === seq.current) setData(d);
    } catch (err) {
      if (my === seq.current) {
        setError(toFriendly(err));
        setData(null);
      }
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ghKey]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Runs a mutation with busy state, toast on success and error dialog on failure. */
export function useMutation() {
  const { toast, showError, refreshSession } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (err) {
        const f = toFriendly(err);
        showError(err, f.code === 'session-required' || f.code === 'session-expired' ? () => void refreshSession() : undefined);
        if (f.code === 'session-expired') void refreshSession();
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast, showError, refreshSession],
  );
  return { busy, run };
}

// ---------------------------------------------------------------------------
// Session gate
// ---------------------------------------------------------------------------

/**
 * GitHub features need the active account to be signed in. The token stays in main-process
 * memory only (until sign-out, app exit or 12 hours) — never written to disk.
 */
export function SessionGate({ children, what }: { children: ReactNode; what: string }) {
  const { activeAccount, accounts, session, refreshSession, setView, toast } = useApp();
  const [credential, setCredential] = useState<AccountCredentialInput | null>(null);
  const onCred = useCallback((c: AccountCredentialInput | null) => setCredential(c), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [key, setKey] = useState(0);

  if (!activeAccount) {
    return (
      <div className="content">
        <div className="empty">
          <h3>No GitHub account</h3>
          <p>Add a GitHub account to use {what}.</p>
          <button className="btn primary" onClick={() => setView('accounts')}>
            Manage accounts
          </button>
        </div>
      </div>
    );
  }
  if (session?.active) return <>{children}</>;

  const signIn = async () => {
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      await call('session:signIn', { credential });
      await refreshSession();
      toast(`Signed in as ${activeAccount.login} (session kept in memory only)`);
    } catch (err) {
      setError(toFriendly(err));
      setKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content">
      <div className="page" style={{ maxWidth: 620 }}>
        <div className="card">
          <h3>🔐 Sign in to {activeAccount.login}</h3>
          <p className="small">
            {what} load data from GitHub as the account selected in the header. Signing in starts a session that is held <strong>in memory only</strong> — it ends when you sign out, quit Git Baba, or
            after 12 hours. Nothing is written to disk unless you tick “Remember this credential”.
          </p>
          {error && <ErrorPanel error={error} />}
          <AccountCredentialFields key={key} account={activeAccount} encryptionAvailable={!!accounts?.encryptionAvailable} purpose={`sign in and use ${what}`}
            retention="then kept in memory only until you sign out, quit Git Baba or 12 hours pass"
            onChange={onCred}
          />
          <div className="row mt">
            <span className="small muted grow">Switch accounts in the header if this repository belongs to another account.</span>
            <button className="btn primary" disabled={!credential || busy} onClick={signIn}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repository context bar
// ---------------------------------------------------------------------------

export function GhContextBar({ ctx, extra }: { ctx: GhRepoContext; extra?: ReactNode }) {
  return (
    <div className="gh-context">
      <span>
        <strong>
          {ctx.owner}/{ctx.name}
        </strong>{' '}
        <span className="muted small">{ctx.isPrivate ? 'private' : 'public'}</span>
      </span>
      <span className="muted small">
        {ctx.via === 'gh' ? (
          <span title="Connected with your GitHub sign-in (GitHub CLI) because the account token cannot read this repository">
            🐙 connected as <strong>{ctx.account}</strong>
          </span>
        ) : (
          <>
            signed in as <strong>{ctx.account}</strong>
          </>
        )}{' '}
        · role {ctx.permissions.level.toLowerCase()}
      </span>
      {ctx.accountMismatch && (
        <span className="badge warn" title="This repository is associated with another account. Actions use the account selected in the header.">
          repo account: {ctx.accountMismatch}
        </span>
      )}
      <span className="spacer" />
      {extra}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small display components
// ---------------------------------------------------------------------------

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 172800) return 'yesterday';
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString();
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Avatar from initials (remote images are blocked by the content security policy on purpose). */
export function Avatar({ login, size = 20 }: { login: string | null | undefined; size?: number }) {
  const name = login ?? '?';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.45, background: `hsl(${h} 45% 40%)` }} title={name}>
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function LabelChip({ label, onRemove }: { label: Pick<GhLabel, 'name' | 'color'>; onRemove?: () => void }) {
  const c = `#${label.color || '888888'}`;
  return (
    <span className="label-chip" style={{ borderColor: c, color: c, background: `${c}22` }}>
      {label.name}
      {onRemove && (
        <button className="chip-x" onClick={onRemove} title="Remove">
          ×
        </button>
      )}
    </span>
  );
}

export function PrStateBadge({ state, isDraft }: { state: string; isDraft?: boolean }) {
  if (state === 'MERGED') return <span className="pr-state merged">⇋ Merged</span>;
  if (state === 'CLOSED') return <span className="pr-state closed">✕ Closed</span>;
  if (isDraft) return <span className="pr-state draft">◌ Draft</span>;
  return <span className="pr-state open">⇄ Open</span>;
}

export function ChecksIcon({ state }: { state: CheckState }) {
  if (!state) return null;
  const map: Record<string, [string, string, string]> = {
    SUCCESS: ['✓', 'ok', 'All checks passed'],
    FAILURE: ['✕', 'danger', 'Some checks failed'],
    ERROR: ['✕', 'danger', 'Some checks errored'],
    PENDING: ['●', 'warn', 'Checks in progress'],
    EXPECTED: ['●', 'warn', 'Waiting for checks'],
  };
  const [icon, cls, title] = map[state] ?? ['?', '', state];
  return (
    <span className={`text-${cls === 'ok' ? 'ok' : cls === 'danger' ? 'danger' : 'warn'}`} title={title}>
      {icon}
    </span>
  );
}

export function ReviewBadge({ decision }: { decision: string | null }) {
  if (!decision) return null;
  const map: Record<string, [string, string]> = {
    APPROVED: ['Approved', 'ok'],
    CHANGES_REQUESTED: ['Changes requested', 'danger'],
    REVIEW_REQUIRED: ['Review required', 'warn'],
  };
  const [label, cls] = map[decision] ?? [decision.toLowerCase(), ''];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/** Plain-text rendering of GitHub markdown (no HTML is ever injected). */
export function BodyText({ text, empty = 'No description provided.' }: { text: string; empty?: string }) {
  if (!text.trim()) return <div className="muted small" style={{ fontStyle: 'italic' }}>{empty}</div>;
  return <div className="md-text">{text}</div>;
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-list">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <div className="sk sk-a" />
          <div className="sk sk-b" />
        </div>
      ))}
    </div>
  );
}

export function Unavailable({ text }: { text: string }) {
  return (
    <div className="banner info">
      <span className="icon">ℹ</span>
      <div>{text}</div>
    </div>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const s = severity.toLowerCase();
  const cls = s === 'critical' || s === 'high' || s === 'error' ? 'danger' : s === 'medium' || s === 'moderate' || s === 'warning' ? 'warn' : 'info';
  return <span className={`badge ${cls}`}>{s}</span>;
}

// ---------------------------------------------------------------------------
// Picker: searchable single/multi select dropdown (GitHub-style sidebar menus)
// ---------------------------------------------------------------------------

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  color?: string;
}

interface PickerProps {
  title: string;
  options: PickerOption[];
  selected: string[];
  multi?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (values: string[]) => void;
  /** Optional "create" entry when the search matches nothing. */
  onCreate?: (query: string) => void;
  createLabel?: string;
  trigger?: ReactNode;
  allowClear?: boolean;
}

export function Picker({ title, options, selected, multi, disabled, disabledReason, onChange, onCreate, createLabel, trigger, allowClear }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<string[]>(selected);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setDraft(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const commit = useCallback(() => {
    setOpen(false);
    const a = [...draft].sort().join('\n');
    const b = [...selected].sort().join('\n');
    if (multi && a !== b) onChange(draft);
  }, [draft, selected, multi, onChange]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) commit();
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open, commit]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(t)) : options;
  }, [options, q]);

  const toggle = (v: string) => {
    if (!multi) {
      setOpen(false);
      onChange(selected[0] === v ? [] : [v]);
      return;
    }
    setDraft((d) => (d.includes(v) ? d.filter((x) => x !== v) : [...d, v]));
  };

  return (
    <div className="picker" ref={ref}>
      <button className="picker-trigger" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => (open ? commit() : setOpen(true))}>
        {trigger ?? (
          <>
            <span>{title}</span> <span className="muted">⚙</span>
          </>
        )}
      </button>
      {open && (
        <div className="dropdown picker-menu">
          <div className="dropdown-title">{title}</div>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" onKeyDown={(e) => e.key === 'Escape' && commit()} />
          <div className="picker-options">
            {allowClear && !multi && selected.length > 0 && (
              <div className="dropdown-item muted" onClick={() => (setOpen(false), onChange([]))}>
                Clear selection
              </div>
            )}
            {filtered.map((o) => {
              const on = (multi ? draft : selected).includes(o.value);
              return (
                <div key={o.value} className={`dropdown-item ${on ? 'active' : ''}`} onClick={() => toggle(o.value)}>
                  <span style={{ width: 14 }}>{on ? '✓' : ''}</span>
                  {o.color && <span className="dot" style={{ background: `#${o.color}` }} />}
                  <div className="grow">
                    <div>{o.label}</div>
                    {o.hint && <div className="small muted">{o.hint}</div>}
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && !onCreate && <div className="small muted" style={{ padding: 8 }}>No matches.</div>}
            {onCreate && q.trim() && !options.some((o) => o.label.toLowerCase() === q.trim().toLowerCase()) && (
              <div
                className="dropdown-item"
                onClick={() => {
                  onCreate(q.trim());
                  setQ('');
                }}
              >
                + {createLabel ?? 'Create'} “{q.trim()}”
              </div>
            )}
          </div>
          {multi && (
            <div className="row" style={{ padding: 6 }}>
              <span className="spacer" />
              <button className="btn sm primary" onClick={commit}>
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A labelled filter dropdown for list toolbars. */
export function FilterMenu({ label, value, options, onChange }: { label: string; value: string; options: PickerOption[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value);
  return (
    <Picker
      title={`Filter by ${label.toLowerCase()}`}
      options={options}
      selected={value ? [value] : []}
      allowClear
      onChange={(v) => onChange(v[0] ?? '')}
      trigger={
        <span className={`filter-trigger ${value ? 'on' : ''}`}>
          {label}
          {current ? `: ${current.label}` : ''} ▾
        </span>
      }
    />
  );
}
