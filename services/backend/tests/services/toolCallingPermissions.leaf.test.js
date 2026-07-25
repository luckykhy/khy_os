'use strict';

/**
 * Leaf-contract test for toolCallingPermissions.js (extracted from the toolCalling god-file).
 *
 * Proves three invariants of the byte-identical DI extraction:
 *  1. The host re-exports the permission API by the SAME identities as the leaf
 *     (`require('toolCalling')[name] === require('toolCallingPermissions')[name]`).
 *  2. setPermissionResolvers actually wires the two host resolvers the chain needs —
 *     getToolRisk/formatToolCall reach the injected _resolveToolDescriptor/_findBuiltinTool.
 *  3. Static SSOT surfaces (PERMISSION_MODES, permissionModeToProfile) are intact.
 */
const test = require('node:test');
const assert = require('node:assert');

const HOST = '../../src/services/toolCalling';
const LEAF = '../../src/services/toolCallingPermissions';

test('re-export identity: host permission API === leaf exports', () => {
  const host = require(HOST);
  const leaf = require(LEAF);
  const names = [
    'requestPermission', 'getPermissionMode', 'setPermissionMode', 'permissionModeToProfile',
    'PERMISSION_MODES', 'isApproved', 'approveTool', 'formatToolCall', '_decisionFromControl',
    'setReadlineProvider', 'getReadlineProvider', 'setPreflightContext',
    'clearPreflightContext', 'enableDangerousMode', 'disableDangerousMode', 'isDangerousMode',
    'acknowledgeDangerousMode',
  ];
  for (const n of names) {
    assert.ok(host[n] !== undefined, `host missing ${n}`);
    assert.strictEqual(host[n], leaf[n], `identity mismatch for ${n}`);
  }
});

test('PERMISSION_MODES is the frozen six-mode SSOT (CC-aligned)', () => {
  const { PERMISSION_MODES, permissionModeToProfile } = require(HOST);
  assert.deepStrictEqual(PERMISSION_MODES, ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypass']);
  assert.ok(Object.isFrozen(PERMISSION_MODES));
  assert.strictEqual(permissionModeToProfile('default'), 'normal');
  assert.strictEqual(permissionModeToProfile('auto'), 'auto');
  assert.strictEqual(permissionModeToProfile('dontAsk'), 'dontAsk');
});

test('setPermissionResolvers injects the host resolvers used by the risk/display path', () => {
  const leaf = require(LEAF);
  let sawResolve = 0;
  let sawFind = 0;
  // Inject stub resolvers; formatToolCall/getToolRisk must reach them.
  leaf.setPermissionResolvers({
    resolveToolDescriptor: (name) => { sawResolve++; return null; },
    findBuiltinTool: (name) => { sawFind++; return null; },
  });
  const out = leaf.formatToolCall('SomeUnknownTool', { a: 1 });
  assert.strictEqual(typeof out, 'string');
  // At least one resolver path was exercised (both feed the risk/descriptor lookup).
  assert.ok(sawResolve + sawFind > 0, 'injected resolvers were never called by formatToolCall');
  // NOTE: this overwrites the host-wired resolvers with stubs, but `node --test` runs each
  // file in its own process, so it cannot leak into other suites. Keep this test last.
});
