import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeEntry, CodeInfo, CodeLastCommit, CodeSearchHit, FileAtCommit, FriendlyError, RepoStatus } from '../../../shared/types';
import { isPublished } from '../../../shared/publish';
import { ErrorPanel } from '../../components/ErrorPanel';
import { relative } from '../../components/FileDiffList';
import { Avatar, Skeleton } from '../../components/github/common';
import { Markdown } from '../../components/Markdown';
import { Spinner } from '../../components/Modal';
import { SwitchBranchDialog } from '../../dialogs/BranchDialogs';
import { CommitDialog } from '../../dialogs/CommitDialog';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { PushDialog } from '../../dialogs/PushDialog';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';
import { AboutPanel } from './AboutPanel';
import { CodeEditor, FileView, formatBytes } from './FileView';
import { RefPicker } from './RefPicker';

type View =
  | { kind: 'tree' }
  | { kind: 'file'; path: string; line: number | null }
  | { kind: 'edit'; path: string; create: boolean; original: string; content: string }
  | { kind: 'search' };

type ChangeMark = 'added' | 'modified' | 'deleted' | 'renamed';

const README_RE = /^readme(\.(md|markdown|txt|rst))?$/i;
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Resolves a link inside a Markdown file relative to that file's folder. */
function resolveLink(fromDir: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0];
  const parts = (clean.startsWith('/') ? clean.slice(1) : fromDir ? `${fromDir}/${clean}` : clean).split('/');
  const out: string[] = [];
  for (const s of parts) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(decodeURIComponent(s));
  }
  return out.join('/');
}

function entryIcon(e: Pick<CodeEntry, 'type' | 'name'>): string {
  if (e.type === 'dir') return '📁';
  if (e.type === 'submodule') return '📦';
  if (e.type === 'symlink') return '↪';
  if (README_RE.test(e.name)) return '📖';
  return '📄';
}

export function CodePage() {
  const { activeRepo, revision, bump, toast, showError, setRepoTab, setPrDraft, refreshRepos } = useApp();
  const repoId = activeRepo!.id;
  const [ref, setRef] = useState<string | null>(null);
  const [info, setInfo] = useState<CodeInfo | null>(null);
  const [infoError, setInfoError] = useState<FriendlyError | null>(null);
  const [dir, setDir] = useState('');
  const [view, setView] = useState<View>({ kind: 'tree' });
  const [entries, setEntries] = useState<CodeEntry[] | null>(null);
  const [treeError, setTreeError] = useState<FriendlyError | null>(null);
  const [lastCommits, setLastCommits] = useState<Record<string, CodeLastCommit | null>>({});
  const [readme, setReadme] = useState<FileAtCommit | null>(null);
  const [file, setFile] = useState<FileAtCommit | null>(null);
  const [fileError, setFileError] = useState<FriendlyError | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState<{ query: string; files: string[]; hits: CodeSearchHit[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [pickerTab, setPickerTab] = useState<'branches' | 'tags' | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'commit'; message: string } | { kind: 'push' } | { kind: 'switch'; target: string; remote: boolean } | { kind: 'delete'; path: string }>(null);
  const [saving, setSaving] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);

  const viewRef = ref ?? info?.ref ?? null;
  const isCurrent = !!viewRef && viewRef === info?.current;
  const isGitHub = !!activeRepo?.github;

  // ---- data loading ----
  useEffect(() => {
    let cancelled = false;
    call('code:info', { repoId, ref: ref ?? undefined })
      .then((d) => {
        if (cancelled) return;
        setInfo(d);
        setInfoError(null);
      })
      .catch((err) => !cancelled && setInfoError(toFriendly(err)));
    return () => {
      cancelled = true;
    };
  }, [repoId, ref, revision]);

  useEffect(() => {
    call('git:status', { repoId })
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [repoId, revision]);

  useEffect(() => {
    if (!viewRef || !info?.lastCommit) {
      setEntries(info && !info.lastCommit ? [] : null);
      return;
    }
    let cancelled = false;
    setTreeError(null);
    call('code:tree', { repoId, ref: viewRef, path: dir })
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setLastCommits({});
        const paths = list.map((e) => e.path).slice(0, 200);
        if (paths.length) void call('code:lastCommits', { repoId, ref: viewRef, paths }).then((m) => !cancelled && setLastCommits(m)).catch(() => undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setEntries([]);
        setTreeError(toFriendly(err));
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, viewRef, dir, info?.lastCommit, revision]);

  /** Uncommitted state of the working copy (only meaningful when viewing the checked-out branch). */
  const changes = useMemo(() => {
    const m = new Map<string, ChangeMark>();
    if (!status || !isCurrent) return m;
    for (const f of [...status.staged, ...status.unstaged, ...status.untracked]) {
      const kind: ChangeMark = f.kind === 'untracked' || f.kind === 'added' ? 'added' : f.kind === 'deleted' ? 'deleted' : f.kind === 'renamed' ? 'renamed' : 'modified';
      if (!m.has(f.path) || kind === 'deleted') m.set(f.path, kind);
    }
    return m;
  }, [status, isCurrent]);
  const pendingCount = status ? new Set([...status.staged, ...status.unstaged, ...status.untracked].map((f) => f.path)).size : 0;

  // New files in this folder that are not committed yet are listed too, marked "new".
  const shownEntries = useMemo(() => {
    if (!entries) return null;
    const list = [...entries];
    const prefix = dir ? `${dir}/` : '';
    const names = new Set(list.map((e) => e.name));
    for (const [p, k] of changes) {
      if (k !== 'added' || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split('/')[0];
      if (names.has(name)) continue;
      names.add(name);
      list.push({ name, path: prefix + name, type: rest.includes('/') ? 'dir' : 'file', size: null });
    }
    return list.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [entries, changes, dir]);

  const markFor = (e: CodeEntry): ChangeMark | null => {
    if (e.type !== 'dir') return changes.get(e.path) ?? null;
    const prefix = `${e.path}/`;
    for (const p of changes.keys()) if (p.startsWith(prefix)) return 'modified';
    return null;
  };

  // README of the folder being shown.
  const readmeEntry = shownEntries?.find((e) => e.type === 'file' && README_RE.test(e.name)) ?? null;
  useEffect(() => {
    if (!readmeEntry || !viewRef) return setReadme(null);
    let cancelled = false;
    loadContent(readmeEntry.path)
      .then((f) => !cancelled && setReadme(f))
      .catch(() => !cancelled && setReadme(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readmeEntry?.path, viewRef, revision, changes.get(readmeEntry?.path ?? '')]);

  /** Committed content, or the working-copy version when the checked-out branch has uncommitted edits. */
  const loadContent = useCallback(
    async (path: string): Promise<FileAtCommit> => {
      const mark = changes.get(path);
      if (isCurrent && (mark === 'added' || mark === 'modified' || mark === 'renamed')) {
        const local = await call('gh:readLocalFile', { repoId, path });
        return { path, hash: 'WORKTREE', content: local.content, binary: false, truncated: local.truncated };
      }
      return call('code:file', { repoId, ref: viewRef!, path });
    },
    [changes, isCurrent, repoId, viewRef],
  );

  const filePath = view.kind === 'file' ? view.path : null;
  useEffect(() => {
    if (!filePath || !viewRef) return;
    let cancelled = false;
    setFileError(null);
    loadContent(filePath)
      .then((f) => !cancelled && setFile(f))
      .catch((err) => {
        if (cancelled) return;
        setFile(null);
        setFileError(toFriendly(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, viewRef, revision]);

  // ---- search ----
  useEffect(() => {
    const q = searchInput.trim();
    if (q.length < 2 || !viewRef) {
      setSearch(null);
      if (view.kind === 'search') setView({ kind: 'tree' });
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      setView((v) => (v.kind === 'edit' ? v : { kind: 'search' }));
      call('code:search', { repoId, ref: viewRef, query: q })
        .then((r) => setSearch({ query: q, ...r }))
        .catch(showError)
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, viewRef, repoId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 't' || e.key === '/') {
        e.preventDefault();
        searchBox.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- navigation ----
  const goDir = (d: string) => {
    setDir(d);
    setView({ kind: 'tree' });
  };
  const openFile = (path: string, line: number | null = null) => {
    setDir(parentOf(path));
    setFile((f) => (f?.path === path ? f : null));
    setView({ kind: 'file', path, line });
  };
  const changeRef = (r: string) => {
    if (view.kind === 'edit' && view.content !== view.original && !window.confirm('Discard your unsaved edits?')) return;
    setRef(r);
    setSearchInput('');
    setReadme(null);
    setEntries(null);
    if (view.kind !== 'file') setView({ kind: 'tree' });
  };

  const onLink = (fromDir: string) => async (href: string) => {
    if (/^(https?:|mailto:)/i.test(href)) return void call('shell:openExternal', { url: href }).catch(showError);
    if (href.startsWith('#')) {
      document.getElementById(`md-${href.slice(1)}`)?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const target = resolveLink(fromDir, href);
    if (!target) return goDir('');
    try {
      const list = await call('code:tree', { repoId, ref: viewRef!, path: parentOf(target) });
      const hit = list.find((e) => e.path === target);
      if (hit?.type === 'dir') goDir(target);
      else if (hit) openFile(target);
      else toast(`${target} does not exist on ${viewRef}`);
    } catch {
      toast(`${target} does not exist on ${viewRef}`);
    }
  };

  // ---- editing ----
  const startEdit = async (path: string) => {
    try {
      const local = await call('gh:readLocalFile', { repoId, path });
      if (local.truncated) return toast('This file is larger than 1 MB — edit it in your editor instead.');
      setView({ kind: 'edit', path, create: false, original: local.content.replace(/\r\n/g, '\n'), content: local.content.replace(/\r\n/g, '\n') });
    } catch (err) {
      showError(err);
    }
  };
  const startCreate = () => setView({ kind: 'edit', path: dir ? `${dir}/` : '', create: true, original: '', content: '' });

  const save = async (andCommit: boolean) => {
    if (view.kind !== 'edit') return;
    const path = view.path.trim().replace(/^\/+/, '');
    if (!path || path.endsWith('/')) return toast('Enter a file name.');
    setSaving(true);
    try {
      await call('code:writeFile', { repoId, path, content: view.content, create: view.create });
      toast(view.create ? `Created ${path}` : `Saved ${path}`);
      const message = `${view.create ? 'Create' : 'Update'} ${baseName(path)}`;
      openFile(path);
      bump();
      if (andCommit) setDialog({ kind: 'commit', message });
    } catch (err) {
      showError(err);
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    if (view.kind === 'edit' && view.content !== view.original && !window.confirm('Discard your unsaved edits?')) return;
    if (view.kind === 'edit' && !view.create) openFile(view.path);
    else setView({ kind: 'tree' });
  };

  const openPr = () => {
    if (!info?.current) return;
    setPrDraft({ base: info.defaultBranch ?? 'main', head: info.current });
    setRepoTab('pulls');
  };

  // ---- rendering helpers ----
  const crumbs = (path: string, isFile: boolean) => {
    const parts = path ? path.split('/') : [];
    return (
      <div className="crumbs">
        <a onClick={() => goDir('')} className="crumb-root">
          {activeRepo!.name}
        </a>
        {parts.map((p, i) => {
          const sub = parts.slice(0, i + 1).join('/');
          const last = i === parts.length - 1;
          return (
            <span key={sub}>
              <span className="crumb-sep">/</span>
              {last && isFile ? <strong>{p}</strong> : <a onClick={() => goDir(sub)}>{p}</a>}
            </span>
          );
        })}
      </div>
    );
  };

  if (infoError && !info) {
    return (
      <div className="content">
        <ErrorPanel error={infoError} />
      </div>
    );
  }
  if (!info) {
    return (
      <div className="content">
        <Skeleton rows={8} />
      </div>
    );
  }

  const empty = !info.lastCommit;
  const isLocalBranch = !!viewRef && info.branches.includes(viewRef);
  const isRemoteBranch = !!viewRef && info.remoteBranches.includes(viewRef);
  const published = isPublished(status);
  const canPush = isCurrent && !!status && !status.operation && (status.ahead > 0 || (!published && !!status.headOid));
  const isDefault = info.current === info.defaultBranch;

  return (
    <div className="content code-page">
      <div className="code-main">
        {/* toolbar */}
        <div className="code-toolbar">
          <RefPicker info={info} value={viewRef ?? ''} onChange={changeRef} openTab={pickerTab} onOpened={() => setPickerTab(null)} />
          <button className="btn ghost sm" onClick={() => setPickerTab('branches')} title="Browse branches">
            ⎇ <strong>{info.branches.length}</strong> {info.branches.length === 1 ? 'branch' : 'branches'}
          </button>
          <button className="btn ghost sm" onClick={() => setPickerTab('tags')} title="Browse tags">
            🏷 <strong>{info.tags.length}</strong> {info.tags.length === 1 ? 'tag' : 'tags'}
          </button>
          <span className="spacer" />
          <div className="code-search">
            <span className="muted">⌕</span>
            <input
              ref={searchBox}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSearchInput('')}
              placeholder="Go to file or search code…"
              spellCheck={false}
            />
            {searchInput ? (
              <button className="btn ghost sm" onClick={() => setSearchInput('')} title="Clear search">
                ✕
              </button>
            ) : (
              <kbd title="Press t or / to search">t</kbd>
            )}
          </div>
          <button className="btn primary" disabled={!isCurrent} onClick={startCreate} title={isCurrent ? 'Create a new file in this folder' : `Switch to ${viewRef} to add files`}>
            ＋ Add file
          </button>
        </div>

        {/* branch state */}
        {isCurrent ? (
          (pendingCount > 0 || canPush || !isDefault) && (
            <div className={`branch-bar ${pendingCount ? 'pending' : ''} slide-down`}>
              <span className="branch-bar-text">
                {pendingCount > 0 ? (
                  <>
                    <span className="pulse-dot" /> <strong>{pendingCount}</strong> uncommitted change{pendingCount === 1 ? '' : 's'} on <span className="branch-pill">{info.current}</span>
                  </>
                ) : canPush ? (
                  <>
                    <strong>{published ? `${status!.ahead} commit${status!.ahead === 1 ? '' : 's'}` : 'This branch'}</strong> {published ? 'not pushed yet' : 'is not on the remote yet'}
                  </>
                ) : (
                  <>
                    <span className="branch-pill">{info.current}</span> is up to date with the remote
                  </>
                )}
              </span>
              <span className="spacer" />
              {pendingCount > 0 && (
                <>
                  <button className="btn sm ghost" onClick={() => setRepoTab('changes')}>
                    Review
                  </button>
                  <button className="btn sm primary" onClick={() => setDialog({ kind: 'commit', message: '' })}>
                    ✓ Commit…
                  </button>
                </>
              )}
              <button className={`btn sm ${canPush && !pendingCount ? 'primary' : ''}`} disabled={!canPush} onClick={() => setDialog({ kind: 'push' })}>
                ⬆ Push{status?.ahead ? ` ↑${status.ahead}` : ''}…
              </button>
              {!isDefault && isGitHub && (
                <button className="btn sm" onClick={openPr} title={`Open a pull request from ${info.current} into ${info.defaultBranch}`}>
                  ⇄ Pull request
                </button>
              )}
            </div>
          )
        ) : (
          <div className="branch-bar readonly slide-down">
            <span className="branch-bar-text">
              👁 Browsing <span className="branch-pill">{viewRef}</span> read-only. Your working copy is on <span className="branch-pill">{info.current ?? 'detached HEAD'}</span>.
            </span>
            <span className="spacer" />
            {(isLocalBranch || isRemoteBranch) && (
              <button className="btn sm" onClick={() => setDialog({ kind: 'switch', target: viewRef!, remote: !isLocalBranch })}>
                {isLocalBranch ? `Switch to ${viewRef}` : 'Check out locally'}
              </button>
            )}
            {info.current && (
              <button className="btn sm ghost" onClick={() => changeRef(info.current!)}>
                Back to {info.current}
              </button>
            )}
          </div>
        )}

        {/* body */}
        {view.kind === 'search' ? (
          <div className="card code-card fade-in">
            <div className="row mb">
              <h3 className="grow" style={{ margin: 0 }}>
                {searching ? 'Searching…' : search ? `Results for “${search.query}” on ${viewRef}` : 'Search'}
              </h3>
              {searching && <Spinner />}
            </div>
            {search && (
              <>
                {search.files.length > 0 && (
                  <>
                    <h4>Files ({search.files.length})</h4>
                    <div className="result-files">
                      {search.files.map((f) => (
                        <div key={f} className="result-file" onClick={() => openFile(f)}>
                          📄 <span className="mono">{f}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <h4 className="mt">
                  Code ({search.hits.length}
                  {search.truncated ? '+' : ''})
                </h4>
                {search.hits.length === 0 && <div className="small muted">No text matches.</div>}
                {Object.entries(
                  search.hits.reduce<Record<string, CodeSearchHit[]>>((acc, h) => {
                    (acc[h.path] ??= []).push(h);
                    return acc;
                  }, {}),
                ).map(([path, hits]) => (
                  <div key={path} className="hit-group">
                    <div className="hit-path" onClick={() => openFile(path)}>
                      📄 <span className="mono">{path}</span> <span className="badge">{hits.length}</span>
                    </div>
                    {hits.slice(0, 8).map((h, i) => (
                      <div key={i} className="hit-line" onClick={() => openFile(path, h.line)}>
                        <span className="ln">{h.line}</span>
                        <span className="mono">{highlightTerm(h.text, search.query)}</span>
                      </div>
                    ))}
                    {hits.length > 8 && <div className="small muted hit-more">+ {hits.length - 8} more in this file</div>}
                  </div>
                ))}
                {search.truncated && <div className="small muted mt">Showing the first 500 matches — refine your search to see more.</div>}
              </>
            )}
          </div>
        ) : view.kind === 'edit' ? (
          <div className="card code-card fade-in">
            <div className="row mb">
              {view.create ? (
                <div className="row grow">
                  <span className="muted">{activeRepo!.name} /</span>
                  <input autoFocus value={view.path} onChange={(e) => setView({ ...view, path: e.target.value })} placeholder="folder/name-your-file.md" spellCheck={false} className="mono" />
                </div>
              ) : (
                <div className="grow">{crumbs(view.path, true)}</div>
              )}
              <span className="small muted">on</span>
              <span className="branch-pill">{info.current}</span>
            </div>
            <CodeEditor value={view.content} onChange={(content) => setView({ ...view, content })} onSave={() => void save(false)} />
            <div className="row mt">
              <span className="small muted">
                {view.content !== view.original ? '● Unsaved changes · ' : ''}Ctrl+S saves. Saving writes the file to your working copy and stages it — nothing is committed until you confirm.
              </span>
              <span className="spacer" />
              <button className="btn ghost" onClick={cancelEdit} disabled={saving}>
                Cancel
              </button>
              <button className="btn" onClick={() => void save(false)} disabled={saving || (!view.create && view.content === view.original)}>
                Save
              </button>
              <button className="btn primary" onClick={() => void save(true)} disabled={saving || (!view.create && view.content === view.original)}>
                {saving ? 'Saving…' : 'Save & commit…'}
              </button>
            </div>
          </div>
        ) : view.kind === 'file' ? (
          <div className="fade-in">
            <div className="row mb">
              <button className="btn sm ghost" onClick={() => goDir(parentOf(view.path))} title="Back to folder">
                ←
              </button>
              {crumbs(view.path, true)}
              {changes.get(view.path) && <span className={`change-tag ${changes.get(view.path)}`}>{changes.get(view.path) === 'added' ? 'new' : changes.get(view.path)}</span>}
            </div>
            {fileError && <ErrorPanel error={fileError} />}
            {!file && !fileError && <Skeleton rows={6} />}
            {file && file.path === view.path && (
              <>
                {file.hash === 'WORKTREE' && (
                  <div className="banner info small">
                    <span className="icon">✎</span>
                    <div className="grow">Showing your uncommitted version of this file.</div>
                    <button className="btn sm primary" onClick={() => setDialog({ kind: 'commit', message: `Update ${baseName(file.path)}` })}>
                      Commit…
                    </button>
                  </div>
                )}
                <FileView
                  file={file}
                  line={view.line}
                  term={search?.query ?? ''}
                  onLink={onLink(parentOf(file.path))}
                  toolbar={
                    <>
                      <button
                        className="btn sm ghost"
                        title="Copy file contents"
                        onClick={() =>
                          navigator.clipboard
                            .writeText(file.content)
                            .then(() => toast('File contents copied'))
                            .catch(showError)
                        }
                      >
                        ⧉ Copy
                      </button>
                      <button className="btn sm ghost" title="Copy path" onClick={() => void call('app:copyText', { text: file.path }).then(() => toast('Path copied'), showError)}>
                        Path
                      </button>
                      <button className="btn sm" disabled={!isCurrent || file.binary || changes.get(file.path) === 'deleted'} title={isCurrent ? 'Edit this file' : `Switch to ${viewRef} to edit`} onClick={() => void startEdit(file.path)}>
                        ✎ Edit
                      </button>
                      <button className="btn sm danger" disabled={!isCurrent || changes.get(file.path) === 'deleted'} title={isCurrent ? 'Delete this file' : `Switch to ${viewRef} to delete files`} onClick={() => setDialog({ kind: 'delete', path: file.path })}>
                        🗑
                      </button>
                    </>
                  }
                />
              </>
            )}
          </div>
        ) : (
          <div className="fade-in">
            {dir && <div className="mb">{crumbs(dir, false)}</div>}
            <div className="card code-card flush-card">
              {info.lastCommit && (
                <div className="last-commit">
                  <Avatar login={info.lastCommit.author} size={24} />
                  <strong>{info.lastCommit.author}</strong>
                  <span className="grow ellipsis muted" title={info.lastCommit.subject}>
                    {info.lastCommit.subject}
                  </span>
                  <span className="mono small muted">{info.lastCommit.hash.slice(0, 7)}</span>
                  <span className="small muted">· {relative(info.lastCommit.date)}</span>
                  <button className="btn sm ghost" onClick={() => setRepoTab('graph')} title="Open Git History">
                    🕘 <strong>{info.commitCount.toLocaleString()}</strong> commits
                  </button>
                </div>
              )}
              {treeError && (
                <div style={{ padding: 12 }}>
                  <ErrorPanel error={treeError} />
                </div>
              )}
              {empty ? (
                <div className="empty">
                  <div style={{ fontSize: 28 }}>🌱</div>
                  <strong>This repository is empty.</strong>
                  <div className="small">Add a README or any file to make the first commit.</div>
                  <button className="btn primary mt" disabled={!isCurrent} onClick={() => setView({ kind: 'edit', path: 'README.md', create: true, original: '', content: `# ${activeRepo!.name}\n\n` })}>
                    ＋ Add a README
                  </button>
                </div>
              ) : !shownEntries ? (
                <Skeleton rows={6} />
              ) : (
                <div className="file-table">
                  {dir && (
                    <div className="file-tr" onClick={() => goDir(parentOf(dir))}>
                      <span className="fi">📁</span>
                      <a className="fname">..</a>
                    </div>
                  )}
                  {shownEntries.map((e, idx) => {
                    const lc = lastCommits[e.path];
                    const mark = markFor(e);
                    return (
                      <div
                        key={e.path}
                        className={`file-tr ${mark === 'deleted' ? 'is-deleted' : ''}`}
                        style={{ animationDelay: `${Math.min(idx, 20) * 12}ms` }}
                        onClick={() => (e.type === 'dir' ? goDir(e.path) : e.type === 'file' || e.type === 'symlink' ? openFile(e.path) : undefined)}
                      >
                        <span className="fi">{entryIcon(e)}</span>
                        <span className="fname ellipsis">
                          <a>{e.name}</a>
                          {mark && <span className={`change-tag ${mark}`}>{mark === 'added' ? 'new' : mark}</span>}
                        </span>
                        <span className="fmsg ellipsis muted" title={lc?.subject}>
                          {lc === undefined && e.size !== null ? <span className="sk sk-inline" /> : lc?.subject}
                        </span>
                        <span className="fsize small muted">{e.type === 'file' ? formatBytes(e.size) : ''}</span>
                        <span className="fdate small muted">{lc ? relative(lc.date) : ''}</span>
                      </div>
                    );
                  })}
                  {shownEntries.length === 0 && !treeError && <div className="empty small">This folder is empty.</div>}
                </div>
              )}
            </div>

            {readme && readmeEntry && readme.path === readmeEntry.path && (
              <div className="card code-card readme-card fade-in">
                <div className="readme-head">
                  <span>📖</span>
                  <strong className="grow">{readme.path}</strong>
                  {isCurrent && (
                    <button className="btn sm ghost" onClick={() => void startEdit(readme.path)} title="Edit README">
                      ✎
                    </button>
                  )}
                </div>
                <div className="readme-body">
                  {/\.(md|markdown)$/i.test(readme.path) ? <Markdown source={readme.content} onLink={onLink(parentOf(readme.path))} /> : <pre>{readme.content}</pre>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <AboutPanel repoId={repoId} info={info} isGitHub={isGitHub} />

      {dialog?.kind === 'commit' && (
        <CommitDialog
          repoId={repoId}
          mode="commit"
          initialMessage={dialog.message}
          onClose={() => setDialog(null)}
          onDone={(c) => {
            setDialog(null);
            bump();
            if (c) toast(`Committed ${c.shortHash ?? ''} — push it when you are ready`);
          }}
        />
      )}
      {dialog?.kind === 'push' && (
        <PushDialog
          repoId={repoId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            bump();
          }}
          onRequestPull={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'switch' && (
        <SwitchBranchDialog
          repoId={repoId}
          target={dialog.target}
          kind={dialog.remote ? 'remote' : 'local'}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setRef(null);
            bump();
            void refreshRepos();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete File"
          danger
          explanation={
            <>
              Deletes <code>{dialog.path}</code> from your working copy on <strong>{info.current}</strong> and stages the deletion.
            </>
          }
          impact="Nothing is committed yet — you can restore the file from the Changes tab until you commit."
          confirmLabel="Delete file"
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const path = dialog.path;
            try {
              await call('code:deleteFile', { repoId, path, confirmed: true });
              toast(`Deleted ${path}`);
              goDir(parentOf(path));
              setDialog({ kind: 'commit', message: `Delete ${baseName(path)}` });
              bump();
            } catch (err) {
              setDialog(null);
              showError(err);
            }
          }}
        />
      )}
    </div>
  );
}

function highlightTerm(text: string, term: string) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + term.length)}</mark>
      {text.slice(i + term.length)}
    </>
  );
}
