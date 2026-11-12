import type { WorkflowStep } from '../../shared/types';
import { ErrorPanel } from './ErrorPanel';

const ICON: Record<WorkflowStep['status'], string> = {
  pending: '○',
  running: '◌',
  done: '✓',
  failed: '✗',
  skipped: '–',
};

/** Vertical list of workflow steps with status, details and the error of a failed step. */
export function WorkflowSteps({ steps, onReviewAuth }: { steps: WorkflowStep[]; onReviewAuth?: () => void }) {
  return (
    <div className="wf-steps">
      {steps.map((s) => (
        <div key={s.id} className={`wf-step ${s.status}`}>
          <span className="wf-icon">{s.status === 'running' ? <span className="spinner" /> : ICON[s.status]}</span>
          <div className="grow">
            <div className="wf-label">
              {s.label}
              {s.status === 'skipped' && <span className="muted small"> (not needed)</span>}
            </div>
            {s.detail && <div className="small muted">{s.detail}</div>}
            {s.error && (
              <div className="mt">
                <ErrorPanel error={s.error} onAction={(a) => a === 'review-auth' && onReviewAuth?.()} available={onReviewAuth ? ['review-auth'] : []} />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
