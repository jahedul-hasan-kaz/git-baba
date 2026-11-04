import { useMemo, useState } from 'react';
import type { AccountProfile, ContributionDay } from '../../../shared/github';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Avatar, Skeleton, useGh } from '../../components/github/common';
import { openExternal } from '../../components/github/SecureActionDialog';
import { call } from '../../services/api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Profile and contribution history of the signed-in account. */
export function ProfileOverview({ onProfile }: { onProfile?: (p: AccountProfile) => void }) {
  const [year, setYear] = useState<number | null>(null);
  const profile = useGh(async () => {
    const p = await call('gh:acctProfile', { year: year ?? undefined });
    onProfile?.(p);
    return p;
  }, [year]);

  if (profile.error) return <ErrorPanel error={profile.error} />;
  const p = profile.data;
  if (!p) return <Skeleton rows={8} />;
  const c = p.contributions;

  return (
    <div className={`profile-overview ${profile.loading ? 'is-loading' : ''}`}>
      <div className="contrib-card">
        <div className="row mb" style={{ alignItems: 'flex-end' }}>
          <div className="grow">
            <div className="contrib-total">
              <strong>{c.total.toLocaleString()}</strong> contributions {year ? `in ${year}` : 'in the last year'}
            </div>
            <div className="small muted">Commits, pull requests, reviews and issues — including private work you have access to.</div>
          </div>
          <div className="year-chips">
            <button className={`year-chip ${year === null ? 'on' : ''}`} onClick={() => setYear(null)}>
              Last 12 months
            </button>
            {p.years.slice(0, 8).map((y) => (
              <button key={y} className={`year-chip ${year === y ? 'on' : ''}`} onClick={() => setYear(y)}>
                {y}
              </button>
            ))}
          </div>
        </div>
        <Heatmap weeks={c.weeks} />
      </div>

      <div className="stat-tiles">
        <Stat icon="◉" label="Commits" value={c.commits} />
        <Stat icon="⇄" label="Pull requests" value={c.pullRequests} />
        <Stat icon="✓" label="Reviews" value={c.reviews} />
        <Stat icon="!" label="Issues" value={c.issues} />
        <Stat icon="📦" label="Repos contributed to" value={c.reposContributed} />
        <Stat icon="🔥" label="Current streak" value={c.currentStreak} suffix=" days" accent />
        <Stat icon="🏆" label="Longest streak" value={c.longestStreak} suffix=" days" />
        <Stat icon="📅" label="Busiest day" value={c.busiestDay?.count ?? 0} suffix={c.busiestDay ? ` · ${new Date(c.busiestDay.date).toLocaleDateString()}` : ''} />
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h3>Where you committed</h3>
          {c.topRepos.length === 0 && <div className="small muted">No commits in this period.</div>}
          {c.topRepos.map((r) => {
            const max = c.topRepos[0]?.count || 1;
            return (
              <div key={r.name} className="bar-row" title={`${r.count} commit(s)`}>
                <span className="ellipsis mono small">{r.name}</span>
                <span className="bar">
                  <i style={{ width: `${(r.count / max) * 100}%` }} />
                </span>
                <span className="small muted nowrap">{r.count}</span>
              </div>
            );
          })}
        </div>
        <div className="card">
          <h3>Organisations</h3>
          {p.organizations.length === 0 && <div className="small muted">No organisation memberships are visible to this token.</div>}
          <div className="org-grid">
            {p.organizations.map((o) => (
              <button key={o.login} className="org-chip" onClick={() => openExternal(`https://github.com/${o.login}`)} title={`Open ${o.login} on GitHub`}>
                <Avatar login={o.login} size={18} />
                {o.login}
              </button>
            ))}
          </div>
          <div className="small muted mt">
            Member since {new Date(p.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })} · {p.followers} followers · {p.following} following · ★ {p.starred} starred
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, suffix = '', accent }: { icon: string; label: string; value: number; suffix?: string; accent?: boolean }) {
  return (
    <div className={`stat-tile ${accent && value > 0 ? 'accent' : ''}`}>
      <span className="stat-ico">{icon}</span>
      <div>
        <div className="stat-value">
          {value.toLocaleString()}
          <span className="stat-suffix">{suffix}</span>
        </div>
        <div className="small muted">{label}</div>
      </div>
    </div>
  );
}

/** GitHub-style calendar: one column per week, one cell per day, with month labels and a hover read-out. */
function Heatmap({ weeks }: { weeks: ContributionDay[][] }) {
  const [hover, setHover] = useState<ContributionDay | null>(null);
  const months = useMemo(() => {
    const out: { col: number; label: string }[] = [];
    let last = -1;
    weeks.forEach((w, i) => {
      const m = new Date(w[0]?.date ?? '').getUTCMonth();
      if (!Number.isNaN(m) && m !== last) {
        if (i < weeks.length - 2) out.push({ col: i, label: MONTHS[m] });
        last = m;
      }
    });
    return out;
  }, [weeks]);

  return (
    <div className="heatmap-wrap">
      <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, 13px)` }}>
        {months.map((m) => (
          <span key={`${m.col}-${m.label}`} style={{ gridColumn: m.col + 1 }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="heatmap" style={{ gridTemplateColumns: `repeat(${weeks.length}, 13px)` }} onMouseLeave={() => setHover(null)}>
        {weeks.map((w, wi) =>
          w.map((d) => (
            <span
              key={d.date}
              className={`hm-cell l${d.level} ${hover?.date === d.date ? 'hover' : ''}`}
              style={{ gridColumn: wi + 1, gridRow: new Date(d.date).getUTCDay() + 1, animationDelay: `${Math.min(wi * 8, 400)}ms` }}
              onMouseEnter={() => setHover(d)}
              aria-label={`${d.count} contributions on ${d.date}`}
            />
          )),
        )}
      </div>
      <div className="heatmap-foot">
        <span className="small muted">
          {hover ? (
            <>
              <strong style={{ color: 'var(--text)' }}>{hover.count === 0 ? 'No' : hover.count} contribution{hover.count === 1 ? '' : 's'}</strong> on{' '}
              {new Date(hover.date).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}
            </>
          ) : (
            'Hover a day to see its contributions'
          )}
        </span>
        <span className="spacer" />
        <span className="small muted">Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`hm-cell l${l} legend`} />
        ))}
        <span className="small muted">More</span>
      </div>
    </div>
  );
}
