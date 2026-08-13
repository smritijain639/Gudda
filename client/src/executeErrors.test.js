import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExplainableExecuteFailure,
  missingRequiredFields,
  prettyFieldName,
  cleanExecuteMessage,
} from './executeErrors.js';

test('missingRequiredFields extracts a single field from a structured error', () => {
  const execute = {
    errors: [
      { type: 'INVALID_DATA', message: 'Required field [approval_date__c] is missing' },
    ],
  };
  assert.deepEqual(missingRequiredFields(execute), ['Approval Date']);
});

test('missingRequiredFields extracts multiple fields and de-duplicates', () => {
  const execute = {
    errors: [
      { type: 'INVALID_DATA', message: 'Field [approval_date__c] is required' },
      { type: 'INVALID_DATA', message: 'Field [reviewer__c] cannot be blank' },
      { type: 'INVALID_DATA', message: 'Field [approval_date__c] is required' },
    ],
  };
  assert.deepEqual(missingRequiredFields(execute), ['Approval Date', 'Reviewer']);
});

test('missingRequiredFields falls back to the message when errors[] is empty', () => {
  const execute = {
    errors: [],
    message: 'Mandatory field [country__v] must be set before this transition',
  };
  assert.deepEqual(missingRequiredFields(execute), ['Country']);
});

test('missingRequiredFields ignores bracketed value lists, keeps field names', () => {
  const execute = {
    errors: [
      {
        type: 'INVALID_DATA',
        message: 'Required parameter [contents__sys] missing; value [501,502] not allowed',
      },
    ],
  };
  // "501,502" is a value list, not a field API name, so only the real field is
  // reported.
  assert.deepEqual(missingRequiredFields(execute), ['Contents']);
});

test('missingRequiredFields ignores messages with no required hint', () => {
  const execute = {
    errors: [
      { type: 'INVALID_DATA', message: 'Invalid value [501,502] for parameter [contents__sys]' },
    ],
  };
  // No required/missing wording -> not treated as a missing-field failure.
  assert.deepEqual(missingRequiredFields(execute), []);
});

test('missingRequiredFields returns empty for unrelated failures', () => {
  assert.deepEqual(
    missingRequiredFields({ message: 'No lifecycle action moves this record.' }),
    []
  );
  assert.deepEqual(missingRequiredFields({}), []);
  assert.deepEqual(missingRequiredFields(null), []);
});

test('missingRequiredFields does not treat non-required bracket tokens as fields', () => {
  // Message has a bracketed token but no required/missing hint -> no fields.
  const execute = {
    errors: [{ type: 'RACE_CONDITION', message: 'Record [00S1] was modified concurrently' }],
  };
  assert.deepEqual(missingRequiredFields(execute), []);
});

test('prettyFieldName humanizes Vault API names', () => {
  assert.equal(prettyFieldName('approval_date__c'), 'Approval Date');
  assert.equal(prettyFieldName('country__v'), 'Country');
  assert.equal(prettyFieldName('reviewer'), 'Reviewer');
});

test('isExplainableExecuteFailure recognizes transition problems', () => {
  assert.equal(isExplainableExecuteFailure('No lifecycle action moves it'), true);
  assert.equal(isExplainableExecuteFailure('Available transitions: Planned'), true);
  assert.equal(isExplainableExecuteFailure('Required field [x__c] is missing'), false);
  assert.equal(isExplainableExecuteFailure(''), false);
});

test('cleanExecuteMessage strips the internal prefix', () => {
  assert.equal(
    cleanExecuteMessage('Execution error: something went wrong'),
    'something went wrong'
  );
  assert.equal(cleanExecuteMessage('plain message'), 'plain message');
  assert.equal(cleanExecuteMessage(''), '');
});
