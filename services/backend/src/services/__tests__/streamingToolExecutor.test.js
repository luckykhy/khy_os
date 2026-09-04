'use strict';

/**
 * streamingToolExecutor.test.js — Unit tests for StreamingToolExecutor (node:test).
 *
 * Covers:
 *  - Hash stability: different key order → same cache hit; different params → no cross-pollution.
 *  - Sibling-abort backfill: bash-like tool error fills placeholders for queued tools.
 *  - Concurrency-safe cache: successful parallel tool result is retrievable by hash.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const { StreamingToolExecutor } = require('../domain/query/query/streamingToolExecutor');

// ── Hash stability & no cross-pollution ─────────────────────────────────────

test('getResultByHash: same logical call with different key order hits cache', async () => {
  const executor = new StreamingToolExecutor({
    executeTools: async () => 'ok',
    isConcurrencySafe: () => true,
  });

  executor.addTool({ name: 'read_file', params: { path: '/a.js', encoding: 'utf8' } });
  await executor.awaitAll();

  // Different key order — must still hit the same cache entry
  const result = executor.getResultByHash('read_file', { encoding: 'utf8', path: '/a.js' });
  assert.ok(result, 'cache hit expected for reordered keys');
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.output, 'ok');
});

test('getResultByHash: different params do not cross-pollute cache', async () => {
  const executor = new StreamingToolExecutor({
    executeTools: async (_name, params) => `output_${params.path}`,
    isConcurrencySafe: () => true,
  });

  executor.addTool({ name: 'read_file', params: { path: '/a.js' } });
  executor.addTool({ name: 'read_file', params: { path: '/b.js' } });
  await executor.awaitAll();

  const a = executor.getResultByHash('read_file', { path: '/a.js' });
  const b = executor.getResultByHash('read_file', { path: '/b.js' });
  assert.ok(a && b, 'both cache entries should exist');
  assert.strictEqual(a.output, 'output_/a.js');
  assert.strictEqual(b.output, 'output_/b.js');

  // Non-existing params → null
  const none = executor.getResultByHash('read_file', { path: '/c.js' });
  assert.strictEqual(none, null);
});

test('getResultByHash: tool name normalization (hyphens/underscores) → same hash', async () => {
  const executor = new StreamingToolExecutor({
    executeTools: async () => 'norm-ok',
    isConcurrencySafe: () => true,
  });

  executor.addTool({ name: 'shell_command', params: { cmd: 'ls' } });
  await executor.awaitAll();

  // Name with hyphen instead of underscore → should still hit
  const result = executor.getResultByHash('shell-command', { cmd: 'ls' });
  assert.ok(result, 'normalization should collapse hyphens/underscores');
  assert.strictEqual(result.output, 'norm-ok');
});

// ── Sibling-abort backfill ──────────────────────────────────────────────────

test('_abortSiblings backfills placeholders for queued serial tools', async () => {
  const executor = new StreamingToolExecutor({
    executeTools: async (name) => {
      if (name === 'bash') {
        throw new Error('exit code 1');
      }
      return 'should not run';
    },
    isConcurrencySafe: (name) => name === 'bash',
    siblingAbortOnBashError: true,
  });

  // Queue several serial tools first, then a parallel bash that will fail
  executor.addTool({ name: 'write_file', params: { path: '/x' }, id: 'wf1' });
  executor.addTool({ name: 'write_file', params: { path: '/y' }, id: 'wf2' });
  executor.addTool({ name: 'bash', params: { command: 'fail' }, id: 'bash1' });

  await executor.awaitAll();

  const results = executor.getAllResults();
  // bash error result
  const bashResult = results.find((r) => r.id === 'bash1');
  assert.ok(bashResult, 'bash result exists');
  assert.strictEqual(bashResult.status, 'error');

  // Queued tools should have siblingAborted placeholders
  const wf1 = results.find((r) => r.id === 'wf1');
  const wf2 = results.find((r) => r.id === 'wf2');
  assert.ok(wf1, 'wf1 placeholder exists');
  assert.ok(wf2, 'wf2 placeholder exists');
  assert.strictEqual(wf1.status, 'error');
  assert.strictEqual(wf1.siblingAborted, true);
  assert.ok(wf1.output.includes('sibling bash tool failed'));
  assert.strictEqual(wf2.siblingAborted, true);
});

test('_abortSiblings: serial queue is empty after abort', async () => {
  const executor = new StreamingToolExecutor({
    executeTools: async (name) => {
      if (name === 'shell') {
        throw new Error('boom');
      }
      return 'ok';
    },
    isConcurrencySafe: (name) => name === 'shell',
    siblingAbortOnBashError: true,
  });

  executor.addTool({ name: 'grep', params: { q: 'x' }, id: 'g1' });
  executor.addTool({ name: 'shell', params: { cmd: 'bad' }, id: 's1' });

  await executor.awaitAll();

  const stats = executor.getStats();
  assert.strictEqual(stats.queued, 0, 'serial queue should be empty after abort');
});

// ── Concurrency-safe tool cache ─────────────────────────────────────────────

test('concurrency-safe tool success is cached and retrievable by hash', async () => {
  let callCount = 0;
  const executor = new StreamingToolExecutor({
    executeTools: async () => {
      callCount++;
      return { data: 42 };
    },
    isConcurrencySafe: () => true,
  });

  executor.addTool({ name: 'calculator', params: { expr: '6*7' }, id: 'c1' });
  await executor.awaitAll();

  assert.strictEqual(callCount, 1);
  const cached = executor.getResultByHash('calculator', { expr: '6*7' });
  assert.ok(cached);
  assert.deepStrictEqual(cached.output, { data: 42 });
  assert.strictEqual(cached.status, 'success');
});

test('error results are NOT cached (only success)', async () => {
  const executor = new StreamingToolExecutor({
    executeTools: async () => {
      throw new Error('fail');
    },
    isConcurrencySafe: () => true,
  });

  executor.addTool({ name: 'broken', params: { x: 1 }, id: 'b1' });
  await executor.awaitAll();

  const cached = executor.getResultByHash('broken', { x: 1 });
  assert.strictEqual(cached, null, 'error results should not be cached');
});
