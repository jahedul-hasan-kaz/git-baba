import { useState } from 'react';
import type { GhRepoContext } from '../../../shared/github';

const LEVELS = ['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_INFO: Record<Level, { icon: string; label: string; blurb: string }> = {
  READ: { icon: '👁', label: 'Read', blurb: 'View and clone the code, open issues and comment.' },
  TRIAGE: { icon: '🏷', label: 'Triage', blurb: 'Manage issues and pull requests without write access to the code.' },
  WRITE: { icon: '✎', label: 'Write', blurb: 'Push branches, merge pull requests and run workflows.' },
  MAINTAIN: { icon: '🛠', label: 'Maintain', blurb: 'Manage the repository without access to sensitive or destructive actions.' },
  ADMIN: { icon: '👑', label: 'Admin', blurb: 'Full access, including settings, secrets, deploy keys and deletion.' },
};

/** What each level unlocks in this app, from the lowest level that allows it. */
const ABILITIES: { label: string; from: Level }[] = [
  { label: 'Browse code, branches, tags & commits', from: 'READ' },
  { label: 'Label & review pull requests', from: 'TRIAGE' },
  { label: 'Push, merge & run Actions', from: 'WRITE' },
  { label: 'Manage branch protection', from: 'MAINTAIN' },
  { label: 'Secrets, deploy keys & danger zone', from: 'ADMIN' },
];

/**
 * The signed-in account's role on the repository: where it sits on GitHub's permission ladder and
 * what it unlocks here. Click a step to see what that level would allow.
 */
export function RoleCard({ ctx }: { ctx: GhRepoContext }) {
  const level = (LEVELS.includes(ctx.permissions.level as Level) ? ctx.permissions.level : 'READ') as Level;
  const rank = LEVELS.indexOf(level);
  const [peek, setPeek] = useState<Level | null>(null);
  const [open, setOpen] = useState(false);
  const shown = peek ?? level;
  const shownRank = LEVELS.indexOf(shown);

  return (
    <div className={`role-card role-${level.toLowerCase()}`}>
      <button className="role-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="role-badge">{LEVEL_INFO[level].icon}</span>
        <span className="grow">
          <span className="role-k">Your role · {ctx.account}</span>
          <span className="role-v">{LEVEL_INFO[level].label}</span>
        </span>
        <span className="role-caret">{open ? '▴' : '▾'}</span>
      </button>

      <div className="role-ladder" role="list" onMouseLeave={() => setPeek(null)}>
        {LEVELS.map((l, i) => (
          <button
            key={l}
            role="listitem"
            className={`role-step ${i <= rank ? 'have' : ''} ${l === level ? 'me' : ''} ${l === peek ? 'peek' : ''}`}
            title={`${LEVEL_INFO[l].label}: ${LEVEL_INFO[l].blurb}`}
            onMouseEnter={() => setPeek(l)}
            onFocus={() => setPeek(l)}
            onClick={() => {
              setPeek(l);
              setOpen(true);
            }}
          />
        ))}
      </div>
      <div className="role-ladder-labels">
        <span>Read</span>
        <span>Admin</span>
      </div>

      {open && (
        <div className="role-body">
          <div className="small">
            <strong>{LEVEL_INFO[shown].label}</strong>
            {shown !== level && <span className="muted"> {shownRank > rank ? '(above your role)' : '(included in your role)'}</span>}
          </div>
          <div className="small muted mb">{LEVEL_INFO[shown].blurb}</div>
          <ul className="role-abilities">
            {ABILITIES.map((a) => {
              const ok = LEVELS.indexOf(a.from) <= shownRank;
              return (
                <li key={a.label} className={ok ? 'ok' : 'off'}>
                  <span>{ok ? '✓' : '✕'}</span> {a.label}
                </li>
              );
            })}
          </ul>
          {rank < LEVELS.length - 1 && <div className="small muted mt">Need more? A repository admin can raise your role on GitHub.</div>}
        </div>
      )}
      <div className="role-foot small muted">
        {ctx.isPrivate ? '🔒 Private' : '🌐 Public'} · {ctx.ownerType === 'Organization' ? 'organisation' : 'personal'} repository
      </div>
    </div>
  );
}
