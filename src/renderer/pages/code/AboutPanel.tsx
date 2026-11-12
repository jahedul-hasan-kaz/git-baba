import { useEffect, useState } from 'react';
import { languageColor } from '../../../shared/languages';
import type { RepoOverview } from '../../../shared/github';
import type { CodeInfo, FriendlyError } from '../../../shared/types';
import { Avatar, relTime, Skeleton } from '../../components/github/common';
import { call, toFriendly } from '../../services/api';
import { useApp } from '../../state/AppState';

const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString());
const open = (url: string) => void call('shell:openExternal', { url }).catch(() => undefined);

const DEPLOY_STATE: Record<string, { cls: string; label: string }> = {
  success: { cls: 'ok', label: 'Active' },
  active: { cls: 'ok', label: 'Active' },
  inactive: { cls: '', label: 'Inactive' },
  failure: { cls: 'danger', label: 'Failed' },
  error: { cls: 'danger', label: 'Error' },
  in_progress: { cls: 'warn', label: 'Deploying' },
  queued: { cls: 'warn', label: 'Queued' },
  pending: { cls: 'warn', label: 'Pending' },
};

export function LanguageBar({ languages }: { languages: Record<string, number> }) {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (!total) return <div className="small muted">No source files detected.</div>;
  const shown = entries.filter(([, v]) => v / total >= 0.001).slice(0, 8);
  const other = total - shown.reduce((n, [, v]) => n + v, 0);
  return (
    <>
      <div className="lang-bar">
        {shown.map(([l, v]) => (
          <span key={l} style={{ width: `${(v / total) * 100}%`, background: languageColor(l) }} title={`${l} ${((v / total) * 100).toFixed(1)}%`} />
        ))}
        {other > 0 && <span style={{ width: `${(other / total) * 100}%`, background: '#8b949e' }} title="Other" />}
      </div>
      <div className="lang-list">
        {shown.map(([l, v]) => (
          <span key={l} className="lang-item">
            <span className="lang-dot" style={{ background: languageColor(l) }} />
            <strong>{l}</strong> <span className="muted">{((v / total) * 100).toFixed(1)}%</span>
          </span>
        ))}
        {other > 0 && (
          <span className="lang-item">
            <span className="lang-dot" style={{ background: '#8b949e' }} />
            <strong>Other</strong> <span className="muted">{((other / total) * 100).toFixed(1)}%</span>
          </span>
        )}
      </div>
    </>
  );
}

/** Right-hand "About" column of the Code tab. GitHub data is optional; local data is always shown. */
export function AboutPanel({ repoId, info, isGitHub }: { repoId: string; info: CodeInfo | null; isGitHub: boolean }) {
  const { ghKey, revision, setView } = useApp();
  const [gh, setGh] = useState<RepoOverview | null>(null);
  const [ghError, setGhError] = useState<FriendlyError | null>(null);
  const [ghLoading, setGhLoading] = useState(isGitHub);
  const [authors, setAuthors] = useState<{ name: string; email: string; commits: number }[]>([]);

  useEffect(() => {
    if (!isGitHub) return;
    let cancelled = false;
    setGhLoading(true);
    setGhError(null);
    call('gh:repoOverview', { repoId })
      .then((d) => !cancelled && setGh(d))
      .catch((err) => {
        if (cancelled) return;
        setGh(null);
        setGhError(toFriendly(err));
      })
      .finally(() => !cancelled && setGhLoading(false));
    return () => {
      cancelled = true;
    };
  }, [repoId, isGitHub, ghKey]);

  useEffect(() => {
    call('graph:authors', { repoId })
      .then(setAuthors)
      .catch(() => setAuthors([]));
  }, [repoId, revision]);

  const needsSignIn = ghError && (ghError.code === 'session-required' || ghError.code === 'session-expired' || ghError.code === 'no-account');
  const people = gh?.contributors.length
    ? gh.contributors.map((c) => ({ key: c.login, name: c.login, n: c.contributions, url: c.url }))
    : authors.map((a) => ({ key: a.email, name: a.name, n: a.commits, url: '' }));
  const peopleTotal = gh?.contributorsTotal ?? people.length;
  const topN = Math.max(1, ...people.map((c) => c.n));
  const langs = gh && Object.keys(gh.languages).length ? gh.languages : (info?.languages ?? null);
  const envs = gh
    ? Object.values(
        gh.deployments.reduce<Record<string, RepoOverview['deployments'][number]>>((acc, d) => {
          if (!acc[d.environment]) acc[d.environment] = d;
          return acc;
        }, {}),
      )
    : [];

  return (
    <aside className="about ab">
      {/* Identity card */}
      <section className="ab-card ab-hero">
        <div className="ab-head">
          <span className="ab-k">About</span>
          {gh && (
            <button className="ab-icon" onClick={() => open(gh.htmlUrl)} title="Open on GitHub">
              ↗
            </button>
          )}
        </div>
        {ghLoading && !gh ? (
          <Skeleton rows={3} />
        ) : gh ? (
          <div className="fade-in">
            <div className="ab-stats">
              <div className={`ab-stat ${gh.viewerStarred ? 'on' : ''}`} title={gh.viewerStarred ? 'You starred this repository' : 'Stars'}>
                <b>{fmt(gh.stars)}</b>
                <span>{gh.viewerStarred ? '★' : '☆'} stars</span>
              </div>
              <div className="ab-stat" title="People watching this repository">
                <b>{fmt(gh.watchers)}</b>
                <span>◉ watching</span>
              </div>
              <div className="ab-stat" title="Forks">
                <b>{fmt(gh.forks)}</b>
                <span>⑂ forks</span>
              </div>
            </div>
            <div className="ab-meta">
              <span>📖 Readme</span>
              {gh.license && <span>⚖ {gh.license}</span>}
              {gh.isFork && gh.parent && <span>⑂ from {gh.parent}</span>}
              {gh.homepage && (
                <a onClick={() => open(/^https?:\/\//.test(gh.homepage!) ? gh.homepage! : `https://${gh.homepage}`)}>🔗 {gh.homepage.replace(/^https?:\/\//, '')}</a>
              )}
            </div>
          </div>
        ) : (
          <div className="small muted">
            {!isGitHub ? (
              'Local repository — connect a GitHub remote to see stars, forks, watchers and deployments.'
            ) : needsSignIn ? (
              <>
                Sign in to your GitHub account to see stars, forks, watchers, contributors and deployments.{' '}
                <a onClick={() => setView('accounts')}>Accounts →</a>
              </>
            ) : (
              <>GitHub details are unavailable: {ghError?.message}</>
            )}
          </div>
        )}
      </section>

      {/* Releases: a version timeline */}
      {gh && gh.releases.length > 0 && (
        <section className="ab-card">
          <div className="ab-head">
            <span className="ab-k">Releases</span>
            <span className="ab-count">{gh.releases.length}</span>
          </div>
          <ol className="ab-timeline">
            {gh.releases.slice(0, 4).map((r, i) => (
              <li key={r.tag} className={i === 0 && !r.prerelease ? 'latest' : r.prerelease ? 'pre' : ''} onClick={() => open(r.url)} title={`Open ${r.tag} on GitHub`}>
                <span className="ab-node" aria-hidden />
                <span className="ab-ver">{r.tag}</span>
                <span className="grow ellipsis ab-rname">{r.name !== r.tag ? r.name : ''}</span>
                <span className="ab-when">
                  {i === 0 && !r.prerelease ? 'latest · ' : r.prerelease ? 'pre · ' : ''}
                  {relTime(r.publishedAt)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Deployments: one live tile per environment */}
      {envs.length > 0 && (
        <section className="ab-card">
          <div className="ab-head">
            <span className="ab-k">Environments</span>
            <span className="ab-count">{envs.length}</span>
          </div>
          <div className="ab-envs">
            {envs.map((d) => {
              const st = DEPLOY_STATE[d.state] ?? { cls: '', label: d.state };
              return (
                <div key={d.id} className={`ab-env ${st.cls} ${d.url ? 'link' : ''}`} onClick={() => d.url && open(d.url)} title={d.url ?? undefined}>
                  <div className="ab-env-top">
                    <span className="ab-led" aria-hidden />
                    <strong className="ellipsis">{d.environment}</strong>
                    <span className="ab-env-state">{st.label}</span>
                  </div>
                  <div className="ab-env-sub ellipsis">
                    <code>{d.ref}</code> @ <code>{d.sha.slice(0, 7)}</code> · {relTime(d.createdAt)}
                  </div>
                  {d.creator && <div className="ab-env-sub ellipsis">by {d.creator}</div>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Contributors: who builds it, with their share */}
      <section className="ab-card">
        <div className="ab-head">
          <span className="ab-k">People</span>
          <span className="ab-count">{peopleTotal}</span>
        </div>
        {people.length === 0 ? (
          <span className="small muted">No commits yet.</span>
        ) : (
          <>
            <div className="ab-board">
              {people.slice(0, 4).map((c, i) => (
                <div key={c.key} className="ab-person" onClick={() => c.url && open(c.url)} style={{ cursor: c.url ? 'pointer' : 'default' }} title={`${c.name} · ${c.n} commit${c.n === 1 ? '' : 's'}`}>
                  <span className="ab-rank">{i + 1}</span>
                  <Avatar login={c.name} size={22} />
                  <span className="grow ab-pname">
                    <span className="ellipsis">{c.name}</span>
                    <span className="ab-bar">
                      <i style={{ width: `${(c.n / topN) * 100}%` }} />
                    </span>
                  </span>
                  <span className="ab-pn">{fmt(c.n)}</span>
                </div>
              ))}
            </div>
            {people.length > 4 && (
              <div className="ab-stack">
                {people.slice(4, 14).map((c) => (
                  <span key={c.key} title={`${c.name} · ${c.n}`} onClick={() => c.url && open(c.url)}>
                    <Avatar login={c.name} size={22} />
                  </span>
                ))}
                {peopleTotal > 14 && <span className="ab-more">+{peopleTotal - 14}</span>}
              </div>
            )}
            {!gh?.contributors.length && <div className="small muted mt">From local history</div>}
          </>
        )}
      </section>

      {/* Languages: a ring */}
      <section className="ab-card">
        <div className="ab-head">
          <span className="ab-k">Languages</span>
        </div>
        {langs ? <LanguageRing languages={langs} /> : <Skeleton rows={1} />}
        {!(gh && Object.keys(gh.languages).length) && info && <div className="small muted mt">Measured on {info.ref}</div>}
      </section>
    </aside>
  );
}

/** Languages as a donut with the main language in the middle, and a compact legend. */
function LanguageRing({ languages }: { languages: Record<string, number> }) {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (!total) return <div className="small muted">No source files detected.</div>;
  const shown = entries.filter(([, v]) => v / total >= 0.001).slice(0, 6);
  const other = total - shown.reduce((n, [, v]) => n + v, 0);
  const parts: [string, number, string][] = [...shown.map(([l, v]): [string, number, string] => [l, v, languageColor(l)]), ...(other > 0 ? [['Other', other, '#8b949e'] as [string, number, string]] : [])];
  let at = 0;
  const stops = parts
    .map(([, v, c]) => {
      const from = at;
      at += (v / total) * 360;
      return `${c} ${from}deg ${at}deg`;
    })
    .join(', ');
  const pct = (v: number) => {
    const p = (v / total) * 100;
    return p < 0.1 ? '<0.1' : p.toFixed(1);
  };
  return (
    <div className="ab-langs">
      <div className="ab-ring" style={{ background: `conic-gradient(${stops})` }}>
        <div className="ab-ring-in">
          <b>{Math.round((parts[0][1] / total) * 100)}%</b>
          <span className="ellipsis">{parts[0][0]}</span>
        </div>
      </div>
      <ul className="ab-legend">
        {parts.map(([l, v, c]) => (
          <li key={l}>
            <span className="lang-dot" style={{ background: c }} />
            <span className="grow ellipsis">{l}</span>
            <span className="muted">{pct(v)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
