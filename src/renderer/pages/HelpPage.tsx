import { useState } from 'react';
import { GIT_HELP } from '../../shared/gitHelp';

const RISK: Record<string, { cls: string; label: string }> = {
  safe: { cls: 'ok', label: 'Low risk' },
  caution: { cls: 'warn', label: 'Use with care' },
  dangerous: { cls: 'danger', label: 'Can lose work' },
};

export function HelpPage() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const items = GIT_HELP.filter((h) => !q || `${h.command} ${h.summary} ${h.what}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="content">
      <div className="page" style={{ maxWidth: 960 }}>
        <h1>Git Help Center</h1>
        <p className="muted">Plain-language explanations of every Git command Git Baba uses: what it does, when to use it, when not to, and what can go wrong.</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search commands (e.g. pull, undo, branch)…" className="mb" />
        <div className="row wrap mb">
          {GIT_HELP.map((h) => (
            <button
              key={h.command}
              className={`btn sm ${open === h.command ? 'primary' : ''}`}
              onClick={() => {
                setOpen(h.command);
                document.getElementById(`help-${h.command.replace(' ', '-')}`)?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              {h.command}
            </button>
          ))}
        </div>
        {items.map((h) => (
          <div key={h.command} id={`help-${h.command.replace(' ', '-')}`} className="card help-card">
            <h3>
              <code style={{ fontSize: 15 }}>{h.command}</code>
              <span className="muted" style={{ fontWeight: 400 }}>
                — {h.summary}
              </span>
            </h3>
            <div className="flags">
              <span className={`badge ${RISK[h.riskLevel].cls}`}>{RISK[h.riskLevel].label}</span>
              <span className="badge">{h.contactsRemote ? '🌐 Talks to the remote' : '💻 Local only'}</span>
              <span className="badge">📝 Modifies local files: {h.modifiesLocalFiles}</span>
            </div>
            <dl>
              <dt>What</dt>
              <dd>{h.what}</dd>
              <dt>Use when</dt>
              <dd>{h.useWhen}</dd>
              <dt>Do NOT use when</dt>
              <dd>{h.avoidWhen}</dd>
              <dt>Example</dt>
              <dd>
                <pre className="token-box" style={{ fontSize: 12 }}>
                  {h.example}
                </pre>
              </dd>
              <dt>Risk</dt>
              <dd>{h.risks}</dd>
              <dt>In this app</dt>
              <dd>{h.inApp}</dd>
            </dl>
          </div>
        ))}
        {items.length === 0 && <div className="empty">No command matches “{q}”.</div>}
      </div>
    </div>
  );
}
