'use strict';

const test = require('node:test');
const assert = require('node:assert');

const core = require('../../src/services/vaultCore');

test('isEnabled: default-on, falsy-off', () => {
  assert.strictEqual(core.isEnabled({}), true);
  assert.strictEqual(core.isEnabled({ KHY_VAULT: 'true' }), true);
  assert.strictEqual(core.isEnabled({ KHY_VAULT: 'off' }), false);
  assert.strictEqual(core.isEnabled({ KHY_VAULT: '0' }), false);
  assert.strictEqual(core.isEnabled({ KHY_VAULT: 'no' }), false);
});

test('isValidSecretName / normalizeName: env-var-like only', () => {
  assert.ok(core.isValidSecretName('GITHUB_PAT'));
  assert.ok(core.isValidSecretName('a'));
  assert.ok(!core.isValidSecretName('1ABC')); // must start with letter
  assert.ok(!core.isValidSecretName('A-B')); // no dash
  assert.ok(!core.isValidSecretName('A B')); // no space
  assert.ok(!core.isValidSecretName(''));
  assert.ok(!core.isValidSecretName('A'.repeat(65))); // too long
  assert.strictEqual(core.normalizeName('  TOKEN  '), 'TOKEN');
  assert.strictEqual(core.normalizeName('bad name'), null);
  assert.strictEqual(core.normalizeName(null), null);
});

test('maskSecret: never returns full value, discloses only length + a few chars', () => {
  assert.strictEqual(core.maskSecret(''), '(empty)');
  assert.match(core.maskSecret('short'), /\*\*\*\* \(5 chars\)/); // <12 fully masked
  const long = 'ghp_abcdefghijklmnopqrstuvwxyz';
  const m = core.maskSecret(long);
  assert.ok(!m.includes(long)); // never the full value
  assert.match(m, /^ghp…yz \(\d+ chars\)$/);
});

test('shapeListing: sorted by name, never includes value', () => {
  const record = {
    BETA: { value: 'secretvalue123456', createdAt: 'c2', updatedAt: 'u2' },
    ALPHA: { value: 'xyz', createdAt: 'c1', updatedAt: 'u1' },
  };
  const out = core.shapeListing(record);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'ALPHA'); // sorted
  assert.strictEqual(out[1].name, 'BETA');
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('secretvalue123456'));
  assert.ok(!serialized.includes('xyz'));
  assert.strictEqual(out[1].length, 'secretvalue123456'.length);
  assert.match(out[1].preview, /chars\)/);
});

test('shapeListing: junk -> []', () => {
  assert.deepStrictEqual(core.shapeListing(null), []);
  assert.deepStrictEqual(core.shapeListing('nope'), []);
});

test('extractSecretRefs / collectSecretRefs: find {{vault:NAME}}, dedupe, preserve order', () => {
  assert.deepStrictEqual(core.extractSecretRefs('Bearer {{vault:TOKEN}} and {{ vault:TOKEN }}'), ['TOKEN']);
  assert.deepStrictEqual(core.extractSecretRefs('none here'), []);
  const refs = core.collectSecretRefs({
    url: 'https://api/{{vault:A}}',
    headers: { Authorization: 'Bearer {{vault:B}}', 'X-Extra': '{{vault:A}}' },
    body: 'key={{vault:C}}',
  });
  assert.deepStrictEqual(refs, ['A', 'C', 'B']); // url, body, then headers; A deduped
});

test('substituteSecrets / substituteHeaders: server-side injection', () => {
  const map = { TOKEN: 'ghp_real', PW: 'p@ss' };
  assert.strictEqual(core.substituteSecrets('Bearer {{vault:TOKEN}}', map), 'Bearer ghp_real');
  // unknown placeholder left intact (caller already checked missing)
  assert.strictEqual(core.substituteSecrets('{{vault:UNKNOWN}}', map), '{{vault:UNKNOWN}}');
  const h = core.substituteHeaders({ Authorization: 'Bearer {{vault:TOKEN}}', 'X-Pw': '{{vault:PW}}' }, map);
  assert.deepStrictEqual(h, { Authorization: 'Bearer ghp_real', 'X-Pw': 'p@ss' });
});

test('substituteHeaders: does not mutate input', () => {
  const input = { A: '{{vault:X}}' };
  const out = core.substituteHeaders(input, { X: 'v' });
  assert.strictEqual(input.A, '{{vault:X}}');
  assert.strictEqual(out.A, 'v');
});

test('redactSecrets: replaces every secret value with [REDACTED], longest first', () => {
  const text = 'leaked ghp_real and tok and ghp_real again';
  const out = core.redactSecrets(text, ['ghp_real', 'tok']);
  assert.ok(!out.includes('ghp_real'));
  assert.match(out, /\[REDACTED\]/);
  // empty / no values -> unchanged
  assert.strictEqual(core.redactSecrets('abc', []), 'abc');
  assert.strictEqual(core.redactSecrets('abc', ['']), 'abc'); // empty string skipped
});

test('redactSecrets: substring overlap handled (longer value redacted fully)', () => {
  // 'abcdef' contains 'abc'; redacting longest first avoids leaving 'def'
  const out = core.redactSecrets('value=abcdef', ['abc', 'abcdef']);
  assert.ok(!out.includes('abcdef'));
  assert.ok(!out.includes('def'));
});

test('buildMissingSecretError: lists names, empty -> empty', () => {
  assert.strictEqual(core.buildMissingSecretError([]), '');
  const msg = core.buildMissingSecretError(['A', 'B']);
  assert.match(msg, /A, B/);
  assert.match(msg, /khy vault set/);
});

test('determinism: shapeListing stable across calls', () => {
  const rec = { Z: { value: 'aaaa', createdAt: 'c', updatedAt: 'u' }, A: { value: 'bbbb', createdAt: 'c', updatedAt: 'u' } };
  assert.deepStrictEqual(core.shapeListing(rec), core.shapeListing(rec));
});
