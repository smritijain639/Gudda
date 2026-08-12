import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findActionForState, REQUIRED_ROLE } from './stateChangePipeline.js';

// The pipeline calls Galileo (Agent 1 + Agent 4). We stub the module's
// galileoComplete by controlling GALILEO env + intercepting global fetch, but
// for focused unit tests it's simpler to test the deterministic pieces
// (Agent 2/3 logic) directly and use a scripted fetch for the LLM.

// --- findActionForState (Agent 3 matching) --------------------------------

test('findActionForState matches a state_change action by target label', () => {
  const actions = [
    { name: 'a1', label: 'Change State to In Progress', type: 'state_change' },
    { name: 'a2', label: 'Delete Record', type: 'record_action' },
  ];
  assert.equal(findActionForState(actions, 'In Progress').name, 'a1');
  assert.equal(findActionForState(actions, 'in progress').name, 'a1');
  // case/spacing tolerant, prefix match
  assert.equal(findActionForState(actions, 'in prog').name, 'a1');
});

test('findActionForState returns null when no state_change matches the target', () => {
  const actions = [{ name: 'a1', label: 'Change State to Planned', type: 'state_change' }];
  assert.equal(findActionForState(actions, 'Inactive'), null);
});

test('findActionForState requires an explicit target when several are available', () => {
  const actions = [
    { name: 'a1', label: 'Change State to Planned', type: 'state_change' },
    { name: 'a2', label: 'Change State to In Progress', type: 'state_change' },
  ];
  assert.equal(findActionForState(actions, null), null);
});

test('findActionForState auto-selects the sole available transition', () => {
  const actions = [
    { name: 'a1', label: 'Change State to Planned', type: 'state_change' },
    { name: 'x', label: 'Delete Record', type: 'record_action' },
  ];
  assert.equal(findActionForState(actions, null).name, 'a1');
});

// --- Agent 2 (verify) via a fake vault -------------------------------------

// A minimal fake Vault client covering the methods Agent 2/3 use.
function fakeVault(overrides = {}) {
  return {
    async query(vql) {
      // Agent 3's state read-back: "SELECT id, name__v, state__v ... WHERE id = ..."
      if (/state__v FROM submission__v WHERE id/.test(vql)) {
        return { data: [{ state__v: overrides.confirmedState || 'in_progress_state__c' }] };
      }
      // Agent 2's submission resolution: "... WHERE name__v = ... OR id = ..."
      if (/FROM submission__v/.test(vql)) {
        return { data: overrides.submission ? [overrides.submission] : [] };
      }
      return { data: [] };
    },
    async resolveUserByLogin() {
      return overrides.user || null;
    },
    async recordRoles() {
      return overrides.roles || [];
    },
    async lifecycleActions() {
      return overrides.actions || [];
    },
    async executeLifecycleAction() {
      if (overrides.executeThrows) throw new Error('execute failed');
      return { responseStatus: 'SUCCESS' };
    },
  };
}

// Import the internals we can call without the LLM.
import { agent2Verify, agent3Execute } from './stateChangePipeline.js';

const A1 = {
  intent: 'change_submission_state',
  document_id: 'SUB - TEST - EU-1',
  target_state: 'In Progress',
  confidence: 1,
  reasoning: '',
};

test('agent2Verify denies when intent is not a state change', async () => {
  const v = await agent2Verify(fakeVault(), {
    agent1: { ...A1, intent: 'other' },
    requesterLogin: 'x@y.com',
  });
  assert.equal(v.execution_approved, false);
  assert.equal(v.checks.intent_permitted, false);
});

test('agent2Verify denies when the submission does not exist', async () => {
  const v = await agent2Verify(fakeVault({ submission: null }), {
    agent1: A1,
    requesterLogin: 'x@y.com',
  });
  assert.equal(v.execution_approved, false);
  assert.equal(v.checks.submission_exists, false);
});

test('agent2Verify denies when the user lacks the affiliate manager role', async () => {
  const v = await agent2Verify(
    fakeVault({
      submission: { id: '00S1', name__v: 'SUB - TEST - EU-1', state__v: 'planned_state__c' },
      user: { vaultUserId: 999, federatedId: 'jdoe' },
      roles: [{ name: 'owner__v', users: [111] }],
    }),
    { agent1: A1, requesterLogin: 'x@y.com' }
  );
  assert.equal(v.execution_approved, false);
  assert.equal(v.checks.submission_exists, true);
  assert.equal(v.checks.is_affiliate_manager, false);
  assert.match(v.reason, new RegExp(REQUIRED_ROLE));
});

test('agent2Verify approves when the user holds affiliate_manager__c on the record', async () => {
  const v = await agent2Verify(
    fakeVault({
      submission: { id: '00S1', name__v: 'SUB - TEST - EU-1', state__v: 'planned_state__c' },
      user: { vaultUserId: 999, federatedId: 'jdoe' },
      roles: [
        { name: 'owner__v', users: [111] },
        { name: 'affiliate_manager__c', users: [999] },
      ],
    }),
    { agent1: A1, requesterLogin: 'x@y.com' }
  );
  assert.equal(v.execution_approved, true);
  assert.equal(v.checks.is_affiliate_manager, true);
  assert.equal(v.document.internal_id, '00S1');
  assert.equal(v.requesting_user.resolved_vault_user_id, 999);
});

// --- Agent 3 (execute) -----------------------------------------------------

const APPROVED = {
  execution_approved: true,
  document: { submission_id: 'SUB - TEST - EU-1', internal_id: '00S1', current_state: 'planned_state__c' },
  requesting_user: { federated_id: 'jdoe', resolved_vault_user_id: 999 },
};

test('agent3Execute invokes the matching action and confirms the new state', async () => {
  const vault = fakeVault({
    actions: [{ name: 'act1', label: 'Change State to In Progress', type: 'state_change' }],
    confirmedState: 'in_progress_state__c',
  });
  const r = await agent3Execute(vault, { verify: APPROVED, targetState: 'In Progress' });
  assert.equal(r.execution_status, 'SUCCESS');
  assert.equal(r.action_invoked, 'act1');
  assert.equal(r.confirmed_status, 'in_progress_state__c');
});

test('agent3Execute fails cleanly when no action matches the target', async () => {
  const vault = fakeVault({
    actions: [{ name: 'act1', label: 'Change State to Planned', type: 'state_change' }],
  });
  const r = await agent3Execute(vault, { verify: APPROVED, targetState: 'Inactive' });
  assert.equal(r.execution_status, 'FAILED');
  assert.equal(r.action_invoked, null);
  assert.match(r.message, /No lifecycle action/);
});
