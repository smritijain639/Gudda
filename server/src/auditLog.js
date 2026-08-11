// Audit log.
//
// Because every Vault operation runs under the shared Business Admin service
// account, the audit log is what ties each action back to the *real* user who
// requested it. Each entry records who (the logged-in user), what (the action),
// the target record, an outcome, and any relevant details.
//
// Entries are:
//   - printed to the console (so they appear in `gitpod automations service logs app`)
//   - appended as JSON lines to a file (AUDIT_LOG_FILE, default server/logs/audit.log)
//   - kept in an in-memory ring buffer so the app can show recent activity.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_FILE =
  process.env.AUDIT_LOG_FILE || path.resolve(__dirname, '../logs/audit.log');
const MAX_BUFFER = Number(process.env.AUDIT_BUFFER_SIZE || 500);

// In-memory ring buffer of the most recent entries (newest last).
const buffer = [];

let fileReady = false;
function ensureFile() {
  if (fileReady) return true;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fileReady = true;
  } catch (err) {
    // Non-fatal: fall back to console + memory only.
    // eslint-disable-next-line no-console
    console.error('[audit] could not create log directory:', err.message);
    fileReady = false;
  }
  return fileReady;
}

// Record an audit entry. `entry` should include at least { actor, action }.
// Common fields: object, recordId, outcome ('success'|'failure'), detail, error.
export function logAudit(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    actor: 'unknown',
    outcome: 'success',
    ...entry,
  };

  // In-memory ring buffer.
  buffer.push(record);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  // Console line (concise, human-readable).
  const target =
    record.object && record.recordId
      ? ` ${record.object}/${record.recordId}`
      : record.object
        ? ` ${record.object}`
        : '';
  const extra = record.detail ? ` — ${record.detail}` : '';
  const err = record.error ? ` [error: ${record.error}]` : '';
  // eslint-disable-next-line no-console
  console.log(
    `[audit] ${record.timestamp} ${record.actor} ${record.action}${target} => ${record.outcome}${extra}${err}`
  );

  // Append as a JSON line.
  if (ensureFile()) {
    try {
      fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[audit] failed to write log file:', e.message);
    }
  }

  return record;
}

// Return the most recent entries (newest first), up to `limit`.
export function getRecentAudit(limit = 100) {
  const n = Math.max(1, Math.min(Number(limit) || 100, MAX_BUFFER));
  return buffer.slice(-n).reverse();
}

// Test helper: clear the in-memory buffer.
export function _clearAuditBuffer() {
  buffer.length = 0;
}

export { LOG_FILE };
