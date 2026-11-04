import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GhGpgKey, GhSshKey, KeyListAccess, LocalGpgKey } from '../../../../shared/github';
import type { FriendlyError, SigningConfig, SshKeyType, SshLocalKey, SshTestResult } from '../../../../shared/types';
import { relTime, useGh, useMutation } from '../../../components/github/common';
import { openExternal, SecureActionDialog } from '../../../components/github/SecureActionDialog';
import { Modal } from '../../../components/Modal';
import { Select } from '../../../components/Select';
import { maskPublicKey } from '../../../components/SshKeyFields';
import { call, toFriendly } from '../../../services/api';
import { useApp } from '../../../state/AppState';
import {
  isGpgSigningKey,
  isSshSigningKey,
  keyBody,
  keyFileNameProblem,
  passphraseStrength,
  shortFingerprint,
  suggestKeyFileName,
  takenKeyNames,
} from './keyNames';

const USER_METHODS: ('session' | 'pat')[] = ['session', 'pat'];
const fileOf = (p: string) => p.replace(/^.*[\\/]/, '').replace(/\.pub$/i, '');
const shortType = (t: string) => t.replace(/^ssh-/, '').replace(/^ecdsa-sha2-nistp/, 'ecdsa-').replace(/@openssh\.com$/, '').replace(/^sk-ssh-/, 'sk-');

type Upload = { kind: 'ssh'; sshKind: GhSshKey['kind']; title: string; key: string } | { kind: 'gpg'; name: string; armored: string };
type Remove = { kind: 'ssh'; key: GhSshKey } | { kind: 'gpg'; key: GhGpgKey };
type SignTarget = { kind: 'ssh'; pubPath: string; name: string } | { kind: 'gpg'; keyId: string; name: string; gpgProgram: string | null };

/** SSH (authentication + signing) and GPG keys: one list per tab that shows where each key lives and what it does. */
export function KeysPage() {
  const [tab, setTab] = useState<'ssh' | 'gpg'>('ssh');
  const signing = useGh(() => call('ssh:signingConfig'), []);
  return (
    <div className="kx">
      <div className="kx-top">
        <div className="segmented">
          <button className={tab === 'ssh' ? 'on' : ''} onClick={() => setTab('ssh')}>
            🔑 SSH keys
          </button>
          <button className={tab === 'gpg' ? 'on' : ''} onClick={() => setTab('gpg')}>
            ✍ GPG keys
          </button>
        </div>
        <SigningSummary cfg={signing.data} />
      </div>
      {tab === 'ssh' ? <SshKeys signing={signing.data} reloadSigning={() => void signing.reload()} /> : <GpgKeys signing={signing.data} reloadSigning={() => void signing.reload()} />}
    </div>
  );
}

function SigningSummary({ cfg }: { cfg: SigningConfig | null }) {
  if (!cfg) return null;
  const label = !cfg.signingKey ? 'not set' : cfg.format === 'ssh' ? `SSH · ${fileOf(cfg.signingKey)}` : `${cfg.format === 'x509' ? 'X.509' : 'GPG'} · ${cfg.signingKey.slice(-8)}`;
  return (
    <span
      className={`kx-sigsum ${cfg.signingKey ? 'on' : ''}`}
      title={cfg.signingKey ? `git config --global\ngpg.format = ${cfg.format ?? 'openpgp'}\nuser.signingkey = ${cfg.signingKey}${cfg.gpgProgram ? `\ngpg.program = ${cfg.gpgProgram}` : ''}\ncommit.gpgsign = ${cfg.commitGpgSign}` : 'No global user.signingkey — commits are not signed.'}
    >
      <span className="kx-dot" /> Commit signing: <strong>{label}</strong>
      {cfg.signingKey && cfg.commitGpgSign && <span className="kx-mini">always</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

async function copyText(text: string, toast: (t: string) => void, what = 'Public key') {
  try {
    await call('app:copyText', { text });
    toast(`${what} copied`);
  } catch (err) {
    toast(toFriendly(err).message);
  }
}

/** Compact "GitHub keys are hidden" strip with the exact permissions to enable, a link to the token page and Retry. */
function AccessStrip({ access, onRetry, busy }: { access: KeyListAccess; onRetry: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const fine = access.tokenKind === 'fine-grained';
  const page = `${access.webBase}/settings/${fine ? 'personal-access-tokens' : 'tokens'}`;
  return (
    <div className="kx-strip warn" role="status">
      <div className="kx-strip-line">
        <span className="kx-strip-ico">🔒</span>
        <span className="grow">
          <strong>GitHub keys are hidden</strong> — your {fine ? 'fine-grained' : 'classic'} token can't read {access.missing.map((m) => m.label).join(' or ')}.{' '}
          <span className="kx-muted">Local keys still work.</span>
        </span>
        <button className="btn sm ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Less' : 'How to fix'}
        </button>
        <button className="btn sm" onClick={() => openExternal(page)} title={page}>
          Edit token ↗
        </button>
        <button className="btn sm" onClick={onRetry} disabled={busy}>
          {busy ? '…' : '↻ Retry'}
        </button>
      </div>
      {open && (
        <div className="kx-strip-more">
          <div>
            <span className="kx-k">Fine-grained</span> Account permissions →{' '}
            {access.missing.map((m) => (
              <code key={m.fineGrained} className="kx-code">
                {m.fineGrained}
              </code>
            ))}{' '}
            = <em>Read and write</em>
            {fine && (
              <button className="btn sm ghost kx-link" onClick={() => openExternal(`${access.webBase}/settings/personal-access-tokens`)}>
                open ↗
              </button>
            )}
          </div>
          <div>
            <span className="kx-k">Classic</span> scopes{' '}
            {access.missing.map((m) => (
              <code key={m.classic} className="kx-code">
                {m.classic}
              </code>
            ))}
            {!fine && (
              <button className="btn sm ghost kx-link" onClick={() => openExternal(`${access.webBase}/settings/tokens`)}>
                open ↗
              </button>
            )}
          </div>
          <div className="kx-muted">Save the token on GitHub, then press Retry — no need to sign in again. Meanwhile use “Copy &amp; open GitHub” to add keys by hand.</div>
        </div>
      )}
    </div>
  );
}

function ErrorStrip({ error, onRetry }: { error: FriendlyError; onRetry: () => void }) {
  return (
    <div className="kx-strip danger" role="alert">
      <div className="kx-strip-line">
        <span className="kx-strip-ico">⚠</span>
        <span className="grow">
          <strong>{error.title}</strong> — {error.message}
        </span>
        <button className="btn sm" onClick={onRetry}>
          ↻ Retry
        </button>
      </div>
    </div>
  );
}

/** Small popover menu anchored to a button. */
function Menu({ label, title, className = 'btn sm', items, disabled }: { label: ReactNode; title?: string; className?: string; disabled?: boolean; items: ({ label: ReactNode; hint?: string; onClick: () => void; danger?: boolean; disabled?: boolean } | null)[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="kx-menu-wrap" ref={ref}>
      <button className={className} title={title} disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {label}
      </button>
      {open && (
        <div className="kx-menu" role="menu">
          {items.filter(Boolean).map((it, i) => (
            <button
              key={i}
              role="menuitem"
              className={it!.danger ? 'danger' : ''}
              disabled={it!.disabled}
              onClick={() => {
                setOpen(false);
                it!.onClick();
              }}
            >
              <span>{it!.label}</span>
              {it!.hint && <small>{it!.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function NewKeyButton({ onGenerate, onPaste, disabled, disabledHint }: { onGenerate: () => void; onPaste: () => void; disabled?: boolean; disabledHint?: string }) {
  return (
    <span className="kx-split">
      <button className="btn sm primary" onClick={onGenerate} disabled={disabled} title={disabled ? disabledHint : 'Generate a new key on this computer'}>
        ＋ New key
      </button>
      <Menu
        className="btn sm primary kx-split-caret"
        label="▾"
        title="More ways to add a key"
        items={[
          { label: '✨ Generate on this computer', hint: disabled ? disabledHint : 'Recommended', onClick: onGenerate, disabled },
          { label: '📋 Paste an existing public key', hint: 'From another computer or a .pub file', onClick: onPaste },
        ]}
      />
    </span>
  );
}

function Where({ local, remote }: { local: boolean; remote: boolean | null }) {
  return (
    <span className="kx-where">
      <span className={`kx-loc ${local ? 'on' : ''}`} title={local ? 'On this computer' : 'Not on this computer'}>
        💻
      </span>
      <span className={`kx-loc ${remote ? 'on' : remote === null ? 'unknown' : ''}`} title={remote ? 'On GitHub' : remote === null ? 'GitHub list not readable' : 'Not on GitHub'}>
        ☁
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

interface SshRowData {
  id: string;
  body: string;
  local: SshLocalKey | null;
  auth: GhSshKey | null;
  sign: GhSshKey | null;
}

function SshKeys({ signing, reloadSigning }: { signing: SigningConfig | null; reloadSigning: () => void }) {
  const { toast } = useApp();
  const remote = useGh(() => call('gh:acctSshKeys'), []);
  const local = useGh(() => call('ssh:listKeys'), []);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [remove, setRemove] = useState<Remove | null>(null);
  const [generate, setGenerate] = useState(false);
  const [paste, setPaste] = useState(false);
  const [signTarget, setSignTarget] = useState<SignTarget | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const access = remote.data?.access ?? null;
  const missing = new Set((access?.missing ?? []).map((m) => m.fineGrained));
  const authReadable = !!remote.data && !missing.has('Git SSH keys');
  const signReadable = !!remote.data && !missing.has('SSH signing keys');
  const webBase = access?.webBase ?? 'https://github.com';

  const rows = useMemo(() => {
    const map = new Map<string, SshRowData>();
    const get = (body: string) => {
      let r = map.get(body);
      if (!r) map.set(body, (r = { id: body, body, local: null, auth: null, sign: null }));
      return r;
    };
    for (const k of local.data?.keys ?? []) get(keyBody(k.publicKey)).local = k;
    for (const k of remote.data?.authentication ?? []) get(keyBody(k.key)).auth = k;
    for (const k of remote.data?.signing ?? []) get(keyBody(k.key)).sign = k;
    return [...map.values()].sort((a, b) => Number(!!b.local) - Number(!!a.local) || (a.local ? fileOf(a.local.pubPath) : '').localeCompare(b.local ? fileOf(b.local.pubPath) : ''));
  }, [local.data, remote.data]);
  const remoteBodies = useMemo(() => new Set([...(remote.data?.authentication ?? []), ...(remote.data?.signing ?? [])].map((k) => keyBody(k.key))), [remote.data]);

  const reload = () => {
    void remote.reload();
    void local.reload();
  };
  const copyAndOpen = async (key: string) => {
    await copyText(key, toast, 'Public key');
    openExternal(`${webBase}/settings/ssh/new`);
  };
  const onLocal = (local.data?.keys ?? []).length;
  const onGitHub = rows.filter((r) => r.auth || r.sign).length;

  return (
    <div>
      <div className="kx-head">
        <span className="kx-counts">
          <strong>{rows.length}</strong> key{rows.length === 1 ? '' : 's'} <span className="kx-sep">·</span> 💻 {local.data ? onLocal : '…'} <span className="kx-sep">·</span> ☁ {remote.data ? (access && !access.ok && onGitHub === 0 ? '?' : onGitHub) : remote.error ? '?' : '…'}
        </span>
        <button className="btn sm ghost" onClick={reload} title="Refresh" aria-label="Refresh">
          ↻
        </button>
        <NewKeyButton onGenerate={() => setGenerate(true)} onPaste={() => setPaste(true)} />
      </div>
      {access && !access.ok && <AccessStrip access={access} onRetry={() => void remote.reload()} busy={remote.loading} />}
      {remote.error && <ErrorStrip error={remote.error} onRetry={() => void remote.reload()} />}
      {remote.data?.signingError && <div className="kx-note">Signing keys could not be read: {remote.data.signingError}</div>}
      {local.error && <ErrorStrip error={local.error} onRetry={() => void local.reload()} />}

      {!local.data && !local.error ? (
        <div className="kx-list">
          <div className="kx-row kx-skel" />
          <div className="kx-row kx-skel" />
        </div>
      ) : rows.length === 0 ? (
        <div className="kx-empty">
          No SSH keys yet. <button className="btn sm primary" onClick={() => setGenerate(true)}>✨ Generate one</button> — takes a few seconds.
        </div>
      ) : (
        <div className="kx-list">
          {rows.map((r) => (
            <SshRow
              key={r.id}
              r={r}
              isNew={!!fresh && r.local?.pubPath === fresh}
              authReadable={authReadable}
              signReadable={signReadable}
              isSigning={!!r.local && isSshSigningKey(signing?.format === 'ssh' ? signing.signingKey : null, r.local)}
              onUpload={(sshKind) => setUpload({ kind: 'ssh', sshKind, title: r.local ? r.local.comment || fileOf(r.local.pubPath) : r.auth?.title || r.sign?.title || 'Key', key: r.local?.publicKey ?? r.body })}
              onCopyOpen={() => void copyAndOpen(r.local?.publicKey ?? r.auth?.key ?? r.sign?.key ?? r.body)}
              onCopy={() => void copyText(r.local?.publicKey ?? r.auth?.key ?? r.sign?.key ?? r.body, toast)}
              onRemove={(k) => setRemove({ kind: 'ssh', key: k })}
              onSign={() => r.local && setSignTarget({ kind: 'ssh', pubPath: r.local.pubPath, name: fileOf(r.local.pubPath) })}
            />
          ))}
        </div>
      )}
      {local.data && <div className="kx-foot">Local keys are read from {local.data.directory}. Private keys never leave this computer.</div>}

      {generate && (
        <GenerateSshDialog
          taken={takenKeyNames((local.data?.keys ?? []).map((k) => k.pubPath))}
          remoteBodies={remoteBodies}
          canUseApi={authReadable}
          onClose={() => setGenerate(false)}
          onCreated={(k) => {
            setFresh(k.pubPath);
            void local.reload();
          }}
          onUpload={(k, sshKind) => setUpload({ kind: 'ssh', sshKind, title: k.comment || fileOf(k.pubPath), key: k.publicKey })}
          onCopyOpen={(k) => void copyAndOpen(k.publicKey)}
          onCopy={(k) => void copyText(k.publicKey, toast)}
          onSign={(k) => setSignTarget({ kind: 'ssh', pubPath: k.pubPath, name: fileOf(k.pubPath) })}
          signing={signing}
        />
      )}
      {paste && (
        <PasteKeyDialog
          kind="ssh"
          onClose={() => setPaste(false)}
          onNext={(u) => {
            setPaste(false);
            setUpload(u);
          }}
        />
      )}
      {upload && <UploadDialog upload={upload} onClose={() => setUpload(null)} onDone={reload} />}
      {remove && <RemoveDialog remove={remove} onClose={() => setRemove(null)} onDone={reload} />}
      {signTarget && <UseForSigningDialog target={signTarget} current={signing} onClose={() => setSignTarget(null)} onDone={reloadSigning} />}
    </div>
  );
}

function SshRow({
  r,
  isNew,
  authReadable,
  signReadable,
  isSigning,
  onUpload,
  onCopyOpen,
  onCopy,
  onRemove,
  onSign,
}: {
  r: SshRowData;
  isNew: boolean;
  authReadable: boolean;
  signReadable: boolean;
  isSigning: boolean;
  onUpload: (kind: GhSshKey['kind']) => void;
  onCopyOpen: () => void;
  onCopy: () => void;
  onRemove: (k: GhSshKey) => void;
  onSign: () => void;
}) {
  const [open, setOpen] = useState(isNew);
  const [testing, setTesting] = useState(false);
  const k = r.local;
  const type = shortType(k?.type ?? r.body.split(' ')[0]);
  const name = k ? fileOf(k.pubPath) : r.auth?.title || r.sign?.title || 'Untitled key';
  const ghTitle = r.auth?.title || r.sign?.title || '';
  const fp = useFingerprint(k?.fingerprint ?? null, r.body);
  const canPrivate = !!k?.match;
  const remoteKnown = authReadable || signReadable;
  const onGh = r.auth || r.sign ? true : remoteKnown ? false : null;
  const added = r.auth?.createdAt ?? r.sign?.createdAt ?? null;
  return (
    <div className={`kx-row ${open ? 'open' : ''} ${isNew ? 'new' : ''}`}>
      <div className="kx-main" onClick={() => setOpen((o) => !o)}>
        <button
          className="kx-caret"
          aria-expanded={open}
          aria-label={open ? 'Hide details' : 'Show details'}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          ▸
        </button>
        <Where local={!!k} remote={onGh} />
        <span className="kx-type">{type}</span>
        <span className="kx-name" title={k?.pubPath ?? ghTitle}>
          {name}
        </span>
        {k && ghTitle && ghTitle !== name && <span className="kx-sub">“{ghTitle}”</span>}
        {isNew && <span className="kx-chip accent">new</span>}
        {r.auth && <span className="kx-chip ok">auth</span>}
        {r.sign && <span className="kx-chip ok">signing</span>}
        {isSigning && (
          <span className="kx-chip accent" title="git config --global user.signingkey">
            ✍ commit signing
          </span>
        )}
        {k && !canPrivate && (
          <span className="kx-chip warn" title="The private key file is not next to this .pub file">
            no private key
          </span>
        )}
        {k?.match?.encrypted && (
          <span className="kx-chip" title="Protected by a passphrase">
            🔒
          </span>
        )}
        {k && onGh === false && <span className="kx-chip warn">not on GitHub</span>}
        <span className="kx-fp" title={k?.fingerprint ?? fp ?? ''}>
          {fp ? shortFingerprint(fp) : ''}
        </span>
        <span className="kx-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn sm ghost" onClick={onCopy} title="Copy public key">
            ⧉ Copy
          </button>
          {canPrivate && (
            <button
              className="btn sm ghost"
              onClick={() => {
                setOpen(true);
                setTesting(true);
              }}
              title="ssh -T git@github.com with this key"
            >
              ⚡ Test
            </button>
          )}
          {k && (!r.auth || !r.sign) && (
            <Menu
              label="⬆ GitHub ▾"
              title="Add this key to your GitHub account"
              items={[
                !r.auth ? { label: 'Add as authentication key', hint: authReadable ? 'Push & pull over SSH' : 'Via API — needs a token with “Git SSH keys”', onClick: () => onUpload('authentication') } : null,
                !r.sign ? { label: 'Add as signing key', hint: signReadable ? 'Shows “Verified” on commits' : 'Via API — needs “SSH signing keys”', onClick: () => onUpload('signing') } : null,
                { label: 'Copy & open GitHub ↗', hint: 'Always works — paste it on github.com', onClick: onCopyOpen },
              ]}
            />
          )}
          {canPrivate && !isSigning && (
            <button className="btn sm ghost" onClick={onSign} title="Sign your commits with this key (global git config)">
              ✍ Sign
            </button>
          )}
          {(r.auth || r.sign) && (
            <Menu
              className="btn sm ghost kx-danger"
              label="🗑"
              title="Remove from GitHub"
              items={[
                r.auth && !r.auth.readOnly ? { label: 'Remove authentication key from GitHub', onClick: () => onRemove(r.auth!), danger: true } : null,
                r.sign ? { label: 'Remove signing key from GitHub', onClick: () => onRemove(r.sign!), danger: true } : null,
              ]}
            />
          )}
        </span>
      </div>
      {open && (
        <div className="kx-detail">
          <div className="kx-kv">
            {k && (
              <>
                <span>File</span>
                <code>{k.pubPath}</code>
              </>
            )}
            {(k?.fingerprint || fp) && (
              <>
                <span>Fingerprint</span>
                <code>{k?.fingerprint ?? fp}</code>
              </>
            )}
            <span>Public key</span>
            <code className="kx-ellipsis">{maskPublicKey(k?.publicKey ?? r.auth?.key ?? r.sign?.key ?? r.body)}</code>
            {added && (
              <>
                <span>On GitHub</span>
                <span>
                  added {relTime(added)}
                  {ghTitle ? ` as “${ghTitle}”` : ''}
                  {r.auth?.readOnly ? ' · read-only (deploy)' : ''}
                </span>
              </>
            )}
          </div>
          {canPrivate && k && (testing || r.auth) && <TestConnection k={k} autoFocus={testing} />}
          {canPrivate && k && !testing && !r.auth && (
            <div className="kx-hint">
              Not an authentication key on GitHub yet — add it, then{' '}
              <button className="btn sm ghost kx-link" onClick={() => setTesting(true)}>
                test the connection
              </button>
              .
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** SHA256 fingerprint for keys that only exist on GitHub (computed from the public key blob). */
function useFingerprint(known: string | null, body: string): string | null {
  const [fp, setFp] = useState<string | null>(known);
  useEffect(() => {
    if (known) {
      setFp(known);
      return;
    }
    let live = true;
    try {
      const b64 = body.split(' ')[1] ?? '';
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      void crypto.subtle.digest('SHA-256', bin).then((d) => {
        if (live) setFp(`SHA256:${btoa(String.fromCharCode(...new Uint8Array(d))).replace(/=+$/, '')}`);
      });
    } catch {
      setFp(null);
    }
    return () => {
      live = false;
    };
  }, [known, body]);
  return fp;
}

/** "Test connection" — ssh -T with exactly this key; a passphrase is asked for this one test and then forgotten. */
function TestConnection({ k, autoFocus }: { k: SshLocalKey; autoFocus?: boolean }) {
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SshTestResult | { ok: false; message: string; reason: 'error'; detail: string; login: null; via: null } | null>(null);
  const needsPass = !!k.match?.encrypted;
  const run = async () => {
    setBusy(true);
    setRes(null);
    try {
      setRes(await call('ssh:testConnection', { pubPath: k.pubPath, passphrase: needsPass ? pass : undefined }));
    } catch (err) {
      const f = toFriendly(err);
      setRes({ ok: false, message: f.message, reason: 'error', detail: f.technical ?? '', login: null, via: null });
    } finally {
      setPass('');
      setBusy(false);
    }
  };
  useEffect(() => {
    if (autoFocus && !needsPass) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="kx-test">
      <span className="kx-k">Connection</span>
      {needsPass && (
        <input
          className="kx-pass"
          type="password"
          placeholder="Key passphrase (used once)"
          value={pass}
          autoFocus={autoFocus}
          autoComplete="off"
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && pass && void run()}
        />
      )}
      <button className="btn sm" disabled={busy || (needsPass && !pass)} onClick={() => void run()}>
        {busy ? 'Testing…' : res ? '↻ Test again' : '⚡ Test connection'}
      </button>
      {busy && <span className="kx-muted">ssh -T git@github.com…</span>}
      {res && (
        <span className={`kx-result ${res.ok ? 'ok' : 'bad'}`} title={res.detail || undefined}>
          {res.ok ? `✓ ${res.message}` : `✕ ${res.message}`}
        </span>
      )}
    </div>
  );
}

const SSH_TYPES: { id: SshKeyType; label: string; desc: string }[] = [
  { id: 'ed25519', label: 'ed25519', desc: 'Recommended · short & fast' },
  { id: 'ecdsa', label: 'ecdsa', desc: 'P-521 curve' },
  { id: 'rsa', label: 'rsa 4096', desc: 'For old servers' },
];

function Stepper({ steps, at }: { steps: string[]; at: number }) {
  return (
    <div className="kx-steps">
      {steps.map((s, i) => (
        <span key={s} className={`kx-step ${i < at ? 'done' : i === at ? 'on' : ''}`}>
          <span className="kx-step-n">{i < at ? '✓' : i + 1}</span>
          {s}
        </span>
      ))}
    </div>
  );
}

function StrengthMeter({ pass }: { pass: string }) {
  const s = passphraseStrength(pass);
  return (
    <div className={`kx-meter s${s.score}`} aria-label={`Passphrase strength: ${s.label}`}>
      <span />
      <span />
      <span />
      <em>{s.label}</em>
    </div>
  );
}

function GenerateSshDialog({
  taken,
  remoteBodies,
  canUseApi,
  signing,
  onClose,
  onCreated,
  onUpload,
  onCopyOpen,
  onCopy,
  onSign,
}: {
  taken: Set<string>;
  remoteBodies: Set<string>;
  canUseApi: boolean;
  signing: SigningConfig | null;
  onClose: () => void;
  onCreated: (k: SshLocalKey) => void;
  onUpload: (k: SshLocalKey, kind: GhSshKey['kind']) => void;
  onCopyOpen: (k: SshLocalKey) => void;
  onCopy: (k: SshLocalKey) => void;
  onSign: (k: SshLocalKey) => void;
}) {
  const { activeAccount } = useApp();
  const login = activeAccount?.login ?? null;
  const [step, setStep] = useState(0);
  const [type, setType] = useState<SshKeyType>('ed25519');
  // The taken set is a snapshot when the dialog opens, so the auto name does not jump after creating the key.
  const [takenAtOpen] = useState(taken);
  const [customName, setCustomName] = useState<string | null>(null);
  const fileName = customName ?? suggestKeyFileName(type, login, takenAtOpen);
  const [comment, setComment] = useState(login ? `${login}@git-baba` : 'git-baba');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [created, setCreated] = useState<SshLocalKey | null>(null);
  const [failure, setFailure] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const nameProblem = keyFileNameProblem(fileName, takenAtOpen);
  const passProblem = pass && pass.length < 5 ? 'At least 5 characters' : pass2 && pass !== pass2 ? 'Passphrases differ' : null;
  const passOk = !passProblem && pass === pass2;

  const generate = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const k = await call('ssh:generateKey', { type, fileName: fileName.trim(), comment: comment.trim(), passphrase: pass });
      setCreated(k);
      setStep(2);
      onCreated(k);
    } catch (err) {
      setFailure(toFriendly(err));
    } finally {
      setPass('');
      setPass2('');
      setBusy(false);
    }
  };

  const onGh = created ? remoteBodies.has(keyBody(created.publicKey)) : false;
  const isSigning = created ? isSshSigningKey(signing?.format === 'ssh' ? signing.signingKey : null, created) : false;

  return (
    <Modal
      title={step === 2 ? 'SSH key ready' : 'New SSH key'}
      icon={step === 2 ? '✅' : '🔑'}
      onClose={onClose}
      locked={busy}
      footer={
        step === 0 ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!!nameProblem} onClick={() => setStep(1)}>
              Next →
            </button>
          </>
        ) : step === 1 ? (
          <>
            <button className="btn" onClick={() => setStep(0)} disabled={busy}>
              ← Back
            </button>
            <span className="grow" />
            <button className="btn primary" disabled={busy || !passOk || !!nameProblem} onClick={() => void generate()}>
              {busy ? 'Generating…' : pass ? '🔒 Generate key' : 'Generate without passphrase'}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        )
      }
    >
      <Stepper steps={['Key', 'Protect', 'Use it']} at={step} />
      {step === 0 && (
        <>
          <div className="kx-types" role="radiogroup" aria-label="Key type">
            {SSH_TYPES.map((t) => (
              <button key={t.id} role="radio" aria-checked={type === t.id} className={`kx-type-tile ${type === t.id ? 'on' : ''}`} onClick={() => setType(t.id)}>
                <strong>{t.label}</strong>
                <small>{t.desc}</small>
              </button>
            ))}
          </div>
          <div className="grid-2">
            <div className={`field ${nameProblem ? 'invalid' : ''}`}>
              <label>
                File in ~/.ssh {customName === null && <span className="kx-mini">auto</span>}
              </label>
              <div className="kx-inline">
                <input value={fileName} onChange={(e) => setCustomName(e.target.value)} spellCheck={false} aria-invalid={!!nameProblem} />
                {customName !== null && (
                  <button className="btn sm ghost" onClick={() => setCustomName(null)} title="Use the suggested free name">
                    ↺
                  </button>
                )}
              </div>
              {nameProblem ? <div className="field-hint">{nameProblem}</div> : <div className="hint">Creates {fileName} and {fileName}.pub — nothing is overwritten.</div>}
            </div>
            <div className="field">
              <label>Label (comment)</label>
              <input value={comment} onChange={(e) => setComment(e.target.value)} spellCheck={false} />
              <div className="hint">Shown at the end of the public key.</div>
            </div>
          </div>
        </>
      )}
      {step === 1 && (
        <>
          <div className="grid-2">
            <div className={`field ${pass && pass.length < 5 ? 'invalid' : ''}`}>
              <label>Passphrase (optional)</label>
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" autoFocus />
              <StrengthMeter pass={pass} />
            </div>
            <div className={`field ${pass2 && pass !== pass2 ? 'invalid' : ''}`}>
              <label>Repeat</label>
              <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" disabled={!pass} onKeyDown={(e) => e.key === 'Enter' && passOk && !busy && void generate()} />
              {passProblem && pass2 && <div className="field-hint">{passProblem}</div>}
            </div>
          </div>
          <div className={`kx-note ${pass ? '' : 'warn'}`}>
            {pass ? 'ssh asks for it when the key is used; Git Baba never stores it.' : 'Without a passphrase, anyone who copies the key file can use it. Fine for a personal, encrypted disk.'}
          </div>
          <div className="kx-summary">
            <span className="kx-type">{type}</span> <code>~/.ssh/{fileName}</code> <span className="kx-muted">“{comment}”</span>
          </div>
          {failure && (
            <div className="kx-strip danger" role="alert">
              <div className="kx-strip-line">
                <span className="kx-strip-ico">⚠</span>
                <span className="grow">
                  <strong>{failure.title}</strong> — {failure.message}
                  {failure.technical && <span className="kx-muted"> ({failure.technical.split('\n')[0]})</span>}
                </span>
              </div>
            </div>
          )}
        </>
      )}
      {step === 2 && created && (
        <div className="kx-done">
          <div className="kx-done-key">
            <span className="kx-type">{shortType(created.type)}</span>
            <strong>{fileOf(created.pubPath)}</strong>
            <code className="kx-fp">{created.fingerprint}</code>
            <button className="btn sm ghost" onClick={() => onCopy(created)}>
              ⧉ Copy public key
            </button>
          </div>
          <ol className="kx-next">
            <li className={onGh ? 'done' : ''}>
              <span className="kx-next-t">{onGh ? '✓ On GitHub' : 'Add it to GitHub'}</span>
              {!onGh && (
                <span className="kx-next-a">
                  <button className="btn sm primary" onClick={() => onUpload(created, 'authentication')} title={canUseApi ? '' : 'Your session token cannot read SSH keys; you can use another token in the next step'}>
                    ⬆ Add for push/pull
                  </button>
                  <button className="btn sm" onClick={() => onUpload(created, 'signing')}>
                    ⬆ Add for signing
                  </button>
                  <button className="btn sm ghost" onClick={() => onCopyOpen(created)}>
                    ⧉ Copy &amp; open GitHub ↗
                  </button>
                </span>
              )}
            </li>
            <li>
              <span className="kx-next-t">Check it works</span>
              <TestConnection k={created} />
            </li>
            <li className={isSigning ? 'done' : ''}>
              <span className="kx-next-t">{isSigning ? '✓ Signs your commits' : 'Sign commits with it (optional)'}</span>
              {!isSigning && (
                <span className="kx-next-a">
                  <button className="btn sm" onClick={() => onSign(created)}>
                    ✍ Use for commit signing…
                  </button>
                </span>
              )}
            </li>
          </ol>
        </div>
      )}
    </Modal>
  );
}

function PasteKeyDialog({ kind, onClose, onNext }: { kind: 'ssh' | 'gpg'; onClose: () => void; onNext: (u: Upload) => void }) {
  const [title, setTitle] = useState('');
  const [key, setKey] = useState('');
  const [sshKind, setSshKind] = useState<GhSshKey['kind']>('authentication');
  const ok =
    kind === 'ssh'
      ? /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-[\w@.-]+) [A-Za-z0-9+/=]+/.test(key.trim()) && !/PRIVATE KEY/.test(key)
      : key.includes('BEGIN PGP PUBLIC KEY BLOCK') && !key.includes('PRIVATE KEY');
  const isPrivate = /PRIVATE KEY/.test(key);
  return (
    <Modal
      title={kind === 'ssh' ? 'Add an SSH public key' : 'Add a GPG public key'}
      icon="📋"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok || !title.trim()} onClick={() => onNext(kind === 'ssh' ? { kind: 'ssh', sshKind, title: title.trim(), key: key.trim() } : { kind: 'gpg', name: title.trim(), armored: key })}>
            Continue →
          </button>
        </>
      }
    >
      <div className="kx-inline mb">
        <div className={`field grow ${title.trim() ? '' : 'invalid'}`} style={{ marginBottom: 0 }}>
          <label>
            {kind === 'ssh' ? 'Title' : 'Name'} <span className="req">*</span>
          </label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'ssh' ? 'Work laptop' : 'Signing key'} autoFocus />
        </div>
        {kind === 'ssh' && (
          <div className="segmented" style={{ alignSelf: 'flex-end' }}>
            <button className={sshKind === 'authentication' ? 'on' : ''} onClick={() => setSshKind('authentication')}>
              Push/pull
            </button>
            <button className={sshKind === 'signing' ? 'on' : ''} onClick={() => setSshKind('signing')}>
              Signing
            </button>
          </div>
        )}
      </div>
      <div className={`field ${key && !ok ? 'invalid' : ''}`}>
        <label>
          Public key <span className="req">*</span>
        </label>
        <textarea className="code" rows={kind === 'ssh' ? 3 : 8} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" placeholder={kind === 'ssh' ? 'ssh-ed25519 AAAA… you@example.com' : '-----BEGIN PGP PUBLIC KEY BLOCK-----'} />
        {isPrivate && <div className="field-hint">That is a PRIVATE key — never share or upload it. Paste the public key.</div>}
      </div>
    </Modal>
  );
}

function UploadDialog({ upload, onClose, onDone }: { upload: Upload; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const needs =
    upload.kind === 'ssh'
      ? upload.sshKind === 'signing'
        ? 'the “SSH signing keys” account permission (fine-grained) or the admin:ssh_signing_key scope (classic)'
        : 'the “Git SSH keys” account permission (fine-grained) or the admin:public_key scope (classic)'
      : 'the “GPG keys” account permission (fine-grained) or the admin:gpg_key scope (classic)';
  return (
    <SecureActionDialog
      title={upload.kind === 'ssh' ? `Add SSH ${upload.sshKind} key to GitHub` : 'Add GPG key to GitHub'}
      icon="⬆"
      confirmLabel="Add to GitHub"
      repoId=""
      methods={USER_METHODS}
      needs={needs}
      onClose={onClose}
      onConfirm={async (auth) => {
        if (upload.kind === 'ssh') await call('gh:acctAddSshKey', { kind: upload.sshKind, title: upload.title, key: upload.key, auth, confirmed: true });
        else await call('gh:acctAddGpgKey', { name: upload.name, armored: upload.armored, auth, confirmed: true });
        toast('Key added to GitHub');
        onDone();
      }}
    >
      <div className="card">
        <dl className="kv">
          <dt>{upload.kind === 'ssh' ? 'Title' : 'Name'}</dt>
          <dd>{upload.kind === 'ssh' ? upload.title : upload.name}</dd>
          <dt>Key</dt>
          <dd className="mono small">{upload.kind === 'ssh' ? maskPublicKey(upload.key) : 'PGP public key block'}</dd>
          {upload.kind === 'ssh' && (
            <>
              <dt>Used for</dt>
              <dd>{upload.sshKind === 'signing' ? 'Signing commits and tags (shows “Verified”)' : 'Pushing and pulling over SSH'}</dd>
            </>
          )}
        </dl>
      </div>
    </SecureActionDialog>
  );
}

function RemoveDialog({ remove, onClose, onDone }: { remove: Remove; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const label = remove.kind === 'ssh' ? remove.key.title || 'this key' : remove.key.keyId;
  return (
    <SecureActionDialog
      title={remove.kind === 'ssh' ? `Delete SSH ${remove.key.kind} key` : 'Delete GPG key'}
      icon="🗑"
      danger
      confirmLabel="Delete from GitHub"
      repoId=""
      methods={USER_METHODS}
      needs={remove.kind === 'ssh' ? (remove.key.kind === 'signing' ? 'the “SSH signing keys” permission or admin:ssh_signing_key scope' : 'the “Git SSH keys” permission or admin:public_key scope') : 'the “GPG keys” permission or admin:gpg_key scope'}
      impact={
        remove.kind === 'ssh'
          ? remove.key.kind === 'signing'
            ? 'Commits signed with this key will no longer show as Verified.'
            : 'Any computer or service using this key can no longer push or pull over SSH.'
          : 'Commits signed with this key will no longer show as Verified on GitHub.'
      }
      onClose={onClose}
      onConfirm={async (auth) => {
        if (remove.kind === 'ssh') await call('gh:acctDeleteSshKey', { kind: remove.key.kind, id: remove.key.id, auth, confirmed: true });
        else await call('gh:acctDeleteGpgKey', { id: remove.key.id, auth, confirmed: true });
        toast(`Deleted ${label}`);
        onDone();
      }}
    >
      <p>
        Removes <strong>{label}</strong> from your GitHub account. The key files on your computers are not touched.
      </p>
    </SecureActionDialog>
  );
}

/** Confirms the exact global git config changes before making a key the commit-signing key. */
function UseForSigningDialog({ target, current, onClose, onDone }: { target: SignTarget; current: SigningConfig | null; onClose: () => void; onDone: () => void }) {
  const [signAll, setSignAll] = useState(current?.commitGpgSign ?? false);
  const { busy, run } = useMutation();
  const settings: [string, string][] =
    target.kind === 'ssh'
      ? [
          ['gpg.format', 'ssh'],
          ['user.signingkey', target.pubPath.replace(/\\/g, '/')],
        ]
      : [['gpg.format', 'openpgp'], ['user.signingkey', target.keyId.toUpperCase()], ...(target.gpgProgram ? ([['gpg.program', target.gpgProgram.replace(/\\/g, '/')]] as [string, string][]) : [])];
  if (signAll) settings.push(['commit.gpgsign', 'true']);
  const before: Record<string, string | null> = { 'gpg.format': current?.format ?? null, 'user.signingkey': current?.signingKey ?? null, 'gpg.program': current?.gpgProgram ?? null, 'commit.gpgsign': current ? String(current.commitGpgSign) : null };
  return (
    <Modal
      title="Use for commit signing"
      icon="✍"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void run(
                () => (target.kind === 'ssh' ? call('ssh:useForSigning', { kind: 'ssh', pubPath: target.pubPath, signAll, confirmed: true }) : call('ssh:useForSigning', { kind: 'gpg', keyId: target.keyId, signAll, confirmed: true })),
                `${target.name} now signs your commits`,
              ).then((r) => {
                if (r) {
                  onDone();
                  onClose();
                }
              })
            }
          >
            {busy ? 'Saving…' : 'Apply to global git config'}
          </button>
        </>
      }
    >
      <p className="kx-p">
        Git will sign commits with <strong>{target.name}</strong> in every repository. These global settings are written:
      </p>
      <table className="kx-cfg">
        <tbody>
          {settings.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>
                <code>{v}</code>
              </td>
              <td className="kx-muted" title={before[k] ?? ''}>
                {before[k] && before[k] !== v ? `was ${before[k].length > 18 ? `…${before[k]!.slice(-16)}` : before[k]}` : before[k] === v ? 'unchanged' : 'new'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="kx-check">
        <input type="checkbox" checked={signAll} onChange={(e) => setSignAll(e.target.checked)} /> Sign every commit automatically (<code>commit.gpgsign = true</code>)
      </label>
      {target.kind === 'gpg' && target.gpgProgram && <div className="kx-note">gpg.program points Git at the GnuPG that holds this key — Git for Windows otherwise uses its own bundled gpg with a separate keyring.</div>}
      <div className="kx-note">For a “Verified” badge, the key must also be on GitHub {target.kind === 'ssh' ? 'as a signing key' : ''} and your commit email must be verified there.</div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// GPG
// ---------------------------------------------------------------------------

interface GpgRowData {
  id: string;
  local: LocalGpgKey | null;
  remote: GhGpgKey | null;
}

function GpgKeys({ signing, reloadSigning }: { signing: SigningConfig | null; reloadSigning: () => void }) {
  const { toast } = useApp();
  const remote = useGh(() => call('gh:acctGpgKeyList'), []);
  const local = useGh(() => call('gh:localGpg'), []);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [remove, setRemove] = useState<Remove | null>(null);
  const [generate, setGenerate] = useState(false);
  const [paste, setPaste] = useState(false);
  const [signTarget, setSignTarget] = useState<SignTarget | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const { busy, run } = useMutation();
  const access = remote.data?.access ?? null;
  const readable = !!remote.data && remote.data.access.ok;
  const webBase = access?.webBase ?? 'https://github.com';
  const gpgProgram = local.data?.binary && local.data.binary !== 'gpg' ? local.data.binary : null;

  const rows = useMemo(() => {
    const map = new Map<string, GpgRowData>();
    for (const k of local.data?.keys ?? []) map.set(k.keyId.toUpperCase(), { id: k.keyId.toUpperCase(), local: k, remote: null });
    for (const k of remote.data?.keys ?? []) {
      const id = k.keyId.toUpperCase();
      const r = map.get(id);
      if (r) r.remote = k;
      else map.set(id, { id, local: null, remote: k });
    }
    return [...map.values()].sort((a, b) => Number(!!b.local) - Number(!!a.local));
  }, [local.data, remote.data]);
  const remoteIds = useMemo(() => new Set((remote.data?.keys ?? []).map((k) => k.keyId.toUpperCase())), [remote.data]);

  const reload = () => {
    void remote.reload();
    void local.reload();
  };
  const exportKey = async (k: LocalGpgKey) => (await run(() => call('gh:localGpgExport', { keyId: k.fingerprint || k.keyId })))?.publicKey ?? null;
  const uploadLocal = async (k: LocalGpgKey) => {
    const armored = await exportKey(k);
    if (armored) setUpload({ kind: 'gpg', name: k.uid || k.keyId, armored });
  };
  const copyLocal = async (k: LocalGpgKey, open: boolean) => {
    const armored = await exportKey(k);
    if (!armored) return;
    await copyText(armored, toast, 'GPG public key');
    if (open) openExternal(`${webBase}/settings/gpg/new`);
  };
  const noGpg = local.data && !local.data.available;

  return (
    <div>
      <div className="kx-head">
        <span className="kx-counts">
          <strong>{rows.length}</strong> key{rows.length === 1 ? '' : 's'} <span className="kx-sep">·</span> 💻 {local.data ? local.data.keys.length : '…'} <span className="kx-sep">·</span> ☁ {remote.data ? (readable ? remote.data.keys.length : '?') : remote.error ? '?' : '…'}
        </span>
        <button className="btn sm ghost" onClick={reload} title="Refresh" aria-label="Refresh">
          ↻
        </button>
        <NewKeyButton onGenerate={() => setGenerate(true)} onPaste={() => setPaste(true)} disabled={!local.data?.available} disabledHint="Install GnuPG (Gpg4win) to generate keys here" />
      </div>
      {access && !access.ok && <AccessStrip access={access} onRetry={() => void remote.reload()} busy={remote.loading} />}
      {remote.error && <ErrorStrip error={remote.error} onRetry={() => void remote.reload()} />}
      {noGpg && (
        <div className="kx-strip info">
          <div className="kx-strip-line">
            <span className="kx-strip-ico">ℹ</span>
            <span className="grow">
              <strong>GnuPG not found.</strong> Install Gpg4win from gpg4win.org to create and use GPG keys here — or sign with an SSH key instead (SSH tab → ✍ Sign).
            </span>
            <button className="btn sm" onClick={() => void local.reload()}>
              ↻ Check again
            </button>
          </div>
        </div>
      )}

      {!local.data && !local.error ? (
        <div className="kx-list">
          <div className="kx-row kx-skel" />
        </div>
      ) : rows.length === 0 ? (
        !noGpg && (
          <div className="kx-empty">
            No GPG keys yet.{' '}
            <button className="btn sm primary" onClick={() => setGenerate(true)}>
              ✨ Generate one
            </button>{' '}
            — or sign commits with an SSH key, which needs no extra software.
          </div>
        )
      ) : (
        <div className="kx-list">
          {rows.map((r) => (
            <GpgRow
              key={r.id}
              r={r}
              isNew={fresh === r.id}
              readable={readable}
              busy={busy}
              isSigning={!!r.local && (signing?.format ?? 'openpgp') === 'openpgp' && isGpgSigningKey(signing?.signingKey ?? null, r.local)}
              onUpload={() => r.local && void uploadLocal(r.local)}
              onCopy={(open) => r.local && void copyLocal(r.local, open)}
              onRemove={() => r.remote && setRemove({ kind: 'gpg', key: r.remote })}
              onSign={() => r.local && setSignTarget({ kind: 'gpg', keyId: r.local.keyId, name: r.local.uid || r.local.keyId, gpgProgram })}
            />
          ))}
        </div>
      )}
      {local.data?.available && (
        <div className="kx-foot" title={local.data.binary ?? ''}>
          gpg {local.data.version} · {local.data.binary}. Secret keys never leave your keyring; only public keys are exported.
        </div>
      )}

      {generate && (
        <GenerateGpgDialog
          remoteIds={remoteIds}
          signing={signing}
          onClose={() => setGenerate(false)}
          onCreated={(k) => {
            setFresh(k.keyId.toUpperCase());
            void local.reload();
          }}
          onUpload={(name, armored) => setUpload({ kind: 'gpg', name, armored })}
          onCopyOpen={(armored) => {
            void copyText(armored, toast, 'GPG public key').then(() => openExternal(`${webBase}/settings/gpg/new`));
          }}
          onSign={(k) => setSignTarget({ kind: 'gpg', keyId: k.keyId, name: k.uid || k.keyId, gpgProgram })}
        />
      )}
      {paste && (
        <PasteKeyDialog
          kind="gpg"
          onClose={() => setPaste(false)}
          onNext={(u) => {
            setPaste(false);
            setUpload(u);
          }}
        />
      )}
      {upload && <UploadDialog upload={upload} onClose={() => setUpload(null)} onDone={reload} />}
      {remove && <RemoveDialog remove={remove} onClose={() => setRemove(null)} onDone={reload} />}
      {signTarget && <UseForSigningDialog target={signTarget} current={signing} onClose={() => setSignTarget(null)} onDone={reloadSigning} />}
    </div>
  );
}

function GpgRow({
  r,
  isNew,
  readable,
  busy,
  isSigning,
  onUpload,
  onCopy,
  onRemove,
  onSign,
}: {
  r: GpgRowData;
  isNew: boolean;
  readable: boolean;
  busy: boolean;
  isSigning: boolean;
  onUpload: () => void;
  onCopy: (open: boolean) => void;
  onRemove: () => void;
  onSign: () => void;
}) {
  const [open, setOpen] = useState(false);
  const l = r.local;
  const g = r.remote;
  const expires = l?.expiresAt ?? g?.expiresAt ?? null;
  const expired = !!expires && new Date(expires) < new Date();
  const soon = !expired && !!expires && new Date(expires).getTime() - Date.now() < 30 * 86400_000;
  const name = l?.uid || g?.emails.map((e) => e.email).join(', ') || r.id;
  return (
    <div className={`kx-row ${open ? 'open' : ''} ${isNew ? 'new' : ''}`}>
      <div className="kx-main" onClick={() => setOpen((o) => !o)}>
        <button
          className="kx-caret"
          aria-expanded={open}
          aria-label={open ? 'Hide details' : 'Show details'}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          ▸
        </button>
        <Where local={!!l} remote={g ? true : readable ? false : null} />
        <span className="kx-type">{l ? l.algorithm.replace(/ \(.*\)$/, '').replace('EdDSA', 'ed25519') : 'gpg'}</span>
        <span className="kx-name" title={name}>
          {name}
        </span>
        {isNew && <span className="kx-chip accent">new</span>}
        {g?.canSign && <span className="kx-chip ok">signing</span>}
        {isSigning && <span className="kx-chip accent">✍ commit signing</span>}
        {g?.revoked && <span className="kx-chip danger">revoked</span>}
        {expired && <span className="kx-chip danger">expired</span>}
        {soon && <span className="kx-chip warn">expires soon</span>}
        {g && g.emails.some((e) => !e.verified) && (
          <span className="kx-chip warn" title="Commits only show Verified for verified emails">
            unverified email
          </span>
        )}
        {l && readable && !g && <span className="kx-chip warn">not on GitHub</span>}
        <span className="kx-fp" title={l?.fingerprint ?? r.id}>
          {r.id.slice(-8)}
        </span>
        <span className="kx-actions" onClick={(e) => e.stopPropagation()}>
          {l && (
            <button className="btn sm ghost" disabled={busy} onClick={() => onCopy(false)} title="Copy the ASCII-armoured public key">
              ⧉ Copy
            </button>
          )}
          {l && !g && (
            <Menu
              label="⬆ GitHub ▾"
              disabled={busy}
              items={[
                { label: 'Add to GitHub', hint: readable ? 'Via the API' : 'Via API — needs a token with “GPG keys”', onClick: onUpload },
                { label: 'Copy & open GitHub ↗', hint: 'Always works — paste it on github.com', onClick: () => onCopy(true) },
              ]}
            />
          )}
          {l && !isSigning && (
            <button className="btn sm ghost" onClick={onSign} title="Sign your commits with this key (global git config)">
              ✍ Sign
            </button>
          )}
          {g && (
            <button className="btn sm ghost kx-danger" onClick={onRemove} title="Remove from GitHub">
              🗑
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="kx-detail">
          <div className="kx-kv">
            <span>Key ID</span>
            <code>{r.id}</code>
            {l?.fingerprint && (
              <>
                <span>Fingerprint</span>
                <code>{l.fingerprint.replace(/(.{4})/g, '$1 ').trim()}</code>
              </>
            )}
            {l && (
              <>
                <span>Created</span>
                <span>
                  {l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '—'} · {expires ? `expires ${new Date(expires).toLocaleDateString()}` : 'no expiry'}
                </span>
              </>
            )}
            {g && (
              <>
                <span>On GitHub</span>
                <span>
                  added {relTime(g.createdAt)} · {g.subkeys} subkey(s) · {g.emails.map((e) => `${e.email}${e.verified ? ' ✓' : ' (unverified)'}`).join(', ') || 'no email'}
                </span>
              </>
            )}
          </div>
          {!l && <div className="kx-hint">The secret key is not in this computer's GnuPG keyring, so it cannot sign here.</div>}
        </div>
      )}
    </div>
  );
}

function GenerateGpgDialog({
  remoteIds,
  signing,
  onClose,
  onCreated,
  onUpload,
  onCopyOpen,
  onSign,
}: {
  remoteIds: Set<string>;
  signing: SigningConfig | null;
  onClose: () => void;
  onCreated: (k: LocalGpgKey) => void;
  onUpload: (name: string, armored: string) => void;
  onCopyOpen: (armored: string) => void;
  onSign: (k: LocalGpgKey) => void;
}) {
  const { activeAccount, toast } = useApp();
  const emails = useGh(() => call('gh:acctEmails'), []);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(activeAccount?.name ?? activeAccount?.login ?? '');
  const [email, setEmail] = useState('');
  const [expiry, setExpiry] = useState<'1y' | '2y' | 'never'>('2y');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FriendlyError | null>(null);
  const [created, setCreated] = useState<{ key: LocalGpgKey; publicKey: string } | null>(null);
  const verified = (emails.data ?? []).filter((e) => e.verified);
  const chosen = email || verified.find((e) => e.primary)?.email || verified[0]?.email || '';
  const emailOk = /^[^\s<>()@]+@[^\s<>()@]+\.[^\s<>()@]+$/.test(chosen);
  const nameOk = !!name.trim() && !/[<>()]/.test(name);
  const passOk = pass === pass2 && pass.length >= 8;

  const generate = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const r = await call('gh:localGpgGenerate', { name: name.trim(), email: chosen, passphrase: pass, expiry });
      setCreated(r);
      setStep(2);
      onCreated(r.key);
    } catch (err) {
      setFailure(toFriendly(err));
    } finally {
      setPass('');
      setPass2('');
      setBusy(false);
    }
  };
  const onGh = created ? remoteIds.has(created.key.keyId.toUpperCase()) : false;
  const isSigning = created ? (signing?.format ?? 'openpgp') === 'openpgp' && isGpgSigningKey(signing?.signingKey ?? null, created.key) : false;

  return (
    <Modal
      title={step === 2 ? 'GPG key ready' : 'New GPG signing key'}
      icon={step === 2 ? '✅' : '✍'}
      onClose={onClose}
      locked={busy}
      footer={
        step === 0 ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!nameOk || !emailOk} onClick={() => setStep(1)}>
              Next →
            </button>
          </>
        ) : step === 1 ? (
          <>
            <button className="btn" onClick={() => setStep(0)} disabled={busy}>
              ← Back
            </button>
            <span className="grow" />
            <button className="btn primary" disabled={busy || !passOk} onClick={() => void generate()}>
              {busy ? 'Generating…' : '🔒 Generate key'}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        )
      }
    >
      <Stepper steps={['Identity', 'Protect', 'Use it']} at={step} />
      {step === 0 && (
        <>
          <div className="grid-2">
            <div className={`field ${nameOk ? '' : 'invalid'}`}>
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className={`field ${emailOk ? '' : 'invalid'}`}>
              <label>Email</label>
              {verified.length > 0 ? (
                <Select value={chosen} onChange={(e) => setEmail(e.target.value)}>
                  {verified.map((e) => (
                    <option key={e.email} value={e.email}>
                      {e.email}
                      {e.primary ? ' (primary)' : ''}
                    </option>
                  ))}
                </Select>
              ) : (
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="A verified GitHub email" />
              )}
            </div>
          </div>
          <div className="kx-inline">
            <span className="kx-k">Expires</span>
            <div className="segmented">
              {(['1y', '2y', 'never'] as const).map((x) => (
                <button key={x} className={expiry === x ? 'on' : ''} onClick={() => setExpiry(x)}>
                  {x === 'never' ? 'Never' : x === '1y' ? '1 year' : '2 years ★'}
                </button>
              ))}
            </div>
          </div>
          <div className="kx-note">Use a verified email of your GitHub account — otherwise commits are not shown as Verified. Creates an ed25519 key in your GnuPG keyring.</div>
        </>
      )}
      {step === 1 && (
        <>
          <div className="grid-2">
            <div className={`field ${pass && pass.length < 8 ? 'invalid' : ''}`}>
              <label>Passphrase</label>
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" autoFocus />
              <StrengthMeter pass={pass} />
            </div>
            <div className={`field ${pass2 && pass !== pass2 ? 'invalid' : ''}`}>
              <label>Repeat</label>
              <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" onKeyDown={(e) => e.key === 'Enter' && passOk && !busy && void generate()} />
              {pass2 && pass !== pass2 && <div className="field-hint">Passphrases differ</div>}
            </div>
          </div>
          <div className="kx-note">At least 8 characters. GnuPG asks for it when signing; Git Baba does not keep it.</div>
          <div className="kx-summary">
            <span className="kx-type">ed25519</span> <code>
              {name.trim()} &lt;{chosen}&gt;
            </code>{' '}
            <span className="kx-muted">{expiry === 'never' ? 'no expiry' : `expires in ${expiry === '1y' ? '1 year' : '2 years'}`}</span>
          </div>
          {failure && (
            <div className="kx-strip danger" role="alert">
              <div className="kx-strip-line">
                <span className="kx-strip-ico">⚠</span>
                <span className="grow">
                  <strong>{failure.title}</strong> — {failure.message}
                </span>
                {failure.technical && (
                  <button className="btn sm ghost" onClick={() => void copyText(failure.technical!, toast, 'Details')}>
                    Copy details
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {step === 2 && created && (
        <div className="kx-done">
          <div className="kx-done-key">
            <span className="kx-type">ed25519</span>
            <strong>{created.key.uid}</strong>
            <code className="kx-fp">{created.key.keyId}</code>
            <button className="btn sm ghost" onClick={() => void copyText(created.publicKey, toast, 'GPG public key')}>
              ⧉ Copy public key
            </button>
          </div>
          <ol className="kx-next">
            <li className={onGh ? 'done' : ''}>
              <span className="kx-next-t">{onGh ? '✓ On GitHub' : 'Add it to GitHub'}</span>
              {!onGh && (
                <span className="kx-next-a">
                  <button className="btn sm primary" onClick={() => onUpload(created.key.uid || created.key.keyId, created.publicKey)}>
                    ⬆ Add to GitHub
                  </button>
                  <button className="btn sm ghost" onClick={() => onCopyOpen(created.publicKey)}>
                    ⧉ Copy &amp; open GitHub ↗
                  </button>
                </span>
              )}
            </li>
            <li className={isSigning ? 'done' : ''}>
              <span className="kx-next-t">{isSigning ? '✓ Signs your commits' : 'Sign commits with it'}</span>
              {!isSigning && (
                <span className="kx-next-a">
                  <button className="btn sm" onClick={() => onSign(created.key)}>
                    ✍ Use for commit signing…
                  </button>
                </span>
              )}
            </li>
          </ol>
        </div>
      )}
    </Modal>
  );
}
