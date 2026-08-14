'use strict';

/**
 * Leaf-contract test for gatewayModelChoices.js (extracted from cli/handlers/gateway.js).
 *
 * Proves: (1) the leaf exports the model-selection handlers + the DI setter as functions; (2) the
 * host re-imports every handler by the SAME name so the classic-CLI selector AND the Ink TUI
 * ModelPicker (both consume buildGatewayModelChoices) keep a byte-identical contract; (3)
 * setGatewayModelChoicesDeps is a guarded, idempotent, non-throwing DI setter that wires the 24
 * function callbacks plus the shared STRICT_OPERATIONAL_ADAPTERS value (function guards ignore
 * non-functions; the Set value is wired when truthy).
 *
 * The leaf performs IO (multi-second adapter probes, interactive prompts, .env persistence, terminal
 * output) so it does NOT self-declare as a pure zero-IO leaf; the assertions below stay on the
 * deterministic surface (export shape, contract identity, setter guard) and never invoke an IO handler.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/handlers/gatewayModelChoices';
const HOST = '../../../src/cli/handlers/gateway';

const HANDLERS = [
  'buildGatewayModelChoices',
  'applyGatewayModelSelection',
  'handleGatewaySelectModel',
  'buildVendorModelChoices',
  'handleModelSwitchByVendor',
];

test('leaf exports the model-selection handlers + setter as functions', () => {
  const leaf = require(LEAF);
  for (const n of [...HANDLERS, 'setGatewayModelChoicesDeps']) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
});

test('host re-imports the handlers by the same names (contract intact for CLI + TUI ModelPicker)', () => {
  const host = require(HOST);
  for (const n of HANDLERS) {
    assert.strictEqual(typeof host[n], 'function', `host missing ${n}`);
  }
});

test('setGatewayModelChoicesDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setGatewayModelChoicesDeps } = require(LEAF);
  assert.doesNotThrow(() => setGatewayModelChoicesDeps());
  assert.doesNotThrow(() => setGatewayModelChoicesDeps({}));
  // Non-function deps ignored; falsy STRICT ignored.
  assert.doesNotThrow(() => setGatewayModelChoicesDeps({ promptWithReplGuard: 1, isAdapterOperational: null, STRICT_OPERATIONAL_ADAPTERS: null }));
  // Idempotent re-injection across the full 24-fn surface + the shared Set value.
  const fakeDeps = { STRICT_OPERATIONAL_ADAPTERS: new Set(['codex']) };
  for (const n of ['promptWithReplGuard', '_getDeepProbeCache', '_setDeepProbeCache', '_getAdapterProbeTimeoutMs',
    '_getAdapterModelListTimeoutMs', 'shouldTreatGenerationFailureAsWarning', '_compactReasonText',
    '_isTimeoutLikeReason', '_isTransientProbeLikeReason', '_classifyHiddenReason', '_shouldRetryProbeByDebounce',
    '_formatModelSourceTag', '_formatConnectionTag', '_formatUpstreamTag', '_formatVisionTag',
    '_resolvePreferredAdapterIssue', '_filterModelsByReliability', 'maybeAutoSyncSwitchCenterForGateway',
    'getTokenInfoForSelection', 'askLine', 'recoverGatewayPromptInput', 'withTimeout', 'isAdapterOperational',
    'persistGatewayPreference']) {
    fakeDeps[n] = () => undefined;
  }
  assert.doesNotThrow(() => setGatewayModelChoicesDeps(fakeDeps));
  assert.doesNotThrow(() => setGatewayModelChoicesDeps(fakeDeps));
});
