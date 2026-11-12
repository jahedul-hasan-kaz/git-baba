import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepoSummary } from '../../shared/types';
import { CloneDialog, isLocalPath } from '../dialogs/CloneDialog';
import { CreateRepoWizard } from '../dialogs/CreateRepoWizard';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

type Detected = { kind: 'github' | 'url' | 'ssh' | 'folder'; label: string; url: string } | null;

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** What the quick box holds: owner/repo, an https or ssh clone URL, or a repository folder. */
export function detectSource(raw: string): Detected {
  const v = raw.trim();
  if (!v) return null;
  if (SLUG_RE.test(v)) return { kind: 'github', label: `GitHub · ${v.replace(/\.git$/, '')}`, url: `https://github.com/${v.replace(/\.git$/, '')}.git` };
  if (/^https?:\/\/\S+\/\S+/i.test(v)) {
    try {
      const u = new URL(v);
      return { kind: 'url', label: `${u.hostname} · ${u.pathname.replace(/^\/+|\.git$|\/+$/g, '')}`, url: v };
    } catch {
      return null;
    }
  }
  const scp = /^[A-Za-z0-9._-]+@([^:/\s]+):(\S+)$/.exec(v);
  if (scp) return { kind: 'ssh', label: `SSH · ${scp[1]} · ${scp[2].replace(/\.git$/, '')}`, url: v };
  if (/^ssh:\/\/\S+/i.test(v)) return { kind: 'ssh', label: `SSH · ${v.replace(/^ssh:\/\/(?:[^@/]+@)?/i, '')}`, url: v };
  if (isLocalPath(v)) return { kind: 'folder', label: `Folder · ${v.split(/[\\/]/).filter(Boolean).pop() ?? v}`, url: v };
  return null;
}

const ICON: Record<NonNullable<Detected>['kind'], string> = { github: '🐙', url: '🌐', ssh: '🔑', folder: '📁' };

/** Launchpad shown when no repository is open: one smart box, three actions, and recent repositories. */
export function WelcomePage() {
  const { info, showError, bump, selectRepo, setView, requestAppSetup, repos } = useApp();
  const [dialog, setDialog] = useState<'create' | 'clone' | null>(null);
  const [quick, setQuick] = useState('');
  const [cloneFrom, setCloneFrom] = useState<string | undefined>(undefined);
  const box = useRef<HTMLInputElement>(null);
  const detected = detectSource(quick);

  const open = async () => {
    try {
      const pick = await call('dialog:pickDirectory', { purpose: 'open' });
      if (!pick) return;
      const repo = await call('repo:addExisting', { selectionId: pick.selectionId });
      bump();
      selectRepo(repo.id);
      if (repo.github && !repo.settings.githubApp) requestAppSetup(repo.id);
    } catch (err) {
      showError(err);
    }
  };
  const onCreated = (r: RepoSummary) => {
    bump();
    selectRepo(r.id);
    if (r.github && !r.settings.githubApp) requestAppSetup(r.id);
  };
  const startClone = (from?: string) => {
    setCloneFrom(from);
    setDialog('clone');
  };

  // Single-key shortcuts while nothing is typed into a field: O open, N create, C clone, / quick box.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (dialog || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-backdrop')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'o') void open();
      else if (k === 'n') setDialog('create');
      else if (k === 'c') startClone();
      else if (k === '/') box.current?.focus();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);

  const recent = useMemo(() => [...repos].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.addedAt ?? '').localeCompare(a.addedAt ?? '')).slice(0, 6), [repos]);

  return (
    <div className="content">
      <div className="welcome lp">
        <div className="lp-hero">
          <div className="lp-orb" aria-hidden>
            <span className="lp-ring" />
            <span className="lp-core">⎇</span>
          </div>
          <div>
            <h1>Let's get a repository open</h1>
            <p className="muted">Open one you already have, start a new one, or clone from GitHub, any Git server or a folder. Nothing is committed or pushed without your review.</p>
          </div>
        </div>

        {info && !info.gitVersion && (
          <div className="banner danger">
            <span className="icon">⚠</span>
            <div>
              Git was not found. Install Git from <a onClick={() => void call('shell:openExternal', { url: 'https://git-scm.com/downloads' }).catch(() => undefined)}>git-scm.com</a> and restart the app.
            </div>
          </div>
        )}

        <form
          className={`lp-quick ${detected ? 'ok' : quick.trim() ? 'bad' : ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (detected) startClone(detected.url);
          }}
        >
          <span className="lp-quick-ico">{detected ? ICON[detected.kind] : '⌕'}</span>
          <input
            ref={box}
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuick('')}
            placeholder="Paste a clone URL, owner/repo, git@host:owner/repo.git or a folder path…"
            spellCheck={false}
            aria-label="Repository to clone"
          />
          {detected ? (
            <button className="btn primary sm" type="submit" title={detected.url}>
              ⬇ Clone <span className="lp-quick-what">{detected.label}</span>
            </button>
          ) : quick.trim() ? (
            <span className="small muted nowrap">Not a repository address yet</span>
          ) : (
            <kbd title="Press / to focus">/</kbd>
          )}
        </form>

        <div className="lp-actions">
          <button className="lp-card" onClick={() => void open()}>
            <span className="lp-card-ico open">📂</span>
            <strong>Open repository</strong>
            <span className="small muted">A Git folder already on this computer.</span>
            <span className="lp-flow">Pick folder → added to your list</span>
            <kbd>O</kbd>
          </button>
          <button className="lp-card" onClick={() => setDialog('create')}>
            <span className="lp-card-ico create">✨</span>
            <strong>Create repository</strong>
            <span className="small muted">New project, locally or on GitHub too.</span>
            <span className="lp-flow">Name → folder → (GitHub) → first commit</span>
            <kbd>N</kbd>
          </button>
          <button className="lp-card" onClick={() => startClone()}>
            <span className="lp-card-ico clone">⬇</span>
            <strong>Clone repository</strong>
            <span className="small muted">From GitHub, another server (HTTPS/SSH) or a folder.</span>
            <span className="lp-flow">Source → sign in → download → ready</span>
            <kbd>C</kbd>
          </button>
        </div>

        {recent.length > 0 && (
          <div className="lp-recent">
            <div className="lp-section">Your repositories</div>
            <div className="lp-recent-grid">
              {recent.map((r) => (
                <button key={r.id} className={`lp-repo ${r.exists ? '' : 'missing'}`} onClick={() => selectRepo(r.id)} title={r.path}>
                  <span className="lp-repo-badge">{r.name.slice(0, 2).toUpperCase()}</span>
                  <span className="lp-repo-text">
                    <strong className="ellipsis">
                      {r.favorite ? '★ ' : ''}
                      {r.name}
                    </strong>
                    <span className="small muted ellipsis">
                      {!r.exists ? 'folder missing' : `⎇ ${r.branch ?? '—'}${r.changeCount ? ` · ${r.changeCount} change${r.changeCount === 1 ? '' : 's'}` : ''}`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="lp-promises">
          <span className="lp-chip">🛡 Review before every commit &amp; push</span>
          <span className="lp-chip">🔐 Credentials per operation, in memory</span>
          <span className="lp-chip">🔍 Pulls scanned before merging</span>
          <span className="lp-chip">🚫 Hooks never run silently</span>
          <a className="small" onClick={() => setView('help')}>
            Learn the Git commands →
          </a>
        </div>
      </div>
      {dialog === 'create' && <CreateRepoWizard onClose={() => setDialog(null)} onCreated={onCreated} />}
      {dialog === 'clone' && <CloneDialog initialRepository={cloneFrom} onClose={() => setDialog(null)} onCloned={onCreated} />}
    </div>
  );
}
