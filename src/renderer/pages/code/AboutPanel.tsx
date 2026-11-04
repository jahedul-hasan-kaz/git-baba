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

  return (
    <aside className="about">
      <section>
        <h3>About</h3>
        {ghLoading && !gh ? (
          <Skeleton rows={2} />
        ) : gh ? (
          <div className="fade-in">
            <p className={gh.description ? '' : 'muted'} style={{ fontStyle: gh.description ? undefined : 'italic' }}>
              {gh.description ?? 'No description, website, or topics provided.'}
            </p>
            {gh.homepage && (
              <div className="about-line">
                🔗{' '}
                <a onClick={() => open(/^https?:\/\//.test(gh.homepage!) ? gh.homepage! : `https://${gh.homepage}`)} className="ellipsis">
                  {gh.homepage.replace(/^https?:\/\//, '')}
                </a>
              </div>
            )}
            {gh.topics.length > 0 && (
              <div className="topics">
                {gh.topics.map((t) => (
                  <span key={t} className="topic">
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="about-line">📖 Readme</div>
            {gh.license && <div className="about-line">⚖ {gh.license} license</div>}
            {gh.isFork && gh.parent && <div className="about-line">⑂ forked from {gh.parent}</div>}
            <div className="stat-chips">
              <span className={`stat-chip ${gh.viewerStarred ? 'on' : ''}`} title={gh.viewerStarred ? 'You starred this repository' : 'Stars'}>
                {gh.viewerStarred ? '★' : '☆'} <strong>{fmt(gh.stars)}</strong> stars
              </span>
              <span className="stat-chip" title="People watching this repository">
                👁 <strong>{fmt(gh.watchers)}</strong> watching
              </span>
              <span className="stat-chip" title="Forks">
                ⑂ <strong>{fmt(gh.forks)}</strong> forks
              </span>
            </div>
            <a className="small" onClick={() => open(gh.htmlUrl)}>
              Open on GitHub ↗
            </a>
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

      {gh && gh.releases.length > 0 && (
        <section>
          <h3>
            Releases <span className="badge">{gh.releases.length}</span>
          </h3>
          {gh.releases.slice(0, 3).map((r, i) => (
            <div key={r.tag} className="release-row" onClick={() => open(r.url)}>
              <span className="text-ok">🏷</span>
              <div className="grow">
                <div className="ellipsis">
                  <strong>{r.name}</strong> {i === 0 && !r.prerelease && <span className="badge ok">Latest</span>}
                  {r.prerelease && <span className="badge warn">Pre-release</span>}
                </div>
                <div className="small muted">{relTime(r.publishedAt)}</div>
              </div>
            </div>
          ))}
        </section>
      )}

      {gh && gh.deployments.length > 0 && (
        <section>
          <h3>
            Deployments <span className="badge">{gh.deployments.length}</span>
          </h3>
          {Object.values(
            gh.deployments.reduce<Record<string, RepoOverview['deployments'][number]>>((acc, d) => {
              if (!acc[d.environment]) acc[d.environment] = d;
              return acc;
            }, {}),
          ).map((d) => {
            const s = DEPLOY_STATE[d.state] ?? { cls: '', label: d.state };
            return (
              <div key={d.id} className="deploy-row" onClick={() => d.url && open(d.url)} style={{ cursor: d.url ? 'pointer' : 'default' }} title={d.url ?? undefined}>
                <span className={`deploy-dot ${s.cls}`} />
                <div className="grow">
                  <div className="ellipsis">
                    <strong>{d.environment}</strong> <span className={`badge ${s.cls}`}>{s.label}</span>
                  </div>
                  <div className="small muted ellipsis">
                    {d.ref} · {d.sha.slice(0, 7)} · {relTime(d.createdAt)}
                    {d.creator ? ` · ${d.creator}` : ''}
                  </div>
                </div>
                {d.url && <span className="muted">↗</span>}
              </div>
            );
          })}
        </section>
      )}

      <section>
        <h3>
          Contributors <span className="badge">{gh?.contributorsTotal ?? gh?.contributors.length ?? authors.length}</span>
        </h3>
        <div className="contributors">
          {(gh?.contributors.length ? gh.contributors.map((c) => ({ key: c.login, name: c.login, n: c.contributions, url: c.url })) : authors.slice(0, 24).map((a) => ({ key: a.email, name: a.name, n: a.commits, url: '' }))).map((c) => (
            <span key={c.key} className="contributor" title={`${c.name} · ${c.n} commit${c.n === 1 ? '' : 's'}`} onClick={() => c.url && open(c.url)}>
              <Avatar login={c.name} size={30} />
            </span>
          ))}
          {!gh?.contributors.length && authors.length === 0 && <span className="small muted">No commits yet.</span>}
        </div>
        {!gh?.contributors.length && authors.length > 0 && <div className="small muted mt">From local history</div>}
      </section>

      <section>
        <h3>Languages</h3>
        {gh && Object.keys(gh.languages).length ? <LanguageBar languages={gh.languages} /> : info ? <LanguageBar languages={info.languages} /> : <Skeleton rows={1} />}
        {!(gh && Object.keys(gh.languages).length) && info && <div className="small muted mt">Measured on {info.ref}</div>}
      </section>
    </aside>
  );
}
