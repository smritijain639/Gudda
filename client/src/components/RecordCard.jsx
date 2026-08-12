import React, { useState } from 'react';
import { api } from '../api.js';

function statusOf(record) {
  const s = record.status__v;
  if (Array.isArray(s)) return s.join(', ');
  return s || '—';
}

// A single record shown inside a bot message. Depending on the user's intent it
// exposes lifecycle actions and/or a guarded delete flow. Outcomes are reported
// back into the chat via onActivity.
export default function RecordCard({ object, record, intent, onActivity }) {
  const [open, setOpen] = useState(false);
  // Full lifecycle picture: { currentStateLabel, states: [{label, current, available, action, inactive}] }.
  const [lifecycle, setLifecycle] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState('');
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState(statusOf(record));
  const [removed, setRemoved] = useState(false);

  // Delete flow state.
  const [confirming, setConfirming] = useState(false);
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const label = record.name__v || record.id;

  async function loadActions() {
    setOpen((o) => !o);
    if (lifecycle || loading) return;
    setLoading(true);
    setError('');
    try {
      const overview = await api.getLifecycle(object, record.id);
      setLifecycle(overview);
      if (overview.currentStateLabel) setStatus(overview.currentStateLabel);
      const reachable = (overview.states || []).filter((s) => s.available);
      if (!reachable.length) {
        setError('No state changes are available from the current state.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!chosen) return;
    const target = (lifecycle?.states || []).find((s) => s.action === chosen);
    const actLabel = target?.label || chosen;
    setApplying(true);
    try {
      // Submission state changes must go through the compliance pipeline, which
      // enforces the Affiliate Manager role check. The chat surfaces the
      // approval/denial and the GxP audit narrative.
      if (object === 'submission__v') {
        const result = await api.changeSubmissionState(
          `Change lifecycle state of submission ${label} to ${target?.label || actLabel}`
        );
        onActivity?.({ pipeline: result });
        if (result.status === 'executed') {
          const overview = await api.getLifecycle(object, record.id);
          setLifecycle(overview);
          if (overview.currentStateLabel) setStatus(overview.currentStateLabel);
          setChosen('');
        }
        return;
      }

      await api.executeAction(object, record.id, chosen);
      onActivity?.({ ok: true, text: `Moved ${label} to “${actLabel}”.` });
      // Refresh the lifecycle picture so the new current state and its
      // available transitions are reflected.
      const overview = await api.getLifecycle(object, record.id);
      setLifecycle(overview);
      if (overview.currentStateLabel) setStatus(overview.currentStateLabel);
      setChosen('');
    } catch (err) {
      onActivity?.({ ok: false, text: `Could not move to “${actLabel}”: ${err.message}` });
    } finally {
      setApplying(false);
    }
  }

  async function startDelete() {
    setConfirming(true);
    if (plan || planLoading) return;
    setPlanLoading(true);
    try {
      const res = await api.getDeletionPlan(object, record.id);
      setPlan(res.plan || res.deleted || res.records || []);
    } catch (err) {
      // Plan is best-effort; deletion can still proceed.
      setPlan(null);
      onActivity?.({ ok: false, text: `Couldn't preview the deletion impact: ${err.message}` });
    } finally {
      setPlanLoading(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      const res = await api.deleteRecord(object, record.id, { mode: 'hard' });
      const n = res.count || (res.deleted ? res.deleted.length : 1);
      setRemoved(true);
      onActivity?.({
        ok: true,
        text: `Deleted ${label}${n > 1 ? ` and ${n - 1} related record(s)` : ''}.`,
      });
    } catch (err) {
      onActivity?.({ ok: false, text: `Could not delete ${label}: ${err.message}` });
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (removed) {
    return (
      <div className="rec-card rec-removed">
        <span className="rec-name strike">{label}</span>
        <span className="pill pill-bad">deleted</span>
      </div>
    );
  }

  return (
    <div className="rec-card">
      <div className="rec-head">
        <div className="rec-main">
          <span className="rec-name">{label}</span>
          <span className="rec-meta mono">
            {object} · {status}
          </span>
        </div>
        <div className="rec-btns">
          <button type="button" className="btn-ghost sm" onClick={loadActions}>
            {open ? 'Hide actions' : 'Actions'}
          </button>
          <button
            type="button"
            className="btn-danger sm"
            onClick={() => (confirming ? setConfirming(false) : startDelete())}
          >
            Delete
          </button>
        </div>
      </div>

      {open && (
        <div className="rec-actions">
          {loading && <span className="muted">Loading lifecycle…</span>}
          {error && <div className="alert warn slim">{error}</div>}
          {lifecycle && (lifecycle.states || []).length > 0 && (
            <>
              <div className="lc-current muted">
                Current state: <strong>{lifecycle.currentStateLabel || '—'}</strong>
              </div>
              <div className="action-row">
                <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
                  <option value="">Change state to…</option>
                  {lifecycle.states.map((s) => (
                    <option
                      key={s.name}
                      value={s.action || ''}
                      disabled={!s.available}
                    >
                      {s.label}
                      {s.current ? ' — current' : s.available ? '' : ' — not available'}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-primary sm"
                  onClick={apply}
                  disabled={!chosen || applying}
                >
                  {applying ? 'Applying…' : 'Apply'}
                </button>
              </div>
              <div className="lc-hint muted">
                States marked “not available” aren’t reachable from the current
                state under your permissions. Vault only allows transitions
                configured for the record’s current state.
              </div>
            </>
          )}
        </div>
      )}

      {confirming && (
        <div className="rec-delete">
          <div className="alert warn slim">
            Permanently delete <strong>{label}</strong>? This cannot be undone.
          </div>
          {planLoading && <span className="muted">Checking related records…</span>}
          {plan && plan.length > 0 && (
            <div className="plan">
              This will also remove {plan.length} related record{plan.length === 1 ? '' : 's'}:
              <ul>
                {plan.slice(0, 6).map((p, i) => (
                  <li key={i} className="mono">
                    {p.object || object}/{p.id}
                  </li>
                ))}
                {plan.length > 6 && <li className="muted">…and {plan.length - 6} more</li>}
              </ul>
            </div>
          )}
          <div className="action-row">
            <button
              type="button"
              className="btn-danger sm"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Yes, delete permanently'}
            </button>
            <button
              type="button"
              className="btn-ghost sm"
              onClick={() => setConfirming(false)}
              disabled={deleting}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
