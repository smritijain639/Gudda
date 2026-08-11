// In-memory session store. Maps an opaque cookie token to the Vault session
// details so the Vault sessionId is never exposed to the browser.
//
// For a single-instance tool this is sufficient. For multi-instance
// deployments, back this with Redis or a shared store.

import crypto from 'node:crypto';

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000); // 30 min

const sessions = new Map();

export function createSession(data) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ...data, createdAt: Date.now(), lastUsed: Date.now() });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.lastUsed > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  session.lastUsed = Date.now();
  return session;
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}

export { SESSION_TTL_MS };
