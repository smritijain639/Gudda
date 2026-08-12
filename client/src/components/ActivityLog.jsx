import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const ACTION_LABELS = {
  login: 'Signed in',
  logout: 'Signed out',
  search: 'Search',
  'ai-search': 'AI search',
  'lifecycle-action': 'Lifecycle action',
  'submission-state-change': 'Submission state change',
  'edit-metadata': 'Edited metadata',
  delete: 'Deleted',
};

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Build a friendly one-line description of what happened, preferring the
// structured fields the server now provides and falling back to older entries.
function describe(e) {
  if (e.summary) return e.summary;
  if (e.action === 'submission-state-change') {
    const name = e.targetName || 'submission';
    const to = e.resultState || e.requestedState;
    return to ? `State change: ${name} → ${to}` : `State change: ${name}`;
  }
  if (e.object) {
    return e.recordId ? `${e.object} / ${e.recordId}` : e.object;
  }
  return actionLabel(e.action);
}

// Human-readable target cell.
function targetOf(e) {
  if (e.targetName) return e.targetName;
  if (e.object) return e.recordId ? `${e.object} / ${e.recordId}` : e.object;
  return null;
}

function detailsOf(e) {
  const parts = [];
  if (e.requestedState) parts.push(`Requested: ${e.requestedState}`);
  if (e.resultState) parts.push(`Result: ${e.resultState}`);
  if (typeof e.resultCount === 'number') parts.push(`${e.resultCount} result(s)`);
  if (!parts.length && e.detail) parts.push(e.detail);
  if (e.error) parts.push(`Error: ${e.error}`);
  return parts.join(' · ');
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsv(entries) {
  const cols = [
    '#',
    'timestamp',
    'user',
    'action',
    'target',
    'outcome',
    'details',
    'narrative',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e, i) =>
    [
      entries.length - i,
      e.timestamp,
      e.actor,
      actionLabel(e.action),
      targetOf(e) || '',
      e.outcome,
      detailsOf(e),
      e.narrative || '',
    ]
      .map(esc)
      .join(',')
  );
  return [cols.join(','), ...rows].join('\n');
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export default function ActivityLog() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());

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

  const toggle = useCallback((i) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  return (
    <div className="card">
      <div className="row-between">
        <h2>Activity log</h2>
        <div className="row-gap">
          <button
            type="button"
            onClick={() =>
              download(
                `activity-log-${fileStamp()}.json`,
                JSON.stringify(entries, null, 2),
                'application/json'
              )
            }
            disabled={loading || entries.length === 0}
          >
            Download JSON
          </button>
          <button
            type="button"
            onClick={() =>
              download(
                `activity-log-${fileStamp()}.csv`,
                toCsv(entries),
                'text/csv'
              )
            }
            disabled={loading || entries.length === 0}
          >
            Download CSV
          </button>
          <button type="button" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
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
                <th>#</th>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Target</th>
                <th>Outcome</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const num = entries.length - i;
                const target = targetOf(e);
                const details = detailsOf(e);
                const hasNarrative = Boolean(e.narrative);
                const isOpen = expanded.has(i);
                return (
                  <React.Fragment key={i}>
                    <tr className={e.outcome === 'failure' ? 'row-failure' : ''}>
                      <td className="mono muted nowrap">{num}</td>
                      <td className="mono nowrap">{fmtTime(e.timestamp)}</td>
                      <td>{e.actor}</td>
                      <td>{actionLabel(e.action)}</td>
                      <td>{target || <span className="muted">—</span>}</td>
                      <td>
                        <span
                          className={`pill ${
                            e.outcome === 'failure' ? 'pill-bad' : 'pill-good'
                          }`}
                        >
                          {e.outcome}
                        </span>
                      </td>
                      <td className="muted">
                        {details || describe(e)}
                        {hasNarrative && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => toggle(i)}
                            >
                              {isOpen ? 'Hide reasoning' : 'Show reasoning'}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {hasNarrative && isOpen && (
                      <tr className="narrative-row">
                        <td />
                        <td colSpan={6}>
                          <div className="narrative">{e.narrative}</div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
