import { describe, expect, it } from 'vitest';
import { AppError } from '../src/main/git/errors';
import type { GitHubClient } from '../src/main/github/client/GitHubClient';
import { compareBranches, createPullRequest } from '../src/main/github/services/pullRequests';

const notFound = () => new AppError({ code: 'not-found', title: 'Not Found', message: 'nf' });

/** Fake client: `exists` lists the paths that answer 200. */
function client(exists: string[], createError?: AppError) {
  return {
    get: async (path: string) => {
      if (path.includes('/compare/')) throw notFound();
      if (exists.includes(path)) return {};
      throw notFound();
    },
    rest: async () => {
      throw createError;
    },
  } as unknown as GitHubClient;
}

const r = { owner: 'inride-llc', name: 'ai-agent-management' };
const repo = '/repos/inride-llc/ai-agent-management';

describe('pull request compare diagnosis (GitHub answers a bare 404)', () => {
  it('explains branches with no common history', async () => {
    const res = await compareBranches(client([repo, `${repo}/branches/main`, `${repo}/branches/qa`]), r, 'main', 'qa');
    expect(res.problem?.code).toBe('unrelated');
    expect(res.problem?.message).toMatch(/share no commit history/);
  });

  it('explains a compare branch that was never pushed', async () => {
    const res = await compareBranches(client([repo, `${repo}/branches/main`]), r, 'main', 'qa');
    expect(res.problem?.code).toBe('head-missing');
  });

  it('explains a repository the account cannot see', async () => {
    const res = await compareBranches(client([]), r, 'main', 'qa');
    expect(res.problem?.code).toBe('no-access');
  });

  it('turns "no history in common" on create into a specific error', async () => {
    const err = new AppError({ code: 'validation', title: 'GitHub Rejected the Request', message: 'Validation Failed: The qa branch has no history in common with main' });
    await expect(createPullRequest(client([repo], err), r, { title: 't', body: '', head: 'qa', base: 'main', draft: false })).rejects.toMatchObject({ friendly: { code: 'unrelated-histories' } });
  });
});
