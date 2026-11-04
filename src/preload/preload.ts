// Preload runs in a sandboxed renderer: only `electron`'s contextBridge and
// ipcRenderer are available, and only a single, narrow function is exposed.
// The renderer gets no Node.js APIs, no ipcRenderer object and no way to
// listen on arbitrary channels.
import { contextBridge, ipcRenderer } from 'electron';

// Kept in sync with CHANNEL_PATTERN in src/shared/api.ts (a sandboxed preload cannot import local modules).
const CHANNEL_PATTERN = /^(app|dialog|repo|git|commit|push|pull|conflict|pr|github|ssh|history|shell|accounts|create|clone|graph|session|gh|code):[A-Za-z]+$/;

contextBridge.exposeInMainWorld('gitGuardian', {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) {
      return Promise.reject(new Error('Blocked IPC channel'));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  /**
   * Subscribe to live progress of long operations (clone, create repository). Only this one
   * fixed channel can be observed, and only the payload — never the IPC event — is passed on.
   */
  onProgress(callback: (event: unknown) => void): () => void {
    if (typeof callback !== 'function') return () => undefined;
    const handler = (_e: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on('gg:progress', handler);
    return () => ipcRenderer.removeListener('gg:progress', handler);
  },
});
