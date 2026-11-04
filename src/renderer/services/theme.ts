export type Theme = 'default' | 'dark' | 'light' | 'system';

export interface ThemeInfo {
  id: Theme;
  label: string;
  hint: string;
  /** [window background, panel, accent] — painted in the live preview tiles. */
  swatch: [string, string, string];
}

export const THEMES: ThemeInfo[] = [
  { id: 'system', label: 'Auto', hint: 'Follows Windows / macOS light or dark mode', swatch: ['#0f1115', '#ffffff', '#5b8cff'] },
  { id: 'light', label: 'Light', hint: 'Bright, for daylight', swatch: ['#f5f7fa', '#ffffff', '#0969da'] },
  { id: 'default', label: 'Dusk', hint: 'Git Baba’s default blue-grey dark', swatch: ['#0f1115', '#1b1f2a', '#5b8cff'] },
  { id: 'dark', label: 'Midnight', hint: 'Deeper, higher-contrast dark', swatch: ['#0a0c10', '#161b23', '#4493f8'] },
];

const KEY = 'gitbaba.theme';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' || v === 'system' ? v : 'default';
  } catch {
    return 'default';
  }
}

/** The concrete palette a theme shows right now ('system' resolves to light or the default dark). */
export function resolveTheme(theme: Theme): Exclude<Theme, 'system'> {
  if (theme !== 'system') return theme;
  try {
    return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'default';
  } catch {
    return 'default';
  }
}

let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

function paint(theme: Exclude<Theme, 'system'>, animate: boolean): void {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-switching');
    window.setTimeout(() => root.classList.remove('theme-switching'), 350);
  }
  if (theme === 'default') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** Applies a theme to the document (and remembers it). `animate` cross-fades colours briefly. */
export function applyTheme(theme: Theme, animate = false): void {
  paint(resolveTheme(theme), animate);
  try {
    const mql = window.matchMedia(LIGHT_QUERY);
    if (systemListener) mql.removeEventListener('change', systemListener);
    systemListener = null;
    if (theme === 'system') {
      systemListener = (e) => paint(e.matches ? 'light' : 'default', true);
      mql.addEventListener('change', systemListener);
    }
  } catch {
    // matchMedia unavailable: the theme stays as painted
  }
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // per-viewer preference only
  }
}
