import type { RepoStatus } from './types';

/**
 * Whether the current branch exists on the remote under its own name, which is where Push sends it.
 * Not published: no upstream, an upstream that is gone (clone of an empty repository, deleted on the
 * remote), or an upstream with another name (a branch started from origin/main).
 */
export function isPublished(st: Pick<RepoStatus, 'branch' | 'upstream' | 'upstreamGone'> | null | undefined): boolean {
  if (!st?.branch || !st.upstream || st.upstreamGone) return false;
  return st.upstream.endsWith(`/${st.branch}`);
}
