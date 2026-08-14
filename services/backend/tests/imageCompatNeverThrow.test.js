'use strict';

/**
 * imageCompatNeverThrow.test.js — regression for the never-throw hardening.
 *
 * normalizeImageItem / normalizeDocItem are the boundary that coerces UNTRUSTED
 * image/document items into a canonical shape; their documented contract is
 * "return null for anything we can't handle". An item field that is a non-string
 * object with a hostile/throwing toString (or a Symbol) makes an internal
 * String(...) coercion throw, which would otherwise escape the boundary. The
 * defensive try/catch degrades such contrived items to null.
 *
 * This is defense-in-depth: such an item does NOT survive JSON.parse (functions/
 * Symbols are dropped), so it is not reachable via the HTTP/JSON request path.
 * The value is guaranteeing the normalize boundary honors its "never throw"
 * contract regardless of caller. Byte-identical for every real string/URL/base64
 * item (the only behavior change is throw → null for the contrived case).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeImageItem, normalizeDocItem } = require('../src/services/gateway/adapters/_imageCompat');

const hostile = { toString() { throw new Error('boom'); } };

test('normalizeImageItem returns null (not throw) on hostile-toString base64', () => {
  let out;
  assert.doesNotThrow(() => { out = normalizeImageItem({ base64: hostile }); });
  assert.equal(out, null);
});

test('normalizeImageItem returns null on hostile-toString data field', () => {
  assert.doesNotThrow(() => normalizeImageItem({ data: hostile }));
  assert.equal(normalizeImageItem({ data: hostile }), null);
});

test('normalizeDocItem returns null (not throw) on hostile-toString base64', () => {
  let out;
  assert.doesNotThrow(() => { out = normalizeDocItem({ base64: hostile }); });
  assert.equal(out, null);
});

test('normalizeImageItem still normalizes a real data-URL (byte-identical path)', () => {
  const out = normalizeImageItem({ base64: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.ok(out, 'a valid data-URL item should normalize to a non-null result');
});

test('normalizeImageItem returns null on falsy input (unchanged)', () => {
  assert.equal(normalizeImageItem(null), null);
  assert.equal(normalizeImageItem(undefined), null);
  assert.equal(normalizeImageItem(''), null);
});
