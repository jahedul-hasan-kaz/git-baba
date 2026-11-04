import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GraphCommit, HistoryActionResult, RebasePreview, ResetMode, ResetPreview, ResetResult } from '../../../shared/types';
import { ErrorPanel } from '../../components/ErrorPanel';
import { relative } from '../../components/FileDiffList';
import { Modal, Spinner } from '../../components/Modal';
import { CreateBranchFromCommitDialog } from '../../dialogs/CreateBranchFromCommitDialog';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';

export type CommitAction =
  | 'cherry-pick'
  | 'revert'
  | 'reset'
  | 'rebase'
  | 'checkout'
  | 'branch'
  | 'tag'
  | 'worktree'
  | 'save-patch'
  | 'copy-patch'
  | 'open-remote'
  | 'copy-sha'
  | 'copy-short'
  | 'copy-message'
  | 'copy-tags';

const SHORT = (h: string) => h.slice(0, 7);

function CommitLine({ c }: { c: Pick<GraphCommit, 'shortHash' | 'subject' | 'author' | 'date'> }) {
  return (
    <div className="ca-commit">
      <span className="mono ca-hash">{c.shortHash}</span>
      <span className="ellipsis grow">{c.subject}</span>
      <span className="small muted">
        {c.author} · {relative(c.date)}
      </span>
    </div>
  );
}

function CommitStack({ commits, mark, max = 8 }: { commits: GraphCommit[]; mark?: Set<string>; max?: number }) {
  if (!commits.length) return null;
  return (
    <div className="ca-stack">
      {commits.slice(0, max).map((c) => (
        <div key={c.hash} className="ca-stack-row">
          <span className="ca-node" />
          <span className="mono small">{c.shortHash}</span>
          <span className="ellipsis grow small">{c.subject}</span>
          {mark?.has(c.hash) && <span className="badge warn">not pushed</span>}
        </div>
      ))}
      {commits.length > max && <div className="small muted ca-more">…and {commits.length - max} more</div>}
    </div>
  );
}

function ResultBanner({ r, onConflicts }: { r: HistoryActionResult; onConflicts: () => void }) {
  return (
    <div className={`banner ${r.outcome === 'conflicts' ? 'warn' : 'ok'}`}>
      <span className="icon">{r.outcome === 'conflicts' ? '⚠' : '✓'}</span>
      <div className="grow">
        <strong>{r.message}</strong>
        {r.conflicted.length > 0 && (
          <div className="mono small" style={{ maxHeight: 120, overflow: 'auto' }}>
            {r.conflicted.map((f) => (
              <div key={f}>! {f}</div>
            ))}
          </div>
        )}
        {r.outcome === 'conflicts' && (
          <button className="btn sm primary mt" onClick={onConflicts}>
            Resolve conflicts now
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Cherry-pick / revert

function ApplyCommitDialog({ repoId, commit, kind, current, onClose, onDone }: { repoId: string; commit: GraphCommit; kind: 'cherry-pick' | 'revert'; current: string | null; onClose: () => void; onDone: () => void }) {
  const { setRepoTab } = useApp();
  const [noCommit, setNoCommit] = useState(false);
  const [mainline, setMainline] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toFriendly> | null>(null);
  const [result, setResult] = useState<HistoryActionResult | null>(null);
  const isMerge = commit.parents.length > 1;
  const pick = kind === 'cherry-pick';

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call(pick ? 'history:cherryPick' : 'history:revert', { repoId, hash: commit.hash, noCommit, mainline: isMerge ? mainline : undefined, confirmed: true });
      setResult(r);
      onDone();
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={pick ? 'Cherry-pick Commit' : 'Revert Commit'}
      icon={pick ? '🍒' : '↶'}
      onClose={onClose}
      locked={busy}
      footer={
        result ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={run} disabled={busy}>
              {busy ? 'Working…' : pick ? `Cherry-pick onto ${current ?? 'HEAD'}` : 'Revert'}
            </button>
          </>
        )
      }
    >
      {result ? (
        <ResultBanner
          r={result}
          onConflicts={() => {
            onClose();
            setRepoTab('conflicts');
          }}
        />
      ) : (
        <>
          <div className="ca-flow">
            <div className="ca-flow-card">
              <div className="small muted">{pick ? 'Copy this commit' : 'Undo this commit'}</div>
              <CommitLine c={commit} />
            </div>
            <div className="ca-flow-arrow">{pick ? '➜' : '↶'}</div>
            <div className="ca-flow-card target">
              <div className="small muted">{pick ? 'onto' : 'with a new commit on'}</div>
              <div className="mono">
                <strong>⎇ {current ?? 'detached HEAD'}</strong>
              </div>
            </div>
          </div>
          <p className="small muted">
            {pick
              ? 'Creates a new commit on your current branch with the same changes. The original commit stays where it is.'
              : 'Creates a new commit that reverses the changes. History is not rewritten, so this is safe for commits that were already pushed.'}
          </p>
          {isMerge && (
            <div className="field">
              <label>This is a merge commit — which side is the mainline?</label>
              <div className="seg">
                {[1, 2].map((m) => (
                  <button key={m} className={mainline === m ? 'on' : ''} onClick={() => setMainline(m as 1 | 2)}>
                    Parent {m} · {commit.parents[m - 1].slice(0, 7)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={noCommit} onChange={(e) => setNoCommit(e.target.checked)} />
            <span>
              <strong>Stage only, don’t commit</strong> — apply the changes so I can review or edit them in Changes first.
            </span>
          </label>
          {error && <ErrorPanel error={error} />}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Reset

const MODES: { mode: ResetMode; title: string; tag: string; branch: string; index: string; files: string; desc: string }[] = [
  { mode: 'soft', title: 'Soft', tag: 'safest', branch: 'moves', index: 'kept + staged', files: 'kept', desc: 'Undo the commits but keep all their changes staged — ready to recommit (e.g. to squash or reword).' },
  { mode: 'mixed', title: 'Mixed', tag: 'default', branch: 'moves', index: 'unstaged', files: 'kept', desc: 'Undo the commits and keep their changes as unstaged edits in your files.' },
  { mode: 'keep', title: 'Keep', tag: 'careful', branch: 'moves', index: 'reset', files: 'updated, your edits kept', desc: 'Move the branch and update files, but keep your uncommitted edits. Stops if they would be overwritten.' },
  { mode: 'hard', title: 'Hard', tag: 'destructive', branch: 'moves', index: 'reset', files: 'replaced', desc: 'Make everything exactly like the chosen commit. Git Baba saves a backup first so you can undo.' },
];

function ResetDialog({ repoId, commit, initialMode = 'mixed', onClose, onDone }: { repoId: string; commit: GraphCommit; initialMode?: ResetMode; onClose: () => void; onDone: (r: ResetResult) => void }) {
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [mode, setMode] = useState<ResetMode>(initialMode);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toFriendly> | null>(null);

  useEffect(() => {
    call('history:resetPreview', { repoId, hash: commit.hash }).then(setPreview).catch((e) => setError(toFriendly(e)));
  }, [repoId, commit.hash]);

  const unpushed = useMemo(() => new Set(preview?.unpushed ?? []), [preview]);
  const dirty = preview ? preview.working.staged + preview.working.unstaged : 0;
  const sameAsHead = preview?.headOid === commit.hash;
  const risky = mode === 'hard' && (unpushed.size > 0 || dirty > 0);
  const word = preview?.branch ?? 'reset';
  const blocked = !preview || sameAsHead || !!preview.operation || (risky && typed !== word);

  const run = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call('history:reset', { repoId, hash: commit.hash, mode, expectedHead: preview.headOid, confirmed: true });
      onDone(r);
    } catch (err) {
      setError(toFriendly(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Reset Branch to Commit"
      icon="⟲"
      size="wide"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          {preview && <span className="small muted grow">↶ A backup is saved — you can undo this reset right after.</span>}
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={`btn ${mode === 'hard' ? 'danger' : 'primary'}`} disabled={blocked || busy} onClick={run}>
            {busy ? 'Resetting…' : `${MODES.find((m) => m.mode === mode)!.title} reset ${preview?.branch ?? 'HEAD'} → ${SHORT(commit.hash)}`}
          </button>
        </>
      }
    >
      {!preview && !error && <Spinner label="Working out what this reset would change…" />}
      {error && <ErrorPanel error={error} />}
      {preview && (
        <>
          <div className="ca-flow">
            <div className="ca-flow-card">
              <div className="small muted">⎇ {preview.branch ?? 'detached HEAD'} is now at</div>
              <div className="mono">{SHORT(preview.headOid)}</div>
            </div>
            <div className="ca-flow-arrow">⟲</div>
            <div className="ca-flow-card target">
              <div className="small muted">will point to</div>
              <CommitLine c={commit} />
            </div>
          </div>
          {sameAsHead && <div className="banner info small">The branch already points to this commit — choose another commit to reset to.</div>}
          {preview.operation && <div className="banner danger small">A {preview.operation} is in progress. Finish or abort it first.</div>}

          <div className="ca-modes">
            {MODES.map((m) => (
              <button key={m.mode} type="button" className={`ca-mode ${m.mode} ${mode === m.mode ? 'on' : ''}`} onClick={() => setMode(m.mode)}>
                <div className="row">
                  <strong className="grow">{m.title}</strong>
                  <span className={`ca-mode-tag ${m.mode}`}>{m.tag}</span>
                </div>
                <div className="ca-lanes">
                  <span title="Branch pointer">⎇ {m.branch}</span>
                  <span title="Staging area">▤ {m.index}</span>
                  <span title="Working files">🗎 {m.files}</span>
                </div>
                <div className="small muted">{m.desc}</div>
              </button>
            ))}
          </div>

          <div className="grid-2" style={{ gap: 16, alignItems: 'start' }}>
            <div>
              <h4>
                {preview.leaving.length} commit{preview.leaving.length === 1 ? '' : 's'} will leave {preview.branch ?? 'HEAD'}
              </h4>
              {preview.leaving.length ? <CommitStack commits={preview.leaving} mark={unpushed} /> : <div className="small muted">None — the branch only moves forward.</div>}
              {preview.arriving.length > 0 && (
                <div className="small muted mt">
                  The target is not in this branch’s history: {preview.arriving.length} commit(s) from elsewhere will become part of it.
                </div>
              )}
            </div>
            <div>
              <h4>Your working folder</h4>
              <div className="ca-wip">
                <span>{preview.working.staged} staged</span>
                <span>{preview.working.unstaged} modified</span>
                <span>{preview.working.untracked} untracked</span>
              </div>
              {mode === 'hard' && dirty > 0 && <div className="small text-warn mt">⚠ {dirty} uncommitted change(s) will be removed from your files — Git Baba keeps a copy for Undo.</div>}
              {mode === 'hard' && preview.working.untracked > 0 && <div className="small muted">Untracked files are left alone.</div>}
              {mode === 'keep' && dirty > 0 && <div className="small muted mt">Your uncommitted edits stay; Git stops if any of them would be overwritten.</div>}
              {unpushed.size > 0 && (
                <div className="small text-warn mt">⚠ {unpushed.size} commit(s) leaving the branch were never pushed. After this reset only the backup (and Undo) still has them.</div>
              )}
              {preview.upstream && preview.leaving.length > unpushed.size && (
                <div className="small muted mt">Some removed commits are already on {preview.upstream}; publishing this branch afterwards would need a force push.</div>
              )}
            </div>
          </div>

          {risky && (
            <div className="field mt">
              <label>
                Type <strong className="mono">{word}</strong> to confirm the hard reset
              </label>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoFocus />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Rebase

function RebaseDialog({ repoId, commit, onClose, onDone }: { repoId: string; commit: GraphCommit; onClose: () => void; onDone: () => void }) {
  const { setRepoTab } = useApp();
  const [p, setP] = useState<RebasePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toFriendly> | null>(null);
  const [result, setResult] = useState<HistoryActionResult | null>(null);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    call('history:rebasePreview', { repoId, onto: commit.hash }).then(setP).catch((e) => setError(toFriendly(e)));
  }, [repoId, commit.hash]);

  const dirty = p ? p.working.staged + p.working.unstaged : 0;
  const needsAck = !!p && p.publishedCount > 0;
  const blocked = !p || p.upToDate || dirty > 0 || (needsAck && !ack);

  const run = async () => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await call('history:rebase', { repoId, onto: commit.hash, expectedHead: p.headOid, confirmed: true }));
      onDone();
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Rebase onto Commit"
      icon="⤴"
      size="wide"
      onClose={onClose}
      locked={busy}
      footer={
        result ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" disabled={blocked || busy} onClick={run}>
              {busy ? 'Rebasing…' : p?.fastForward ? `Fast-forward ${p.branch ?? 'HEAD'}` : `Replay ${p?.replay.length ?? 0} commit(s) onto ${SHORT(commit.hash)}`}
            </button>
          </>
        )
      }
    >
      {error && <ErrorPanel error={error} />}
      {!p && !error && <Spinner label="Working out which commits would be replayed…" />}
      {result && (
        <ResultBanner
          r={result}
          onConflicts={() => {
            onClose();
            setRepoTab('conflicts');
          }}
        />
      )}
      {p && !result && (
        <>
          <div className="ca-rebase">
            <div className="ca-rebase-col">
              <div className="small muted">Your commits on ⎇ {p.branch ?? 'HEAD'}</div>
              {p.replay.length ? <CommitStack commits={p.replay} max={6} /> : <div className="small muted">none to replay</div>}
            </div>
            <div className="ca-flow-arrow">⤴</div>
            <div className="ca-rebase-col">
              <div className="small muted">replayed on top of</div>
              <CommitLine c={commit} />
            </div>
          </div>
          {p.upToDate && <div className="banner info small">{p.branch ?? 'HEAD'} already contains this commit — there is nothing to rebase.</div>}
          {p.fastForward && !p.upToDate && <div className="banner ok small">Your branch has no commits of its own past this point: it simply moves forward. No commits are rewritten.</div>}
          {dirty > 0 && <div className="banner danger small">You have {dirty} uncommitted change(s). Commit or stash them before rebasing.</div>}
          {p.mergesDropped > 0 && <div className="banner warn small">{p.mergesDropped} merge commit(s) are flattened: their changes are kept, but the merge commits themselves are not recreated.</div>}
          {needsAck && (
            <label className="check">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                <strong>{p.publishedCount} of these commits were already pushed.</strong> Rebasing gives them new ids, so publishing afterwards needs a force push and can disrupt others working on this branch.
                I understand.
              </span>
            </label>
          )}
          <p className="small muted">A backup of the current tip is saved before the rebase. If a conflict stops it, you can resolve it or abort to go back exactly to where you were.</p>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Checkout

function CheckoutDialog({ repoId, commit, onClose, onDone, onBranchInstead }: { repoId: string; commit: GraphCommit; onClose: () => void; onDone: () => void; onBranchInstead: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toFriendly> | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      await call('history:checkout', { repoId, hash: commit.hash, confirmed: true });
      onDone();
      onClose();
    } catch (err) {
      setError(toFriendly(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Check Out Commit"
      icon="⎋"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" onClick={onBranchInstead} disabled={busy}>
            ⎇ Create a branch here instead
          </button>
          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? 'Checking out…' : 'Check out (detached HEAD)'}
          </button>
        </>
      }
    >
      <CommitLine c={commit} />
      <div className="banner info small mt">
        <span className="icon">ℹ</span>
        <div>
          Your files will show the project exactly as it was at this commit. You will not be on any branch (<em>detached HEAD</em>): new commits made here are easy to lose unless you create a branch.
          Switch back to a branch any time from Branches.
        </div>
      </div>
      <p className="small muted">Uncommitted changes are carried along when possible; Git refuses if they would be overwritten.</p>
      {error && <ErrorPanel error={error} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Tag

/** Next semantic versions after the newest version-like tag. */
function nextVersions(tags: string[]): string[] {
  const parsed = tags
    .map((t) => /^(v?)(\d+)\.(\d+)\.(\d+)$/.exec(t))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ p: m[1], v: [Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number] }))
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  const top = parsed[0];
  if (!top) return ['v0.1.0', 'v1.0.0'];
  const [M, m, p] = top.v;
  return [`${top.p}${M}.${m}.${p + 1}`, `${top.p}${M}.${m + 1}.0`, `${top.p}${M + 1}.0.0`];
}

function TagDialog({ repoId, commit, tags, onClose, onDone }: { repoId: string; commit: GraphCommit; tags: string[]; onClose: () => void; onDone: (name: string) => void }) {
  const suggestions = useMemo(() => nextVersions(tags), [tags]);
  const [name, setName] = useState('');
  const [annotated, setAnnotated] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toFriendly> | null>(null);
  const exists = tags.includes(name.trim());
  const invalid = !!name && (/[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(name.trim()) || !name.trim());
  const run = async () => {
    setBusy(true);
    try {
      await call('history:createTag', { repoId, hash: commit.hash, name: name.trim(), message: annotated ? message || name.trim() : undefined });
      onDone(name.trim());
      onClose();
    } catch (err) {
      setError(toFriendly(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create Tag"
      icon="🏷"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <span className="small muted grow">The tag is created locally; publish it with ⬆ Push.</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || exists || invalid || busy} onClick={run}>
            {busy ? 'Creating…' : `Tag ${SHORT(commit.hash)}`}
          </button>
        </>
      }
    >
      <CommitLine c={commit} />
      <div className={`field mt ${exists || invalid ? 'invalid' : ''}`}>
        <label>Tag name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.2.0" spellCheck={false} autoFocus onKeyDown={(e) => e.key === 'Enter' && name && !exists && !invalid && run()} />
        <div className="row mt" style={{ gap: 6 }}>
          <span className="small muted">Suggested:</span>
          {suggestions.map((s, i) => (
            <button key={s} type="button" className={`ca-suggest ${name === s ? 'on' : ''}`} onClick={() => setName(s)} title={['Patch release', 'Minor release', 'Major release'][i] ?? ''}>
              {s}
            </button>
          ))}
        </div>
        {exists && <div className="small text-danger">A tag with this name already exists.</div>}
        {invalid && !exists && <div className="small text-danger">Not a valid tag name (no spaces, “..”, “~ ^ : ? * [ \\”).</div>}
      </div>
      <div className="seg mb">
        <button className={annotated ? 'on' : ''} onClick={() => setAnnotated(true)} title="Stores who tagged it, when, and a message — recommended for releases">
          📝 Annotated
        </button>
        <button className={!annotated ? 'on' : ''} onClick={() => setAnnotated(false)} title="Just a name pointing at the commit">
          🏷 Lightweight
        </button>
      </div>
      {annotated && (
        <div className="field">
          <label>Message</label>
          <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={name ? `Release ${name}` : 'What this tag marks…'} />
        </div>
      )}
      {error && <ErrorPanel error={error} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Worktree

function WorktreeDialog({ repoId, commit, branches, onClose, onDone }: { repoId: string; commit: GraphCommit; branches: string[]; onClose: () => void; onDone: (path: string) => void }) {
  const [dir, setDir] = useState('');
  const [withBranch, setWithBranch] = useState(true);
  const [branch, setBranch] = useState(`wt/${commit.shortHash}`);
  const [list, setList] = useState<{ path: string; head: string | null; branch: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toFriendly> | null>(null);
  useEffect(() => {
    call('history:worktrees', { repoId }).then(setList).catch(() => setList([]));
  }, [repoId]);
  const branchTaken = withBranch && branches.includes(branch.trim());
  const pick = async () => {
    try {
      const d = await call('history:pickWorktreeDir', { repoId });
      if (d) setDir(d);
    } catch (err) {
      setError(toFriendly(err));
    }
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = await call('history:addWorktree', { repoId, hash: commit.hash, path: dir, branch: withBranch ? branch.trim() : undefined });
      onDone(r.path);
      onClose();
    } catch (err) {
      setError(toFriendly(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create Worktree"
      icon="🌲"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!dir || busy || branchTaken || (withBranch && !branch.trim())} onClick={run}>
            {busy ? 'Creating…' : 'Create worktree'}
          </button>
        </>
      }
    >
      <p className="small muted">A worktree is a second working folder for this repository: work on this commit side by side without stashing or switching branches here.</p>
      <CommitLine c={commit} />
      <div className="field mt">
        <label>Folder</label>
        <div className="row">
          <input className="grow mono" value={dir} readOnly placeholder="Choose an empty folder…" onClick={pick} />
          <button className="btn" onClick={pick}>
            📂 Browse…
          </button>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={withBranch} onChange={(e) => setWithBranch(e.target.checked)} /> Start a new branch there
      </label>
      {withBranch && (
        <div className={`field ${branchTaken ? 'invalid' : ''}`}>
          <input className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
          {branchTaken && <div className="small text-danger">That branch already exists.</div>}
        </div>
      )}
      {!withBranch && <div className="small muted">The worktree will be on a detached HEAD at {commit.shortHash}.</div>}
      {list.length > 1 && (
        <>
          <h4 className="mt">Existing worktrees</h4>
          <div className="ca-stack">
            {list.map((w) => (
              <div key={w.path} className="ca-stack-row">
                <span className="ca-node" />
                <span className="mono small ellipsis grow" title={w.path}>
                  {w.path}
                </span>
                <span className="small muted">{w.branch ?? (w.head ? SHORT(w.head) : '')}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {error && <ErrorPanel error={error} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Controller

interface Ctx {
  repoId: string;
  current: string | null;
  branches: string[];
  tags: string[];
  onChanged: () => void;
}

/** One place that runs every commit action (dialogs, copies, links) and shows the reset Undo bar. */
export function useCommitActions({ repoId, current, branches, tags, onChanged }: Ctx) {
  const { toast, showError } = useApp();
  const [open, setOpen] = useState<{ action: CommitAction; commit: GraphCommit; mode?: string } | null>(null);
  const [lastReset, setLastReset] = useState<ResetResult | null>(null);
  const [undoing, setUndoing] = useState(false);

  const copy = async (text: string, what: string) => {
    try {
      await call('app:copyText', { text });
      toast(`${what} copied`);
    } catch (err) {
      showError(err);
    }
  };

  const run = async (action: CommitAction, commit: GraphCommit, opts?: { mode?: string }) => {
    try {
      switch (action) {
        case 'copy-sha':
          return copy(commit.hash, 'Commit SHA');
        case 'copy-short':
          return copy(commit.shortHash, 'Short SHA');
        case 'copy-message': {
          const d = await call('graph:commit', { repoId, hash: commit.hash });
          return copy(d.body ? `${d.subject}\n\n${d.body}` : d.subject, 'Commit message');
        }
        case 'copy-tags': {
          const t = commit.refs.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5));
          return t.length ? copy(t.join('\n'), t.length > 1 ? `${t.length} tags` : `Tag ${t[0]}`) : toast('This commit has no tag', 'info');
        }
        case 'copy-patch': {
          const r = await call('history:copyPatch', { repoId, hash: commit.hash });
          return toast(`Patch copied (${Math.max(1, Math.round(r.bytes / 1024))} KB)`);
        }
        case 'save-patch': {
          const r = await call('history:savePatch', { repoId, hash: commit.hash });
          return r && toast(`Patch saved to ${r.path}`);
        }
        case 'open-remote': {
          const r = await call('history:remoteUrl', { repoId, hash: commit.hash });
          if (!r.url) return toast('No GitHub-style remote is configured for this repository', 'warning');
          if (!r.onRemote) toast(`Heads up: ${r.remote} may not have this commit yet (not pushed)`, 'info');
          return call('shell:openExternal', { url: r.url });
        }
        default:
          setOpen({ action, commit, mode: opts?.mode });
      }
    } catch (err) {
      showError(err);
    }
  };

  const close = () => setOpen(null);
  const done = () => onChanged();

  const undo = async () => {
    if (!lastReset) return;
    setUndoing(true);
    try {
      await call('history:undoReset', { repoId, previousOid: lastReset.previousOid, mode: lastReset.mode, wipRef: lastReset.wipRef, confirmed: true });
      toast(`Reset undone — back at ${SHORT(lastReset.previousOid)}`);
      setLastReset(null);
      onChanged();
    } catch (err) {
      showError(err);
    } finally {
      setUndoing(false);
    }
  };

  let dialog: ReactNode = null;
  if (open) {
    const { action, commit } = open;
    if (action === 'cherry-pick' || action === 'revert') dialog = <ApplyCommitDialog repoId={repoId} commit={commit} kind={action} current={current} onClose={close} onDone={done} />;
    else if (action === 'reset')
      dialog = (
        <ResetDialog
          repoId={repoId}
          commit={commit}
          initialMode={(['soft', 'mixed', 'keep', 'hard'] as const).find((m) => m === open.mode)}
          onClose={close}
          onDone={(r) => {
            setLastReset(r);
            close();
            onChanged();
          }}
        />
      );
    else if (action === 'rebase') dialog = <RebaseDialog repoId={repoId} commit={commit} onClose={close} onDone={done} />;
    else if (action === 'checkout') dialog = <CheckoutDialog repoId={repoId} commit={commit} onClose={close} onDone={done} onBranchInstead={() => setOpen({ action: 'branch', commit })} />;
    else if (action === 'tag') dialog = <TagDialog repoId={repoId} commit={commit} tags={tags} onClose={close} onDone={(n) => (toast(`Tag ${n} created`), onChanged())} />;
    else if (action === 'worktree') dialog = <WorktreeDialog repoId={repoId} commit={commit} branches={branches} onClose={close} onDone={(p) => (toast(`Worktree created at ${p}`), onChanged())} />;
    else if (action === 'branch')
      dialog = (
        <CreateBranchFromCommitDialog
          repoId={repoId}
          commit={commit}
          existing={branches}
          onClose={close}
          onDone={() => {
            close();
            onChanged();
          }}
        />
      );
  }

  const undoBar = lastReset ? (
    <div className="ca-undo">
      <span className="ca-undo-ico">⟲</span>
      <span className="grow small">
        <strong>{lastReset.mode[0].toUpperCase() + lastReset.mode.slice(1)} reset</strong> {SHORT(lastReset.previousOid)} → {SHORT(lastReset.newOid)}
        {lastReset.wipRef ? ' · uncommitted changes saved' : ''} <span className="muted">· backup {lastReset.backupRef.replace('refs/gitbaba/backups/', '')}</span>
      </span>
      <button className="btn sm primary" onClick={undo} disabled={undoing}>
        {undoing ? 'Undoing…' : '↶ Undo reset'}
      </button>
      <button className="btn sm ghost" onClick={() => setLastReset(null)} title="Dismiss (the backup reference stays)">
        ✕
      </button>
    </div>
  ) : null;

  return { run, dialog, undoBar };
}
