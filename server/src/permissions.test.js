import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessObject, filterObjects } from './permissions.js';

test('canAccessObject allows anything when no allowlist is captured', () => {
  assert.equal(canAccessObject(null, 'submission__v'), true);
  assert.equal(canAccessObject({}, 'submission__v'), true);
  assert.equal(canAccessObject({ allowedObjects: null }, 'anything__v'), true);
});

test('canAccessObject enforces the allowlist when present', () => {
  const session = { allowedObjects: ['submission__v', 'registration__rim'] };
  assert.equal(canAccessObject(session, 'submission__v'), true);
  assert.equal(canAccessObject(session, 'registration__rim'), true);
  assert.equal(canAccessObject(session, 'application__v'), false);
});

test('canAccessObject with an empty allowlist blocks everything', () => {
  const session = { allowedObjects: [] };
  // Empty array is a real (falsy-length but defined) restriction.
  assert.equal(canAccessObject(session, 'submission__v'), false);
});

test('filterObjects returns all when no allowlist is captured', () => {
  const objects = [{ name: 'a__v' }, { name: 'b__v' }];
  assert.deepEqual(filterObjects(null, objects), objects);
  assert.deepEqual(filterObjects({}, objects), objects);
});

test('filterObjects keeps only permitted objects', () => {
  const session = { allowedObjects: ['a__v', 'c__v'] };
  const objects = [{ name: 'a__v' }, { name: 'b__v' }, { name: 'c__v' }];
  const result = filterObjects(session, objects);
  assert.deepEqual(result.map((o) => o.name), ['a__v', 'c__v']);
});

test('filterObjects handles empty/undefined input safely', () => {
  const session = { allowedObjects: ['a__v'] };
  assert.deepEqual(filterObjects(session, undefined), []);
  assert.deepEqual(filterObjects(session, []), []);
});
