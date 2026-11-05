import { useEffect, useState } from 'react';
import type { GhRepoContext } from '../../../shared/github';
import type { FriendlyError } from '../../../shared/types';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Skeleton } from '../../components/github/common';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';
import { RepoSettingsPage } from '../RepoSettingsPage';
import { DangerZone } from './DangerZone';
import { DeployKeys } from './DeployKeys';
import { RemoteRefs } from './RemoteRefs';
import { RepoSecrets } from './RepoSecrets';
import { RepoAccess } from './RepoAccess';
import { RoleCard } from './RoleCard';

type Section = 'general' | 'access' | 'secrets' | 'deploy-keys' | 'refs' | 'danger';

interface Item {
  id: Section;
  icon: string;
  label: string;
  hint: string;
  /** Needs the GitHub context; checked against the account's role on the repository. */
  needs?: 'read' | 'admin';
}

const ITEMS: Item[] = [
  { id: 'general', icon: '⚙', label: 'General', hint: 'Who you commit as, remotes, remove' },
  { id: 'access', icon: '🛡', label: 'Security & access', hint: 'Push & merge credential, GitHub App, commit signing' },
  { id: 'secrets', icon: '🔐', label: 'Secrets', hint: 'Actions, Copilot agent, environments, organisation', needs: 'admin' },
  { id: 'deploy-keys', icon: '🔑', label: 'Deploy keys', hint: 'Machine access with SSH', needs: 'admin' },
  { id: 'refs', icon: '⎇', label: 'Branches, tags & commits', hint: 'As they are on GitHub', needs: 'read' },
  { id: 'danger', icon: '⚠', label: 'Danger zone', hint: 'Delete on GitHub', needs: 'admin' },
];

/**
 * Repository-level settings. Local settings are always available; GitHub sections appear only when the
 * repository is on GitHub and the signed-in account's role allows them (no disabled features to click on).
 */
export function RepoSettingsShell() {
  const { activeRepo, ghKey } = useApp();
  const repo = activeRepo!;
  const [section, setSection] = useState<Section>('general');
  const [ctx, setCtx] = useState<GhRepoContext | null>(null);
  const [ctxError, setCtxError] = useState<FriendlyError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!repo.github) return;
    let live = true;
    setLoading(true);
    setCtxError(null);
    call('gh:context', { repoId: repo.id })
      .then((c) => live && setCtx(c))
      .catch((err) => {
        if (!live) return;
        setCtx(null);
        setCtxError(toFriendly(err));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [repo.id, repo.github, ghKey]);

  const allowed = (i: Item) => !i.needs || (!!ctx && (i.needs === 'read' || ctx.permissions.canAdmin));
  const visible = ITEMS.filter((i) => !i.needs || (repo.github && allowed(i)));
  const current = visible.some((i) => i.id === section) ? section : 'general';

  return (
    <div className="settings-layout repo-settings">
      <nav className="settings-nav">
        <div className="settings-nav-group">This computer</div>
        {visible
          .filter((i) => !i.needs)
          .map((i) => (
            <NavItem key={i.id} item={i} on={current === i.id} onClick={() => setSection(i.id)} />
          ))}
        {repo.github && (
          <>
            <div className="settings-nav-group">
              GitHub · {repo.github.owner}/{repo.github.repo}
            </div>
            {loading && !ctx && <Skeleton rows={3} />}
            {visible
              .filter((i) => i.needs)
              .map((i) => (
                <NavItem key={i.id} item={i} on={current === i.id} onClick={() => setSection(i.id)} />
              ))}
            {ctx && (
              <RoleCard ctx={ctx} />
            )}
            {ctxError && !ctx && <div className="role-note small muted">Sign in to manage GitHub settings.</div>}
          </>
        )}
      </nav>
      <div className="settings-body">
        <h2 style={{ marginTop: 0 }}>{ITEMS.find((i) => i.id === current)!.label}</h2>
        {current === 'general' && <RepoSettingsPage onManageAccess={() => setSection('access')} />}
        {current === 'access' && <RepoAccess appsAvailable={!!ctx} />}
        {ITEMS.find((i) => i.id === current)?.needs && ctxError && !ctx && <ErrorPanel error={ctxError} />}
        {ctx && current === 'secrets' && <RepoSecrets repoId={repo.id} ctx={ctx} />}
        {ctx && current === 'deploy-keys' && <DeployKeys repoId={repo.id} />}
        {ctx && current === 'refs' && <RemoteRefs repoId={repo.id} ctx={ctx} />}
        {ctx && current === 'danger' && <DangerZone repoId={repo.id} ctx={ctx} />}
      </div>
    </div>
  );
}

function NavItem({ item, on, onClick }: { item: Item; on: boolean; onClick: () => void }) {
  return (
    <button className={`settings-nav-item ${on ? 'on' : ''} ${item.id === 'danger' ? 'danger' : ''}`} onClick={onClick}>
      <span className="settings-nav-ico">{item.icon}</span>
      <span className="grow">
        <span className="settings-nav-label">{item.label}</span>
        <span className="settings-nav-hint">{item.hint}</span>
      </span>
    </button>
  );
}
