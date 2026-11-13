/**
 * Hand-off from global search to the page that shows the result. The target page may not be mounted
 * yet (the tab switches first), so the request is kept until that page picks it up.
 */
export type Jump = { kind: 'commit'; repoId: string; hash: string } | { kind: 'file'; repoId: string; ref: string; path: string; line: number | null };

export const JUMP_EVENT = 'gb:jump';
let pending: Jump | null = null;

export function requestJump(j: Jump) {
  pending = j;
  window.dispatchEvent(new Event(JUMP_EVENT));
}

/** Takes the pending request of this kind for this repository, if any. */
export function takeJump<K extends Jump['kind']>(kind: K, repoId: string): Extract<Jump, { kind: K }> | null {
  if (!pending || pending.kind !== kind || pending.repoId !== repoId) return null;
  const j = pending as Extract<Jump, { kind: K }>;
  pending = null;
  return j;
}

/** The history list tells the tab bar whether a search filter is on, so it can offer "Clear search". */
export const FILTER_EVENT = 'gb:history-filter';
export const CLEAR_EVENT = 'gb:history-clear';
export function announceFilter(active: boolean) {
  window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: active }));
}
export function requestClearFilter() {
  window.dispatchEvent(new Event(CLEAR_EVENT));
}
