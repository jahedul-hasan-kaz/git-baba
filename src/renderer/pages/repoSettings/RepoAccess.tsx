import { useState, type ReactNode } from 'react';
import type { DefaultSource } from '../../../shared/authDefaults';
import type { AuthMethod, CommitSigningPreference, RemoteAuthPreference, RepoAccessOverview, SigningMethod } from '../../../shared/types';
import type { RepoSettingsPatch } from '../../../shared/api';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Skeleton } from '../../components/github/common';
import { useAsync } from '../../hooks/useAsync';
import { RepoAppLink } from './RepoAppLink';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';

/** Who set something up: this app, Git's own configuration, or the system. */
type Origin = 'app' | 'git' | 'system' | 'account';
const ORIGIN_LABEL: Record<Origin, string> = { app: 'Git Baba', git: 'git config', system: 'System', account: 'Signed-in account' };

interface Fact {
  ok: boolean;
  text: ReactNode;
  origin?: Origin;
}

export const REMOTE_LABEL: Record<AuthMethod, string> = { ssh: 'SSH key', pat: 'Personal access token', system: 'Git identity (unsigned)', 'github-app': 'GitHub App', none: 'None' };
export const SIGN_LABEL: Record<SigningMethod, string> = { none: 'Unsigned (Git identity)', gpg: 'GPG signed', ssh: 'SSH signed', x509: 'X.509 signed' };
export const SOURCE_TEXT: Record<DefaultSource, string> = {
  'github-app': 'GitHub App linked — it takes priority',
  'repo-setting': 'chosen here',
  remembered: 'already set up for this repository',
  'git-config': 'from your git config',
  default: 'nothing configured — Git identity',
};

/**
 * Security & access: which credential push / pull / merge use, the GitHub App link, and commit signing.
 * Nothing is created here — the page chooses between what exists and shows where each piece was set up
 * (Git Baba, git config or the system), so the dialogs can preselect it.
 */
export function RepoAccess({ appsAvailable }: { appsAvailable: boolean }) {
  const { activeRepo, revision, bump, showError, toast, activeAccount, session, requestAppSetup } = useApp();
  const repo = activeRepo!;
  const overview = useAsync(() => call('repo:accessOverview', { repoId: repo.id }), [repo.id, revision]);
  const [saving, setSaving] = useState<string | null>(null);
  const [showApps, setShowApps] = useState(false);

  const update = async (key: string, settings: RepoSettingsPatch, msg: string) => {
    setSaving(key);
    try {
      await call('repo:updateSettings', { repoId: repo.id, settings });
      toast(msg);
      bump();
    } catch (err) {
      showError(err);
    } finally {
      setSaving(null);
    }
  };

  if (overview.error) return <ErrorPanel error={overview.error} onAction={() => void overview.reload()} available={['retry']} />;
  const o = overview.data;
  if (!o) return <Skeleton rows={6} />;

  const accountSignedIn = !!repo.account && !!activeAccount && activeAccount.id === repo.account.id && (!!session?.active || activeAccount.remembered);
  const app = repo.settings.githubApp;

  return (
    <div className="access">
      {/* ---------------- push, pull & merge ---------------- */}
      <section className="access-section">
        <header className="access-head">
          <div>
            <h3>Push, pull &amp; merge</h3>
            <p className="small muted">The credential these dialogs preselect. You can still pick another one in the dialog.</p>
          </div>
          <AutoChip
            on={!repo.settings.remoteAuth}
            busy={saving === 'remote'}
            onClick={() => update('remote', { remoteAuth: null }, 'Push, pull and merge follow what is set up')}
          />
        </header>
        <div className="access-grid">
          <MethodCard
            icon="🔑"
            title="SSH key"
            method="ssh"
            o={o}
            chosen={repo.settings.remoteAuth === 'ssh'}
            busy={saving === 'remote'}
            onChoose={() => update('remote', { remoteAuth: 'ssh' as RemoteAuthPreference }, 'SSH key preselected for push, pull and merge')}
            facts={[
              o.detected.sshKeyPath ? { ok: true, text: <>Key <span className="mono">{shortPath(o.detected.sshKeyPath)}</span> remembered</>, origin: 'app' } : null,
              o.detected.sshCommand ? { ok: true, text: <>core.sshCommand <span className="mono">{o.detected.sshCommand}</span></>, origin: 'git' } : null,
              o.detected.sshEnv ? { ok: true, text: <>GIT_SSH <span className="mono">{shortPath(o.detected.sshEnv)}</span></>, origin: 'system' } : null,
              o.remote?.protocol === 'ssh' ? { ok: true, text: 'The remote uses SSH', origin: 'git' } : null,
              !o.detected.sshKeyPath && !o.detected.sshCommand && !o.detected.sshEnv ? { ok: false, text: 'No key remembered — the dialog asks for one (tick “Remember this key” there).' } : null,
            ]}
          />
          <MethodCard
            icon="👤"
            title="Personal access token"
            method="pat"
            o={o}
            chosen={repo.settings.remoteAuth === 'pat'}
            busy={saving === 'remote'}
            onChoose={() => update('remote', { remoteAuth: 'pat' as RemoteAuthPreference }, 'Token preselected for push, pull and merge')}
            facts={[
              accountSignedIn ? { ok: true, text: <>Uses <strong>{repo.account!.login}</strong>’s sign-in</>, origin: 'account' } : null,
              o.detected.patSaved ? { ok: true, text: 'Token saved (encrypted) for this repository', origin: 'app' } : null,
              !accountSignedIn && !o.detected.patSaved ? { ok: false, text: 'No token saved — paste one in the dialog and tick “Save” there.' } : null,
            ]}
          />
          <MethodCard
            icon="💻"
            title="Git identity (unsigned)"
            method="system"
            o={o}
            chosen={repo.settings.remoteAuth === 'system'}
            busy={saving === 'remote'}
            onChoose={() => update('remote', { remoteAuth: 'system' as RemoteAuthPreference }, 'Git identity preselected for push, pull and merge')}
            facts={[
              o.detected.credentialHelper ? { ok: true, text: <>Credential helper <span className="mono">{o.detected.credentialHelper}</span></>, origin: 'git' } : null,
              o.remote?.protocol === 'ssh' ? { ok: true, text: 'ssh-agent / ~/.ssh keys', origin: 'system' } : null,
              !o.detected.credentialHelper && o.remote?.protocol !== 'ssh' ? { ok: false, text: 'No credential helper in git config — Git may fail to sign in.' } : null,
            ]}
          />
        </div>
      </section>

      {/* ---------------- GitHub App ---------------- */}
      <section className="access-section">
        <header className="access-head">
          <div>
            <h3>GitHub App</h3>
            <p className="small muted">A linked App is preselected before every other method: each operation gets a short-lived token that is revoked right after.</p>
          </div>
          <Toggle
            on={!!app}
            disabled={!repo.github || saving === 'app'}
            label={app ? 'Linked' : 'Not linked'}
            onChange={(next) => {
              if (!next) void update('app', { githubApp: null }, 'GitHub App unlinked');
              else if (appsAvailable) setShowApps(true);
              else requestAppSetup(repo.id);
            }}
          />
        </header>
        {app ? (
          <div className="access-app on">
            <span className="app-logo">🤖</span>
            <div className="grow">
              <strong>App {app.appId}</strong> · {app.owner}/{app.repo}
              {app.installationId && <span className="muted"> · installation {app.installationId}</span>}
              <div className="small muted">
                {app.registryId ? 'Linked from your account’s App registry' : 'Set up for this repository'}
                {o.detected.githubAppKeySaved && ' · key saved (encrypted)'}
              </div>
            </div>
            <span className="badge ok">preselected</span>
          </div>
        ) : (
          <div className="access-app">
            <span className="app-logo muted">🤖</span>
            <div className="grow small muted">
              {repo.github ? 'Not linked. Link an App you already registered — Apps are created on GitHub, not here.' : 'Only available for GitHub repositories.'}
            </div>
            {repo.github && (
              <>
                {appsAvailable && (
                  <button className="btn sm primary" onClick={() => setShowApps((v) => !v)}>
                    {showApps ? 'Hide your Apps' : 'Choose from your Apps'}
                  </button>
                )}
                <button className="btn sm" onClick={() => requestAppSetup(repo.id)}>
                  Link by App ID…
                </button>
              </>
            )}
          </div>
        )}
        {appsAvailable && (showApps || !!app?.registryId) && (
          <div className="mt">
            <RepoAppLink repoId={repo.id} />
          </div>
        )}
      </section>

      {/* ---------------- commit signing ---------------- */}
      <section className="access-section">
        <header className="access-head">
          <div>
            <h3>Commit signing</h3>
            <p className="small muted">What the commit dialog preselects. Keys are set up in Git (user.signingkey), not here.</p>
          </div>
          <AutoChip
            on={!repo.settings.commitSigning}
            busy={saving === 'sign'}
            onClick={() => update('sign', { commitSigning: null }, 'Commit signing follows git config')}
          />
        </header>
        <div className="access-grid two">
          <SignCard
            icon="🔏"
            title={o.signing.signedLabel ?? 'GPG signed commit'}
            on={o.effective.commit.method !== 'none'}
            chosen={repo.settings.commitSigning === 'signed'}
            disabled={!o.signing.signedMethod || !o.signing.signingKey}
            busy={saving === 'sign'}
            onChoose={() => update('sign', { commitSigning: 'signed' as CommitSigningPreference }, 'Commits are signed by default')}
            facts={[
              o.signing.signingKey ? { ok: true, text: <>Key <span className="mono">{shortPath(o.signing.signingKey)}</span></>, origin: 'git' } : { ok: false, text: 'No user.signingkey in git config — set one up in Git first.' },
              o.signing.gpgFormat ? { ok: true, text: <>gpg.format <span className="mono">{o.signing.gpgFormat}</span></>, origin: 'git' } : null,
              o.signing.commitGpgSign ? { ok: true, text: 'commit.gpgsign = true', origin: 'git' } : null,
            ]}
          />
          <SignCard
            icon="✍"
            title="Unsigned (Git identity)"
            on={o.effective.commit.method === 'none'}
            chosen={repo.settings.commitSigning === 'unsigned'}
            busy={saving === 'sign'}
            onChoose={() => update('sign', { commitSigning: 'unsigned' as CommitSigningPreference }, 'Commits are unsigned by default')}
            facts={[
              o.signing.name || o.signing.email
                ? { ok: true, text: <>{o.signing.name ?? '?'} &lt;{o.signing.email ?? '?'}&gt;</>, origin: 'git' }
                : { ok: false, text: 'No user.name / user.email yet — set them under General.' },
            ]}
          />
        </div>
      </section>
    </div>
  );
}

function MethodCard(props: { icon: string; title: string; method: AuthMethod; o: RepoAccessOverview; chosen: boolean; busy: boolean; onChoose: () => void; facts: (Fact | null)[] }) {
  const { icon, title, method, o, chosen, busy, onChoose, facts } = props;
  const available = o.available.includes(method);
  const inUse = o.effective.remote.method === method;
  const overridden = chosen && !inUse && o.effective.remote.source === 'github-app';
  return (
    <ChoiceCard
      icon={icon}
      title={title}
      on={inUse}
      chosen={chosen}
      disabled={!available}
      busy={busy}
      onChoose={onChoose}
      facts={facts}
      note={!available ? 'Not available for this remote' : overridden ? 'GitHub App takes priority' : undefined}
    />
  );
}

function SignCard(props: { icon: string; title: string; on: boolean; chosen: boolean; disabled?: boolean; busy: boolean; onChoose: () => void; facts: (Fact | null)[] }) {
  return <ChoiceCard {...props} />;
}

function ChoiceCard(props: { icon: string; title: string; on: boolean; chosen: boolean; disabled?: boolean; busy: boolean; onChoose: () => void; facts: (Fact | null)[]; note?: string }) {
  const { icon, title, on, chosen, disabled, busy, onChoose, facts, note } = props;
  const list = facts.filter((f): f is Fact => !!f);
  return (
    <button type="button" className={`access-card ${on ? 'on' : ''} ${chosen ? 'chosen' : ''}`} disabled={disabled || busy} onClick={() => !chosen && onChoose()} aria-pressed={chosen}>
      <div className="access-card-top">
        <span className="access-ico">{icon}</span>
        <strong className="grow">{title}</strong>
        {on ? <span className="badge ok">✓ preselected</span> : chosen ? <span className="badge">chosen</span> : null}
      </div>
      <ul className="access-facts">
        {list.map((f, i) => (
          <li key={i} className={f.ok ? 'ok' : 'off'}>
            <span className="fact-dot" />
            <span className="grow">{f.text}</span>
            {f.origin && <span className={`origin origin-${f.origin}`}>{ORIGIN_LABEL[f.origin]}</span>}
          </li>
        ))}
      </ul>
      {note ? <div className="access-note">{note}</div> : !chosen && !disabled && <div className="access-cta">Use by default</div>}
    </button>
  );
}

function AutoChip({ on, busy, onClick }: { on: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button className={`auto-chip ${on ? 'on' : ''}`} disabled={on || busy} onClick={onClick} title="Follow what is set up (Git Baba, git config, system)">
      {on ? '✓ Automatic' : 'Reset to automatic'}
    </button>
  );
}

function Toggle({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <label className={`toggle ${on ? 'on' : ''} ${disabled ? 'disabled' : ''}`}>
      <span className="small">{label}</span>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

function shortPath(p: string): string {
  return p.length > 42 ? `…${p.slice(-40)}` : p;
}
