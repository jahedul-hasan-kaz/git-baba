import type {
  CodeEntry,
  CodeSearchHit,
  BranchInfo,
  ChangeKind,
  CommitInfo,
  CommitStatFile,
  DiffFileStatus,
  DiffHunk,
  FileChange,
  FileDiff,
  GraphCommit,
  RepoStatus,
  StashEntry,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// git status --porcelain=v2 --branch -z
// ---------------------------------------------------------------------------

function kindFromCode(c: string): ChangeKind {
  switch (c) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}

/** Splits `count` space-separated fields off the front; the remainder (a path) may contain spaces. */
function splitFields(entry: string, count: number): string[] {
  const fields: string[] = [];
  let rest = entry;
  for (let i = 0; i < count; i++) {
    const idx = rest.indexOf(' ');
    if (idx === -1) {
      fields.push(rest);
      rest = '';
      break;
    }
    fields.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  fields.push(rest);
  return fields;
}

export function parseStatusV2(output: string): Omit<RepoStatus, 'operation'> {
  const status: Omit<RepoStatus, 'operation'> = {
    branch: null,
    detached: false,
    headOid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  // Git prints branch.ab only when the upstream branch exists; without it the upstream is "gone".
  let sawAb = false;
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;

    if (entry.startsWith('# ')) {
      const [, key, ...rest] = entry.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.headOid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        if (value === '(detached)') status.detached = true;
        else status.branch = value;
      } else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        sawAb = true;
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }

    const type = entry[0];
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = splitFields(entry, 8);
      const xy = f[1];
      const p = f[8];
      if (xy[0] !== '.') status.staged.push({ path: p, kind: kindFromCode(xy[0]), area: 'staged' });
      if (xy[1] !== '.') status.unstaged.push({ path: p, kind: kindFromCode(xy[1]), area: 'unstaged' });
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const f = splitFields(entry, 9);
      const xy = f[1];
      const p = f[9];
      const origPath = entries[++i];
      if (xy[0] !== '.') status.staged.push({ path: p, origPath, kind: kindFromCode(xy[0]), area: 'staged' });
      if (xy[1] !== '.') status.unstaged.push({ path: p, origPath, kind: kindFromCode(xy[1]), area: 'unstaged' });
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = splitFields(entry, 10);
      status.conflicted.push({ path: f[10], kind: 'conflicted', area: 'conflicted', conflictCode: f[1] });
    } else if (type === '?') {
      status.untracked.push({ path: entry.slice(2), kind: 'untracked', area: 'untracked' });
    }
  }
  if (status.upstream && !sawAb) status.upstreamGone = true;
  return status;
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

/** Undo git's C-style quoting of unusual paths: "a/tab\there" */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[++i];
    if (/[0-7]/.test(next)) {
      const oct = inner.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string): string | null {
  const unq = unquoteGitPath(p.trim());
  if (unq === '/dev/null') return null;
  return unq.replace(/^[ab]\//, '');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export interface ParseDiffOptions {
  /** Stop collecting lines for a file after this many (keeps huge diffs responsive). */
  maxLinesPerFile?: number;
}

export function parseUnifiedDiff(text: string, opts: ParseDiffOptions = {}): FileDiff[] {
  const maxLines = opts.maxLinesPerFile ?? 20_000;
  const files: FileDiff[] = [];
  const lines = text.split('\n');
  let file: (FileDiff & { _lineCount: number }) | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let remOld = 0;
  let remNew = 0;

  const finish = () => {
    if (file) {
      const { _lineCount, ...rest } = file;
      void _lineCount;
      files.push(rest);
    }
    file = null;
    hunk = null;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx];
    if (line.endsWith('\r') && !line.startsWith('+') && !line.startsWith('-') && !line.startsWith(' ')) line = line.slice(0, -1);

    if (line.startsWith('diff --git ')) {
      finish();
      // Best-effort paths from the header; overwritten by ---/+++ or rename lines.
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      const a = m ? m[1] : '';
      const b = m ? m[2] : '';
      file = { oldPath: a, newPath: b, status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0, _lineCount: 0 };
      continue;
    }
    if (!file) continue;
    const f: FileDiff & { _lineCount: number } = file;

    if (!hunk || !/^[ +\-\\]/.test(line)) {
      if (line.startsWith('new file mode ')) {
        f.status = 'added';
        f.newMode = line.slice('new file mode '.length).trim();
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        f.status = 'deleted';
        f.oldMode = line.slice('deleted file mode '.length).trim();
        continue;
      }
      if (line.startsWith('old mode ')) {
        f.oldMode = line.slice(9).trim();
        continue;
      }
      if (line.startsWith('new mode ')) {
        f.newMode = line.slice(9).trim();
        continue;
      }
      if (line.startsWith('similarity index ')) {
        f.similarity = parseInt(line.slice(17), 10);
        continue;
      }
      if (line.startsWith('rename from ')) {
        f.status = 'renamed';
        f.oldPath = unquoteGitPath(line.slice(12));
        continue;
      }
      if (line.startsWith('rename to ')) {
        f.status = 'renamed';
        f.newPath = unquoteGitPath(line.slice(10));
        continue;
      }
      if (line.startsWith('copy from ')) {
        f.status = 'copied';
        f.oldPath = unquoteGitPath(line.slice(10));
        continue;
      }
      if (line.startsWith('copy to ')) {
        f.status = 'copied';
        f.newPath = unquoteGitPath(line.slice(8));
        continue;
      }
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        f.binary = true;
        continue;
      }
      if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4));
        if (p === null) f.status = 'added';
        else f.oldPath = p;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4));
        if (p === null) f.status = 'deleted';
        else f.newPath = p;
        continue;
      }
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      hunk = {
        header: line,
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      remOld = hunk.oldLines;
      remNew = hunk.newLines;
      f.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      const h: DiffHunk = hunk;
      const content = line.slice(1).replace(/\r$/, '');
      if (line.startsWith('+')) {
        f.additions++;
        if (f._lineCount++ < maxLines) h.lines.push({ type: 'add', content, newLine: newNo });
        else f.truncated = true;
        newNo++;
        remNew--;
      } else if (line.startsWith('-')) {
        f.deletions++;
        if (f._lineCount++ < maxLines) h.lines.push({ type: 'del', content, oldLine: oldNo });
        else f.truncated = true;
        oldNo++;
        remOld--;
      } else if (line.startsWith(' ')) {
        if (f._lineCount++ < maxLines) h.lines.push({ type: 'context', content, oldLine: oldNo, newLine: newNo });
        else f.truncated = true;
        oldNo++;
        newNo++;
        remOld--;
        remNew--;
      } else if (line.startsWith('\\')) {
        h.lines.push({ type: 'meta', content: line });
      }
      // Hunk fully consumed: following lines are headers again (protects against
      // content lines such as "--- x" being mistaken for file headers and vice versa).
      if (remOld <= 0 && remNew <= 0 && !(lines[idx + 1] ?? '').startsWith('\\')) hunk = null;
    }
  }
  finish();
  for (const f of files) {
    if (f.status === 'modified' && f.oldPath !== f.newPath && f.oldPath && f.newPath) f.status = 'renamed';
  }
  return files;
}

/** Builds a diff for an untracked file (everything added) without invoking git. */
export function synthesizeAddedDiff(path: string, content: string, binary: boolean): FileDiff {
  const diff: FileDiff = { oldPath: path, newPath: path, status: 'added' as DiffFileStatus, binary, hunks: [], additions: 0, deletions: 0 };
  if (binary || content.length === 0) return diff;
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const hunk: DiffHunk = { header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: [] };
  lines.forEach((l, i) => hunk.lines.push({ type: 'add', content: l.replace(/\r$/, ''), newLine: i + 1 }));
  diff.hunks.push(hunk);
  diff.additions = lines.length;
  return diff;
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// log / branches / stash
// ---------------------------------------------------------------------------

export const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';

/** hash, short hash, parents, author, email, date, subject, ref decorations */
export const GRAPH_FIELDS = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D';
export const GRAPH_FORMAT = `${GRAPH_FIELDS}%x1e`;

export function parseGraphLog(output: string): GraphCommit[] {
  return output
    .split('\x1e')
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, shortHash, parents, author, email, date, subject, refs] = r.split('\x1f');
      return {
        hash,
        shortHash,
        parents: (parents ?? '').split(' ').filter(Boolean),
        author,
        email,
        date,
        subject: subject ?? '',
        refs: (refs ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      };
    });
}

/** Combines `diff --numstat -z` and `diff --name-status -z` output into per-file stats. */
export function mergeNumstat(numstat: string, nameStatus: string): CommitStatFile[] {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const n = numstat.split('\0');
  for (let i = 0; i < n.length; i++) {
    const rec = n[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(rec);
    if (!m) continue;
    let p = m[3];
    if (p === '') {
      // rename/copy: "add\tdel\t\0old\0new"
      i += 1;
      p = n[++i];
    }
    counts.set(p, { additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  const statusMap: Record<string, CommitStatFile['status']> = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'typechange' };
  const out: CommitStatFile[] = [];
  const parts = nameStatus.split('\0').filter((x) => x !== '');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    const status = statusMap[code[0]] ?? 'modified';
    let oldPath: string | undefined;
    let p: string;
    if (code[0] === 'R' || code[0] === 'C') {
      oldPath = parts[++i];
      p = parts[++i];
    } else p = parts[++i];
    const c = counts.get(p) ?? { additions: 0, deletions: 0, binary: false };
    out.push({ path: p, ...(oldPath ? { oldPath } : {}), status, ...c });
  }
  return out;
}

export function parseLog(output: string): CommitInfo[] {
  return output
    .split('\x1e')
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, shortHash, author, email, date, subject] = r.split('\x1f');
      return { hash, shortHash, author, email, date, subject: subject ?? '' };
    });
}

export const BRANCH_FORMAT = '%(refname)%1f%(HEAD)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(contents:subject)%1f%(committerdate:iso-strict)%1e';

export function parseBranches(output: string): BranchInfo[] {
  const result: BranchInfo[] = [];
  for (const rec of output.split('\x1e')) {
    const r = rec.replace(/^\s+/, '');
    if (!r) continue;
    const [ref, head, oid, upstream, track, subject, date] = r.split('\x1f');
    if (ref.endsWith('/HEAD')) continue;
    const remote = ref.startsWith('refs/remotes/');
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    const info: BranchInfo = { name, current: head === '*', remote, oid, subject: subject ?? '' };
    if (upstream) info.upstream = upstream;
    if (upstream && track === 'gone') info.upstreamGone = true;
    if (date) info.date = date;
    const ahead = /ahead (\d+)/.exec(track ?? '');
    const behind = /behind (\d+)/.exec(track ?? '');
    if (ahead) info.ahead = Number(ahead[1]);
    if (behind) info.behind = Number(behind[1]);
    result.push(info);
  }
  return result;
}

/** "branch: Created from main" → "main" (null for HEAD or other reflog messages). */
export function parseReflogOrigin(oldestSubject: string): string | null {
  const m = /^branch: Created from (.+)$/.exec(oldestSubject.trim());
  if (!m || m[1] === 'HEAD') return null;
  return m[1].replace(/^refs\/(heads|remotes)\//, '');
}

const PREFERRED_BASES = ['main', 'master', 'develop', 'dev'];

/**
 * Nearest other branch in a branch's history. `decorations` are `%D` lines ordered from the
 * branch tip backwards (one per commit that carries a branch ref); `locals` are the local branch names.
 */
export function inferOrigin(branch: string, decorations: string[], locals: Set<string>): string | null {
  const short = (n: string) => (locals.has(n) ? n : n.replace(/^[^/]+\//, ''));
  for (const line of decorations) {
    const names = line
      .split(', ')
      .map((n) => n.replace(/^HEAD -> /, '').trim())
      .filter((n) => n && n !== 'HEAD' && !n.endsWith('/HEAD') && n !== branch && short(n) !== short(branch));
    if (!names.length) continue;
    // Prefer the local name when both "main" and "origin/main" point here.
    const pool = names.filter((n) => locals.has(n) || !names.some((o) => locals.has(o) && o === short(n)));
    return pool.find((n) => PREFERRED_BASES.includes(short(n))) ?? pool[0];
  }
  return null;
}

export function parseStashList(output: string): StashEntry[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const [ref, ...msg] = line.split('\x1f');
      return { index, ref, message: msg.join(' ') };
    });
}

export function parseNameStatus(output: string): { path: string; status: string }[] {
  const parts = output.split('\0').filter((p) => p !== '');
  const out: { path: string; status: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (/^[RC]\d*$/.test(code)) {
      const from = parts[++i];
      const to = parts[++i];
      out.push({ path: to, status: `${code[0] === 'R' ? 'renamed' : 'copied'} from ${from}` });
    } else {
      const p = parts[++i];
      const map: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', T: 'type changed' };
      out.push({ path: p, status: map[code[0]] ?? code });
    }
  }
  return out;
}

export function countChanges(files: FileChange[][]): number {
  const set = new Set<string>();
  for (const list of files) for (const f of list) set.add(f.path);
  return set.size;
}

// ---------------------------------------------------------------------------
// Branch labels for history (git name-rev) and the code browser (git ls-tree)
// ---------------------------------------------------------------------------

/**
 * Splits a `git name-rev` name such as `main~3^2~1` into the branch tip it was named after
 * (`main`) and, when the path crosses a merge, the revision of the innermost merge commit
 * (`main~3`) — the branch merged there is the one the commit was really made on.
 */
export function parseNameRev(name: string): { tip: string | null; mergeRev: string | null } {
  const n = name.trim();
  if (!n || n === 'undefined') return { tip: null, mergeRev: null };
  const tip = n
    .split(/[~^]/)[0]
    .replace(/^remotes\//, '')
    .replace(/^tags\//, '');
  const m = /^(.*)\^[2-9]\d*(?:~\d+)?$/.exec(n);
  return { tip: tip || null, mergeRev: m ? m[1] : null };
}

/** Branch name from a merge commit subject (git, GitHub and GitLab default messages). */
export function branchFromMergeSubject(subject: string): string | null {
  const patterns = [
    /^Merge pull request #\d+ from [^/\s]+\/(\S+)/,
    /^Merge branch '([^']+)'/,
    /^Merge remote-tracking branch '(?:[^/']+\/)?([^']+)'/,
    /^Merge branch "([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = p.exec(subject);
    if (m) return m[1];
  }
  return null;
}

/** `git ls-tree -z -l` output: `<mode> <type> <object> <size>\t<name>` records. */
export function parseLsTree(output: string, dir: string): CodeEntry[] {
  const prefix = dir ? `${dir.replace(/\/+$/, '')}/` : '';
  return output
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const tab = rec.indexOf('\t');
      const [mode, type, , size] = rec.slice(0, tab).trim().split(/\s+/);
      const name = rec.slice(tab + 1);
      const kind: CodeEntry['type'] = type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
      return { name, path: prefix + name, type: kind, size: size && size !== '-' ? Number(size) : null };
    })
    .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** `git grep -n -z` output against a commit: `<oid>:<path>\0<line>\0<text>`. */
export function parseGrep(output: string, max: number): { hits: CodeSearchHit[]; truncated: boolean } {
  const hits: CodeSearchHit[] = [];
  const lines = output.split('\n');
  for (const l of lines) {
    if (!l) continue;
    const parts = l.split('\0');
    if (parts.length < 3) continue;
    const path = parts[0].replace(/^[0-9a-f]{40,64}:/, '');
    hits.push({ path, line: Number(parts[1]) || null, text: parts.slice(2).join('\0').slice(0, 400) });
    if (hits.length >= max) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}
