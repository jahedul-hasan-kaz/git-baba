import { useState } from 'react';
import { ErrorPanel } from '../components/ErrorPanel';
import { Spinner } from '../components/Modal';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useAsync } from '../hooks/useAsync';
import { call } from '../services/api';
import { useApp } from '../state/AppState';

const CLS: Record<string, string> = { SUCCESS: 'ok', WARNING: 'warn', FAILED: 'danger', CANCELLED: '' };

export function OperationHistoryPage() {
  const { revision, bump } = useApp();
  const history = useAsync(() => call('history:list'), [revision]);
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const entries = (history.data ?? []).filter((e) => !filter || `${e.repoName} ${e.operation} ${e.status} ${e.summary}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="content">
      <div className="page">
        <div className="row mb">
          <h1 className="grow" style={{ margin: 0 }}>
            Operation History
          </h1>
          <input style={{ width: 260 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" />
          <button className="btn danger" onClick={() => setConfirmClear(true)} disabled={!history.data?.length}>
            Clear
          </button>
        </div>
        <p className="small muted">A local log of operations. It never contains credentials, private keys or tokens.</p>
        {history.error && <ErrorPanel error={history.error} />}
        {history.loading && !history.data && <Spinner />}
        <table className="list">
          <thead>
            <tr>
              <th>Time</th>
              <th>Repository</th>
              <th>Operation</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>
                  {new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="small">{e.repoName ?? '—'}</td>
                <td>{e.operation}</td>
                <td>
                  <span className={`badge ${CLS[e.status]}`}>{e.status}</span>
                </td>
                <td className="small muted">{e.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {history.data?.length === 0 && <div className="empty">No operations yet.</div>}
      </div>
      {confirmClear && (
        <ConfirmDialog
          title="Clear Operation History"
          explanation="Deletes the local operation log."
          impact="Repositories, files and commits are not affected."
          confirmLabel="Clear history"
          onCancel={() => setConfirmClear(false)}
          onConfirm={async () => {
            await call('history:clear');
            setConfirmClear(false);
            bump();
          }}
        />
      )}
    </div>
  );
}
