import { useLayoutEffect, type RefObject } from 'react';

const GAP = 8;

/**
 * Places a fixed-position menu at (x, y) and keeps it entirely inside the window: it shifts left/up when it
 * would cross the right/bottom edge, and when it is taller than the window it gets the window's height and
 * scrolls, with soft fades at the edges that still have items beyond them (`.can-up` / `.can-down`).
 */
export function fitMenu(el: HTMLElement, x: number, y: number) {
  el.style.maxHeight = `${window.innerHeight - GAP * 2}px`;
  // offset sizes: unaffected by the opening animation's transform.
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(GAP, Math.min(x, window.innerWidth - w - GAP))}px`;
  el.style.top = `${Math.max(GAP, Math.min(y, window.innerHeight - h - GAP))}px`;
  markScroll(el);
}

/** Toggles the edge fades of a scrolling menu. */
export function markScroll(el: HTMLElement) {
  const scrolls = el.scrollHeight > el.clientHeight + 1;
  el.classList.toggle('can-up', scrolls && el.scrollTop > 2);
  el.classList.toggle('can-down', scrolls && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
}

/** Hook form of {@link fitMenu}; refits when the position or `deps` change and tracks scrolling. */
export function useMenuFit(ref: RefObject<HTMLElement | null>, x: number | undefined, y: number | undefined, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || x === undefined || y === undefined) return;
    fitMenu(el, x, y);
    const onScroll = () => markScroll(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, x, y, ...deps]);
}

/**
 * Places a submenu next to its row: to the right of the parent menu, or to the left when there is no room,
 * aligned with the row and pulled up so it never runs past the bottom of the window (scrolling if needed).
 */
export function fitSubmenu(sub: HTMLElement, row: HTMLElement, menu: HTMLElement) {
  const m = menu.getBoundingClientRect();
  const it = row.getBoundingClientRect();
  sub.style.maxHeight = `${window.innerHeight - GAP * 2}px`;
  const sw = sub.offsetWidth;
  const sh = sub.offsetHeight;
  const right = m.right + 4;
  const left = right + sw + GAP <= window.innerWidth ? right : Math.max(GAP, m.left - 4 - sw);
  sub.style.left = `${left}px`;
  sub.style.top = `${Math.max(GAP, Math.min(it.top - 5, window.innerHeight - sh - GAP))}px`;
  markScroll(sub);
}
