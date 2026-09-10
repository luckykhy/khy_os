'use strict';
/**
 * streamingToolExecutor.test.js �?Unit tests for StreamingToolExecutor (node:test).
 *
 * Covers:
 *  - Hash stability: different key order �?same cache hit; different params �?no cross-pollution.
 *  - Sibling-abort backfill: bash-like tool error fills placeholders for queued tools.
 *  - Concurrency-safe cache: successful parallel tool result is retrievable by hash.
 */
const { StreamingToolExecutor } = require('../domain/query/query/streamingToolExecutor');
// ── Hash stability & no cross-pollution ─────────────────────────────────────
// ── Sibling-abort backfill ──────────────────────────────────────────────────
// ── Concurrency-safe tool cache ─────────────────────────────────────────────

describe('Streaming Tool Executor', () => {
  test('getResultByHash: same logical call with different key order hits cache', async () => {
      const executor = new StreamingToolExecutor({
        executeTools: async () => 'ok',
        isConcurrencySafe: () => true,
      });
    
      executor.addTool({ name: 'read_file', params: { path: '/a.js', encoding: 'utf8' } });
      await executor.awaitAll();
    
      // Different key order �?must still hit the same cache entry
      const result = executor.getResultByHash('read_file', { encoding: 'utf8', path: '/a.js' });
      expect(result).toBeTruthy();
      expect(result.status).toBe('success');
      expect(result.output).toBe('ok');
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
      expect(a && b).toBeTruthy();
      expect(a.output).toBe('output_/a.js');
      expect(b.output).toBe('output_/b.js');
    
      // Non-existing params �?null
      const none = executor.getResultByHash('read_file', { path: '/c.js' });
      expect(none).toBe(null);
  });

  test('getResultByHash: tool name normalization (hyphens/underscores) �?same hash', async () => {
      const executor = new StreamingToolExecutor({
        executeTools: async () => 'norm-ok',
        isConcurrencySafe: () => true,
      });
    
      executor.addTool({ name: 'shell_command', params: { cmd: 'ls' } });
      await executor.awaitAll();
    
      // Name with hyphen instead of underscore �?should still hit
      const result = executor.getResultByHash('shell-command', { cmd: 'ls' });
      expect(result).toBeTruthy();
      expect(result.output).toBe('norm-ok');
  });

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
      expect(bashResult).toBeTruthy();
      expect(bashResult.status).toBe('error');
    
      // Queued tools should have siblingAborted placeholders
      const wf1 = results.find((r) => r.id === 'wf1');
      const wf2 = results.find((r) => r.id === 'wf2');
      expect(wf1).toBeTruthy();
      expect(wf2).toBeTruthy();
      expect(wf1.status).toBe('error');
      expect(wf1.siblingAborted).toBe(true);
      expect(wf1.output).toContain('sibling bash tool failed');
      expect(wf2.siblingAborted).toBe(true);
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
      expect(stats.queued).toBe(0, 'serial queue should be empty after abort');
  });

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
    
      expect(callCount).toBe(1);
      const cached = executor.getResultByHash('calculator', { expr: '6*7' });
      expect(cached).toBeTruthy();
      expect(cached.output).toEqual({ data: 42 });
      expect(cached.status).toBe('success');
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
      expect(cached).toBe(null, 'error results should not be cached');
  });

});

