import { useEffect, useMemo, useState } from 'react';
import type { DraftReviewComment, PrDetails, PrFile, PrFilesResult, ReviewThread } from '../../../shared/github';
import type { DiffLine } from '../../../shared/types';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Avatar, relTime, Skeleton, useGh, useMutation } from '../../components/github/common';
import { call } from '../../services/api';
import { FilesTree } from './pr/FilesTree';

const AUTO_EXPAND_LINES = 400;

interface Props {
  repoId: string;
  pr: PrDetails;
  pending: DraftReviewComment[];
  setPending: (fn: (p: DraftReviewComment[]) => DraftReviewComment[]) => void;
  onChanged: () => void;
  onFinishReview: () => void;
  onFilesLoaded: (f: PrFilesResult) => void;
}

const STATUS: Record<string, [string, string]> = { added: ['A', 'added'], removed: ['D', 'deleted'], modified: ['M', 'modified'], renamed: ['R', 'renamed'], copied: ['C', 'copied'], changed: ['M', 'modified'], unchanged: ['·', ''] };

export function PrFiles({ repoId, pr, pending, setPending, onChanged, onFinishReview, onFilesLoaded }: Props) {
  const files = useGh(async () => {
    const r = await call('gh:prFiles', { repoId, number: pr.number });
    onFilesLoaded(r);
    return r;
  }, [repoId, pr.number, pr.headRefOid]);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const threadCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of pr.reviewThreads) m.set(t.path, (m.get(t.path) ?? 0) + 1);
    return m;
  }, [pr.reviewThreads]);

  const fileList = files.data?.files;
  const q = filter.trim().toLowerCase();
  const visiblePaths = useMemo(() => (fileList ?? []).filter((f) => !q || f.path.toLowerCase().includes(q)).map((f) => f.path), [fileList, q]);

  // "You are here": highlight the file whose card is at the top of the view while scrolling.
  useEffect(() => {
    if (visiblePaths.length === 0) return;
    const seen = new Set<string>();
    const order = new Map(visiblePaths.map((p, i) => [p, i]));
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const p = (e.target as HTMLElement).dataset.filePath;
          if (!p) continue;
          if (e.isIntersecting) seen.add(p);
          else seen.delete(p);
        }
        if (seen.size === 0) return;
        const top = [...seen].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
        setActive((cur) => (cur === top ? cur : top));
      },
      { rootMargin: '-60px 0px -65% 0px' },
    );
    for (const p of visiblePaths) {
      const el = document.getElementById(`file-${p}`);
      if (el) {
        el.dataset.filePath = p;
        obs.observe(el);
      }
    }
    return () => obs.disconnect();
  }, [visiblePaths]);

  if (files.error) return <div className="content"><ErrorPanel error={files.error} /></div>;
  if (!files.data) return <div className="content"><Skeleton rows={6} /></div>;

  const jump = (p: string) => {
    setActive(p);
    document.getElementById(`file-${p}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="pr-files">
      <div className="pr-files-tree">
        <FilesTree
          files={files.data.files}
          filter={filter}
          onFilter={setFilter}
          collapsed={collapsedDirs}
          setCollapsed={setCollapsedDirs}
          active={active}
          threadCounts={threadCounts}
          truncated={files.data.truncated}
          onPick={jump}
        />
      </div>
      <div className="pr-files-main">
        {pending.length > 0 && (
          <div className="banner info">
            <span className="icon">✎</span>
            <div className="grow">
              Review in progress — <strong>{pending.length}</strong> pending comment(s). They are only visible to others after you submit the review.
            </div>
            <button className="btn sm primary" onClick={onFinishReview}>
              Finish your review
            </button>
          </div>
        )}
        {files.data.files
          .filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()))
          .map((f) => (
            <FileCard
              key={f.path}
              repoId={repoId}
              pr={pr}
              file={f}
              headOid={files.data!.headOid}
              threads={pr.reviewThreads.filter((t) => t.path === f.path)}
              pending={pending.filter((c) => c.path === f.path)}
              addPending={(c) => setPending((p) => [...p, c])}
              removePending={(c) => setPending((p) => p.filter((x) => x !== c))}
              onChanged={onChanged}
            />
          ))}
      </div>
    </div>
  );
}

interface CardProps {
  repoId: string;
  pr: PrDetails;
  file: PrFile;
  headOid: string;
  threads: ReviewThread[];
  pending: DraftReviewComment[];
  addPending: (c: DraftReviewComment) => void;
  removePending: (c: DraftReviewComment) => void;
  onChanged: () => void;
}

function FileCard({ repoId, pr, file, headOid, threads, pending, addPending, removePending, onChanged }: CardProps) {
  const lineCount = file.diff?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0;
  const [open, setOpen] = useState(lineCount <= AUTO_EXPAND_LINES && !file.binary);
  const [composer, setComposer] = useState<{ line: number | null; side: 'LEFT' | 'RIGHT' } | null>(null);
  const [text, setText] = useState('');
  const { busy, run } = useMutation();
  const canComment = pr.state === 'OPEN' || pr.state === 'CLOSED';

  const lineKey = (line: number | null, side: string) => `${side}:${line ?? 'file'}`;
  const threadsAt = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      const k = lineKey(t.line, t.diffSide);
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return m;
  }, [threads]);
  const pendingAt = (line: number | null, side: string) => pending.filter((c) => c.line === line && c.side === side);
  const fileLevel = threads.filter((t) => t.line === null);

  const submitSingle = async () => {
    if (!composer || !text.trim()) return;
    const ok = await run(() => call('gh:prReviewComment', { repoId, number: pr.number, commitId: headOid, comment: { path: file.path, line: composer.line, side: composer.side, body: text } }), 'Comment added');
    if (ok !== undefined) {
      setComposer(null);
      setText('');
      onChanged();
    }
  };
  const addToReview = () => {
    if (!composer || !text.trim()) return;
    addPending({ path: file.path, line: composer.line, side: composer.side, body: text });
    setComposer(null);
    setText('');
  };

  const composerUi = (
    <div className="inline-composer">
      <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={composer?.line ? `Comment on line ${composer.line}` : 'Comment on this file'} />
      <div className="row">
        <span className="spacer" />
        <button className="btn sm" onClick={() => (setComposer(null), setText(''))}>
          Cancel
        </button>
        <button className="btn sm" disabled={busy || !text.trim()} onClick={submitSingle}>
          Add single comment
        </button>
        <button className="btn sm primary" disabled={!text.trim()} onClick={addToReview}>
          {pending.length ? 'Add review comment' : 'Start a review'}
        </button>
      </div>
    </div>
  );

  const side = (l: DiffLine): 'LEFT' | 'RIGHT' => (l.type === 'del' ? 'LEFT' : 'RIGHT');
  const lineNo = (l: DiffLine) => (l.type === 'del' ? l.oldLine : l.newLine) ?? null;

  return (
    <div className="file-card" id={`file-${file.path}`}>
      <div className="file-card-header" onClick={() => setOpen((o) => !o)}>
        <span className="muted">{open ? '▾' : '▸'}</span>
        <span className={`kind ${STATUS[file.status]?.[1] ?? ''}`}>{STATUS[file.status]?.[0]}</span>
        <span className="mono grow ellipsis">
          {file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ` : ''}
          {file.path}
        </span>
        {threads.length > 0 && <span className="badge">💬 {threads.length}</span>}
        {pending.length > 0 && <span className="badge info">✎ {pending.length}</span>}
        <span className="badge ok">+{file.additions}</span>
        <span className="badge danger">−{file.deletions}</span>
        {canComment && (
          <button
            className="btn sm ghost"
            title="Comment on this file"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
              setComposer({ line: null, side: 'RIGHT' });
            }}
          >
            💬
          </button>
        )}
      </div>
      {open && (
        <div className="file-card-body">
          {fileLevel.map((t) => (
            <ThreadView key={t.id} repoId={repoId} pr={pr} thread={t} onChanged={onChanged} />
          ))}
          {pendingAt(null, 'RIGHT').map((c, i) => (
            <PendingView key={i} c={c} onRemove={() => removePending(c)} />
          ))}
          {composer?.line === null && composerUi}
          {file.binary && <div className="empty small">Binary file not shown.</div>}
          {file.tooLarge && (
            <div className="empty small">
              Large diffs are not rendered by GitHub's API.{' '}
              <a onClick={() => call('shell:openExternal', { url: `${pr.url}/files` }).catch(() => undefined)}>View it on GitHub</a>
            </div>
          )}
          {file.diff && (
            <table className="diff review-diff">
              <colgroup>
                <col style={{ width: 52 }} />
                <col style={{ width: 52 }} />
                <col style={{ width: 22 }} />
                <col />
              </colgroup>
              <tbody>
                {file.diff.hunks.map((h, hi) => [
                  <tr key={`h${hi}`} className="hunk">
                    <td colSpan={4}>{h.header}</td>
                  </tr>,
                  ...h.lines.flatMap((l, li) => {
                    const ln = lineNo(l);
                    const sd = side(l);
                    const here = ln !== null ? threadsAt.get(lineKey(ln, sd)) ?? [] : [];
                    const pend = ln !== null ? pendingAt(ln, sd) : [];
                    const rows = [
                      <tr key={`${hi}-${li}`} className={`${l.type} commentable`}>
                        <td className="ln">{l.oldLine ?? ''}</td>
                        <td className="ln">{l.newLine ?? ''}</td>
                        <td className="sign">
                          {canComment && ln !== null && l.type !== 'meta' ? (
                            <button className="add-comment" title="Comment on this line" onClick={() => setComposer({ line: ln, side: sd })}>
                              +
                            </button>
                          ) : l.type === 'add' ? (
                            '+'
                          ) : l.type === 'del' ? (
                            '−'
                          ) : (
                            ''
                          )}
                        </td>
                        <td>{l.content || ' '}</td>
                      </tr>,
                    ];
                    if (here.length || pend.length || (composer && composer.line === ln && composer.side === sd && ln !== null)) {
                      rows.push(
                        <tr key={`${hi}-${li}-c`} className="comment-row">
                          <td colSpan={4}>
                            {here.map((t) => (
                              <ThreadView key={t.id} repoId={repoId} pr={pr} thread={t} onChanged={onChanged} />
                            ))}
                            {pend.map((c, i) => (
                              <PendingView key={i} c={c} onRemove={() => removePending(c)} />
                            ))}
                            {composer && composer.line === ln && composer.side === sd && composerUi}
                          </td>
                        </tr>,
                      );
                    }
                    return rows;
                  }),
                ])}
              </tbody>
            </table>
          )}
          {!file.diff && !file.binary && !file.tooLarge && <div className="empty small">No textual changes (rename or mode change only).</div>}
        </div>
      )}
      {!open && lineCount > AUTO_EXPAND_LINES && (
        <div className="empty small" onClick={() => setOpen(true)} style={{ cursor: 'pointer' }}>
          Large diff ({lineCount} lines) — click to load.
        </div>
      )}
    </div>
  );
}

function PendingView({ c, onRemove }: { c: DraftReviewComment; onRemove: () => void }) {
  return (
    <div className="thread pending">
      <div className="row small">
        <span className="badge info">Pending</span>
        <span className="grow muted">Will be posted when you submit your review</span>
        <button className="btn sm ghost" onClick={onRemove}>
          Delete
        </button>
      </div>
      <div className="md-text">{c.body}</div>
    </div>
  );
}

export function ThreadView({ repoId, pr, thread, onChanged }: { repoId: string; pr: PrDetails; thread: ReviewThread; onChanged: () => void }) {
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [collapsed, setCollapsed] = useState(thread.isResolved);
  const { busy, run } = useMutation();
  const first = thread.comments[0];

  const sendReply = async () => {
    if (!reply.trim() || !first) return;
    const ok = await run(() => call('gh:prReply', { repoId, number: pr.number, commentId: first.databaseId, body: reply }), 'Reply posted');
    if (ok !== undefined) {
      setReply('');
      setReplying(false);
      onChanged();
    }
  };

  return (
    <div className={`thread ${thread.isResolved ? 'resolved' : ''}`}>
      <div className="row small">
        <span className="mono muted grow">
          {thread.path}
          {thread.line ? `:${thread.line}` : ''}
          {thread.isOutdated && <span className="badge warn" style={{ marginLeft: 6 }}>outdated</span>}
          {thread.isResolved && <span className="badge ok" style={{ marginLeft: 6 }}>resolved</span>}
        </span>
        {thread.isResolved && (
          <button className="btn sm ghost" onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? 'Show' : 'Hide'}
          </button>
        )}
        {!thread.isResolved && thread.viewerCanResolve && (
          <button className="btn sm" disabled={busy} onClick={() => run(() => call('gh:prResolveThread', { repoId, threadId: thread.id, resolved: true }), 'Conversation resolved').then(onChanged)}>
            Resolve conversation
          </button>
        )}
        {thread.isResolved && thread.viewerCanUnresolve && (
          <button className="btn sm" disabled={busy} onClick={() => run(() => call('gh:prResolveThread', { repoId, threadId: thread.id, resolved: false }), 'Conversation unresolved').then(onChanged)}>
            Unresolve
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          {thread.comments.map((c) => (
            <div key={c.id} className="thread-comment">
              <div className="row small">
                <Avatar login={c.author?.login} />
                <strong>{c.author?.login ?? 'ghost'}</strong>
                <span className="muted">{relTime(c.createdAt)}</span>
                <span className="spacer" />
                {c.viewerCanUpdate && editing?.id !== c.databaseId && (
                  <button className="btn sm ghost" onClick={() => setEditing({ id: c.databaseId, body: c.body })}>
                    Edit
                  </button>
                )}
              </div>
              {editing?.id === c.databaseId ? (
                <div className="inline-composer">
                  <textarea rows={3} value={editing.body} onChange={(e) => setEditing({ id: c.databaseId, body: e.target.value })} />
                  <div className="row">
                    <span className="spacer" />
                    <button className="btn sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn sm primary"
                      disabled={busy || !editing.body.trim()}
                      onClick={() =>
                        run(() => call('gh:prEditComment', { repoId, kind: 'review', databaseId: c.databaseId, body: editing.body }), 'Comment updated').then((r) => {
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
                <div className="md-text">{c.body}</div>
              )}
            </div>
          ))}
          {replying ? (
            <div className="inline-composer">
              <textarea autoFocus rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" />
              <div className="row">
                <span className="spacer" />
                <button className="btn sm" onClick={() => setReplying(false)}>
                  Cancel
                </button>
                <button className="btn sm primary" disabled={busy || !reply.trim()} onClick={sendReply}>
                  Reply
                </button>
              </div>
            </div>
          ) : (
            <button className="btn sm ghost" onClick={() => setReplying(true)}>
              Reply…
            </button>
          )}
        </>
      )}
    </div>
  );
}
