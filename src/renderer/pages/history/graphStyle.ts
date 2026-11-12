export const LANE_COLORS = ['#5b8cff', '#3ecf8e', '#f5b84a', '#ff6b6b', '#b18cff', '#6cc4ff', '#ff9f6b', '#9fd36b'];

const hash = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

/** Stable avatar colour per author (by e-mail when known). */
export const authorColor = (key: string) => `hsl(${hash(key.toLowerCase()) % 360} 55% 48%)`;

/** "Ada Lovelace" → "AL", "octocat" → "OC". */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] ?? '?').slice(0, 2).toUpperCase();
}
