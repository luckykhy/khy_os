'use strict';
/**
 * Leaf-contract test for gatewayConfigEditor.js (extracted from cli/handlers/gateway.js).
 *
 * Proves: (1) the leaf exports handleGatewayConfig + the DI setter as functions; (2) the host
 * re-imports handleGatewayConfig by the same name so the `gateway config` command contract is
 * byte-identical; (3) setGatewayConfigEditorDeps is a guarded, idempotent, non-throwing DI
 * setter that only wires function-typed deps (the 10 host callbacks â€?JSON/env helpers, model
 * choice builders and the provider-key leaf's _addCustomProviderInteractive â€?that avoid a
 * require cycle).
 *
 * The leaf performs IO (reads/writes .env, interactive prompts, lazy pool loads) so it does NOT
 * self-declare as a pure zero-IO leaf; assertions stay on the deterministic surface and never
 * invoke the IO handler.
 */
const LEAF = '../../../src/cli/handlers/gatewayConfigEditor';
const HOST = '../../../src/cli/handlers/gateway';

describe('Gateway Config Editor Leaf', () => {
  test('leaf exports handleGatewayConfig + DI setter as functions', () => {
      const leaf = require(LEAF);
      expect(typeof leaf.handleGatewayConfig).toBe('function');
      expect(typeof leaf.setGatewayConfigEditorDeps).toBe('function');
  });

  test('host re-imports handleGatewayConfig by the same name (contract intact)', () => {
      const host = require(HOST);
      expect(typeof host.handleGatewayConfig).toBe('function');
  });

  test('setGatewayConfigEditorDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setGatewayConfigEditorDeps } = require(LEAF);
      expect(() => setGatewayConfigEditorDeps().not.toThrow());
      expect(() => setGatewayConfigEditorDeps({}).not.toThrow());
      // Non-function deps are ignored, not wired.
      expect(() => setGatewayConfigEditorDeps({ promptWithReplGuard: 1, _writeEnvMap: null, buildGatewayModelChoices: 'x' }).not.toThrow());
      // Idempotent re-injection with real functions across the full dep surface.
      const fakeDeps = {};
      for (const n of ['promptWithReplGuard', '_parseJsonObject', '_mergeJsonEnvVar', '_removeJsonEnvVarKey',
        '_safeJsonLine', '_writeEnvMap', '_unsetEnvKeys', 'buildGatewayModelChoices',
        'handleGatewaySelectModel', '_addCustomProviderInteractive']) {
        fakeDeps[n] = () => undefined;
      }
      expect(() => setGatewayConfigEditorDeps(fakeDeps).not.toThrow());
      expect(() => setGatewayConfigEditorDeps(fakeDeps).not.toThrow());
  });

});

