/** Best-effort owner/repo extraction from a remote URL for prefilling forms. */
export function ownerRepoFromUrl(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** "5 seconds ago", "1 day ago", "3 months ago"… */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const units: [string, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60], ['second', 1]];
  for (const [name, secs] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return '0 seconds ago';
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
