import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiAuthInput, GhRepoContext, MarketplaceAction, StarterWorkflow } from '../../../../shared/github';
import type { FriendlyError } from '../../../../shared/types';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { ApiAuthPicker } from '../../../components/github/ApiAuthPicker';
import { Skeleton, useGh } from '../../../components/github/common';
import { Modal, Spinner } from '../../../components/Modal';
import { call, toFriendly } from '../../../services/api';
import { useApp } from '../../../state/AppState';
import { openUrl } from './shared';

import { Select } from '../../../components/Select';
const CATEGORIES: { id: 'suggested' | StarterWorkflow['category']; label: string; icon: string }[] = [
  { id: 'suggested', label: 'Suggested for this repository', icon: '✨' },
  { id: 'deployments', label: 'Deployment', icon: '🚀' },
  { id: 'ci', label: 'Continuous integration', icon: '🧪' },
  { id: 'automation', label: 'Automation', icon: '🤖' },
  { id: 'code-scanning', label: 'Security', icon: '🛡' },
  { id: 'pages', label: 'Pages', icon: '📄' },
];

const BLANK = `name: CI

on:
  push:
    branches: [ "$BRANCH" ]
  pull_request:
    branches: [ "$BRANCH" ]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run a one-line script
        run: echo Hello, world!
`;

export interface StudioTarget {
  /** Existing file to edit (path + branch), or a new file from a template / blank. */
  path?: string;
  branch?: string;
  content?: string;
  name?: string;
}

interface Props {
  repoId: string;
  ctx: GhRepoContext;
  branches: string[];
  initial: StudioTarget | null;
  onClose: () => void;
  onCommitted: () => void;
}

/** "New workflow": GitHub's starter workflows by category (with suggestions for this repo), Marketplace search, or a blank file. */
export function WorkflowStudio({ repoId, ctx, branches, initial, onClose, onCommitted }: Props) {
  const [editing, setEditing] = useState<StudioTarget | null>(initial);
  if (editing) return <WorkflowEditor repoId={repoId} ctx={ctx} branches={branches} target={editing} onBack={() => (initial ? onClose() : setEditing(null))} onCommitted={onCommitted} />;
  return <Gallery repoId={repoId} ctx={ctx} onClose={onClose} onPick={setEditing} />;
}

function Gallery({ repoId, ctx, onClose, onPick }: { repoId: string; ctx: GhRepoContext; onClose: () => void; onPick: (t: StudioTarget) => void }) {
  const starters = useGh(() => call('gh:starterWorkflows', { repoId }), [repoId]);
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]['id']>('suggested');
  const [q, setQ] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [market, setMarket] = useState<MarketplaceAction[] | null>(null);
  const [marketBusy, setMarketBusy] = useState(false);

  const list = starters.data ?? [];
  const query = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const inCat = query ? list : cat === 'suggested' ? list.filter((s) => s.suggested) : list.filter((s) => s.category === cat);
    return inCat.filter((s) => !query || `${s.name} ${s.description} ${s.tags.join(' ')} ${s.creator ?? ''}`.toLowerCase().includes(query)).sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));
  }, [list, cat, query]);
  const counts = useMemo(() => Object.fromEntries(CATEGORIES.map((c) => [c.id, c.id === 'suggested' ? list.filter((s) => s.suggested).length : list.filter((s) => s.category === c.id).length])), [list]);

  // Marketplace search follows the search box (debounced).
  useEffect(() => {
    if (!query) {
      setMarket(null);
      return;
    }
    setMarketBusy(true);
    const t = setTimeout(() => {
      call('gh:marketplaceSearch', { repoId, query })
        .then(setMarket)
        .catch(() => setMarket([]))
        .finally(() => setMarketBusy(false));
    }, 450);
    return () => clearTimeout(t);
  }, [repoId, query]);

  const configure = async (s: StarterWorkflow) => {
    setLoadingId(s.id);
    setError(null);
    try {
      const t = await call('gh:starterWorkflow', { repoId, category: s.category, id: s.id });
      onPick({ content: t.content, name: `${s.id.replace(/[^A-Za-z0-9._-]/g, '-')}.yml` });
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="content studio">
      <div className="row mb">
        <button className="btn sm ghost" onClick={onClose}>
          ← Actions
        </button>
        <h2 className="grow" style={{ margin: 0 }}>
          Choose a workflow
        </h2>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Build, test, deploy and automate {ctx.owner}/{ctx.name}. Start from GitHub's starter workflows, find an action in the Marketplace, or write your own.
      </p>

      <div className="studio-search">
        <span>⌕</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workflows and Marketplace actions…" spellCheck={false} autoFocus />
        {q && (
          <button className="ft-clear" style={{ position: 'static', transform: 'none' }} onClick={() => setQ('')}>
            ×
          </button>
        )}
      </div>

      <div className="studio-yourself" onClick={() => onPick({ content: BLANK.replace(/\$BRANCH/g, ctx.defaultBranch), name: 'main.yml' })}>
        <span className="studio-yourself-ico">✎</span>
        <div className="grow">
          <strong>Set up a workflow yourself</strong>
          <div className="small muted">Start from a minimal skeleton in the editor, with snippets and Marketplace search beside it.</div>
        </div>
        <span className="btn sm primary">Open editor →</span>
      </div>

      {error && <ErrorPanel error={error} />}

      {!query && (
        <div className="studio-cats">
          {CATEGORIES.map((c) => (
            <button key={c.id} className={`studio-cat ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>
              <span>{c.icon}</span> {c.label} <span className="badge">{counts[c.id] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {starters.error && <ErrorPanel error={starters.error} />}
      {starters.loading && !starters.data && (
        <div className="studio-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="studio-card">
              <Skeleton rows={3} />
            </div>
          ))}
        </div>
      )}
      {starters.data && shown.length === 0 && <div className="empty small">{query ? 'No starter workflow matches — see the Marketplace results below.' : cat === 'suggested' ? 'No language-specific suggestions; browse the categories.' : 'Nothing in this category.'}</div>}
      <div className="studio-grid">
        {shown.slice(0, 60).map((s) => (
          <div key={`${s.category}/${s.id}`} className={`studio-card ${s.suggested ? 'suggested' : ''}`}>
            <div className="row" style={{ gap: 8 }}>
              <span className="studio-card-ico">{CATEGORIES.find((c) => c.id === s.category)?.icon}</span>
              <strong className="grow ellipsis">{s.name}</strong>
              {s.suggested && <span className="badge info">suggested</span>}
            </div>
            <div className="small muted studio-card-desc">{s.description}</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {s.creator && <span className="small muted">By {s.creator}</span>}
              {s.tags.slice(0, 3).map((t) => (
                <span key={t} className="studio-tag">
                  {t}
                </span>
              ))}
              <span className="spacer" />
              <button className="btn sm" disabled={loadingId !== null} onClick={() => void configure(s)}>
                {loadingId === s.id ? 'Loading…' : 'Configure'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {query && (
        <div className="mt">
          <h3 className="row">
            🛒 Marketplace actions <span className="spacer" />
            <button className="btn sm ghost" onClick={() => openUrl(`https://github.com/marketplace?type=actions&query=${encodeURIComponent(query)}`)}>
              Open in Marketplace ↗
            </button>
          </h3>
          {marketBusy && <Spinner label="Searching…" />}
          {market && !marketBusy && market.length === 0 && <div className="small muted">No actions found.</div>}
          <div className="market-list">
            {market?.map((m) => (
              <div key={m.fullName} className="market-row" onClick={() => openUrl(m.url)}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <strong className="ellipsis">{m.fullName}</strong>
                    {m.verifiedOwner && <span className="badge ok">✓ verified creator</span>}
                  </div>
                  <div className="small muted ellipsis">{m.description}</div>
                </div>
                <span className="small muted nowrap">★ {m.stars.toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div className="small muted mt">Open the editor to insert an action into a workflow.</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const SNIPPETS: { title: string; desc: string; code: string }[] = [
  { title: 'Run on push to main & release branches', desc: 'Trigger on pushes to selected branches.', code: 'on:\n  push:\n    branches:\n      - main\n      - release/*\n' },
  { title: 'Run on pull requests', desc: 'Trigger for pull requests that target main.', code: 'on:\n  pull_request:\n    branches:\n      - main\n' },
  { title: 'Run on a schedule', desc: 'Every weekday at 02:00 UTC.', code: "on:\n  schedule:\n    - cron: '0 2 * * 1-5'\n" },
  { title: 'Manual run with inputs', desc: 'Adds a “Run workflow” button with parameters.', code: "on:\n  workflow_dispatch:\n    inputs:\n      environment:\n        description: 'Target environment'\n        type: choice\n        options: [staging, production]\n        required: true\n" },
  { title: 'Run on tag push (releases)', desc: 'Start when a version tag is pushed.', code: "on:\n  push:\n    tags:\n      - 'v*'\n" },
  { title: 'Least-privilege token', desc: 'Limit what GITHUB_TOKEN can do.', code: 'permissions:\n  contents: read\n' },
  { title: 'Build matrix', desc: 'Test across versions and OSes.', code: "    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n        node: [18, 20]\n    runs-on: \${{ matrix.os }}\n" },
  { title: 'Cache dependencies', desc: 'Speed up npm installs.', code: "      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n          cache: npm\n" },
  { title: 'Use a secret', desc: 'Read a repository secret into an env var.', code: '        env:\n          API_TOKEN: ${{ secrets.API_TOKEN }}\n' },
  { title: 'Deploy to an environment', desc: 'Protected environments can require approval.', code: '    environment:\n      name: production\n      url: https://example.com\n' },
];

/** Light checks that catch the usual mistakes before a commit (GitHub validates fully on push). */
function lint(text: string): { level: 'error' | 'warn' | 'ok'; msg: string }[] {
  const out: { level: 'error' | 'warn' | 'ok'; msg: string }[] = [];
  const lines = text.split('\n');
  if (!text.trim()) return [{ level: 'error', msg: 'The workflow is empty.' }];
  const tabLine = lines.findIndex((l) => /^\s*\t/.test(l));
  if (tabLine >= 0) out.push({ level: 'error', msg: `Line ${tabLine + 1}: YAML does not allow tabs for indentation.` });
  if (!lines.some((l) => /^['"]?on['"]?\s*:/.test(l))) out.push({ level: 'error', msg: 'Missing the top-level “on:” trigger.' });
  if (!lines.some((l) => /^jobs\s*:/.test(l))) out.push({ level: 'error', msg: 'Missing the top-level “jobs:” section.' });
  else if (!/runs-on\s*:|uses\s*:\s*\.\/\.github\/workflows|uses\s*:\s*[\w.-]+\/[\w.-]+\/\.github\/workflows/.test(text)) out.push({ level: 'error', msg: 'Each job needs “runs-on:” (or calls a reusable workflow).' });
  if (!/^name\s*:/m.test(text)) out.push({ level: 'warn', msg: 'Add a “name:” so the workflow is easy to find in the Actions list.' });
  if (!/^permissions\s*:/m.test(text)) out.push({ level: 'warn', msg: 'Consider “permissions:” to limit the GITHUB_TOKEN (least privilege).' });
  const unpinned = [...text.matchAll(/uses:\s*([\w.-]+\/[\w./-]+)(?!@)\s*$/gm)].map((m) => m[1]);
  if (unpinned.length) out.push({ level: 'warn', msg: `Pin a version for: ${unpinned.slice(0, 3).join(', ')}` });
  if (/pull_request_target/.test(text) && /actions\/checkout/.test(text)) out.push({ level: 'warn', msg: 'pull_request_target with checkout can expose secrets to untrusted code.' });
  if (!out.some((x) => x.level === 'error')) out.unshift({ level: 'ok', msg: 'Structure looks valid.' });
  return out;
}

function WorkflowEditor({ repoId, ctx, branches, target, onBack, onCommitted }: { repoId: string; ctx: GhRepoContext; branches: string[]; target: StudioTarget; onBack: () => void; onCommitted: () => void }) {
  const { toast } = useApp();
  const isEdit = !!target.path;
  const [fileName, setFileName] = useState(target.path ? target.path.replace('.github/workflows/', '') : (target.name ?? 'main.yml'));
  const [branch, setBranch] = useState(target.branch ?? ctx.defaultBranch);
  const [text, setText] = useState(target.content ?? '');
  const [original, setOriginal] = useState(target.content ?? '');
  const [existing, setExisting] = useState<{ sha: string } | null | undefined>(undefined);
  const [loading, setLoading] = useState(isEdit && target.content === undefined);
  const [side, setSide] = useState<'docs' | 'market'>('docs');
  const [wrap, setWrap] = useState(false);
  const [commit, setCommit] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const validName = /^[A-Za-z0-9._-]+\.ya?ml$/.test(fileName);
  const path = `.github/workflows/${fileName}`;

  // Is there already a file with this name on the branch? (edit loads it; new files must not clobber one silently)
  useEffect(() => {
    if (!validName) {
      setExisting(undefined);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      call('gh:workflowFile', { repoId, path, ref: branch })
        .then((f) => {
          if (!live) return;
          setExisting(f ? { sha: f.sha } : null);
          if (f && loading) {
            setText(f.content);
            setOriginal(f.content);
            setLoading(false);
          }
        })
        .catch(() => live && setExisting(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, path, branch, validName]);

  const issues = useMemo(() => lint(text), [text]);
  const errors = issues.filter((i) => i.level === 'error').length;
  const lineCount = text.split('\n').length;
  const dirty = text !== original || !isEdit;

  const insert = useCallback((snippet: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const before = ta.value.slice(0, start);
    const needsNl = before.length > 0 && !before.endsWith('\n');
    const next = `${before}${needsNl ? '\n' : ''}${snippet}${ta.value.slice(ta.selectionEnd)}`;
    setText(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + (needsNl ? 1 : 0) + snippet.length;
      ta.setSelectionRange(pos, pos);
    });
    toast('Snippet inserted');
  }, [toast]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      const v = ta.value;
      if (e.shiftKey) {
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        if (v.slice(ls, ls + 2) === '  ') {
          setText(v.slice(0, ls) + v.slice(ls + 2));
          requestAnimationFrame(() => ta.setSelectionRange(Math.max(ls, s - 2), Math.max(ls, s - 2)));
        }
      } else {
        setText(`${v.slice(0, s)}  ${v.slice(ta.selectionEnd)}`);
        requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
      }
    } else if (e.key === 'Enter') {
      // Keep the indentation of the current line (one more level after a trailing colon).
      const s = ta.selectionStart;
      const v = ta.value;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(ls, s);
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      const extra = /:\s*$/.test(line) ? '  ' : '';
      if (indent || extra) {
        e.preventDefault();
        const ins = `\n${indent}${extra}`;
        setText(v.slice(0, s) + ins + v.slice(ta.selectionEnd));
        requestAnimationFrame(() => ta.setSelectionRange(s + ins.length, s + ins.length));
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!errors && validName) setCommit(true);
    }
  };

  return (
    <div className="content studio-editor">
      <div className="editor-bar">
        <button className="btn sm ghost" onClick={() => (dirty && text.trim() ? setConfirmLeave(true) : onBack())}>
          ←
        </button>
        <span className="crumb">{ctx.name}</span>
        <span className="crumb-sep">/</span>
        <span className="crumb">.github</span>
        <span className="crumb-sep">/</span>
        <span className="crumb">workflows</span>
        <span className="crumb-sep">/</span>
        <input className={`file-name-input ${validName ? '' : 'invalid'}`} value={fileName} onChange={(e) => setFileName(e.target.value.trim())} disabled={isEdit} spellCheck={false} aria-label="File name" />
        <span className="small muted">in</span>
        <Select kind="branch" value={branch} onChange={(e) => setBranch(e.target.value)} className="branch-select" disabled={isEdit}>
          {[...new Set([ctx.defaultBranch, ...branches])].map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </Select>
        {existing && !isEdit && <span className="badge warn" title="A file with this name exists on the branch — committing replaces it">exists · will replace</span>}
        {existing === null && !isEdit && validName && <span className="badge ok">new file</span>}
        <span className="spacer" />
        <button className="btn" onClick={() => (dirty && text.trim() ? setConfirmLeave(true) : onBack())}>
          Cancel changes
        </button>
        <button className="btn primary" disabled={!validName || errors > 0 || !text.trim() || (isEdit && !dirty)} title={errors ? 'Fix the errors first' : 'Ctrl+S'} onClick={() => setCommit(true)}>
          Commit changes…
        </button>
      </div>
      {!validName && <div className="field-hint" style={{ marginBottom: 6 }}>File name must end with .yml or .yaml and contain only letters, numbers, “.”, “_” or “-”.</div>}

      <div className="editor-layout">
        <div className="editor-pane">
          <div className="editor-tools">
            <span className="small muted">YAML · 2 spaces · {lineCount} lines</span>
            <span className="spacer" />
            <label className="check small">
              <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> wrap
            </label>
          </div>
          {loading ? (
            <Spinner label="Loading the workflow…" />
          ) : (
            <div className="code-editor">
              <div className="gutter" ref={gutterRef} aria-hidden>
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <textarea
                ref={taRef}
                className={wrap ? 'wrap' : ''}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onScroll={(e) => {
                  if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                spellCheck={false}
                placeholder="Enter file contents here"
              />
            </div>
          )}
          <div className="lint">
            {issues.map((i, k) => (
              <div key={k} className={`lint-row ${i.level}`}>
                {i.level === 'error' ? '✕' : i.level === 'warn' ? '⚠' : '✓'} {i.msg}
              </div>
            ))}
          </div>
        </div>

        <div className="editor-side">
          <div className="segmented">
            <button className={side === 'market' ? 'on' : ''} onClick={() => setSide('market')}>
              Marketplace
            </button>
            <button className={side === 'docs' ? 'on' : ''} onClick={() => setSide('docs')}>
              Documentation
            </button>
          </div>
          {side === 'docs' ? (
            <div className="side-scroll">
              <h4>Snippets</h4>
              <p className="small muted">Click Insert to add a snippet at the cursor.</p>
              {SNIPPETS.map((s) => (
                <div key={s.title} className="snippet">
                  <div className="row">
                    <strong className="grow small">{s.title}</strong>
                    <button className="btn sm" onClick={() => insert(s.code)}>
                      Insert
                    </button>
                  </div>
                  <div className="small muted">{s.desc}</div>
                  <pre>{s.code}</pre>
                </div>
              ))}
              <button className="btn sm ghost" onClick={() => openUrl('https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions')}>
                Workflow syntax reference ↗
              </button>
            </div>
          ) : (
            <MarketPanel repoId={repoId} onInsert={insert} />
          )}
        </div>
      </div>

      {commit && (
        <CommitWorkflowDialog
          repoId={repoId}
          ctx={ctx}
          path={path}
          branch={branch}
          content={text}
          existingSha={existing?.sha ?? null}
          isEdit={isEdit || !!existing}
          onClose={() => setCommit(false)}
          onDone={() => {
            setCommit(false);
            onCommitted();
          }}
        />
      )}
      {confirmLeave && (
        <Modal
          title="Discard changes?"
          size="narrow"
          onClose={() => setConfirmLeave(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmLeave(false)}>
                Keep editing
              </button>
              <button className="btn danger" onClick={onBack}>
                Discard
              </button>
            </>
          }
        >
          <p>Your edits to {fileName} have not been committed and will be lost.</p>
        </Modal>
      )}
    </div>
  );
}

function MarketPanel({ repoId, onInsert }: { repoId: string; onInsert: (code: string) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MarketplaceAction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => {
      call('gh:marketplaceSearch', { repoId, query: q.trim() || 'setup' })
        .then(setItems)
        .catch(() => setItems([]))
        .finally(() => setBusy(false));
    }, 400);
    return () => clearTimeout(t);
  }, [repoId, q]);

  const add = async (m: MarketplaceAction) => {
    setAdding(m.fullName);
    try {
      const { ref } = await call('gh:actionLatest', { repoId, fullName: m.fullName });
      onInsert(`      - name: ${m.fullName.split('/')[1]}\n        uses: ${m.fullName}@${ref ?? 'main'}\n`);
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="side-scroll">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Marketplace for actions" spellCheck={false} />
      {busy && <Spinner label="Searching…" />}
      {!busy && items?.length === 0 && <div className="small muted pad">No actions found.</div>}
      {items?.map((m) => (
        <div key={m.fullName} className="snippet">
          <div className="row" style={{ gap: 6 }}>
            <strong className="grow small ellipsis" title={m.fullName}>
              {m.fullName}
            </strong>
            <span className="small muted nowrap">★ {m.stars.toLocaleString()}</span>
          </div>
          {m.verifiedOwner && <span className="badge ok">✓ verified creator</span>}
          <div className="small muted">{m.description}</div>
          <div className="row mt-xs">
            <button className="btn sm" disabled={adding !== null} onClick={() => void add(m)}>
              {adding === m.fullName ? 'Adding…' : '+ Insert step'}
            </button>
            <button className="btn sm ghost" onClick={() => openUrl(m.url)}>
              View ↗
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CommitWorkflowDialog({
  repoId,
  ctx,
  path,
  branch,
  content,
  existingSha,
  isEdit,
  onClose,
  onDone,
}: {
  repoId: string;
  ctx: GhRepoContext;
  path: string;
  branch: string;
  content: string;
  existingSha: string | null;
  isEdit: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useApp();
  const [message, setMessage] = useState(`${isEdit ? 'Update' : 'Create'} ${path.split('/').pop()}`);
  const [mode, setMode] = useState<'direct' | 'pull-request'>('direct');
  const [auth, setAuth] = useState<{ input: ApiAuthInput | null; summary: string }>({ input: null, summary: '' });
  const onAuth = useCallback((input: ApiAuthInput | null, summary: string) => setAuth({ input, summary }), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [result, setResult] = useState<{ url: string; mode: 'direct' | 'pull-request'; branch: string } | null>(null);

  const submit = async () => {
    if (!auth.input) return;
    setBusy(true);
    setError(null);
    try {
      const res = await call('gh:workflowWrite', { repoId, path, content, branch, mode, message: message.trim(), existingSha, auth: auth.input, confirmed: true });
      setResult(res);
      toast(res.mode === 'direct' ? `Committed ${path} to ${branch}` : 'Pull request opened');
    } catch (err) {
      setError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal title="Workflow committed" icon="✓" size="narrow" onClose={onDone} footer={<button className="btn primary" onClick={onDone}>Done</button>}>
        <div className="banner ok">
          <span className="icon">✓</span>
          <div>
            {result.mode === 'direct' ? (
              <>
                <strong>{path}</strong> is on <strong>{branch}</strong>. It shows up in the Actions list as soon as GitHub has indexed it.
              </>
            ) : (
              <>
                A pull request from <span className="mono">{result.branch}</span> into <strong>{branch}</strong> was opened.
              </>
            )}
          </div>
        </div>
        <button className="btn sm ghost mt" onClick={() => openUrl(result.url)}>
          Open on GitHub ↗
        </button>
      </Modal>
    );
  }

  return (
    <Modal
      title="Commit changes"
      size="wide"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !auth.input || !message.trim()} onClick={() => void submit()}>
            {busy ? 'Committing…' : mode === 'direct' ? `Commit to ${branch}` : 'Commit & open pull request'}
          </button>
        </>
      }
    >
      {error && <ErrorPanel error={error} />}
      <div className={`field ${!message.trim() ? 'invalid' : ''}`}>
        <label>
          Commit message <span className="req">*</span>
        </label>
        <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} />
      </div>
      <div className="proto-cards" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label className={`radio-card ${mode === 'direct' ? 'selected' : ''}`}>
          <input type="radio" checked={mode === 'direct'} onChange={() => setMode('direct')} />
          <div>
            <strong>Commit directly to {branch}</strong>
            <div className="small muted">The workflow is active immediately.</div>
          </div>
        </label>
        <label className={`radio-card ${mode === 'pull-request' ? 'selected' : ''}`}>
          <input type="radio" checked={mode === 'pull-request'} onChange={() => setMode('pull-request')} />
          <div>
            <strong>New branch & pull request</strong>
            <div className="small muted">Review it before it can run on {branch}.</div>
          </div>
        </label>
      </div>
      {existingSha && (
        <div className="banner warn small">
          <span className="icon">⚠</span>
          <div>
            This replaces the existing <span className="mono">{path}</span> on {branch}.
          </div>
        </div>
      )}
      <h4 style={{ margin: '12px 0 8px' }}>Authenticate this commit</h4>
      <ApiAuthPicker repoId={repoId} purpose={`commit ${path}`} needs="“Contents” and “Workflows: write” (fine-grained) or the “repo” + “workflow” scopes (classic)" onChange={onAuth} />
      <div className="small muted mt">
        Commits to {ctx.owner}/{ctx.name} as {auth.summary || '…'}.
      </div>
    </Modal>
  );
}
