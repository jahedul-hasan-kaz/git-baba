export interface StepDef {
  label: string;
  /** Short result shown under a finished step, e.g. "20 commits". */
  detail?: string;
}

interface Props {
  steps: StepDef[];
  /** Index of the active step. */
  current: number;
  /** The active step is working (spinner + pulse). */
  busy?: boolean;
  /** Index of a step that failed (shown in red). */
  failed?: number;
  /** Finished steps become clickable when this returns true — e.g. to go back. */
  canSelect?: (index: number) => boolean;
  onSelect?: (index: number) => void;
}

/**
 * Connected wizard stepper: numbered dots, a connector that fills as you progress, a check on finished
 * steps, a spinner on the active one while it works, and clickable finished steps where going back is safe.
 */
export function Stepper({ steps, current, busy, failed, canSelect, onSelect }: Props) {
  return (
    <ol className="stepper" role="list" style={{ listStyle: 'none', padding: 0 }}>
      {steps.map((s, i) => {
        const state = failed === i ? 'failed' : i < current ? 'done' : i === current ? 'current' : 'todo';
        const clickable = state === 'done' && !!onSelect && (canSelect ? canSelect(i) : true);
        const Tag = clickable ? 'button' : 'li';
        return (
          <Tag
            key={s.label}
            className={`stepper-item ${state} ${state === 'current' && busy ? 'busy' : ''} ${clickable ? 'clickable' : ''}`}
            {...(clickable ? { type: 'button' as const, onClick: () => onSelect!(i), title: `Go back to “${s.label}”` } : {})}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="stepper-dot">
              {state === 'done' ? <span className="stepper-tick">✓</span> : state === 'failed' ? '!' : state === 'current' && busy ? <span className="stepper-spin" /> : i + 1}
            </span>
            <span className="stepper-label">{s.label}</span>
            {s.detail && state === 'done' && <span className="stepper-detail" title={s.detail}>{s.detail}</span>}
          </Tag>
        );
      })}
    </ol>
  );
}
