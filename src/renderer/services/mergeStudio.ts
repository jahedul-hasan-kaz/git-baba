/** Lets any screen open the Merge Studio on the Branches tab (it may not be mounted yet). */
let pending = false;
export const MERGE_STUDIO_EVENT = 'gb:open-merge-studio';

export function requestMergeStudio(): void {
  pending = true;
  window.dispatchEvent(new Event(MERGE_STUDIO_EVENT));
}

/** True once per request; the Merge Studio calls this when it mounts or hears the event. */
export function takeMergeStudioRequest(): boolean {
  const p = pending;
  pending = false;
  return p;
}
