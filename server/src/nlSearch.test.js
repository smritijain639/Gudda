import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson,
  validateSpec,
  objectKeywords,
  rankSiblings,
  findPopulatedSibling,
} from './nlSearch.js';
import { getByPath, isGalileoConfigured, galileoComplete } from './galileoClient.js';

// --- extractJson ------------------------------------------------------------

test('extractJson parses a plain JSON object', () => {
  const spec = extractJson('{"object":"submission__v","term":"foo"}');
  assert.equal(spec.object, 'submission__v');
  assert.equal(spec.term, 'foo');
});

test('extractJson strips ```json code fences', () => {
  const spec = extractJson('```json\n{"object":"application__v"}\n```');
  assert.equal(spec.object, 'application__v');
});

test('extractJson pulls the object out of surrounding prose', () => {
  const spec = extractJson('Sure! Here is the spec: {"object":"registration__rim"} Hope that helps.');
  assert.equal(spec.object, 'registration__rim');
});

test('extractJson throws on non-JSON', () => {
  assert.throws(() => extractJson('I cannot help with that'), /did not return valid JSON/);
});

// --- validateSpec -----------------------------------------------------------

test('validateSpec accepts a known object and keeps valid fields', () => {
  const { spec, warnings } = validateSpec(
    {
      object: 'submission__v',
      termFields: ['name__v'],
      filters: [{ field: 'status__v', operator: '=', value: 'active__v' }],
    },
    { objectNames: ['submission__v'], knownFields: ['status__v'] }
  );
  assert.equal(spec.object, 'submission__v');
  assert.equal(warnings.length, 0);
});

test('validateSpec repairs object case-insensitively', () => {
  const { spec } = validateSpec(
    { object: 'Submission__v' },
    { objectNames: ['submission__v'], knownFields: null }
  );
  assert.equal(spec.object, 'submission__v');
});

test('validateSpec throws when the object is unknown', () => {
  assert.throws(
    () => validateSpec({ object: 'nope__v' }, { objectNames: ['submission__v'] }),
    /does not exist/
  );
});

test('validateSpec drops unknown filter fields and warns', () => {
  const { spec, warnings } = validateSpec(
    {
      object: 'submission__v',
      filters: [
        { field: 'status__v', operator: '=', value: 'active__v' },
        { field: 'made_up__c', operator: '=', value: 'x' },
      ],
    },
    { objectNames: ['submission__v'], knownFields: ['status__v'] }
  );
  assert.equal(spec.filters.length, 1);
  assert.equal(spec.filters[0].field, 'status__v');
  assert.ok(warnings.some((w) => /unknown fields/.test(w)));
});

test('validateSpec falls back termFields to name__v when all dropped', () => {
  const { spec } = validateSpec(
    { object: 'submission__v', termFields: ['bogus__c'] },
    { objectNames: ['submission__v'], knownFields: ['status__v'] }
  );
  assert.deepEqual(spec.termFields, ['name__v']);
});

// --- sibling object matching ------------------------------------------------

test('objectKeywords splits name and drops the suffix', () => {
  assert.deepEqual(objectKeywords('medicinal_product_registration__v'), [
    'medicinal',
    'product',
    'registration',
  ]);
  assert.deepEqual(objectKeywords('registration__rim'), ['registration']);
});

test('rankSiblings prefers objects sharing the head keyword', () => {
  const all = [
    { name: 'medicinal_product_registration__v', label: 'MPR' },
    { name: 'registration__rim', label: 'Registration' },
    { name: 'registration__v', label: 'Registration' },
    { name: 'submission__v', label: 'Submission' },
  ];
  const ranked = rankSiblings('medicinal_product_registration__v', all);
  // Both registration objects share the head "registration"; submission does not.
  assert.ok(ranked.includes('registration__rim'));
  assert.ok(ranked.includes('registration__v'));
  assert.ok(!ranked.includes('submission__v'));
});

test('findPopulatedSibling returns the first sibling with records', async () => {
  const all = [
    { name: 'medicinal_product_registration__v', label: 'MPR' },
    { name: 'registration__rim', label: 'Registration' },
    { name: 'registration__v', label: 'Registration' },
  ];
  const vault = {
    query: async (vql) => {
      if (vql.includes('FROM registration__rim')) {
        return { data: [{ id: 'r1', name__v: 'REG-1' }], responseDetails: { total: 1 } };
      }
      return { data: [], responseDetails: { total: 0 } };
    },
  };
  const alt = await findPopulatedSibling(
    vault,
    all,
    { object: 'medicinal_product_registration__v', term: '' },
    'how many registrations'
  );
  assert.ok(alt);
  assert.equal(alt.object, 'registration__rim');
  assert.equal(alt.data.length, 1);
});

test('findPopulatedSibling returns null when no sibling has records', async () => {
  const all = [
    { name: 'medicinal_product_registration__v', label: 'MPR' },
    { name: 'registration__rim', label: 'Registration' },
  ];
  const vault = { query: async () => ({ data: [], responseDetails: { total: 0 } }) };
  const alt = await findPopulatedSibling(
    vault,
    all,
    { object: 'medicinal_product_registration__v', term: '' },
    'q'
  );
  assert.equal(alt, null);
});

// --- galileoClient helpers --------------------------------------------------

test('getByPath reads nested dot paths', () => {
  const obj = { choices: [{ message: { content: 'hello' } }] };
  assert.equal(getByPath(obj, 'choices.0.message.content'), 'hello');
  assert.equal(getByPath(obj, 'choices.1.message.content'), undefined);
});

test('galileoComplete adds a missing space after a bare auth prefix', async () => {
  const saved = {
    url: process.env.GALILEO_URL,
    key: process.env.GALILEO_API_KEY,
    prefix: process.env.GALILEO_AUTH_PREFIX,
  };
  const originalFetch = globalThis.fetch;
  let sentAuth;
  globalThis.fetch = (url, opts) => {
    sentAuth = opts.headers.Authorization;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
    });
  };
  try {
    process.env.GALILEO_URL = 'https://x/v1/chat/completions';
    process.env.GALILEO_API_KEY = 'abc123';
    process.env.GALILEO_AUTH_PREFIX = 'Bearer'; // no trailing space (trimmed by .env loaders)
    const out = await galileoComplete({ user: 'hi' });
    assert.equal(out, 'ok');
    assert.equal(sentAuth, 'Bearer abc123');
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.url == null) delete process.env.GALILEO_URL;
    else process.env.GALILEO_URL = saved.url;
    if (saved.key == null) delete process.env.GALILEO_API_KEY;
    else process.env.GALILEO_API_KEY = saved.key;
    if (saved.prefix == null) delete process.env.GALILEO_AUTH_PREFIX;
    else process.env.GALILEO_AUTH_PREFIX = saved.prefix;
  }
});

test('isGalileoConfigured reflects env vars', () => {
  const url = process.env.GALILEO_URL;
  const key = process.env.GALILEO_API_KEY;
  try {
    delete process.env.GALILEO_URL;
    delete process.env.GALILEO_API_KEY;
    assert.equal(isGalileoConfigured(), false);
    process.env.GALILEO_URL = 'https://x';
    process.env.GALILEO_API_KEY = 'k';
    assert.equal(isGalileoConfigured(), true);
  } finally {
    if (url == null) delete process.env.GALILEO_URL;
    else process.env.GALILEO_URL = url;
    if (key == null) delete process.env.GALILEO_API_KEY;
    else process.env.GALILEO_API_KEY = key;
  }
});
