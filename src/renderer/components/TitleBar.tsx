import { useEffect, useRef, useState } from 'react';
import type { AppMenuId } from '../../shared/api';
import logoUrl from '../assets/logo.png';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

const LABEL: Record<AppMenuId, string> = { file: 'File', view: 'View', help: 'Help' };

/** The CSS colour value as #rrggbb, or null when it is not a plain hex colour. */
function hexVar(name: string): string | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  return null;
}

/**
 * The window's title bar, VS Code style: app icon, name and the File / Help menus on the left, the system's
 * own minimise / maximise / close buttons on the right. The bar can be dragged to move the window, and
 * double-clicked to maximise. Menus open as native pop-ups under their titles.
 */
export function TitleBar() {
  const { info } = useApp();
  const [menus, setMenus] = useState<AppMenuId[]>(['file', 'help']);
  const [open, setOpen] = useState<AppMenuId | null>(null);
  const refs = useRef<Partial<Record<AppMenuId, HTMLButtonElement | null>>>({});
  const mac = info?.platform === 'darwin';

  useEffect(() => {
    void call('app:menus').then(setMenus).catch(() => undefined);
  }, []);

  // Keep the window-button area in the theme's colours.
  useEffect(() => {
    const paint = () => {
      const color = hexVar('--bg');
      const symbolColor = hexVar('--text-2');
      if (color && symbolColor) void call('app:titleBar', { color, symbolColor }).catch(() => undefined);
    };
    paint();
    const obs = new MutationObserver(() => window.setTimeout(paint, 0));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => obs.disconnect();
  }, []);

  const show = async (id: AppMenuId) => {
    const el = refs.current[id];
    if (!el) return;
    const r = el.getBoundingClientRect();
    setOpen(id);
    try {
      await call('app:menuPopup', { menu: id, x: r.left, y: r.bottom });
    } finally {
      setOpen((o) => (o === id ? null : o));
    }
  };

  // Alt+F / Alt+H open the menus, like a native menu bar.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const id = menus.find((m) => LABEL[m][0].toLowerCase() === e.key.toLowerCase());
      if (!id) return;
      e.preventDefault();
      void show(id);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menus]);

  return (
    <div className={`titlebar ${mac ? 'mac' : ''}`}>
      {!mac && <img className="tb-logo" src={logoUrl} alt="" width={16} height={16} draggable={false} />}
      <span className="tb-name">Git Baba</span>
      <nav className="tb-menus" role="menubar">
        {menus.map((id) => (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === id}
            className={`tb-menu ${open === id ? 'on' : ''}`}
            onClick={() => void show(id)}
          >
            <u>{LABEL[id][0]}</u>
            {LABEL[id].slice(1)}
          </button>
        ))}
      </nav>
    </div>
  );
}
