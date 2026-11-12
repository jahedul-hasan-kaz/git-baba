import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

const ModalCloseContext = createContext<(() => void) | null>(null);

/** Closes the dialog this component is rendered in (null outside a dialog). */
export function useEnclosingModalClose(): (() => void) | null {
  return useContext(ModalCloseContext);
}

interface Props {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  size?: 'narrow' | 'normal' | 'wide';
  children: ReactNode;
  /** Prevent closing with Escape while an operation is running. */
  locked?: boolean;
}

export function Modal({ title, icon, onClose, footer, size = 'normal', children, locked }: Props) {
  const backdrop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || locked) return;
      // With stacked dialogs, Escape closes only the top-most one.
      const all = document.querySelectorAll('.modal-backdrop');
      if (all.length && all[all.length - 1] !== backdrop.current) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, locked]);

  return (
    <div ref={backdrop} className="modal-backdrop" role="dialog" aria-modal="true">
      <div className={`modal ${size === 'normal' ? '' : size}`}>
        <div className="modal-header">
          {icon && <span style={{ fontSize: 18 }}>{icon}</span>}
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} disabled={locked} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <ModalCloseContext.Provider value={onClose}>{children}</ModalCloseContext.Provider>
        </div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row muted">
      <span className="spinner" /> {label}
    </span>
  );
}
