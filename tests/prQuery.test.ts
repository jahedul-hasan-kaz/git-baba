import { describe, expect, it } from 'vitest';
import { effectiveSearch, fromGhJson, matchesQuery } from '../src/main/github/services/pullRequests';
import { ensurePr, getQualifier, scopeToRepo, setQualifier, setState, stateOf, tokenize } from '../src/shared/prQuery';
import type { PrListItem } from '../src/shared/github';

describe('GitHub-style pull request queries', () => {
  it('tokenizes qualifiers, quoted values, negation and free text', () => {
    expect(tokenize('is:pr -label:"good first issue" fix login')).toEqual([
      { key: 'is', value: 'pr', negated: false },
      { key: 'label', value: 'good first issue', negated: true },
      { key: null, value: 'fix', negated: false },
      { key: null, value: 'login', negated: false },
    ]);
  });

  it('sets, replaces and removes qualifiers, keeping free text last', () => {
    expect(setQualifier('is:pr fix', 'author', '@me')).toBe('is:pr author:@me fix');
    expect(setQualifier('is:pr author:a', 'author', 'b')).toBe('is:pr author:b');
    expect(setQualifier('is:pr author:a', 'author', null)).toBe('is:pr');
    expect(setQualifier('is:pr', 'label', 'needs review')).toBe('is:pr label:"needs review"');
    expect(getQualifier('is:pr label:"needs review"', 'label')).toBe('needs review');
  });

  it('switches state the way the tabs do', () => {
    expect(stateOf('is:pr is:open')).toBe('open');
    expect(setState('is:pr is:open author:x', 'merged')).toBe('is:pr author:x is:merged');
    expect(setState('is:pr is:merged', 'all')).toBe('is:pr');
    expect(ensurePr('is:open')).toBe('is:pr is:open');
  });

  it('keeps the search inside the repository', () => {
    expect(scopeToRepo('is:pr repo:evil/other org:x fix')).toBe('is:pr fix');
    expect(effectiveSearch({ owner: 'o', name: 'r' }, { state: 'all', sort: 'best-match', raw: 'is:open repo:x/y bug' })).toBe('repo:o/r is:pr is:open bug');
  });
});

describe('local filtering when search is unavailable', () => {
  const pr = { number: 12, title: 'Fix login bug', author: { login: 'octo', avatarUrl: '' }, labels: [{ name: 'bug', color: 'f00' }], assignees: [], baseRefName: 'main', headRefName: 'fix/login', milestone: null, isDraft: false, reviewDecision: 'APPROVED', checks: 'SUCCESS' } as unknown as PrListItem;
  it('applies the qualifiers it can check and ignores the rest', () => {
    expect(matchesQuery(pr, 'is:pr is:open author:octo label:bug login')).toBe(true);
    expect(matchesQuery(pr, 'author:someone')).toBe(false);
    expect(matchesQuery(pr, '-label:bug')).toBe(false);
    expect(matchesQuery(pr, '-is:open review:approved base:main')).toBe(true);
    expect(matchesQuery(pr, 'created:>2020-01-01')).toBe(true);
    expect(matchesQuery(pr, '#12')).toBe(true);
  });
});

describe('gh pr list mapping', () => {
  it('maps gh JSON into list items', () => {
    const [p] = fromGhJson([
      { number: 5, title: 'T', state: 'OPEN', isDraft: false, author: { login: 'a' }, labels: [{ name: 'x', color: '00ff00' }], comments: [{}, {}], commits: [{}], statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }], baseRefName: 'main', headRefName: 'f', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(p).toMatchObject({ number: 5, comments: 2, commits: 1, checks: 'PENDING', labels: [{ name: 'x' }], author: { login: 'a' } });
  });
});
