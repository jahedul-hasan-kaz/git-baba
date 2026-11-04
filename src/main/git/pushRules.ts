import type { PushRuleId, PushRuleReport, PushRuleViolation } from '../../shared/types';

/**
 * Turns GitHub's push rejection output (GH013 rulesets / push protection, GH006 branch
 * protection, GH001 large files) into structured, explainable violations. Pure function —
 * it only reads the text Git printed; local analysis is added by the caller.
 */

const SHA = /\b[0-9a-f]{40}\b/g;
/** Non-global twin for .test() (a global regex keeps lastIndex between calls). */
const HAS_SHA = /\b[0-9a-f]{40}\b/;

interface CatalogEntry {
  title: string;
  explanation: string;
  needed: string;
  fixes: PushRuleViolation['fixes'];
  locallyFixable: boolean;
  who: string | null;
}

const ADMIN = 'A repository administrator (Settings → Rules → Rulesets, or Settings → Branches) — or an organisation owner for organisation rulesets.';

export const RULE_CATALOG: Record<PushRuleId, CatalogEntry> = {
  secret: {
    title: 'A secret was found in your commits (push protection)',
    explanation: 'GitHub scanned the commits you are pushing and found something that looks like a password, token or key. Pushing it would expose it to everyone who can read the repository.',
    needed: 'Remove the secret from every unpushed commit that contains it (editing the file in a new commit is not enough — it stays in history). Then rotate the secret if it was real.',
    fixes: ['drop-file', 'unblock-secret'],
    locallyFixable: true,
    who: 'If it is a false positive or a test value, someone allowed to bypass push protection can allow it through the link GitHub provided.',
  },
  'file-size': {
    title: 'A file is too large',
    explanation: 'The push contains a file larger than the limit allowed by GitHub or by a repository rule.',
    needed: 'Remove the large file from the unpushed commits (store it with Git LFS or outside the repository instead).',
    fixes: ['drop-file'],
    locallyFixable: true,
    who: null,
  },
  'file-path': {
    title: 'A restricted file path was changed',
    explanation: 'A repository rule forbids pushing changes to certain paths (for example workflow files, secrets folders or generated files).',
    needed: 'Remove the changes to the restricted path(s) from the unpushed commits, or ask an administrator to change the rule.',
    fixes: ['drop-file', 'admin'],
    locallyFixable: true,
    who: ADMIN,
  },
  'file-extension': {
    title: 'A restricted file type was added',
    explanation: 'A repository rule forbids files with certain extensions (for example executables or archives).',
    needed: 'Remove those files from the unpushed commits.',
    fixes: ['drop-file', 'admin'],
    locallyFixable: true,
    who: ADMIN,
  },
  'path-length': {
    title: 'A file path is too long',
    explanation: 'A repository rule limits how long file paths may be.',
    needed: 'Rename or move the file to a shorter path, or remove it from the unpushed commits.',
    fixes: ['drop-file'],
    locallyFixable: true,
    who: null,
  },
  'pull-request': {
    title: 'Changes must go through a pull request',
    explanation: 'This branch does not accept direct pushes. Every change has to be proposed in a pull request and merged there.',
    needed: 'Push your commits to a new branch and open a pull request into this branch.',
    fixes: ['push-to-branch', 'admin'],
    locallyFixable: false,
    who: ADMIN,
  },
  'status-checks': {
    title: 'Required status checks must pass first',
    explanation: 'This branch only accepts commits whose required checks (CI) have passed — which can only happen on a pull request or another branch.',
    needed: 'Push to a new branch, let the checks run, and merge through a pull request.',
    fixes: ['push-to-branch', 'admin'],
    locallyFixable: false,
    who: ADMIN,
  },
  reviews: {
    title: 'An approving review is required',
    explanation: 'This branch requires approval from reviewers before changes land.',
    needed: 'Open a pull request from a new branch and get the required approvals.',
    fixes: ['push-to-branch', 'admin'],
    locallyFixable: false,
    who: ADMIN,
  },
  signatures: {
    title: 'Commits must have verified signatures',
    explanation: 'Every commit pushed to this branch must be signed (GPG, SSH or S/MIME) with a key GitHub can verify.',
    needed: 'Recreate the listed unpushed commits signed (Commit → GPG) with a key added to your GitHub account, or push to another branch.',
    fixes: ['sign-commits', 'push-to-branch'],
    locallyFixable: false,
    who: 'Add your signing key in GitHub → Settings → SSH and GPG keys. An administrator can relax the rule.',
  },
  'linear-history': {
    title: 'Merge commits are not allowed (linear history)',
    explanation: 'This branch requires a straight line of commits. Your push contains merge commits.',
    needed: 'Rebase your commits onto the remote branch instead of merging, or merge through a pull request with squash/rebase.',
    fixes: ['rebase', 'push-to-branch'],
    locallyFixable: false,
    who: ADMIN,
  },
  'non-fast-forward': {
    title: 'Force pushes / history rewrites are blocked',
    explanation: 'The remote branch has commits you do not have, and this branch forbids overwriting history.',
    needed: 'Pull (Review) the latest changes first, then push again.',
    fixes: ['pull-first'],
    locallyFixable: false,
    who: null,
  },
  'restricted-ref': {
    title: 'You may not update this branch',
    explanation: 'Only specific people, teams or apps may create, update or delete this branch.',
    needed: 'Push to a different branch and open a pull request, or ask to be added to the allowed list.',
    fixes: ['push-to-branch', 'admin'],
    locallyFixable: false,
    who: ADMIN,
  },
  'commit-message': {
    title: 'A commit message does not match the required pattern',
    explanation: 'A rule requires commit messages in a specific format (for example a ticket number or conventional prefix).',
    needed: 'Recreate the listed commits with compliant messages (or ask an administrator about the pattern).',
    fixes: ['reword', 'admin'],
    locallyFixable: false,
    who: ADMIN,
  },
  'email-pattern': {
    title: 'An author / committer email is not allowed',
    explanation: 'A rule only accepts commits from specific email addresses or domains.',
    needed: 'Set your Git identity to an allowed email (Settings tab) and recreate the listed commits.',
    fixes: ['reword', 'admin'],
    locallyFixable: false,
    who: ADMIN,
  },
  'ref-name': {
    title: 'The branch name is not allowed',
    explanation: 'A rule only accepts branch names matching a pattern.',
    needed: 'Push to a branch whose name follows the required pattern.',
    fixes: ['push-to-branch', 'admin'],
    locallyFixable: false,
    who: ADMIN,
  },
  'code-scanning': {
    title: 'Code scanning results block this push',
    explanation: 'A rule requires code scanning to pass for this branch.',
    needed: 'Push to a new branch, fix the reported alerts and merge through a pull request.',
    fixes: ['push-to-branch'],
    locallyFixable: false,
    who: ADMIN,
  },
  deployments: {
    title: 'A successful deployment is required',
    explanation: 'A rule requires changes to be deployed to an environment before they reach this branch.',
    needed: 'Merge through a pull request after the deployment succeeds.',
    fixes: ['push-to-branch'],
    locallyFixable: false,
    who: ADMIN,
  },
  workflows: {
    title: 'Required workflows must pass',
    explanation: 'A rule requires specific GitHub Actions workflows to succeed for this branch.',
    needed: 'Push to a new branch and merge through a pull request once the workflows pass.',
    fixes: ['push-to-branch'],
    locallyFixable: false,
    who: ADMIN,
  },
  unknown: {
    title: 'A repository rule blocked the push',
    explanation: 'GitHub rejected the push because of a rule Git Baba does not recognise. GitHub’s exact message is shown below.',
    needed: 'Read GitHub’s message; usually pushing to a new branch and opening a pull request works.',
    fixes: ['push-to-branch', 'admin'],
    locallyFixable: false,
    who: ADMIN,
  },
};

const CLASSIFY: [RegExp, PushRuleId][] = [
  [/secret/i, 'secret'],
  [/pull request/i, 'pull-request'],
  [/status check/i, 'status-checks'],
  [/approving review|review(s)? (is|are) required|code owner/i, 'reviews'],
  [/verified signature|must be signed/i, 'signatures'],
  [/merge commit|linear history/i, 'linear-history'],
  [/force.?push|non-fast-forward|cannot rewrite history/i, 'non-fast-forward'],
  [/path length|path.*too long/i, 'path-length'],
  [/file extension/i, 'file-extension'],
  [/file size|too large|exceeds.*limit/i, 'file-size'],
  [/file path|restricted (file|path)|path is restricted/i, 'file-path'],
  [/commit message/i, 'commit-message'],
  [/(author|committer).*e-?mail/i, 'email-pattern'],
  [/(branch|tag|ref) name/i, 'ref-name'],
  [/code scanning|code quality/i, 'code-scanning'],
  [/deployment/i, 'deployments'],
  [/workflow/i, 'workflows'],
  [/cannot (update|create|delete)|restrict(ed)? (creations?|updates?|deletions?)|protected ref|not allowed to (push|update)/i, 'restricted-ref'],
];

export function classifyRule(text: string): PushRuleId {
  return CLASSIFY.find(([re]) => re.test(text))?.[1] ?? 'unknown';
}

function cleanLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^remote:\s?/, '').replace(/\s+$/, ''))
    .map((l) => l.replace(/^error:\s*/, ''));
}

function violation(id: PushRuleId, message: string, extra: Partial<PushRuleViolation> = {}): PushRuleViolation {
  const c = RULE_CATALOG[id];
  return {
    id,
    title: c.title,
    githubMessage: message,
    explanation: c.explanation,
    needed: c.needed,
    fixes: c.fixes,
    locallyFixable: c.locallyFixable,
    whoCanFix: c.who,
    files: [],
    commits: [],
    checks: [],
    unblockUrl: null,
    status: 'unchecked',
    ...extra,
  };
}

/** Pulls file references from detail lines: "path: a/b.txt:12", "<sha>: a/b.txt", "- a/b.txt". */
function filesFrom(lines: string[]): PushRuleViolation['files'] {
  const files: PushRuleViolation['files'] = [];
  let commit: string | null = null;
  for (const l of lines) {
    const c = /commit:\s*([0-9a-f]{40})/.exec(l);
    if (c) commit = c[1];
    const p = /path:\s*(\S+?)(?::(\d+))?$/.exec(l.trim());
    if (p) {
      files.push({ path: p[1], commit, line: p[2] ? Number(p[2]) : null, sizeMb: null });
      continue;
    }
    const shaPath = /^([0-9a-f]{40}):\s*(\S.*)$/.exec(l.trim());
    if (shaPath) files.push({ path: shaPath[2].trim(), commit: shaPath[1], line: null, sizeMb: null });
  }
  const seen = new Set<string>();
  return files.filter((f) => {
    const k = `${f.path}|${f.commit}|${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function parsePushRejection(raw: string): PushRuleReport | null {
  const text = raw ?? '';
  const isRules = /GH013|repository rule violations|push declined due to repository rule/i.test(text);
  const isProtected = /GH006|protected branch hook declined|protected branch update failed/i.test(text);
  const isLarge = /GH001|exceeds GitHub's file size limit/i.test(text);
  const isSecret = /push protection|push cannot contain secrets/i.test(text);
  if (!isRules && !isProtected && !isLarge && !isSecret) return null;

  const lines = cleanLines(text);
  const ref = /for (refs\/heads\/[^\s.]+(?:\.[^\s.]+)*)/.exec(text)?.[1] ?? null;
  const rulesUrl = /(https?:\/\/\S+\/rules\S*)/.exec(text)?.[1] ?? null;
  const violations: PushRuleViolation[] = [];

  // --- GH001: large files ---
  const large = [...text.matchAll(/File (.+?) is ([\d.]+) MB; this exceeds GitHub's file size limit of ([\d.]+) MB/g)];
  if (large.length) {
    violations.push(
      violation('file-size', large.map((m) => m[0]).join('\n'), {
        files: large.map((m) => ({ path: m[1].trim(), commit: null, line: null, sizeMb: Number(m[2]) })),
        title: `File larger than GitHub's ${large[0][3]} MB limit`,
      }),
    );
  }

  // --- Push protection (secrets) ---
  if (isSecret) {
    const start = lines.findIndex((l) => /push protection/i.test(l));
    const block = start >= 0 ? lines.slice(start) : lines;
    const types = [...block.join('\n').matchAll(/—{1,}\s*([^—\n]+?)\s*—{2,}/g)].map((m) => m[1].trim()).filter((t) => !/resolve the following/i.test(t));
    const unblock = /(https?:\/\/\S+\/secret-scanning\/unblock-secret\/\S+)/.exec(text)?.[1] ?? null;
    violations.push(
      violation('secret', (block.find((l) => /push cannot contain secrets/i.test(l)) ?? 'Push cannot contain secrets').replace(/^\s*-\s*/, '').trim(), {
        files: filesFrom(block),
        commits: [...new Set(block.join('\n').match(SHA) ?? [])],
        unblockUrl: unblock,
        title: types.length ? `Secret detected: ${[...new Set(types)].join(', ')}` : RULE_CATALOG.secret.title,
      }),
    );
  }

  // --- Ruleset bullets ("- Changes must be made through a pull request.") ---
  if (isRules) {
    const secretStart = lines.findIndex((l) => /push protection/i.test(l));
    const ruleLines = secretStart >= 0 ? lines.slice(0, secretStart) : lines;
    let current: { head: string; detail: string[] } | null = null;
    const flush = () => {
      if (!current) return;
      const id = classifyRule(current.head);
      if (id === 'secret' && violations.some((v) => v.id === 'secret')) {
        current = null;
        return;
      }
      const detail = current.detail;
      violations.push(
        violation(id, [current.head, ...detail.filter((d) => d.trim() && !HAS_SHA.test(d) && !/^\s*(path:|commit:)/.test(d))].join(' ').replace(/\s+/g, ' ').trim(), {
          files: filesFrom(detail),
          commits: [...new Set(detail.join('\n').match(SHA) ?? [])],
          checks: [...current.head.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
        }),
      );
      current = null;
    };
    for (const l of ruleLines) {
      const bullet = /^\s{0,2}-\s+(.+)$/.exec(l);
      if (bullet && !/^\s*-\s*[0-9a-f]{40}/.test(l)) {
        flush();
        current = { head: bullet[1].trim(), detail: [] };
      } else if (current) current.detail.push(l);
    }
    flush();
  }

  // --- GH006: classic branch protection ("error: Changes must be made through a pull request.") ---
  if (isProtected) {
    const msgs = lines.filter((l) => l.trim() && !/GH006|protected branch|^To |^!|^Done$|^\s*$/i.test(l) && !/^https?:/.test(l.trim()) && l.length < 300);
    const found = new Set(violations.map((v) => v.id));
    for (const m of msgs) {
      const id = classifyRule(m);
      if (id === 'unknown' || found.has(id)) continue;
      found.add(id);
      violations.push(violation(id, m.trim(), { checks: [...m.matchAll(/"([^"]+)"/g)].map((x) => x[1]) }));
    }
    if (!violations.length) violations.push(violation('restricted-ref', 'Protected branch update failed'));
  }

  if (!violations.length) violations.push(violation('unknown', lines.filter((l) => l.trim()).slice(0, 6).join(' ')));

  return {
    kind: isSecret && !isRules ? 'push-protection' : isLarge && !isRules ? 'file-size' : isProtected && !isRules ? 'branch-protection' : 'ruleset',
    ref,
    rulesUrl,
    violations,
    raw: lines.filter((l) => l.trim()).slice(0, 80),
    commits: [],
    branch: '',
    remote: '',
    remoteBranch: '',
    canRewrite: false,
  };
}
