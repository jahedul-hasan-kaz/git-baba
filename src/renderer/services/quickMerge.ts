/** Lets any screen open the simple, single-branch merge (one source → one target). */
export const QUICK_MERGE_EVENT = 'gb:quick-merge';

export interface QuickMergeRequest {
  source?: string;
  target?: string;
}

export function requestQuickMerge(req: QuickMergeRequest = {}): void {
  window.dispatchEvent(new CustomEvent<QuickMergeRequest>(QUICK_MERGE_EVENT, { detail: req }));
}
