'use strict';

/**
 * Tests for the Arena Manager.
 */

const { ArenaManager, generateArenaSummary, formatArenaResult } = require('../src/services/arenaManager');

describe('ArenaManager', () => {

  describe('constructor', () => {
    test('creates with default options', () => {
      const gw = { query: async () => 'test' };
      const arena = new ArenaManager(gw);
      expect(arena).toBeDefined();
    });

    test('accepts custom timeout and concurrency', () => {
      const gw = { query: async () => 'test' };
      const arena = new ArenaManager(gw, { timeoutMs: 30000, maxConcurrency: 3 });
      expect(arena).toBeDefined();
    });
  });

  describe('run()', () => {
    test('rejects with less than 2 models', async () => {
      const gw = { query: async () => 'test' };
      const arena = new ArenaManager(gw);

      await expect(arena.run({ prompt: 'test', models: ['m1'] }))
        .rejects.toThrow('at least 2 models');
    });

    test('rejects without prompt', async () => {
      const gw = { query: async () => 'test' };
      const arena = new ArenaManager(gw);

      await expect(arena.run({ prompt: '', models: ['m1', 'm2'] }))
        .rejects.toThrow('at least 2 models');
    });

    test('runs multiple models in parallel via query()', async () => {
      const responses = {
        'model-a': 'Response from model A with some content',
        'model-b': 'Response from model B with different content',
      };

      const gw = {
        query: async (prompt, opts) => {
          return responses[opts.model] || 'unknown';
        },
      };

      const arena = new ArenaManager(gw);
      const result = await arena.run({ prompt: 'test prompt', models: ['model-a', 'model-b'] });

      expect(result.arenaId).toMatch(/^arena-/);
      expect(result.prompt).toBe('test prompt');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].model).toBe('model-a');
      expect(result.entries[0].content).toBe('Response from model A with some content');
      expect(result.entries[1].model).toBe('model-b');
      expect(result.entries[1].content).toBe('Response from model B with different content');
      expect(result.summary).toBeDefined();
      expect(result.summary.successCount).toBe(2);
      expect(result.totalMs).toBeGreaterThan(0);
    });

    test('handles model failures gracefully', async () => {
      const gw = {
        query: async (prompt, opts) => {
          if (opts.model === 'bad-model') throw new Error('Model unavailable');
          return 'OK response';
        },
      };

      const arena = new ArenaManager(gw);
      const result = await arena.run({ prompt: 'test', models: ['good-model', 'bad-model'] });

      expect(result.entries).toHaveLength(2);
      const good = result.entries.find((e) => e.model === 'good-model');
      const bad = result.entries.find((e) => e.model === 'bad-model');
      expect(good.failed).toBe(false);
      expect(bad.failed).toBe(true);
      expect(bad.error).toContain('Model unavailable');
      expect(result.summary.failedCount).toBe(1);
    });

    test('calls onProgress callback', async () => {
      const gw = {
        query: async () => 'short response',
      };

      const progressEvents = [];
      const arena = new ArenaManager(gw);
      await arena.run({
        prompt: 'test',
        models: ['m1', 'm2'],
        onProgress: (model, event) => progressEvents.push({ model, event }),
      });

      // query() fallback emits one chunk per model
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('generateArenaSummary()', () => {
    test('generates summary for successful entries', () => {
      const entries = [
        { model: 'a', content: 'Hello world from model a', latencyMs: 100, totalMs: 500, usage: null, failed: false },
        { model: 'b', content: 'Hello world from model b with more text', latencyMs: 200, totalMs: 800, usage: null, failed: false },
      ];

      const summary = generateArenaSummary('test', entries);
      expect(summary.successCount).toBe(2);
      expect(summary.failedCount).toBe(0);
      expect(summary.fastest.model).toBe('a');
      expect(summary.metrics).toHaveLength(2);
      expect(summary.similarities).toHaveLength(1);
      expect(summary.similarities[0].similarity).toBeGreaterThan(0);
      expect(summary.recommendation).toBeTruthy();
    });

    test('handles all failures', () => {
      const entries = [
        { model: 'a', content: '', latencyMs: 0, totalMs: 0, failed: true, error: 'fail' },
        { model: 'b', content: '', latencyMs: 0, totalMs: 0, failed: true, error: 'fail' },
      ];

      const summary = generateArenaSummary('test', entries);
      expect(summary.successCount).toBe(0);
      expect(summary.failedCount).toBe(2);
    });
  });

  describe('formatArenaResult()', () => {
    test('formats result as readable string', () => {
      const result = {
        arenaId: 'arena-test',
        prompt: 'Test prompt',
        entries: [
          { model: 'a', content: 'Response A', latencyMs: 100, totalMs: 500, failed: false },
          { model: 'b', content: 'Response B', latencyMs: 200, totalMs: 800, failed: false },
        ],
        summary: generateArenaSummary('test', [
          { model: 'a', content: 'Response A', latencyMs: 100, totalMs: 500, usage: null, failed: false },
          { model: 'b', content: 'Response B', latencyMs: 200, totalMs: 800, usage: null, failed: false },
        ]),
        totalMs: 900,
      };

      const output = formatArenaResult(result);
      expect(output).toContain('Arena Results');
      expect(output).toContain('arena-test');
      expect(output).toContain('a');
      expect(output).toContain('b');
    });
  });
});
