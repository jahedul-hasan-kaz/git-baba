import { useState } from 'react';
import type { GraphCommit } from '../../shared/types';
import { Modal } from '../components/Modal';
import { call } from '../services/api';
import { useApp } from '../state/AppState';
import { PublishBranchDialog } from './BranchDialogs';

// Mirrors the main-process branch-name rules so mistakes show while typing.
function nameProblem(name: string, existing: string[]): string | null {
  if (!name) return null;
  if (/\s/.test(name)) return 'Spaces are not allowed — use - or _ instead.';
  if (/[~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(name)) return 'This is not a valid Git branch name.';
  if (existing.includes(name)) return `A branch named ${name} already exists.`;
  return null;
}

/** Creates a branch that starts at a commit chosen in Git History — locally, or published to the remote. */
export function CreateBranchFromCommitDialog({ repoId, commit, existing, onClose, onDone }: { repoId: string; commit: GraphCommit; existing: string[]; onClose: () => void; onDone: () => void }) {
  const { toast, showError, refreshRepos } = useApp();
  const [name, setName] = useState('');
  const [switchTo, setSwitchTo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [publish, setPublish] = useState(false);
  const trimmed = name.trim();
  const problem = nameProblem(trimmed, existing);

  const createLocal = async () => {
    setBusy(true);
    try {
      await call('git:createBranch', { repoId, name: trimmed, startPoint: commit.hash, switchTo });
      toast(`Created ${trimmed} at ${commit.shortHash}${switchTo ? ' and switched to it' : ''}`);
      void refreshRepos();
      onDone();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  if (publish) return <PublishBranchDialog repoId={repoId} name={trimmed} base={commit.hash} onClose={() => setPublish(false)} onDone={onDone} />;

  return (
    <Modal
      size="narrow"
      icon="⎇"
      title="Create branch from commit"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" disabled={!trimmed || !!problem || busy} onClick={createLocal} title="Create the branch on this computer only (nothing is pushed)">
            Create locally
          </button>
          <button className="btn primary" disabled={!trimmed || !!problem || busy} onClick={() => setPublish(true)} title="Create the branch and push it with the authentication you choose">
            Create & Publish…
          </button>
        </>
      }
    >
      <div className="commit-chip mb">
        <span className="mono">{commit.shortHash}</span>
        <span className="grow ellipsis">{commit.subject}</span>
        {commit.branch && <span className="branch-pill">{commit.branch}</span>}
      </div>
      <div className="field">
        <label>New branch name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && trimmed && !problem && !busy && void createLocal()}
          placeholder="feature/my-change"
          spellCheck={false}
          autoFocus
        />
        {problem ? <span className="hint text-danger">{problem}</span> : <span className="hint">The branch starts at this commit; later commits of {commit.branch ?? 'its branch'} are not included.</span>}
      </div>
      <label className="check">
        <input type="checkbox" checked={switchTo} onChange={(e) => setSwitchTo(e.target.checked)} /> Switch to the new branch (uncommitted changes come along)
      </label>
    </Modal>
  );
}
