import type { FileDiff, SecurityFinding, SecurityReport, Severity } from '../../shared/types';
import type { GitService } from '../git/GitService';
import { redactSecrets } from '../util/redact';
import { CONTENT_RULES, LOCK_OR_MIN, PATH_RULES } from './rules';

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };
const MAX_EXCERPT = 160;
const LONG_LINE = 1500;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?)$/i;

export const DISCLAIMER =
  'This is an automated, pattern-based review. It can miss malicious code and can flag harmless code. ' +
  'It does not guarantee that the incoming changes are safe — review them yourself before continuing.';

function excerpt(line: string): string {
  const trimmed = line.trim();
  const short = trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT)}…` : trimmed;
  // Incoming code might contain real secrets; never echo them back in full.
  return redactSecrets(short);
}

class FindingCollector {
  private readonly map = new Map<string, SecurityFinding>();

  add(f: Omit<SecurityFinding, 'occurrences'>): void {
    const key = `${f.file}\0${f.ruleId}`;
    const existing = this.map.get(key);
    if (existing) {
      existing.occurrences++;
      return;
    }
    this.map.set(key, { ...f, occurrences: 1 });
  }

  list(): SecurityFinding[] {
    return [...this.map.values()];
  }
}

export class SecurityScanner {
  /** Path-based checks (file type, location, permission changes). */
  scanPath(diff: Pick<FileDiff, 'newPath' | 'oldPath' | 'status' | 'binary' | 'oldMode' | 'newMode'>): SecurityFinding[] {
    const c = new FindingCollector();
    const p = diff.status === 'deleted' ? diff.oldPath : diff.newPath;

    for (const rule of PATH_RULES) {
      if (rule.pattern.test(p)) {
        c.add({ file: p, ruleId: rule.id, severity: rule.severity, title: rule.title, reason: `${rule.reason}${diff.status === 'deleted' ? ' (file deleted)' : ''}` });
      }
    }
    if (diff.status === 'renamed' && diff.oldPath !== diff.newPath) {
      for (const rule of PATH_RULES) {
        if (rule.pattern.test(diff.oldPath) && !rule.pattern.test(diff.newPath)) {
          c.add({ file: p, ruleId: `${rule.id}-renamed-away`, severity: 'medium', title: `${rule.title} (renamed)`, reason: `Renamed from ${diff.oldPath}.` });
        }
      }
    }
    if (diff.newMode === '100755' && diff.oldMode !== '100755') {
      c.add({ file: p, ruleId: 'became-executable', severity: 'medium', title: 'File marked executable', reason: 'The file gained the executable permission bit.' });
    }
    if (diff.newMode === '120000') {
      c.add({ file: p, ruleId: 'symlink', severity: 'medium', title: 'Symbolic link', reason: 'Symlinks can point outside the repository (e.g. to your home directory).' });
    }
    if (diff.newMode === '160000') {
      c.add({ file: p, ruleId: 'submodule', severity: 'medium', title: 'Submodule commit changed', reason: 'The pinned commit of a submodule changed; its contents are not shown here.' });
    }
    if (diff.binary && diff.status !== 'deleted' && !PATH_RULES.some((r) => r.id === 'executable-binary' && r.pattern.test(p))) {
      const isImage = IMAGE.test(p);
      c.add({
        file: p,
        ruleId: 'binary-file',
        severity: isImage ? 'info' : 'medium',
        title: isImage ? 'Binary image' : 'Binary file',
        reason: isImage ? 'Image content cannot be reviewed as text.' : 'Binary content cannot be reviewed as source code.',
      });
    }
    return c.list();
  }

  /** Content-based checks on lines that would be added to your working tree. */
  scanLines(file: string, lines: { content: string; line?: number }[]): SecurityFinding[] {
    const c = new FindingCollector();
    const skipLongLine = LOCK_OR_MIN.test(file) || /\.(svg|json|csv|tsv|snap|lock|txt|md|pem)$/i.test(file);
    for (const { content, line } of lines) {
      for (const rule of CONTENT_RULES) {
        if (rule.onlyPaths && !rule.onlyPaths.test(file)) continue;
        if (rule.skipPaths && rule.skipPaths.test(file)) continue;
        if (!rule.pattern.test(content)) continue;
        if (rule.alsoRequires && !rule.alsoRequires.test(content)) continue;
        c.add({ file, ruleId: rule.id, severity: rule.severity, title: rule.title, reason: rule.reason, line, excerpt: excerpt(content) });
      }
      if (!skipLongLine && content.length > LONG_LINE) {
        c.add({
          file,
          ruleId: 'very-long-line',
          severity: 'medium',
          title: 'Very long line (minified or obfuscated)',
          reason: `A ${content.length}-character line cannot be meaningfully reviewed.`,
          line,
        });
      }
    }
    return c.list();
  }

  /** Scan one file's full content (e.g. a new untracked file). */
  scanFile(file: string, content: string): SecurityFinding[] {
    return [
      ...this.scanPath({ newPath: file, oldPath: file, status: 'added', binary: false }),
      ...this.scanLines(
        file,
        content.split('\n').map((l, i) => ({ content: l, line: i + 1 })),
      ),
    ];
  }

  /** Scan a parsed diff: only added lines matter, since they are what arrives on your machine. */
  scanDiff(diff: FileDiff): SecurityFinding[] {
    const p = diff.status === 'deleted' ? diff.oldPath : diff.newPath;
    const added = diff.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => ({ content: l.content, line: l.newLine })));
    const findings = [...this.scanPath(diff), ...this.scanLines(p, added)];
    if (diff.truncated) {
      findings.push({
        file: p,
        ruleId: 'partially-scanned',
        severity: 'medium',
        title: 'File only partially scanned',
        reason: 'The change is too large to scan completely. Review it manually.',
        occurrences: 1,
      });
    }
    return findings;
  }

  generateSecurityReport(findings: SecurityFinding[], scannedFiles: number, partial = false): SecurityReport {
    const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.file.localeCompare(b.file));
    const max = sorted.reduce<Severity>((m, f) => (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[m] ? f.severity : m), 'info');
    const status = max === 'high' ? 'REVIEW_REQUIRED' : max === 'medium' || partial ? 'REVIEW_RECOMMENDED' : 'NO_ISSUES_DETECTED';
    const flaggedFiles = [...new Set(sorted.filter((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.medium).map((f) => f.file))];
    const headline =
      status === 'REVIEW_REQUIRED'
        ? `Potentially suspicious changes detected in ${flaggedFiles.length} file(s).`
        : status === 'REVIEW_RECOMMENDED'
          ? `Changes to sensitive files detected in ${flaggedFiles.length} file(s).`
          : 'No suspicious patterns were detected by the automated checks.';
    return { status, headline, findings: sorted, flaggedFiles, scannedFiles, partial, disclaimer: DISCLAIMER };
  }

  /** Inspect everything between the merge-base of HEAD and `targetOid`. */
  async scanIncomingChanges(git: GitService, targetOid: string): Promise<{ files: FileDiff[]; report: SecurityReport }> {
    const hasHead = await git.hasHead();
    let files: FileDiff[];
    let partial = false;
    try {
      files = hasHead ? await git.diffRange('HEAD', targetOid, { threeDot: true }) : await git.diffRange('4b825dc642cb6eb9a060e54bf8d69288fbee4904', targetOid);
    } catch {
      // Diff too large to load: fall back to path-only scanning.
      partial = true;
      const names = hasHead ? await git.nameStatus('HEAD', targetOid, true) : [];
      files = names.map((n) => ({
        oldPath: n.path,
        newPath: n.path,
        status: n.status === 'deleted' ? 'deleted' : n.status === 'added' ? 'added' : 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
        truncated: true,
      }));
    }
    const findings = files.flatMap((f) => this.scanDiff(f));
    if (files.some((f) => f.truncated)) partial = true;
    return { files, report: this.generateSecurityReport(findings, files.length, partial) };
  }
}
