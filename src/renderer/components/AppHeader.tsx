import { useEffect, useRef, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { applyTheme, getTheme, resolveTheme, THEMES, type Theme } from '../services/theme';
import { useApp, type GlobalView } from '../state/AppState';
import { AccountSwitcher } from './AccountSwitcher';

// Git Help lives in the footer's Help menu (F1); the header keeps only the global pages.
const NAV: [GlobalView, string, string][] = [
  ['accounts', '👤', 'Account'],
  ['token', '🧩', 'GitHub App Token'],
];

/** Global header: app identity, global pages, theme and the GitHub account switcher. */
export function AppHeader() {
  const { view, setView, activeRepoId } = useApp();
  return (
    <header className="app-header">
      <div className="row" style={{ cursor: 'pointer' }} onClick={() => setView(activeRepoId ? 'repo' : 'welcome')}>
        <img className="app-logo-img" src={logoUrl} alt="" width={28} height={28} draggable={false} />
        <div>
          <div style={{ fontWeight: 700, lineHeight: 1.1 }}>Git Baba</div>
          <div className="small muted" style={{ lineHeight: 1.1 }}>
            Review → Authenticate → Confirm
          </div>
        </div>
      </div>
      <nav className="row" style={{ marginLeft: 24 }}>
        {NAV.map(([v, icon, label]) => (
          <button key={v} className={`btn ghost sm ${view === v ? 'nav-active' : ''}`} onClick={() => setView(v)}>
            <span aria-hidden>{icon}</span> {label}
          </button>
        ))}
      </nav>
      <span className="spacer" />
      <ThemeControl />
      <AccountSwitcher />
    </header>
  );
}

/** Small line icons (currentColor) for each theme. */
export function ThemeIcon({ theme, size = 16 }: { theme: Theme; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (theme === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
      </svg>
    );
  }
  if (theme === 'system') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
      {theme === 'dark' && <path d="M17 3.5v3M15.5 5h3M20.5 8.5v2M19.5 9.5h2" strokeWidth={1.6} />}
    </svg>
  );
}

/**
 * Theme control: an icon pill that shows the current theme; it opens a small popover of live preview tiles.
 * Choices apply instantly and are remembered. "Auto" follows the operating system.
 */
function ThemeControl() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [spin, setSpin] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const pick = (t: Theme) => {
    if (t === theme) return;
    setTheme(t);
    setSpin((s) => s + 1);
    applyTheme(t, true);
  };
  const current = THEMES.find((t) => t.id === theme)!;
  const shown = resolveTheme(theme);

  return (
    <div className="pop-anchor ax-theme" ref={ref}>
      <button
        className={`ax-theme-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={`Theme: ${current.label} — click to change`}
        aria-label={`Theme: ${current.label}. Change theme`}
        aria-expanded={open}
      >
        <span key={spin} className="ax-theme-ico">
          <ThemeIcon theme={theme} />
        </span>
        <span className="ax-theme-name">{current.label}</span>
      </button>
      {open && (
        <div className="dropdown ax-theme-pop pop-in" role="radiogroup" aria-label="Theme">
          <div className="ax-theme-grid">
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={theme === t.id} className={`ax-theme-tile ${theme === t.id ? 'on' : ''}`} onClick={() => pick(t.id)} title={t.hint}>
                <ThemePreview theme={t} />
                <span className="ax-theme-tile-label">
                  <ThemeIcon theme={t.id} size={13} /> {t.label}
                </span>
              </button>
            ))}
          </div>
          <div className="ax-theme-hint">{theme === 'system' ? `Following your system — now ${shown === 'light' ? 'light' : 'dark'}.` : current.hint}</div>
        </div>
      )}
    </div>
  );
}

/** A tiny window mock-up painted in the theme's colours ("Auto" is split light / dark). */
function ThemePreview({ theme }: { theme: (typeof THEMES)[number] }) {
  if (theme.id === 'system') {
    const light = THEMES.find((t) => t.id === 'light')!;
    const dusk = THEMES.find((t) => t.id === 'default')!;
    return (
      <span className="ax-prev ax-prev-split">
        <MiniWindow sw={dusk.swatch} />
        <MiniWindow sw={light.swatch} />
      </span>
    );
  }
  return (
    <span className="ax-prev">
      <MiniWindow sw={theme.swatch} />
    </span>
  );
}

function MiniWindow({ sw }: { sw: [string, string, string] }) {
  const [bg, panel, accent] = sw;
  const light = bg.startsWith('#f');
  const line = light ? 'rgba(0,0,0,.14)' : 'rgba(255,255,255,.14)';
  return (
    <span className="ax-mini" style={{ background: bg }}>
      <span className="ax-mini-bar" style={{ background: panel, borderColor: line }}>
        <i style={{ background: accent }} />
      </span>
      <span className="ax-mini-side" style={{ background: panel, borderColor: line }} />
      <span className="ax-mini-body">
        <i style={{ background: line, width: '80%' }} />
        <i style={{ background: line, width: '55%' }} />
        <i style={{ background: accent, width: '35%' }} />
      </span>
    </span>
  );
}
