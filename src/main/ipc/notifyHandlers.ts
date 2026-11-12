import type { ApiMap } from '../../shared/api';
import type { NotificationKind, NotificationPrefs } from '../../shared/types';
import type { AppContext } from '../context';
import { ValidationError } from '../util/validate';

export type NotifyChannels = 'notify:feed' | 'notify:page' | 'notify:markAllRead' | 'notify:clear' | 'notify:refresh' | 'notify:setPrefs';

type Handlers = { [C in NotifyChannels]: (payload: unknown) => Promise<ApiMap[C]['res']> };

/** Notification feed for the active account (the poller itself lives in NotificationCenter). */
export function createNotifyHandlers(ctx: AppContext): Handlers {
  const center = () => {
    if (!ctx.notifications) throw new ValidationError('Notifications are not available');
    return ctx.notifications;
  };
  return {
    'notify:feed': async () => center().feed(),
    'notify:page': async (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
      const offset = num(p.offset, 100_000);
      const limit = num(p.limit, 100);
      if (offset === null || limit === null) throw new ValidationError('Invalid page');
      const kinds = Array.isArray(p.kinds) ? (p.kinds.filter((k) => typeof k === 'string') as NotificationKind[]) : undefined;
      return center().page(kinds, offset, limit);
    },
    'notify:markAllRead': async () => center().markAllRead(),
    'notify:clear': async () => center().clear(),
    'notify:refresh': async () => center().refresh(),
    'notify:setPrefs': async (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const patch: Partial<NotificationPrefs> = {};
      if (p.desktop !== undefined) patch.desktop = p.desktop === true;
      if (p.snoozeUntil !== undefined) {
        if (p.snoozeUntil === null) patch.snoozeUntil = null;
        else if (typeof p.snoozeUntil === 'string' && !Number.isNaN(Date.parse(p.snoozeUntil))) patch.snoozeUntil = new Date(p.snoozeUntil).toISOString();
        else throw new ValidationError('Invalid snooze time');
      }
      return center().setPrefs(patch);
    },
  };
}
