import type { CodeScanningAlert, DependabotAlert, SecurityList, SecurityOverview } from '../../../shared/github';
import { AppError } from '../../git/errors';
import type { GitHubClient } from '../client/GitHubClient';
import type { RepoCoords } from './pullRequests';

const enc = encodeURIComponent;
const base = (r: RepoCoords) => `/repos/${enc(r.owner)}/${enc(r.name)}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Turns "feature not enabled / no permission" into a friendly explanation instead of an error. */
function unavailableReason(err: unknown, feature: string): string | null {
  if (!(err instanceof AppError)) return null;
  const code = err.friendly.code;
  const msg = err.friendly.message;
  if (code === 'feature-disabled' || code === 'gone' || /not enabled|disabled|advanced security|no analysis/i.test(msg)) return `${feature} is not enabled for this repository. ${msg}`;
  if (code === 'forbidden') return `Your account cannot read ${feature.toLowerCase()} for this repository (needs the “security_events” scope or Security alerts permission, and write/security-manager role).`;
  if (code === 'not-found') return `${feature} is not available for this repository (not enabled, no analysis yet, or no access).`;
  return null;
}

async function listOrUnavailable<T>(feature: string, load: () => Promise<{ items: T[]; hasMore: boolean }>): Promise<SecurityList<T>> {
  try {
    const r = await load();
    return { items: r.items, page: 1, hasMore: r.hasMore, unavailable: null };
  } catch (err) {
    const reason = unavailableReason(err, feature);
    if (reason) return { items: [], page: 1, hasMore: false, unavailable: reason };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Overview / settings
// ---------------------------------------------------------------------------

export async function getSecurityOverview(c: GitHubClient, r: RepoCoords): Promise<SecurityOverview> {
  const notes: string[] = [];
  const repo = await c.get<Json>(base(r), { action: 'read the repository' });
  const saa = repo.security_and_analysis as Json | undefined;
  if (!saa) notes.push('Security feature settings are visible to repository admins only.');

  const vulnerability = await c.rest(`GET`, `${base(r)}/vulnerability-alerts`, { allowStatus: [404, 403] }).then((x) => (x.status === 204 ? true : x.status === 404 ? false : null)).catch(() => null);
  const autofix = await c.get<{ enabled: boolean }>(`${base(r)}/automated-security-fixes`).then((x) => x.enabled).catch(() => null);
  const dependabotConfig = await fileExists(c, r, '.github/dependabot.yml').then(async (yml) => yml || (await fileExists(c, r, '.github/dependabot.yaml'))).catch(() => null);
  const codeScanning = await c
    .get<{ state: string }>(`${base(r)}/code-scanning/default-setup`)
    .then((x) => x.state === 'configured')
    .catch(() => null);
  return {
    vulnerabilityAlertsEnabled: vulnerability,
    automatedSecurityFixes: autofix,
    dependabotConfig,
    secretScanning: saa?.secret_scanning?.status ?? null,
    codeScanningConfigured: codeScanning,
    advancedSecurity: saa?.advanced_security?.status ?? null,
    notes,
  };
}

export async function fileExists(c: GitHubClient, r: RepoCoords, path: string, ref?: string): Promise<boolean> {
  const res = await c.rest('GET', `${base(r)}/contents/${path.split('/').map(enc).join('/')}`, { query: { ref }, allowStatus: [404] });
  return res.status !== 404;
}

export async function setVulnerabilityAlerts(c: GitHubClient, r: RepoCoords, enabled: boolean) {
  await c.rest(enabled ? 'PUT' : 'DELETE', `${base(r)}/vulnerability-alerts`, { action: enabled ? 'enable Dependabot alerts' : 'disable Dependabot alerts' });
}

export async function setAutomatedSecurityFixes(c: GitHubClient, r: RepoCoords, enabled: boolean) {
  await c.rest(enabled ? 'PUT' : 'DELETE', `${base(r)}/automated-security-fixes`, { action: enabled ? 'enable Dependabot security updates' : 'disable Dependabot security updates' });
}

// ---------------------------------------------------------------------------
// Code scanning (and code quality = non-security / maintainability findings)
// ---------------------------------------------------------------------------

const QUALITY_TAGS = ['maintainability', 'reliability', 'quality', 'correctness', 'readability', 'useless-code', 'complexity', 'style'];

export function mapCodeScanningAlert(a: Json): CodeScanningAlert {
  const rule = a.rule ?? {};
  const tags: string[] = rule.tags ?? [];
  const loc = a.most_recent_instance?.location ?? {};
  return {
    number: a.number,
    state: a.state,
    severity: rule.security_severity_level ?? rule.severity ?? 'none',
    securitySeverity: rule.security_severity_level ?? null,
    rule: { id: rule.id ?? '', name: rule.name ?? rule.id ?? '', description: rule.full_description ?? rule.description ?? '', tags },
    tool: a.tool?.name ?? 'unknown',
    toolVersion: a.tool?.version ?? null,
    path: loc.path ?? null,
    startLine: loc.start_line ?? null,
    endLine: loc.end_line ?? null,
    message: a.most_recent_instance?.message?.text ?? rule.description ?? '',
    ref: a.most_recent_instance?.ref ?? null,
    createdAt: a.created_at,
    updatedAt: a.updated_at ?? a.created_at,
    dismissedReason: a.dismissed_reason ?? null,
    url: a.html_url,
    // Findings without a security severity, or tagged as quality, are code-quality results.
    isQuality: !rule.security_severity_level || tags.some((t) => QUALITY_TAGS.includes(t.toLowerCase())),
  };
}

export async function listCodeScanningAlerts(c: GitHubClient, r: RepoCoords, f: { state?: string; severity?: string; tool?: string; ref?: string }): Promise<SecurityList<CodeScanningAlert>> {
  return listOrUnavailable('Code scanning', async () => {
    const res = await c.paginate<Json>(`${base(r)}/code-scanning/alerts`, {
      query: { state: f.state || undefined, severity: f.severity || undefined, tool_name: f.tool || undefined, ref: f.ref ? (f.ref.startsWith('refs/') ? f.ref : `refs/heads/${f.ref}`) : undefined, sort: 'updated', direction: 'desc' },
      maxItems: 500,
      action: 'load code scanning alerts',
    });
    return { items: res.items.map(mapCodeScanningAlert), hasMore: res.hasMore };
  });
}

export async function updateCodeScanningAlert(c: GitHubClient, r: RepoCoords, number: number, p: { state: 'open' | 'dismissed'; reason?: string; comment?: string }) {
  await c.rest('PATCH', `${base(r)}/code-scanning/alerts/${number}`, {
    body: p.state === 'dismissed' ? { state: 'dismissed', dismissed_reason: p.reason, dismissed_comment: p.comment || undefined } : { state: 'open' },
    action: p.state === 'dismissed' ? 'dismiss the alert' : 'reopen the alert',
  });
}

export async function codeScanningAlertDetails(c: GitHubClient, r: RepoCoords, number: number) {
  const [alert, instances] = await Promise.all([
    c.get<Json>(`${base(r)}/code-scanning/alerts/${number}`, { action: 'load the alert' }),
    c.paginate<Json>(`${base(r)}/code-scanning/alerts/${number}/instances`, { maxItems: 50 }).catch(() => ({ items: [] as Json[], hasMore: false })),
  ]);
  return {
    alert: mapCodeScanningAlert(alert),
    help: (alert.rule?.help as string | undefined) ?? null,
    instances: instances.items.map((i) => ({ ref: i.ref, state: i.state, path: i.location?.path ?? null, line: i.location?.start_line ?? null, commit: i.commit_sha ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Dependabot alerts (also the source for the Vulnerabilities view)
// ---------------------------------------------------------------------------

export function mapDependabotAlert(a: Json): DependabotAlert {
  const adv = a.security_advisory ?? {};
  const vuln = a.security_vulnerability ?? {};
  return {
    number: a.number,
    state: a.state,
    package: a.dependency?.package?.name ?? vuln.package?.name ?? '',
    ecosystem: a.dependency?.package?.ecosystem ?? vuln.package?.ecosystem ?? '',
    manifest: a.dependency?.manifest_path ?? '',
    scope: a.dependency?.scope ?? null,
    severity: vuln.severity ?? adv.severity ?? 'unknown',
    ghsaId: adv.ghsa_id ?? '',
    cveId: adv.cve_id ?? null,
    summary: adv.summary ?? '',
    description: adv.description ?? '',
    vulnerableRange: vuln.vulnerable_version_range ?? '',
    patchedVersion: vuln.first_patched_version?.identifier ?? null,
    cvss: adv.cvss?.score ?? adv.cvss_severities?.cvss_v4?.score ?? adv.cvss_severities?.cvss_v3?.score ?? null,
    createdAt: a.created_at,
    updatedAt: a.updated_at ?? a.created_at,
    dismissedReason: a.dismissed_reason ?? null,
    url: a.html_url,
    references: (adv.references ?? []).map((x: Json) => x.url).filter(Boolean).slice(0, 10),
  };
}

export async function listDependabotAlerts(c: GitHubClient, r: RepoCoords, f: { state?: string; severity?: string; ecosystem?: string }): Promise<SecurityList<DependabotAlert>> {
  return listOrUnavailable('Dependabot alerts', async () => {
    const res = await c.paginate<Json>(`${base(r)}/dependabot/alerts`, {
      query: { state: f.state || undefined, severity: f.severity || undefined, ecosystem: f.ecosystem || undefined, sort: 'updated', direction: 'desc' },
      maxItems: 500,
      action: 'load Dependabot alerts',
    });
    return { items: res.items.map(mapDependabotAlert), hasMore: res.hasMore };
  });
}

export async function updateDependabotAlert(c: GitHubClient, r: RepoCoords, number: number, p: { state: 'open' | 'dismissed'; reason?: string; comment?: string }) {
  await c.rest('PATCH', `${base(r)}/dependabot/alerts/${number}`, {
    body: p.state === 'dismissed' ? { state: 'dismissed', dismissed_reason: p.reason, dismissed_comment: p.comment || undefined } : { state: 'open' },
    action: p.state === 'dismissed' ? 'dismiss the alert' : 'reopen the alert',
  });
}

/** Open Dependabot pull requests, matched to packages by title ("Bump <package> from …"). */
export async function dependabotPullRequests(c: GitHubClient, r: RepoCoords) {
  const res = await c.get<{ items: Json[] }>('/search/issues', {
    query: { q: `repo:${r.owner}/${r.name} is:pr author:app/dependabot`, sort: 'updated', order: 'desc', per_page: 100 },
    action: 'load Dependabot pull requests',
  });
  return res.items.map((i) => {
    const m = /bump (\S+)/i.exec(i.title as string);
    return { number: i.number as number, title: i.title as string, state: (i.pull_request?.merged_at ? 'merged' : i.state) as string, url: i.html_url as string, package: m ? m[1] : null };
  });
}
