import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the audit log at a temp file before importing the module.
const tmpFile = path.join(os.tmpdir(), `audit-test-${process.pid}.log`);
process.env.AUDIT_LOG_FILE = tmpFile;
process.env.AUDIT_BUFFER_SIZE = '5';

const { logAudit, getRecentAudit, _clearAuditBuffer } = await import('./auditLog.js');

beforeEach(() => {
  _clearAuditBuffer();
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    /* ignore */
  }
});

test('logAudit stores an entry with defaults and returns it', () => {
  const rec = logAudit({ actor: 'alice@x.com', action: 'login' });
  assert.equal(rec.actor, 'alice@x.com');
  assert.equal(rec.action, 'login');
  assert.equal(rec.outcome, 'success'); // default
  assert.ok(rec.timestamp, 'timestamp is set');
});

test('getRecentAudit returns entries newest-first', () => {
  logAudit({ actor: 'a', action: 'search' });
  logAudit({ actor: 'b', action: 'delete', object: 'submission__v', recordId: 'r1' });
  const recent = getRecentAudit(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].action, 'delete'); // newest first
  assert.equal(recent[1].action, 'search');
});

test('ring buffer is capped at AUDIT_BUFFER_SIZE', () => {
  for (let i = 0; i < 8; i += 1) logAudit({ actor: 'u', action: `a${i}` });
  const recent = getRecentAudit(100);
  assert.equal(recent.length, 5, 'buffer capped at 5');
  assert.equal(recent[0].action, 'a7', 'keeps the most recent');
  assert.equal(recent[4].action, 'a3', 'drops the oldest');
});

test('entries are appended to the log file as JSON lines', () => {
  logAudit({ actor: 'carol@x.com', action: 'edit-metadata', object: 'submission__v', recordId: 'r9' });
  logAudit({ actor: 'carol@x.com', action: 'logout' });
  const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.actor, 'carol@x.com');
  assert.equal(first.action, 'edit-metadata');
  assert.equal(first.recordId, 'r9');
});

test('failure outcomes are recorded with the error', () => {
  const rec = logAudit({
    actor: 'dan@x.com',
    action: 'delete',
    object: 'submission__v',
    recordId: 'r1',
    outcome: 'failure',
    error: 'permission denied',
  });
  assert.equal(rec.outcome, 'failure');
  assert.equal(rec.error, 'permission denied');
});
