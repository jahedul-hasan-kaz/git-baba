// Pure helpers for reading and resolving conflict markers. They never touch
// the filesystem; the GitService decides when a resolution is written.

export interface CommonSegment {
  type: 'common';
  text: string;
}

export interface ConflictSegment {
  type: 'conflict';
  index: number;
  ours: string;
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
}

export type Segment = CommonSegment | ConflictSegment;

export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'both-theirs-first';

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SEP = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, '');
}

/** Splits file content into common text and conflict blocks. */
export function parseConflictMarkers(text: string): Segment[] {
  const lines = text.split(/(?<=\n)/);
  const segments: Segment[] = [];
  let common = '';
  let i = 0;
  let index = 0;

  while (i < lines.length) {
    const start = START.exec(stripEol(lines[i]));
    if (!start) {
      common += lines[i++];
      continue;
    }
    // Look ahead for a well-formed block; if it is malformed treat the line as text.
    let j = i + 1;
    let ours = '';
    let base: string | null = null;
    let theirs = '';
    let phase: 'ours' | 'base' | 'theirs' = 'ours';
    let endLabel: string | null = null;
    let closed = false;
    for (; j < lines.length; j++) {
      const l = stripEol(lines[j]);
      if (phase === 'ours' && BASE.test(l)) {
        phase = 'base';
        base = '';
        continue;
      }
      if ((phase === 'ours' || phase === 'base') && SEP.test(l)) {
        phase = 'theirs';
        continue;
      }
      if (phase === 'theirs') {
        const end = END.exec(l);
        if (end) {
          endLabel = end[1] ?? '';
          closed = true;
          break;
        }
      }
      if (START.test(l)) break; // nested/malformed
      if (phase === 'ours') ours += lines[j];
      else if (phase === 'base') base += lines[j];
      else theirs += lines[j];
    }
    if (!closed) {
      common += lines[i++];
      continue;
    }
    if (common) segments.push({ type: 'common', text: common });
    common = '';
    segments.push({
      type: 'conflict',
      index: index++,
      ours,
      base,
      theirs,
      oursLabel: start[1] ?? 'current',
      theirsLabel: endLabel ?? 'incoming',
    });
    i = j + 1;
  }
  if (common) segments.push({ type: 'common', text: common });
  return segments;
}

export function hasConflictMarkers(text: string): boolean {
  return parseConflictMarkers(text).some((s) => s.type === 'conflict');
}

function ensureTrailingNewline(s: string, eol: string): string {
  return s === '' || s.endsWith('\n') ? s : s + eol;
}

function pick(seg: ConflictSegment, choice: ConflictChoice, eol: string): string {
  switch (choice) {
    case 'ours':
      return seg.ours;
    case 'theirs':
      return seg.theirs;
    case 'both':
      return ensureTrailingNewline(seg.ours, eol) + seg.theirs;
    case 'both-theirs-first':
      return ensureTrailingNewline(seg.theirs, eol) + seg.ours;
  }
}

/**
 * Resolves conflict blocks. `choices` maps conflict index → choice; blocks
 * without a choice keep their markers so nothing is silently decided.
 */
export function resolveConflicts(text: string, choices: Record<number, ConflictChoice> | ConflictChoice): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return parseConflictMarkers(text)
    .map((seg) => {
      if (seg.type === 'common') return seg.text;
      const choice = typeof choices === 'string' ? choices : choices[seg.index];
      if (!choice) return renderConflict(seg, eol);
      return pick(seg, choice, eol);
    })
    .join('');
}

export function renderConflict(seg: ConflictSegment, eol = '\n'): string {
  let out = `<<<<<<< ${seg.oursLabel}${eol}${seg.ours}`;
  if (seg.base !== null) out += `|||||||${eol}${seg.base}`;
  out += `=======${eol}${seg.theirs}>>>>>>> ${seg.theirsLabel}${eol}`;
  return out;
}

/** Explains a porcelain conflict code (e.g. "UU", "DU") in plain language. */
export function explainConflictCode(code: string, op: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null): string {
  const local = op === 'rebase' ? 'the branch you are rebasing onto' : 'your current branch';
  const incoming = op === 'rebase' ? 'your commit being replayed' : 'the incoming branch';
  switch (code) {
    case 'UU':
      return `Both ${local} and ${incoming} changed the same lines of this file.`;
    case 'AA':
      return `This file was added on both sides with different content.`;
    case 'DU':
      return `${capitalize(local)} deleted this file, but ${incoming} modified it.`;
    case 'UD':
      return `${capitalize(incoming)} deleted this file, but ${local} modified it.`;
    case 'AU':
      return `${capitalize(local)} added this file and ${incoming} changed it in an incompatible way.`;
    case 'UA':
      return `${capitalize(incoming)} added this file and ${local} changed it in an incompatible way.`;
    case 'DD':
      return `Both sides deleted (or renamed) this file differently.`;
    default:
      return 'Git could not combine the changes to this file automatically.';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
