import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSmallTalk, detectActionIntent, actionPromptFor } from './intent.js';

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
