/**
 * Builds a patch containing only some hunks / lines of a single-file unified diff, for staging,
 * unstaging or discarding part of a file. Works on the raw `git diff` text so line endings and
 * "\ No newline at end of file" markers survive exactly.
 *
 * `selection` maps a hunk index to the indexes of its changed lines to keep (indexes count every
 * line in the hunk body, as the parsed diff does), or to 'all'.
 *
 * Forward (stage): unselected "+" lines are dropped, unselected "-" lines become context.
 * Reverse (unstage / discard, applied with -R): unselected "+" lines become context, unselected "-" are dropped.
 */
export function buildPartialPatch(raw: string, selection: Map<number, Set<number> | 'all'>, reverse: boolean): string | null {
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header: string[] = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) header.push(lines[i++]);
  if (!header.some((l) => l.startsWith('--- ')) || !header.some((l) => l.startsWith('+++ '))) return null;

  const out: string[] = [];
  let hunkIdx = -1;
  let any = false;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    hunkIdx++;
    const body: string[] = [];
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) body.push(lines[i++]);
    const sel = selection.get(hunkIdx);
    if (!sel) continue;

    const kept: string[] = [];
    let oldN = 0;
    let newN = 0;
    let changed = false;
    let lastKept = true; // whether the previous body line made it into the patch
    body.forEach((l, k) => {
      const t = l[0];
      if (t === '\\') {
        if (lastKept) kept.push(l);
        return;
      }
      const chosen = sel === 'all' || sel.has(k);
      if (t === ' ' || t === undefined) {
        kept.push(l.length ? l : ' ');
        oldN++;
        newN++;
        lastKept = true;
      } else if (t === '+') {
        if (chosen) {
          kept.push(l);
          newN++;
          changed = true;
          lastKept = true;
        } else if (reverse) {
          kept.push(` ${l.slice(1)}`);
          oldN++;
          newN++;
          lastKept = true;
        } else lastKept = false;
      } else if (t === '-') {
        if (chosen) {
          kept.push(l);
          oldN++;
          changed = true;
          lastKept = true;
        } else if (!reverse) {
          kept.push(` ${l.slice(1)}`);
          oldN++;
          newN++;
          lastKept = true;
        } else lastKept = false;
      }
    });
    if (!changed) continue;
    any = true;
    // Starts are recounted by `git apply --recount`; the old start locates the hunk.
    out.push(`@@ -${m[1]},${oldN} +${m[2]},${newN} @@${m[3]}`, ...kept);
  }
  if (!any) return null;
  return [...header, ...out].join('\n') + '\n';
}
