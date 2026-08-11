import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const ACTION_LABELS = {
  login: 'Signed in',
  logout: 'Signed out',
  search: 'Search',
  'ai-search': 'AI search',
  'lifecycle-action': 'Lifecycle action',
  'edit-metadata': 'Edited metadata',
  delete: 'Deleted',
};

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ActivityLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { entries: rows } = await api.getAudit(200);
      setEntries(rows || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="card">
      <div className="row-between">
        <h2>Activity log</h2>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="muted">
        Who asked the app to do what. Every action runs under the shared Business Admin
        account, so this trail records the real user behind each operation.
      </p>

      {error && <div className="alert error">{error}</div>}

      {!error && entries.length === 0 && !loading && (
        <p className="muted">No activity recorded yet.</p>
      )}

      {entries.length > 0 && (
        <div className="table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Target</th>
                <th>Outcome</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className={e.outcome === 'failure' ? 'row-failure' : ''}>
                  <td className="mono nowrap">{fmtTime(e.timestamp)}</td>
                  <td>{e.actor}</td>
                  <td>{ACTION_LABELS[e.action] || e.action}</td>
                  <td className="mono">
                    {e.object ? (
                      <>
                        {e.object}
                        {e.recordId ? <span className="muted">/{e.recordId}</span> : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${e.outcome === 'failure' ? 'pill-bad' : 'pill-good'}`}>
                      {e.outcome}
                    </span>
                  </td>
                  <td className="muted">
                    {e.detail || ''}
                    {typeof e.resultCount === 'number' ? ` (${e.resultCount} result(s))` : ''}
                    {e.error ? ` — ${e.error}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
