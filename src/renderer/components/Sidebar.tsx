import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RepoSummary } from '../../shared/types';
import { CloneDialog } from '../dialogs/CloneDialog';
import { CreateRepoWizard } from '../dialogs/CreateRepoWizard';
import { ContributorsDialog, DuplicateRepoDialog, hueOf, LastCommitDialog, RemoveRepoDialog } from '../dialogs/RepoActionDialogs';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

/** "jahedul-hasan-kaz, inride" / "jahedul-hasan-kaz, personal" / "local repository". */
export function repoSubtitle(r: RepoSummary): string {
  if (r.github) return `${r.account?.login ?? 'no account'}, ${r.ownerLabel ?? r.github.owner}`;
  if (r.identity) return r.identity.split('/')[0];
  return r.remoteUrl ? 'other remote' : 'local repository';
}

interface Group {
  key: string;
  label: string;
  kind: 'favorites' | 'personal' | 'org' | 'other';
  repos: RepoSummary[];
}

/** Personal accounts first, then organisations alphabetically, then non-GitHub repositories. */
function groupRepos(list: RepoSummary[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of list) {
    let key: string;
    let label: string;
    let kind: Group['kind'];
    if (r.github && r.ownerLabel === 'personal') {
      key = `personal:${r.github.owner.toLowerCase()}`;
      label = r.github.owner;
      kind = 'personal';
    } else if (r.github) {
      key = `org:${r.github.owner.toLowerCase()}`;
      label = r.github.owner;
      kind = 'org';
    } else {
      key = 'other';
      label = 'Local & other remotes';
      kind = 'other';
    }
    const g = groups.get(key) ?? { key, label, kind, repos: [] };
    g.repos.push(r);
    groups.set(key, g);
  }
  const rank = { favorites: 0, personal: 1, org: 2, other: 3 };
  return [...groups.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label));
}

const RAIL_KEY = 'gitbaba.sidebar.rail';
function loadRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

const COLLAPSE_KEY = 'gitbaba.sidebar.collapsed';
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

type RepoDialog = { kind: 'duplicate' | 'contributors' | 'lastCommit' | 'remove'; repo: RepoSummary };

/** Repositories grouped by owner (favourites pinned on top), with a right-click menu of repository actions. */
export function Sidebar() {
  const { repos, activeRepoId, selectRepo, view, showError, bump, toast, requestAppSetup } = useApp();
  const [dialog, setDialog] = useState<'create' | 'clone' | null>(null);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ repo: RepoSummary; x: number; y: number } | null>(null);
  const [repoDialog, setRepoDialog] = useState<RepoDialog | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const menuRef = useRef<HTMLDivElement>(null);
  // Worktrees opened in the app fold under their main repository instead of being listed as repositories.
  const { mainRepos, worktreesOf } = useMemo(() => {
    const ids = new Set(repos.map((r) => r.id));
    const kids = new Map<string, RepoSummary[]>();
    const main: RepoSummary[] = [];
    for (const r of repos) {
      if (r.worktreeOf && ids.has(r.worktreeOf)) kids.set(r.worktreeOf, [...(kids.get(r.worktreeOf) ?? []), r]);
      else main.push(r);
    }
    for (const list of kids.values()) list.sort((a, b) => (a.branch ?? a.name).localeCompare(b.branch ?? b.name));
    return { mainRepos: main, worktreesOf: kids };
  }, [repos]);
  const activeFamily = useMemo(() => {
    const a = repos.find((r) => r.id === activeRepoId);
    return a?.worktreeOf && worktreesOf.has(a.worktreeOf) ? a.worktreeOf : (a?.id ?? null);
  }, [repos, activeRepoId, worktreesOf]);
  const ctxRef = useRef<HTMLDivElement>(null);
  // Minimised to an icon rail (one avatar per repository); remembered between sessions.
  const [rail, setRail] = useState(loadRail);
  const toggleRail = useCallback(() => {
    setRail((r) => {
      const next = !r;
      try {
        localStorage.setItem(RAIL_KEY, next ? '1' : '0');
      } catch {
        // per-viewer convenience only
      }
      return next;
    });
  }, []);

  // The shell grid reads the sidebar width from this variable, so the page animates with it.
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', rail ? '68px' : '290px');
    return () => {
      document.documentElement.style.removeProperty('--sidebar-w');
    };
  }, [rail]);

  // Ctrl/Cmd + B toggles the sidebar (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'b') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      toggleRail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleRail]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setCtxMenu(null);
    const onBlur = () => setCtxMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Keep the context menu inside the window.
  useEffect(() => {
    const el = ctxRef.current;
    if (!el || !ctxMenu) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(ctxMenu.x, window.innerWidth - r.width - 8);
    const y = Math.min(ctxMenu.y, window.innerHeight - r.height - 8);
    if (x !== ctxMenu.x || y !== ctxMenu.y) setCtxMenu({ ...ctxMenu, x, y });
  }, [ctxMenu]);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        // Per-viewer convenience only.
      }
      return next;
    });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...mainRepos].sort((a, b) => a.name.localeCompare(b.name));
    const text = (r: RepoSummary) => [r.name, repoSubtitle(r), r.identity ?? '', ...(worktreesOf.get(r.id) ?? []).map((w) => `${w.name} ${w.branch ?? ''}`)].join(' ').toLowerCase();
    return q ? list.filter((r) => text(r).includes(q)) : list;
  }, [mainRepos, worktreesOf, query]);

  const groups = useMemo(() => {
    const favs = filtered.filter((r) => r.favorite);
    const out: Group[] = [];
    if (favs.length) out.push({ key: 'favorites', label: 'Favorites', kind: 'favorites', repos: favs });
    return [...out, ...groupRepos(filtered.filter((r) => !r.favorite))];
  }, [filtered]);

  const openExisting = async () => {
    setMenu(false);
    try {
      const pick = await call('dialog:pickDirectory', { purpose: 'open' });
      if (!pick) return;
      const repo = await call('repo:addExisting', { selectionId: pick.selectionId });
      bump();
      selectRepo(repo.id);
      toast(`Added ${repo.name}`);
      if (repo.github && !repo.settings.githubApp) requestAppSetup(repo.id);
    } catch (err) {
      showError(err);
    }
  };

  const onCreated = (repo: RepoSummary) => {
    bump();
    selectRepo(repo.id);
  };

  const toggleFavorite = async (r: RepoSummary) => {
    try {
      await call('repo:setFavorite', { repoId: r.id, favorite: !r.favorite });
      toast(r.favorite ? `${r.name} removed from favorites` : `★ ${r.name} pinned to favorites`, 'info');
      bump();
    } catch (err) {
      showError(err);
    }
  };

  const openOnGitHub = async (r: RepoSummary) => {
    if (!r.github || !r.identity) return;
    try {
      await call('shell:openExternal', { url: `https://${r.identity}` });
    } catch (err) {
      showError(err);
    }
  };

  const act = (fn: () => void) => () => {
    setCtxMenu(null);
    fn();
  };

  const groupIcon = (g: Group) => {
    if (g.kind === 'favorites') return <span className="group-icon fav">★</span>;
    if (g.kind === 'other') return <span className="group-icon">⌂</span>;
    const hue = hueOf(g.label);
    return (
      <span className={`group-icon ${g.kind === 'org' ? 'org' : ''}`} style={{ background: `hsl(${hue} 50% 28%)`, color: `hsl(${hue} 90% 86%)` }}>
        {g.label[0]?.toUpperCase()}
      </span>
    );
  };

  return (
    <aside className={`sidebar ${rail ? 'rail' : ''}`}>
      {rail ? (
        <div className="rail-body">
          <button className="rail-toggle" onClick={toggleRail} title="Expand sidebar (Ctrl+B)" aria-label="Expand sidebar">
            »
          </button>
          <div style={{ position: 'relative' }} ref={menuRef}>
            <button className="rail-add" onClick={() => setMenu((m) => !m)} title="Add repository" aria-label="Add repository">
              +
            </button>
            {menu && (
              <div className="dropdown" style={{ left: 0, top: 'calc(100% + 4px)', width: 230 }}>
                <div className="dropdown-item" onClick={openExisting}>
                  📂 Open existing repository
                </div>
                <div className="dropdown-item" onClick={() => { setMenu(false); setDialog('create'); }}>
                  ✨ Create repository
                </div>
                <div className="dropdown-item" onClick={() => { setMenu(false); setDialog('clone'); }}>
                  ⬇ Clone repository
                </div>
              </div>
            )}
          </div>
          <div className="rail-list">
            {[...filtered]
              .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
              .map((r) => {
                const hue = hueOf(r.github?.owner ?? r.name);
                const active = r.id === activeFamily && view === 'repo';
                const wts = worktreesOf.get(r.id)?.length ?? 0;
                return (
                  <button
                    key={r.id}
                    className={`rail-item ${active ? 'active' : ''} ${ctxMenu?.repo.id === r.id ? 'ctx' : ''}`}
                    onClick={() => selectRepo(r.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ repo: r, x: e.clientX, y: e.clientY });
                    }}
                    title={`${r.name}${r.branch ? `\n⎇ ${r.branch}` : ''}\n${repoSubtitle(r)}${r.changeCount ? `\n${r.changeCount} uncommitted change(s)` : ''}`}
                  >
                    <span className="rail-avatar" style={{ background: `hsl(${hue} 50% 26%)`, color: `hsl(${hue} 90% 88%)` }}>
                      {r.name[0]?.toUpperCase()}
                    </span>
                    {r.favorite && <span className="rail-fav">★</span>}
                    {wts > 0 && <span className="rail-wt" title={`${wts} worktree(s) open`}>🗂</span>}
                    {r.hasConflicts ? <span className="rail-dot danger" /> : r.changeCount > 0 ? <span className="rail-dot warn" /> : null}
                  </button>
                );
              })}
          </div>
        </div>
      ) : (
        <>
      <div className="sidebar-title" style={{ paddingLeft: 18, paddingRight: 14 }}>
        <span className="row" style={{ gap: 8 }}>
          <button className="rail-toggle inline" onClick={toggleRail} title="Minimise sidebar (Ctrl+B)" aria-label="Minimise sidebar">
            «
          </button>
          Repositories ({mainRepos.length})
        </span>
        <div style={{ position: 'relative' }} ref={menuRef}>
          <button className="btn sm" onClick={() => setMenu((m) => !m)}>
            + Add
          </button>
          {menu && (
            <div className="dropdown" style={{ right: 0, left: 'auto', width: 230 }}>
              <div className="dropdown-item" onClick={openExisting}>
                📂 Open existing repository
              </div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setMenu(false);
                  setDialog('create');
                }}
              >
                ✨ Create repository
              </div>
              <div
                className="dropdown-item"
                onClick={() => {
                  setMenu(false);
                  setDialog('clone');
                }}
              >
                ⬇ Clone repository
              </div>
            </div>
          )}
        </div>
      </div>
      {mainRepos.length > 5 && (
        <div style={{ padding: '0 12px 8px' }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repositories…" />
        </div>
      )}

      <div className="repo-list">
        {mainRepos.length === 0 && <div className="small muted" style={{ padding: 8 }}>No repositories yet. Use “+ Add”.</div>}
        {mainRepos.length > 0 && filtered.length === 0 && <div className="small muted" style={{ padding: 8 }}>No repository matches “{query}”.</div>}
        {groups.map((g) => {
          // Searching always shows matches, even inside collapsed groups.
          const isCollapsed = collapsed.has(g.key) && !query.trim();
          return (
            <div key={g.key} className={`repo-group ${g.kind}`}>
              <button className="repo-group-head" onClick={() => toggleGroup(g.key)} aria-expanded={!isCollapsed}>
                <span className={`chev ${isCollapsed ? '' : 'open'}`}>▸</span>
                {groupIcon(g)}
                <span className="ellipsis grow">{g.label}</span>
                {g.kind === 'personal' && <span className="group-tag">personal</span>}
                {g.kind === 'org' && <span className="group-tag">org</span>}
                <span className="badge">{g.repos.length}</span>
              </button>
              {!isCollapsed && (
                <div className="repo-group-body">
                  {g.repos.map((r, i) => {
                    const wts = worktreesOf.get(r.id) ?? [];
                    const family = activeFamily === r.id && view === 'repo';
                    const inWorktree = family && r.id !== activeRepoId;
                    return (
                    <div key={r.id} className={`repo-fam ${family && wts.length ? 'open' : ''}`}>
                    <div
                      className={`repo-item ${family && !inWorktree ? 'active' : ''} ${inWorktree ? 'family' : ''} ${ctxMenu?.repo.id === r.id ? 'ctx' : ''}`}
                      style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}
                      onClick={() => selectRepo(r.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({ repo: r, x: e.clientX, y: e.clientY });
                      }}
                      title={`${r.path}\nRight-click for more actions`}
                    >
                      <div className="name">
                        <span className="ellipsis grow">{r.name}</span>
                        {r.changeCount > 0 && <span className="repo-changes" title={`${r.changeCount} uncommitted change(s)`}>{r.changeCount}</span>}
                        {r.hasConflicts && <span className="dot danger" title="Merge conflicts" />}
                        {!r.exists && <span className="dot danger" title="Folder missing" />}
                        {r.favorite && <span className="repo-star" title="Favorite">★</span>}
                        {wts.length > 0 && !family && (
                          <span className="repo-wt-count" title={`${wts.length} worktree(s) open in Git Baba:\n${wts.map((w) => `⎇ ${w.branch ?? w.name}`).join('\n')}`}>
                            🗂 {wts.length}
                          </span>
                        )}
                      </div>
                      <div className="meta">
                        {r.branch && <span className="repo-branch">⎇ {r.branch}</span>}
                        {repoSubtitle(r)}
                      </div>
                    </div>
                    {family && wts.length > 0 && (
                      <div className="repo-wts">
                        {wts.map((w) => (
                          <div
                            key={w.id}
                            className={`repo-wt ${w.id === activeRepoId ? 'active' : ''} ${ctxMenu?.repo.id === w.id ? 'ctx' : ''}`}
                            onClick={() => selectRepo(w.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setCtxMenu({ repo: w, x: e.clientX, y: e.clientY });
                            }}
                            title={`Worktree of ${r.name}\n${w.path}`}
                          >
                            <span className="repo-wt-ico">🗂</span>
                            <span className="ellipsis grow">{w.branch ?? w.name}</span>
                            {w.changeCount > 0 && <span className="repo-changes" title={`${w.changeCount} uncommitted change(s)`}>{w.changeCount}</span>}
                            {!w.exists && <span className="dot danger" title="Folder missing" />}
                          </div>
                        ))}
                      </div>
                    )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
        </>
      )}

      {ctxMenu && (
        <div ref={ctxRef} className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onContextMenu={(e) => e.preventDefault()}>
          <div className="ctx-head">
            <strong className="ellipsis">{ctxMenu.repo.name}</strong>
            <span className="small muted ellipsis">{repoSubtitle(ctxMenu.repo)}</span>
          </div>
          <div className="dropdown-item" onClick={act(() => toggleFavorite(ctxMenu.repo))}>
            <span className="ctx-ico" style={{ color: 'var(--warn)' }}>{ctxMenu.repo.favorite ? '☆' : '★'}</span>
            {ctxMenu.repo.favorite ? 'Remove from favorites' : 'Add to favorites'}
          </div>
          <div className={`dropdown-item ${ctxMenu.repo.github ? '' : 'disabled'}`} onClick={ctxMenu.repo.github ? act(() => openOnGitHub(ctxMenu.repo)) : undefined} title={ctxMenu.repo.github ? undefined : 'This repository has no GitHub remote'}>
            <span className="ctx-ico">↗</span> View on GitHub
          </div>
          <div className="dropdown-sep" />
          <div className={`dropdown-item ${ctxMenu.repo.exists ? '' : 'disabled'}`} onClick={ctxMenu.repo.exists ? act(() => setRepoDialog({ kind: 'lastCommit', repo: ctxMenu.repo })) : undefined}>
            <span className="ctx-ico">◉</span> Last commit &amp; tag
          </div>
          <div className={`dropdown-item ${ctxMenu.repo.exists ? '' : 'disabled'}`} onClick={ctxMenu.repo.exists ? act(() => setRepoDialog({ kind: 'contributors', repo: ctxMenu.repo })) : undefined}>
            <span className="ctx-ico">👥</span> Contributors
          </div>
          <div className={`dropdown-item ${ctxMenu.repo.exists ? '' : 'disabled'}`} onClick={ctxMenu.repo.exists ? act(() => setRepoDialog({ kind: 'duplicate', repo: ctxMenu.repo })) : undefined}>
            <span className="ctx-ico">⧉</span> Duplicate…
          </div>
          <div className="dropdown-sep" />
          <div className="dropdown-item danger" onClick={act(() => setRepoDialog({ kind: 'remove', repo: ctxMenu.repo }))}>
            <span className="ctx-ico">✕</span> Remove…
          </div>
        </div>
      )}

      {dialog === 'create' && <CreateRepoWizard onClose={() => setDialog(null)} onCreated={onCreated} />}
      {dialog === 'clone' && <CloneDialog onClose={() => setDialog(null)} onCloned={onCreated} />}
      {repoDialog?.kind === 'duplicate' && (
        <DuplicateRepoDialog
          repo={repoDialog.repo}
          onClose={() => setRepoDialog(null)}
          onDone={(created) => {
            setRepoDialog(null);
            toast(`Duplicated as ${created.name}`);
            onCreated(created);
          }}
        />
      )}
      {repoDialog?.kind === 'contributors' && <ContributorsDialog repo={repoDialog.repo} onClose={() => setRepoDialog(null)} />}
      {repoDialog?.kind === 'lastCommit' && <LastCommitDialog repo={repoDialog.repo} onClose={() => setRepoDialog(null)} />}
      {repoDialog?.kind === 'remove' && (
        <RemoveRepoDialog
          repo={repoDialog.repo}
          onClose={() => setRepoDialog(null)}
          onRemoved={(remoteMissing) => {
            const removed = repoDialog.repo;
            setRepoDialog(null);
            if (removed.id === activeRepoId) selectRepo(null);
            toast(remoteMissing ? `${removed.name} no longer exists on the remote — removed from the app, local files untouched` : `${removed.name} removed from the app — files untouched`, 'info');
            bump();
          }}
        />
      )}
    </aside>
  );
}
