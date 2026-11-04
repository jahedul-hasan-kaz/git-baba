/**
 * A soft light that follows the pointer over the top bar and sidebar (used by the Light theme's textures).
 * Sets --mx / --my on the hovered element at most once per frame; resets when the pointer leaves.
 */
export function installSpotlight(selector = '.app-header, .sidebar'): void {
  let frame = 0;
  let pending: { el: HTMLElement; x: number; y: number } | null = null;
  let current: HTMLElement | null = null;

  const reset = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
  };

  document.addEventListener(
    'pointermove',
    (e) => {
      if (document.documentElement.dataset.theme !== 'light') return;
      const el = (e.target as Element | null)?.closest?.(selector) as HTMLElement | null;
      if (el !== current) {
        reset(current);
        current = el;
      }
      if (!el) return;
      const r = el.getBoundingClientRect();
      pending = { el, x: e.clientX - r.left, y: e.clientY - r.top };
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!pending) return;
          pending.el.style.setProperty('--mx', `${Math.round(pending.x)}px`);
          pending.el.style.setProperty('--my', `${Math.round(pending.y)}px`);
          pending = null;
        });
      }
    },
    { passive: true },
  );
  document.addEventListener('pointerleave', () => {
    reset(current);
    current = null;
  });
}
