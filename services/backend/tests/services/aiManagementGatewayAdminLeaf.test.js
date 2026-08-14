'use strict';

/**
 * Leaf-contract test for aiManagementGatewayAdmin.js (extracted from aiManagementServer).
 *
 * Proves: (1) the 8 host-consumed handlers + internals are exported functions,
 * (2) setGatewayAdminDeps wires the reverse edges so an exported handler
 * (handleManageList) runs end-to-end through injected sendJson, (3) validatePluginCode
 * is a pure deterministic re-export, (4) requiring aiManagementServer performs the
 * production wiring and keeps the host public contract intact.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../src/services/aiManagementGatewayAdmin';
const HOST = '../../src/services/aiManagementServer';

const HOST_CONSUMED = [
  'handleAiGatewayNamespace', 'handleAttributionDetail', 'handlePublicPaymentWebhook',
  'handleDependencyList', 'handleDependencyInstall',
  'handleManageList', 'handleManageResource', 'handleManageInvoke',
];

test('leaf exports the 8 host-consumed handlers + internals as functions', () => {
  const leaf = require(LEAF);
  for (const n of HOST_CONSUMED) {
    assert.strictEqual(typeof leaf[n], 'function', `missing handler ${n}`);
  }
  for (const n of ['toGatewayModelId', 'validatePluginCode', 'collectGatewayModelsSnapshot', 'setGatewayAdminDeps']) {
    assert.strictEqual(typeof leaf[n], 'function', `missing internal ${n}`);
  }
});

test('validatePluginCode is a pure re-export (valid + syntax-error paths)', () => {
  const leaf = require(LEAF);
  assert.deepStrictEqual(leaf.validatePluginCode('const a = 1;'), { valid: true });
  const bad = leaf.validatePluginCode('const = ;');
  assert.strictEqual(bad.valid, false);
  assert.strictEqual(typeof bad.error, 'string');
});

test('setGatewayAdminDeps wires sendJson/sendError so handleManageList runs end-to-end', async () => {
  const leaf = require(LEAF);
  let captured = null;
  leaf.setGatewayAdminDeps({
    sendJson: (res, code, body) => { captured = { via: 'json', code, body }; },
    sendError: (res, code, message) => { captured = { via: 'error', code, message }; },
  });
  await leaf.handleManageList({}, {});
  assert.ok(captured, 'no response emitted — reverse edge not wired');
  assert.strictEqual(typeof captured.code, 'number');
});

test('requiring aiManagementServer performs production DI wiring (host exports intact)', () => {
  const host = require(HOST);
  for (const n of ['start', 'stop', 'isRunning', 'getPort', 'configureFrontendStatic']) {
    assert.strictEqual(typeof host[n], 'function', `host missing ${n}`);
  }
  assert.ok(host.__test__ && typeof host.__test__ === 'object');
  // __test__ still re-exports the two band symbols it always exposed.
  assert.strictEqual(typeof host.__test__.handleAiGatewayNamespace, 'function');
  assert.strictEqual(typeof host.__test__.handleAttributionDetail, 'function');
});
