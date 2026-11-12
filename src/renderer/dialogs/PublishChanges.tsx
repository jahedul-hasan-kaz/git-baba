import { useEffect, useMemo, useState } from 'react';
import type { ChangeArea, ChangeKind, FileDiff, RepoStatus } from '../../shared/types';
import { DiffViewer } from '../components/DiffViewer';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

interface Entry {
  path: string;
  kind: ChangeKind;
  /** Area whose diff is shown (unstaged wins: it is the newest edit). */
  area: ChangeArea;
}

const KIND: Record<ChangeKind, [string, string]> = {
  modified: ['M', 'modified'],
  added: ['A', 'added'],
  deleted: ['D', 'deleted'],
  renamed: ['R', 'renamed'],
  copied: ['C', 'added'],
  typechange: ['T', 'modified'],
  untracked: ['U', 'added'],
  conflicted: ['!', 'deleted'],
};

const TYPES = ['feat', 'fix', 'refactor', 'style', 'chore', 'docs'];

/** "feature/worktree-adv" → "feat: worktree adv". */
export function messageFromBranch(branch: string): string {
  const [head, ...rest] = branch.split('/');
  const tail = (rest.length ? rest.join(' ') : head).replace(/[-_]+/g, ' ').trim();
  const type = /^(feat|feature)$/i.test(head) ? 'feat' : /^(fix|bugfix|hotfix)$/i.test(head) ? 'fix' : /^chore$/i.test(head) ? 'chore' : /^refactor$/i.test(head) ? 'refactor' : rest.length ? head.toLowerCase() : 'feat';
  return `${type}: ${tail}`;
}

/**
 * The uncommitted changes a publish can take along: every file with its diff one click away, and an undo per file
 * (backed up first) for anything that should not go out. The parent re-checks the publish after each undo.
 */
export function PublishChanges(props: {
  repoId: string;
  branch: string;
  canCommit: boolean;
  include: boolean;
  onInclude: (v: boolean) => void;
  message: string;
  onMessage: (v: string) => void;
  /** Called after files were undone, so the publish preview is rebuilt. */
  onUndone: () => void;
  disabled?: boolean;
}) {
  const { repoId, branch, canCommit, include, onInclude, message, onMessage, onUndone, disabled } = props;
  const { toast, showError } = useApp();
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiff | null>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setStatus(await call('git:status', { repoId }));
    } catch (err) {
      showError(err);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  const entries = useMemo<Entry[]>(() => {
    if (!status) return [];
    const m = new Map<string, Entry>();
    for (const f of status.staged) m.set(f.path, { path: f.path, kind: f.kind, area: 'staged' });
    for (const f of status.unstaged) m.set(f.path, { path: f.path, kind: m.get(f.path)?.kind === 'added' ? 'added' : f.kind, area: 'unstaged' });
    for (const f of status.untracked) m.set(f.path, { path: f.path, kind: 'untracked', area: 'untracked' });
    for (const f of status.conflicted) m.set(f.path, { path: f.path, kind: 'conflicted', area: 'conflicted' });
    return [...m.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [status]);

  // Line counts for every file (small: diffs are cached and shown on demand).
  useEffect(() => {
    let live = true;
    for (const e of entries) {
      if (e.path in diffs) continue;
      void call('git:diffFile', { repoId, path: e.path, area: e.area })
        .then((d) => live && setDiffs((m) => ({ ...m, [e.path]: d })))
        .catch(() => live && setDiffs((m) => ({ ...m, [e.path]: null })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, repoId]);

  const totals = entries.reduce((t, e) => ({ add: t.add + (diffs[e.path]?.additions ?? 0), del: t.del + (diffs[e.path]?.deletions ?? 0) }), { add: 0, del: 0 });
  const maxDelta = Math.max(1, ...entries.map((e) => (diffs[e.path]?.additions ?? 0) + (diffs[e.path]?.deletions ?? 0)));

  const undo = async (paths: string[]) => {
    setBusy(true);
    try {
      // Staged edits are unstaged first, so the undo takes the whole change back (not just the unstaged part).
      const staged = paths.filter((p) => status?.staged.some((f) => f.path === p));
      if (staged.length) await call('git:unstage', { repoId, paths: staged });
      const r = await call('git:discard', { repoId, paths, confirmed: true });
      toast(`${paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} files`} undone${r.backedUp ? ' — a backup copy was kept' : ''}`);
      setConfirm(null);
      setOpen((o) => (o && paths.includes(o) ? null : o));
      setDiffs((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !paths.includes(k))));
      await load();
      onUndone();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!status || entries.length === 0) return null;
  const off = disabled || busy;
  const type = /^(\w+)(\(.+\))?!?:/.exec(message)?.[1];
  const setType = (t: string) => onMessage(/^(\w+)(\(.+\))?!?:\s*/.test(message) ? message.replace(/^(\w+)/, t) : `${t}: ${message}`);

  return (
    <section className={`pc ${include ? 'on' : ''}`}>
      <header className="pc-head">
        <div className="grow">
          <strong>
            {entries.length} uncommitted change{entries.length === 1 ? '' : 's'}
          </strong>
          <span className="pc-tot">
            <b className="text-ok">+{totals.add}</b> <b className="text-danger">−{totals.del}</b>
          </span>
        </div>
        {canCommit ? (
          <label className="pc-switch" title="Commit these changes on the new branch and publish them with it">
            <input type="checkbox" checked={include} disabled={off} onChange={(e) => onInclude(e.target.checked)} />
            <span className="pc-knob" aria-hidden />
            <span>{include ? 'Going out' : 'Stay here'}</span>
          </label>
        ) : (
          <span className="small muted" title="Pending changes can only be committed when the branch starts from your current commit.">
            not included
          </span>
        )}
      </header>

      <div className="pc-files">
        {entries.map((e) => {
          const d = diffs[e.path];
          const [letter, cls] = KIND[e.kind];
          const isOpen = open === e.path;
          const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/') + 1) : '';
          return (
            <div key={e.path} className={`pc-file ${isOpen ? 'open' : ''} ${confirm === e.path ? 'confirm' : ''}`}>
              <div className="pc-row" role="button" tabIndex={0} onClick={() => setOpen(isOpen ? null : e.path)} onKeyDown={(k) => k.key === 'Enter' && setOpen(isOpen ? null : e.path)} title={`${e.path}\nClick to see the change`}>
                <span className={`fx-st ${cls}`}>{letter}</span>
                <span className="ellipsis grow pc-name">
                  {dir && <span className="muted">{dir}</span>}
                  {e.path.slice(dir.length)}
                </span>
                {d && !d.binary && (
                  <>
                    <span className="pc-n text-ok">+{d.additions}</span>
                    <span className="pc-n text-danger">−{d.deletions}</span>
                    <span className="uc-bar">
                      <i className="add" style={{ width: `${(d.additions / maxDelta) * 100}%` }} />
                      <i className="del" style={{ width: `${(d.deletions / maxDelta) * 100}%` }} />
                    </span>
                  </>
                )}
                {confirm === e.path ? (
                  <span className="pc-ask" onClick={(k) => k.stopPropagation()}>
                    <button className="pc-yes" disabled={off} onClick={() => void undo([e.path])}>
                      Undo
                    </button>
                    <button className="pc-no" onClick={() => setConfirm(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    className="pc-undo"
                    disabled={off}
                    title={e.kind === 'untracked' || e.kind === 'added' ? 'Remove this new file (a backup copy is kept)' : 'Undo the changes to this file (a backup copy is kept)'}
                    onClick={(k) => {
                      k.stopPropagation();
                      setConfirm(e.path);
                    }}
                  >
                    ↶
                  </button>
                )}
                <span className="pc-chev">›</span>
              </div>
              {isOpen && (
                <div className="pc-diff">
                  <DiffViewer diff={d ?? null} hideHeader emptyText={d === undefined ? 'Loading…' : 'No text changes to show.'} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <footer className="pc-foot">
        {confirm === '*' ? (
          <span className="pc-ask">
            <span className="small">Undo all {entries.length}? Backups are kept.</span>
            <button className="pc-yes" disabled={off} onClick={() => void undo(entries.map((e) => e.path))}>
              Undo all
            </button>
            <button className="pc-no" onClick={() => setConfirm(null)}>
              Keep
            </button>
          </span>
        ) : (
          <>
            <span className="small muted grow">{include ? `Committed on ${branch}, then published.` : 'They stay uncommitted on your current branch and are not published.'}</span>
            <button className="link small" disabled={off} onClick={() => setConfirm('*')}>
              ↶ Undo all
            </button>
          </>
        )}
      </footer>

      {include && canCommit && (
        <div className="pc-msg">
          <div className="pc-types">
            {TYPES.map((t) => (
              <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)} disabled={off}>
                {t}
              </button>
            ))}
            {!message.trim() && (
              <button className="pc-suggest" onClick={() => onMessage(messageFromBranch(branch))}>
                ✨ {messageFromBranch(branch)}
              </button>
            )}
          </div>
          <textarea rows={2} value={message} onChange={(e) => onMessage(e.target.value)} placeholder="Commit message (required)" disabled={off} />
        </div>
      )}
    </section>
  );
}
