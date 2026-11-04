import { useEffect, useRef, useState, type ReactNode } from 'react';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

export interface ResultAction {
  label: string;
  run: () => void;
  primary?: boolean;
  title?: string;
}

interface Props {
  tone: 'ok' | 'warn';
  title: ReactNode;
  /** One short line under the title. */
  subtitle?: ReactNode;
  /** Small facts shown as chips, e.g. ["main → origin/main", "3 commits"]. */
  chips?: ReactNode[];
  /** A commit id shown as a copyable chip. */
  sha?: string | null;
  /** Next steps; the first primary one gets focus. "Done" is always added last. */
  actions?: ResultAction[];
  /** Fine print (authentication used, token revocation…). */
  note?: ReactNode;
  /** Raw output, collapsed. */
  details?: string;
  onClose: () => void;
}

/**
 * Compact outcome window for push / merge: an animated check, one line of what happened, copyable commit
 * and the next useful steps. Raw git output stays folded away. Esc or Enter closes it.
 */
export function ResultCard({ tone, title, subtitle, chips = [], sha, actions = [], note, details, onClose }: Props) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    first.current?.focus();
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  const copy = () => {
    if (!sha) return;
    void call('app:copyText', { text: sha })
      .then(() => {
        setCopied(true);
        toast('Commit id copied');
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const primaryIdx = actions.findIndex((a) => a.primary);
  return (
    <div className="modal-backdrop rc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`rc ${tone}`} role="dialog" aria-modal="true" aria-live="polite">
        <div className="rc-burst" aria-hidden>
          <svg viewBox="0 0 52 52" width="44" height="44">
            <circle className="rc-ring" cx="26" cy="26" r="23" fill="none" />
            {tone === 'ok' ? <path className="rc-tick" fill="none" d="M15 27 l7 7 l15 -16" /> : <path className="rc-tick" fill="none" d="M26 14 v16 M26 37 v1" />}
          </svg>
          {tone === 'ok' && (
            <span className="rc-sparks">
              {Array.from({ length: 8 }, (_, i) => (
                <i key={i} style={{ ['--r' as string]: `${i * 45}deg` }} />
              ))}
            </span>
          )}
        </div>
        <div className="rc-body">
          <div className="rc-title">{title}</div>
          {subtitle && <div className="rc-sub">{subtitle}</div>}
          {(chips.length > 0 || sha) && (
            <div className="rc-chips">
              {chips.map((c, i) => (
                <span key={i} className="rc-chip">
                  {c}
                </span>
              ))}
              {sha && (
                <button className={`rc-chip mono rc-sha ${copied ? 'copied' : ''}`} onClick={copy} title="Copy the full commit id">
                  {copied ? '✓ copied' : `⧉ ${sha.slice(0, 8)}`}
                </button>
              )}
            </div>
          )}
          {note && <div className="rc-note">{note}</div>}
          {details && (
            <details className="rc-details">
              <summary>Git output</summary>
              <pre>{details}</pre>
            </details>
          )}
          <div className="rc-actions">
            {actions.map((a, i) => (
              <button key={a.label} ref={i === (primaryIdx < 0 ? -1 : primaryIdx) ? first : undefined} className={`btn sm ${a.primary ? 'primary' : ''}`} onClick={a.run} title={a.title}>
                {a.label}
              </button>
            ))}
            <span className="spacer" />
            <button ref={primaryIdx < 0 ? first : undefined} className={`btn sm ${primaryIdx < 0 ? 'primary' : 'ghost'}`} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A deliberate confirm: press and hold (mouse, touch, Enter or Space) until the bar fills. Releasing early
 * cancels. Replaces a separate "I confirm" checkbox for actions that change shared history.
 */
export function HoldToConfirm({ label, holdingLabel = 'Keep holding…', disabled, danger, ms = 900, onConfirm }: { label: string; holdingLabel?: string; disabled?: boolean; danger?: boolean; ms?: number; onConfirm: () => void }) {
  const [p, setP] = useState(0);
  const raf = useRef<number | null>(null);
  const start = useRef(0);
  const done = useRef(false);

  const stop = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (!done.current) setP(0);
  };
  const begin = () => {
    if (disabled || raf.current) return;
    done.current = false;
    start.current = performance.now();
    const tick = (t: number) => {
      const v = Math.min(1, (t - start.current) / ms);
      setP(v);
      if (v >= 1) {
        done.current = true;
        raf.current = null;
        onConfirm();
        window.setTimeout(() => setP(0), 400);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <button
      className={`btn hold-btn ${danger ? 'danger solid' : 'primary'} ${p > 0 ? 'holding' : ''}`}
      disabled={disabled}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => (e.key === 'Enter' || e.key === ' ') && stop()}
      onBlur={stop}
      title="Press and hold to confirm (mouse, Enter or Space)"
    >
      <span className="hold-fill" style={{ transform: `scaleX(${p})` }} aria-hidden />
      <span className="hold-text">{p > 0 && p < 1 ? holdingLabel : label}</span>
    </button>
  );
}
