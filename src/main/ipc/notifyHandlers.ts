import type { ApiMap } from '../../shared/api';
import type { NotificationPrefs } from '../../shared/types';
import type { AppContext } from '../context';
import { ValidationError } from '../util/validate';

export type NotifyChannels = 'notify:feed' | 'notify:markAllRead' | 'notify:clear' | 'notify:refresh' | 'notify:setPrefs';

type Handlers = { [C in NotifyChannels]: (payload: unknown) => Promise<ApiMap[C]['res']> };

/** Notification feed for the active account (the poller itself lives in NotificationCenter). */
export function createNotifyHandlers(ctx: AppContext): Handlers {
  const center = () => {
    if (!ctx.notifications) throw new ValidationError('Notifications are not available');
    return ctx.notifications;
  };
  return {
    'notify:feed': async () => center().feed(),
    'notify:markAllRead': async () => center().markAllRead(),
    'notify:clear': async () => center().clear(),
    'notify:refresh': async () => center().refresh(),
    'notify:setPrefs': async (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const patch: Partial<NotificationPrefs> = {};
      if (p.desktop !== undefined) patch.desktop = p.desktop === true;
      if (p.includeOwn !== undefined) patch.includeOwn = p.includeOwn === true;
      if (p.snoozeUntil !== undefined) {
        if (p.snoozeUntil === null) patch.snoozeUntil = null;
        else if (typeof p.snoozeUntil === 'string' && !Number.isNaN(Date.parse(p.snoozeUntil))) patch.snoozeUntil = new Date(p.snoozeUntil).toISOString();
        else throw new ValidationError('Invalid snooze time');
      }
      return center().setPrefs(patch);
    },
  };
}
