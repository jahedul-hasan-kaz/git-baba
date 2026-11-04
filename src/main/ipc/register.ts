import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { CHANNEL_PATTERN } from '../../shared/api';
import type { Result } from '../../shared/types';
import { toFriendlyError } from '../git/errors';
import type { Handlers } from './handlers';

const OPERATION_NAMES: Record<string, string> = {
  'push:execute': 'Push',
  'push:prepare': 'Push',
  'commit:execute': 'Commit',
  'commit:prepare': 'Commit',
  'pull:prepare': 'Pull',
  'pull:execute': 'Pull',
  'git:fetch': 'Fetch',
  'repo:clone': 'Clone',
  'repo:create': 'Create repository',
  'pr:create': 'Create pull request',
  'pr:prepare': 'Pull request',
  'conflict:continue': 'Continue',
  'conflict:abort': 'Abort',
};

function operationName(channel: string): string {
  if (OPERATION_NAMES[channel]) return OPERATION_NAMES[channel];
  const action = channel.split(':')[1] ?? channel;
  return action.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Registers every handler behind a uniform guard: only the app's own window may
 * call, payloads go through per-handler validation, and errors are converted to
 * friendly, redacted messages — stack traces never cross the bridge.
 */
export function registerIpc(ipcMain: IpcMain, handlers: Handlers, isTrustedSender: (e: IpcMainInvokeEvent) => boolean): void {
  for (const [channel, handler] of Object.entries(handlers) as [string, (p: unknown) => Promise<unknown>][]) {
    if (!CHANNEL_PATTERN.test(channel)) throw new Error(`Invalid channel name ${channel}`);
    ipcMain.handle(channel, async (event, payload: unknown): Promise<Result<unknown>> => {
      if (!isTrustedSender(event)) {
        return { ok: false, error: { code: 'forbidden', title: 'Request Blocked', message: 'This request did not come from the application window.', reasons: [], actions: [] } };
      }
      try {
        const data = await handler(payload);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toFriendlyError(err, operationName(channel)) };
      }
    });
  }
}
