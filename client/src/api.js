// Small fetch wrapper. All requests go through the Vite proxy to /api and
// include the session cookie.

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  let body;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }

  if (!res.ok) {
    const err = new Error(body.error || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.vaultErrors = body.vaultErrors;
    throw err;
  }
  return body;
}

export const api = {
  me: () => request('/auth/me'),
  login: (payload) => request('/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request('/auth/logout', { method: 'POST' }),

  listObjects: () => request('/objects'),

  getFields: (object) => request(`/objects/${encodeURIComponent(object)}/fields`),

  llmStatus: () => request('/llm/status'),

  nlSearch: (question) =>
    request('/records/nl-search', { method: 'POST', body: JSON.stringify({ question }) }),

  searchRecords: (payload) =>
    request('/records/search', { method: 'POST', body: JSON.stringify(payload) }),

  globalSearch: (payload) =>
    request('/records/global-search', { method: 'POST', body: JSON.stringify(payload) }),

  getActions: (object, id) =>
    request(`/records/${encodeURIComponent(object)}/${encodeURIComponent(id)}/actions`),

  getLifecycle: (object, id) =>
    request(`/records/${encodeURIComponent(object)}/${encodeURIComponent(id)}/lifecycle`),

  executeAction: (object, id, action) =>
    request(`/records/${encodeURIComponent(object)}/${encodeURIComponent(id)}/actions/execute`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  updateRecord: (object, id, fields) =>
    request(`/records/${encodeURIComponent(object)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    }),

  getDeletionPlan: (object, id) =>
    request(`/records/${encodeURIComponent(object)}/${encodeURIComponent(id)}/deletion-plan`),

  deleteRecord: (object, id, payload) =>
    request(`/records/${encodeURIComponent(object)}/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getAudit: (limit = 100) => request(`/audit?limit=${encodeURIComponent(limit)}`),
};
