import { useEffect, useMemo, useRef, useState } from 'react';

const TYPES: [string, string, string][] = [
  ['feat', '✨', 'A new feature'],
  ['fix', '🐛', 'A bug fix'],
  ['docs', '📝', 'Documentation only'],
  ['style', '🎨', 'Formatting, no code change'],
  ['refactor', '♻', 'Code change that neither fixes a bug nor adds a feature'],
  ['perf', '⚡', 'Performance improvement'],
  ['test', '🧪', 'Adding or fixing tests'],
  ['chore', '🔧', 'Build, tooling, dependencies'],
];
const PREFIX = /^(\w+)(\(([^)]*)\))?(!)?:\s?/;

/** Common top folder of the staged files, as a scope suggestion ("renderer", "main/git"…). */
function suggestScope(paths: string[]): string | null {
  if (!paths.length) return null;
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  const common: string[] = [];
  for (let i = 0; ; i++) {
    const seg = dirs[0][i];
    if (!seg || !dirs.every((d) => d[i] === seg)) break;
    common.push(seg);
  }
  const meaningful = common.filter((s) => !['src', 'lib', 'app', 'packages'].includes(s));
  return meaningful.slice(-1)[0] ?? (paths.length === 1 ? paths[0].split('/').pop()!.replace(/\.[^.]+$/, '') : null);
}

interface Props {
  repoId: string;
  message: string;
  setMessage: (m: string) => void;
  stagedPaths: string[];
  stagedStats: { add: number; del: number };
  branch: string | null;
  canCommit: boolean;
  primaryLabel: string;
  blockedReason: string | null;
  onCommit: () => void;
}

/** Commit message composer: conventional-commit type chips, scope suggestion, subject length meter, saved draft. */
export function CommitComposer({ repoId, message, setMessage, stagedPaths, stagedStats, branch, canCommit, primaryLabel, blockedReason, onCommit }: Props) {
  const [subject, ...rest] = message.split('\n');
  const body = rest.join('\n').replace(/^\n/, '');
  const [showBody, setShowBody] = useState(!!body);
  const subjRef = useRef<HTMLInputElement>(null);
  const draftKey = `gb.draft.${repoId}`;
  const m = PREFIX.exec(subject);
  const type = m?.[1] ?? null;
  const scope = m?.[3] ?? '';
  const text = m ? subject.slice(m[0].length) : subject;
  const suggestion = useMemo(() => suggestScope(stagedPaths), [stagedPaths]);

  // Restore / keep the draft for this repository.
  useEffect(() => {
    try {
      const d = localStorage.getItem(draftKey);
      if (d && !message) setMessage(d);
    } catch {
      /* drafts are a convenience */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  // A commit undone from the Push window puts its message back here.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ repoId: string; message: string }>).detail;
      if (d?.repoId === repoId && !message.trim()) setMessage(d.message);
    };
    window.addEventListener('gb:draft-restored', on);
    return () => window.removeEventListener('gb:draft-restored', on);
  }, [repoId, message, setMessage]);
  useEffect(() => {
    try {
      if (message) localStorage.setItem(draftKey, message);
      else localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [draftKey, message]);

  const compose = (t: string | null, sc: string, tx: string, b: string) => {
    const head = t ? `${t}${sc ? `(${sc})` : ''}: ${tx}` : tx;
    setMessage(b.trim() ? `${head}\n\n${b}` : head);
  };
  const len = subject.length;
  const meter = len <= 50 ? 'good' : len <= 72 ? 'ok' : 'long';

  return (
    <div className="cc" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit) {
        e.preventDefault();
        onCommit();
      }
    }}>
      <div className="cc-types">
        {TYPES.map(([t, ico, desc]) => (
          <button key={t} className={`cc-type ${type === t ? 'on' : ''}`} title={desc} onClick={() => compose(type === t ? null : t, type === t ? '' : scope, text, body)}>
            {ico} {t}
          </button>
        ))}
      </div>
      {type && (
        <div className="cc-scope">
          <span className="small muted">scope</span>
          <input value={scope} onChange={(e) => compose(type, e.target.value.replace(/[()\s]/g, ''), text, body)} placeholder="optional" spellCheck={false} />
          {suggestion && suggestion !== scope && (
            <button className="cc-suggest" onClick={() => compose(type, suggestion, text, body)} title="Suggested from the staged files">
              ✨ {suggestion}
            </button>
          )}
        </div>
      )}
      <div className="cc-subject">
        <input
          ref={subjRef}
          value={subject}
          onChange={(e) => setMessage([e.target.value, ...rest].join('\n'))}
          placeholder={type ? 'what this change does…' : 'Summary (required)'}
          spellCheck
        />
        <span className={`cc-count ${meter}`} title="Keep the summary under 50 characters (72 at most)">
          {len}
        </span>
      </div>
      <div className="cc-meter">
        <span className={meter} style={{ width: `${Math.min(100, (len / 72) * 100)}%` }} />
      </div>
      {showBody ? (
        <textarea rows={3} value={body} onChange={(e) => compose(type, scope, text, e.target.value)} placeholder="Description — why this change, anything reviewers should know…" />
      ) : (
        <button className="cc-addbody" onClick={() => setShowBody(true)}>
          + Add description
        </button>
      )}
      <button className="btn primary block cc-go" disabled={!canCommit} onClick={onCommit} title={blockedReason ?? 'Ctrl+Enter'}>
        {primaryLabel}
      </button>
      <div className="cc-foot small muted">
        {blockedReason ? (
          <span>{blockedReason}</span>
        ) : (
          <>
            to <strong>⎇ {branch ?? 'detached HEAD'}</strong> · {stagedPaths.length} file{stagedPaths.length === 1 ? '' : 's'} <span className="text-ok">+{stagedStats.add}</span> <span className="text-danger">−{stagedStats.del}</span> · <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
          </>
        )}
      </div>
    </div>
  );
}
