// Thin wrapper around the Veeva Vault REST API.
//
// Docs: https://developer.veevavault.com/api/
// The subset used here (object records — NOT documents):
//   - POST   /api/{v}/auth                                   authenticate, returns sessionId
//   - POST   /api/{v}/query                                  run a VQL query
//   - GET    /api/{v}/metadata/vobjects                      list objects
//   - GET    /api/{v}/metadata/vobjects/{object}            object metadata (label, fields, relationships)
//   - GET    /api/{v}/vobjects/{object}/{id}/actions         user actions available for a record
//   - POST   /api/{v}/vobjects/{object}/{id}/actions/{name}  initiate a user action
//   - PUT    /api/{v}/vobjects/{object}/{id}                 update record fields
//   - DELETE /api/{v}/vobjects/{object}/{id}                 hard-delete a record
//   - GET    /api/{v}/objects/users/me                       current user + security profile
//
// Note: object *records* use /actions (GET to list, POST to initiate). The
// /lifecycle_actions + PUT variant is for *documents* and returns
// "The specified resource cannot be found" against a vobject record.

const DEFAULT_API_VERSION = process.env.VAULT_API_VERSION || 'v24.1';

// The Vault instance this tool targets.
const VAULT_DNS = process.env.VAULT_DNS || 'https://sb-roche-rim-development.veevavault.com';

// Vault returns responseStatus: "SUCCESS" | "FAILURE" on every call.
function assertSuccess(body, fallbackMessage) {
  // Vault returns SUCCESS on success. It also returns WARNING for non-fatal
  // conditions (e.g. "Duplicate query execution detected") while still
  // including valid data — treat WARNING as success so throttling notices
  // don't surface as errors to the user.
  if (body && (body.responseStatus === 'SUCCESS' || body.responseStatus === 'WARNING')) {
    return body;
  }
  const errors = (body && body.errors) || [];
  const message =
    errors.map((e) => e.message).filter(Boolean).join('; ') ||
    (body && body.responseMessage) ||
    fallbackMessage;
  const err = new Error(message);
  err.vaultErrors = errors;
  throw err;
}

function normalizeBaseUrl(dnsOrUrl) {
  if (!dnsOrUrl) throw new Error('Vault DNS/URL is required');
  let url = dnsOrUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

export function createVaultClient({ vaultDns, sessionId, apiVersion = DEFAULT_API_VERSION }) {
  const baseUrl = normalizeBaseUrl(vaultDns);
  const apiRoot = `${baseUrl}/api/${apiVersion}`;

  async function request(path, { method = 'GET', headers = {}, body } = {}) {
    const res = await fetch(`${apiRoot}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(sessionId ? { Authorization: sessionId } : {}),
        ...headers,
      },
      body,
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Vault returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    return { httpStatus: res.status, body: json };
  }

  return {
    baseUrl,
    apiVersion,

    // Run a VQL query. Returns { data, responseDetails }.
    async query(vql) {
      const { body } = await request('/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ q: vql }).toString(),
      });
      assertSuccess(body, 'VQL query failed');
      return { data: body.data || [], responseDetails: body.responseDetails || {} };
    },

    // List all vault objects: [{ name, label, label_plural, ... }].
    async listObjects() {
      const { body } = await request('/metadata/vobjects');
      assertSuccess(body, 'Could not load the object list');
      return (body.objects || []).map((o) => ({
        name: o.name,
        label: o.label || o.label_plural || o.name,
      }));
    },

    // Object metadata: label, plural label, field definitions, relationships.
    async objectMetadata(objectName) {
      const { body } = await request(
        `/metadata/vobjects/${encodeURIComponent(objectName)}?loc=false`
      );
      assertSuccess(body, `Could not load metadata for object "${objectName}"`);
      return body.object;
    },

    // Editable, user-facing fields for an object, with type info.
    // Filters out system/read-only fields so the edit form only shows what
    // can actually be changed.
    async editableFields(objectName) {
      const object = await this.objectMetadata(objectName);
      const fields = object.fields || [];
      const SYSTEM = new Set([
        'id',
        'created_by__v',
        'created_date__v',
        'modified_by__v',
        'modified_date__v',
        'global_id__sys',
        'link__sys',
        'object_type__v',
      ]);
      return fields
        .filter((f) => f.editable !== false && !SYSTEM.has(f.name) && f.type !== 'formula')
        .map((f) => ({
          name: f.name,
          label: f.label || f.name,
          type: f.type,
          required: !!f.required,
          editable: f.editable !== false,
          picklist: f.picklist || null,
          maxLength: f.max_length,
          // Vault marks fields with a source relationship (parent/child links)
          // so the UI can warn before touching them.
          objectReference: f.object ? f.object.name : null,
        }));
    },

    // Relationships defined on an object (used to walk the hierarchy).
    async relationships(objectName) {
      const object = await this.objectMetadata(objectName);
      return object.relationships || [];
    },

    // The signed-in user, including security profile / permissions.
    // GET /objects/users/me -> { users: [{ user: {...} }] }
    async currentUser() {
      const { body } = await request('/objects/users/me');
      assertSuccess(body, 'Could not load the current user');
      const entry = (body.users && body.users[0]) || {};
      return entry.user || entry;
    },

    // Update fields on a record.
    // PUT /vobjects/{object}/{id} with form-urlencoded field=value pairs.
    async updateRecord(objectName, recordId, fields) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(fields || {})) {
        params.append(key, value == null ? '' : String(value));
      }
      const { body } = await request(
        `/vobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        }
      );
      assertSuccess(body, 'Update failed');
      return body;
    },

    // Hard-delete a record. DELETE /vobjects/{object}/{id}.
    async deleteRecord(objectName, recordId) {
      const { body } = await request(
        `/vobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`,
        { method: 'DELETE' }
      );
      assertSuccess(body, 'Delete failed');
      return body;
    },

    // User actions (including lifecycle state changes) available for a record.
    // GET /vobjects/{object}/{id}/actions -> { data: [{ name, label, ... }] }
    async lifecycleActions(objectName, recordId) {
      const { body } = await request(
        `/vobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}/actions`
      );
      assertSuccess(body, 'Could not load record actions');
      // Vault returns the list under "data"; older responses may use "actions".
      const actions = body.data || body.actions || [];
      // Normalize each entry so the UI always has name + label.
      return actions.map((a) => ({
        name: a.name || a.name__v,
        label: a.label || a.label__v || a.name || a.name__v,
        ...a,
      }));
    },

    // Role assignments on a specific record instance.
    // GET /vobjects/{object}/{id}/roles ->
    //   { data: [{ name, users: [<vaultUserId>], groups: [...], ... }] }
    // Returns the raw role rows so callers can check membership.
    async recordRoles(objectName, recordId) {
      const { body } = await request(
        `/vobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}/roles`
      );
      assertSuccess(body, 'Could not load record roles');
      return body.data || [];
    },

    // Resolve an app-login identity (username/email) to their Vault user
    // record, including federated_id__v and numeric Vault user id. Used to
    // attribute an operation to the real requesting user rather than the
    // Business Admin service account. Returns null when not found.
    //
    // Note: the `users` object does not support MAXROWS; use PAGESIZE.
    async resolveUserByLogin(login) {
      if (!login) return null;
      const safe = escapeVql(login);
      const vql =
        `SELECT id, user_name__v, user_email__v, federated_id__v ` +
        `FROM users ` +
        `WHERE user_name__v = '${safe}' OR user_email__v = '${safe}' ` +
        `PAGESIZE 1`;
      const { data } = await this.query(vql);
      const row = data[0];
      if (!row) return null;
      return {
        vaultUserId: row.id,
        userName: row.user_name__v || null,
        userEmail: row.user_email__v || null,
        federatedId: row.federated_id__v || null,
      };
    },

    // All lifecycle states configured for an object, regardless of the
    // record's current state. The /actions endpoint only returns the
    // transitions reachable from where a record is *now*, so to show users the
    // full picture (e.g. that "Inactive" exists) we read the lifecycle
    // configuration directly.
    //
    // Flow: object metadata -> available_lifecycles[0] -> the lifecycle's
    // state list via /configuration/Objectlifecycle.{name}.
    async lifecycleStates(objectName) {
      const object = await this.objectMetadata(objectName);
      const lifecycleName = (object.available_lifecycles || [])[0];
      if (!lifecycleName) return { lifecycle: null, startingState: null, states: [] };

      const { body } = await request(
        `/configuration/Objectlifecycle.${encodeURIComponent(lifecycleName)}`
      );
      assertSuccess(body, `Could not load lifecycle "${lifecycleName}"`);
      const data = body.data || {};
      const states = (data.states || [])
        .filter((s) => s.active !== false)
        .map((s) => ({
          name: s.name,
          label: s.label || s.name,
          recordStatus: s.record_status || null,
          // record_status inactive__v marks the "retired"/inactive states.
          inactive: (s.record_status || '').toLowerCase() === 'inactive__v',
        }));
      // starting_state comes as "Objectlifecyclestate.planned_state__c".
      const startingState = (data.starting_state || '').split('.').pop() || null;
      return { lifecycle: lifecycleName, startingState, states };
    },

    // A complete lifecycle picture for one record: its current state, every
    // configured state, and which state changes are actually available right
    // now (from the /actions endpoint), matched to states by label. This lets
    // the UI list all states while only enabling the reachable transitions and
    // explaining why the others are unavailable.
    async lifecycleOverview(objectName, recordId) {
      const [statesInfo, actions, current] = await Promise.all([
        this.lifecycleStates(objectName),
        this.lifecycleActions(objectName, recordId),
        this._recordState(objectName, recordId),
      ]);

      // State-change actions, keyed by a normalized target-state label. Vault
      // labels them e.g. "Change State to In Progress"; strip that prefix so
      // the remainder matches a state label ("In Progress").
      const stateChanges = actions.filter(
        (a) => (a.type || '').toLowerCase() === 'state_change'
      );
      const norm = (s) => String(s || '').trim().toLowerCase();
      const byTargetLabel = new Map();
      for (const a of stateChanges) {
        const target = norm(a.label).replace(/^change\s+state\s+to\s+/, '');
        byTargetLabel.set(target, a);
      }

      const states = statesInfo.states.map((s) => {
        const isCurrent = s.name === current.state;
        const action = byTargetLabel.get(norm(s.label)) || null;
        return {
          ...s,
          current: isCurrent,
          // A transition is available if Vault offers a matching state_change
          // action and it isn't the state we're already in.
          action: action ? action.name : null,
          available: !isCurrent && !!action,
        };
      });

      return {
        lifecycle: statesInfo.lifecycle,
        currentState: current.state,
        currentStateLabel:
          states.find((s) => s.current)?.label || current.state || null,
        states,
        // Non-state-change actions (e.g. delete) surfaced separately if needed.
        otherActions: actions.filter((a) => (a.type || '').toLowerCase() !== 'state_change'),
      };
    },

    // The current lifecycle state of a record (state__v). Best-effort: returns
    // { state: null } if the field isn't queryable for this object.
    async _recordState(objectName, recordId) {
      try {
        const { data } = await this.query(
          `SELECT id, state__v FROM ${objectName} WHERE id = '${recordId}'`
        );
        const row = data[0] || {};
        return { state: row.state__v || null };
      } catch {
        return { state: null };
      }
    },

    // Initiate a user action (e.g. a lifecycle state change) on a record.
    // POST /vobjects/{object}/{id}/actions/{name}
    // Vault expects form-urlencoded for this endpoint, not JSON.
    async executeLifecycleAction(objectName, recordId, actionName) {
      const { body } = await request(
        `/vobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}/actions/${encodeURIComponent(actionName)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: '',
        }
      );
      assertSuccess(body, 'Action failed');
      return body;
    },

    // Immediate child records that reference the given record, grouped by the
    // child object. Uses the object's inbound relationships to find which
    // objects/fields point back at this one.
    async findChildren(objectName, recordId) {
      const object = await this.objectMetadata(objectName);
      const rels = object.relationships || [];

      // Inbound (child) relationships: another object references this one.
      const inbound = rels.filter(
        (r) => (r.relationship_type || '').toLowerCase() === 'child' && r.object && r.object.name
      );

      const groups = [];
      for (const rel of inbound) {
        const childObject = rel.object.name;
        const refField = rel.field; // field on the child that points at us
        if (!refField) continue;
        try {
          const { data } = await this.query(
            `SELECT id, name__v FROM ${childObject} WHERE ${refField} = '${recordId}'`
          );
          if (data.length > 0) {
            groups.push({
              object: childObject,
              label: rel.relationship_label || childObject,
              field: refField,
              records: data,
            });
          }
        } catch {
          // A relationship may not be queryable (e.g. no read access); skip it
          // rather than failing the whole discovery.
        }
      }
      return groups;
    },

    // Recursively build a bottom-up deletion plan for a record and its
    // descendants. Returns an ordered list; children appear before parents so
    // callers can delete in order without creating orphans.
    async buildDeletionPlan(objectName, recordId, { maxDepth = 5 } = {}) {
      const plan = [];
      const visited = new Set();

      const walk = async (obj, id, name, depth) => {
        const key = `${obj}:${id}`;
        if (visited.has(key)) return;
        visited.add(key);

        let childCount = 0;
        if (depth < maxDepth) {
          const groups = await this.findChildren(obj, id);
          for (const g of groups) {
            for (const rec of g.records) {
              await walk(g.object, rec.id, rec.name__v, depth + 1);
              childCount += 1;
            }
          }
        }
        // Add self after descendants (bottom-up order).
        plan.push({ object: obj, id, name: name || id, depth, childCount });
      };

      await walk(objectName, recordId, null, 0);
      return plan;
    },
  };
}

// Authenticate against Vault. Returns { sessionId, vaultId, userId, vaultDns }.
// vaultDns defaults to the configured VAULT_DNS.
export async function authenticate({ vaultDns = VAULT_DNS, username, password, apiVersion = DEFAULT_API_VERSION }) {
  const baseUrl = normalizeBaseUrl(vaultDns);
  const res = await fetch(`${baseUrl}/api/${apiVersion}/auth`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ username, password }).toString(),
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Vault auth returned a non-JSON response (HTTP ${res.status})`);
  }
  assertSuccess(body, 'Authentication failed. Check your Vault DNS, username, and password.');

  return {
    sessionId: body.sessionId,
    userId: body.userId,
    vaultId: body.vaultId,
    vaultIds: body.vaultIds || [],
    vaultDns: baseUrl,
    apiVersion,
  };
}

// --- Business Admin service account ---------------------------------------
//
// The login page only verifies that the end user is a genuine Vault user.
// All actual Vault operations run under a fixed Business Admin service account
// so every verified user can perform admin-level tasks regardless of their own
// profile. Credentials come from the environment, never the source.

let serviceSessionCache = null; // { sessionId, vaultDns, apiVersion, obtainedAt }
const SERVICE_SESSION_TTL_MS = Number(
  process.env.VAULT_SERVICE_SESSION_TTL_MS || 25 * 60 * 1000
); // refresh before Vault's typical 30-min inactivity timeout

export function isServiceAccountConfigured() {
  return Boolean(process.env.VAULT_SERVICE_USERNAME && process.env.VAULT_SERVICE_PASSWORD);
}

// Authenticate the Business Admin service account, caching the session so we
// don't re-auth on every request. Pass { force: true } to bypass the cache.
export async function serviceAuthenticate({ force = false } = {}) {
  const username = process.env.VAULT_SERVICE_USERNAME;
  const password = process.env.VAULT_SERVICE_PASSWORD;
  if (!username || !password) {
    const err = new Error(
      'The Business Admin service account is not configured. Set VAULT_SERVICE_USERNAME and VAULT_SERVICE_PASSWORD on the server.'
    );
    err.status = 503;
    throw err;
  }

  if (
    !force &&
    serviceSessionCache &&
    Date.now() - serviceSessionCache.obtainedAt < SERVICE_SESSION_TTL_MS
  ) {
    return serviceSessionCache;
  }

  const auth = await authenticate({ vaultDns: VAULT_DNS, username, password });
  serviceSessionCache = { ...auth, obtainedAt: Date.now() };
  return serviceSessionCache;
}

// True when a thrown Vault error indicates the session has expired/invalid.
function isInvalidSessionError(err) {
  const errors = (err && err.vaultErrors) || [];
  if (errors.some((e) => e && e.type === 'INVALID_SESSION_ID')) return true;
  return /invalid session|session.*expired|inactive/i.test((err && err.message) || '');
}

// Return a Vault client bound to the (cached) Business Admin service session.
// Every method is wrapped so that if the cached session has expired, we
// re-authenticate the service account once and transparently retry the call.
export async function createServiceVaultClient() {
  const build = async ({ force = false } = {}) => {
    const svc = await serviceAuthenticate({ force });
    return createVaultClient({
      vaultDns: svc.vaultDns,
      sessionId: svc.sessionId,
      apiVersion: svc.apiVersion,
    });
  };

  let client = await build();

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args) => {
        try {
          return await value.apply(target, args);
        } catch (err) {
          if (!isInvalidSessionError(err)) throw err;
          // Session expired: drop the cache, re-auth, retry once.
          invalidateServiceSession();
          client = await build({ force: true });
          const fresh = Reflect.get(client, prop, client);
          return await fresh.apply(client, args);
        }
      };
    },
  });
}

// Clear the cached service session (e.g. after a 401 so the next call re-auths).
export function invalidateServiceSession() {
  serviceSessionCache = null;
}

// Escape a value for safe inclusion inside a single-quoted VQL literal.
function escapeVql(value) {
  return String(value).replace(/'/g, "\\'");
}

// Build a VQL statement from a structured smart-search spec.
//   spec = {
//     object: 'submission__v',
//     select: ['id','name__v','status__v'],   // optional
//     term: 'foo',                            // optional free-text
//     termFields: ['name__v','external_id__v'], // fields the term matches
//     filters: [{ field, operator, value }],  // optional structured filters
//     limit: 25,
//   }
// operator ∈ =, !=, CONTAINS, STARTSWITH, >, <, >=, <=
function buildSmartSearchVql(spec = {}) {
  const {
    object,
    select = ['id', 'name__v', 'status__v'],
    term = '',
    termFields = ['name__v'],
    filters = [],
    limit = 25,
  } = spec;

  if (!object) throw new Error('object is required');
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 1000);

  const fields = [...new Set(['id', ...select])];
  const clauses = [];

  // Free-text term across the chosen fields (OR-joined).
  if (term) {
    const t = escapeVql(term);
    const ors = termFields.map((f) => `${f} CONTAINS ('${t}')`);
    if (ors.length) clauses.push(`(${ors.join(' OR ')})`);
  }

  // Structured filters (AND-joined).
  for (const f of filters) {
    if (!f || !f.field || !f.operator) continue;
    const op = String(f.operator).toUpperCase();
    const val = f.value;
    if (op === 'CONTAINS' || op === 'STARTSWITH') {
      clauses.push(`${f.field} ${op} ('${escapeVql(val)}')`);
    } else if (['=', '!=', '>', '<', '>=', '<='].includes(op)) {
      // Numbers and dates go unquoted; everything else is quoted.
      const isNumeric = typeof val === 'number' || /^-?\d+(\.\d+)?$/.test(String(val));
      const isDate = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(String(val));
      const literal = isNumeric || isDate ? String(val) : `'${escapeVql(val)}'`;
      clauses.push(`${f.field} ${op} ${literal}`);
    }
  }

  let vql = `SELECT ${fields.join(', ')} FROM ${object}`;
  if (clauses.length) vql += ` WHERE ${clauses.join(' AND ')}`;
  vql += ` MAXROWS ${safeLimit}`;
  return vql;
}

// Determine whether a Vault user record represents an admin.
// Vault exposes the security profile on the user; the built-in admin profile
// is "business_admin__v" / "vault_owner__v". We also honor an explicit
// allowlist via VAULT_ADMIN_PROFILES (comma-separated).
function isAdminUser(user) {
  if (!user) return false;
  const extra = (process.env.VAULT_ADMIN_PROFILES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const adminProfiles = new Set([
    'business_admin__v',
    'vault_owner__v',
    'system_admin__v',
    ...extra,
  ]);
  const profile =
    user.security_profile__v ||
    user.security_profile ||
    user.security_profile__sys ||
    '';
  const profiles = Array.isArray(profile) ? profile : [profile];
  return profiles.some((p) => adminProfiles.has(p));
}

export {
  assertSuccess,
  normalizeBaseUrl,
  DEFAULT_API_VERSION,
  VAULT_DNS,
  buildSmartSearchVql,
  escapeVql,
  isAdminUser,
};

// serviceAuthenticate, createServiceVaultClient, invalidateServiceSession,
// and isServiceAccountConfigured are exported inline above.
