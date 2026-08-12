import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSmallTalk,
  detectActionIntent,
  actionPromptFor,
  detectTargetState,
  matchTargetState,
} from './intent.js';

test('greetings are detected and personalized', () => {
  for (const g of ['Hi', 'hello', 'Hey!', 'good morning', 'HELLO', ' hi ']) {
    const r = detectSmallTalk(g, { username: 'vijaykv1' });
    assert.ok(r, `expected small-talk for "${g}"`);
    assert.equal(r.type, 'greeting');
    assert.match(r.reply, /vijaykv1/);
  }
});

test('thanks / how-are-you / bye / help are detected', () => {
  assert.equal(detectSmallTalk('thanks').type, 'thanks');
  assert.equal(detectSmallTalk('how are you').type, 'howareyou');
  assert.equal(detectSmallTalk('bye').type, 'bye');
  assert.equal(detectSmallTalk('help').type, 'help');
  assert.equal(detectSmallTalk('what can you do').type, 'help');
});

test('real queries are NOT treated as small-talk', () => {
  const queries = [
    'show submissions in draft state',
    'find registrations for my product',
    'list records ready for review',
    'hi, show me submissions', // greeting word but a real request
    'submission SUB-123',
  ];
  for (const q of queries) {
    assert.equal(detectSmallTalk(q), null, `"${q}" should fall through to search`);
  }
});

test('empty / whitespace returns null', () => {
  assert.equal(detectSmallTalk(''), null);
  assert.equal(detectSmallTalk('   '), null);
  assert.equal(detectSmallTalk(undefined), null);
});

test('greeting without username omits the name gracefully', () => {
  const r = detectSmallTalk('hi', {});
  assert.equal(r.type, 'greeting');
  assert.doesNotMatch(r.reply, /undefined/);
});

test('detectActionIntent recognizes delete/obsolete/edit/lifecycle', () => {
  assert.equal(detectActionIntent('need to delete one submission'), 'delete');
  assert.equal(detectActionIntent('remove this record'), 'delete');
  assert.equal(detectActionIntent('make this document obsolete'), 'obsolete');
  assert.equal(detectActionIntent('retire the registration'), 'obsolete');
  assert.equal(detectActionIntent('update the name field'), 'edit');
  assert.equal(detectActionIntent('change the status'), 'lifecycle');
  assert.equal(detectActionIntent('promote to review'), 'lifecycle');
});

test('detectActionIntent returns null for plain searches', () => {
  assert.equal(detectActionIntent('show submissions in draft'), null);
  assert.equal(detectActionIntent('list registrations'), null);
  assert.equal(detectActionIntent(''), null);
});

test('actionPromptFor produces a pick-list prompt for delete', () => {
  const p = actionPromptFor('delete', 'submission__v', 3);
  assert.match(p, /delete/i);
  assert.match(p, /3/);
  assert.match(p, /submission__v/);
});

test('detectTargetState extracts the state named after "to"', () => {
  assert.equal(
    detectTargetState('Change lifecycle state of submission SUB - IMA-2026-01318 to Planned'),
    'Planned'
  );
  assert.equal(detectTargetState('move it to In Progress'), 'In Progress');
  assert.equal(detectTargetState('set state to Inactive.'), 'Inactive');
  assert.equal(detectTargetState('promote SUB-1 into Ready for Submission'), 'Ready for Submission');
});

test('detectTargetState returns null when no target is named', () => {
  assert.equal(detectTargetState('change the status of SUB-1'), null);
  assert.equal(detectTargetState('show submissions'), null);
  assert.equal(detectTargetState(''), null);
  // Overly long trailing phrase is not treated as a state label.
  assert.equal(
    detectTargetState('to a really long sentence that clearly is not a lifecycle state label at all here'),
    null
  );
});

test('matchTargetState matches by label or state name, tolerant of casing/spacing', () => {
  const states = [
    { name: 'planned_state__c', label: 'Planned' },
    { name: 'in_progress_state__c', label: 'In Progress' },
    { name: 'inactive_state__c', label: 'Inactive' },
  ];
  assert.equal(matchTargetState(states, 'Planned').name, 'planned_state__c');
  assert.equal(matchTargetState(states, 'in progress').name, 'in_progress_state__c');
  assert.equal(matchTargetState(states, 'INACTIVE').name, 'inactive_state__c');
  // prefix match
  assert.equal(matchTargetState(states, 'plan').name, 'planned_state__c');
  assert.equal(matchTargetState(states, 'nope'), null);
  assert.equal(matchTargetState(states, ''), null);
});
