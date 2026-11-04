import { useState } from 'react';
import type { GhRepoContext } from '../../../shared/github';
import { SecureActionDialog } from '../../components/github/SecureActionDialog';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';

/** Deleting the repository on GitHub — the most destructive action, behind impact review, auth and a typed name. */
export function DangerZone({ repoId, ctx }: { repoId: string; ctx: GhRepoContext }) {
  const { activeRepo, selectRepo, toast, bump } = useApp();
  const [step, setStep] = useState<'idle' | 'delete' | 'after'>('idle');
  const full = `${ctx.owner}/${ctx.name}`;

  return (
    <div>
      <div className="danger-card">
        <div className="grow">
          <strong>Delete this repository on GitHub</strong>
          <div className="small muted">
            Permanently deletes <span className="mono">{full}</span> on GitHub: code, issues, pull requests, wiki, Actions history, secrets, releases and stars. Forks of a public
            repository are kept and one is promoted. GitHub may allow a short restore window for some repositories.
          </div>
        </div>
        <button className="btn danger solid" onClick={() => setStep('delete')}>
          Delete repository…
        </button>
      </div>
      <p className="small muted mt">
        Your local clone at <span className="mono">{activeRepo?.path}</span> is never touched. To only remove it from Git Baba, use General → Remove from Git Baba.
      </p>

      {step === 'delete' && (
        <SecureActionDialog
          title={`Delete ${full}`}
          icon="🗑"
          danger
          confirmLabel="I understand — delete this repository"
          repoId={repoId}
          needs="admin access and the “delete_repo” scope (classic) or “Administration: write” (fine-grained)"
          typeToConfirm={full}
          impact={
            <>
              This cannot be undone from Git Baba. Everyone loses access immediately, open pull requests close, and deploy keys and webhooks stop working.
              {ctx.isPrivate ? ' Private repository: there are no forks to keep a copy.' : ''}
            </>
          }
          onClose={() => setStep((s) => (s === 'delete' ? 'idle' : s))}
          onConfirm={async (auth) => {
            await call('gh:adminDeleteRepo', { repoId, typedName: full, auth, confirmed: true });
            toast(`${full} deleted on GitHub`);
            setStep('after');
          }}
        >
          <div className="checklist">
            <div className="check-item done">✓ Visibility: {ctx.isPrivate ? 'private' : 'public'}</div>
            <div className="check-item done">✓ Default branch: {ctx.defaultBranch}</div>
            <div className="check-item done">✓ Your role: {ctx.permissions.level.toLowerCase()}</div>
          </div>
        </SecureActionDialog>
      )}
      {step === 'after' && (
        <ConfirmDialog
          title="Also remove it from Git Baba?"
          explanation={<>{full} no longer exists on GitHub. Your local clone still has the full history.</>}
          impact="Removing it from Git Baba keeps the folder on disk; you can add it again any time."
          confirmLabel="Remove from Git Baba"
          onCancel={() => {
            setStep('idle');
            bump();
          }}
          onConfirm={async () => {
            await call('repo:remove', { repoId });
            selectRepo(null);
            bump();
            setStep('idle');
          }}
        />
      )}
    </div>
  );
}
