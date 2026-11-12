import { useEffect, useRef, useState } from 'react';
import type { TransplantPreview } from '../../../shared/types';
import { authorColor, initials } from '../../pages/history/graphStyle';
import { call, toFriendly } from '../../services/api';
import { relative } from '../FileDiffList';

interface Props {
  repoId: string;
  source: string;
  base: string;
  target: string;
  revision: number;
  selected: Set<string>;
  setSelected: (fn: (s: Set<string>) => Set<string>) => void;
  /** Called once the commits are known: every selectable commit and the source tip. */
  onLoaded: (all: string[], head: string) => void;
}

/**
 * Pick which of a source's commits get merged: newest first, tick any of them (Shift+click for a range).
 * Only ticked commits are brought into the target, oldest first.
 */
export function CommitPicker({ repoId, source, base, target, revision, selected, setSelected, onLoaded }: Props) {
  const [p, setP] = useState<TransplantPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const last = useRef<string | null>(null);

  useEffect(() => {
    setP(null);
    setError(null);
    call('git:transplantPreview', { repoId, source, base, target })
      .then((x) => {
        setP(x);
        onLoaded(
          x.commits.filter((c) => !c.alreadyInTarget).map((c) => c.hash),
          x.sourceOid,
        );
      })
      .catch((e) => setError(toFriendly(e).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, source, base, target, revision]);

  if (error) return <div className="banner danger small">{error}</div>;
  if (!p) return <div className="small muted mm-shimmer">Reading {source}’s commits…</div>;
  if (!p.commits.length) return <div className="mp-empty">{source} has no commits of its own on top of {base}.</div>;

  const newest = [...p.commits].reverse(); // preview is oldest first
  const selectable = newest.filter((c) => !c.alreadyInTarget);
  const files = new Set(newest.filter((c) => selected.has(c.hash)).flatMap((c) => c.files));

  const click = (hash: string, shift: boolean) => {
    if (shift && last.current) {
      const a = selectable.findIndex((c) => c.hash === last.current);
      const b = selectable.findIndex((c) => c.hash === hash);
      if (a !== -1 && b !== -1) {
        const range = selectable.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.hash);
        return setSelected((s) => new Set([...s, ...range]));
      }
    }
    last.current = hash;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(hash)) n.delete(hash);
      else n.add(hash);
      return n;
    });
  };

  return (
    <div className="cp">
      <div className="cp-bar">
        <span className="small">
          <strong>{selectable.filter((c) => selected.has(c.hash)).length}</strong> of {selectable.length} commits · {files.size} file{files.size === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setSelected(() => new Set(selectable.map((c) => c.hash)))}>
          All
        </button>
        <button className="btn sm ghost" onClick={() => setSelected(() => new Set())}>
          None
        </button>
      </div>
      <div className="cp-list">
        {newest.map((c) => {
          const on = selected.has(c.hash);
          return (
            <div key={c.hash} className={`cp-row ${on ? 'on' : ''} ${c.alreadyInTarget ? 'done' : ''}`}>
              <div className="cp-main" onClick={(e) => !c.alreadyInTarget && click(c.hash, e.shiftKey)}>
                <span className={`pk-box ${on ? 'all' : 'none'}`}>{on ? '✓' : ''}</span>
                <span className="cp-avatar" style={{ background: authorColor(c.email || c.author) }}>
                  {initials(c.author)}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="cp-subj ellipsis">{c.subject}</span>
                  <span className="small muted ellipsis">
                    <span className="mono">{c.shortHash}</span> · {c.author} · {relative(c.date)}
                  </span>
                </span>
                {c.alreadyInTarget && (
                  <span className="badge ok" title={`${target} already has this change`}>
                    already in {target.replace(/^origin\//, '')}
                  </span>
                )}
                <button
                  className="btn sm ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(open === c.hash ? null : c.hash);
                  }}
                >
                  {c.files.length} file{c.files.length === 1 ? '' : 's'}
                </button>
              </div>
              {open === c.hash && (
                <div className="cp-files mono small">
                  {c.files.map((f) => (
                    <div key={f}>{f}</div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="small muted cp-note">
        Ticked commits are applied oldest first. Skipping an earlier commit that a later one builds on can cause conflicts.
        {p.mergesSkipped > 0 ? ` ${p.mergesSkipped} merge commit(s) are not listed — only regular commits can be picked.` : ''}
      </div>
    </div>
  );
}
