import { useRef, useState } from 'react';
import type { AppInstallationInfo, RegisteredApp } from '../../../../shared/github';
import type { KeyHandleInfo } from '../../../../shared/types';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { relTime, Skeleton, useGh, useMutation } from '../../../components/github/common';
import { openExternal } from '../../../components/github/SecureActionDialog';
import { Modal } from '../../../components/Modal';
import { ConfirmDialog } from '../../../dialogs/ConfirmDialog';
import { call } from '../../../services/api';
import { useApp } from '../../../state/AppState';

type Focus = 'accounts' | 'ssh' | 'gpg' | 'apps' | 'tokens' | 'pats' | 'oauth';

/**
 * Every credential at a glance: what GitHub knows (SSH / GPG keys, App installations) and what this computer
 * stores (remembered account tokens, per-repository tokens and App keys, SSH key paths, live installation
 * tokens). Personal access tokens and OAuth apps cannot be listed through GitHub's API — those tiles link out.
 */
export function CredentialsPage() {
  const { setView } = useApp();
  const local = useGh(() => call('gh:acctCredentials'), []);
  const ssh = useGh(() => call('gh:acctSshKeys'), []);
  const gpg = useGh(() => call('gh:acctGpgKeys'), []);
  const [focus, setFocus] = useState<Focus>('apps');

  const l = local.data;
  const tiles: { id: Focus; icon: string; label: string; value: string; sub: string; tone?: 'warn' | 'ok' }[] = [
    { id: 'accounts', icon: '👤', label: 'Accounts', value: String(l?.accounts.length ?? '…'), sub: l ? `${l.accounts.filter((a) => a.signedIn).length} signed in · ${l.accounts.filter((a) => a.remembered).length} remembered` : '' },
    { id: 'ssh', icon: '🔑', label: 'SSH keys', value: ssh.data ? String(ssh.data.authentication.length + ssh.data.signing.length) : '…', sub: ssh.data ? `${ssh.data.authentication.length} auth · ${ssh.data.signing.length} signing` : ssh.error ? 'not readable' : '' },
    { id: 'gpg', icon: '✍', label: 'GPG keys', value: gpg.data ? String(gpg.data.length) : '…', sub: gpg.data ? `${gpg.data.filter((k) => k.expiresAt && new Date(k.expiresAt) < new Date()).length} expired` : gpg.error ? 'not readable' : '' },
    { id: 'apps', icon: '🧩', label: 'GitHub Apps', value: String(l?.apps.length ?? '…'), sub: 'registered in Git Baba' },
    { id: 'tokens', icon: '⏳', label: 'Installation tokens', value: String(l?.installationTokens.active ?? '…'), sub: l ? `active now · ${l.installationTokens.total} this session` : '', tone: l && l.installationTokens.active > 0 ? 'warn' : 'ok' },
    { id: 'pats', icon: '🎫', label: 'Stored tokens & keys', value: String(l ? l.repoPats.length + l.repoAppKeys.length : '…'), sub: l ? `${l.repoPats.length} PAT · ${l.repoAppKeys.length} App key (per repo)` : '' },
    { id: 'oauth', icon: '🔗', label: 'PATs & OAuth apps', value: '↗', sub: 'managed on github.com' },
  ];

  return (
    <div>
      {local.error && <ErrorPanel error={local.error} />}
      <div className="cred-tiles">
        {tiles.map((t) => (
          <button key={t.id} className={`cred-tile ${focus === t.id ? 'on' : ''} ${t.tone ?? ''}`} onClick={() => setFocus(t.id)}>
            <span className="cred-ico">{t.icon}</span>
            <span className="cred-val">{t.value}</span>
            <span className="cred-lbl">{t.label}</span>
            <span className="cred-sub">{t.sub}</span>
          </button>
        ))}
      </div>
      {l && !l.encryptionAvailable && (
        <div className="banner warn small">
          <span className="icon">⚠</span>
          <div>Secure storage (OS keychain) is unavailable — nothing can be remembered on this computer.</div>
        </div>
      )}

      <div className="cred-detail">
        {focus === 'accounts' && (
          <DetailList
            title="Accounts in Git Baba"
            empty="No accounts added."
            rows={(l?.accounts ?? []).map((a) => ({
              key: a.login,
              icon: a.signedIn ? '🟢' : '⚪',
              title: `${a.login} · ${a.host}`,
              sub: `${a.signedIn ? 'signed in (memory only)' : 'signed out'} · ${a.remembered ? 'token remembered in the OS keychain' : 'token not stored'}${a.scopes ? ` · scopes: ${a.scopes.join(', ') || 'none'}` : a.signedIn ? ' · fine-grained token' : ''}`,
            }))}
            action={{ label: 'Manage accounts', onClick: () => setView('accounts') }}
          />
        )}
        {focus === 'ssh' && (
          <DetailList
            title="SSH keys on GitHub"
            empty={ssh.error ? ssh.error.message : 'No SSH keys.'}
            rows={[...(ssh.data?.authentication ?? []), ...(ssh.data?.signing ?? [])].map((k) => ({ key: `${k.kind}${k.id}`, icon: k.kind === 'signing' ? '✍' : '🔑', title: k.title || 'Untitled', sub: `${k.kind} · added ${relTime(k.createdAt)}` }))}
            extra={(l?.repoSshKeys ?? []).map((r) => ({ key: `local-${r.repo}`, icon: '💻', title: r.keyFile, sub: `remembered for ${r.repo}` }))}
            extraTitle="Key files remembered per repository"
          />
        )}
        {focus === 'gpg' && (
          <DetailList
            title="GPG keys on GitHub"
            empty={gpg.error ? gpg.error.message : 'No GPG keys.'}
            rows={(gpg.data ?? []).map((k) => ({ key: String(k.id), icon: '✍', title: k.keyId, sub: `${k.emails.map((e) => e.email).join(', ') || 'no email'}${k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ''}` }))}
          />
        )}
        {focus === 'apps' && <AppsRegistry onChanged={() => void local.reload()} />}
        {focus === 'tokens' && (
          <DetailList
            title="Installation tokens this session"
            empty="No installation tokens were created this session."
            rows={l ? [{ key: 'sum', icon: '⏳', title: `${l.installationTokens.active} active · ${l.installationTokens.revoked} revoked · ${l.installationTokens.total} total`, sub: 'Short-lived (≤ 1 h) tokens from GitHub Apps, kept in memory only and revoked after each operation.' }] : []}
            action={{ label: 'Open token manager', onClick: () => setView('token') }}
          />
        )}
        {focus === 'pats' && (
          <DetailList
            title="Stored per repository (encrypted)"
            empty="Nothing is stored for any repository."
            rows={[
              ...(l?.repoPats ?? []).map((p) => ({ key: `pat-${p.repo}`, icon: '🎫', title: `Personal access token · ${p.repo}`, sub: `username ${p.username}` })),
              ...(l?.repoAppKeys ?? []).map((p) => ({ key: `app-${p.repo}`, icon: '🧩', title: `GitHub App key · ${p.repo}`, sub: p.appId ? `App ${p.appId}` : 'App key' })),
            ]}
            hint="Remove them in each repository's Settings → General, or by unticking “Allow saved credentials”."
          />
        )}
        {focus === 'oauth' && (
          <div className="card">
            <h3>Personal access tokens & OAuth apps</h3>
            <p className="small muted">
              GitHub does not let applications list or revoke your personal access tokens or OAuth authorisations through its API — a deliberate protection. Review them on github.com, where
              you can see last use and revoke anything you don’t recognise.
            </p>
            <div className="handoff-grid">
              {[
                ['🎫', 'Fine-grained tokens', 'https://github.com/settings/tokens?type=beta'],
                ['🎟', 'Classic tokens', 'https://github.com/settings/tokens'],
                ['🔗', 'Authorized OAuth apps', 'https://github.com/settings/applications'],
                ['🧩', 'Authorized GitHub Apps', 'https://github.com/settings/apps/authorizations'],
                ['🛡', 'Security log', 'https://github.com/settings/security-log'],
                ['📱', 'Sessions & devices', 'https://github.com/settings/sessions'],
              ].map(([icon, label, url]) => (
                <button key={url} className="handoff-card link" onClick={() => openExternal(url)}>
                  <div className="handoff-ico">{icon}</div>
                  <strong className="grow">{label}</strong>
                  <span>↗</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface Row {
  key: string;
  icon: string;
  title: string;
  sub: string;
}

function DetailList({ title, rows, empty, action, extra, extraTitle, hint }: { title: string; rows: Row[]; empty: string; action?: { label: string; onClick: () => void }; extra?: Row[]; extraTitle?: string; hint?: string }) {
  return (
    <div className="card">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>
          {title}
        </h3>
        {action && (
          <button className="btn sm" onClick={action.onClick}>
            {action.label} →
          </button>
        )}
      </div>
      {rows.length === 0 && <div className="small muted mt">{empty}</div>}
      <div className="key-list mt">
        {rows.map((r) => (
          <div key={r.key} className="key-row">
            <span className="key-ico">{r.icon}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <strong className="ellipsis">{r.title}</strong>
              <div className="small muted">{r.sub}</div>
            </div>
          </div>
        ))}
      </div>
      {extra && extra.length > 0 && (
        <>
          <h4 className="mt">{extraTitle}</h4>
          <div className="key-list">
            {extra.map((r) => (
              <div key={r.key} className="key-row">
                <span className="key-ico">{r.icon}</span>
                <div className="grow">
                  <strong>{r.title}</strong>
                  <div className="small muted">{r.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {hint && <div className="small muted mt">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub Apps registered at account level
// ---------------------------------------------------------------------------

function AppsRegistry({ onChanged }: { onChanged: () => void }) {
  const apps = useGh(() => call('gh:appsList'), []);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RegisteredApp | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { run } = useMutation();
  const { toast } = useApp();

  return (
    <div className="card">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>
          GitHub Apps
        </h3>
        <button className="btn sm primary" onClick={() => setAdding(true)}>
          ＋ Register an App
        </button>
      </div>
      <p className="small muted">
        Register an App once with its private key (encrypted in your OS keychain). Then link it from any repository’s Settings → GitHub App — no copying keys around. Install it on more
        repositories with one click.
      </p>
      {apps.error && <ErrorPanel error={apps.error} />}
      {apps.data?.length === 0 && (
        <div className="empty small">
          No GitHub Apps registered yet. <a onClick={() => openExternal('https://github.com/settings/apps/new')}>Create one on GitHub ↗</a>
        </div>
      )}
      <div className="app-list">
        {(apps.data ?? []).map((a) => (
          <AppCard
            key={a.id}
            app={a}
            open={open === a.id}
            onToggle={() => setOpen(open === a.id ? null : a.id)}
            onRemove={() => setRemoving(a)}
          />
        ))}
      </div>
      {adding && (
        <RegisterAppDialog
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void apps.reload();
            onChanged();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Remove GitHub App from Git Baba"
          danger
          explanation={
            <>
              Forgets <strong>{removing.name}</strong> and deletes its stored private key from this computer.
            </>
          }
          impact="Repositories linked to it lose access to the key until you link another App. The App itself stays on GitHub — uninstall or delete it there if you want."
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const r = await run(() => call('gh:appsRemove', { id: removing.id, confirmed: true }));
            if (r) toast(r.unlinked ? `Removed ${removing.name} and unlinked it from ${r.unlinked} repositor${r.unlinked === 1 ? 'y' : 'ies'}` : `Removed ${removing.name}`);
            setRemoving(null);
            void apps.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function AppCard({ app, open, onToggle, onRemove }: { app: RegisteredApp; open: boolean; onToggle: () => void; onRemove: () => void }) {
  const installs = useGh<AppInstallationInfo[] | null>(() => (open ? call('gh:appsInstallations', { id: app.id }) : Promise.resolve(null)), [app.id, open]);
  const [repos, setRepos] = useState<Record<number, string[] | 'loading'>>({});
  const perms = Object.entries(app.permissions);

  const loadRepos = async (i: AppInstallationInfo) => {
    setRepos((r) => ({ ...r, [i.id]: 'loading' }));
    const list = await call('gh:appsInstallationRepos', { id: app.id, installationId: i.id }).catch(() => []);
    setRepos((r) => ({ ...r, [i.id]: list }));
  };

  return (
    <div className={`app-card ${open ? 'open' : ''}`}>
      <div className="app-card-head" onClick={onToggle}>
        <span className="app-logo">{app.name[0]?.toUpperCase()}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <strong>{app.name}</strong>
            <span className="badge">App {app.appId}</span>
            {app.hasKey ? <span className="badge ok">🔒 key stored</span> : <span className="badge warn">key missing</span>}
          </div>
          <div className="small muted">
            by {app.owner} · {perms.length} permission(s) · {app.events.length} event(s) · added {relTime(app.addedAt)}
          </div>
        </div>
        <button
          className="btn sm primary"
          onClick={(e) => {
            e.stopPropagation();
            openExternal(`${app.htmlUrl}/installations/new`);
          }}
          title="Install on more accounts or repositories (opens GitHub)"
        >
          ＋ Install on repositories ↗
        </button>
        <span className={`step-caret ${open ? 'open' : ''}`}>▸</span>
      </div>
      {open && (
        <div className="app-card-body">
          <div className="perm-chips">
            {perms.map(([k, v]) => (
              <span key={k} className={`perm-chip ${v}`}>
                {k.replace(/_/g, ' ')}: <strong>{v}</strong>
              </span>
            ))}
            {perms.length === 0 && <span className="small muted">No permissions requested.</span>}
          </div>
          <h4>Installations</h4>
          {installs.error && <ErrorPanel error={installs.error} />}
          {!installs.data && !installs.error && <Skeleton rows={2} />}
          {installs.data?.length === 0 && <div className="small muted">Not installed anywhere yet.</div>}
          {installs.data?.map((i) => {
            const rs = repos[i.id];
            return (
              <div key={i.id} className="install-row">
                <div className="row" style={{ gap: 8 }}>
                  <strong>{i.account}</strong>
                  <span className="badge">{i.accountType}</span>
                  <span className="badge">{i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}</span>
                  {i.suspended && <span className="badge danger">suspended</span>}
                  <span className="spacer" />
                  {i.repositorySelection === 'selected' && !rs && (
                    <button className="btn sm ghost" onClick={() => void loadRepos(i)}>
                      Show repositories
                    </button>
                  )}
                  <button className="btn sm" onClick={() => openExternal(i.htmlUrl)} title="Add or remove repositories for this installation on GitHub">
                    Configure ↗
                  </button>
                </div>
                {rs === 'loading' && <Skeleton rows={1} />}
                {Array.isArray(rs) && (
                  <div className="repo-chips">
                    {rs.map((r) => (
                      <span key={r} className="branch-pill">
                        {r}
                      </span>
                    ))}
                    {rs.length === 0 && <span className="small muted">No repositories.</span>}
                  </div>
                )}
              </div>
            );
          })}
          <div className="row mt">
            <button className="btn sm ghost" onClick={() => openExternal(app.htmlUrl)}>
              App page ↗
            </button>
            <span className="spacer" />
            <button className="btn sm danger" onClick={onRemove}>
              Remove from Git Baba…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RegisterAppDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [appId, setAppId] = useState('');
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [keyInfo, setKeyInfo] = useState<KeyHandleInfo | null>(null);
  const [pem, setPem] = useState('');
  const { busy, run } = useMutation();
  const keyRef = useRef<string | null>(null);
  const ok = /^\d+$/.test(appId) && ((mode === 'file' && keyInfo) || (mode === 'paste' && pem.includes('PRIVATE KEY')));

  const close = () => {
    if (keyRef.current) void call('github:discardKey', { handle: keyRef.current }).catch(() => undefined);
    onClose();
  };

  return (
    <Modal
      title="Register a GitHub App"
      icon="🧩"
      onClose={close}
      locked={busy}
      footer={
        <>
          <button className="btn cancel" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!ok || busy}
            onClick={() =>
              void run(() => call('gh:appsAdd', mode === 'file' ? { appId, keyHandle: keyInfo!.handle } : { appId, privateKey: pem }), 'GitHub App registered').then((r) => {
                keyRef.current = null;
                setPem('');
                if (r) onDone();
              })
            }
          >
            {busy ? 'Verifying…' : 'Verify & register'}
          </button>
        </>
      }
    >
      <p className="small muted">Git Baba verifies the key with GitHub (signed request to /app), then stores it encrypted with your OS keychain. Only you, on this computer, can use it.</p>
      <div className={`field ${appId && !/^\d+$/.test(appId) ? 'invalid' : ''}`}>
        <label>
          App ID <span className="req">*</span>
        </label>
        <input value={appId} onChange={(e) => setAppId(e.target.value.trim())} placeholder="123456" spellCheck={false} />
        <div className="hint">On GitHub: Settings → Developer settings → GitHub Apps → your App → “App ID”.</div>
      </div>
      <div className="segmented mb">
        <button className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>
          Load .pem file
        </button>
        <button className={mode === 'paste' ? 'on' : ''} onClick={() => setMode('paste')}>
          Paste key
        </button>
      </div>
      {mode === 'file' ? (
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              void call('github:loadKeyFile').then((k) => {
                if (k) {
                  keyRef.current = k.handle;
                  setKeyInfo(k);
                }
              })
            }
          >
            Choose .pem file…
          </button>
          <span className="small muted">{keyInfo ? `${keyInfo.fileName} · ${keyInfo.fingerprint.slice(0, 24)}…` : 'No file chosen'}</span>
        </div>
      ) : (
        <textarea className="code" rows={6} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN RSA PRIVATE KEY-----" spellCheck={false} autoComplete="off" />
      )}
    </Modal>
  );
}
