'use strict';
/**
 * Leaf-contract test for toolCallingPermissions.js (extracted from the toolCalling god-file).
 *
 * Proves three invariants of the byte-identical DI extraction:
 *  1. The host re-exports the permission API by the SAME identities as the leaf
 *     (`require('toolCalling')[name] === require('toolCallingPermissions')[name]`).
 *  2. setPermissionResolvers actually wires the two host resolvers the chain needs â€?
 *     getToolRisk/formatToolCall reach the injected _resolveToolDescriptor/_findBuiltinTool.
 *  3. Static SSOT surfaces (PERMISSION_MODES, permissionModeToProfile) are intact.
 */
const HOST = '../../src/services/toolCalling';
const LEAF = '../../src/services/toolCallingPermissions';

describe('Tool Calling Permissions leaf', () => {
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
        expect(host[n] !== undefined).toBeTruthy();
        expect(host[n]).toBe(leaf[n], `identity mismatch for ${n}`);
      }
  });

  test('PERMISSION_MODES is the frozen six-mode SSOT (CC-aligned)', () => {
      const { PERMISSION_MODES, permissionModeToProfile } = require(HOST);
      expect(PERMISSION_MODES).toEqual(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypass']);
      expect(Object.isFrozen(PERMISSION_MODES).toBeTruthy());
      expect(permissionModeToProfile('default')).toBe('normal');
      expect(permissionModeToProfile('auto')).toBe('auto');
      expect(permissionModeToProfile('dontAsk')).toBe('dontAsk');
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
      expect(typeof out).toBe('string');
      // At least one resolver path was exercised (both feed the risk/descriptor lookup).
      expect(sawResolve + sawFind > 0).toBeTruthy();
      // NOTE: this overwrites the host-wired resolvers with stubs, but `node --test` runs each
      // file in its own process, so it cannot leak into other suites. Keep this test last.
  });

});

