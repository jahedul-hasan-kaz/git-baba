import { useEffect, useState } from 'react';
import type { PrDetails } from '../../../../shared/github';

/**
 * "Merge only approved pull requests": a per-repository switch, kept in this computer's settings.
 * When on, Git Baba refuses to merge a pull request until a reviewer has approved it, even where
 * GitHub's own branch rules would allow it.
 */
const key = (repo: string) => `gb.pr.approvedOnly.${repo}`;
const EVENT = 'gb-approved-only';

function read(repo: string): boolean {
  try {
    return localStorage.getItem(key(repo)) === '1';
  } catch {
    return false;
  }
}

export function useApprovedOnly(repo: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => read(repo));
  useEffect(() => {
    setOn(read(repo));
    const sync = () => setOn(read(repo));
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, [repo]);
  const set = (v: boolean) => {
    try {
      localStorage.setItem(key(repo), v ? '1' : '0');
    } catch {
      /* setting is a convenience */
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return [on, set];
}

/** True when the switch is on and this pull request has no approval yet. */
export const awaitsApproval = (on: boolean, pr: PrDetails) => on && pr.state === 'OPEN' && pr.reviewDecision !== 'APPROVED';
