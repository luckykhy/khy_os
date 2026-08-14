'use strict';

/**
 * aiRequestParsers.streamToolInterceptor.test.js — Unit tests for
 * _createStreamToolInterceptor Phase 7 pre-execution logic (node:test).
 *
 * Covers:
 *  - Empty input does NOT trigger streamingExecutor.addTool.
 *  - Complete (non-empty keys) input triggers addTool exactly once.
 *  - Duplicate blockId chunks do NOT re-submit.
 *  - tool_use_end event triggers addTool even if keys were empty earlier.
 *  - reset() clears preExecutedToolIds so same id can be re-submitted.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const { _createStreamToolInterceptor } = require('./aiRequestParsers');

// Helper: create a mock streamingExecutor that records calls
function createMockExecutor() {
  const calls = [];
  return {
    addTool(call) {
      calls.push(call);
    },
    getCalls() {
      return calls;
    },
  };
}

// ── Empty input does NOT trigger addTool ────────────────────────────────────

test('interceptor: empty input {} does not trigger addTool', () => {
  const mock = createMockExecutor();
  const interceptor = _createStreamToolInterceptor(() => {}, {
    streamingExecutor: mock,
  });

  // Simulate content_block_start with empty input (typical streaming start)
  interceptor.onChunk({
    type: 'tool_use',
    tool: 'read_file',
    name: 'read_file',
    input: {},
    rawInput: {},
    id: 'block_1',
  });

  assert.strictEqual(mock.getCalls().length, 0, 'empty input should NOT trigger addTool');
});

// ── Complete input triggers addTool exactly once ────────────────────────────

test('interceptor: complete input triggers addTool once', () => {
  const mock = createMockExecutor();
  const interceptor = _createStreamToolInterceptor(() => {}, {
    streamingExecutor: mock,
  });

  // First chunk: empty start (should not trigger)
  interceptor.onChunk({
    type: 'tool_use',
    tool: 'read_file',
    name: 'read_file',
    input: {},
    rawInput: {},
    id: 'block_2',
  });

  // Second chunk: full input (should trigger)
  interceptor.onChunk({
    type: 'tool_use',
    tool: 'read_file',
    name: 'read_file',
    input: { path: '/foo.js' },
    rawInput: { path: '/foo.js' },
    id: 'block_2',
  });

  assert.strictEqual(mock.getCalls().length, 1, 'should trigger addTool once');
  assert.strictEqual(mock.getCalls()[0].name, 'read_file');
  assert.deepStrictEqual(mock.getCalls()[0].params, { path: '/foo.js' });
});

// ── Duplicate blockId does NOT re-submit ────────────────────────────────────

test('interceptor: same blockId repeated does NOT re-submit', () => {
  const mock = createMockExecutor();
  const interceptor = _createStreamToolInterceptor(() => {}, {
    streamingExecutor: mock,
  });

  const chunk = {
    type: 'tool_use',
    tool: 'bash',
    name: 'bash',
    input: { command: 'echo hi' },
    rawInput: { command: 'echo hi' },
    id: 'block_3',
  };

  interceptor.onChunk(chunk);
  interceptor.onChunk(chunk); // duplicate
  interceptor.onChunk(chunk); // duplicate

  assert.strictEqual(
    mock.getCalls().length,
    1,
    'only first complete chunk triggers addTool; duplicates are deduped by blockId'
  );
});

// ── tool_use_end triggers submission ────────────────────────────────────────

test('interceptor: tool_use_end triggers addTool even if first chunk had empty input', () => {
  const mock = createMockExecutor();
  const interceptor = _createStreamToolInterceptor(() => {}, {
    streamingExecutor: mock,
  });

  // Empty start
  interceptor.onChunk({
    type: 'tool_use',
    tool: 'write_file',
    name: 'write_file',
    input: {},
    rawInput: {},
    id: 'block_4',
  });

  assert.strictEqual(mock.getCalls().length, 0);

  // Explicit end event with full input
  interceptor.onChunk({
    type: 'tool_use_end',
    tool: 'write_file',
    name: 'write_file',
    input: { path: '/x.js', content: 'hello' },
    rawInput: { path: '/x.js', content: 'hello' },
    id: 'block_4',
  });

  assert.strictEqual(mock.getCalls().length, 1);
  assert.strictEqual(mock.getCalls()[0].id, 'block_4');
});

// ── reset() clears preExecutedToolIds ───────────────────────────────────────

test('interceptor: reset() allows same blockId to be re-submitted', () => {
  const mock = createMockExecutor();
  const interceptor = _createStreamToolInterceptor(() => {}, {
    streamingExecutor: mock,
  });

  const chunk = {
    type: 'tool_use',
    tool: 'grep',
    name: 'grep',
    input: { pattern: 'foo' },
    rawInput: { pattern: 'foo' },
    id: 'block_5',
  };

  interceptor.onChunk(chunk);
  assert.strictEqual(mock.getCalls().length, 1);

  // After reset, same id should be submittable again
  interceptor.reset();
  interceptor.onChunk(chunk);
  assert.strictEqual(mock.getCalls().length, 2, 'after reset, same blockId can be submitted again');
});

// ── No streamingExecutor → no crash ─────────────────────────────────────────

test('interceptor: works without streamingExecutor (no crash)', () => {
  const interceptor = _createStreamToolInterceptor(() => {}, {});

  // Should not throw
  interceptor.onChunk({
    type: 'tool_use',
    tool: 'bash',
    name: 'bash',
    input: { command: 'ls' },
    rawInput: { command: 'ls' },
    id: 'block_6',
  });

  assert.ok(interceptor.hasToolCall(), 'tool call detected');
});
