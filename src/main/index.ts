import { app, BrowserWindow, ipcMain, Menu, Notification, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The app was renamed from "Git Guardian" to "Git Baba", which changes the data folder.
 * On first launch, copy the app's own files (repository list, history, accounts and the
 * opt-in encrypted credentials) from the old folder. The old folder is left untouched.
 */
function migrateLegacyData(userData: string): void {
  const legacy = path.join(app.getPath('appData'), 'Git Guardian');
  if (path.resolve(legacy) === path.resolve(userData)) return;
  if (fs.existsSync(path.join(userData, 'repositories.json')) || !fs.existsSync(path.join(legacy, 'repositories.json'))) return;
  try {
    fs.mkdirSync(userData, { recursive: true });
    for (const name of ['repositories.json', 'history.json', 'accounts.json']) {
      const src = path.join(legacy, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userData, name));
    }
    const secrets = path.join(legacy, 'secrets');
    if (fs.existsSync(secrets)) fs.cpSync(secrets, path.join(userData, 'secrets'), { recursive: true });
  } catch {
    // Migration is best-effort; the app works with an empty profile.
  }
}
import { fileURLToPath } from 'node:url';
import { AccountSecretStore, AccountStore } from './accounts/AccountStore';
import { AppRegistry } from './accounts/AppRegistry';
import { AppContext } from './context';
import { createHandlers } from './ipc/handlers';
import { runGit } from './git/runner';
import { setSshKeygenBinary, sshKeygenBinary } from './git/sshKeys';
import { setGitExecPathForGpg } from './git/gpg';
import { registerIpc } from './ipc/register';
import { HistoryStore } from './repositories/HistoryStore';
import { RepoStore } from './repositories/RepoStore';
import { NotificationCenter, type WatchedRepo } from './notifications/NotificationCenter';
import { desktopText } from './notifications/desktop';
import { repoOwnerAccount } from './accounts/repoAccount';
import { parseRemoteUrl } from './git/remoteUrl';
import type { AppNotification } from '../shared/types';
import { SecretStore, type Encryptor } from './repositories/SecretStore';

const isDev = !app.isPackaged && process.argv.includes('--dev');
const DEV_URL = 'http://127.0.0.1:5173';
const RENDERER_FILE = path.join(__dirname, '..', '..', 'renderer', 'index.html');

let mainWindow: BrowserWindow | null = null;
let ctx: AppContext | null = null;

// Electron's safeStorage uses DPAPI (Windows), Keychain (macOS) or libsecret/kwallet (Linux).
// On Linux without a keyring it falls back to a hard-coded key; we refuse to store secrets then.
const electronEncryptor: Encryptor = {
  isAvailable() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return true;
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data),
};

// Windows and macOS file systems are case-insensitive, and Chromium canonicalises file URLs
// (e.g. "c:\workspace" becomes "file:///C:/Workspace"), so compare paths case-insensitively there.
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (isDev) return u.origin === new URL(DEV_URL).origin;
    return u.protocol === 'file:' && normalizePath(fileURLToPath(u)) === normalizePath(RENDERER_FILE);
  } catch {
    return false;
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || !mainWindow || event.sender !== mainWindow.webContents) return false;
  // Only the top-level app document; never iframes.
  if (frame.parent) return false;
  return isAppUrl(frame.url);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'Git Baba',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      // DevTools are disabled in packaged builds.
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // No navigation away from the app and no new windows; external links go through shell:openExternal.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname === 'docs.github.com' || u.hostname === 'git-scm.com')) {
        void shell.openExternal(u.toString());
      }
    } catch {
      // ignore malformed URLs
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  if (isDev) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadFile(RENDERER_FILE);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Development/testing only: isolate app data (repositories, history) in another folder.
if (!app.isPackaged && process.env.GG_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.GG_USER_DATA_DIR));
}

app.enableSandbox();

// Windows shows toast notifications only for an app with an AppUserModelID (matches build.appId).
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'dev.gitbaba.app' : process.execPath);

/** Brings the window forward and opens the notification panel. */
function openNotifications(): void {
  if (!mainWindow) createWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
  mainWindow?.webContents.send('gg:notify', { type: 'open' });
}

// Keep a reference while shown: a garbage-collected Notification loses its click handler.
const shownNotifications = new Set<Notification>();

function showDesktop(items: AppNotification[]): void {
  if (!Notification.isSupported() || items.length === 0) return;
  // While the app is in front, the bell animates instead of interrupting with a banner.
  if (mainWindow && mainWindow.isFocused() && mainWindow.isVisible()) return;
  const t = desktopText(items);
  const n = new Notification({
    title: t.title,
    subtitle: t.subtitle,
    body: t.body,
    silent: false,
    urgency: items.some((i) => i.tone === 'failure') ? 'critical' : 'normal',
    timeoutType: 'default',
  });
  shownNotifications.add(n);
  const done = () => shownNotifications.delete(n);
  n.on('click', () => {
    openNotifications();
    done();
  });
  n.on('close', done);
  n.show();
  // Draw attention without stealing focus (taskbar flash on Windows/Linux, dock bounce on macOS).
  if (process.platform === 'darwin') app.dock?.bounce('informational');
  else mainWindow?.flashFrame(true);
}

app.whenReady().then(() => {
  // Deny every permission request (camera, notifications, geolocation…).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  if (!isDev) Menu.setApplicationMenu(null);

  const userData = app.getPath('userData');
  migrateLegacyData(userData);
  ctx = new AppContext(
    new RepoStore(path.join(userData, 'repositories.json')),
    new SecretStore(path.join(userData, 'secrets'), electronEncryptor),
    new HistoryStore(path.join(userData, 'history.json')),
    path.join(userData, 'discard-backups'),
    new AccountStore(path.join(userData, 'accounts.json')),
    new AccountSecretStore(path.join(userData, 'secrets', 'accounts'), electronEncryptor),
  );
  // GitHub Apps registered at account level; repositories link to them instead of keeping their own key copy.
  const appRegistry = new AppRegistry(path.join(userData, 'github-apps.json'), path.join(userData, 'secrets', 'apps'), electronEncryptor);
  const repoStore = ctx.repos;
  ctx.appRegistry = appRegistry;
  ctx.secrets.linkedAppKey = (repoId) => {
    const id = repoStore.get(repoId)?.settings.githubApp?.registryId;
    return id ? appRegistry.getKey(id) : null;
  };
  // Live progress for clone / create-repository workflows (one fixed channel, main → renderer only).
  ctx.progress = (event) => mainWindow?.webContents.send('gg:progress', event);
  registerIpc(ipcMain, createHandlers(ctx, () => mainWindow, app.getVersion()), isTrustedSender);
  void runGit({ cwd: userData, args: ['--exec-path'] })
    .then((r) => {
      setSshKeygenBinary(sshKeygenBinary(r.stdout.trim()));
      setGitExecPathForGpg(r.stdout.trim());
    })
    .catch(() => undefined);
  createWindow();
  mainWindow?.on('focus', () => mainWindow?.flashFrame(false));

  // Activity notifications for the active account's repositories.
  const appCtx = ctx;
  const remoteCache = new Map<string, { at: number; url: string | null }>();
  const originOf = async (repoId: string): Promise<string | null> => {
    const hit = remoteCache.get(repoId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.url;
    const remotes = await appCtx.git(repoId).git.remotes().catch(() => []);
    const r = remotes.find((x) => x.name === 'origin') ?? remotes[0];
    const url = r?.pushUrl ?? null;
    remoteCache.set(repoId, { at: Date.now(), url });
    return url;
  };
  const center = new NotificationCenter({
    file: path.join(userData, 'notifications.json'),
    activeAccount: () => {
      const id = appCtx.accounts.activeId();
      const a = id ? appCtx.accounts.get(id) : undefined;
      return a ? { id: a.id, login: a.login } : null;
    },
    client: async (accountId) => {
      const t = await appCtx.sessions.token(accountId).catch(() => null);
      if (!t) return null;
      try {
        return appCtx.sessions.client(accountId).client;
      } catch {
        return null;
      }
    },
    reposFor: async (accountId) => {
      const out: WatchedRepo[] = [];
      for (const repo of appCtx.repos.list()) {
        if (!fs.existsSync(repo.path)) continue;
        const url = await originOf(repo.id);
        if (!url) continue;
        const parsed = parseRemoteUrl(url);
        if (!parsed.isGitHub || !parsed.owner || !parsed.repo) continue;
        if (repoOwnerAccount(appCtx.accounts, repo, parsed)?.id !== accountId) continue;
        // A repository and its worktrees share one GitHub repository: watch it once.
        if (out.some((w) => w.owner.toLowerCase() === parsed.owner!.toLowerCase() && w.name.toLowerCase() === parsed.repo!.toLowerCase())) continue;
        out.push({ repo, accountId, owner: parsed.owner, name: parsed.repo });
      }
      return out;
    },
    worktrees: async (repoPath) => {
      const r = await runGit({ cwd: repoPath, args: ['worktree', 'list', '--porcelain'] }).catch(() => null);
      return r ? r.stdout : null;
    },
    desktop: showDesktop,
    emit: (feed) => {
      mainWindow?.webContents.send('gg:notify', { type: 'feed', feed });
      // Unread count on the dock (macOS) / launcher (Linux Unity).
      if (process.platform !== 'win32') app.setBadgeCount(feed.unread);
    },
    desktopSupported: Notification.isSupported(),
  });
  appCtx.notifications = center;
  center.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('before-quit', () => {
  // Drop (and revoke) any in-memory tokens and keys.
  ctx?.notifications?.stop();
  ctx?.vault.clear();
  ctx?.sessions.endAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
