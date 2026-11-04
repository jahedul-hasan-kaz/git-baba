import { useMemo, useState } from 'react';
import type { GhRepoContext, GhSecret, SecretScope, SecretsOverview } from '../../../shared/github';
import { ErrorPanel } from '../../components/ErrorPanel';
import { relTime, Skeleton, useGh, useMutation } from '../../components/github/common';
import { openExternal, SecureActionDialog } from '../../components/github/SecureActionDialog';
import { Modal } from '../../components/Modal';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';

import { Select } from '../../components/Select';
interface Store {
  key: string;
  scope: SecretScope;
  env?: string;
  icon: string;
  title: string;
  hint: string;
  secrets: GhSecret[] | null;
  error: string | null;
  manageable: boolean;
  protectedEnv?: boolean;
}

type Editing = { store: Store; name?: string } | null;
type Deleting = { store: Store; name: string } | null;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stores(o: SecretsOverview): Store[] {
  const out: Store[] = [
    { key: 'repo', scope: 'repo', icon: '📦', title: 'Repository', hint: 'Available to every workflow in this repository.', secrets: o.repo, error: o.repoError, manageable: true },
    {
      key: 'copilot',
      scope: 'copilot',
      icon: '🤖',
      title: 'Copilot coding agent',
      hint: o.copilot.exists ? 'Secrets the Copilot coding agent can use (the “copilot” environment).' : 'Not set up yet — adding a secret creates the “copilot” environment for the agent.',
      secrets: o.copilot.exists ? o.copilot.secrets : [],
      error: o.copilot.error,
      manageable: true,
    },
    ...o.environments.map((e) => ({
      key: `env:${e.name}`,
      scope: 'env' as const,
      env: e.name,
      icon: e.protected ? '🛡' : '🌐',
      title: `Environment · ${e.name}`,
      hint: e.protected ? 'Protected environment — jobs may need approval before they can read these.' : 'Only jobs that target this environment can read these.',
      secrets: e.secrets,
      error: e.error,
      manageable: true,
      protectedEnv: e.protected,
    })),
  ];
  if (o.org) {
    out.push({
      key: 'org',
      scope: 'org',
      icon: '🏢',
      title: `Organisation · ${o.org.name}`,
      hint: o.org.manageable ? 'Shared with this repository by the organisation. You can manage organisation secrets.' : 'Shared with this repository by the organisation (read-only: managing them needs organisation admin).',
      secrets: o.org.secrets,
      error: o.org.error,
      manageable: o.org.manageable,
    });
  }
  return out;
}

/**
 * Every secret store that applies to this repository in one place — repository, Copilot coding agent,
 * environments and organisation — plus which workflows use each secret, and secrets referenced but missing.
 * Values are encrypted on this computer and are write-only: GitHub (and Git Baba) never shows them again.
 */
export function RepoSecrets({ repoId, ctx }: { repoId: string; ctx: GhRepoContext }) {
  const overview = useGh(() => call('gh:adminSecrets', { repoId }), [repoId]);
  const usage = useGh(() => call('gh:adminSecretUsage', { repoId }), [repoId]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Deleting>(null);
  const [newEnv, setNewEnv] = useState(false);

  const list = useMemo(() => (overview.data ? stores(overview.data) : []), [overview.data]);
  const defined = useMemo(() => new Set(list.flatMap((s) => (s.secrets ?? []).map((x) => x.name))), [list]);
  const missing = useMemo(() => Object.entries(usage.data ?? {}).filter(([n]) => !defined.has(n)), [usage.data, defined]);
  const total = list.reduce((n, s) => n + (s.secrets?.length ?? 0), 0);
  const query = q.trim().toUpperCase();
  const reload = () => {
    void overview.reload();
  };

  if (overview.error) return <ErrorPanel error={overview.error} />;
  if (!overview.data) return <Skeleton rows={6} />;

  return (
    <div>
      <div className="secret-summary">
        <div className="stat-tile">
          <span className="stat-ico">🔐</span>
          <div>
            <div className="stat-value">{total}</div>
            <div className="small muted">secrets in {list.filter((s) => (s.secrets?.length ?? 0) > 0).length} store(s)</div>
          </div>
        </div>
        <div className={`stat-tile ${missing.length ? 'danger' : ''}`}>
          <span className="stat-ico">{missing.length ? '⚠' : '✓'}</span>
          <div>
            <div className="stat-value">{usage.data ? missing.length : '…'}</div>
            <div className="small muted">referenced in workflows but missing</div>
          </div>
        </div>
        <div className="stat-tile">
          <span className="stat-ico">💤</span>
          <div>
            <div className="stat-value">{usage.data ? [...defined].filter((n) => !usage.data![n]).length : '…'}</div>
            <div className="small muted">not used by any workflow</div>
          </div>
        </div>
        <div className="actions-search" style={{ minWidth: 220 }}>
          <span>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a secret…" spellCheck={false} />
        </div>
      </div>

      {missing.length > 0 && (
        <div className="banner warn small">
          <span className="icon">⚠</span>
          <div className="grow">
            Workflows reference secrets that do not exist here:{' '}
            {missing.map(([n, wfs]) => (
              <button key={n} className="secret-missing" title={`Used in: ${wfs.join(', ')}`} onClick={() => setEditing({ store: list[0], name: n })}>
                {n} ＋
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="secret-stores">
        {list.map((s) => {
          const items = (s.secrets ?? []).filter((x) => !query || x.name.includes(query));
          if (query && items.length === 0) return null;
          return (
            <div key={s.key} className={`secret-store ${s.protectedEnv ? 'protected' : ''}`}>
              <div className="secret-store-head">
                <span className="secret-store-ico">{s.icon}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong>{s.title}</strong> <span className="badge">{s.secrets?.length ?? 0}</span>
                  <div className="small muted">{s.hint}</div>
                </div>
                {s.manageable && (
                  <button className="btn sm primary" onClick={() => setEditing({ store: s })}>
                    ＋ New secret
                  </button>
                )}
              </div>
              {s.error && <div className="small text-danger pad">{s.error}</div>}
              {!s.error && items.length === 0 && <div className="small muted pad">No secrets.</div>}
              {items.map((x) => {
                const used = usage.data?.[x.name];
                return (
                  <div key={x.name} className="secret-row">
                    <span className="secret-lock">🔒</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <strong className="mono">{x.name}</strong>
                        {x.visibility && <span className="badge">{x.visibility === 'all' ? 'all repositories' : x.visibility === 'private' ? 'private repositories' : 'selected repositories'}</span>}
                      </div>
                      <div className="small muted">
                        updated {relTime(x.updatedAt)}
                        {used ? (
                          <>
                            {' '}
                            · used by{' '}
                            {used.map((w) => (
                              <span key={w} className="wf-use">
                                {w}
                              </span>
                            ))}
                          </>
                        ) : usage.data ? (
                          ' · not referenced by any workflow'
                        ) : (
                          ''
                        )}
                      </div>
                    </div>
                    {s.manageable && (
                      <>
                        <button className="btn sm" onClick={() => setEditing({ store: s, name: x.name })} title="Replace the value">
                          ✎ Update
                        </button>
                        <button className="btn sm ghost danger-text" onClick={() => setDeleting({ store: s, name: x.name })}>
                          🗑
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="row mt">
        <button className="btn sm" onClick={() => setNewEnv(true)}>
          ＋ New environment
        </button>
        <button className="btn sm ghost" onClick={() => openExternal(`https://github.com/${ctx.owner}/${ctx.name}/settings/environments`)}>
          Environment protection rules ↗
        </button>
      </div>

      {editing && <SecretEditor repoId={repoId} ctx={ctx} stores={list.filter((s) => s.manageable)} initial={editing} onClose={() => setEditing(null)} onDone={reload} />}
      {deleting && (
        <SecureActionDialog
          title={`Delete secret ${deleting.name}`}
          icon="🗑"
          danger
          confirmLabel="Delete secret"
          repoId={repoId}
          needs="admin access, or “Secrets: write” (fine-grained)"
          typeToConfirm={deleting.name}
          impact={
            usage.data?.[deleting.name]
              ? `Workflows that use it will fail: ${usage.data[deleting.name].join(', ')}.`
              : 'Any workflow or job that reads it will get an empty value.'
          }
          onClose={() => setDeleting(null)}
          onConfirm={async (auth) => {
            await call('gh:adminDeleteSecret', { repoId, scope: deleting.store.scope, env: deleting.store.env, name: deleting.name, auth, confirmed: true });
            reload();
          }}
        >
          <p>
            Deletes <strong className="mono">{deleting.name}</strong> from <strong>{deleting.store.title}</strong>. The value cannot be recovered.
          </p>
        </SecureActionDialog>
      )}
      {newEnv && <NewEnvDialog repoId={repoId} onClose={() => setNewEnv(false)} onDone={reload} />}
    </div>
  );
}

/** Two steps: compose (store, name, value) → authenticate. The value lives only in this dialog and is cleared after use. */
function SecretEditor({ repoId, ctx, stores: list, initial, onClose, onDone }: { repoId: string; ctx: GhRepoContext; stores: Store[]; initial: NonNullable<Editing>; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [storeKey, setStoreKey] = useState(initial.store.key);
  const [name, setName] = useState(initial.name ?? '');
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [orgVisibility, setOrgVisibility] = useState<'all' | 'private' | 'selected'>('selected');
  const [step, setStep] = useState<1 | 2>(1);
  const store = list.find((s) => s.key === storeKey) ?? list[0];
  const upper = name.trim().toUpperCase();
  const exists = (store.secrets ?? []).some((x) => x.name === upper);
  const nameErr = !upper ? null : !NAME_RE.test(upper) ? 'Letters, digits and _ only, not starting with a digit.' : upper.startsWith('GITHUB_') ? 'Names starting with GITHUB_ are reserved.' : null;
  const looks = value.includes('PRIVATE KEY') ? 'a private key' : /^gh[pousr]_[A-Za-z0-9]{20,}$/.test(value.trim()) ? 'a GitHub token' : /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value.trim()) ? 'a JWT' : null;
  const close = () => {
    setValue('');
    onClose();
  };

  if (step === 2) {
    return (
      <SecureActionDialog
        title={`${exists ? 'Update' : 'Create'} secret ${upper}`}
        icon="🔐"
        confirmLabel={exists ? 'Replace value' : 'Save secret'}
        repoId={repoId}
        needs={store.scope === 'org' ? 'organisation admin, or “Organization secrets: write”' : 'admin access, or “Secrets: write” (fine-grained)'}
        impact={exists ? 'The current value is replaced for every workflow run that starts from now on.' : undefined}
        onClose={close}
        onConfirm={async (auth) => {
          await call('gh:adminPutSecret', { repoId, scope: store.scope, env: store.env, name: upper, value, orgVisibility: store.scope === 'org' ? orgVisibility : undefined, auth, confirmed: true });
          toast(`Secret ${upper} saved`);
          setValue('');
          onDone();
        }}
      >
        <div className="card">
          <dl className="kv">
            <dt>Secret</dt>
            <dd className="mono">{upper}</dd>
            <dt>Store</dt>
            <dd>
              {store.icon} {store.title}
            </dd>
            <dt>Value</dt>
            <dd>
              {'•'.repeat(Math.min(value.length, 24))} <span className="small muted">({value.length} characters)</span>
            </dd>
            <dt>Protection</dt>
            <dd className="small">Encrypted on this computer with {ctx.owner}/{ctx.name}’s public key (libsodium sealed box) before it is sent. Nobody can read it back — not even you.</dd>
          </dl>
        </div>
      </SecureActionDialog>
    );
  }

  return (
    <Modal
      title={initial.name ? `Update ${initial.name}` : 'New secret'}
      icon="🔐"
      size="wide"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!upper || !!nameErr || !value} onClick={() => setStep(2)}>
            Review & authenticate →
          </button>
        </>
      }
    >
      <div className="field">
        <label>Where</label>
        <div className="store-picker">
          {list.map((s) => (
            <button key={s.key} className={`store-opt ${s.key === store.key ? 'on' : ''}`} onClick={() => setStoreKey(s.key)} disabled={!!initial.name}>
              <span>{s.icon}</span> {s.title}
            </button>
          ))}
        </div>
        <div className="hint">{store.hint}</div>
      </div>
      {store.scope === 'org' && (
        <div className="field">
          <label>Repository access</label>
          <Select value={orgVisibility} onChange={(e) => setOrgVisibility(e.target.value as typeof orgVisibility)}>
            <option value="selected">Only this repository (selected)</option>
            <option value="private">All private repositories</option>
            <option value="all">All repositories</option>
          </Select>
        </div>
      )}
      <div className={`field ${nameErr ? 'invalid' : ''}`}>
        <label>
          Name <span className="req">*</span>
        </label>
        <input className="mono" value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '_'))} placeholder="API_TOKEN" disabled={!!initial.name} spellCheck={false} autoComplete="off" />
        {nameErr && <div className="field-hint">{nameErr}</div>}
        {!nameErr && upper && exists && !initial.name && <div className="small text-warn">A secret with this name exists — saving replaces its value.</div>}
      </div>
      <div className="field">
        <label>
          Value <span className="req">*</span>
        </label>
        <div className="secret-value">
          <textarea
            className={`code ${show ? '' : 'masked'}`}
            rows={4}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste the value"
          />
          <button type="button" className="btn sm ghost" onClick={() => setShow((s) => !s)}>
            {show ? '🙈 Hide' : '👁 Show'}
          </button>
        </div>
        <div className="hint">
          {value.length} characters
          {looks ? ` · looks like ${looks}` : ''}
          {value !== value.trim() ? ' · ⚠ has leading/trailing whitespace' : ''} · max 48 KB. Never written to disk.
        </div>
      </div>
    </Modal>
  );
}

function NewEnvDialog({ repoId, onClose, onDone }: { repoId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const { busy, run } = useMutation();
  const ok = /^[^/\\'"]{1,255}$/.test(name.trim());
  return (
    <Modal
      title="New environment"
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!ok || busy}
            onClick={() =>
              void run(() => call('gh:adminCreateEnv', { repoId, name: name.trim() }).then(() => true), `Environment ${name.trim()} created`).then((r) => {
                if (r) {
                  onDone();
                  onClose();
                }
              })
            }
          >
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="production" autoFocus />
        <div className="hint">Add protection rules (reviewers, wait timers, branch limits) on GitHub afterwards.</div>
      </div>
    </Modal>
  );
}
