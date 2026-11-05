import type { ApiMap, Channel } from '../../shared/api';
import type { FriendlyError, NotificationFeed, ProgressEvent, Result } from '../../shared/types';

declare global {
  interface Window {
    gitGuardian: {
      invoke(channel: string, payload?: unknown): Promise<unknown>;
      onProgress(callback: (event: unknown) => void): () => void;
      onNotify(callback: (event: unknown) => void): () => void;
    };
  }
}

export class ApiError extends Error {
  constructor(readonly friendly: FriendlyError) {
    super(friendly.message);
    this.name = 'ApiError';
  }
}

type Args<C extends Channel> = ApiMap[C]['req'] extends void ? [] : [ApiMap[C]['req']];

/** Typed wrapper around the single preload bridge function. */
export async function call<C extends Channel>(channel: C, ...args: Args<C>): Promise<ApiMap[C]['res']> {
  const res = (await window.gitGuardian.invoke(channel, args[0])) as Result<ApiMap[C]['res']>;
  if (!res || typeof res !== 'object') {
    throw new ApiError({ code: 'bridge', title: 'Internal Error', message: 'Unexpected response from the application.', reasons: [], actions: [] });
  }
  if (!res.ok) throw new ApiError(res.error);
  return res.data;
}

/** Subscribe to live progress events (clone / create repository). Returns an unsubscribe function. */
export function onProgress(callback: (event: ProgressEvent) => void): () => void {
  return window.gitGuardian.onProgress((e) => callback(e as ProgressEvent));
}

export type NotifyEvent = { type: 'feed'; feed: NotificationFeed } | { type: 'open' };

/** Subscribe to notification feed updates and "open the panel" requests (from a clicked desktop notification). */
export function onNotify(callback: (event: NotifyEvent) => void): () => void {
  return window.gitGuardian.onNotify((e) => {
    const ev = e as NotifyEvent;
    if (ev && (ev.type === 'feed' || ev.type === 'open')) callback(ev);
  });
}

export function toFriendly(err: unknown): FriendlyError {
  if (err instanceof ApiError) return err.friendly;
  return { code: 'unexpected', title: 'Something Went Wrong', message: 'An unexpected error occurred.', reasons: [], actions: ['retry'], technical: err instanceof Error ? err.message : String(err) };
}
