import type { AppNotification } from '../../shared/types';

/** Text for one OS notification: title, body and (macOS) subtitle. Kept short — OS banners truncate. */
export function desktopText(items: AppNotification[]): { title: string; subtitle?: string; body: string } {
  if (items.length === 1) {
    const n = items[0];
    const who = n.actor ?? (n.kind === 'worktree' ? 'This computer' : 'Someone');
    const num = n.number ? ` #${n.number}` : '';
    return {
      title: `${who} ${n.action}${num}`.slice(0, 120),
      subtitle: n.repo,
      body: [n.subject, n.detail].filter(Boolean).join(' — ').slice(0, 240) + (process.platform === 'darwin' ? '' : `\n${n.repo}`),
    };
  }
  const repos = [...new Set(items.map((n) => n.repo))];
  const lines = items.slice(0, 3).map((n) => `• ${n.actor ?? 'Someone'} ${n.action} ${n.subject}`.slice(0, 90));
  if (items.length > 3) lines.push(`…and ${items.length - 3} more`);
  return {
    title: `${items.length} new updates${repos.length === 1 ? ` in ${repos[0]}` : ` in ${repos.length} repositories`}`,
    subtitle: items[0].accountLogin,
    body: lines.join('\n'),
  };
}
