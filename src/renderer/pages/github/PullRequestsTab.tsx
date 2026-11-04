import { useEffect, useState } from 'react';
import type { GhRepoContext } from '../../../shared/github';
import { useGh } from '../../components/github/common';
import { call } from '../../services/api';
import { useApp } from '../../state/AppState';
import { CreatePr } from './CreatePr';
import { GitHubRepoShell } from './GitHubRepoShell';
import { PrDetail } from './PrDetail';
import { PrList } from './PrList';

export function PullRequestsTab() {
  return <GitHubRepoShell what="Pull requests">{(ctx, repoId) => <PullRequests key={repoId} repoId={repoId} ctx={ctx} />}</GitHubRepoShell>;
}

function PullRequests({ repoId, ctx }: { repoId: string; ctx: GhRepoContext }) {
  const { openPr, setOpenPr, prDraft, setPrDraft } = useApp();
  const [mode, setMode] = useState<'list' | 'create' | 'detail'>(openPr ? 'detail' : prDraft ? 'create' : 'list');
  const [number, setNumber] = useState<number | null>(openPr);
  const [draft, setDraft] = useState<{ base: string; head: string } | null>(prDraft);

  // Deep link into "Open a pull request" with prefilled branches (e.g. from the merge dialog).
  useEffect(() => {
    if (prDraft) {
      setDraft(prDraft);
      setMode('create');
      setPrDraft(null);
    }
  }, [prDraft, setPrDraft]);
  // Labels, milestones, users and branches — loaded once and shared by list, create and detail.
  const metadata = useGh(() => call('gh:prMetadata', { repoId }), [repoId]);

  // Deep link (e.g. from a Dependabot alert) into a specific pull request.
  useEffect(() => {
    if (openPr) {
      setNumber(openPr);
      setMode('detail');
      setOpenPr(null);
    }
  }, [openPr, setOpenPr]);

  if (mode === 'create') {
    return (
      <CreatePr
        key={draft ? `${draft.base}<-${draft.head}` : 'new'}
        repoId={repoId}
        ctx={ctx}
        metadata={metadata.data}
        initialBase={draft?.base}
        initialHead={draft?.head}
        onBranchesChanged={() => void call('gh:prMetadata', { repoId, refresh: true }).then((m) => metadata.setData(m)).catch(() => undefined)}
        onCancel={() => {
          setDraft(null);
          setMode('list');
        }}
        onCreated={(n) => {
          setNumber(n);
          setMode('detail');
        }}
      />
    );
  }
  if (mode === 'detail' && number) {
    return (
      <PrDetail
        key={number}
        repoId={repoId}
        ctx={ctx}
        metadata={metadata.data}
        number={number}
        onBack={() => setMode('list')}
        onMetadataChanged={() => void call('gh:prMetadata', { repoId, refresh: true }).then((m) => metadata.setData(m)).catch(() => undefined)}
      />
    );
  }
  return (
    <PrList
      repoId={repoId}
      ctx={ctx}
      metadata={metadata.data}
      onOpen={(n) => {
        setNumber(n);
        setMode('detail');
      }}
      onCreate={() => setMode('create')}
    />
  );
}
