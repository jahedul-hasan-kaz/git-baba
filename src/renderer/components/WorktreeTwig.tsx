import { useMemo, useState } from 'react';
import type { RepoSummary } from '../../shared/types';

/** Rows shown before "+N more" — the open worktree and ones with changes are always among them. */
const PEEK = 4;
/** From this many worktrees the expanded list gets its own filter. */
const FILTER_FROM = 7;

const label = (w: RepoSummary) => w.branch ?? w.name;

/** "feature/tree/" dimmed, "tree-test" emphasised: long branch names stay readable when truncated. */
function BranchName({ name, query }: { name: string; query: string }) {
  const cut = name.lastIndexOf('/') + 1;
  const head = name.slice(0, cut);
  const leaf = name.slice(cut);
  const mark = (text: string) => {
    const q = query.trim().toLowerCase();
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    if (i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    );
  };
  return (
    <span className="wtw-name ellipsis grow" dir="ltr">
      {head && <span className="wtw-prefix">{mark(head)}</span>}
      <span className="wtw-leaf">{mark(leaf)}</span>
    </span>
  );
}

/**
 * The worktrees of one repository that are open in Git Baba, as a small branch off its sidebar row.
 * Scales to many: the open, changed and matching ones first, the rest behind "+N more", and a filter for long lists.
 */
export function WorktreeTwig({
  parent,
  worktrees,
  activeRepoId,
  query,
  onSelect,
  onContext,
}: {
  parent: RepoSummary;
  worktrees: RepoSummary[];
  activeRepoId: string | null;
  query: string;
  onSelect: (id: string) => void;
  onContext: (repo: RepoSummary, x: number, y: number) => void;
}) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState('');
  const q = (query.trim() || filter.trim()).toLowerCase();

  const ordered = useMemo(() => {
    const rank = (w: RepoSummary) => (w.id === activeRepoId ? 0 : !w.exists ? 3 : w.changeCount > 0 ? 1 : 2);
    return [...worktrees].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
  }, [worktrees, activeRepoId]);

  const matches = q ? ordered.filter((w) => `${label(w)} ${w.name}`.toLowerCase().includes(q)) : ordered;
  const shown = all || q ? matches : ordered.slice(0, PEEK);
  const hidden = ordered.length - shown.length;
  const dirty = worktrees.filter((w) => w.changeCount > 0).length;

  return (
    <div className="repo-wts" role="group" aria-label={`Worktrees of ${parent.name}`}>
      {all && worktrees.length >= FILTER_FROM && !query.trim() && (
        <input className="wtw-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${worktrees.length} worktrees…`} autoFocus />
      )}
      {shown.map((w) => (
        <div
          key={w.id}
          className={`repo-wt ${w.id === activeRepoId ? 'active' : ''} ${!w.exists ? 'gone' : ''}`}
          onClick={() => onSelect(w.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onContext(w, e.clientX, e.clientY);
          }}
          title={`${label(w)}\nWorktree of ${parent.name}\n${w.path}${w.changeCount ? `\n${w.changeCount} uncommitted change(s)` : ''}`}
        >
          <span className="repo-wt-ico">🗂</span>
          <BranchName name={label(w)} query={q} />
          {w.changeCount > 0 && <span className="repo-changes">{w.changeCount}</span>}
          {!w.exists && <span className="dot danger" title="Folder missing" />}
        </div>
      ))}
      {q && matches.length === 0 && <div className="wtw-none">No worktree matches “{query.trim() || filter.trim()}”</div>}
      {!q && hidden > 0 && (
        <button className="wtw-more" onClick={() => setAll(true)}>
          <span>+{hidden} more</span>
          {dirty > shown.filter((w) => w.changeCount > 0).length && <span className="wtw-more-dirty">● changes inside</span>}
        </button>
      )}
      {all && !query.trim() && ordered.length > PEEK && (
        <button
          className="wtw-more"
          onClick={() => {
            setAll(false);
            setFilter('');
          }}
        >
          Show less
        </button>
      )}
    </div>
  );
}
