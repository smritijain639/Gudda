import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticate,
  createVaultClient,
  createServiceVaultClient,
  serviceAuthenticate,
  invalidateServiceSession,
  isServiceAccountConfigured,
  normalizeBaseUrl,
  assertSuccess,
  buildSmartSearchVql,
  escapeVql,
  isAdminUser,
} from './vaultClient.js';

test('normalizeBaseUrl adds https and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('my-vault.veevavault.com'), 'https://my-vault.veevavault.com');
  assert.equal(normalizeBaseUrl('https://my-vault.veevavault.com/'), 'https://my-vault.veevavault.com');
  assert.equal(normalizeBaseUrl('http://localhost:8080///'), 'http://localhost:8080');
});

test('normalizeBaseUrl throws when empty', () => {
  assert.throws(() => normalizeBaseUrl(''), /required/i);
});

test('assertSuccess passes through a SUCCESS body', () => {
  const body = { responseStatus: 'SUCCESS', data: [1, 2] };
  assert.equal(assertSuccess(body, 'x'), body);
});

test('assertSuccess throws with joined Vault error messages', () => {
  const body = {
    responseStatus: 'FAILURE',
    errors: [{ message: 'INVALID_SESSION' }, { message: 'expired' }],
  };
  assert.throws(() => assertSuccess(body, 'fallback'), /INVALID_SESSION; expired/);
});

test('assertSuccess falls back when no error messages present', () => {
  assert.throws(() => assertSuccess({ responseStatus: 'FAILURE' }, 'fallback msg'), /fallback msg/);
});

// --- fetch-backed tests using a stub global fetch --------------------------

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(obj, status = 200) {
  return Promise.resolve({
    status,
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
}

test('authenticate posts credentials and returns session data', async () => {
  let captured;
  const restore = stubFetch((url, opts) => {
    captured = { url, opts };
    return jsonResponse({
      responseStatus: 'SUCCESS',
      sessionId: 'sess-123',
      userId: 42,
      vaultId: 7,
    });
  });

  try {
    const result = await authenticate({
      vaultDns: 'my-vault.veevavault.com',
      username: 'u@example.com',
      password: 'pw',
    });
    assert.equal(result.sessionId, 'sess-123');
    assert.equal(result.userId, 42);
    assert.equal(result.vaultDns, 'https://my-vault.veevavault.com');
    assert.match(captured.url, /\/api\/v[\d.]+\/auth$/);
    assert.equal(captured.opts.method, 'POST');
    assert.match(captured.opts.body, /username=u%40example.com/);
    assert.match(captured.opts.body, /password=pw/);
  } finally {
    restore();
  }
});

test('authenticate throws on FAILURE', async () => {
  const restore = stubFetch(() =>
    jsonResponse({ responseStatus: 'FAILURE', errors: [{ message: 'INVALID_USER_CREDENTIALS' }] })
  );
  try {
    await assert.rejects(
      authenticate({ vaultDns: 'v.veevavault.com', username: 'x', password: 'y' }),
      /INVALID_USER_CREDENTIALS/
    );
  } finally {
    restore();
  }
});

test('client.query sends VQL and returns data', async () => {
  let captured;
  const restore = stubFetch((url, opts) => {
    captured = { url, opts };
    return jsonResponse({
      responseStatus: 'SUCCESS',
      data: [{ id: 'r1' }],
      responseDetails: { total: 1 },
    });
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 'sess' });
    const out = await client.query('SELECT id FROM foo__v');
    assert.deepEqual(out.data, [{ id: 'r1' }]);
    assert.equal(out.responseDetails.total, 1);
    assert.match(captured.url, /\/query$/);
    assert.match(captured.opts.body, /q=SELECT\+id\+FROM\+foo__v/);
    assert.equal(captured.opts.headers.Authorization, 'sess');
  } finally {
    restore();
  }
});

test('client.lifecycleActions reads the data array from /actions', async () => {
  let captured;
  const restore = stubFetch((url, opts) => {
    captured = { url, opts };
    return jsonResponse({
      responseStatus: 'SUCCESS',
      data: [{ name: 'approve', label: 'Approve' }],
    });
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 'sess' });
    const actions = await client.lifecycleActions('foo__v', 'r1');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, 'approve');
    assert.equal(actions[0].label, 'Approve');
    assert.match(captured.url, /\/vobjects\/foo__v\/r1\/actions$/);
  } finally {
    restore();
  }
});

test('client.lifecycleActions normalizes missing labels to the name', async () => {
  const restore = stubFetch(() =>
    jsonResponse({ responseStatus: 'SUCCESS', data: [{ name: 'change_state_to_approved__c' }] })
  );
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 'sess' });
    const [action] = await client.lifecycleActions('foo__v', 'r1');
    assert.equal(action.label, 'change_state_to_approved__c');
  } finally {
    restore();
  }
});

test('client.lifecycleStates reads the configured lifecycle and flags inactive states', async () => {
  const restore = stubFetch((url) => {
    if (url.includes('/metadata/vobjects/submission__v')) {
      return jsonResponse({
        responseStatus: 'SUCCESS',
        object: { name: 'submission__v', available_lifecycles: ['sub_lc__c'] },
      });
    }
    if (url.includes('/configuration/Objectlifecycle.sub_lc__c')) {
      return jsonResponse({
        responseStatus: 'SUCCESS',
        data: {
          name: 'sub_lc__c',
          starting_state: 'Objectlifecyclestate.planned_state__c',
          states: [
            { name: 'planned_state__c', label: 'Planned', record_status: 'active__v', active: true },
            { name: 'inactive_state__c', label: 'Inactive', record_status: 'inactive__v', active: true },
            { name: 'old_state__c', label: 'Old', record_status: 'active__v', active: false },
          ],
        },
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 's' });
    const result = await client.lifecycleStates('submission__v');
    assert.equal(result.lifecycle, 'sub_lc__c');
    assert.equal(result.startingState, 'planned_state__c');
    // Inactive (active:false) state is filtered out; two remain.
    assert.equal(result.states.length, 2);
    const inactive = result.states.find((s) => s.name === 'inactive_state__c');
    assert.equal(inactive.inactive, true);
    const planned = result.states.find((s) => s.name === 'planned_state__c');
    assert.equal(planned.inactive, false);
  } finally {
    restore();
  }
});

test('client.lifecycleStates returns empty when object has no lifecycle', async () => {
  const restore = stubFetch((url) => {
    if (url.includes('/metadata/vobjects/thing__v')) {
      return jsonResponse({
        responseStatus: 'SUCCESS',
        object: { name: 'thing__v', available_lifecycles: [] },
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 's' });
    const result = await client.lifecycleStates('thing__v');
    assert.deepEqual(result, { lifecycle: null, startingState: null, states: [] });
  } finally {
    restore();
  }
});

test('client.lifecycleOverview marks current state and matches reachable actions by label', async () => {
  const restore = stubFetch((url, opts) => {
    if (url.includes('/metadata/vobjects/submission__v')) {
      return jsonResponse({
        responseStatus: 'SUCCESS',
        object: { name: 'submission__v', available_lifecycles: ['sub_lc__c'] },
      });
    }
    if (url.includes('/configuration/Objectlifecycle.sub_lc__c')) {
      return jsonResponse({
        responseStatus: 'SUCCESS',
        data: {
          starting_state: 'Objectlifecyclestate.planned_state__c',
          states: [
            { name: 'deferred_state__c', label: 'Deferred', record_status: 'active__v', active: true },
            { name: 'in_progress_state__c', label: 'In Progress', record_status: 'active__v', active: true },
            { name: 'inactive_state__c', label: 'Inactive', record_status: 'inactive__v', active: true },
          ],
        },
      });
    }
    if (url.includes('/vobjects/submission__v/r1/actions')) {
      return jsonResponse({
        responseStatus: 'SUCCESS',
        data: [
          { name: 'act_a', label: 'Change State to In Progress', type: 'state_change' },
          { name: 'del', label: 'Delete Record', type: 'record_action' },
        ],
      });
    }
    if (url.includes('/query')) {
      return jsonResponse({
        responseStatus: 'SUCCESS',
        data: [{ id: 'r1', state__v: 'deferred_state__c' }],
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 's' });
    const overview = await client.lifecycleOverview('submission__v', 'r1');
    assert.equal(overview.currentState, 'deferred_state__c');
    assert.equal(overview.currentStateLabel, 'Deferred');

    const deferred = overview.states.find((s) => s.name === 'deferred_state__c');
    assert.equal(deferred.current, true);
    assert.equal(deferred.available, false);

    // "Change State to In Progress" -> "In Progress" state is reachable.
    const inProgress = overview.states.find((s) => s.name === 'in_progress_state__c');
    assert.equal(inProgress.available, true);
    assert.equal(inProgress.action, 'act_a');

    // Inactive exists in the list but has no matching action -> not available.
    const inactive = overview.states.find((s) => s.name === 'inactive_state__c');
    assert.equal(inactive.available, false);
    assert.equal(inactive.action, null);

    // Non-state-change actions surfaced separately.
    assert.equal(overview.otherActions.length, 1);
    assert.equal(overview.otherActions[0].name, 'del');
  } finally {
    restore();
  }
});

test('client.executeLifecycleAction POSTs to /actions/{name}', async () => {
  let captured;
  const restore = stubFetch((url, opts) => {
    captured = { url, opts };
    return jsonResponse({ responseStatus: 'SUCCESS' });
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 'sess' });
    await client.executeLifecycleAction('foo__v', 'r1', 'approve');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.match(captured.url, /\/vobjects\/foo__v\/r1\/actions\/approve$/);
  } finally {
    restore();
  }
});

test('client.listObjects returns name/label pairs', async () => {
  let captured;
  const restore = stubFetch((url) => {
    captured = url;
    return jsonResponse({
      responseStatus: 'SUCCESS',
      objects: [{ name: 'registration__rim', label: 'Registration' }],
    });
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 'sess' });
    const objects = await client.listObjects();
    assert.deepEqual(objects, [{ name: 'registration__rim', label: 'Registration' }]);
    assert.match(captured, /\/metadata\/vobjects$/);
  } finally {
    restore();
  }
});

test('authenticate uses the configured VAULT_DNS when none passed', async () => {
  let captured;
  const restore = stubFetch((url) => {
    captured = url;
    return jsonResponse({ responseStatus: 'SUCCESS', sessionId: 's', userId: 1, vaultId: 1 });
  });
  try {
    const result = await authenticate({ username: 'u', password: 'p' });
    assert.match(captured, /sb-roche-rim-development\.veevavault\.com/);
    assert.equal(result.vaultDns, 'https://sb-roche-rim-development.veevavault.com');
  } finally {
    restore();
  }
});

// --- Smart-search VQL builder ----------------------------------------------

test('escapeVql escapes single quotes', () => {
  assert.equal(escapeVql("O'Brien"), "O\\'Brien");
});

test('buildSmartSearchVql builds a term search across multiple fields', () => {
  const vql = buildSmartSearchVql({
    object: 'submission__v',
    term: 'CA-070107',
    termFields: ['name__v', 'external_id__v'],
    select: ['id', 'name__v', 'status__v'],
    limit: 25,
  });
  assert.match(vql, /^SELECT id, name__v, status__v FROM submission__v WHERE /);
  assert.match(vql, /\(name__v CONTAINS \('CA-070107'\) OR external_id__v CONTAINS \('CA-070107'\)\)/);
  assert.match(vql, /MAXROWS 25$/);
});

test('buildSmartSearchVql builds structured filters with correct literal quoting', () => {
  const vql = buildSmartSearchVql({
    object: 'submission__v',
    filters: [
      { field: 'name__v', operator: 'CONTAINS', value: 'foo' },
      { field: 'planned_submission_date__v', operator: '>=', value: '2026-01-01' },
      { field: 'count__c', operator: '>', value: 5 },
      { field: 'status__v', operator: '=', value: 'active__v' },
    ],
  });
  assert.match(vql, /name__v CONTAINS \('foo'\)/);
  assert.match(vql, /planned_submission_date__v >= 2026-01-01/); // date unquoted
  assert.match(vql, /count__c > 5/); // number unquoted
  assert.match(vql, /status__v = 'active__v'/); // string quoted
  assert.match(vql, / AND /);
});

test('buildSmartSearchVql clamps the limit and requires an object', () => {
  const vql = buildSmartSearchVql({ object: 'foo__v', limit: 99999 });
  assert.match(vql, /MAXROWS 1000$/);
  assert.throws(() => buildSmartSearchVql({}), /object is required/);
});

// --- Admin detection --------------------------------------------------------

test('isAdminUser recognizes built-in admin profiles', () => {
  assert.equal(isAdminUser({ security_profile__v: 'business_admin__v' }), true);
  assert.equal(isAdminUser({ security_profile__v: 'vault_owner__v' }), true);
  assert.equal(isAdminUser({ security_profile__v: 'document_user__v' }), false);
  assert.equal(isAdminUser(null), false);
});

test('isAdminUser honors VAULT_ADMIN_PROFILES allowlist', () => {
  process.env.VAULT_ADMIN_PROFILES = 'rim_admin__c';
  try {
    assert.equal(isAdminUser({ security_profile__v: 'rim_admin__c' }), true);
  } finally {
    delete process.env.VAULT_ADMIN_PROFILES;
  }
});

// --- New client methods -----------------------------------------------------

test('client.currentUser reads the user from users[0]', async () => {
  const restore = stubFetch(() =>
    jsonResponse({
      responseStatus: 'SUCCESS',
      users: [{ user: { id: 9, security_profile__v: 'business_admin__v' } }],
    })
  );
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 's' });
    const me = await client.currentUser();
    assert.equal(me.id, 9);
    assert.equal(me.security_profile__v, 'business_admin__v');
  } finally {
    restore();
  }
});

test('client.updateRecord PUTs form-encoded fields', async () => {
  let captured;
  const restore = stubFetch((url, opts) => {
    captured = { url, opts };
    return jsonResponse({ responseStatus: 'SUCCESS' });
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 's' });
    await client.updateRecord('submission__v', 'r1', {
      planned_submission_date__v: '2026-02-01',
    });
    assert.equal(captured.opts.method, 'PUT');
    assert.equal(captured.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.match(captured.opts.body, /planned_submission_date__v=2026-02-01/);
    assert.match(captured.url, /\/vobjects\/submission__v\/r1$/);
  } finally {
    restore();
  }
});

test('client.deleteRecord issues a DELETE', async () => {
  let captured;
  const restore = stubFetch((url, opts) => {
    captured = { url, opts };
    return jsonResponse({ responseStatus: 'SUCCESS' });
  });
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 's' });
    await client.deleteRecord('submission__v', 'r1');
    assert.equal(captured.opts.method, 'DELETE');
    assert.match(captured.url, /\/vobjects\/submission__v\/r1$/);
  } finally {
    restore();
  }
});

test('client.editableFields filters out system and non-editable fields', async () => {
  const restore = stubFetch(() =>
    jsonResponse({
      responseStatus: 'SUCCESS',
      object: {
        fields: [
          { name: 'id', type: 'ID' },
          { name: 'created_date__v', type: 'DateTime' },
          { name: 'name__v', type: 'String', editable: true, label: 'Name' },
          { name: 'computed__c', type: 'formula', editable: true },
          { name: 'readonly__c', type: 'String', editable: false },
          { name: 'planned_submission_date__v', type: 'Date', editable: true, label: 'Planned Date' },
        ],
      },
    })
  );
  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 's' });
    const fields = await client.editableFields('submission__v');
    const names = fields.map((f) => f.name);
    assert.deepEqual(names, ['name__v', 'planned_submission_date__v']);
  } finally {
    restore();
  }
});

test('client.buildDeletionPlan orders children before parents', async () => {
  // Fetch sequence:
  // 1) metadata(parent) -> one child relationship to child__v via parent__v
  // 2) query children of parent -> one child c1
  // 3) metadata(child) -> no child relationships
  // 4) query children of child -> (not reached; depth guard via no rels)
  let call = 0;
  const restore = stubFetch((url, opts) => {
    call += 1;
    const isQuery = url.endsWith('/query');
    if (isQuery) {
      // URLSearchParams encodes spaces as '+'; normalize before matching.
      const body = decodeURIComponent(opts.body.replace(/\+/g, ' '));
      if (body.includes("parent__v = 'p1'")) {
        return jsonResponse({ responseStatus: 'SUCCESS', data: [{ id: 'c1', name__v: 'Child 1' }] });
      }
      return jsonResponse({ responseStatus: 'SUCCESS', data: [] });
    }
    // metadata calls
    if (url.includes('/metadata/vobjects/parent__v')) {
      return jsonResponse({
        responseStatus: 'SUCCESS',
        object: {
          relationships: [
            {
              relationship_type: 'child',
              field: 'parent__v',
              relationship_label: 'Children',
              object: { name: 'child__v' },
            },
          ],
        },
      });
    }
    // child object: no further children
    return jsonResponse({ responseStatus: 'SUCCESS', object: { relationships: [] } });
  });

  try {
    const client = createVaultClient({ vaultDns: 'v.veevavault.com', sessionId: 's' });
    const plan = await client.buildDeletionPlan('parent__v', 'p1');
    assert.equal(plan.length, 2);
    // Child must come first (bottom-up).
    assert.equal(plan[0].object, 'child__v');
    assert.equal(plan[0].id, 'c1');
    assert.equal(plan[1].object, 'parent__v');
    assert.equal(plan[1].id, 'p1');
    assert.equal(plan[1].childCount, 1);
  } finally {
    restore();
  }
});

// --- Business Admin service account ----------------------------------------

test('isServiceAccountConfigured reflects env vars', () => {
  const u = process.env.VAULT_SERVICE_USERNAME;
  const p = process.env.VAULT_SERVICE_PASSWORD;
  try {
    delete process.env.VAULT_SERVICE_USERNAME;
    delete process.env.VAULT_SERVICE_PASSWORD;
    assert.equal(isServiceAccountConfigured(), false);
    process.env.VAULT_SERVICE_USERNAME = 'svc@example.com';
    process.env.VAULT_SERVICE_PASSWORD = 'secret';
    assert.equal(isServiceAccountConfigured(), true);
  } finally {
    if (u == null) delete process.env.VAULT_SERVICE_USERNAME;
    else process.env.VAULT_SERVICE_USERNAME = u;
    if (p == null) delete process.env.VAULT_SERVICE_PASSWORD;
    else process.env.VAULT_SERVICE_PASSWORD = p;
  }
});

test('serviceAuthenticate throws 503 when not configured', async () => {
  const u = process.env.VAULT_SERVICE_USERNAME;
  const p = process.env.VAULT_SERVICE_PASSWORD;
  invalidateServiceSession();
  try {
    delete process.env.VAULT_SERVICE_USERNAME;
    delete process.env.VAULT_SERVICE_PASSWORD;
    await assert.rejects(() => serviceAuthenticate(), (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /service account is not configured/i);
      return true;
    });
  } finally {
    if (u == null) delete process.env.VAULT_SERVICE_USERNAME;
    else process.env.VAULT_SERVICE_USERNAME = u;
    if (p == null) delete process.env.VAULT_SERVICE_PASSWORD;
    else process.env.VAULT_SERVICE_PASSWORD = p;
    invalidateServiceSession();
  }
});

test('serviceAuthenticate authenticates once and caches the session', async () => {
  const u = process.env.VAULT_SERVICE_USERNAME;
  const p = process.env.VAULT_SERVICE_PASSWORD;
  process.env.VAULT_SERVICE_USERNAME = 'svc@example.com';
  process.env.VAULT_SERVICE_PASSWORD = 'secret';
  invalidateServiceSession();

  let authCalls = 0;
  const restore = stubFetch((url) => {
    if (String(url).endsWith('/auth')) {
      authCalls += 1;
      return jsonResponse({
        responseStatus: 'SUCCESS',
        sessionId: 'svc-session',
        userId: 42,
        vaultId: 7,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const a = await serviceAuthenticate();
    const b = await serviceAuthenticate(); // should hit cache
    assert.equal(a.sessionId, 'svc-session');
    assert.equal(b.sessionId, 'svc-session');
    assert.equal(authCalls, 1, 'service account should authenticate only once');

    const c = await serviceAuthenticate({ force: true }); // bypass cache
    assert.equal(authCalls, 2);
    assert.equal(c.sessionId, 'svc-session');
  } finally {
    restore();
    invalidateServiceSession();
    if (u == null) delete process.env.VAULT_SERVICE_USERNAME;
    else process.env.VAULT_SERVICE_USERNAME = u;
    if (p == null) delete process.env.VAULT_SERVICE_PASSWORD;
    else process.env.VAULT_SERVICE_PASSWORD = p;
  }
});

test('createServiceVaultClient uses the service session for requests', async () => {
  const u = process.env.VAULT_SERVICE_USERNAME;
  const p = process.env.VAULT_SERVICE_PASSWORD;
  process.env.VAULT_SERVICE_USERNAME = 'svc@example.com';
  process.env.VAULT_SERVICE_PASSWORD = 'secret';
  invalidateServiceSession();

  let sentAuthHeader = null;
  const restore = stubFetch((url, opts) => {
    if (String(url).endsWith('/auth')) {
      return jsonResponse({ responseStatus: 'SUCCESS', sessionId: 'svc-session', userId: 1, vaultId: 1 });
    }
    if (String(url).endsWith('/query')) {
      sentAuthHeader = opts.headers.Authorization;
      return jsonResponse({ responseStatus: 'SUCCESS', data: [{ id: 'r1' }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const client = await createServiceVaultClient();
    const { data } = await client.query('SELECT id FROM submission__v');
    assert.equal(data.length, 1);
    assert.equal(sentAuthHeader, 'svc-session', 'requests must carry the service session id');
  } finally {
    restore();
    invalidateServiceSession();
    if (u == null) delete process.env.VAULT_SERVICE_USERNAME;
    else process.env.VAULT_SERVICE_USERNAME = u;
    if (p == null) delete process.env.VAULT_SERVICE_PASSWORD;
    else process.env.VAULT_SERVICE_PASSWORD = p;
  }
});

test('createServiceVaultClient re-authenticates and retries on invalid session', async () => {
  const u = process.env.VAULT_SERVICE_USERNAME;
  const p = process.env.VAULT_SERVICE_PASSWORD;
  process.env.VAULT_SERVICE_USERNAME = 'svc@example.com';
  process.env.VAULT_SERVICE_PASSWORD = 'secret';
  invalidateServiceSession();

  let authCalls = 0;
  let queryCalls = 0;
  const restore = stubFetch((url) => {
    if (String(url).endsWith('/auth')) {
      authCalls += 1;
      return jsonResponse({
        responseStatus: 'SUCCESS',
        sessionId: `svc-session-${authCalls}`,
        userId: 1,
        vaultId: 1,
      });
    }
    if (String(url).endsWith('/query')) {
      queryCalls += 1;
      if (queryCalls === 1) {
        // First call: simulate an expired session.
        return jsonResponse({
          responseStatus: 'FAILURE',
          errors: [{ type: 'INVALID_SESSION_ID', message: 'Invalid or expired session' }],
        });
      }
      return jsonResponse({ responseStatus: 'SUCCESS', data: [{ id: 'ok' }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const client = await createServiceVaultClient();
    const { data } = await client.query('SELECT id FROM submission__v');
    assert.equal(data[0].id, 'ok');
    assert.equal(authCalls, 2, 'should re-authenticate after invalid session');
    assert.equal(queryCalls, 2, 'should retry the query once');
  } finally {
    restore();
    invalidateServiceSession();
    if (u == null) delete process.env.VAULT_SERVICE_USERNAME;
    else process.env.VAULT_SERVICE_USERNAME = u;
    if (p == null) delete process.env.VAULT_SERVICE_PASSWORD;
    else process.env.VAULT_SERVICE_PASSWORD = p;
  }
});
