import { useEffect, useRef, useState } from 'react';
import type { CodeInfo } from '../../../shared/types';

/** GitHub-style branch / tag switcher for the code browser (only changes what is viewed). */
export function RefPicker({ info, value, onChange, openTab, onOpened }: { info: CodeInfo; value: string; onChange: (ref: string) => void; openTab?: 'branches' | 'tags' | null; onOpened?: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'branches' | 'tags'>('branches');
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openTab) return;
    setTab(openTab);
    setOpen(true);
    onOpened?.();
  }, [openTab, onOpened]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const isTag = info.tags.includes(value) && !info.branches.includes(value);
  const pick = (r: string) => {
    onChange(r);
    setOpen(false);
    setFilter('');
  };

  const row = (name: string, extra?: React.ReactNode) => (
    <div key={name} className={`ref-option ${name === value ? 'on' : ''}`} onClick={() => pick(name)}>
      <span className="ref-check">{name === value ? '✓' : ''}</span>
      <span className="grow ellipsis mono">{name}</span>
      {extra}
    </div>
  );

  const local = info.branches.filter(match);
  const remote = info.remoteBranches.filter((r) => match(r) && !info.branches.includes(r.split('/').slice(1).join('/')));
  const tags = info.tags.filter(match);

  return (
    <div className="ref-picker" ref={box}>
      <button className="btn ref-trigger" onClick={() => setOpen((o) => !o)} title="Choose the branch or tag to browse">
        <span>{isTag ? '🏷' : '⎇'}</span>
        <strong className="ellipsis" style={{ maxWidth: 220 }}>
          {value}
        </strong>
        <span className="muted">▾</span>
      </button>
      {open && (
        <div className="ref-menu pop-in">
          <div className="ref-menu-head">
            <strong>Switch branches/tags</strong>
            <span className="muted small">viewing only — your checkout does not change</span>
          </div>
          <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tab === 'branches' ? 'Find a branch…' : 'Find a tag…'} />
          <div className="segmented ref-tabs">
            <button className={tab === 'branches' ? 'on' : ''} onClick={() => setTab('branches')}>
              Branches <span className="badge">{info.branches.length + info.remoteBranches.length}</span>
            </button>
            <button className={tab === 'tags' ? 'on' : ''} onClick={() => setTab('tags')}>
              Tags <span className="badge">{info.tags.length}</span>
            </button>
          </div>
          <div className="ref-options">
            {tab === 'branches' ? (
              <>
                {local.map((b) =>
                  row(
                    b,
                    <>
                      {b === info.defaultBranch && <span className="badge">default</span>}
                      {b === info.current && <span className="badge ok">checked out</span>}
                    </>,
                  ),
                )}
                {remote.length > 0 && <div className="ref-group">Remote only</div>}
                {remote.map((b) => row(b))}
                {local.length + remote.length === 0 && <div className="empty small">Nothing matches “{filter}”.</div>}
              </>
            ) : (
              <>
                {tags.map((t) => row(t))}
                {tags.length === 0 && <div className="empty small">{info.tags.length ? `Nothing matches “${filter}”.` : 'This repository has no tags.'}</div>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
