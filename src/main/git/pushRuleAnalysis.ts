import type { PushRuleReport, PushRuleViolation } from '../../shared/types';
import type { GitService } from './GitService';

/** Base of the rejected push: the remote branch, or the commit before the oldest unpushed one. */
async function rangeOf(git: GitService, head: string, remote: string) {
  const commits = await git.unpushedCommits(head, remote);
  const base = commits.length ? (commits[0].parents[0] ?? null) : head;
  return { commits, base };
}

const FILE_RULES = new Set(['file-size', 'file-extension', 'file-path', 'path-length', 'secret']);

/** Finds the files/commits a rule is about when GitHub did not list them, using local data only. */
export async function analyzeReport(git: GitService, report: PushRuleReport, ctx: { branch: string; remote: string; remoteBranch: string; head: string; canRewrite: boolean }): Promise<PushRuleReport> {
  const { commits, base } = await rangeOf(git, ctx.head, ctx.remote);
  const metas = await Promise.all(commits.slice(-200).map(async (c) => ({ c, m: await git.commitMeta(c.hash) })));
  const changed = await git.changedPathsWithSize(base, ctx.head);
  const changedSet = new Set(changed.map((f) => f.path));

  const violations: PushRuleViolation[] = report.violations.map((v) => {
    const out = { ...v, files: [...v.files], commits: [...v.commits] };
    if (FILE_RULES.has(v.id) && out.files.length === 0) {
      if (v.id === 'file-size') {
        const limitMb = Number(/([\d.]+)\s*MB/i.exec(v.githubMessage)?.[1] ?? 100);
        out.files = changed.filter((f) => f.size !== null && f.size > limitMb * 1024 * 1024).map((f) => ({ path: f.path, commit: null, line: null, sizeMb: Math.round((f.size! / 1024 / 1024) * 10) / 10 }));
      } else if (v.id === 'file-extension') {
        const exts = [...new Set(v.githubMessage.match(/\.[A-Za-z0-9]{1,10}\b/g) ?? [])].map((e) => e.toLowerCase());
        out.files = changed.filter((f) => exts.some((e) => f.path.toLowerCase().endsWith(e))).map((f) => ({ path: f.path, commit: null, line: null, sizeMb: null }));
      } else if (v.id === 'path-length') {
        const max = Number(/(\d{2,4})/.exec(v.githubMessage)?.[1] ?? 0);
        if (max) out.files = changed.filter((f) => f.path.length > max).map((f) => ({ path: f.path, commit: null, line: null, sizeMb: null }));
      } else if (v.id === 'file-path') {
        const patterns = [...v.githubMessage.matchAll(/[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]).filter((s) => s.includes('/') || s.includes('*') || s.includes('.'));
        const toRe = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*')}`);
        out.files = changed.filter((f) => patterns.some((pt) => toRe(pt).test(f.path))).map((f) => ({ path: f.path, commit: null, line: null, sizeMb: null }));
      }
    }
    // Only files actually changed by the unpushed commits can be removed from them.
    out.files = out.files.filter((f) => changedSet.has(f.path) || f.commit !== null);
    if (v.id === 'linear-history' && !out.commits.length) out.commits = metas.filter((x) => x.c.parents.length > 1).map((x) => x.c.hash);
    if (v.id === 'signatures' && !out.commits.length) out.commits = metas.filter((x) => !x.m.signed).map((x) => x.c.hash);
    if ((v.id === 'commit-message' || v.id === 'email-pattern') && !out.commits.length) out.commits = metas.map((x) => x.c.hash);
    return out;
  });

  return {
    ...report,
    violations,
    branch: ctx.branch,
    remote: ctx.remote,
    remoteBranch: ctx.remoteBranch,
    canRewrite: ctx.canRewrite,
    commits: metas.map(({ c, m }) => ({ hash: c.hash, shortHash: c.hash.slice(0, 8), subject: m.subject, author: m.authorName, email: m.authorEmail, isMerge: c.parents.length > 1 })),
  };
}

/**
 * Re-validates what can be checked locally after a fix. GitHub stays authoritative —
 * anything that depends on GitHub (reviews, checks, permissions) is reported as remote-only.
 */
export async function recheckReport(git: GitService, report: PushRuleReport, head: string): Promise<PushRuleReport> {
  const { commits, base } = await rangeOf(git, head, report.remote);
  const changed = new Set((await git.changedPathsWithSize(base, head)).map((f) => f.path));
  const metas = await Promise.all(commits.map(async (c) => ({ c, m: await git.commitMeta(c.hash) })));
  const violations = report.violations.map((v): PushRuleViolation => {
    if (FILE_RULES.has(v.id) && v.files.length) {
      const still = v.files.filter((f) => changed.has(f.path));
      return { ...v, status: still.length ? 'still-present' : 'resolved' };
    }
    if (v.id === 'linear-history') return { ...v, status: metas.some((x) => x.c.parents.length > 1) ? 'still-present' : 'resolved' };
    if (v.id === 'signatures') return { ...v, status: metas.some((x) => !x.m.signed) ? 'still-present' : 'resolved' };
    return { ...v, status: 'remote-only' };
  });
  return { ...report, violations };
}
