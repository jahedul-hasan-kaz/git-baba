import { useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { call } from '../services/api';
import { useApp } from '../state/AppState';
import { Modal } from './Modal';

type Dialog = 'shortcuts' | 'about' | 'edition' | null;

/**
 * The slim status footer: app version and edition, Git and secure-storage state, keyboard shortcuts
 * (Ctrl+/) and a Help menu with the Help Center and About. Present on every screen.
 */
export function AppFooter() {
  const { info, setView } = useApp();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!helpOpen) return;
    const close = (e: MouseEvent) => helpRef.current && !helpRef.current.contains(e.target as Node) && setHelpOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setHelpOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [helpOpen]);

  const help = (ico: string, label: string, run: () => void, hint?: string) => (
    <button
      className="ft-menu-item"
      onClick={() => {
        setHelpOpen(false);
        run();
      }}
    >
      <span className="ft-menu-ico">{ico}</span>
      <span className="grow">{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );

  return (
    <footer className="app-footer">
      <button className="ft-item ft-brand" onClick={() => setDialog('about')} title="About Git Baba">
        <img src={logoUrl} alt="" width={14} height={14} draggable={false} />
        Git Baba <span className="ft-ver">v{info?.version ?? '…'}</span>
      </button>
      <span className="ft-sep" />
      <span className="ft-item static" title={info?.gitVersion ? `Using ${info.gitVersion}` : 'Git was not found'}>
        <span className={`ft-led ${info?.gitVersion ? 'ok' : 'bad'}`} /> {info?.gitVersion ? info.gitVersion.replace(/^git version /, 'git ') : 'git not found'}
      </span>
      {info && (
        <span className="ft-item static" title={info.encryptionAvailable ? 'Tokens are stored encrypted by the operating system' : 'Operating-system encryption is not available; tokens are not remembered'}>
          {info.encryptionAvailable ? '🔒 secure storage' : '🔓 no secure storage'}
        </span>
      )}
      <span className="spacer" />
      <button className="ft-item" onClick={() => setDialog('shortcuts')} title="Keyboard shortcuts (Ctrl+/)">
        ⌨ Shortcuts
      </button>
      <div className="ft-anchor" ref={helpRef}>
        <button className={`ft-item ${helpOpen ? 'on' : ''}`} onClick={() => setHelpOpen((o) => !o)} title="Help" aria-haspopup="menu" aria-expanded={helpOpen}>
          ? Help ▴
        </button>
        {helpOpen && (
          <div className="ft-menu pop-in" role="menu">
            {help('📘', 'Git Help Center', () => setView('help'), 'F1')}
            {help('⌨', 'Keyboard shortcuts', () => setDialog('shortcuts'), 'Ctrl+/')}
            <div className="dropdown-sep" />
            {help('⚖', 'Edition & license', () => setDialog('edition'))}
            {help('ℹ', 'About Git Baba', () => setDialog('about'))}
          </div>
        )}
      </div>
      {/* Plan indicator at the far right of the status bar, like GitKraken's. */}
      <button className="ft-plan" onClick={() => setDialog('edition')} title="Community edition — free and open source. See editions and license">
        <span className="ft-plan-ico" aria-hidden>
          <svg viewBox="0 0 16 16" width="11" height="11">
            <path d="M8 1.2 14 4.6v6.8L8 14.8 2 11.4V4.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M8 5.2 11 7v3.2L8 12 5 10.2V7z" fill="currentColor" />
          </svg>
        </span>
        Community
      </button>

      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} onEdition={() => setDialog('edition')} />}
      {dialog === 'edition' && <EditionDialog onClose={() => setDialog(null)} />}
    </footer>
  );
}

const SHORTCUTS: { group: string; icon: string; keys: [string[], string][] }[] = [
  {
    group: 'Everywhere',
    icon: '🌐',
    keys: [
      [['Ctrl', '1…9'], 'Switch repository tab'],
      [['Ctrl', '/'], 'Show these shortcuts'],
      [['?'], 'Show these shortcuts'],
      [['F1'], 'Git Help Center'],
      [['Esc'], 'Close a window or menu'],
    ],
  },
  {
    group: 'Changes workspace',
    icon: '◉',
    keys: [
      [['Ctrl', 'B'], 'Show / hide the repositories sidebar'],
      [['Ctrl', 'Shift', 'B'], 'Show / hide the branches sidebar'],
      [['Ctrl', 'Shift', 'F'], 'Filter branches, stashes and tags'],
      [['Ctrl', 'Shift', 'N'], 'New branch'],
      [['W'], 'Back to your working changes'],
      [['↑', '↓'], 'Previous / next commit (also J / K)'],
      [['C'], 'Copy the commit SHA'],
      [['B'], 'Branch from the commit'],
      [['T'], 'Tag the commit'],
      [['P'], 'Cherry-pick the commit'],
      [['Shift', 'F10'], 'Commit menu'],
    ],
  },
  {
    group: 'Branches sidebar',
    icon: '⎇',
    keys: [
      [['Click'], 'Show the branch or tag in the graph'],
      [['Double-click'], 'Switch to the branch'],
      [['Drag', '→', 'branch'], 'Merge one branch into another'],
      [['Right-click'], 'All branch, stash and tag actions'],
    ],
  },
  {
    group: 'Staging & commit',
    icon: '✎',
    keys: [
      [['Space'], 'Stage / unstage the file'],
      [['Del'], 'Discard the file’s changes'],
      [['Ctrl', 'Click'], 'Pick several files'],
      [['Shift', 'Click'], 'Pick a range of files'],
      [['Ctrl', 'A'], 'Pick every file'],
      [['Ctrl', 'Enter'], 'Commit'],
      [['Esc'], 'Close the file diff'],
    ],
  },
  {
    group: 'Diff focus view',
    icon: '⤢',
    keys: [
      [['[', ']'], 'Previous / next file'],
      [['P', 'N'], 'Previous / next change'],
      [['−', '+'], 'Text size'],
      [['W'], 'Wrap long lines'],
    ],
  },
  {
    group: 'Comparing commits',
    icon: '⇄',
    keys: [
      [['Drag', '→', 'commit'], 'Compare two commits'],
      [['Esc'], 'Leave compare mode'],
    ],
  },
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    return SHORTCUTS.map((g) => ({ ...g, keys: g.keys.filter(([k, d]) => !s || d.toLowerCase().includes(s) || k.join(' ').toLowerCase().includes(s) || g.group.toLowerCase().includes(s)) })).filter((g) => g.keys.length);
  }, [q]);
  return (
    <Modal title="Keyboard Shortcuts" icon="⌨" size="wide" onClose={onClose}>
      <input className="mb" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shortcuts…" />
      <div className="kb-grid">
        {groups.map((g) => (
          <section key={g.group} className="kb-group">
            <h4>
              <span>{g.icon}</span> {g.group}
            </h4>
            {g.keys.map(([keys, desc]) => (
              <div key={desc + keys.join()} className="kb-row">
                <span className="grow">{desc}</span>
                <span className="kb-keys">
                  {keys.map((k, i) => (k === '→' ? <span key={i} className="muted">→</span> : <kbd key={i}>{k}</kbd>))}
                </span>
              </div>
            ))}
          </section>
        ))}
        {groups.length === 0 && <div className="muted">No shortcut matches “{q}”.</div>}
      </div>
    </Modal>
  );
}

function AboutDialog({ onClose, onEdition }: { onClose: () => void; onEdition: () => void }) {
  const { info, toast, showError } = useApp();
  const details = `Git Baba ${info?.version ?? ''}\n${info?.gitVersion ?? 'git not found'}\nPlatform: ${info?.platform ?? ''}\nSecure storage: ${info?.encryptionAvailable ? 'yes' : 'no'}`;
  return (
    <Modal
      title="About Git Baba"
      icon="ℹ"
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => call('app:copyText', { text: details }).then(() => toast('Version details copied'), showError)}>
            ⧉ Copy details
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="about-hero">
        <img src={logoUrl} alt="" width={64} height={64} draggable={false} />
        <div>
          <h2 style={{ margin: 0 }}>Git Baba</h2>
          <div className="muted">Review → Authenticate → Confirm</div>
          <button className="ft-edition about-edition" onClick={onEdition}>
            <span className="ft-edition-dot" /> Community Edition · v{info?.version ?? '…'}
          </button>
        </div>
      </div>
      <p className="small">A security-first Git client: every risky step is explained, reviewed and confirmed, with backups before anything is rewritten.</p>
      <dl className="kv">
        <dt>Version</dt>
        <dd className="mono">{info?.version ?? '…'}</dd>
        <dt>Git</dt>
        <dd className="mono">{info?.gitVersion ?? 'not found'}</dd>
        <dt>Platform</dt>
        <dd className="mono">{info?.platform ?? '…'}</dd>
        <dt>Secure storage</dt>
        <dd>{info?.encryptionAvailable ? '✓ available' : 'not available'}</dd>
        <dt>License</dt>
        <dd>MIT</dd>
      </dl>
    </Modal>
  );
}

function EditionDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, boolean, boolean][] = [
    ['Changes workspace, graph, staging by line', true, true],
    ['Merge Studio, transplant, cherry-pick, rebase, reset with undo', true, true],
    ['GitHub pull requests, Actions, security', true, true],
    ['Multiple accounts, PAT / GitHub App / gh CLI sign-in', true, true],
    ['Use at work and in commercial projects', true, true],
    ['Priority support & onboarding for teams', false, true],
    ['Custom builds and deployment help', false, true],
  ];
  return (
    <Modal title="Edition & License" icon="⚖" onClose={onClose}>
      <div className="ed-grid">
        <div className="ed-card on">
          <div className="ed-badge">Your edition</div>
          <h3>Community</h3>
          <div className="small muted">Free · open source · MIT license</div>
        </div>
        <div className="ed-card">
          <div className="ed-badge muted">On request</div>
          <h3>Commercial support</h3>
          <div className="small muted">For teams that want help and guarantees</div>
        </div>
      </div>
      <table className="ed-table">
        <tbody>
          {rows.map(([label, c, p]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className={c ? 'text-ok' : 'muted'}>{c ? '✓' : '—'}</td>
              <td className={p ? 'text-ok' : 'muted'}>{p ? '✓' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Every feature is in the Community edition. The MIT license allows personal and commercial use; commercial support is an optional service, not a different app.</p>
    </Modal>
  );
}
