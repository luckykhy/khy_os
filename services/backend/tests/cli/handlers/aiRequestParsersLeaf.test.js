'use strict';

/**
 * Leaf-contract test for aiRequestParsers.js (extracted from cli/ai.js).
 *
 * Proves: (1) the leaf exports its request-parsing / stream-interception entry points as functions
 * (plus the two constant tables); (2) the host (cli/ai.js) still exposes its public surface (chat /
 * __test__ seam) so the extraction kept the module contract intact and the moved bodies are re-imported
 * by the same names; (3) two deterministic, side-effect-free bodies behave identically after
 * relocation — _partialToolMarkerTailLen sizes the withhold tail from _TOOL_CALL_MARKERS, and
 * _detectUserInputLanguage classifies CJK vs latin input.
 *
 * The leaf reads only the shared khyUpgradeRuntime singleton (no conversation/session state), but its
 * stream-interceptor path drives IO-adjacent gateway flows, so it does NOT self-declare as a pure
 * zero-IO leaf; the assertions stay on the deterministic surface.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/aiRequestParsers';
const HOST = '../../../src/cli/ai';

const FN_EXPORTS = [
  '_partialToolMarkerTailLen', '_streamToolRawInputEnabled', '_resolveToolBlockInput',
  '_createStreamToolInterceptor', '_classifyGatewayThrownError', '_isFirstTokenSignalChunk',
  '_isTransientGatewayErrorType', '_resolveTaskScale', '_fileRefRedosGuardEnabled',
  '_extractFileReferences', '_isLightweightConversationInput', '_buildGreetingQuickReply',
  '_extractRequestedLanguage', '_detectUserInputLanguage', '_hasLanguageRuleInPrompt',
  '_buildLanguageFallbackDirective',
];

test('leaf exports the request-parsing entry points as functions + marker constants', () => {
  const leaf = require(LEAF);
  for (const n of FN_EXPORTS) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
  assert.ok(Array.isArray(leaf._TOOL_CALL_MARKERS), '_TOOL_CALL_MARKERS is an array');
  assert.ok(leaf._TOOL_CALL_MARKERS.includes('<tool_call>'));
  assert.strictEqual(typeof leaf.FILEREF_MAX_TOKEN, 'number');
});

test('host cli/ai keeps its public contract + __test__ seam after extraction', () => {
  const host = require(HOST);
  assert.strictEqual(typeof host.chat, 'function');
  assert.ok(host.__test__, 'host exposes __test__ seam');
  // The __test__ seam re-exports moved bodies by the same names.
  assert.strictEqual(typeof host.__test__._createStreamToolInterceptor, 'function');
  assert.strictEqual(typeof host.__test__._extractFileReferences, 'function');
});

test('_partialToolMarkerTailLen sizes the withhold tail deterministically', () => {
  const { _partialToolMarkerTailLen } = require(LEAF);
  // A clean string with no partial marker tail withholds nothing.
  assert.strictEqual(_partialToolMarkerTailLen('hello world'), 0);
  // A dangling prefix of a known marker must be withheld (non-zero, bounded).
  const tail = _partialToolMarkerTailLen('some text <tool_cal');
  assert.ok(tail > 0, 'withholds a partial marker prefix');
});

test('_detectUserInputLanguage classifies CJK vs latin input', () => {
  const { _detectUserInputLanguage } = require(LEAF);
  assert.strictEqual(_detectUserInputLanguage('你好,帮我写一个函数'), 'zh');
  assert.strictEqual(_detectUserInputLanguage('hello, write me a function'), 'en');
});
