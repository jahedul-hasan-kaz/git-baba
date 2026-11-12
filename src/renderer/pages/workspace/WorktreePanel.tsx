import { useEffect, useMemo, useState } from 'react';
import type { BranchInfo, WorktreeInfo } from '../../../shared/types';
import { BranchPicker, toPickerItems } from '../../components/BranchPicker';
import { relative } from '../../components/FileDiffList';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';
import { behindOn, DriftChips, SyncDialog, type SyncSource } from './WorktreeSync';
import { Hourglass } from '../../components/Hourglass';

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

type Facet = 'all' | 'changed' | 'locked' | 'missing';
type Density = 'auto' | 'cards' | 'rows';
/** From this many worktrees the panel switches to rows and groups by branch prefix (unless the user chose). */
const DENSE_FROM = 6;
const DENSITY_KEY = 'gb.wt.density';
const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const saveJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Per-viewer convenience only.
  }
};
/** "feature/payments/x" → "feature"; no prefix → "other"; detached → "detached". */
const groupOf = (w: WorktreeInfo) => (!w.branch ? 'detached' : w.branch.includes('/') ? w.branch.slice(0, w.branch.indexOf('/')) : 'other');
const matchesFacet = (w: WorktreeInfo, f: Facet) =>
  f === 'all' || (f === 'changed' && (w.changes ?? 0) > 0) || (f === 'locked' && w.locked) || (f === 'missing' && w.prunable);

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
  const [syncing, setSyncing] = useState<{ list: WorktreeInfo[]; source: SyncSource } | null>(null);

  useEffect(() => {
    if (addRequest) {
      setAdding(addRequest);
      clearAddRequest();
    }
  }, [addRequest, clearAddRequest]);

  const [facet, setFacet] = useState<Facet>('all');
  const [density, setDensityState] = useState<Density>(() => loadJson<Density>(DENSITY_KEY, 'auto'));
  const setDensity = (d: Density) => {
    setDensityState(d);
    saveJson(DENSITY_KEY, d);
  };
  const groupsKey = `gb.wt.folded.${repoId}`;
  const [folded, setFolded] = useState<string[]>(() => loadJson<string[]>(groupsKey, []));
  useEffect(() => setFolded(loadJson<string[]>(groupsKey, [])), [groupsKey]);
  const toggleGroup = (g: string) =>
    setFolded((prev) => {
      const next = prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g];
      saveJson(groupsKey, next);
      return next;
    });

  const all = worktrees ?? [];
  const q = query.trim().toLowerCase();
  const searched = useMemo(() => (q ? all.filter((w) => `${w.path} ${w.branch ?? ''} ${w.subject ?? ''}`.toLowerCase().includes(q)) : all), [all, q]);
  // The main folder and the one this window shows stay on top as cards; the rest follow the filter.
  const pinned = searched.filter((w) => w.main || w.current);
  const rest = searched.filter((w) => !w.main && !w.current && matchesFacet(w, facet));
  const rows = density === 'rows' || (density === 'auto' && all.length > DENSE_FROM);
  const counts = {
    all: all.length,
    changed: all.filter((w) => (w.changes ?? 0) > 0).length,
    locked: all.filter((w) => w.locked).length,
    missing: all.filter((w) => w.prunable).length,
  };
  const stale = counts.missing;
  const grouped = useMemo(() => {
    const map = new Map<string, WorktreeInfo[]>();
    for (const w of [...rest].sort((a, b) => (a.branch ?? '').localeCompare(b.branch ?? ''))) {
      const g = groupOf(w);
      map.set(g, [...(map.get(g) ?? []), w]);
    }
    // A prefix with a single worktree is not worth a header: it joins the ungrouped list.
    for (const [g, items] of [...map.entries()]) {
      if (items.length < 2 && g !== 'other') {
        map.delete(g);
        map.set('other', [...(map.get('other') ?? []), ...items].sort((a, b) => (a.branch ?? '').localeCompare(b.branch ?? '')));
      }
    }
    const rank = (g: string) => (g === 'other' ? 1 : g === 'detached' ? 2 : 0);
    return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  }, [rest]);
  const useGroups = rows && rest.length > DENSE_FROM && grouped.length > 1;

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

  const handlers = (w: WorktreeInfo) => ({
    onOpen: () => void open(w),
    onReveal: () => void run(`rev:${w.path}`, () => call('git:worktreeReveal', { repoId, path: w.path })),
    onLock: () => void run(`lock:${w.path}`, () => call('git:worktreeLock', { repoId, path: w.path, lock: !w.locked }), w.locked ? 'Worktree unlocked' : 'Worktree locked'),
    onRemove: () => setRemoving(w),
    onCopy: () => void call('app:copyText', { text: w.path }).then(() => toast('Folder path copied')),
    onSync: (source: SyncSource) => setSyncing({ list: [w], source }),
  });
  // Worktrees missing new commits on the branch they follow (e.g. develop) or on their own remote branch.
  const behindBase = behindOn(all, 'base');
  const behindUp = behindOn(all, 'upstream');
  const baseNames = [...new Set(behindBase.map((w) => w.drift?.base?.name))];
  const fetchNow = () => window.dispatchEvent(new CustomEvent('gb:repo-dialog', { detail: 'fetch' }));
  const card = (w: WorktreeInfo, i: number) => <WorktreeCard key={w.path} w={w} delay={i} busy={busy} {...handlers(w)} />;
  const row = (w: WorktreeInfo, i: number, grouped: boolean) => <WorktreeRow key={w.path} w={w} delay={i} busy={busy} grouped={grouped} q={q} {...handlers(w)} />;

  return (
    <div className="wt">
      <div className="wt-scroll">
        {loading && !worktrees ? (
          <div className="wr-empty mm-shimmer">Reading worktrees…</div>
        ) : (
          <>
            {all.length > 2 && (
              <div className="wt-bar">
                <div className="wt-facets" role="tablist" aria-label="Show worktrees">
                  {(['all', 'changed', 'locked', 'missing'] as Facet[])
                    .filter((f) => f === 'all' || counts[f] > 0 || facet === f)
                    .map((f) => (
                      <button key={f} role="tab" aria-selected={facet === f} className={`wt-facet ${f} ${facet === f ? 'on' : ''}`} onClick={() => setFacet(f)}>
                        {f === 'all' ? 'All' : f === 'changed' ? '✎ Changed' : f === 'locked' ? '🔒 Locked' : '⚠ Missing'}
                        <span className="wt-facet-n">{counts[f]}</span>
                      </button>
                    ))}
                </div>
                <div className="wt-density" role="group" aria-label="Layout">
                  <button className={!rows ? 'on' : ''} onClick={() => setDensity('cards')} title="Cards">
                    ▤
                  </button>
                  <button className={rows ? 'on' : ''} onClick={() => setDensity('rows')} title="Compact rows">
                    ☰
                  </button>
                </div>
              </div>
            )}
            {(behindBase.length > 0 || behindUp.length > 0) && (
              <div className="wd-keepup">
                <div className="wd-keepup-head">
                  <span className="wd-keepup-ico">⇣</span>
                  <span className="grow">
                    <strong>New work is waiting</strong>
                    <span className="small muted">
                      {behindBase.length > 0 && `${behindBase.length} behind ${baseNames.length === 1 ? baseNames[0] : 'their base'}`}
                      {behindBase.length > 0 && behindUp.length > 0 && ' · '}
                      {behindUp.length > 0 && `${behindUp.length} behind their remote`}
                    </span>
                  </span>
                </div>
                <div className="wd-keepup-acts">
                  {behindBase.length > 0 && (
                    <button className="btn sm primary" onClick={() => setSyncing({ list: behindBase, source: 'base' })}>
                      Update {behindBase.length > 1 ? `all ${behindBase.length}` : folderOf(behindBase[0].path)}
                    </button>
                  )}
                  {behindUp.length > 0 && (
                    <button className="btn sm" onClick={() => setSyncing({ list: behindUp, source: 'upstream' })}>
                      Pull remote{behindUp.length > 1 ? ` (${behindUp.length})` : ''}
                    </button>
                  )}
                  <button className="btn sm ghost" onClick={fetchNow} title="Fetch first to see what teammates pushed most recently">
                    <Hourglass /> Fetch
                  </button>
                </div>
              </div>
            )}
            <div className="wt-trunk">
              {pinned.map((w, i) => card(w, i))}
              {rest.length > 0 && pinned.length > 0 && rows && <div className="wt-sep">{rest.length} more worktree{rest.length === 1 ? '' : 's'}</div>}
              {useGroups
                ? grouped.map(([g, items]) => {
                    const isFolded = folded.includes(g) && !q;
                    const dirty = items.filter((w) => (w.changes ?? 0) > 0).length;
                    return (
                      <div key={g} className={`wt-group ${isFolded ? 'folded' : ''}`}>
                        <button className="wt-group-head" onClick={() => toggleGroup(g)} aria-expanded={!isFolded}>
                          <span className={`chev ${isFolded ? '' : 'open'}`}>▸</span>
                          <span className="wt-group-name">{g === 'other' ? (grouped.length > 1 ? 'others' : 'worktrees') : g === 'detached' ? 'detached' : `${g}/`}</span>
                          {dirty > 0 && <span className="wt-group-dirty" title={`${dirty} with uncommitted changes`}>✎ {dirty}</span>}
                          <span className="wt-group-n">{items.length}</span>
                        </button>
                        {!isFolded && <div className="wt-group-body">{items.map((w, i) => row(w, i, g !== 'other'))}</div>}
                      </div>
                    );
                  })
                : rest.map((w, i) => (rows ? row(w, i, false) : card(w, i + pinned.length)))}
              {searched.length === 0 && <div className="wr-empty">No worktree matches “{query.trim()}”</div>}
              {searched.length > 0 && rest.length === 0 && facet !== 'all' && (
                <div className="wr-empty">
                  No {facet} worktrees ·{' '}
                  <button className="link" onClick={() => setFacet('all')}>
                    show all
                  </button>
                </div>
              )}
            </div>
          </>
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

      {syncing && (
        <SyncDialog
          repoId={repoId}
          worktrees={syncing.list}
          source={syncing.source}
          branches={branches}
          onClose={() => setSyncing(null)}
          onChanged={() => {
            reload();
            bump();
          }}
          onOpen={(w) => {
            setSyncing(null);
            void open(w);
          }}
        />
      )}
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

/** One worktree as a dense row: the branch leaf in bold, state at a glance, actions on hover or focus. */
function WorktreeRow(props: { w: WorktreeInfo; delay: number; busy: string | null; grouped: boolean; q: string; onOpen: () => void; onReveal: () => void; onLock: () => void; onRemove: () => void; onCopy: () => void; onSync: (s: SyncSource) => void }) {
  const { w, delay, busy, grouped, q, onOpen, onReveal, onLock, onRemove, onCopy, onSync } = props;
  const color = branchColor(w.branch ?? 'HEAD');
  const name = w.branch ?? `detached @ ${w.head.slice(0, 7)}`;
  const cut = grouped && w.branch ? w.branch.indexOf('/') + 1 : name.lastIndexOf('/') + 1;
  const head = grouped ? '' : name.slice(0, cut);
  const leaf = name.slice(cut);
  const mark = (t: string) => {
    const i = q ? t.toLowerCase().indexOf(q) : -1;
    return i < 0 ? t : (
      <>
        {t.slice(0, i)}
        <mark>{t.slice(i, i + q.length)}</mark>
        {t.slice(i + q.length)}
      </>
    );
  };
  const canOpen = !w.prunable;
  return (
    <div
      className={`wt-row ${w.prunable ? 'gone' : ''}`}
      style={{ ['--bc' as string]: color, animationDelay: `${Math.min(delay, 10) * 18}ms` }}
      tabIndex={0}
      onDoubleClick={canOpen ? onOpen : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && canOpen) onOpen();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const rows = [...document.querySelectorAll<HTMLElement>('.wt-row')];
          rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
      }}
      title={`${name}\n${w.path}${w.subject ? `\n${w.subject}` : ''}${w.date ? ` · ${relative(w.date)}` : ''}\nDouble-click or Enter to open`}
    >
      <span className="wt-row-node" aria-hidden />
      <span className="wt-row-name ellipsis">
        {head && <span className="wt-row-prefix">{mark(head)}</span>}
        <span className="wt-row-leaf">{mark(leaf)}</span>
      </span>
      {w.locked && <span className="wt-row-lock" title={w.lockReason ? `Locked: ${w.lockReason}` : 'Locked'}>🔒</span>}
      <DriftChips w={w} compact onSync={onSync} />
      <span className="wt-row-meta">
        {w.prunable ? (
          <span className="wt-state gone">missing</span>
        ) : (w.changes ?? 0) > 0 ? (
          <span className="wt-state dirty">✎ {w.changes}</span>
        ) : (
          <span className="wt-row-age">{w.date ? relative(w.date).replace(/ ago$/, '') : ''}</span>
        )}
      </span>
      <span className="wt-row-actions">
        {canOpen && (
          <button className="wt-act primary" disabled={busy === `open:${w.path}`} onClick={onOpen} title={w.repoId ? 'Switch to this worktree' : 'Open this worktree in Git Baba'}>
            ↗
          </button>
        )}
        {canOpen && (
          <button className="wt-act" onClick={onReveal} title="Open the folder">
            📂
          </button>
        )}
        <button className="wt-act" onClick={onCopy} title="Copy folder path">
          ⧉
        </button>
        {canOpen && (
          <button className="wt-act" disabled={busy === `lock:${w.path}`} onClick={onLock} title={w.locked ? 'Unlock' : 'Lock (protect from removal)'}>
            {w.locked ? '🔓' : '🔒'}
          </button>
        )}
        <button className="wt-act danger" disabled={w.locked || busy === `rm:${w.path}`} onClick={onRemove} title={w.locked ? 'Unlock it to remove' : w.prunable ? 'Forget this missing worktree' : 'Remove this worktree'}>
          ✕
        </button>
      </span>
    </div>
  );
}

function WorktreeCard(props: { w: WorktreeInfo; delay: number; busy: string | null; onOpen: () => void; onReveal: () => void; onLock: () => void; onRemove: () => void; onCopy: () => void; onSync: (s: SyncSource) => void }) {
  const { w, delay, busy, onOpen, onReveal, onLock, onRemove, onCopy, onSync } = props;
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
      <DriftChips w={w} onSync={onSync} />
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
          <button className="btn cancel" onClick={onClose} disabled={busy}>
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

      {mode === 'new' && base && (
        <div className="small muted mb">
          ⇣ This worktree keeps up with <strong>{base.replace(/^[^/]+\//, (m) => (remote.some((b) => b.name === base) ? '' : m))}</strong>: when anyone adds commits there, it offers to bring them in.
        </div>
      )}
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
