import type { PrDetails } from '../../../../shared/github';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'merged' | 'closed';

/** One-line answer to "can this be merged, and if not, why?" from GitHub's merge state. */
export function mergeVerdict(pr: PrDetails): { tone: Tone; icon: string; title: string; detail: string } {
  if (pr.state === 'MERGED') return { tone: 'merged', icon: '⇋', title: 'Merged', detail: `${pr.mergedBy ?? 'Someone'} merged this pull request` };
  if (pr.state === 'CLOSED') return { tone: 'closed', icon: '⊘', title: 'Closed without merging', detail: 'Reopen it to continue.' };
  if (pr.isDraft) return { tone: 'info', icon: '✎', title: 'Draft', detail: 'Mark it ready for review before merging.' };
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { tone: 'danger', icon: '✕', title: 'Conflicts', detail: `This branch has conflicts with ${pr.baseRefName} that must be resolved.` };
  const s = pr.checksSummary;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { tone: 'danger', icon: '✕', title: 'Changes requested', detail: 'A reviewer asked for changes before this can merge.' };
  if (s.failed) return { tone: 'danger', icon: '✕', title: `${s.failed} check${s.failed === 1 ? '' : 's'} failing`, detail: 'Fix the failing checks, or merge anyway if the rules allow it.' };
  switch (pr.mergeStateStatus) {
    case 'CLEAN':
      return { tone: 'ok', icon: '✓', title: 'Ready to merge', detail: 'All rules are satisfied.' };
    case 'HAS_HOOKS':
      return { tone: 'ok', icon: '✓', title: 'Ready to merge', detail: 'Rules are satisfied; merge hooks will run.' };
    case 'UNSTABLE':
      return { tone: 'warn', icon: '!', title: 'Mergeable with warnings', detail: 'Some non-required checks did not pass.' };
    case 'BEHIND':
      return { tone: 'warn', icon: '↓', title: `Behind ${pr.baseRefName}`, detail: 'The base branch has new commits; update this branch first.' };
    case 'BLOCKED':
      return {
        tone: 'warn',
        icon: '⛔',
        title: 'Blocked by branch rules',
        detail: pr.reviewDecision === 'REVIEW_REQUIRED' ? 'An approving review is required.' : s.pending ? 'Waiting for required checks.' : 'A branch protection rule is not satisfied yet.',
      };
    default:
      return { tone: 'info', icon: '●', title: s.pending ? 'Checks running' : 'Checking mergeability…', detail: 'GitHub is still working this out.' };
  }
}
