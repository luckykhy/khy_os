'use strict';

/**
 * mcpHttpServer — pure security-helper tests (node:test).
 *
 * The transport itself (http.createServer / sockets) is deliberately NOT
 * exercised end-to-end here — per house convention, resident-process + network
 * tests are brittle in unit tests; the request→response contract is already
 * covered by mcpServer.test.js (handleMessage). This file locks the pure
 * security decisions that MUST NOT regress: loopback detection, the "no bare
 * network exposure without a token" start guard, and bearer/query token auth.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const h = require('../../../src/services/mcp/mcpHttpServer');

test('isLoopbackHost: 127.x / localhost / ::1 / empty → true; public → false', () => {
  assert.equal(h.isLoopbackHost('127.0.0.1'), true);
  assert.equal(h.isLoopbackHost('localhost'), true);
  assert.equal(h.isLoopbackHost('::1'), true);
  assert.equal(h.isLoopbackHost(''), true);
  assert.equal(h.isLoopbackHost('127.5.5.5'), true);
  assert.equal(h.isLoopbackHost('0.0.0.0'), false);
  assert.equal(h.isLoopbackHost('192.168.1.10'), false);
  assert.equal(h.isLoopbackHost('example.com'), false);
});

test('canStartOnHost: loopback always ok; non-loopback needs token', () => {
  assert.equal(h.canStartOnHost('127.0.0.1').ok, true);
  assert.equal(h.canStartOnHost('localhost', '').ok, true);
  // non-loopback, no token → refuse with a reason
  const refused = h.canStartOnHost('0.0.0.0', '');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /token|loopback|127\.0\.0\.1/);
  // non-loopback WITH token → ok
  assert.equal(h.canStartOnHost('0.0.0.0', 'secret').ok, true);
});

test('isAuthorized: no token configured → always allowed (loopback)', () => {
  assert.equal(h.isAuthorized({}, ''), true);
  assert.equal(h.isAuthorized({ authorization: 'Bearer whatever' }, ''), true);
});

test('isAuthorized: token configured → bearer or query must match', () => {
  const tok = 's3cr3t';
  assert.equal(h.isAuthorized({ authorization: 'Bearer s3cr3t' }, tok), true);
  assert.equal(h.isAuthorized({ queryToken: 's3cr3t' }, tok), true);
  assert.equal(h.isAuthorized({ authorization: 'Bearer wrong' }, tok), false);
  assert.equal(h.isAuthorized({ queryToken: 'wrong' }, tok), false);
  assert.equal(h.isAuthorized({}, tok), false);
});

test('DEFAULT_HOST is loopback (safe default)', () => {
  assert.equal(h.DEFAULT_HOST, '127.0.0.1');
  assert.equal(h.isLoopbackHost(h.DEFAULT_HOST), true);
});
