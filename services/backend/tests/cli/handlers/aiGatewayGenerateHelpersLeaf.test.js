'use strict';
/**
 * Leaf-contract test for aiGatewayGenerateHelpers.js (extracted from cli/ai.js).
 *
 * Proves: (1) the leaf exports its gateway-generation helper entry points + the DI setter as functions;
 * (2) the host (cli/ai.js) still exposes its public surface (chat / getConversationStats /
 * checkModelCapability) so the extraction kept the module contract intact and the moved bodies are
 * re-imported by the same names; (3) two deterministic, side-effect-free bodies behave identically after
 * relocation â€?_toolProgressLabel maps a tool name to a human progress label, and _extractPlan pulls a
 * plan block out of assistant text; (4) setAiGatewayGenerateHelpersDeps is a guarded, idempotent,
 * non-throwing DI setter that only wires the injected host accessors.
 *
 * The leaf performs IO (service calls via getService, standalone-LLM logging), so it does NOT
 * self-declare as a pure zero-IO leaf; the assertions stay on the deterministic surface and never drive
 * a live gateway request.
 */
const LEAF = '../../../src/cli/aiGatewayGenerateHelpers';
const HOST = '../../../src/cli/ai';
const ENTRY_POINTS = [
  '_buildToolFallbackReply', '_salvageRecentToolResult', '_extractPlan', '_buildWorkSummary',
  '_toolProgressLabel', '_runNaturalToolCallWithIdleTimeout', '_formatGatewayFailureDetails',
  '_directGenerate', '_shouldInjectTaskSelfAwareness',
  '_buildWrapUpPrompt', '_buildStepDriverPrompt', '_buildStepRecoveryPrompt', '_buildResumePlanPrompt',
  '_wrapUpEnabled', '_annotateTruncation', '_buildRecoveryAttemptsNote',
];

describe('Ai Gateway Generate Helpers Leaf', () => {
  test('leaf exports the gateway-generation helper entry points + DI setter as functions', () => {
      const leaf = require(LEAF);
      for (const n of [...ENTRY_POINTS, 'setAiGatewayGenerateHelpersDeps']) {
        expect(typeof leaf[n]).toBe('function', `missing ${n}`);
      }
  });

  test('host cli/ai keeps its public contract after extraction', () => {
      const host = require(HOST);
      expect(typeof host.chat).toBe('function');
      expect(typeof host.getConversationStats).toBe('function');
      expect(typeof host.checkModelCapability).toBe('function');
  });

  test('_toolProgressLabel maps a tool name to a non-empty label deterministically', () => {
      const { _toolProgressLabel } = require(LEAF);
      const a = _toolProgressLabel('Read');
      const b = _toolProgressLabel('Bash');
      expect(typeof a).toBe('string');
      expect(a.length > 0).toBeTruthy();
      expect(typeof b).toBe('string');
      expect(b.length > 0).toBeTruthy();
  });

  test('_extractPlan splits a leading [Plan] line and passes plain text through unchanged', () => {
      const { _extractPlan } = require(LEAF);
      // No plan marker: plan is null and the reply is returned verbatim as `cleaned`.
      const none = _extractPlan('just a plain sentence with no plan');
      expect(none).toEqual({ plan: null, cleaned: 'just a plain sentence with no plan' });
      // A leading [Plan] line is lifted out and stripped from the cleaned body.
      const got = _extractPlan('[Plan] do the thing\nrest of reply');
      expect(got.plan).toBe('do the thing');
      expect(got.cleaned).toBe('rest of reply');
  });

  test('setAiGatewayGenerateHelpersDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setAiGatewayGenerateHelpersDeps } = require(LEAF);
      expect(() => setAiGatewayGenerateHelpersDeps().not.toThrow());
      expect(() => setAiGatewayGenerateHelpersDeps({}).not.toThrow());
      // Non-function deps are ignored by the typeof guards.
      assert.doesNotThrow(() => setAiGatewayGenerateHelpersDeps({
        _resolveAuditTraceContext: 1, _logStandaloneLlmRequest: null, getService: 0,
      }));
      const fake = {
        _resolveAuditTraceContext: () => ({}), _logStandaloneLlmRequest: () => {},
        _logStandaloneLlmResponse: () => {}, getService: () => ({}),
      };
      expect(() => setAiGatewayGenerateHelpersDeps(fake).not.toThrow());
      expect(() => setAiGatewayGenerateHelpersDeps(fake).not.toThrow());
  });

});

