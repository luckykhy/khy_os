'use strict';
/**
 * toolUseLoop.streamingExecGate.test.js — Unit tests for the Phase 7
 * KHY_STREAMING_TOOL_EXEC gate semantics (node:test).
 *
 * Locks the behavior contract of isStreamingExecEnabled(env):
 *  - Unset KHY_STREAMING_TOOL_EXEC → streaming pre-execution ENABLED (default on).
 *  - 'false' (literal) → streaming pre-execution DISABLED.
 *  - 'true' → streaming pre-execution ENABLED (backward compatible).
 *  - Strict comparison: 'FALSE' / ' false ' / '0' do NOT disable (no lenient
 *    parsing — mirrors the production `!== 'false'` gate exactly).
 */
const { isStreamingExecEnabled } = require('../toolUseLoopCore');
test('gate: KHY_STREAMING_TOOL_EXEC="false" → disabled', () => {
  assert.strictEqual(
    isStreamingExecEnabled({ KHY_STREAMING_TOOL_EXEC: 'false' }),
    false,
    'literal "false" must disable streaming pre-execution'
  );
});
test('gate: KHY_STREAMING_TOOL_EXEC="true" → enabled (backward compatible)', () => {
  assert.strictEqual(
    isStreamingExecEnabled({ KHY_STREAMING_TOOL_EXEC: 'true' }),
    true,
    '"true" must keep streaming pre-execution enabled'
  );
});
test('gate: strict comparison — only literal "false" disables', () => {
  // Uppercase, padded, and numeric variants are NOT lenient-parsed: the
  // production gate is a strict `!== 'false'`, so these stay enabled.
  expect(isStreamingExecEnabled({ KHY_STREAMING_TOOL_EXEC: 'FALSE' })).toBe(true);
  expect(isStreamingExecEnabled({ KHY_STREAMING_TOOL_EXEC: ' false ' })).toBe(true);
  expect(isStreamingExecEnabled({ KHY_STREAMING_TOOL_EXEC: '0' })).toBe(true);
  expect(isStreamingExecEnabled({ KHY_STREAMING_TOOL_EXEC: '' })).toBe(true);
});

describe('Tool Use Loop streaming Exec Gate', () => {
  test('gate: unset KHY_STREAMING_TOOL_EXEC → enabled by default', () => {
      assert.strictEqual(
        isStreamingExecEnabled({}),
        true,
        'unset env var should keep streaming pre-execution enabled'
      );
  });

  test('gate: defaults to process.env when no argument given', () => {
      const saved = process.env.KHY_STREAMING_TOOL_EXEC;
      try {
        delete process.env.KHY_STREAMING_TOOL_EXEC;
        expect(isStreamingExecEnabled()).toBe(true, 'unset in process.env → enabled');
        process.env.KHY_STREAMING_TOOL_EXEC = 'false';
        expect(isStreamingExecEnabled()).toBe(false, '"false" in process.env → disabled');
      } finally {
        if (saved === undefined) {
          delete process.env.KHY_STREAMING_TOOL_EXEC;
        } else {
          process.env.KHY_STREAMING_TOOL_EXEC = saved;
        }
      }
  });

});
