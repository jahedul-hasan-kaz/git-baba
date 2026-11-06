import { useEffect, useMemo, useState } from 'react';
import type { BranchInfo, WorktreeInfo } from '../../../shared/types';
import { BranchPicker, toPickerItems } from '../../components/BranchPicker';
import { relative } from '../../components/FileDiffList';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';

const COLORS = ['#5b8cff', '#3ecf8e', '#f5b84a', '#ff6b6b', '#b18cff', '#6cc4ff', '#ff9f6b', '#9fd36b'];
export const branchColor = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
const folderOf = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/');
const parentOf = (p: string) => {
  const s = sepOf(p);
  const t = p.replace(/[\\/]+$/, '');
  return t.slice(0, t.lastIndexOf(s)) || t;
};
const slug = (b: string) => b.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export interface AddRequest {
  branch?: string;
  create?: boolean;
}

interface Props {
  repoId: string;
  repoPath: string;
  repoName: string;
  worktrees: WorktreeInfo[] | null;
  loading: boolean;
  branches: BranchInfo[];
  query: string;
  reload: () => void;
  /** A request from the branch tree ("Open in a new worktree…"). */
  addRequest: AddRequest | null;
  clearAddRequest: () => void;
}

/**
 * Worktree mode of the left rail: every working folder of this repository as a card on one trunk, so
 * branches can be worked on side by side without stashing or switching. Open one in Git Baba, reveal its
 * folder, lock it, or remove it; add a new one from an existing or new branch.
 */
export function WorktreePanel({ repoId, repoPath, repoName, worktrees, loading, branches, query, reload, addRequest, clearAddRequest }: Props) {
  const { showError, toast, selectRepo, refreshRepos, bump } = useApp();
  const [adding, setAdding] = useState<AddRequest | null>(null);
  const [removing, setRemoving] = useState<WorktreeInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (addRequest) {
      setAdding(addRequest);
      clearAddRequest();
    }
  }, [addRequest, clearAddRequest]);

  const list = useMemo(() => {
    const all = worktrees ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((w) => `${w.path} ${w.branch ?? ''} ${w.subject ?? ''}`.toLowerCase().includes(q)) : all;
  }, [worktrees, query]);
  const stale = (worktrees ?? []).filter((w) => w.prunable).length;

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok);
      reload();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(null);
    }
  };

  const open = (w: WorktreeInfo) =>
    run(`open:${w.path}`, async () => {
      const s = await call('git:worktreeOpen', { repoId, path: w.path });
      await refreshRepos();
      selectRepo(s.id);
      bump();
    });

  return (
    <div className="wt">
      <div className="wt-scroll">
        {loading && !worktrees ? (
          <div className="wr-empty mm-shimmer">Reading worktrees…</div>
        ) : (
          <div className="wt-trunk">
            {list.map((w, i) => (
              <WorktreeCard
                key={w.path}
                w={w}
                delay={i}
                busy={busy}
                onOpen={() => void open(w)}
                onReveal={() => void run(`rev:${w.path}`, () => call('git:worktreeReveal', { repoId, path: w.path }))}
                onLock={() => void run(`lock:${w.path}`, () => call('git:worktreeLock', { repoId, path: w.path, lock: !w.locked }), w.locked ? 'Worktree unlocked' : 'Worktree locked')}
                onRemove={() => setRemoving(w)}
                onCopy={() => void call('app:copyText', { text: w.path }).then(() => toast('Folder path copied'))}
              />
            ))}
            {list.length === 0 && <div className="wr-empty">No match</div>}
          </div>
        )}

        {worktrees && worktrees.length <= 1 && !query && (
          <div className="wt-intro">
            <div className="wt-intro-art" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <strong>Work on branches side by side</strong>
            <p className="small muted">A worktree checks out another branch in its own folder — no stashing, no switching back and forth. Review a pull request while your own work stays exactly where it is.</p>
          </div>
        )}

        <button className="wt-add" onClick={() => setAdding({})}>
          <span className="wt-add-ico">＋</span>
          <span>
            <strong>New worktree</strong>
            <span className="small muted">From an existing or a new branch</span>
          </span>
        </button>

        {stale > 0 && (
          <div className="wt-stale">
            <span>⚠ {stale} worktree folder{stale === 1 ? ' is' : 's are'} gone</span>
            <button className="btn sm" disabled={busy === 'prune'} onClick={() => void run('prune', () => call('git:worktreePrune', { repoId }), 'Stale worktrees cleaned up')}>
              Clean up
            </button>
          </div>
        )}
      </div>

      {adding && (
        <AddWorktreeDialog
          repoId={repoId}
          repoPath={repoPath}
          repoName={repoName}
          branches={branches}
          taken={new Set((worktrees ?? []).map((w) => w.branch).filter((b): b is string => !!b))}
          initial={adding}
          onClose={() => setAdding(null)}
          onDone={(w, openIt) => {
            setAdding(null);
            reload();
            toast(`Worktree ${folderOf(w.path)} ready on ${w.branch ?? 'detached HEAD'}`);
            if (openIt) void open(w);
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={removing.prunable ? 'Forget Missing Worktree' : 'Remove Worktree'}
          explanation={
            removing.prunable ? (
              <>
                The folder <strong>{removing.path}</strong> no longer exists. Git forgets this worktree.
              </>
            ) : (
              <>
                Deletes the folder <strong>{removing.path}</strong> and its worktree registration. The branch <strong>{removing.branch ?? '(detached)'}</strong> and its commits stay in the repository.
              </>
            )
          }
          impact={
            removing.changes ? (
              <span className="text-danger">
                It has {removing.changes} uncommitted change{removing.changes === 1 ? '' : 's'} — they are discarded.
              </span>
            ) : (
              'No uncommitted changes are lost.'
            )
          }
          confirmLabel={removing.changes ? `Remove and discard ${removing.changes} change${removing.changes === 1 ? '' : 's'}` : 'Remove worktree'}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const w = removing;
            setRemoving(null);
            await run(`rm:${w.path}`, async () => {
              await call('git:worktreeRemove', { repoId, path: w.path, force: !!w.changes, confirmed: true });
              await refreshRepos();
            }, `Worktree ${folderOf(w.path)} removed`);
          }}
        />
      )}
    </div>
  );
}

function WorktreeCard(props: { w: WorktreeInfo; delay: number; busy: string | null; onOpen: () => void; onReveal: () => void; onLock: () => void; onRemove: () => void; onCopy: () => void }) {
  const { w, delay, busy, onOpen, onReveal, onLock, onRemove, onCopy } = props;
  const color = branchColor(w.branch ?? 'HEAD');
  const state = w.prunable ? 'gone' : w.current ? 'here' : '';
  return (
    <div className={`wt-card ${state} ${w.main ? 'main' : ''}`} style={{ ['--bc' as string]: color, animationDelay: `${Math.min(delay, 8) * 35}ms` }}>
      <span className="wt-node" aria-hidden />
      <div className="wt-card-head">
        <span className="wt-folder-ico">{w.prunable ? '⚠' : w.main ? '🏠' : '🗂'}</span>
        <strong className="ellipsis grow" title={w.path}>
          {folderOf(w.path)}
        </strong>
        {w.current && <span className="wt-here">here</span>}
        {w.main && !w.current && <span className="wt-badge">main</span>}
        {w.locked && (
          <span className="wt-badge lock" title={w.lockReason ? `Locked: ${w.lockReason}` : 'Locked — protected from removal and clean-up'}>
            🔒
          </span>
        )}
      </div>
      <div className="wt-card-branch">
        <span className="wt-branch" title={w.branch ?? 'detached HEAD'}>
          ⎇ {w.branch ?? `detached @ ${w.head.slice(0, 7)}`}
        </span>
        {w.prunable ? (
          <span className="wt-state gone">folder missing</span>
        ) : w.changes === null ? null : w.changes > 0 ? (
          <span className="wt-state dirty" title={`${w.changes} uncommitted change(s)`}>
            ✎ {w.changes}
          </span>
        ) : (
          <span className="wt-state clean">✓ clean</span>
        )}
      </div>
      {w.subject && (
        <div className="wt-commit ellipsis" title={`${w.subject}${w.date ? `\n${new Date(w.date).toLocaleString()}` : ''}`}>
          {w.subject}
          {w.date && <span className="muted"> · {relative(w.date).replace(/ ago$/, '')}</span>}
        </div>
      )}
      <button className="wt-path mono ellipsis" onClick={onCopy} title={`${w.path}\nClick to copy`}>
        {w.path}
      </button>
      <div className="wt-actions">
        {!w.current && !w.prunable && (
          <button className="wt-act primary" disabled={busy === `open:${w.path}`} onClick={onOpen} title="Open this worktree in Git Baba">
            {busy === `open:${w.path}` ? 'Opening…' : w.repoId ? '↗ Switch to' : '↗ Open'}
          </button>
        )}
        {!w.prunable && (
          <button className="wt-act" onClick={onReveal} title="Open the folder">
            📂
          </button>
        )}
        {!w.main && !w.prunable && (
          <button className="wt-act" disabled={busy === `lock:${w.path}`} onClick={onLock} title={w.locked ? 'Unlock' : 'Lock (protect from removal)'}>
            {w.locked ? '🔓' : '🔒'}
          </button>
        )}
        {!w.main && !w.current && (
          <button className="wt-act danger" disabled={w.locked || busy === `rm:${w.path}`} onClick={onRemove} title={w.locked ? 'Unlock it to remove' : w.prunable ? 'Forget this missing worktree' : 'Remove this worktree'}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function AddWorktreeDialog(props: {
  repoId: string;
  repoPath: string;
  repoName: string;
  branches: BranchInfo[];
  taken: Set<string>;
  initial: AddRequest;
  onClose: () => void;
  onDone: (w: WorktreeInfo, open: boolean) => void;
}) {
  const { repoId, repoPath, repoName, branches, taken, initial, onClose, onDone } = props;
  const local = branches.filter((b) => !b.remote);
  const remote = branches.filter((b) => b.remote && !b.name.endsWith('/HEAD'));
  const free = local.filter((b) => !taken.has(b.name));
  const [mode, setMode] = useState<'existing' | 'new'>(initial.create || (!initial.branch && free.length === 0) ? 'new' : 'existing');
  const [existing, setExisting] = useState(initial.create ? '' : (initial.branch ?? free[0]?.name ?? ''));
  const [name, setName] = useState(initial.create ? (initial.branch ?? '') : '');
  const [base, setBase] = useState('');
  const [folder, setFolder] = useState('');
  const [edited, setEdited] = useState(false);
  const [openAfter, setOpenAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Picking a remote branch creates a local branch tracking it.
  const isRemotePick = mode === 'existing' && remote.some((b) => b.name === existing) && !local.some((b) => b.name === existing);
  const branch = mode === 'new' ? name.trim() : isRemotePick ? existing.slice(existing.indexOf('/') + 1) : existing;
  const suggested = branch ? `${parentOf(repoPath)}${sepOf(repoPath)}${repoName}-${slug(branch)}` : '';
  useEffect(() => {
    if (!edited) setFolder(suggested);
  }, [suggested, edited]);

  const clash = mode === 'existing' && !isRemotePick && taken.has(existing);
  const nameTaken = mode === 'new' && local.some((b) => b.name === branch);
  const can = !!branch && !!folder.trim() && !clash && !nameTaken && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const create = mode === 'new' || isRemotePick;
      const w = await call('git:worktreeAdd', { repoId, path: folder.trim(), branch, create, base: mode === 'new' ? base || undefined : isRemotePick ? existing : undefined });
      onDone(w, openAfter);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Worktree"
      icon="🗂"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <label className="check small" style={{ marginRight: 'auto' }}>
            <input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} /> Open it in Git Baba
          </label>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!can} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create worktree'}
          </button>
        </>
      }
    >
      <div className="segmented mb" role="tablist">
        <button className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>
          ⎇ Existing branch
        </button>
        <button className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
          ＋ New branch
        </button>
      </div>

      {mode === 'existing' ? (
        <div className="field">
          <label>Branch to check out</label>
          <BranchPicker value={existing} onChange={setExisting} items={toPickerItems([...free, ...remote])} placeholder="Choose a branch…" recentKey="worktree-branch" />
          {clash && <div className="small text-danger mt">This branch is already checked out in another worktree.</div>}
          {isRemotePick && <div className="small muted mt">Creates the local branch {branch}, tracking {existing}.</div>}
          {free.length < local.length && <div className="small muted mt">Branches already checked out in a worktree are not listed — a branch can be in one worktree at a time.</div>}
        </div>
      ) : (
        <div className="grid-2">
          <div className="field">
            <label>New branch name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/side-quest" spellCheck={false} autoFocus />
            {nameTaken && <div className="small text-danger">A branch with this name already exists.</div>}
          </div>
          <div className="field">
            <label>Start from</label>
            <BranchPicker
              value={base}
              onChange={setBase}
              items={toPickerItems([...local, ...remote])}
              special={[{ name: '', label: 'Current commit (HEAD)', icon: '◉', subject: 'Start from where this window is' }]}
              recentKey="branch-start"
            />
          </div>
        </div>
      )}

      <div className="field">
        <label>Folder</label>
        <input
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value);
            setEdited(true);
          }}
          placeholder="Choose a new, empty folder"
          spellCheck={false}
          className="mono"
        />
        {edited && suggested && folder !== suggested && (
          <button className="link small" onClick={() => setEdited(false)}>
            Use {folderOf(suggested)} next to the repository
          </button>
        )}
      </div>

      {branch && folder && (
        <div className="wt-preview" style={{ ['--bc' as string]: branchColor(branch) }}>
          <div className="wt-preview-row">
            <span>🏠</span>
            <span className="ellipsis grow">{repoName}</span>
            <span className="muted small">this repository</span>
          </div>
          <div className="wt-preview-row new">
            <span>🗂</span>
            <span className="ellipsis grow mono">{folderOf(folder)}</span>
            <span className="wt-branch">⎇ {branch}</span>
          </div>
        </div>
      )}
      {error && <div className="banner danger small mt">{error}</div>}
    </Modal>
  );
}
