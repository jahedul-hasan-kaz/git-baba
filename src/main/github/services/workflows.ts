import type { DispatchInput, LabelGate, MarketplaceAction, RepoTag, StarterWorkflow, Workflow, WorkflowJob, WorkflowProposal, WorkflowRun, WorkflowTemplate } from '../../../shared/github';
import { AppError } from '../../git/errors';
import { readZip } from '../../util/zip';
import type { GitHubClient } from '../client/GitHubClient';
import type { RepoCoords } from './pullRequests';

const enc = encodeURIComponent;
const base = (r: RepoCoords) => `/repos/${enc(r.owner)}/${enc(r.name)}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function mapRun(x: Json): WorkflowRun {
  const start = x.run_started_at ?? x.created_at;
  const done = x.status === 'completed' ? x.updated_at : null;
  return {
    id: x.id,
    name: x.name ?? '',
    workflowId: x.workflow_id,
    runNumber: x.run_number,
    attempt: x.run_attempt ?? 1,
    event: x.event,
    branch: x.head_branch ?? null,
    sha: x.head_sha,
    status: x.status,
    conclusion: x.conclusion ?? null,
    createdAt: x.created_at,
    startedAt: start ?? null,
    updatedAt: x.updated_at,
    durationMs: start && done ? new Date(done).getTime() - new Date(start).getTime() : null,
    actor: x.actor?.login ?? null,
    title: x.display_title ?? x.head_commit?.message?.split('\n')[0] ?? '',
    url: x.html_url,
  };
}

export async function listWorkflows(c: GitHubClient, r: RepoCoords): Promise<Workflow[]> {
  const [wfs, runs] = await Promise.all([
    c.paginate<Json>(`${base(r)}/actions/workflows`, { itemsKey: 'workflows', maxItems: 200, action: 'load workflows' }),
    c.get<{ workflow_runs: Json[] }>(`${base(r)}/actions/runs`, { query: { per_page: 100 }, action: 'load workflow runs' }).catch(() => ({ workflow_runs: [] })),
  ]);
  const latest = new Map<number, WorkflowRun>();
  for (const run of runs.workflow_runs.map(mapRun)) if (!latest.has(run.workflowId)) latest.set(run.workflowId, run);
  return wfs.items.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state, url: w.html_url, lastRun: latest.get(w.id) ?? null, dispatchable: null }));
}

export async function listRuns(c: GitHubClient, r: RepoCoords, q: { workflowId?: number; branch?: string; status?: string; page?: number }) {
  const path = q.workflowId ? `${base(r)}/actions/workflows/${q.workflowId}/runs` : `${base(r)}/actions/runs`;
  const res = await c.get<{ total_count: number; workflow_runs: Json[] }>(path, { query: { per_page: 30, page: q.page ?? 1, branch: q.branch, status: q.status }, action: 'load workflow runs' });
  return { runs: res.workflow_runs.map(mapRun), total: res.total_count, page: q.page ?? 1, hasMore: (q.page ?? 1) * 30 < res.total_count };
}

export async function getRunJobs(c: GitHubClient, r: RepoCoords, runId: number): Promise<{ run: WorkflowRun; jobs: WorkflowJob[] }> {
  const [run, jobs] = await Promise.all([
    c.get<Json>(`${base(r)}/actions/runs/${runId}`, { action: 'load the run' }),
    c.paginate<Json>(`${base(r)}/actions/runs/${runId}/jobs`, { itemsKey: 'jobs', maxItems: 200, query: { filter: 'latest' }, action: 'load jobs' }),
  ]);
  return {
    run: mapRun(run),
    jobs: jobs.items.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion ?? null,
      startedAt: j.started_at ?? null,
      completedAt: j.completed_at ?? null,
      steps: (j.steps ?? []).map((s: Json) => ({ name: s.name, status: s.status, conclusion: s.conclusion ?? null, number: s.number, startedAt: s.started_at ?? null, completedAt: s.completed_at ?? null })),
      runnerName: j.runner_name ?? null,
      labels: Array.isArray(j.labels) ? j.labels.map(String) : [],
      url: j.html_url ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Job logs (with fallbacks) and annotations
// ---------------------------------------------------------------------------

export interface JobLogResult {
  text: string;
  truncated: boolean;
  /** Exact per-step output when the source provides it (run archive / GitHub CLI). */
  steps: { number: number | null; name: string; text: string }[] | null;
  source: 'job' | 'archive' | 'gh-cli';
  /** Why an earlier source was skipped (shown as a hint). */
  note: string | null;
}

const MAX_LOG = 512 * 1024;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Splits a run-log archive into this job's steps (`<job>/<n>_<step>.txt`), or its single job file. */
function fromArchive(zip: Buffer, jobName: string): Omit<JobLogResult, 'source' | 'note'> | null {
  const entries = readZip(zip);
  const want = norm(jobName);
  const dirs = [...new Set(entries.map((e) => e.name.split('/')).filter((p) => p.length > 1).map((p) => p[0]))];
  const dir = dirs.find((d) => d === jobName) ?? dirs.find((d) => norm(d) === want) ?? dirs.find((d) => norm(d).startsWith(want) || want.startsWith(norm(d)));
  if (dir) {
    const steps = entries
      .filter((e) => e.name.startsWith(`${dir}/`))
      .map((e) => {
        const m = /^(\d+)_(.*)\.txt$/.exec(e.name.slice(dir.length + 1));
        return { number: m ? Number(m[1]) : null, name: m ? m[2] : e.name, text: e.read().toString('utf8') };
      })
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    if (steps.length) {
      const text = steps.map((s) => s.text).join('\n');
      return { text: text.length > MAX_LOG ? text.slice(-MAX_LOG) : text, truncated: text.length > MAX_LOG, steps };
    }
  }
  const top = entries.find((e) => !e.name.includes('/') && norm(e.name.replace(/^\d+_/, '').replace(/\.txt$/, '')) === want);
  if (!top) return null;
  const text = top.read().toString('utf8');
  return { text: text.length > MAX_LOG ? text.slice(-MAX_LOG) : text, truncated: text.length > MAX_LOG, steps: null };
}

/** `gh run view --log` output: "<job>\t<step>\t<timestamp> <line>". */
export function parseGhRunLog(out: string): { name: string; text: string }[] {
  const steps: { name: string; lines: string[] }[] = [];
  for (const line of out.replace(/\r/g, '').split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const step = parts[1];
    const body = parts.slice(2).join('\t');
    if (!steps.length || steps[steps.length - 1].name !== step) steps.push({ name: step, lines: [] });
    steps[steps.length - 1].lines.push(body);
  }
  return steps.map((s) => ({ name: s.name, text: s.lines.join('\n') }));
}

/**
 * A job's log, trying in turn: the job log endpoint → the run's log archive (exact per-step files) → the
 * user's GitHub CLI (`gh run view --log`). Each failure is remembered so the UI can explain what happened.
 */
export async function robustJobLogs(
  c: GitHubClient,
  r: RepoCoords,
  p: { jobId: number; runId?: number; jobName?: string },
  cli?: () => Promise<string>,
): Promise<JobLogResult> {
  const notes: string[] = [];
  try {
    const t = await c.downloadText(`${base(r)}/actions/jobs/${p.jobId}/logs`, MAX_LOG, 'download the job log');
    if (t.text.trim()) return { ...t, steps: null, source: 'job', note: null };
    notes.push('the job log was empty');
  } catch (err) {
    notes.push(`job log: ${errMsg(err)}`);
  }
  if (p.runId && p.jobName) {
    try {
      const zip = await c.downloadBytes(`${base(r)}/actions/runs/${p.runId}/logs`, 'download the run logs');
      const got = fromArchive(zip, p.jobName);
      if (got) return { ...got, source: 'archive', note: notes.join('; ') };
      notes.push('run archive: no files for this job');
    } catch (err) {
      notes.push(`run archive: ${errMsg(err)}`);
    }
  }
  if (cli && p.runId) {
    try {
      const out = await cli();
      const steps = parseGhRunLog(out);
      if (steps.length) {
        const text = steps.map((s) => s.text).join('\n');
        return { text: text.length > MAX_LOG ? text.slice(-MAX_LOG) : text, truncated: text.length > MAX_LOG, steps: steps.map((s) => ({ number: null, ...s })), source: 'gh-cli', note: notes.join('; ') };
      }
      notes.push('GitHub CLI: no output');
    } catch (err) {
      notes.push(`GitHub CLI: ${errMsg(err)}`);
    }
  }
  throw new AppError({ code: 'logs-unavailable', title: 'Logs Unavailable', message: `The log could not be loaded (${notes.join('; ')}).`, actions: ['retry'] });
}

export interface JobAnnotation {
  level: 'failure' | 'warning' | 'notice';
  title: string | null;
  message: string;
  path: string | null;
  line: number | null;
}

export async function jobAnnotations(c: GitHubClient, r: RepoCoords, jobId: number): Promise<JobAnnotation[]> {
  const res = await c.paginate<Json>(`${base(r)}/check-runs/${jobId}/annotations`, { maxItems: 200, action: 'load annotations' });
  return res.items.map((a) => ({
    level: a.annotation_level === 'failure' ? 'failure' : a.annotation_level === 'warning' ? 'warning' : 'notice',
    title: a.title || null,
    message: String(a.message ?? ''),
    path: a.path && a.path !== '.github' ? a.path : null,
    line: a.start_line ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Label gates (workflows that need a pull request label)
// ---------------------------------------------------------------------------

/** Splits "a, b\n c" style values of a `labels:` input. */
function splitLabels(v: string): string[] {
  return v
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s && !s.startsWith('${{'));
}

/**
 * Finds the pull request labels a workflow file cares about. This is a text heuristic over the
 * common ways of checking labels — it never executes anything — and may miss exotic expressions.
 */
export function parseLabelGate(yaml: string): { requiredLabels: string[]; blockingLabels: string[]; reactsToLabeling: boolean; onPullRequest: boolean } {
  const text = yaml.replace(/\r/g, '');
  const lines = text.split('\n');
  const required = new Set<string>();
  const blocking = new Set<string>();
  const add = (set: Set<string>, v: string) => {
    const t = v.trim();
    if (t && t.length <= 100 && !t.includes('${{')) set.add(t);
  };

  // contains(github.event.pull_request.labels.*.name, 'x')  /  !contains(...)  /  toJSON(...labels...)
  const containsRe = /(!\s*)?contains\(\s*(?:toJSON\([^)]*labels[^)]*\)|[^,()]*labels\.\*\.name[^,]*)\s*,\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(containsRe)) add(m[1] ? blocking : required, m[2]);
  // github.event.label.name == 'x'  (the label that triggered a `labeled` run)
  for (const m of text.matchAll(/github\.event\.label\.name\s*(==|!=)\s*['"]([^'"]+)['"]/g)) add(m[1] === '!=' ? blocking : required, m[2]);
  // JavaScript in github-script: labels.some(l => l.name === 'x') / labels.includes('x')
  for (const l of lines) {
    if (!/label/i.test(l)) continue;
    for (const m of l.matchAll(/\b\w+\.name\s*===?\s*['"]([^'"]+)['"]/g)) add(required, m[1]);
    for (const m of l.matchAll(/labels?[^\n]*?\.includes\(\s*['"]([^'"]+)['"]\s*\)/gi)) add(required, m[1]);
  }
  // mheap/github-action-required-labels (and similar) — `labels:` input of the step
  lines.forEach((line, i) => {
    if (!/uses:\s*[^\s]*required-?labels?/i.test(line) && !/uses:\s*[^\s]*label-?(gate|check|guard|verifier)/i.test(line)) return;
    const stepIndent = line.length - line.trimStart().length;
    const found: string[] = [];
    for (let j = i + 1; j < lines.length && j < i + 40; j++) {
      const raw = lines[j];
      const indent = raw.length - raw.trimStart().length;
      if (raw.trim() && indent < stepIndent && !raw.trimStart().startsWith('-')) break;
      const t = raw.trim();
      const lm = /^labels:\s*(.*)$/.exec(t);
      if (lm) {
        if (lm[1] && !/^[|>][-+]?$/.test(lm[1])) found.push(...splitLabels(lm[1]));
        else {
          for (let k = j + 1; k < lines.length; k++) {
            const bi = lines[k].length - lines[k].trimStart().length;
            if (lines[k].trim() === '') continue;
            if (bi <= indent) break;
            found.push(...splitLabels(lines[k]));
          }
        }
      }
    }
    for (const f of found) add(required, f);
  });

  // `on:` region: from the top-level `on:` key to the next top-level key.
  const onIdx = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l));
  let region = '';
  if (onIdx >= 0) {
    const end = lines.findIndex((l, i) => i > onIdx && /^\S/.test(l) && !l.startsWith('#'));
    region = lines.slice(onIdx, end === -1 ? undefined : end).join('\n');
  }
  const onPullRequest = /\bpull_request(_target)?\b/.test(region);
  const reactsToLabeling = onPullRequest && /\b(un)?labeled\b/.test(region);
  for (const b of blocking) required.delete(b);
  return { requiredLabels: [...required], blockingLabels: [...blocking], reactsToLabeling, onPullRequest };
}

/** Workflows of the repository (as of `ref`) that check pull request labels. */
export async function labelGates(c: GitHubClient, r: RepoCoords, ref: string): Promise<LabelGate[]> {
  const wfs = await c.paginate<Json>(`${base(r)}/actions/workflows`, { itemsKey: 'workflows', maxItems: 100, action: 'load workflows' });
  const candidates = wfs.items.filter((w) => w.state === 'active' && /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(w.path)).slice(0, 40);
  const out: LabelGate[] = [];
  await Promise.all(
    candidates.map(async (w) => {
      const file = await readFile(c, r, w.path, ref).catch(() => null);
      if (!file) return;
      const g = parseLabelGate(file.content);
      if (!g.onPullRequest) return;
      if (g.requiredLabels.length === 0 && g.blockingLabels.length === 0) return;
      out.push({ workflowId: w.id, name: w.name, path: w.path, ...g });
    }),
  );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runAction(c: GitHubClient, r: RepoCoords, runId: number, action: 'rerun' | 'rerun-failed' | 'cancel') {
  const suffix = action === 'rerun' ? 'rerun' : action === 'rerun-failed' ? 'rerun-failed-jobs' : 'cancel';
  await c.rest('POST', `${base(r)}/actions/runs/${runId}/${suffix}`, { action: action === 'cancel' ? 'cancel the run' : 're-run the workflow' });
}

export async function jobLogs(c: GitHubClient, r: RepoCoords, jobId: number) {
  return c.downloadText(`${base(r)}/actions/jobs/${jobId}/logs`, 512 * 1024, 'download the logs');
}

// ---------------------------------------------------------------------------
// Manual dispatch
// ---------------------------------------------------------------------------

export async function readFile(c: GitHubClient, r: RepoCoords, path: string, ref?: string): Promise<{ content: string; sha: string } | null> {
  const res = await c.rest<Json>('GET', `${base(r)}/contents/${path.split('/').map(enc).join('/')}`, { query: { ref }, allowStatus: [404], action: `read ${path}` });
  if (res.status === 404) return null;
  if (Array.isArray(res.data) || res.data.type !== 'file') throw new AppError({ code: 'not-a-file', title: 'Not a File', message: `${path} is not a file.` });
  return { content: Buffer.from(String(res.data.content ?? ''), 'base64').toString('utf8'), sha: res.data.sha };
}

/**
 * Minimal reader for the `on: workflow_dispatch: inputs:` block of a workflow file.
 * It only needs input names and their simple scalar attributes.
 */
export function parseDispatch(yaml: string): { dispatchable: boolean; inputs: DispatchInput[] } {
  const lines = yaml.replace(/\r/g, '').split('\n');
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const strip = (v: string) => v.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
  // Flow style: on: [push, workflow_dispatch]  or  on: workflow_dispatch
  if (lines.some((l) => /^['"]?on['"]?\s*:\s*(\[.*\bworkflow_dispatch\b.*\]|workflow_dispatch\s*$)/.test(l.trim()) && indentOf(l) === 0)) return { dispatchable: true, inputs: [] };
  const idx = lines.findIndex((l) => /^\s*workflow_dispatch\s*:/.test(l));
  if (idx === -1) return { dispatchable: false, inputs: [] };
  const wdIndent = indentOf(lines[idx]);
  const inputs: DispatchInput[] = [];
  let i = idx + 1;
  // find "inputs:"
  while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > wdIndent)) {
    if (/^\s*inputs\s*:/.test(lines[i])) {
      const inIndent = indentOf(lines[i]);
      i++;
      let current: DispatchInput | null = null;
      let currentIndent = -1;
      let inOptions = false;
      while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > inIndent)) {
        const line = lines[i];
        const t = line.trim();
        const ind = indentOf(line);
        if (!t || t.startsWith('#')) {
          i++;
          continue;
        }
        if (current === null || ind <= currentIndent) {
          const m = /^([A-Za-z0-9_-]+)\s*:\s*$/.exec(t);
          if (m) {
            current = { name: m[1], description: '', required: false, default: null, type: 'string', options: [] };
            currentIndent = ind;
            inputs.push(current);
            inOptions = false;
          }
        } else {
          const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(t);
          if (kv && !t.startsWith('- ')) {
            inOptions = kv[1] === 'options' && kv[2] === '';
            const v = strip(kv[2]);
            if (kv[1] === 'description') current.description = v;
            if (kv[1] === 'required') current.required = v === 'true';
            if (kv[1] === 'default') current.default = v;
            if (kv[1] === 'type') current.type = v;
            if (kv[1] === 'options' && v.startsWith('[')) current.options = v.slice(1, -1).split(',').map((o) => strip(o)).filter(Boolean);
          } else if (inOptions && t.startsWith('- ')) {
            current.options.push(strip(t.slice(2)));
          }
        }
        i++;
      }
      break;
    }
    i++;
  }
  return { dispatchable: true, inputs };
}

export async function workflowDispatchInfo(c: GitHubClient, r: RepoCoords, path: string, ref: string) {
  const file = await readFile(c, r, path, ref);
  if (!file) return { dispatchable: false, inputs: [] as DispatchInput[], source: null as string | null };
  return { ...parseDispatch(file.content), source: file.content };
}

export async function dispatchWorkflow(c: GitHubClient, r: RepoCoords, workflowId: number, ref: string, inputs: Record<string, string>) {
  await c.rest('POST', `${base(r)}/actions/workflows/${workflowId}/dispatches`, { body: { ref, inputs }, action: 'run the workflow' });
}

// ---------------------------------------------------------------------------
// Tags, starter workflows (actions/starter-workflows), Marketplace, writing workflow files
// ---------------------------------------------------------------------------

export async function listTags(c: GitHubClient, r: RepoCoords): Promise<RepoTag[]> {
  const res = await c.paginate<Json>(`${base(r)}/tags`, { maxItems: 300, action: 'load tags' });
  return res.items.map((t) => ({ name: String(t.name), sha: String(t.commit?.sha ?? '') })).filter((t) => t.sha);
}

const STARTER_REPO = 'actions/starter-workflows';
const STARTER_RAW = 'https://raw.githubusercontent.com/actions/starter-workflows/main';
const STARTER_CATEGORIES = ['deployments', 'ci', 'automation', 'code-scanning', 'pages'] as const;
let starterCache: { at: number; list: Omit<StarterWorkflow, 'suggested'>[] } | null = null;

async function rawText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** GitHub's own starter workflows, grouped by category; "suggested" ones match the repository's languages. */
export async function starterWorkflows(c: GitHubClient, r: RepoCoords): Promise<StarterWorkflow[]> {
  if (!starterCache || Date.now() - starterCache.at > 6 * 3600_000) {
    const tree = await c.get<{ tree: { path: string; type: string }[] }>(`/repos/${STARTER_REPO}/git/trees/main`, { query: { recursive: 1 }, action: 'load starter workflows' });
    const props = tree.tree.filter((t) => t.type === 'blob' && /^(deployments|ci|automation|code-scanning|pages)\/properties\/[^/]+\.properties\.json$/.test(t.path));
    const list: Omit<StarterWorkflow, 'suggested'>[] = [];
    // Raw files come from raw.githubusercontent.com (no API rate limit); a few at a time.
    for (let i = 0; i < props.length; i += 12) {
      const chunk = await Promise.all(
        props.slice(i, i + 12).map(async (p) => {
          const [category, , file] = p.path.split('/');
          const id = file.replace(/\.properties\.json$/, '');
          const text = await rawText(`${STARTER_RAW}/${p.path}`);
          if (!text) return null;
          try {
            const j = JSON.parse(text) as { name?: string; description?: string; creator?: string; categories?: string[] | null };
            return { id, category: category as StarterWorkflow['category'], name: j.name ?? id, description: j.description ?? '', creator: j.creator ?? null, tags: (j.categories ?? []).filter(Boolean).slice(0, 8) };
          } catch {
            return null;
          }
        }),
      );
      list.push(...(chunk.filter(Boolean) as Omit<StarterWorkflow, 'suggested'>[]));
    }
    starterCache = { at: Date.now(), list };
  }
  const langs = await c.get<Record<string, number>>(`${base(r)}/languages`, { action: 'load languages' }).catch(() => ({}) as Record<string, number>);
  const mine = new Set(Object.keys(langs).map((l) => l.toLowerCase()));
  return starterCache.list.map((s) => ({ ...s, suggested: s.tags.some((t) => mine.has(t.toLowerCase())) }));
}

export async function starterWorkflow(c: GitHubClient, r: RepoCoords, category: string, id: string): Promise<{ content: string; name: string }> {
  if (!(STARTER_CATEGORIES as readonly string[]).includes(category) || !/^[A-Za-z0-9._-]+$/.test(id)) throw new AppError({ code: 'invalid-input', title: 'Unknown Template', message: 'That starter workflow does not exist.' });
  const text = await rawText(`${STARTER_RAW}/${category}/${id}.yml`);
  if (!text) throw new AppError({ code: 'not-found', title: 'Template Unavailable', message: `Could not download ${id}.yml from ${STARTER_REPO}.` });
  const repo = await c.get<{ default_branch: string }>(base(r), { action: 'read the repository' });
  return { content: text.replace(/\$default-branch/g, repo.default_branch).replace(/\$protected-branches/g, repo.default_branch).replace(/\$cron-daily/g, "'30 5 * * *'"), name: id };
}

export async function marketplaceSearch(c: GitHubClient, query: string): Promise<MarketplaceAction[]> {
  const q = `${query} topic:github-action`.trim();
  const res = await c.get<{ items: Json[] }>('/search/repositories', { query: { q, sort: 'stars', order: 'desc', per_page: 20 }, action: 'search the Marketplace' });
  return res.items.map((x) => ({
    fullName: x.full_name,
    description: x.description ?? null,
    stars: x.stargazers_count ?? 0,
    url: x.html_url,
    owner: x.owner?.login ?? '',
    verifiedOwner: ['actions', 'github', 'docker', 'aws-actions', 'azure', 'google-github-actions', 'hashicorp'].includes(String(x.owner?.login ?? '').toLowerCase()),
  }));
}

/** Newest release tag of an action (falls back to its newest tag). */
export async function actionLatest(c: GitHubClient, fullName: string): Promise<{ ref: string | null }> {
  const rel = await c.rest<Json>('GET', `/repos/${fullName.split('/').map(enc).join('/')}/releases/latest`, { allowStatus: [404], action: 'read the latest release' });
  if (rel.status === 200 && rel.data.tag_name) return { ref: String(rel.data.tag_name) };
  const tags = await c.get<Json[]>(`/repos/${fullName.split('/').map(enc).join('/')}/tags`, { query: { per_page: 1 }, action: 'read tags' }).catch(() => []);
  return { ref: tags[0]?.name ?? null };
}

/** Writes a workflow file to `branch` directly, or on a new branch with a pull request into `branch`. */
export async function writeWorkflow(
  c: GitHubClient,
  r: RepoCoords,
  p: { path: string; content: string; branch: string; mode: 'direct' | 'pull-request'; message: string; existingSha: string | null },
): Promise<{ url: string; mode: 'direct' | 'pull-request'; branch: string }> {
  const current = await readFile(c, r, p.path, p.branch);
  if (current && current.sha !== p.existingSha) {
    throw new AppError({ code: 'exists', title: 'File Already Exists', message: `${p.path} already exists on ${p.branch} (or changed since you opened it). Open it again to edit the latest version, or choose another file name.` });
  }
  const content = Buffer.from(p.content, 'utf8').toString('base64');
  const filePath = `${base(r)}/contents/${p.path.split('/').map(enc).join('/')}`;
  if (p.mode === 'direct') {
    const res = await c.rest<{ commit: { html_url: string } }>('PUT', filePath, { body: { message: p.message, content, branch: p.branch, sha: current?.sha }, action: `commit ${p.path}` });
    return { url: res.data.commit.html_url, mode: 'direct', branch: p.branch };
  }
  const head = await c.get<{ object: { sha: string } }>(`${base(r)}/git/ref/heads/${p.branch.split('/').map(enc).join('/')}`, { action: `read ${p.branch}` });
  const branch = `git-baba/${p.path.split('/').pop()!.replace(/\.(ya?ml)$/, '')}-${Date.now().toString(36)}`;
  await c.rest('POST', `${base(r)}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: head.object.sha }, action: 'create a branch' });
  await c.rest('PUT', filePath, { body: { message: p.message, content, branch, sha: current?.sha }, action: `commit ${p.path}` });
  const pr = await c.rest<{ html_url: string }>('POST', `${base(r)}/pulls`, {
    body: { title: p.message, head: branch, base: p.branch, body: `Workflow proposed with Git Baba.\n\nFile: \`${p.path}\`\n\nReview the triggers, permissions and action versions before merging.` },
    action: 'open the pull request',
  });
  return { url: pr.data.html_url, mode: 'pull-request', branch };
}

/** The run a dispatch just created (GitHub does not return it): newest workflow_dispatch run on `ref` since `since`. */
export async function findDispatchedRun(c: GitHubClient, r: RepoCoords, workflowId: number, ref: string, since: number): Promise<number | null> {
  for (let i = 0; i < 8; i++) {
    await new Promise((res) => setTimeout(res, i === 0 ? 1200 : 1500));
    const res = await c.get<{ workflow_runs: Json[] }>(`${base(r)}/actions/workflows/${workflowId}/runs`, { query: { event: 'workflow_dispatch', branch: ref, per_page: 5 }, action: 'find the new run' }).catch(() => ({ workflow_runs: [] as Json[] }));
    const hit = res.workflow_runs.find((x) => new Date(x.created_at).getTime() >= since - 5000);
    if (hit) return hit.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Security / Marketplace workflow templates
// ---------------------------------------------------------------------------

export const TEMPLATES: WorkflowTemplate[] = [
  { id: 'codeql', name: 'CodeQL analysis', category: 'Code scanning (SAST)', description: 'GitHub’s semantic code analysis. Finds security vulnerabilities and code-quality issues; results appear under Code scanning.', path: '.github/workflows/codeql.yml', kind: 'workflow', marketplaceUrl: 'https://github.com/marketplace/actions/codeql-analysis' },
  { id: 'dependency-review', name: 'Dependency review', category: 'Dependency scanning', description: 'Blocks pull requests that add dependencies with known vulnerabilities.', path: '.github/workflows/dependency-review.yml', kind: 'workflow', marketplaceUrl: 'https://github.com/marketplace/actions/dependency-review' },
  { id: 'dependabot', name: 'Dependabot version updates', category: 'Dependency updates', description: 'Weekly pull requests that keep dependencies up to date, for the ecosystems detected in the repository.', path: '.github/dependabot.yml', kind: 'config', marketplaceUrl: 'https://docs.github.com/code-security/dependabot/dependabot-version-updates' },
  { id: 'scorecard', name: 'OpenSSF Scorecard', category: 'Security analysis', description: 'Checks supply-chain security practices (branch protection, pinned actions, token permissions…).', path: '.github/workflows/scorecard.yml', kind: 'workflow', marketplaceUrl: 'https://github.com/marketplace/actions/ossf-scorecard-action' },
  { id: 'super-linter', name: 'Super-Linter', category: 'Linting / code quality', description: 'Runs many linters (JS/TS, Python, YAML, Markdown, shell…) on changed files.', path: '.github/workflows/super-linter.yml', kind: 'workflow', marketplaceUrl: 'https://github.com/marketplace/actions/super-linter' },
  { id: 'secret-scanning', name: 'Secret scanning & push protection', category: 'Secret scanning', description: 'Detects committed credentials. It is a repository setting, not a workflow — configured in GitHub settings.', path: '', kind: 'guided', marketplaceUrl: 'https://docs.github.com/code-security/secret-scanning' },
];

const CODEQL_LANGS: Record<string, string> = {
  JavaScript: 'javascript-typescript',
  TypeScript: 'javascript-typescript',
  Python: 'python',
  Java: 'java-kotlin',
  Kotlin: 'java-kotlin',
  'C#': 'csharp',
  Go: 'go',
  Ruby: 'ruby',
  C: 'c-cpp',
  'C++': 'c-cpp',
  Swift: 'swift',
};

const ECOSYSTEM_FILES: [RegExp, string][] = [
  [/^package\.json$/, 'npm'],
  [/^(requirements.*\.txt|pyproject\.toml|setup\.py|Pipfile)$/, 'pip'],
  [/^go\.mod$/, 'gomod'],
  [/^pom\.xml$/, 'maven'],
  [/^build\.gradle(\.kts)?$/, 'gradle'],
  [/^Gemfile$/, 'bundler'],
  [/^Cargo\.toml$/, 'cargo'],
  [/^composer\.json$/, 'composer'],
  [/\.(csproj|sln)$/, 'nuget'],
  [/^Dockerfile/, 'docker'],
  [/^pubspec\.yaml$/, 'pub'],
];

export function renderTemplate(id: string, ctx: { defaultBranch: string; languages: string[]; ecosystems: string[] }): string {
  const branch = ctx.defaultBranch;
  switch (id) {
    case 'codeql': {
      const langs = [...new Set(ctx.languages.map((l) => CODEQL_LANGS[l]).filter(Boolean))];
      if (!langs.length) langs.push('actions');
      return `name: CodeQL

on:
  push:
    branches: [ "${branch}" ]
  pull_request:
    branches: [ "${branch}" ]
  schedule:
    - cron: '27 3 * * 1'

permissions:
  contents: read

jobs:
  analyze:
    name: Analyze (\${{ matrix.language }})
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      actions: read
      contents: read
    strategy:
      fail-fast: false
      matrix:
        language: [ ${langs.map((l) => `'${l}'`).join(', ')} ]
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: \${{ matrix.language }}
          build-mode: none
      - uses: github/codeql-action/analyze@v3
        with:
          category: "/language:\${{ matrix.language }}"
`;
    }
    case 'dependency-review':
      return `name: Dependency review

on:
  pull_request:
    branches: [ "${branch}" ]

permissions:
  contents: read
  pull-requests: write

jobs:
  dependency-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: high
          comment-summary-in-pr: on-failure
`;
    case 'scorecard':
      return `name: OpenSSF Scorecard

on:
  push:
    branches: [ "${branch}" ]
  schedule:
    - cron: '30 4 * * 2'

permissions: read-all

jobs:
  analysis:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: ossf/scorecard-action@v2.4.0
        with:
          results_file: results.sarif
          results_format: sarif
          publish_results: false
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
`;
    case 'super-linter':
      return `name: Lint

on:
  pull_request:
    branches: [ "${branch}" ]

permissions:
  contents: read
  statuses: write

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: super-linter/super-linter/slim@v7
        env:
          DEFAULT_BRANCH: ${branch}
          VALIDATE_ALL_CODEBASE: false
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
    case 'dependabot': {
      const ecos = ctx.ecosystems.length ? ctx.ecosystems : ['github-actions'];
      return `version: 2
updates:
${ecos
  .map(
    (e) => `  - package-ecosystem: "${e}"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
`,
  )
  .join('')}`;
    }
    default:
      throw new AppError({ code: 'unknown-template', title: 'Unknown Template', message: 'This configuration cannot be generated automatically.' });
  }
}

export async function proposeTemplate(c: GitHubClient, r: RepoCoords, templateId: string): Promise<WorkflowProposal> {
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new AppError({ code: 'unknown-template', title: 'Unknown Template', message: 'Choose one of the listed configurations.' });
  const repo = await c.get<{ default_branch: string; html_url: string }>(base(r), { action: 'read the repository' });
  if (template.kind === 'guided') {
    return {
      template,
      path: '',
      content: '',
      existing: null,
      existingSha: null,
      defaultBranch: repo.default_branch,
      guidance: [
        'Secret scanning and push protection are repository settings, not workflow files, so nothing is written here.',
        `Open ${repo.html_url}/settings/security_analysis`,
        'Enable “Secret scanning” and “Push protection” (public repositories: free; private: needs GitHub Secret Protection / Advanced Security).',
        'Detected secrets then appear under Security → Secret scanning on GitHub.',
      ],
    };
  }
  const [languages, root] = await Promise.all([
    c.get<Record<string, number>>(`${base(r)}/languages`).catch(() => ({})),
    c.get<{ name: string; type: string }[]>(`${base(r)}/contents`, { query: { ref: repo.default_branch } }).catch(() => []),
  ]);
  const ecosystems = new Set<string>();
  for (const f of Array.isArray(root) ? root : []) for (const [re, eco] of ECOSYSTEM_FILES) if (re.test(f.name)) ecosystems.add(eco);
  if ((Array.isArray(root) ? root : []).some((f) => f.name === '.github' && f.type === 'dir')) ecosystems.add('github-actions');
  const existing = await readFile(c, r, template.path, repo.default_branch);
  return {
    template,
    path: template.path,
    content: renderTemplate(template.id, { defaultBranch: repo.default_branch, languages: Object.keys(languages), ecosystems: [...ecosystems] }),
    existing: existing?.content ?? null,
    existingSha: existing?.sha ?? null,
    defaultBranch: repo.default_branch,
    guidance: [],
  };
}

/**
 * Writes exactly one file (the template's path) — either on a new branch with a pull request
 * (default) or directly on the default branch. Existing files are only replaced when the user
 * explicitly chose to, and only if the file has not changed since it was shown.
 */
export async function applyTemplate(
  c: GitHubClient,
  r: RepoCoords,
  p: { path: string; content: string; mode: 'pull-request' | 'direct'; overwrite: boolean; existingSha: string | null; templateName: string },
): Promise<{ url: string; mode: 'pull-request' | 'direct' }> {
  const repo = await c.get<{ default_branch: string }>(base(r), { action: 'read the repository' });
  const current = await readFile(c, r, p.path, repo.default_branch);
  if (current && !p.overwrite) throw new AppError({ code: 'exists', title: 'File Already Exists', message: `${p.path} already exists. Nothing was changed. Tick “Replace the existing file” to update it.` });
  if (current && current.sha !== p.existingSha) throw new AppError({ code: 'changed', title: 'File Changed', message: `${p.path} changed on GitHub after it was shown to you. Review it again.` });
  const message = `${current ? 'Update' : 'Add'} ${p.templateName} (${p.path})`;
  const content = Buffer.from(p.content, 'utf8').toString('base64');
  const filePath = `${base(r)}/contents/${p.path.split('/').map(enc).join('/')}`;
  if (p.mode === 'direct') {
    const res = await c.rest<{ commit: { html_url: string } }>('PUT', filePath, { body: { message, content, branch: repo.default_branch, sha: current?.sha }, action: `write ${p.path}` });
    return { url: res.data.commit.html_url, mode: 'direct' };
  }
  const head = await c.get<{ object: { sha: string } }>(`${base(r)}/git/ref/heads/${enc(repo.default_branch)}`, { action: 'read the default branch' });
  const branch = `git-baba/${p.path.split('/').pop()!.replace(/\.(ya?ml)$/, '')}-${Date.now().toString(36)}`;
  await c.rest('POST', `${base(r)}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: head.object.sha }, action: 'create a branch' });
  await c.rest('PUT', filePath, { body: { message, content, branch, sha: current?.sha }, action: `write ${p.path}` });
  const pr = await c.rest<{ html_url: string }>('POST', `${base(r)}/pulls`, {
    body: { title: message, head: branch, base: repo.default_branch, body: `Proposed by Git Baba. Review the configuration (including action versions) before merging.\n\nFile: \`${p.path}\`` },
    action: 'open the pull request',
  });
  return { url: pr.data.html_url, mode: 'pull-request' };
}
