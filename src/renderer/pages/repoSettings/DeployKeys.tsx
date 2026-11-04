import { useMemo, useState } from 'react';
import type { DeployKey } from '../../../shared/github';
import { ErrorPanel } from '../../components/ErrorPanel';
import { relTime, Skeleton, useGh } from '../../components/github/common';
import { SecureActionDialog } from '../../components/github/SecureActionDialog';
import { maskPublicKey } from '../../components/SshKeyFields';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';

const keyBody = (k: string) => k.trim().split(/\s+/).slice(0, 2).join(' ');
const SSH_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-[\w@.-]+) [A-Za-z0-9+/=]+/;

/** Deploy keys: per-repository SSH keys for servers and CI — read-only by default, matched to keys on this computer. */
export function DeployKeys({ repoId }: { repoId: string }) {
  const keys = useGh(() => call('gh:adminDeployKeys', { repoId }), [repoId]);
  const local = useGh(() => call('ssh:listKeys'), []);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DeployKey | null>(null);
  const localBodies = useMemo(() => new Map((local.data?.keys ?? []).map((k) => [keyBody(k.publicKey), k.pubPath.replace(/^.*[\\/]/, '')])), [local.data]);

  if (keys.error) return <ErrorPanel error={keys.error} />;
  if (!keys.data) return <Skeleton rows={4} />;
  const writeCount = keys.data.filter((k) => !k.readOnly).length;

  return (
    <div>
      <div className="row mb">
        <span className="small muted grow">
          A deploy key grants one repository to one machine (a server, CI). Prefer read-only; a write key can push to every branch that is not protected.
        </span>
        <button className="btn sm primary" onClick={() => setAdding(true)}>
          ＋ Add deploy key
        </button>
      </div>
      {writeCount > 0 && (
        <div className="banner warn small">
          <span className="icon">⚠</span>
          <div>
            {writeCount} key(s) can <strong>push</strong> to this repository. Check you still need write access for each.
          </div>
        </div>
      )}
      {keys.data.length === 0 && <div className="empty small">No deploy keys.</div>}
      <div className="key-list">
        {keys.data.map((k) => {
          const stale = !k.lastUsed || Date.now() - new Date(k.lastUsed).getTime() > 90 * 86400_000;
          const mine = localBodies.get(keyBody(k.key));
          return (
            <div key={k.id} className="key-row">
              <span className="key-ico">{k.readOnly ? '🔐' : '✏️'}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <strong className="ellipsis">{k.title}</strong>
                  {k.readOnly ? <span className="badge ok">read-only</span> : <span className="badge warn">read / write</span>}
                  {!k.verified && <span className="badge warn">unverified</span>}
                  {mine && <span className="badge info" title="The private key is on this computer">{mine}</span>}
                  {stale && <span className="badge" title="Unused for 90+ days — consider removing it">stale</span>}
                </div>
                <div className="mono small muted ellipsis">{maskPublicKey(k.key)}</div>
                <div className="small muted">
                  added {relTime(k.createdAt)}
                  {k.addedBy ? ` by ${k.addedBy}` : ''} · {k.lastUsed ? `last used ${relTime(k.lastUsed)}` : 'never used'}
                </div>
              </div>
              <button className="btn sm danger" onClick={() => setRemoving(k)}>
                Delete…
              </button>
            </div>
          );
        })}
      </div>

      {adding && <AddDeployKey repoId={repoId} locals={local.data?.keys ?? []} onClose={() => setAdding(false)} onDone={() => void keys.reload()} />}
      {removing && (
        <SecureActionDialog
          title={`Delete deploy key “${removing.title}”`}
          icon="🗑"
          danger
          confirmLabel="Delete key"
          repoId={repoId}
          needs="admin access, or “Administration: write”"
          impact="Machines using this key lose access to the repository immediately."
          onClose={() => setRemoving(null)}
          onConfirm={async (auth) => {
            await call('gh:adminDeleteDeployKey', { repoId, id: removing.id, auth, confirmed: true });
            void keys.reload();
          }}
        />
      )}
    </div>
  );
}

function AddDeployKey({ repoId, locals, onClose, onDone }: { repoId: string; locals: { pubPath: string; publicKey: string; comment: string }[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [title, setTitle] = useState('');
  const [key, setKey] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const ok = !!title.trim() && SSH_RE.test(key.trim()) && !/PRIVATE KEY/.test(key);
  return (
    <SecureActionDialog
      title="Add a deploy key"
      icon="🔑"
      confirmLabel="Add deploy key"
      repoId={repoId}
      needs="admin access, or “Administration: write”"
      ready={ok}
      impact={readOnly ? undefined : 'This key will be able to push to the repository (unprotected branches), from any machine that holds it.'}
      onClose={onClose}
      onConfirm={async (auth) => {
        await call('gh:adminAddDeployKey', { repoId, title: title.trim(), key: key.trim(), readOnly, auth, confirmed: true });
        toast('Deploy key added');
        onDone();
      }}
    >
      <div className={`field ${title.trim() ? '' : 'invalid'}`}>
        <label>
          Title <span className="req">*</span>
        </label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="production-server" />
      </div>
      {locals.length > 0 && (
        <div className="field">
          <label>Use a key from this computer</label>
          <div className="store-picker">
            {locals.map((k) => (
              <button
                key={k.pubPath}
                className={`store-opt ${key.trim() === k.publicKey.trim() ? 'on' : ''}`}
                onClick={() => {
                  setKey(k.publicKey);
                  if (!title) setTitle(k.comment || k.pubPath.replace(/^.*[\\/]/, ''));
                }}
              >
                🔑 {k.pubPath.replace(/^.*[\\/]/, '')}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={`field ${key && !ok ? 'invalid' : ''}`}>
        <label>
          Public key <span className="req">*</span>
        </label>
        <textarea className="code" rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder="ssh-ed25519 AAAA… deploy@server" spellCheck={false} autoComplete="off" />
        {/PRIVATE KEY/.test(key) && <div className="field-hint">That is a PRIVATE key — never upload it. Paste the .pub file’s content.</div>}
      </div>
      <label className={`check ${readOnly ? '' : 'text-warn'}`}>
        <input type="checkbox" checked={!readOnly} onChange={(e) => setReadOnly(!e.target.checked)} /> Allow write access (push)
      </label>
    </SecureActionDialog>
  );
}
