import type { SecurityReport } from '../../shared/types';

const STATUS_TEXT: Record<SecurityReport['status'], { label: string; cls: string; icon: string }> = {
  REVIEW_REQUIRED: { label: 'REVIEW REQUIRED', cls: 'danger', icon: '⛔' },
  REVIEW_RECOMMENDED: { label: 'REVIEW RECOMMENDED', cls: 'warn', icon: '⚠' },
  NO_ISSUES_DETECTED: { label: 'NO ISSUES DETECTED', cls: 'ok', icon: '✓' },
};

export function SecurityReportView({ report, onOpenFile }: { report: SecurityReport; onOpenFile?: (path: string) => void }) {
  const s = STATUS_TEXT[report.status];
  const byFile = new Map<string, SecurityReport['findings']>();
  for (const f of report.findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }
  return (
    <div>
      <div className={`banner ${s.cls}`}>
        <span className="icon">{s.icon}</span>
        <div className="grow">
          <strong>Security Status: {s.label}</strong>
          <div>{report.headline}</div>
          <div className="small muted">
            {report.scannedFiles} changed file(s) inspected{report.partial ? ' · some content could only be partially scanned' : ''}
          </div>
        </div>
      </div>

      {report.flaggedFiles.length > 0 && (
        <div className="card">
          <h3>Potentially suspicious changes detected</h3>
          <ul className="mono">
            {report.flaggedFiles.map((f) => (
              <li key={f}>
                {onOpenFile ? <a onClick={() => onOpenFile(f)}>{f}</a> : f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {[...byFile.entries()].map(([file, findings]) => (
        <div key={file} className="mb">
          <div className="row mb" style={{ marginBottom: 4 }}>
            <strong className="mono">{onOpenFile ? <a onClick={() => onOpenFile(file)}>{file}</a> : file}</strong>
          </div>
          {findings.map((f) => (
            <div key={f.ruleId} className={`finding ${f.severity}`}>
              <div className="row">
                <span className={`badge ${f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warn' : 'info'}`}>{f.severity.toUpperCase()}</span>
                <strong>{f.title}</strong>
                {f.line !== undefined && <span className="muted small">line {f.line}</span>}
                {f.occurrences > 1 && <span className="muted small">×{f.occurrences}</span>}
              </div>
              <div className="small">Reason: {f.reason}</div>
              {f.excerpt && <div className="excerpt">{f.excerpt}</div>}
            </div>
          ))}
        </div>
      ))}

      <p className="small muted">{report.disclaimer}</p>
    </div>
  );
}
