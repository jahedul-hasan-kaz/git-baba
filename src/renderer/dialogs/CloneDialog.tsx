import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountCredentialInput, AccountSummary, AuthInput, CloneState, DirectoryCheck, FriendlyError, RemoteRepoEntry, RepoSummary, SshKeyInput } from '../../shared/types';
import { AccountCredentialFields } from '../components/AccountCredentialFields';
import { ErrorPanel } from '../components/ErrorPanel';
import { Modal } from '../components/Modal';
import { SshKeyFields } from '../components/SshKeyFields';
import { WorkflowSteps } from '../components/WorkflowSteps';
import { call, onProgress, toFriendly } from '../services/api';
import { timeAgo } from '../services/format';
import { useApp } from '../state/AppState';
import { ConfirmDialog } from './ConfirmDialog';

import { Select } from '../components/Select';
import { Hourglass } from '../components/Hourglass';
type Source = 'github' | 'enterprise' | 'url';
type Protocol = 'https' | 'pat' | 'ssh';
type HttpsAuth = 'account' | 'system';

interface Target {
  host: string;
  /** "owner" or "group/subgroup" — everything before the repository name. */
  owner: string;
  repo: string;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** A repository folder on this computer or a network share: C:\…, /…, \\server\…, file://… */
export function isLocalPath(v: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('\\\\') || /^file:\/\//i.test(v);
}

/** Reads owner/repo, https://host/owner/repo(.git), git@host:owner/repo.git, ssh://git@host[:port]/owner/repo or a local folder. */
function parseTarget(input: string, defaultHost: string | null): Target | null {
  const v = input.trim().replace(/[\\/]+$/, '');
  if (!v) return null;
  if (!defaultHost && isLocalPath(v)) {
    const repo = (v.split(/[\\/]/).pop() ?? '').replace(/\.git$/, '');
    return repo ? { host: 'this computer', owner: '', repo } : null;
  }
  if (defaultHost && SLUG_RE.test(v)) {
    const [owner, repo] = v.split('/');
    return { host: defaultHost, owner, repo: repo.replace(/\.git$/, '') };
  }
  let host = '';
  let path = '';
  const scp = /^[A-Za-z0-9._-]+@([^:/\s]+):(.+)$/.exec(v);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(v);
      if (!['https:', 'http:', 'ssh:'].includes(u.protocol)) return null;
      host = u.hostname;
      path = u.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }
  const parts = path.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { host: host.toLowerCase(), owner: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1] };
}

function hostOfAccount(a: AccountSummary): string {
  if (!a.apiBaseUrl) return 'github.com';
  try {
    const h = new URL(a.apiBaseUrl).hostname.toLowerCase();
    return h === 'api.github.com' ? 'github.com' : h;
  } catch {
    return 'github.com';
  }
}

function cleanHost(v: string): string {
  return v.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

function joinPath(parent: string, child: string): string {
  if (!parent) return child;
  const sep = parent.includes('/') && !parent.includes('\\') ? '/' : '\\';
  return parent.endsWith('\\') || parent.endsWith('/') ? `${parent}${child}` : `${parent}${sep}${child}`;
}

function nodeParent(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

function mask(v: string): string {
  return v.length <= 8 ? '••••••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

const PARENT_KEY = 'gitbaba.clone.parent';
function readLastParent(): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? '';
  } catch {
    return '';
  }
}
function writeLastParent(p: string): void {
  try {
    localStorage.setItem(PARENT_KEY, p);
  } catch {
    // per-viewer convenience only
  }
}

function Req({ show, children }: { show: boolean; children: React.ReactNode }) {
  return show ? <div className="field-hint">{children}</div> : null;
}

/** Clone: source (GitHub.com / Enterprise / URL) → protocol (HTTPS / PAT / SSH) → authenticate → clone → verify → add. */
export function CloneDialog({ onClose, onCloned, initialRepository }: { onClose: () => void; onCloned: (r: RepoSummary) => void; initialRepository?: string }) {
  const { accounts, activeAccount, repos: appRepos, toast } = useApp();
  const [source, setSource] = useState<Source>('url');
  const [enterpriseHost, setEnterpriseHost] = useState('');
  const [typedRepository, setTypedRepository] = useState(initialRepository ?? '');
  // GitHub.com tab: browse the account's repositories instead of typing one.
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepoEntry[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const repository = source === 'github' ? (picked ?? '') : typedRepository;
  const [destPath, setDestPath] = useState(readLastParent);
  const [destCheck, setDestCheck] = useState<DirectoryCheck | null>(null);
  const [folder, setFolder] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('https');
  const [httpsAuth, setHttpsAuth] = useState<HttpsAuth>('account');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [credential, setCredential] = useState<AccountCredentialInput | null>(null);
  const onCred = useCallback((c: AccountCredentialInput | null) => setCredential(c), []);
  const [patUser, setPatUser] = useState('');
  const [patToken, setPatToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [ssh, setSsh] = useState<{ input: SshKeyInput | null; summary: string }>({ input: null, summary: '' });
  const onSsh = useCallback((input: SshKeyInput | null, summary: string) => setSsh({ input, summary }), []);
  const [authKey, setAuthKey] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const [state, setState] = useState<CloneState | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const defaultHost = source === 'github' ? 'github.com' : source === 'enterprise' ? cleanHost(enterpriseHost) || null : null;
  const target = useMemo(() => parseTarget(repository, defaultHost), [repository, defaultHost]);
  const host = target?.host ?? defaultHost;
  const hostAccounts = (accounts?.accounts ?? []).filter((a) => host && hostOfAccount(a) === host);
  const account = hostAccounts.find((a) => a.id === accountId) ?? null;

  // Keep the chosen account valid for the current host.
  useEffect(() => {
    if (account) return;
    const pick = hostAccounts.find((a) => a.id === activeAccount?.id) ?? hostAccounts[0] ?? null;
    setAccountId(pick?.id ?? null);
    if (!pick && httpsAuth === 'account') setHttpsAuth('system');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, accounts]);

  // Folder name follows the repository until the user edits it (always, on the GitHub.com tab).
  useEffect(() => {
    if (!folderTouched || source === 'github') setFolder(target?.repo ?? '');
  }, [target?.repo, folderTouched, source]);

  // Destination: the folder used last time, otherwise the drive root of this computer.
  useEffect(() => {
    if (destPath) return;
    call('clone:resolveFolder', {})
      .then((d) => setDestPath((cur) => cur || d.path))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live check of the typed destination.
  useEffect(() => {
    if (!destPath.trim() || state) {
      setDestCheck(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      call('clone:resolveFolder', { path: destPath })
        .then((d) => !stale && setDestCheck(d))
        .catch(() => !stale && setDestCheck({ path: destPath, exists: false, isDirectory: false, selectionId: null }));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [destPath, state]);

  // A different account or tab means a different list.
  useEffect(() => {
    setRemoteRepos(null);
    setPicked(null);
    setRepoFilter('');
  }, [accountId, source]);

  const loadRepos = useCallback(async () => {
    if (!credential) return;
    setLoadingRepos(true);
    setError(null);
    try {
      const res = await call('clone:listRepos', { credential });
      setRemoteRepos(res.repos);
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setLoadingRepos(false);
    }
  }, [credential]);

  // A remembered credential needs no typing, so the list can load straight away.
  useEffect(() => {
    if (source === 'github' && credential?.useRemembered && credential.accountId === accountId && remoteRepos === null && !loadingRepos) void loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, credential?.useRemembered, credential?.accountId, accountId]);

  useEffect(
    () =>
      onProgress((e) => {
        if (e.kind === 'clone') setState((cur) => (cur && cur.workflowId === e.state.workflowId ? e.state : cur));
      }),
    [],
  );

  // A pasted URL that already uses the chosen transport is cloned as-is (keeps custom ports and paths).
  const pasted = repository.trim();
  const pastedIsSsh = /^ssh:\/\//i.test(pasted) || /^[A-Za-z0-9._-]+@[^:/\s]+:/.test(pasted);
  const pastedIsHttps = /^https?:\/\//i.test(pasted);
  const local = source === 'url' && !!target && isLocalPath(pasted);
  // A pasted git@… / ssh:// address means SSH; a pasted https:// address means HTTPS. Follow it.
  useEffect(() => {
    if (state) return;
    if (pastedIsSsh) setProtocol('ssh');
    else if (pastedIsHttps) setProtocol((p) => (p === 'ssh' ? 'https' : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedIsSsh, pastedIsHttps]);
  const cloneUrl = !target ? '' : local ? pasted : (protocol === 'ssh' && pastedIsSsh) || (protocol !== 'ssh' && pastedIsHttps) ? pasted : protocol === 'ssh' ? `git@${target.host}:${target.owner}/${target.repo}.git` : `https://${target.host}/${target.owner}/${target.repo}.git`;

  const auth: { kind: 'account'; credential: AccountCredentialInput } | { kind: 'other'; input: AuthInput; summary: string } | null = local
    ? { kind: 'other', input: { method: 'none' }, summary: 'None needed — a folder on this computer' }
    : protocol === 'https'
      ? httpsAuth === 'account'
        ? credential && account
          ? { kind: 'account', credential }
          : null
        : { kind: 'other', input: { method: 'system' }, summary: 'Your existing Git credentials (credential manager)' }
      : protocol === 'pat'
        ? patToken.trim()
          ? { kind: 'other', input: { method: 'pat', token: patToken.trim(), username: patUser.trim() || undefined }, summary: `Personal access token ${mask(patToken.trim())}${patUser.trim() ? ` as ${patUser.trim()}` : ''}` }
          : null
        : ssh.input
          ? { kind: 'other', input: { method: 'ssh', ...ssh.input }, summary: ssh.summary }
          : null;

  // Everything still missing, in the order the user meets it.
  const missing: { id: string; text: string }[] = [];
  if (source === 'enterprise' && !cleanHost(enterpriseHost)) missing.push({ id: 'host', text: 'Enterprise server address' });
  if (source === 'github') {
    if (!picked) missing.push({ id: 'repo', text: remoteRepos ? 'Pick a repository from the list' : 'Load and pick a repository' });
  } else if (!repository.trim()) missing.push({ id: 'repo', text: 'Repository' });
  else if (!target) missing.push({ id: 'repo', text: 'A valid repository (owner/name or a clone URL)' });
  if (source !== 'github' && !folder.trim()) missing.push({ id: 'folder', text: 'Folder name' });
  if (!state) {
    if (!destPath.trim()) missing.push({ id: 'dest', text: 'Destination folder' });
    else if (destCheck && destCheck.exists && !destCheck.isDirectory) missing.push({ id: 'dest', text: 'Destination is a file, not a folder' });
  }
  if (!auth) {
    missing.push({
      id: 'auth',
      text:
        protocol === 'https' ? (account ? `Token for ${account.login}` : 'A GitHub account for this server') : protocol === 'pat' ? 'Personal access token' : 'SSH key',
    });
  }
  const isMissing = (id: string) => missing.some((m) => m.id === id);
  const flag = (id: string) => attempted && isMissing(id);

  const browse = async () => {
    try {
      const p = await call('dialog:pickDirectory', { purpose: 'clone-parent' });
      if (p) setDestPath(p.path);
    } catch (err) {
      setError(toFriendly(err));
    }
  };

  const clonedKeys = useMemo(() => new Set(appRepos.filter((r) => r.github).map((r) => `${r.github!.owner}/${r.github!.repo}`.toLowerCase())), [appRepos]);
  const available = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    return (remoteRepos ?? []).filter((r) => !clonedKeys.has(r.fullName.toLowerCase()) && (!q || r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)));
  }, [remoteRepos, clonedKeys, repoFilter]);
  const hiddenCloned = (remoteRepos ?? []).filter((r) => clonedKeys.has(r.fullName.toLowerCase())).length;

  const authenticateAndClone = async () => {
    setAttempted(true);
    if (missing.length || !auth || !target) return;
    setBusy(true);
    setError(null);
    try {
      let s = state;
      if (!s || s.phase === 'cancelled') {
        // Typed paths are registered (and created when missing) just before use.
        const dest = await call('clone:resolveFolder', { path: destPath, register: true, create: true });
        if (!dest.selectionId) throw new Error(`${dest.path} is not a folder.`);
        writeLastParent(dest.path);
        s = await call('clone:start', {
          input: { selectionId: dest.selectionId, folderName: folder.trim(), repository: cloneUrl, accountId: auth.kind === 'account' ? auth.credential.accountId : null },
        });
        setState(s);
      }
      const next = await call('clone:authenticate', auth.kind === 'account' ? { workflowId: s.workflowId, credential: auth.credential } : { workflowId: s.workflowId, auth: auth.input });
      setState(next);
      setPatToken('');
      setAuthKey((k) => k + 1);
      if (next.phase === 'done' && next.repo) {
        toast(`Cloned ${next.repo.name}`);
        onCloned(next.repo);
      }
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (state && state.phase === 'running') {
      try {
        setState(await call('clone:cancel', { workflowId: state.workflowId }));
      } catch (err) {
        setError(toFriendly(err));
      }
      return;
    }
    onClose();
  };

  const running = state?.phase === 'running';
  const done = state?.phase === 'done';
  const locked = !!state;
  const showSetup = !state || state.phase === 'awaiting-auth';
  const tokenUrl = host && host !== 'github.com' ? `https://${host}/settings/tokens/new?scopes=repo&description=Git%20Baba` : 'https://github.com/settings/tokens/new?scopes=repo&description=Git%20Baba';
  const sshUrl = host && host !== 'github.com' ? `https://${host}/settings/ssh/new` : 'https://github.com/settings/ssh/new';
  const open = (url: string) => void call('shell:openExternal', { url }).catch(() => undefined);

  return (
    <Modal
      title="Clone Repository"
      size="wide"
      onClose={running ? cancel : onClose}
      locked={busy && !running}
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : running ? (
          <button className="btn danger" onClick={cancel}>
            Cancel clone
          </button>
        ) : (
          <>
            {state?.leftoverFolder && (
              <button className="btn danger" onClick={() => setConfirmRemove(true)}>
                Remove incomplete folder…
              </button>
            )}
            {attempted && missing.length > 0 && (
              <span className="small text-danger ellipsis" title={missing.map((m) => m.text).join('\n')}>
                Still needed: {missing.map((m) => m.text).join(' · ')}
              </span>
            )}
            <span className="spacer" />
            <button className="btn cancel" onClick={onClose} disabled={busy}>
              {state?.phase === 'cancelled' || state?.phase === 'failed' ? 'Close' : 'Cancel'}
            </button>
            {state?.phase !== 'failed' && state?.phase !== 'cancelled' ? (
              <button
                className="btn primary"
                onClick={authenticateAndClone}
                disabled={busy}
                title={missing.length ? `Still needed:\n${missing.map((m) => `• ${m.text}`).join('\n')}` : undefined}
              >
                {busy ? 'Authenticating…' : state ? 'Retry authentication' : 'Clone'}
              </button>
            ) : (
              <button
                className="btn primary"
                title={state?.leftoverFolder ? 'Remove the incomplete folder first, or use another folder name' : undefined}
                onClick={() => {
                  setState(null);
                  setError(null);
                  setAttempted(false);
                  setAuthKey((k) => k + 1);
                }}
              >
                Start over
              </button>
            )}
          </>
        )
      }
    >
      {error && <ErrorPanel error={error} />}

      {showSetup && (
        <>
          {/* 1. Where from */}
          <div className="clone-section">
            <div className="clone-step">
              <span className="num">1</span> Repository
            </div>
            <div className="segmented mb" role="tablist">
              {(
                [
                  ['github', 'GitHub.com'],
                  ['enterprise', 'GitHub Enterprise'],
                  ['url', 'URL'],
                ] as [Source, string][]
              ).map(([id, label]) => (
                <button key={id} className={source === id ? 'on' : ''} disabled={locked} onClick={() => setSource(id)}>
                  {label}
                </button>
              ))}
            </div>

            {source === 'enterprise' && (
              <div className={`field ${flag('host') ? 'invalid' : ''}`}>
                <label>
                  Enterprise server address <span className="req">*</span>
                </label>
                <input value={enterpriseHost} onChange={(e) => setEnterpriseHost(e.target.value)} placeholder="github.example.com" spellCheck={false} disabled={locked} />
                <Req show={flag('host')}>Enter your GitHub Enterprise server, e.g. github.example.com.</Req>
              </div>
            )}

            {source === 'github' ? (
              <div className={`field ${flag('repo') ? 'invalid' : ''}`}>
                <label>
                  Your repositories <span className="req">*</span>
                </label>
                {hostAccounts.length === 0 ? (
                  <div className="banner info small">
                    <span className="icon">ℹ</span>
                    <div>
                      Add your GitHub.com account first (header → GitHub Account) to see your repositories here, or use the <a onClick={() => setSource('url')}>URL</a> tab.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="repo-browse-auth">
                      {hostAccounts.length > 1 && (
                        <Select kind="account" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value)} disabled={locked} aria-label="GitHub account">
                          {hostAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.login}
                              {a.active ? ' (default)' : ''}
                            </option>
                          ))}
                        </Select>
                      )}
                      {account && <AccountCredentialFields key={`${authKey}-${account.id}`} account={account} encryptionAvailable={!!accounts?.encryptionAvailable} purpose="list and clone your repositories" onChange={onCred} />}
                      <div className="row mt">
                        <button className="btn" onClick={() => void loadRepos()} disabled={!credential || credential.accountId !== accountId || loadingRepos || locked}>
                          {loadingRepos ? 'Loading…' : remoteRepos ? <><Hourglass /> Reload repositories</> : 'Load my repositories'}
                        </button>
                        {!credential && <span className="small muted">Enter the account's token to list its repositories.</span>}
                      </div>
                    </div>

                    {remoteRepos && (
                      <div className="repo-browser">
                        <input value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} placeholder={`Filter ${available.length} repositories…`} spellCheck={false} disabled={locked} />
                        <div className="repo-browser-list" role="listbox">
                          {available.length === 0 && (
                            <div className="small muted pad">
                              {remoteRepos.length === 0 ? 'No repositories found for this account.' : repoFilter ? 'No repositories match.' : 'Every repository of this account is already cloned.'}
                            </div>
                          )}
                          {available.map((r) => (
                            <div
                              key={r.fullName}
                              role="option"
                              aria-selected={picked === r.fullName}
                              className={`repo-row ${picked === r.fullName ? 'selected' : ''}`}
                              onClick={() => !locked && setPicked(r.fullName)}
                            >
                              <div className="grow" style={{ minWidth: 0 }}>
                                <div className="row" style={{ gap: 6 }}>
                                  <strong className="ellipsis">{r.fullName}</strong>
                                  {r.private && <span className="badge warn">private</span>}
                                  {r.fork && <span className="badge">fork</span>}
                                  {r.archived && <span className="badge">archived</span>}
                                </div>
                                {r.description && <div className="small muted ellipsis">{r.description}</div>}
                              </div>
                              {r.updatedAt && <span className="small muted nowrap">{timeAgo(r.updatedAt)}</span>}
                            </div>
                          ))}
                        </div>
                        <div className="small muted">
                          {available.length} available{hiddenCloned ? ` · ${hiddenCloned} already cloned (hidden)` : ''}
                        </div>
                      </div>
                    )}
                  </>
                )}
                <Req show={flag('repo')}>Pick the repository you want to clone.</Req>
              </div>
            ) : (
              <>
                <div className={`field ${flag('repo') ? 'invalid' : ''}`}>
                  <label>
                    {source === 'url' ? 'Repository URL' : 'Repository'} <span className="req">*</span>
                  </label>
                  <input
                    value={typedRepository}
                    onChange={(e) => setTypedRepository(e.target.value)}
                    placeholder={source === 'url' ? 'https://host/owner/repo.git  ·  git@host:owner/repo.git  ·  C:\\path\\repo.git' : 'owner/repository  or paste a URL'}
                    spellCheck={false}
                    disabled={locked}
                  />
                  <Req show={flag('repo')}>{typedRepository.trim() ? 'This does not look like owner/repository or a clone URL.' : 'Which repository do you want to clone?'}</Req>
                  {target && (
                    <div className="small muted mt-xs">
                      {local ? (
                        <>
                          📁 Folder on this computer · <strong>{target.repo}</strong>
                        </>
                      ) : (
                        <>
                          {target.host} · <strong>{target.owner}/{target.repo}</strong>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <div className={`field ${flag('folder') ? 'invalid' : ''}`}>
                  <label>
                    Folder name <span className="req">*</span>
                  </label>
                  <input
                    value={folder}
                    onChange={(e) => {
                      setFolder(e.target.value);
                      setFolderTouched(true);
                    }}
                    spellCheck={false}
                    disabled={locked}
                  />
                  <Req show={flag('folder')}>Name of the new folder for the repository.</Req>
                </div>
              </>
            )}

            <div className={`field ${flag('dest') ? 'invalid' : ''}`}>
              <label>
                Local path <span className="req">*</span>
              </label>
              <div className="row">
                <input
                  className="grow mono"
                  value={state?.summary.destination ? nodeParent(state.summary.destination) : destPath}
                  onChange={(e) => setDestPath(e.target.value)}
                  placeholder="C:\Workspace\github-repo"
                  spellCheck={false}
                  disabled={locked}
                />
                <button className="btn" onClick={browse} disabled={locked}>
                  Choose…
                </button>
              </div>
              {destCheck && !state && destCheck.exists && !destCheck.isDirectory && <div className="field-hint">That path is a file. Enter a folder.</div>}
              {destCheck && !state && !destCheck.exists && destPath.trim() && <div className="small text-warn mt-xs">This folder doesn't exist yet — it will be created.</div>}
              <Req show={flag('dest') && !destPath.trim()}>Choose where the repository folder is created.</Req>
              <div className="small muted mt-xs">
                The repository is cloned into <span className="mono">{state?.summary.destination ?? (folder ? joinPath(destCheck?.path ?? destPath, folder) : destCheck?.path ?? destPath)}</span>
              </div>
            </div>
          </div>

          {/* 2. How to authenticate */}
          {local ? (
            <div className="banner info small">
              <span className="icon">📁</span>
              <div>
                This repository is a folder on this computer (or a network share), so <strong>no sign-in is needed</strong>. The clone's <span className="mono">origin</span> points
                to that folder: fetch, pull and push work with it directly.
              </div>
            </div>
          ) : (
          <div className="clone-section">
            <div className="clone-step">
              <span className="num">2</span> Authentication
            </div>
            <div className="proto-cards">
              {(
                [
                  ['https', 'HTTPS', 'Sign in with your GitHub account, or use the Git credentials already on this computer'],
                  ['pat', 'Personal access token', 'Paste a token (classic or fine-grained) with read access to the repository'],
                  ['ssh', 'SSH', 'Use an SSH key on this computer, generate one, or provide your public key'],
                ] as [Protocol, string, string][]
              ).map(([id, label, desc]) => (
                <label key={id} className={`radio-card ${protocol === id ? 'selected' : ''} ${locked ? 'disabled' : ''}`}>
                  <input type="radio" checked={protocol === id} onChange={() => setProtocol(id)} disabled={locked} />
                  <div>
                    <strong>{label}</strong>
                    <div className="small muted">{desc}</div>
                  </div>
                </label>
              ))}
            </div>

            <div className={`auth-panel ${flag('auth') ? 'invalid' : ''}`}>
              {protocol === 'https' && (
                <>
                  <div className="segmented mb">
                    <button className={httpsAuth === 'account' ? 'on' : ''} onClick={() => setHttpsAuth('account')} disabled={locked}>
                      GitHub account
                    </button>
                    <button className={httpsAuth === 'system' ? 'on' : ''} onClick={() => setHttpsAuth('system')} disabled={locked}>
                      Git credential manager
                    </button>
                  </div>
                  {httpsAuth === 'account' &&
                    (hostAccounts.length === 0 ? (
                      <div className="banner info small">
                        <span className="icon">ℹ</span>
                        <div>
                          No GitHub account for <strong>{host ?? 'this server'}</strong> is added yet. Add one from the header (GitHub Account), or choose <a onClick={() => setProtocol('pat')}>Personal access token</a> or{' '}
                          <a onClick={() => setHttpsAuth('system')}>Git credential manager</a>.
                        </div>
                      </div>
                    ) : source === 'github' ? (
                      <p className="small muted">
                        {credential && credential.accountId === accountId ? (
                          <>✓ Signed in as <strong>{account?.login}</strong> above — the same token clones the repository.</>
                        ) : (
                          <>Enter the token for <strong>{account?.login}</strong> in the repository list above.</>
                        )}
                      </p>
                    ) : (
                      <>
                        {hostAccounts.length > 1 && (
                          <div className="field">
                            <label>
                              Account <span className="req">*</span>
                            </label>
                            <Select kind="account" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value)} disabled={locked}>
                              {hostAccounts.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.login}
                                  {a.active ? ' (default)' : ''}
                                </option>
                              ))}
                            </Select>
                          </div>
                        )}
                        {account && <AccountCredentialFields key={`${authKey}-${account.id}`} account={account} encryptionAvailable={!!accounts?.encryptionAvailable} purpose="verify access and clone" onChange={onCred} />}
                      </>
                    ))}
                  {httpsAuth === 'system' && (
                    <p className="small muted">
                      Git uses what is already set up on this computer (e.g. Git Credential Manager). Nothing is entered or stored here. If no credential is stored, the clone of a private repository fails — use a token or SSH instead.
                    </p>
                  )}
                </>
              )}

              {protocol === 'pat' && (
                <>
                  <div className="grid-2">
                    <div className={`field ${flag('auth') ? 'invalid' : ''}`}>
                      <label>
                        Personal access token <span className="req">*</span>
                      </label>
                      <div className="row">
                        <input
                          className="grow mono"
                          type={showToken ? 'text' : 'password'}
                          value={patToken}
                          onChange={(e) => setPatToken(e.target.value)}
                          placeholder="ghp_… or github_pat_…"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={busy}
                        />
                        <button type="button" className="btn sm ghost" onClick={() => setShowToken((s) => !s)} title={showToken ? 'Hide token' : 'Show token'}>
                          {showToken ? '🙈' : '👁'}
                        </button>
                      </div>
                      <Req show={flag('auth')}>Paste a token with read access to {target ? `${target.owner}/${target.repo}` : 'the repository'}.</Req>
                    </div>
                    <div className="field">
                      <label>Username (optional)</label>
                      <input value={patUser} onChange={(e) => setPatUser(e.target.value)} placeholder="your GitHub login" spellCheck={false} disabled={busy} />
                    </div>
                  </div>
                  <div className="row small">
                    <span className="muted grow">Used for this clone only, then removed from memory. Not saved.</span>
                    <a onClick={() => open(tokenUrl)}>Create a token on {host ?? 'GitHub'} ↗</a>
                  </div>
                </>
              )}

              {protocol === 'ssh' && (
                <>
                  {target && (
                    <div className="small muted mb">
                      Clones from <span className="mono">{cloneUrl}</span>
                    </div>
                  )}
                  <SshKeyFields key={authKey} savedKey={null} onChange={onSsh} />
                  {flag('auth') && <div className="field-hint">Choose, generate or provide the SSH key to use.</div>}
                  <div className="row small mt">
                    <span className="muted grow">The public key must be added to your account on {host ?? 'GitHub'}.</span>
                    <a onClick={() => open(sshUrl)}>Add SSH key ↗</a>
                  </div>
                </>
              )}
            </div>
          </div>
          )}

          <div className="card mt">
            <dl className="kv">
              <dt>Repository</dt>
              <dd>{target ? (local ? cloneUrl : `${target.host}/${target.owner}/${target.repo}`) : '—'}</dd>
              <dt>Clone URL</dt>
              <dd className="mono small">{cloneUrl || '—'}</dd>
              <dt>Authentication</dt>
              <dd>{auth ? (auth.kind === 'account' ? `GitHub account ${account?.login}` : auth.summary) : <span className="muted">not chosen yet</span>}</dd>
              <dt>Destination</dt>
              <dd className="mono small">{state?.summary.destination ?? (destPath.trim() ? joinPath(destCheck?.path ?? destPath, folder) : '—')}</dd>
            </dl>
          </div>
        </>
      )}

      {state && (
        <>
          {state.phase !== 'awaiting-auth' && (
            <dl className="kv mb">
              <dt>Repository</dt>
              <dd>{state.summary.repository}</dd>
              <dt>Account</dt>
              <dd>{state.summary.account ?? '—'}</dd>
              <dt>Authentication</dt>
              <dd>{state.summary.authentication}</dd>
              <dt>Destination</dt>
              <dd className="mono small">{state.summary.destination}</dd>
            </dl>
          )}
          {state.progress && (
            <div className="card">
              <div className="row small">
                <span className="grow">{state.progress.text}</span>
                {state.progress.percent !== null && <strong>{state.progress.percent}%</strong>}
              </div>
              {state.progress.percent !== null && (
                <div className="progress">
                  <div className="progress-bar" style={{ width: `${state.progress.percent}%` }} />
                </div>
              )}
            </div>
          )}
          {done && state.repo && (
            <div className="banner ok">
              <span className="icon">✓</span>
              <div>
                <strong>Repository cloned successfully.</strong> {state.repo.name}
                {state.summary.account ? ` · account ${state.summary.account}` : ''}
                {state.summary.owner ? ` · owner ${state.summary.owner}` : ''} — added to your repository list.
              </div>
            </div>
          )}
          {state.phase === 'cancelled' && (
            <div className="banner info">
              <span className="icon">ℹ</span>
              <div>Clone cancelled.{state.leftoverFolder ? ` An incomplete folder remains at ${state.leftoverFolder}. It is not deleted unless you choose to.` : ''}</div>
            </div>
          )}
          <WorkflowSteps steps={state.steps} onReviewAuth={() => setAuthKey((k) => k + 1)} />
        </>
      )}
      {confirmRemove && state?.leftoverFolder && (
        <ConfirmDialog
          title="Remove Incomplete Clone Folder"
          danger
          explanation={<>Deletes the folder created by this interrupted clone.</>}
          impact={`${state.leftoverFolder} and everything in it will be deleted. It did not exist before this clone started.`}
          affected={[state.leftoverFolder]}
          confirmLabel="Delete folder"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={async () => {
            try {
              setState(await call('clone:removeLeftover', { workflowId: state.workflowId, confirmed: true }));
            } catch (err) {
              setError(toFriendly(err));
            }
            setConfirmRemove(false);
          }}
        />
      )}
    </Modal>
  );
}
