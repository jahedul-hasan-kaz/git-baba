import { useEffect, useState } from 'react';
import { Modal, Spinner } from '../components/Modal';
import { Select } from '../components/Select';
import { call } from '../services/api';
import { QUICK_MERGE_EVENT, type QuickMergeRequest } from '../services/quickMerge';
import { useApp } from '../state/AppState';
import { MergeBranchesDialog } from './BranchMergeDialog';

type How = 'direct' | 'bridge' | 'pr';
type Refs = { current: string | null; branches: string[]; remotes: string[] };

const pickMain = (refs: Refs, not?: string) =>
  ['main', 'master', 'develop'].find((b) => b !== not && refs.branches.includes(b)) ?? refs.branches.find((b) => b !== not) ?? '';

/** Opens the simple merge from anywhere (see `requestQuickMerge`). Mounted once per repository view. */
export function QuickMergeHost({ repoId }: { repoId: string }) {
  const [req, setReq] = useState<QuickMergeRequest | null>(null);
  useEffect(() => {
    const on = (e: Event) => setReq((e as CustomEvent<QuickMergeRequest>).detail ?? {});
    window.addEventListener(QUICK_MERGE_EVENT, on);
    return () => window.removeEventListener(QUICK_MERGE_EVENT, on);
  }, []);
  if (!req || !repoId) return null;
  return <QuickMergeDialog key={JSON.stringify(req)} repoId={repoId} initial={req} onClose={() => setReq(null)} />;
}

/** One source, one target: pick them, choose how (merge / new branch + PR / PR only), then the checked merge runs. */
export function QuickMergeDialog({ repoId, initial, onClose }: { repoId: string; initial: QuickMergeRequest; onClose: () => void }) {
  const { bump, setPrDraft, setRepoTab } = useApp();
  const [refs, setRefs] = useState<Refs | null>(null);
  const [source, setSource] = useState(initial.source ?? '');
  const [target, setTarget] = useState(initial.target ?? '');
  const [how, setHow] = useState<How>('direct');
  const [go, setGo] = useState(false);

  useEffect(() => {
    call('graph:refs', { repoId })
      .then((r) => {
        setRefs(r);
        const src = initial.source ?? r.current ?? '';
        setSource(src);
        setTarget((t) => t || (src === r.current ? pickMain(r, src) : r.current ?? pickMain(r, src)));
      })
      .catch(() => setRefs({ current: null, branches: [], remotes: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  if (go && how !== 'pr')
    return (
      <MergeBranchesDialog
        repoId={repoId}
        source={source}
        target={target}
        initialMode={how}
        decided
        onClose={() => setGo(false)}
        onDone={() => {
          bump();
          onClose();
        }}
      />
    );

  const remoteNames = new Set(refs?.remotes.map((r) => r.split('/')[0]) ?? []);
  const shortName = (b: string) => (remoteNames.has(b.split('/')[0]) ? b.slice(b.indexOf('/') + 1) : b);
  const same = !!source && source === target;
  const ready = !!source && !!target && !same;
  const targetIsLocal = !!refs?.branches.includes(target);

  const openPr = () => {
    setPrDraft({ base: shortName(target), head: shortName(source) });
    setRepoTab('pulls');
    onClose();
  };

  const options = (withRemotes: boolean) => (
    <>
      {refs?.branches.length ? (
        <optgroup label="Branches">
          {refs.branches.map((b) => (
            <option key={b} value={b}>
              {b}
              {b === refs.current ? ' (current)' : ''}
            </option>
          ))}
        </optgroup>
      ) : null}
      {withRemotes && refs?.remotes.length ? (
        <optgroup label="Remote branches">
          {refs.remotes.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );

  const cards: [How, string, string, string, string | false][] = [
    ['direct', '⤵', `Merge into ${target || 'target'}`, 'Bring the changes in now, then publish if you like', !targetIsLocal && 'Merging directly needs a local target branch'],
    ['bridge', '⎇', 'New branch + pull request', `${target || 'Target'} stays untouched; the merge lands on a fresh branch for review`, false],
    ['pr', '⇄', `Pull request from ${source ? shortName(source) : 'source'}`, 'No local merge: open a PR on GitHub straight from this branch', false],
  ];

  return (
    <Modal
      title="Merge"
      icon="⤵"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready || (how === 'direct' && !targetIsLocal)} onClick={() => (how === 'pr' ? openPr() : setGo(true))}>
            {how === 'pr' ? 'Continue to pull request →' : 'Check & continue →'}
          </button>
        </>
      }
    >
      {!refs ? (
        <Spinner label="Loading branches…" />
      ) : (
        <div className="qm">
          <div className="qm-flow">
            <label className="qm-side">
              <span className="qm-k">From</span>
              <Select kind="branch" value={source} onChange={(e) => setSource(e.target.value)}>
                {!source && <option value="">Choose a branch…</option>}
                {options(true)}
              </Select>
            </label>
            <button className="qm-swap" title="Swap source and target" disabled={!source || !target} onClick={() => (setSource(target), setTarget(source))}>
              ⇄
            </button>
            <label className="qm-side">
              <span className="qm-k">Into</span>
              <Select kind="branch" value={target} onChange={(e) => setTarget(e.target.value)}>
                {!target && <option value="">Choose a branch…</option>}
                {options(true)}
              </Select>
            </label>
          </div>
          {same && <div className="small text-danger">Pick two different branches.</div>}

          <div className="qm-hows" role="radiogroup" aria-label="How to merge">
            {cards.map(([v, ico, title, sub, off]) => (
              <button key={v} role="radio" aria-checked={how === v} className={`qm-how ${how === v ? 'on' : ''}`} disabled={!!off} title={off || ''} onClick={() => setHow(v)}>
                <span className="qm-how-ico">{ico}</span>
                <span className="qm-how-text">
                  <strong className="ellipsis">{title}</strong>
                  <span className="small muted">{off || sub}</span>
                </span>
                <span className="qm-radio" />
              </button>
            ))}
          </div>
          <div className="small muted">
            Next, both branches are checked for conflicts and remote state before anything changes. Need several branches at once? Use the ✨ Merge Studio in the left sidebar.
          </div>
        </div>
      )}
    </Modal>
  );
}
