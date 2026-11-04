import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftReviewComment, GhRepoContext, PrCommit, PrDetails, PrFilesResult, RepoMetadata, ReviewEvent, TimelineEvent } from '../../../shared/github';
import type { CommitDetails, FriendlyError } from '../../../shared/types';
import { DiffViewer } from '../../components/DiffViewer';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Avatar, LabelChip, Picker, relTime, ReviewBadge, Skeleton, useGh, useMutation } from '../../components/github/common';
import { Markdown } from '../../components/Markdown';
import { Modal, Spinner } from '../../components/Modal';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';
import { BrowserSignIn } from '../../components/github/BrowserSignIn';
import { MergeDialog } from './MergeDialog';
import { PrFiles, ThreadView } from './PrFiles';
import { ChecksSecurity } from './pr/ChecksSecurity';
import { CHECK_STATE, CommitsTimeline } from './pr/CommitsTimeline';
import { isTokenProblem, useGhCli } from './pr/ghCli';
import { MergeStatusPanel } from './pr/MergeStatusPanel';
import { PrHero } from './pr/PrHero';

/** Markdown body for descriptions and comments; links open in the browser, never in the app window. */
function MdBody({ text, empty = 'No description provided.' }: { text: string; empty?: string }) {
  if (!text.trim()) return <div className="muted small" style={{ fontStyle: 'italic' }}>{empty}</div>;
  return <Markdown source={text} onLink={(href) => /^https?:\/\//i.test(href) && void call('shell:openExternal', { url: href }).catch(() => undefined)} />;
}

type Tab = 'conversation' | 'commits' | 'checks' | 'files';

interface Props {
  repoId: string;
  ctx: GhRepoContext;
  metadata: RepoMetadata | null;
  number: number;
  onBack: () => void;
  onMetadataChanged: () => void;
}

export function PrDetail({ repoId, ctx, metadata, number, onBack, onMetadataChanged }: Props) {
  const { bump } = useApp();
  const [commitOpen, setCommitOpen] = useState<PrCommit | null>(null);
  const [checksCommit, setChecksCommit] = useState<string | null>(null);
  const mergeRef = useRef<HTMLDivElement>(null);
  const details = useGh(() => call('gh:prDetails', { repoId, number }), [repoId, number]);
  const [tab, setTab] = useState<Tab>('conversation');
  const [pending, setPendingState] = useState<DraftReviewComment[]>([]);
  const setPending = useCallback((fn: (p: DraftReviewComment[]) => DraftReviewComment[]) => setPendingState(fn), []);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState<'closed' | 'open' | null>(null);
  const [files, setFiles] = useState<PrFilesResult | null>(null);
  const { run } = useMutation();

  if (details.error) {
    return (
      <div className="content">
        <button className="btn sm ghost mb" onClick={onBack}>
          ← Pull requests
        </button>
        <ErrorPanel error={details.error} onAction={() => details.reload()} available={['retry']} />
        {['not-found', 'forbidden', 'pat-permission', 'session-required', 'session-expired'].includes(details.error.code) && (
          <div className="card mt" style={{ maxWidth: 560 }}>
            <BrowserSignIn repoId={repoId} onDone={() => void details.reload()} compact />
          </div>
        )}
      </div>
    );
  }
  const pr = details.data;
  if (!pr) return <div className="content"><Skeleton rows={8} /></div>;

  const refresh = () => void details.reload();
  const refreshAll = () => {
    void details.reload();
    bump();
  };
  const checkState = pr.checksSummary.total === 0 ? null : pr.checksSummary.failed ? 'FAILURE' : pr.checksSummary.pending ? 'PENDING' : 'SUCCESS';
  const perms = pr.permissions;

  return (
    <div className="content" style={{ paddingTop: 10 }}>
      <PrHero
        repoId={repoId}
        pr={pr}
        ctx={ctx}
        onRefresh={refreshAll}
        onBack={onBack}
        onShowMerge={() => {
          setTab('conversation');
          setTimeout(() => mergeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
        }}
      />

      <div className="tabs" style={{ background: 'transparent', padding: 0, marginBottom: 12 }}>
        {(
          [
            ['conversation', `Conversation`, pr.comments],
            ['commits', 'Commits', pr.commits],
            ['checks', 'Checks & security', pr.checksSummary.total],
            ['files', 'Files changed', pr.changedFiles],
          ] as [Tab, string, number][]
        ).map(([id, label, n]) => (
          <div key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {id === 'checks' && checkState && <span className={`text-${CHECK_STATE[checkState].cls}`}>{CHECK_STATE[checkState].icon}</span>}
            {label} <span className="badge">{n}</span>
          </div>
        ))}
        <span className="spacer" />
        {pr.state === 'OPEN' && (
          <button className="btn sm primary" style={{ alignSelf: 'center', marginLeft: 10 }} onClick={() => setReviewOpen(true)}>
            {pending.length ? `Finish your review (${pending.length})` : 'Review changes'}
          </button>
        )}
      </div>

      {tab === 'files' ? (
        <PrFiles repoId={repoId} pr={pr} pending={pending} setPending={setPending} onChanged={refresh} onFinishReview={() => setReviewOpen(true)} onFilesLoaded={setFiles} />
      ) : (
        <div className="pr-detail-grid">
          <div style={{ minWidth: 0 }}>
            {tab === 'conversation' && (
              <Conversation
                repoId={repoId}
                pr={pr}
                ctx={ctx}
                mergeRef={mergeRef}
                onChanged={refresh}
                onMerge={() => setMergeOpen(true)}
                onCloseReopen={(s) => setCloseConfirm(s)}
                onShowChecks={() => setTab('checks')}
              />
            )}
            {tab === 'commits' && (
              <CommitsTimeline
                repoId={repoId}
                pr={pr}
                onOpen={setCommitOpen}
                onChecks={(oid) => {
                  setChecksCommit(oid);
                  setTab('checks');
                }}
              />
            )}
            {tab === 'checks' && <ChecksSecurity repoId={repoId} pr={pr} metadata={metadata} canWrite={perms.canWrite} initialCommit={checksCommit} onChanged={refresh} />}
          </div>
          <Sidebar repoId={repoId} pr={pr} metadata={metadata} onChanged={refresh} onMetadataChanged={onMetadataChanged} />
        </div>
      )}

      {reviewOpen && (
        <ReviewSubmitDialog
          repoId={repoId}
          pr={pr}
          pending={pending}
          files={files}
          onRemove={(c) => setPending((p) => p.filter((x) => x !== c))}
          onClose={() => setReviewOpen(false)}
          onSubmitted={() => {
            setPendingState([]);
            setReviewOpen(false);
            refresh();
          }}
        />
      )}
      {commitOpen && <CommitModal repoId={repoId} oid={commitOpen.oid} message={commitOpen.message} prUrl={pr.url} onClose={() => setCommitOpen(null)} />}
      {mergeOpen && (
        <MergeDialog
          repoId={repoId}
          number={number}
          onClose={() => {
            setMergeOpen(false);
            refresh();
          }}
          onMerged={() => {
            refresh();
            bump();
          }}
        />
      )}
      {closeConfirm && (
        <ConfirmDialog
          title={closeConfirm === 'closed' ? 'Close Pull Request' : 'Reopen Pull Request'}
          explanation={closeConfirm === 'closed' ? <>Closes #{number} without merging. It can be reopened later.</> : <>Reopens #{number}.</>}
          impact="No code is merged, pushed or deleted."
          confirmLabel={closeConfirm === 'closed' ? 'Close pull request' : 'Reopen pull request'}
          onCancel={() => setCloseConfirm(null)}
          onConfirm={async () => {
            await run(() => call('gh:prState', { repoId, number, state: closeConfirm, confirmed: true }), closeConfirm === 'closed' ? 'Pull request closed' : 'Pull request reopened');
            setCloseConfirm(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function Conversation({
  repoId,
  pr,
  ctx,
  mergeRef,
  onChanged,
  onMerge,
  onCloseReopen,
  onShowChecks,
}: {
  repoId: string;
  pr: PrDetails;
  ctx: GhRepoContext;
  mergeRef: React.RefObject<HTMLDivElement | null>;
  onChanged: () => void;
  onMerge: () => void;
  onCloseReopen: (s: 'closed' | 'open') => void;
  onShowChecks: () => void;
}) {
  const [comment, setComment] = useState('');
  const [preview, setPreview] = useState(false);
  const [viaCli, setViaCli] = useState(false);
  const cli = useGhCli(repoId, pr.number, onChanged);
  const [editBody, setEditBody] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const { busy, run } = useMutation();
  const unresolved = pr.reviewThreads.filter((t) => !t.isResolved);

  const post = async () => {
    if (!comment.trim()) return;
    if (viaCli) {
      if (await cli.run('comment', { body: comment }, 'Comment added with GitHub CLI')) {
        setComment('');
        setPreview(false);
      }
      return;
    }
    try {
      await call('gh:prComment', { repoId, number: pr.number, body: comment });
      setComment('');
      setPreview(false);
      onChanged();
    } catch (err) {
      // Token not allowed to comment: offer the GitHub CLI right here.
      if (isTokenProblem(toFriendly(err).code)) setViaCli(true);
      await run(() => Promise.reject(err));
    }
  };

  return (
    <div className="tl">
      <div className="timeline-card tl-item">
        <span className="tl-avatar">
          <Avatar login={pr.author?.login} size={30} />
        </span>
        <div className="timeline-head">
          <strong>{pr.author?.login ?? 'ghost'}</strong>
          <span className="muted small">commented {relTime(pr.createdAt)}</span>
          <span className="spacer" />
          {pr.viewerCanUpdate && editBody === null && (
            <button className="btn sm ghost" onClick={() => setEditBody(pr.body)}>
              Edit
            </button>
          )}
        </div>
        <div className="timeline-body">
          {editBody !== null ? (
            <div className="inline-composer">
              <textarea rows={8} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
              <div className="row">
                <span className="spacer" />
                <button className="btn sm" onClick={() => setEditBody(null)}>
                  Cancel
                </button>
                <button
                  className="btn sm primary"
                  disabled={busy}
                  onClick={() =>
                    run(() => call('gh:prEdit', { repoId, number: pr.number, body: editBody }), 'Description updated').then((r) => {
                      if (r !== undefined) {
                        setEditBody(null);
                        onChanged();
                      }
                    })
                  }
                >
                  Update description
                </button>
              </div>
            </div>
          ) : (
            <MdBody text={pr.body} />
          )}
        </div>
      </div>

      {pr.timeline.map((e: TimelineEvent, i) => {
        if (e.type === 'comment') {
          const c = e.comment;
          return (
            <div key={i} className="timeline-card tl-item">
              <span className="tl-avatar">
                <Avatar login={c.author?.login} size={30} />
              </span>
              <div className="timeline-head">
                <strong>{c.author?.login ?? 'ghost'}</strong>
                <span className="muted small">commented {relTime(c.createdAt)}</span>
                {c.updatedAt !== c.createdAt && <span className="muted small">· edited</span>}
                <span className="spacer" />
                {c.viewerCanUpdate && editing?.id !== c.databaseId && (
                  <button className="btn sm ghost" onClick={() => setEditing({ id: c.databaseId, body: c.body })}>
                    Edit
                  </button>
                )}
              </div>
              <div className="timeline-body">
                {editing?.id === c.databaseId ? (
                  <div className="inline-composer">
                    <textarea rows={4} value={editing.body} onChange={(ev) => setEditing({ id: c.databaseId, body: ev.target.value })} />
                    <div className="row">
                      <span className="spacer" />
                      <button className="btn sm" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                      <button
                        className="btn sm primary"
                        disabled={busy || !editing.body.trim()}
                        onClick={() =>
                          run(() => call('gh:prEditComment', { repoId, kind: 'issue', databaseId: c.databaseId, body: editing.body }), 'Comment updated').then((r) => {
                            if (r !== undefined) {
                              setEditing(null);
                              onChanged();
                            }
                          })
                        }
                      >
                        Update comment
                      </button>
                    </div>
                  </div>
                ) : (
                  <MdBody text={c.body} empty="(empty)" />
                )}
              </div>
            </div>
          );
        }
        if (e.type === 'review') {
          const label = e.state === 'APPROVED' ? 'approved these changes' : e.state === 'CHANGES_REQUESTED' ? 'requested changes' : e.state === 'DISMISSED' ? 'review was dismissed' : 'reviewed';
          return (
            <div key={i} className={`timeline-event tl-event review-${e.state.toLowerCase()}`}>
              <span className={`tl-badge ${e.state === 'APPROVED' ? 'ok' : e.state === 'CHANGES_REQUESTED' ? 'danger' : ''}`}>{e.state === 'APPROVED' ? '✓' : e.state === 'CHANGES_REQUESTED' ? '✕' : '👁'}</span>
              <Avatar login={e.author?.login} size={18} />
              <span className="grow">
                <strong>{e.author?.login ?? 'ghost'}</strong> {label} <span className="muted">{relTime(e.at)}</span>
                {e.body && (
                  <div className="tl-review-body">
                    <MdBody text={e.body} />
                  </div>
                )}
              </span>
            </div>
          );
        }
        if (e.type === 'commit') {
          return (
            <div key={i} className="timeline-event tl-event">
              <span className="tl-badge">●</span>
              <span className="small">
                <span className="mono muted">{e.oid.slice(0, 7)}</span> {e.message} <span className="muted">— {e.author}</span>
              </span>
            </div>
          );
        }
        return (
          <div key={i} className="timeline-event tl-event small muted">
            <span className="tl-badge">•</span>
            <span>
              <strong>{e.actor ?? 'someone'}</strong> {e.text} {relTime(e.at)}
            </span>
          </div>
        );
      })}

      {pr.reviewThreads.length > 0 && (
        <div className="card">
          <h3>
            Review conversations <span className="badge">{pr.reviewThreads.length}</span> {unresolved.length > 0 && <span className="badge warn">{unresolved.length} unresolved</span>}
          </h3>
          {pr.reviewThreads.map((t) => (
            <ThreadView key={t.id} repoId={repoId} pr={pr} thread={t} onChanged={onChanged} />
          ))}
        </div>
      )}

      <MergeStatusPanel ref={mergeRef} repoId={repoId} pr={pr} ctx={ctx} onMerge={onMerge} onRefresh={onChanged} onShowChecks={onShowChecks} />

      <div className="timeline-card composer">
        <div className="timeline-head">
          <div className="segmented sm">
            <button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>
              Write
            </button>
            <button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
          <span className="spacer" />
          <span className="small muted">Markdown supported · Ctrl+Enter to post</span>
        </div>
        <div className="timeline-body">
          {preview ? (
            <div className="composer-preview">
              <MdBody text={comment} empty="Nothing to preview." />
            </div>
          ) : (
            <textarea
              rows={4}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && void post()}
              placeholder="Leave a comment"
            />
          )}
          <div className="row mt">
            <label className="check small" style={{ margin: 0 }} title="Post through your own gh login instead of the signed-in account token">
              <input type="checkbox" checked={viaCli} onChange={(e) => setViaCli(e.target.checked)} /> post with GitHub CLI
            </label>
            <span className="spacer" />
            {pr.viewerCanUpdate && pr.state !== 'MERGED' && (
              <button className="btn" onClick={() => onCloseReopen(pr.state === 'OPEN' ? 'closed' : 'open')}>
                {pr.state === 'OPEN' ? 'Close pull request' : 'Reopen pull request'}
              </button>
            )}
            <button className="btn primary" disabled={busy || !!cli.busy || !comment.trim()} onClick={() => void post()}>
              {cli.busy === 'comment' ? 'Posting…' : 'Comment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

function CommitModal({ repoId, oid, message, prUrl, onClose }: { repoId: string; oid: string; message: string; prUrl: string; onClose: () => void }) {
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  useEffect(() => {
    let live = true;
    call('graph:commit', { repoId, hash: oid })
      .then((d) => live && setDetails(d))
      .catch((err) => live && setError(toFriendly(err)));
    return () => {
      live = false;
    };
  }, [repoId, oid]);
  return (
    <Modal title={`Commit ${oid.slice(0, 7)}`} size="wide" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <pre className="commit-body">{message}</pre>
      {!details && !error && <Spinner label="Loading commit from your local repository…" />}
      {error && (
        <div className="banner info">
          <span className="icon">ℹ</span>
          <div className="grow">This commit is not in your local repository yet (fetch the branch to see its diff here).</div>
          <button className="btn sm" onClick={() => call('shell:openExternal', { url: `${prUrl}/commits/${oid}` }).catch(() => undefined)}>
            View on GitHub
          </button>
        </div>
      )}
      {details && (
        <>
          <div className="small muted mb">
            {details.files.length} file(s) · <span className="text-ok">+{details.additions}</span> <span className="text-danger">−{details.deletions}</span> · {details.author} {new Date(details.date).toLocaleString()}
          </div>
          {details.diffs.map((d) => (
            <div key={d.newPath + d.oldPath} className="file-card">
              <DiffViewer diff={d} />
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function Sidebar({ repoId, pr, metadata, onChanged, onMetadataChanged }: { repoId: string; pr: PrDetails; metadata: RepoMetadata | null; onChanged: () => void; onMetadataChanged: () => void }) {
  const { run } = useMutation();
  const triage = pr.permissions.canTriage;
  const noTriage = 'You need triage (or higher) access to change this.';
  const users = (metadata?.assignableUsers ?? []).map((u) => ({ value: u.login, label: u.login }));
  const reviewerState = new Map(pr.latestReviews.map((r) => [r.author, r.state]));
  const reviewers = [...new Set([...pr.requestedReviewers, ...pr.latestReviews.map((r) => r.author)])];

  const diff = (next: string[], prev: string[]) => ({ add: next.filter((x) => !prev.includes(x)), remove: prev.filter((x) => !next.includes(x)) });

  return (
    <div className="pr-sidebar">
      <div className="sidebar-block">
        <Picker
          title="Reviewers"
          multi
          disabled={!triage}
          disabledReason={noTriage}
          options={users.filter((u) => u.value !== pr.author?.login)}
          selected={pr.requestedReviewers}
          onChange={(v) => {
            const d = diff(v, pr.requestedReviewers);
            void run(() => call('gh:prReviewers', { repoId, number: pr.number, ...d }), 'Reviewers updated').then(onChanged);
          }}
        />
        {reviewers.length === 0 && <span className="small muted">No reviews</span>}
        {reviewers.map((r) => {
          const s = reviewerState.get(r);
          return (
            <div key={r} className="row small">
              <Avatar login={r} size={16} /> <span className="grow">{r}</span>
              <span className={s === 'APPROVED' ? 'text-ok' : s === 'CHANGES_REQUESTED' ? 'text-danger' : 'muted'} title={s ?? 'Awaiting review'}>
                {s === 'APPROVED' ? '✓' : s === 'CHANGES_REQUESTED' ? '✕' : s === 'COMMENTED' ? '💬' : '●'}
              </span>
            </div>
          );
        })}
        <ReviewBadge decision={pr.reviewDecision} />
      </div>
      <div className="sidebar-block">
        <Picker
          title="Assignees"
          multi
          disabled={!triage}
          disabledReason={noTriage}
          options={users}
          selected={pr.assignees.map((a) => a.login)}
          onChange={(v) => {
            const d = diff(
              v,
              pr.assignees.map((a) => a.login),
            );
            void run(() => call('gh:prAssignees', { repoId, number: pr.number, ...d }), 'Assignees updated').then(onChanged);
          }}
        />
        {pr.assignees.length === 0 ? <span className="small muted">No one assigned</span> : pr.assignees.map((a) => <div key={a.login} className="row small"><Avatar login={a.login} size={16} /> {a.login}</div>)}
      </div>
      <div className="sidebar-block">
        <Picker
          title="Labels"
          multi
          disabled={!triage}
          disabledReason={noTriage}
          options={(metadata?.labels ?? []).map((l) => ({ value: l.name, label: l.name, color: l.color, hint: l.description ?? undefined }))}
          selected={pr.labels.map((l) => l.name)}
          onChange={(v) => void run(() => call('gh:prLabels', { repoId, number: pr.number, labels: v }), 'Labels updated').then(onChanged)}
          onCreate={
            pr.permissions.canWrite
              ? (name) => {
                  const color = Math.floor(Math.random() * 0xffffff)
                    .toString(16)
                    .padStart(6, '0');
                  void run(() => call('gh:labelCreate', { repoId, name, color }), `Label “${name}” created`)
                    .then(() => call('gh:prLabels', { repoId, number: pr.number, labels: [...pr.labels.map((l) => l.name), name] }))
                    .then(() => {
                      onMetadataChanged();
                      onChanged();
                    });
                }
              : undefined
          }
          createLabel="Create label"
        />
        <div className="row wrap">{pr.labels.length ? pr.labels.map((l) => <LabelChip key={l.name} label={l} />) : <span className="small muted">None yet</span>}</div>
      </div>
      <div className="sidebar-block">
        <Picker
          title="Milestone"
          disabled={!triage}
          disabledReason={noTriage}
          allowClear
          options={(metadata?.milestones ?? []).map((m) => ({ value: String(m.number), label: m.title, hint: m.dueOn ? `due ${new Date(m.dueOn).toLocaleDateString()}` : undefined }))}
          selected={(metadata?.milestones ?? []).filter((m) => m.title === pr.milestone).map((m) => String(m.number))}
          onChange={(v) => void run(() => call('gh:prMilestone', { repoId, number: pr.number, milestone: v[0] ? Number(v[0]) : null }), 'Milestone updated').then(onChanged)}
        />
        <span className="small muted">{pr.milestone ?? 'No milestone'}</span>
      </div>
      <div className="sidebar-block">
        <div className="sidebar-title-static">Linked issues</div>
        {pr.linkedIssues.length === 0 ? (
          <span className="small muted">Use “Closes #123” in the description to link issues.</span>
        ) : (
          pr.linkedIssues.map((i) => (
            <div key={i.number} className="small">
              <a onClick={() => call('shell:openExternal', { url: i.url }).catch(() => undefined)}>
                #{i.number} {i.title}
              </a>{' '}
              <span className="muted">({i.state.toLowerCase()})</span>
            </div>
          ))
        )}
      </div>
      {!triage && <div className="small muted">Your role ({pr.permissions.level.toLowerCase()}) can view this pull request but not change its metadata.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review submission
// ---------------------------------------------------------------------------

function ReviewSubmitDialog({
  repoId,
  pr,
  pending,
  files,
  onRemove,
  onClose,
  onSubmitted,
}: {
  repoId: string;
  pr: PrDetails;
  pending: DraftReviewComment[];
  files: PrFilesResult | null;
  onRemove: (c: DraftReviewComment) => void;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [body, setBody] = useState('');
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenBlocked, setTokenBlocked] = useState(false);
  const cli = useGhCli(repoId, pr.number, onSubmitted);
  const own = pr.viewerDidAuthor;
  const needsSure = event !== 'COMMENT';
  const empty = event !== 'APPROVE' && !body.trim() && pending.length === 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('gh:prSubmitReview', { repoId, number: pr.number, commitId: files?.headOid ?? pr.headRefOid, event, body, comments: pending, confirmed: true });
      onSubmitted();
    } catch (err) {
      const f = toFriendly(err);
      setError(f);
      if (isTokenProblem(f.code)) setTokenBlocked(true);
    } finally {
      setBusy(false);
    }
  };
  // gh cannot attach line comments, so it is offered for summary-only reviews.
  const submitWithCli = () =>
    void cli.run(event === 'APPROVE' ? 'approve' : event === 'REQUEST_CHANGES' ? 'request-changes' : 'review-comment', { body }, event === 'APPROVE' ? 'Approved with GitHub CLI' : event === 'REQUEST_CHANGES' ? 'Changes requested with GitHub CLI' : 'Review posted with GitHub CLI');

  return (
    <Modal
      title="Finish your review"
      size="wide"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <span className="small muted grow">Nothing is posted until you click Submit review.</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Keep reviewing
          </button>
          <button
            className="btn"
            disabled={busy || !!cli.busy || empty || (needsSure && !sure) || pending.length > 0 || (event !== 'APPROVE' && !body.trim())}
            onClick={submitWithCli}
            title={pending.length ? 'The GitHub CLI cannot post line comments — remove them or submit normally' : 'Submit through your own gh login'}
          >
            {cli.busy ? 'Submitting…' : tokenBlocked ? '⌨ Submit with GitHub CLI (recommended)' : '⌨ Submit with gh'}
          </button>
          <button className={`btn ${event === 'REQUEST_CHANGES' ? 'danger solid' : 'primary'}`} disabled={busy || empty || (needsSure && !sure)} onClick={submit}>
            {busy ? 'Submitting…' : 'Submit review'}
          </button>
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      <div className="grid-2" style={{ gap: 20, alignItems: 'start' }}>
        <div>
          <h4>Review summary</h4>
          <dl className="kv">
            <dt>Pull request</dt>
            <dd>
              #{pr.number} {pr.title}
            </dd>
            <dt>Changed files</dt>
            <dd>{pr.changedFiles}</dd>
            <dt>Pending comments</dt>
            <dd>{pending.length}</dd>
            <dt>Existing comments</dt>
            <dd>
              {pr.reviewThreads.reduce((n, t) => n + t.comments.length, 0)} in {pr.reviewThreads.length} conversation(s)
            </dd>
            <dt>Checks</dt>
            <dd>
              {pr.checksSummary.total === 0 ? 'none' : `${pr.checksSummary.passed} passed · ${pr.checksSummary.failed} failed · ${pr.checksSummary.pending} pending`}
            </dd>
            <dt>Reviewed commit</dt>
            <dd className="mono">{(files?.headOid ?? pr.headRefOid).slice(0, 7)}</dd>
          </dl>
          {pending.length > 0 && (
            <div className="card mt" style={{ maxHeight: 220, overflow: 'auto' }}>
              {pending.map((c, i) => (
                <div key={i} className="row small" style={{ alignItems: 'flex-start', marginBottom: 6 }}>
                  <span className="mono muted">
                    {c.path}
                    {c.line ? `:${c.line}` : ''}
                  </span>
                  <span className="grow ellipsis">{c.body}</span>
                  <button className="btn sm ghost" onClick={() => onRemove(c)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="field">
            <label>Summary</label>
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave a summary comment (optional for approvals)" />
          </div>
          <div className="review-types">
          {(
            [
              ['COMMENT', '💬', 'Comment', 'Submit general feedback without explicit approval.'],
              ['APPROVE', '✓', 'Approve', 'Give your approval to merge these changes.'],
              ['REQUEST_CHANGES', '✕', 'Request changes', 'Feedback that must be addressed before merging.'],
            ] as [ReviewEvent, string, string, string][]
          ).map(([v, icon, l, d]) => {
            const disabled = own && v !== 'COMMENT';
            return (
              <label key={v} className={`review-type ${v.toLowerCase()} ${event === v ? 'selected' : ''}`} style={disabled ? { opacity: 0.45 } : undefined}>
                <span className="rt-icon">{icon}</span>
                <input
                  type="radio"
                  checked={event === v}
                  disabled={disabled}
                  onChange={() => {
                    setEvent(v);
                    setSure(false);
                  }}
                />
                <div>
                  <strong>{l}</strong>
                  <div className="small muted">{disabled ? 'GitHub does not allow this on your own pull request.' : d}</div>
                </div>
              </label>
            );
          })}
          </div>
          {needsSure && (
            <label className="check">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
              <span>
                I want to <strong>{event === 'APPROVE' ? 'approve' : 'request changes on'}</strong> #{pr.number}
                {pending.length ? ` with ${pending.length} comment(s)` : ''}.
              </span>
            </label>
          )}
          {empty && <div className="small text-warn">Add a summary or at least one comment.</div>}
        </div>
      </div>
    </Modal>
  );
}
