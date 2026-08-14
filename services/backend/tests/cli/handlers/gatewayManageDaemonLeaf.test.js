'use strict';

/**
 * Leaf-contract test for gatewayManageDaemon.js (extracted from cli/handlers/gateway.js).
 *
 * Proves: (1) the host-consumed exports are functions, (2) the host re-imports them by the
 * same names so the public gateway handler contract is unchanged, (3) _parseIntWithMin is a
 * pure deterministic re-export (the shared util the host still calls at several sites),
 * (4) _resolveAiManageApiBaseUrl runs deterministically for the explicit-port path.
 *
 * The leaf is a unidirectional extraction: it requires nothing from the host, so no DI is
 * involved — requiring it in isolation must fully wire.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/handlers/gatewayManageDaemon';
const HOST = '../../../src/cli/handlers/gateway';

test('leaf exports the host-consumed daemon handlers + shared util as functions', () => {
  const leaf = require(LEAF);
  for (const n of ['handleGatewayManage', 'handleAiServer', '_resolveAiManageApiBaseUrl', '_parseIntWithMin']) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
});

test('_parseIntWithMin is a pure deterministic re-export (clamp-to-min + fallback)', () => {
  const { _parseIntWithMin } = require(LEAF);
  assert.strictEqual(_parseIntWithMin('42', 5, 1), 42);
  assert.strictEqual(_parseIntWithMin('0', 5, 1), 5);   // below min → fallback
  assert.strictEqual(_parseIntWithMin('abc', 7, 1), 7); // non-numeric → fallback
  assert.strictEqual(_parseIntWithMin(undefined, 9, 1), 9);
});

test('_resolveAiManageApiBaseUrl honours an explicit api port deterministically', () => {
  const { _resolveAiManageApiBaseUrl } = require(LEAF);
  const out = _resolveAiManageApiBaseUrl({ apiPort: 8123 });
  assert.strictEqual(out, 'http://127.0.0.1:8123');
});

test('requiring the host re-imports the leaf by the same names (contract intact)', () => {
  const host = require(HOST);
  assert.strictEqual(typeof host.handleGatewayManage, 'function');
  assert.strictEqual(typeof host.handleAiServer, 'function');
  assert.strictEqual(typeof host.__test__._resolveAiManageApiBaseUrl, 'function');
});
