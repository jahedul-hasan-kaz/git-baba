/**
 * The app's refresh / reload / retry glyph: an hourglass whose sand drains to the bottom, then it flips over and
 * starts again. Still by default; it runs while its button is hovered or focused, and non-stop when `spinning`.
 */
export function Hourglass({ spinning, className }: { spinning?: boolean; className?: string }) {
  return (
    <svg className={`hg ${spinning ? 'run' : ''} ${className ?? ''}`} viewBox="0 0 16 16" width="1em" height="1em" aria-hidden focusable="false">
      <g className="hg-body">
        <path d="M3.5 1.75h9M3.5 14.25h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M4.75 2v1.6c0 1.5 1.1 2.7 2.4 3.6L8 7.8l.85-.6c1.3-.9 2.4-2.1 2.4-3.6V2M4.75 14v-1.6c0-1.5 1.1-2.7 2.4-3.6L8 8.2l.85.6c1.3.9 2.4 2.1 2.4 3.6V14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path className="hg-top" d="M5.9 4.2h4.2c-.3.9-1 1.6-1.8 2.2L8 6.6l-.3-.2c-.8-.6-1.5-1.3-1.8-2.2z" fill="currentColor" />
        <path className="hg-bot" d="M5.6 13.1c.1-1.2 1-2.1 2.4-2.6 1.4.5 2.3 1.4 2.4 2.6z" fill="currentColor" />
        <line className="hg-fall" x1="8" y1="7.6" x2="8" y2="12" stroke="currentColor" strokeWidth=".9" strokeDasharray="1 1.2" />
      </g>
    </svg>
  );
}
