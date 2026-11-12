import { useEffect, useState, type ReactNode } from 'react';
import type { UpdateCheck } from '../../shared/api';
import { call, onNotify } from '../services/api';
import { useApp } from '../state/AppState';
import { AboutDialog, EditionDialog, ShortcutsDialog } from './AppFooter';
import { Hourglass } from './Hourglass';
import { Modal } from './Modal';

type Dialog = 'shortcuts' | 'cheatsheet' | 'practices' | 'about' | 'edition' | 'update' | null;

const MENU_DIALOGS: Dialog[] = ['shortcuts', 'cheatsheet', 'practices', 'about', 'edition', 'update'];

/**
 * Shows what the window's File / Help menu asks for (the menu itself is the native one, built in the main
 * process). Also handles the shortcut keys: Ctrl+/ and ? for shortcuts, F1 for the Help Center.
 */
export function AppMenus() {
  const { setView } = useApp();
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(
    () =>
      onNotify((e) => {
        if (e.type !== 'menu') return;
        if (e.id === 'token') setView('token');
        else if (e.id === 'help') setView('help');
        else if ((MENU_DIALOGS as string[]).includes(e.id)) setDialog(e.id as Dialog);
      }),
    [setView],
  );

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setDialog((d) => (d === 'shortcuts' ? null : 'shortcuts'));
      } else if (e.key === '?' && !typing && !document.querySelector('.modal-backdrop')) {
        e.preventDefault();
        setDialog('shortcuts');
      } else if (e.key === 'F1') {
        e.preventDefault();
        setView('help');
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [setView]);

  const close = () => setDialog(null);
  return (
    <>
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={close} />}
      {dialog === 'about' && <AboutDialog onClose={close} onEdition={() => setDialog('edition')} />}
      {dialog === 'edition' && <EditionDialog onClose={close} />}
      {dialog === 'cheatsheet' && <CheatSheetDialog onClose={close} />}
      {dialog === 'practices' && <PracticesDialog onClose={close} />}
      {dialog === 'update' && <UpdateDialog onClose={close} />}
    </>
  );
}

// ---------------------------------------------------------------- cheat sheet

const CHEATS: { group: string; icon: string; rows: [string, string][] }[] = [
  {
    group: 'Start',
    icon: '🚀',
    rows: [
      ['git init', 'Make the current folder a repository'],
      ['git clone <url>', 'Copy a remote repository to your computer'],
      ['git config --global user.name "Name"', 'Set the name on your commits'],
      ['git config --global user.email you@x.com', 'Set the email on your commits'],
    ],
  },
  {
    group: 'Everyday changes',
    icon: '✏',
    rows: [
      ['git status', 'What changed and what is staged'],
      ['git add <file>', 'Stage a file for the next commit'],
      ['git add -p', 'Stage part of a file, piece by piece'],
      ['git commit -m "msg"', 'Record the staged changes'],
      ['git diff', 'Changes not staged yet'],
      ['git diff --staged', 'Changes that will be committed'],
    ],
  },
  {
    group: 'Branches',
    icon: '⎇',
    rows: [
      ['git branch', 'List local branches'],
      ['git switch <name>', 'Move to a branch'],
      ['git switch -c <name>', 'Create a branch and move to it'],
      ['git merge <name>', 'Bring another branch into this one'],
      ['git rebase <base>', 'Replay your commits on top of <base>'],
      ['git branch -d <name>', 'Delete a merged branch'],
    ],
  },
  {
    group: 'Remote',
    icon: '🌐',
    rows: [
      ['git fetch', 'Download new commits without changing your files'],
      ['git pull', 'Fetch and merge into the current branch'],
      ['git push', 'Send your commits to the remote'],
      ['git push -u origin <name>', 'Publish a new branch'],
      ['git remote -v', 'Show the remotes'],
    ],
  },
  {
    group: 'History',
    icon: '🕘',
    rows: [
      ['git log --oneline --graph', 'Compact history with branches'],
      ['git show <commit>', 'What one commit changed'],
      ['git blame <file>', 'Who last changed each line'],
      ['git reflog', 'Everywhere HEAD has been — your safety net'],
    ],
  },
  {
    group: 'Undo',
    icon: '↶',
    rows: [
      ['git restore <file>', 'Throw away unstaged edits to a file'],
      ['git restore --staged <file>', 'Unstage a file, keep the edits'],
      ['git commit --amend', 'Fix the last commit (before pushing)'],
      ['git revert <commit>', 'New commit that undoes an old one — safe on shared branches'],
      ['git reset --soft HEAD~1', 'Undo the last commit, keep its changes staged'],
      ['git stash / git stash pop', 'Park work in progress and bring it back'],
    ],
  },
];

function CheatSheetDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const groups = CHEATS.map((g) => ({ ...g, rows: g.rows.filter(([c, d]) => !q || `${c} ${d}`.toLowerCase().includes(q.toLowerCase())) })).filter((g) => g.rows.length);
  const copy = (cmd: string) => void call('app:copyText', { text: cmd }).then(() => toast(`Copied “${cmd}”`));
  return (
    <Modal title="Git cheat sheet" icon="📄" size="wide" onClose={onClose}>
      <input className="mb" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a command (e.g. undo, branch, push)…" />
      <div className="cs-grid">
        {groups.map((g) => (
          <section key={g.group} className="cs-card">
            <h3>
              <span aria-hidden>{g.icon}</span> {g.group}
            </h3>
            {g.rows.map(([c, d]) => (
              <button key={c} className="cs-row" onClick={() => copy(c)} title="Click to copy">
                <code>{c}</code>
                <span className="small muted">{d}</span>
              </button>
            ))}
          </section>
        ))}
        {groups.length === 0 && <div className="muted">Nothing matches “{q}”.</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- best practices

const PRACTICES: { icon: string; title: string; why: string; how: ReactNode }[] = [
  { icon: '🎯', title: 'Small, focused commits', why: 'Easy to review, easy to revert, and the history explains itself.', how: 'One idea per commit. Stage parts of files when one file holds two changes.' },
  { icon: '📝', title: 'Write clear commit messages', why: 'Future you (and your team) read the history to understand why.', how: <>A short summary line in the imperative — <code>fix: handle empty token</code> — then a blank line and the reason if it is not obvious.</> },
  { icon: '⎇', title: 'Work on a branch, not on main', why: 'Main stays releasable; your work can be reviewed before it lands.', how: <>Name branches by purpose: <code>feature/login</code>, <code>fix/crash-on-save</code>.</> },
  { icon: '🔄', title: 'Sync often', why: 'Small, early merges are far easier than one big conflict at the end.', how: 'Fetch and bring the base branch into yours every day or before opening a pull request.' },
  { icon: '👀', title: 'Review before you push', why: 'Mistakes are cheap to fix locally and expensive once shared.', how: 'Read your diff once more. Use pull requests so someone else looks too.' },
  { icon: '🚫', title: 'Never rewrite shared history', why: 'Force-pushing a branch others use breaks their copies.', how: <>Use <code>git revert</code> on shared branches; keep rebase and amend for your own, unpushed work.</> },
  { icon: '🔐', title: 'Keep secrets out of Git', why: 'Anything committed lives forever in the history, even after deletion.', how: <>Use environment variables or a secret store, and add files like <code>.env</code> to <code>.gitignore</code>.</> },
  { icon: '🧹', title: 'Ignore generated files', why: 'Build output and dependencies bloat the repository and cause conflicts.', how: <>List <code>node_modules/</code>, <code>dist/</code> and logs in <code>.gitignore</code>.</> },
  { icon: '🏷', title: 'Tag releases', why: 'You can always find, rebuild and compare exactly what was shipped.', how: <>Annotated tags with versions: <code>git tag -a v1.2.0 -m "v1.2.0"</code>.</> },
  { icon: '✍', title: 'Sign your commits', why: 'Proves the commits really came from you.', how: 'Set up a GPG or SSH signing key in Account → Keys, and turn on signing.' },
];

function PracticesDialog({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <Modal title="Git best practices" icon="🌱" onClose={onClose}>
      <div className="bp-list">
        {PRACTICES.map((p, i) => (
          <div key={p.title} className={`bp-item ${open === i ? 'open' : ''}`}>
            <button className="bp-head" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              <span className="bp-n">{i + 1}</span>
              <span className="bp-ico" aria-hidden>
                {p.icon}
              </span>
              <strong className="grow">{p.title}</strong>
              <span className="bp-chev">›</span>
            </button>
            {open === i && (
              <div className="bp-body">
                <div>
                  <span className="bp-k">Why</span> {p.why}
                </div>
                <div>
                  <span className="bp-k">How</span> {p.how}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- updates

function UpdateDialog({ onClose }: { onClose: () => void }) {
  const { info } = useApp();
  const [res, setRes] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      setRes(await call('app:checkUpdate'));
    } catch {
      setRes({ current: info?.version ?? '', latest: null, url: null, notes: null, publishedAt: null, status: 'unknown', message: 'Could not check for updates.' });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Modal
      title="Check for updates"
      icon="⟲"
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => void check()} disabled={busy}>
            <Hourglass spinning={busy} /> Check again
          </button>
          <span className="spacer" />
          {res?.status === 'available' && res.url && (
            <button className="btn primary" onClick={() => void call('shell:openExternal', { url: res.url! })}>
              Get v{res.latest}
            </button>
          )}
          <button className={`btn ${res?.status === 'available' ? '' : 'primary'}`} onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className={`up-hero ${busy ? 'busy' : res?.status ?? ''}`}>
        <span className="up-ico" aria-hidden>
          {busy ? <Hourglass spinning /> : res?.status === 'available' ? '⬆' : res?.status === 'up-to-date' ? '✓' : '?'}
        </span>
        <div>
          <strong>{busy ? 'Checking…' : res?.status === 'available' ? `Version ${res.latest} is available` : res?.status === 'up-to-date' ? 'You have the latest version' : 'Could not tell'}</strong>
          <div className="small muted">
            {busy ? 'Asking GitHub for the newest release.' : res?.message ?? `You are on v${res?.current ?? info?.version ?? '…'}${res?.latest ? ` · newest is v${res.latest}` : ''}${res?.publishedAt ? ` (${new Date(res.publishedAt).toLocaleDateString()})` : ''}.`}
          </div>
        </div>
      </div>
      {!busy && res?.status === 'available' && res.notes && <pre className="up-notes">{res.notes}</pre>}
    </Modal>
  );
}
