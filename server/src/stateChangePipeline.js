// 4-agent orchestration for Veeva Vault RIM submission state changes.
//
// This is the SOLE mechanism for changing a submission__v record's lifecycle
// state. Every request flows through four agents in strict order; the pipeline
// short-circuits the moment a stage fails or denies:
//
//   Agent 1 — Interpret (Galileo LLM, read-only): classify intent and identify
//             the target submission + desired target state.
//   Agent 2 — Verify (deterministic, read-only): GxP guardrails. Intent must be
//             a state change, the submission must exist, and the requesting user
//             must hold the affiliate_manager__c role ON THAT record instance.
//   Agent 3 — Execute (deterministic, write): discover the matching lifecycle
//             user action, invoke it, and read the state back to confirm.
//   Agent 4 — Audit (Galileo LLM): produce a plain-prose GxP audit narrative.
//
// Role verification uses the live endpoint GET /vobjects/submission__v/{id}/roles
// (the spec's submission_user__v VQL / user_roles endpoint do not exist in this
// Vault). Identity is derived from the logged-in user's federated_id__v.

import { galileoComplete } from './galileoClient.js';
import { extractJson } from './nlSearch.js';

const SUBMISSION_OBJECT = 'submission__v';
// The role that authorizes a submission state change, per GxP policy.
const REQUIRED_ROLE = 'affiliate_manager__c';

// ---------------------------------------------------------------------------
// Agent 1 — Neural Processing Agent (Interpret)
// ---------------------------------------------------------------------------

const AGENT1_SYSTEM = `You are the Neural Processing Agent for a Veeva Vault RIM system.
Your ONLY function is to interpret user intent for changing the lifecycle state of a Submission record.
Respond with ONLY a single JSON object. No prose, no code fences.

Classify intent:
- "change_submission_state": the user explicitly asks to transition, change, move, promote, or update the state/status of a Submission record.
- "other": anything else (chatter, searches, ambiguous requests).

Schema:
{
  "intent": "change_submission_state" | "other",
  "document_id": "<the exact Submission name or record id the user named, or null>",
  "target_state": "<the state label the user wants to move the record to, or null>",
  "confidence": <float 0.0 to 1.0>,
  "reasoning": "<one concise sentence explaining the classification>"
}

Rules:
- document_id must be copied verbatim from the user's text (e.g. "SUB - IMA-2026-01318 - EU-100607" or an internal id). Do not invent one.
- target_state is the destination state named after words like "to"/"into" (e.g. "Planned", "In Progress"). Null if none is stated.
- Only use "change_submission_state" when the request is clearly about changing a Submission's state.`;

export async function agent1Interpret({ message }) {
  const output = await galileoComplete({
    system: AGENT1_SYSTEM,
    user: `User request: "${message}"\n\nReturn the JSON now.`,
  });
  const parsed = extractJson(output);
  // Normalize + defensively coerce the shape.
  return {
    intent: parsed.intent === 'change_submission_state' ? 'change_submission_state' : 'other',
    document_id: parsed.document_id ? String(parsed.document_id).trim() : null,
    target_state: parsed.target_state ? String(parsed.target_state).trim() : null,
    confidence:
      typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
    reasoning: parsed.reasoning ? String(parsed.reasoning) : '',
  };
}

// ---------------------------------------------------------------------------
// Agent 2 — Compliance Agent (Verify) — deterministic, read-only
// ---------------------------------------------------------------------------

function escapeVql(value) {
  return String(value == null ? '' : value).replace(/'/g, "\\'");
}

// Resolve the target submission by name or internal id.
async function resolveSubmission(vault, identifier) {
  const safe = escapeVql(identifier);
  const vql =
    `SELECT id, name__v, state__v FROM ${SUBMISSION_OBJECT} ` +
    `WHERE name__v = '${safe}' OR id = '${safe}' PAGESIZE 1`;
  const { data } = await vault.query(vql);
  return data[0] || null;
}

export async function agent2Verify(vault, { agent1, requesterLogin }) {
  const checks = {
    intent_permitted: agent1.intent === 'change_submission_state',
    submission_exists: false,
    is_affiliate_manager: false,
  };
  const document = { submission_id: agent1.document_id, internal_id: null, current_state: null };
  const requesting_user = { federated_id: null, resolved_vault_user_id: null };

  // Guardrail 1: intent.
  if (!checks.intent_permitted) {
    return {
      execution_approved: false,
      reason: 'Intent is not a submission state change; request is out of scope.',
      checks,
      document,
      requesting_user,
    };
  }

  if (!agent1.document_id) {
    return {
      execution_approved: false,
      reason: 'No submission identifier was provided in the request.',
      checks,
      document,
      requesting_user,
    };
  }

  // Guardrail 2: submission existence.
  const submission = await resolveSubmission(vault, agent1.document_id);
  if (!submission) {
    return {
      execution_approved: false,
      reason: `Submission "${agent1.document_id}" was not found in ${SUBMISSION_OBJECT}.`,
      checks,
      document,
      requesting_user,
    };
  }
  checks.submission_exists = true;
  document.submission_id = submission.name__v;
  document.internal_id = submission.id;
  document.current_state = submission.state__v;

  // Resolve the requesting user's Vault identity (federated id + numeric id).
  const user = await vault.resolveUserByLogin(requesterLogin);
  if (!user) {
    return {
      execution_approved: false,
      reason: `Could not resolve requesting user "${requesterLogin}" to a Vault user record.`,
      checks,
      document,
      requesting_user,
    };
  }
  requesting_user.federated_id = user.federatedId;
  requesting_user.resolved_vault_user_id = user.vaultUserId;

  // Guardrail 3: Affiliate Manager role on THIS record instance.
  const roles = await vault.recordRoles(SUBMISSION_OBJECT, submission.id);
  const roleRow = roles.find((r) => (r.name || '').toLowerCase() === REQUIRED_ROLE);
  const members = (roleRow && roleRow.users) || [];
  checks.is_affiliate_manager = members.map(String).includes(String(user.vaultUserId));

  if (!checks.is_affiliate_manager) {
    return {
      execution_approved: false,
      reason:
        `User ${user.federatedId} (Vault id ${user.vaultUserId}) does not hold the ` +
        `${REQUIRED_ROLE} role on submission ${submission.name__v}. ` +
        (roleRow
          ? `The role is assigned to ${members.length} user(s), none matching the requester.`
          : `The ${REQUIRED_ROLE} role is not assigned on this record.`),
      checks,
      document,
      requesting_user,
    };
  }

  return {
    execution_approved: true,
    reason:
      `Intent permitted, submission ${submission.name__v} exists (state ${submission.state__v}), ` +
      `and ${user.federatedId} holds ${REQUIRED_ROLE} on the record.`,
    checks,
    document,
    requesting_user,
  };
}

// ---------------------------------------------------------------------------
// Agent 3 — Executer Agent (Act) — deterministic, write
// ---------------------------------------------------------------------------

// Match a lifecycle user action to the user's requested target state, by label.
// Vault labels state-change actions e.g. "Change State to In Progress"; strip
// that prefix and compare to the target state label.
function normState(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/_state__c$/, '')
    .replace(/[_\s]+/g, ' ')
    .trim();
}

// True when a record's current state matches the requested target state.
// Compares tolerantly: current is a state name ("deferred_state__c") while the
// target is usually a label ("Deferred").
function isSameState(currentState, targetState) {
  if (!currentState || !targetState) return false;
  return normState(currentState) === normState(targetState);
}

function findActionForState(actions, targetState) {
  const stateChanges = (actions || []).filter(
    (a) => (a.type || '').toLowerCase() === 'state_change'
  );
  if (!targetState) {
    // No explicit target named: only unambiguous when exactly one is available.
    return stateChanges.length === 1 ? stateChanges[0] : null;
  }
  const t = normState(targetState);
  const stripped = (a) => normState(String(a.label || '').replace(/^change\s+state\s+to\s+/i, ''));
  return (
    stateChanges.find((a) => stripped(a) === t) ||
    stateChanges.find((a) => stripped(a).startsWith(t)) ||
    stateChanges.find((a) => stripped(a).includes(t)) ||
    null
  );
}

export async function agent3Execute(vault, { verify, targetState }) {
  const submissionId = verify.document.submission_id;
  const internalId = verify.document.internal_id;
  const base = {
    execution_status: 'FAILED',
    submission_id: submissionId,
    internal_id: internalId,
    action_invoked: null,
    confirmed_status: null,
    message: '',
  };

  // Discover available lifecycle user actions for the record.
  const actions = await vault.lifecycleActions(SUBMISSION_OBJECT, internalId);
  const action = findActionForState(actions, targetState);

  if (!action) {
    const available = actions
      .filter((a) => (a.type || '').toLowerCase() === 'state_change')
      .map((a) => a.label)
      .join(', ');
    return {
      ...base,
      message: targetState
        ? `No lifecycle action moves ${submissionId} to "${targetState}" from its current state.` +
          (available ? ` Available transitions: ${available}.` : ' No transitions are available.')
        : `No target state was specified and the transition is ambiguous.` +
          (available ? ` Available transitions: ${available}.` : ''),
    };
  }

  // Act: trigger the lifecycle action.
  await vault.executeLifecycleAction(SUBMISSION_OBJECT, internalId, action.name);

  // Confirm: read the state back.
  let confirmed = null;
  try {
    const { data } = await vault.query(
      `SELECT id, name__v, state__v FROM ${SUBMISSION_OBJECT} WHERE id = '${escapeVql(internalId)}'`
    );
    confirmed = data[0] ? data[0].state__v : null;
  } catch {
    confirmed = null;
  }

  return {
    execution_status: 'SUCCESS',
    submission_id: submissionId,
    internal_id: internalId,
    action_invoked: action.name,
    confirmed_status: confirmed,
    message: `Applied "${action.label}" to ${submissionId}.`,
  };
}

// ---------------------------------------------------------------------------
// Agent 4 — Audit Agent (Log) — Galileo LLM narrative
// ---------------------------------------------------------------------------

const AGENT4_SYSTEM = `You are the Audit Agent for a GxP-regulated Veeva Vault RIM system.
Write a compliance audit narrative summarizing a completed submission state-change request.
Requirements:
- Exactly 4 to 8 plain-prose sentences.
- No markdown, no headers, no bullet points, no code blocks.
- State only facts present in the provided data. Make no external assumptions.
- Cover: the requesting user (federated id and resolved Vault user id), the target submission (name and internal id), the detected intent, the compliance decision (especially the Affiliate Manager authorization result), the lifecycle action invoked (or that none was), and the final confirmed state (or that execution was halted).`;

export async function agent4Audit({ agent1, verify, execute }) {
  const facts = {
    intent: { detected: agent1.intent, target_state: agent1.target_state, confidence: agent1.confidence },
    requesting_user: verify.requesting_user,
    submission: verify.document,
    compliance: { approved: verify.execution_approved, reason: verify.reason, checks: verify.checks },
    execution: execute || { execution_status: 'HALTED', message: 'Execution was not attempted.' },
  };
  try {
    const output = await galileoComplete({
      system: AGENT4_SYSTEM,
      user: `Lifecycle facts (JSON):\n${JSON.stringify(facts, null, 2)}\n\nWrite the audit narrative now.`,
    });
    const text = String(output).trim();
    if (text) return text;
  } catch {
    // Fall through to a deterministic narrative if the LLM is unavailable.
  }
  return deterministicNarrative(facts);
}

// Fallback narrative so an audit entry always exists even if Galileo is down.
function deterministicNarrative(f) {
  const u = f.requesting_user;
  const s = f.submission;
  const parts = [];
  parts.push(
    `User ${u.federated_id || 'unknown'} (Vault user id ${u.resolved_vault_user_id || 'unknown'}) requested a submission state change.`
  );
  parts.push(
    `The target record was ${s.submission_id || 'an unspecified submission'} (internal id ${s.internal_id || 'unknown'}), which was in state ${s.current_state || 'unknown'}.`
  );
  parts.push(`The detected intent was "${f.intent.detected}".`);
  parts.push(
    f.compliance.approved
      ? `Compliance verification approved the request because the user holds the Affiliate Manager role on the record.`
      : `Compliance verification denied the request: ${f.compliance.reason}`
  );
  if (f.compliance.approved) {
    parts.push(
      f.execution.execution_status === 'SUCCESS'
        ? `The lifecycle action ${f.execution.action_invoked} was invoked and the record's state was confirmed as ${f.execution.confirmed_status || 'unconfirmed'}.`
        : `Execution did not succeed: ${f.execution.message}`
    );
  } else {
    parts.push(`No lifecycle action was invoked and the record state was left unchanged.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

// Run the full pipeline. Returns every agent's output plus a top-level status.
// `requesterLogin` is the app-login identity of the real requesting user.
export async function runStateChangePipeline(vault, { message, requesterLogin }) {
  // Agent 1 — Interpret.
  const agent1 = await agent1Interpret({ message });
  if (agent1.intent !== 'change_submission_state') {
    return {
      status: 'out_of_scope',
      agent1,
      verify: null,
      execute: null,
      audit: null,
    };
  }

  // Agent 2 — Verify.
  const verify = await agent2Verify(vault, { agent1, requesterLogin });
  if (!verify.execution_approved) {
    const audit = await agent4Audit({ agent1, verify, execute: null });
    return { status: 'denied', agent1, verify, execute: null, audit };
  }

  // No-op short-circuit: the record is already in the requested state, so there
  // is nothing to change. This is a friendly, expected outcome — not an error.
  if (agent1.target_state && isSameState(verify.document.current_state, agent1.target_state)) {
    const execute = {
      execution_status: 'NO_CHANGE',
      submission_id: verify.document.submission_id,
      internal_id: verify.document.internal_id,
      action_invoked: null,
      confirmed_status: verify.document.current_state,
      message: `${verify.document.submission_id} is already in the requested state.`,
    };
    const audit = await agent4Audit({ agent1, verify, execute });
    return { status: 'already_in_state', agent1, verify, execute, audit };
  }

  // Agent 3 — Execute.
  let execute;
  try {
    execute = await agent3Execute(vault, { verify, targetState: agent1.target_state });
  } catch (err) {
    execute = {
      execution_status: 'FAILED',
      submission_id: verify.document.submission_id,
      internal_id: verify.document.internal_id,
      action_invoked: null,
      confirmed_status: null,
      message: `Execution error: ${err.message}`,
    };
  }

  // Agent 4 — Audit.
  const audit = await agent4Audit({ agent1, verify, execute });

  return {
    status: execute.execution_status === 'SUCCESS' ? 'executed' : 'execution_failed',
    agent1,
    verify,
    execute,
    audit,
  };
}

export { findActionForState, REQUIRED_ROLE, SUBMISSION_OBJECT };
