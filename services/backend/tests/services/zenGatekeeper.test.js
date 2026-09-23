'use strict';

/**
 * zenGatekeeper.test.js — OpenCode Zen free-tier gate pure-leaf contract.
 *
 * Locks:
 *  - endpoint detection is SSOT-driven (serviceDefaults.ZEN_BASE_URL), tolerant
 *    of trailing slash / optional /v1;
 *  - headers carry the OpenCode fingerprint (UA, session, client) + public bearer;
 *  - session/request ids are locally generated (ses_/msg_ + 26 base62), process-stable;
 *  - never throws; no network IO.
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const {
  isZenEndpoint,
  buildZenHeaders,
  requiresStream,
  getSessionId,
  newSessionId,
  newRequestId,
  _reset,
  ZEN_BASE_URL,
} = require('../../src/services/zenGatekeeper');

beforeEach(() => {
  delete process.env.OPENCODE_CLIENT;
  delete process.env.KHY_ZEN_SESSION_ID;
  delete process.env.KHY_OPENCODE_USER_AGENT;
  _reset();
});

test('isZenEndpoint: matches SSOT, tolerates /v1 and trailing slash', () => {
  assert.strictEqual(isZenEndpoint(ZEN_BASE_URL), true);
  assert.strictEqual(isZenEndpoint(`${ZEN_BASE_URL}/`), true);
  assert.strictEqual(isZenEndpoint(ZEN_BASE_URL.replace(/\/v1$/, '')), true);
  assert.strictEqual(isZenEndpoint('https://api.openai.com/v1'), false);
  assert.strictEqual(isZenEndpoint(''), false);
  assert.strictEqual(isZenEndpoint('not-a-url'), false);
});

test('requiresStream only for Zen endpoints', () => {
  assert.strictEqual(requiresStream(ZEN_BASE_URL), true);
  assert.strictEqual(requiresStream('https://api.openai.com'), false);
});

test('buildZenHeaders: opencode fingerprint + public bearer', () => {
  const h = buildZenHeaders();
  assert.match(h['User-Agent'], /^opencode\//);
  assert.strictEqual(h['x-opencode-client'], 'cli');
  assert.match(h['x-opencode-session'], /^ses_[0-9A-Za-z]{26}$/);
  assert.match(h['x-opencode-request'], /^msg_[0-9A-Za-z]{26}$/);
  assert.strictEqual(h['x-session-id'], h['x-opencode-session']);
  assert.strictEqual(h.Authorization, 'Bearer public');
  assert.ok(h['x-opencode-project']);
});

test('session id is process-stable; request id is fresh each call', () => {
  const a = getSessionId();
  const b = getSessionId();
  assert.strictEqual(a, b);
  const r1 = buildZenHeaders()['x-opencode-request'];
  const r2 = buildZenHeaders()['x-opencode-request'];
  assert.notStrictEqual(r1, r2);
});

test('OPENCODE_CLIENT env overrides client header', () => {
  process.env.OPENCODE_CLIENT = 'desktop';
  assert.strictEqual(buildZenHeaders()['x-opencode-client'], 'desktop');
});

test('id generators: ses_/msg_ + 26 base62, never empty', () => {
  assert.match(newSessionId(), /^ses_[0-9A-Za-z]{26}$/);
  assert.match(newRequestId(), /^msg_[0-9A-Za-z]{26}$/);
  assert.notStrictEqual(newSessionId(), newSessionId());
});

test('custom bearer override for non-default key', () => {
  const h = buildZenHeaders({ bearer: '' });
  assert.strictEqual(h.Authorization, 'Bearer ');
});
