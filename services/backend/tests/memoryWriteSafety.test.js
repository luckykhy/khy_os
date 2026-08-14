'use strict';

/**
 * memoryWriteSafety — pure-leaf contract tests (node:test, jest-ignored).
 *
 * Verifies the deterministic write-policy decisions only (no fs IO): gate
 * default-on / off, plan clamping, transient-vs-permanent retry classification,
 * the retry upper bound, deterministic linear back-off, and read-back verify.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ws = require('../src/services/memoryWriteSafety');

test('isEnabled: default-on, off only for {0,false,off,no} (trim/lowercase)', () => {
  assert.equal(ws.isEnabled({}), true);
  assert.equal(ws.isEnabled({ KHY_MEMORY_WRITE_SAFETY: '' }), true);
  assert.equal(ws.isEnabled({ KHY_MEMORY_WRITE_SAFETY: '1' }), true);
  assert.equal(ws.isEnabled({ KHY_MEMORY_WRITE_SAFETY: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.equal(ws.isEnabled({ KHY_MEMORY_WRITE_SAFETY: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
});

test('planWrite: gate off ⇒ {enabled:false} single bare write fallback', () => {
  const p = ws.planWrite({ KHY_MEMORY_WRITE_SAFETY: 'off' });
  assert.equal(p.enabled, false);
  assert.equal(p.maxAttempts, 1);
  assert.equal(p.backoffBaseMs, 0);
  assert.equal(p.verify, false);
});

test('planWrite: defaults when enabled with no overrides', () => {
  const p = ws.planWrite({});
  assert.equal(p.enabled, true);
  assert.equal(p.maxAttempts, ws.DEFAULTS.maxAttempts);
  assert.equal(p.backoffBaseMs, ws.DEFAULTS.backoffBaseMs);
  assert.equal(p.verify, true);
});

test('planWrite: env overrides are clamped to safe bounds', () => {
  assert.equal(ws.planWrite({ KHY_MEMORY_WRITE_RETRIES: '99' }).maxAttempts, 10);
  assert.equal(ws.planWrite({ KHY_MEMORY_WRITE_RETRIES: '0' }).maxAttempts, 1);
  assert.equal(ws.planWrite({ KHY_MEMORY_WRITE_RETRIES: 'abc' }).maxAttempts, ws.DEFAULTS.maxAttempts);
  assert.equal(ws.planWrite({ KHY_MEMORY_WRITE_BACKOFF_MS: '-5' }).backoffBaseMs, 0);
  assert.equal(ws.planWrite({ KHY_MEMORY_WRITE_BACKOFF_MS: '999999' }).backoffBaseMs, 5000);
});

test('planWrite: verify toggled off only by {0,false,off,no}', () => {
  assert.equal(ws.planWrite({ KHY_MEMORY_WRITE_VERIFY: 'off' }).verify, false);
  assert.equal(ws.planWrite({ KHY_MEMORY_WRITE_VERIFY: '0' }).verify, false);
  assert.equal(ws.planWrite({ KHY_MEMORY_WRITE_VERIFY: 'yes' }).verify, true);
  assert.equal(ws.planWrite({}).verify, true);
});

test('shouldRetry: transient codes retry, permanent codes do not', () => {
  for (const code of ['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'EINTR', 'ETIMEDOUT', 'EPERM', 'EEXIST']) {
    assert.equal(ws.shouldRetry(code, 1, 3), true, `${code} should retry`);
  }
  for (const code of ['EACCES', 'EROFS', 'ENOSPC', 'ENOENT', 'EVERIFY', undefined, null, '']) {
    assert.equal(ws.shouldRetry(code, 1, 3), false, `${code} should not retry`);
  }
});

test('shouldRetry: never retries at/after the attempt ceiling', () => {
  assert.equal(ws.shouldRetry('EAGAIN', 3, 3), false); // ceiling reached
  assert.equal(ws.shouldRetry('EAGAIN', 4, 3), false);
  assert.equal(ws.shouldRetry('eagain', 1, 3), true);  // case-insensitive
});

test('backoffMs: deterministic linear, zero base ⇒ 0, capped at 5000', () => {
  assert.equal(ws.backoffMs(1, 25), 25);
  assert.equal(ws.backoffMs(3, 25), 75);
  assert.equal(ws.backoffMs(2, 0), 0);
  assert.equal(ws.backoffMs(1000, 25), 5000); // cap
});

test('verifyMatches: exact equality, null/undefined coerced to empty', () => {
  assert.equal(ws.verifyMatches('abc', 'abc'), true);
  assert.equal(ws.verifyMatches('abc', 'abd'), false);
  assert.equal(ws.verifyMatches('', null), true);
  assert.equal(ws.verifyMatches(null, undefined), true);
  assert.equal(ws.verifyMatches('x', ''), false);
});
