import express from 'express';
import {
  authenticate,
  createVaultClient,
  createServiceVaultClient,
  isServiceAccountConfigured,
  VAULT_DNS,
  buildSmartSearchVql,
} from './vaultClient.js';
import { createSession, getSession, destroySession } from './sessionStore.js';
import { isGalileoConfigured } from './galileoClient.js';
import { nlToVql, findPopulatedSibling } from './nlSearch.js';
import { logAudit, getRecentAudit } from './auditLog.js';
import { canAccessObject, filterObjects } from './permissions.js';
import { runStateChangePipeline, SUBMISSION_OBJECT } from './stateChangePipeline.js';

// The real user behind a request, for the audit trail. Since all Vault work
// runs under the shared Business Admin account, this is the only link back to
// the person who actually asked for the action.
function actorOf(req) {
  return (
    req.session?.loginUsername ||
    (req.session?.userId ? `userId:${req.session.userId}` : 'anonymous')
  );
}

function clientInfo(req) {
  return {
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

// Turn a raw Vault state name (e.g. "in_review__c" or "approved_state") into a
// human-readable label for the activity log. Safe on null/undefined.
function prettifyState(state) {
  if (!state) return null;
  return String(state)
    .replace(/__[a-z]$/i, '')
    .replace(/_state$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

const userCanAccessObject = (req, objectName) => canAccessObject(req.session, objectName);
const filterAllowedObjects = (req, objects) => filterObjects(req.session, objects);

// Express guard: 403 if the :object route param is outside the user's set.
function requireObjectAccess(req, res, next) {
  const objectName = req.params.object || req.body?.object;
  if (objectName && !userCanAccessObject(req, objectName)) {
    return res.status(403).json({
      error: `You do not have permission to access "${objectName}".`,
    });
  }
  next();
}

const COOKIE_NAME = 'vault_session';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

// Wrap async handlers so rejected promises reach the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Resolve the current session and attach a Vault client.
//
// Auth model: the login page only verifies that the end user is a genuine Vault
// user. All Vault operations run under the Business Admin service account, so
// the client attached here is bound to that account's session — not the user's.
const requireSession = asyncHandler(async (req, res, next) => {
  const token = req.cookies[COOKIE_NAME];
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  req.session = session;
  req.vault = await createServiceVaultClient();
  next();
});

// Every verified user operates as Business Admin, so a valid session is
// sufficient for the previously admin-gated endpoints. We still require the
// service account to be configured.
function requireAdmin(req, res, next) {
  if (!isServiceAccountConfigured()) {
    return res.status(503).json({
      error: 'The Business Admin service account is not configured on the server.',
    });
  }
  next();
}

export function buildRouter() {
  const router = express.Router();

  // --- Auth -----------------------------------------------------------------

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required.' });
      }

      // The service account must be configured, since all operations run under it.
      if (!isServiceAccountConfigured()) {
        return res.status(503).json({
          error: 'The Business Admin service account is not configured on the server.',
        });
      }

      // Identity check only: verify the end user is a genuine Vault user by
      // authenticating their own credentials. We do NOT keep this session — all
      // subsequent operations use the Business Admin service account.
      let auth;
      try {
        auth = await authenticate({ vaultDns: VAULT_DNS, username, password });
      } catch (err) {
        logAudit({
          actor: username,
          action: 'login',
          outcome: 'failure',
          error: err.message,
          ...clientInfo(req),
        });
        throw err;
      }

      // Capture the objects THIS user is permitted to see, using their own
      // session (which only lists objects their profile can access). Operations
      // still execute under Business Admin, but we restrict what the user can
      // reach to their own permission set. If it can't be read, fall back to
      // null = "no explicit restriction" (Business Admin scope).
      let allowedObjects = null;
      try {
        const userVault = createVaultClient({
          vaultDns: auth.vaultDns,
          sessionId: auth.sessionId,
          apiVersion: auth.apiVersion,
        });
        const userObjects = await userVault.listObjects();
        allowedObjects = userObjects.map((o) => o.name);
      } catch {
        allowedObjects = null; // non-fatal
      }

      // Every verified user operates as Business Admin.
      const token = createSession({
        userId: auth.userId,
        vaultId: auth.vaultId,
        vaultDns: VAULT_DNS,
        apiVersion: auth.apiVersion,
        loginUsername: username,
        isAdmin: true,
        profile: 'business_admin__v (service account)',
        allowedObjects,
      });

      logAudit({
        actor: username,
        action: 'login',
        outcome: 'success',
        detail: 'verified; acting as Business Admin',
        ...clientInfo(req),
      });

      res.cookie(COOKIE_NAME, token, cookieOptions());
      res.json({
        user: { userId: auth.userId, vaultId: auth.vaultId, username },
        vaultDns: VAULT_DNS,
        apiVersion: auth.apiVersion,
        isAdmin: true,
        profile: 'business_admin__v (service account)',
        actingAs: 'Business Admin',
        objectCount: allowedObjects ? allowedObjects.length : null,
      });
    })
  );

  router.post('/auth/logout', (req, res) => {
    const session = getSession(req.cookies[COOKIE_NAME]);
    if (session) {
      logAudit({
        actor: session.loginUsername || `userId:${session.userId}`,
        action: 'logout',
        outcome: 'success',
        ...clientInfo(req),
      });
    }
    destroySession(req.cookies[COOKIE_NAME]);
    res.clearCookie(COOKIE_NAME, cookieOptions());
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    const session = getSession(req.cookies[COOKIE_NAME]);
    if (!session) return res.status(401).json({ error: 'Not authenticated.' });
    res.json({
      user: {
        userId: session.userId,
        vaultId: session.vaultId,
        username: session.loginUsername || null,
      },
      vaultDns: session.vaultDns,
      apiVersion: session.apiVersion,
      isAdmin: !!session.isAdmin,
      profile: session.profile || null,
      actingAs: 'Business Admin',
      objectCount: session.allowedObjects ? session.allowedObjects.length : null,
    });
  });

  // --- Audit log ------------------------------------------------------------

  // Recent activity: who asked the app to do what. Any signed-in user may view
  // it; entries record the real user behind each Business-Admin operation.
  router.get(
    '/audit',
    requireSession,
    (req, res) => {
      const limit = Number(req.query.limit) || 100;
      res.json({ entries: getRecentAudit(limit) });
    }
  );

  // --- Objects --------------------------------------------------------------

  // List all vault objects, so the UI can offer valid API names.
  router.get(
    '/objects',
    requireSession,
    asyncHandler(async (req, res) => {
      const objects = await req.vault.listObjects();
      // Only surface objects the logged-in user is permitted to see.
      res.json({ objects: filterAllowedObjects(req, objects) });
    })
  );

  // Editable fields for an object (for the smart-search field picker and the
  // retrospective edit form).
  router.get(
    '/objects/:object/fields',
    requireSession,
    requireObjectAccess,
    asyncHandler(async (req, res) => {
      const fields = await req.vault.editableFields(req.params.object);
      res.json({ fields });
    })
  );

  // --- Records --------------------------------------------------------------

  // Smart search within a single object.
  // Body: { object, term?, termFields?, filters?, select?, limit? }
  router.post(
    '/records/search',
    requireSession,
    requireObjectAccess,
    asyncHandler(async (req, res) => {
      const { object, term = '', termFields, filters, select, limit } = req.body || {};
      if (!object) return res.status(400).json({ error: 'object is required.' });

      const vql = buildSmartSearchVql({
        object,
        term,
        termFields: termFields && termFields.length ? termFields : ['name__v'],
        filters: filters || [],
        select: select && select.length ? select : ['id', 'name__v', 'status__v'],
        limit: limit || 25,
      });

      const { data, responseDetails } = await req.vault.query(vql);
      logAudit({
        actor: actorOf(req),
        action: 'search',
        object,
        detail: term ? `term="${term}"` : 'filtered/advanced search',
        outcome: 'success',
        resultCount: data.length,
        ...clientInfo(req),
      });
      res.json({ records: data, total: responseDetails.total ?? data.length, vql });
    })
  );

  // Whether the Galileo LLM is configured (so the UI can show/hide NL search).
  router.get('/llm/status', (req, res) => {
    res.json({ configured: isGalileoConfigured() });
  });

  // Natural-language search: Galileo translates the question into a Vault query.
  // Body: { question }
  router.post(
    '/records/nl-search',
    requireSession,
    asyncHandler(async (req, res) => {
      const { question } = req.body || {};
      if (!question || !question.trim()) {
        return res.status(400).json({ error: 'question is required.' });
      }

      // Restrict the object catalog the LLM can choose from to the user's set.
      const objects = filterAllowedObjects(req, await req.vault.listObjects());
      const { spec, vql, warnings } = await nlToVql({
        question,
        objects,
        getFields: (object) => req.vault.editableFields(object),
      });

      // Safety: never run against an object outside the user's permissions.
      if (!userCanAccessObject(req, spec.object)) {
        return res.status(403).json({
          error: `You do not have permission to access "${spec.object}".`,
        });
      }

      let { data, responseDetails } = await req.vault.query(vql);
      let usedObject = spec.object;
      let usedVql = vql;
      const notes = [...(warnings || [])];

      // Fallback: RIM often has several objects for the same concept (e.g.
      // registration__v, registration__rim, medicinal_product_registration__v).
      // If the LLM's pick returns nothing, probe sibling objects that share the
      // main keyword and use the first that actually has records.
      if (data.length === 0) {
        const alt = await findPopulatedSibling(req.vault, objects, spec, question);
        if (alt) {
          data = alt.data;
          responseDetails = alt.responseDetails;
          usedObject = alt.object;
          usedVql = alt.vql;
          notes.push(
            `No records in "${spec.object}"; showing results from "${alt.object}" instead.`
          );
        }
      }

      logAudit({
        actor: actorOf(req),
        action: 'ai-search',
        object: usedObject,
        detail: `question="${question.trim().slice(0, 200)}"`,
        outcome: 'success',
        resultCount: data.length,
        ...clientInfo(req),
      });

      res.json({
        object: usedObject,
        records: data,
        total: responseDetails.total ?? data.length,
        vql: usedVql,
        spec,
        warnings: notes,
        triedObject: spec.object,
      });
    })
  );

  // Global smart search across several objects at once.
  // Body: { objects: [names], term, limit? }
  router.post(
    '/records/global-search',
    requireSession,
    asyncHandler(async (req, res) => {
      const { objects = [], term = '', limit = 10 } = req.body || {};
      if (!term) return res.status(400).json({ error: 'term is required.' });
      if (!objects.length) return res.status(400).json({ error: 'objects is required.' });

      // Only search within objects the user is permitted to access.
      const permitted = objects.filter((o) => userCanAccessObject(req, o));

      const results = await Promise.all(
        permitted.slice(0, 25).map(async (object) => {
          try {
            const vql = buildSmartSearchVql({
              object,
              term,
              termFields: ['name__v'],
              select: ['id', 'name__v', 'status__v'],
              limit,
            });
            const { data } = await req.vault.query(vql);
            return { object, records: data };
          } catch (err) {
            // Skip objects that lack name__v/status__v or aren't queryable.
            return { object, records: [], error: err.message };
          }
        })
      );

      res.json({ results: results.filter((r) => r.records.length > 0) });
    })
  );

  // Lifecycle user actions available for a specific record.
  router.get(
    '/records/:object/:id/actions',
    requireSession,
    requireObjectAccess,
    asyncHandler(async (req, res) => {
      const { object, id } = req.params;
      const actions = await req.vault.lifecycleActions(object, id);
      res.json({ actions });
    })
  );

  // Full lifecycle picture for a record: current state, every configured
  // state, and which state changes are available right now. Lets the UI show
  // all states (e.g. "Inactive") while only enabling reachable transitions.
  router.get(
    '/records/:object/:id/lifecycle',
    requireSession,
    requireObjectAccess,
    asyncHandler(async (req, res) => {
      const { object, id } = req.params;
      const overview = await req.vault.lifecycleOverview(object, id);
      res.json(overview);
    })
  );

  // Execute a lifecycle action against a record.
  // Body: { action }  (action = the action's "name" from the actions list)
  router.post(
    '/records/:object/:id/actions/execute',
    requireSession,
    requireObjectAccess,
    asyncHandler(async (req, res) => {
      const { object, id } = req.params;
      const { action } = req.body || {};
      if (!action) return res.status(400).json({ error: 'action is required.' });

      // Submission state changes must go through the compliance pipeline
      // (POST /submission/change-state). Direct execution is blocked so the
      // GxP guardrails (Affiliate Manager role check) can't be bypassed.
      if (object === SUBMISSION_OBJECT) {
        logAudit({
          actor: actorOf(req),
          action: 'lifecycle-action',
          object,
          recordId: id,
          detail: `action="${action}" blocked: use compliance pipeline`,
          outcome: 'blocked',
          ...clientInfo(req),
        });
        return res.status(403).json({
          error:
            'Submission state changes must go through the compliance pipeline. ' +
            'Ask in plain English (e.g. "change state of <submission> to <state>").',
        });
      }

      try {
        const result = await req.vault.executeLifecycleAction(object, id, action);
        logAudit({
          actor: actorOf(req),
          action: 'lifecycle-action',
          object,
          recordId: id,
          detail: `action="${action}"`,
          outcome: 'success',
          ...clientInfo(req),
        });
        res.json({ ok: true, result });
      } catch (err) {
        logAudit({
          actor: actorOf(req),
          action: 'lifecycle-action',
          object,
          recordId: id,
          detail: `action="${action}"`,
          outcome: 'failure',
          error: err.message,
          ...clientInfo(req),
        });
        throw err;
      }
    })
  );

  // Submission state change via the 4-agent compliance pipeline.
  // Body: { message } — the user's plain-English request.
  // This is the ONLY sanctioned path for changing a submission__v state.
  router.post(
    '/submission/change-state',
    requireSession,
    asyncHandler(async (req, res) => {
      const { message } = req.body || {};
      if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'message is required.' });
      }

      const requesterLogin = req.session.loginUsername || null;
      const result = await runStateChangePipeline(req.vault, {
        message: String(message),
        requesterLogin,
      });

      // Audit every pipeline run with its outcome and the compliance narrative.
      const doc = result.verify?.document || {};
      const outcome =
        result.status === 'executed'
          ? 'success'
          : result.status === 'out_of_scope'
            ? 'out_of_scope'
            : result.status === 'denied'
              ? 'denied'
              : 'failure';
      logAudit({
        actor: actorOf(req),
        action: 'submission-state-change',
        object: SUBMISSION_OBJECT,
        recordId: doc.internal_id || null,
        detail:
          `intent="${result.agent1?.intent}" ` +
          `target="${result.agent1?.target_state || ''}" ` +
          `submission="${doc.submission_id || result.agent1?.document_id || ''}" ` +
          `-> ${result.execute?.confirmed_status || 'n/a'}`,
        // Friendly, structured fields so the activity log can render without
        // parsing technical strings or exposing internal object/state names.
        summary: `State change: ${doc.submission_id || result.agent1?.document_id || 'submission'}`,
        targetName: doc.submission_id || result.agent1?.document_id || null,
        requestedState: result.agent1?.target_state || null,
        resultState: prettifyState(result.execute?.confirmed_status),
        outcome,
        error: result.status === 'execution_failed' ? result.execute?.message : undefined,
        narrative: result.audit || undefined,
        ...clientInfo(req),
      });

      res.json(result);
    })
  );

  // --- Retrospective metadata edit (admin only) -----------------------------

  // Update fields on a record. Body: { fields: { field: value, ... } }
  router.put(
    '/records/:object/:id',
    requireSession,
    requireAdmin,
    requireObjectAccess,
    asyncHandler(async (req, res) => {
      const { object, id } = req.params;
      const { fields } = req.body || {};
      if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
        return res.status(400).json({ error: 'fields object with at least one value is required.' });
      }
      const changed = Object.keys(fields);
      try {
        const result = await req.vault.updateRecord(object, id, fields);
        logAudit({
          actor: actorOf(req),
          action: 'edit-metadata',
          object,
          recordId: id,
          detail: `fields=[${changed.join(', ')}]`,
          fields,
          outcome: 'success',
          ...clientInfo(req),
        });
        res.json({ ok: true, result });
      } catch (err) {
        logAudit({
          actor: actorOf(req),
          action: 'edit-metadata',
          object,
          recordId: id,
          detail: `fields=[${changed.join(', ')}]`,
          outcome: 'failure',
          error: err.message,
          ...clientInfo(req),
        });
        throw err;
      }
    })
  );

  // --- Deletion with hierarchical resolution (admin only) -------------------

  // Preview: build the bottom-up deletion plan for a record and its children.
  router.get(
    '/records/:object/:id/deletion-plan',
    requireSession,
    requireAdmin,
    requireObjectAccess,
    asyncHandler(async (req, res) => {
      const { object, id } = req.params;
      const plan = await req.vault.buildDeletionPlan(object, id);
      res.json({ plan, total: plan.length });
    })
  );

  // Execute a hard delete for the whole plan (children first) or a soft delete
  // (single lifecycle action) depending on mode.
  // Body: { mode: 'hard' | 'soft', softAction?, confirm: <record name> }
  router.post(
    '/records/:object/:id/delete',
    requireSession,
    requireAdmin,
    requireObjectAccess,
    asyncHandler(async (req, res) => {
      const { object, id } = req.params;
      const { mode = 'hard', softAction } = req.body || {};

      if (mode === 'soft') {
        if (!softAction) {
          return res.status(400).json({ error: 'softAction is required for a soft delete.' });
        }
        try {
          const result = await req.vault.executeLifecycleAction(object, id, softAction);
          logAudit({
            actor: actorOf(req),
            action: 'delete',
            object,
            recordId: id,
            detail: `soft delete via action="${softAction}"`,
            outcome: 'success',
            ...clientInfo(req),
          });
          return res.json({ ok: true, mode: 'soft', deleted: [], result });
        } catch (err) {
          logAudit({
            actor: actorOf(req),
            action: 'delete',
            object,
            recordId: id,
            detail: `soft delete via action="${softAction}"`,
            outcome: 'failure',
            error: err.message,
            ...clientInfo(req),
          });
          throw err;
        }
      }

      // Hard delete: resolve hierarchy, delete children before parents.
      const plan = await req.vault.buildDeletionPlan(object, id);
      const deleted = [];
      try {
        for (const item of plan) {
          await req.vault.deleteRecord(item.object, item.id);
          deleted.push({ object: item.object, id: item.id });
        }
        logAudit({
          actor: actorOf(req),
          action: 'delete',
          object,
          recordId: id,
          detail: `hard delete of ${deleted.length} record(s) (children first)`,
          deleted,
          outcome: 'success',
          ...clientInfo(req),
        });
        res.json({ ok: true, mode: 'hard', deleted, count: deleted.length });
      } catch (err) {
        logAudit({
          actor: actorOf(req),
          action: 'delete',
          object,
          recordId: id,
          detail: `hard delete failed after ${deleted.length} of ${plan.length} record(s)`,
          deleted,
          outcome: 'failure',
          error: err.message,
          ...clientInfo(req),
        });
        throw err;
      }
    })
  );

  return router;
}

export { COOKIE_NAME };
