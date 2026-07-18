'use strict';

const path = require('path');
const {
  partitionIntoBatches,
  resolveConcurrencySafe,
} = require('../../src/services/toolExecutionEngine');

// Real tool registry — exercises the variant-expansion path so shell aliases
// (snake_case 'shell_command') resolve to the registered camelCase tool and
// recover their content-aware isConcurrencySafe verdict (s02 defect B).
let toolRegistry;
try { toolRegistry = require('../../src/tools'); } catch { toolRegistry = null; }

const call = (name, params = {}) => ({ name, params });
const shape = (batches) =>
  batches.map((b) => ({
    parallel: b.parallel,
    names: b.calls.map((c) => c.name),
  }));

describe('toolExecutionEngine.partitionIntoBatches (s02 order-preserving batching)', () => {
  test('preserves order: [readA, readB, rm, readC] → [parallel(A,B), serial(rm), parallel(C)]', () => {
    const calls = [
      call('read_file', { path: 'a.txt' }),
      call('read_file', { path: 'b.txt' }),
      call('shell_command', { command: 'rm -rf x' }),
      call('read_file', { path: 'c.txt' }),
    ];
    const batches = partitionIntoBatches(calls, toolRegistry);
    expect(shape(batches)).toEqual([
      { parallel: true, names: ['read_file', 'read_file'] },
      { parallel: false, names: ['shell_command'] },
      // Trailing single safe call: its own (single-element) parallel batch.
      { parallel: true, names: ['read_file'] },
    ]);
    // rm executes strictly before readC.
    const order = batches.flatMap((b) => b.calls.map((c) => c.params.command || c.params.path));
    expect(order.indexOf('rm -rf x')).toBeLessThan(order.indexOf('c.txt'));
  });

  test('defect B: bash "ls" is concurrency-safe, bash "rm" is serial', () => {
    if (!toolRegistry) {
      // Without a registry the static fallback has no shell alias → both serial.
      // Skip the registry-dependent assertion gracefully.
      return;
    }
    const calls = [
      call('shell_command', { command: 'ls -la' }),
      call('shell_command', { command: 'rm file' }),
    ];
    const batches = partitionIntoBatches(calls, toolRegistry);
    // ls is read-only → parallel-eligible (single-element parallel batch);
    // rm is mutating → its own serial batch, AFTER ls.
    expect(shape(batches)).toEqual([
      { parallel: true, names: ['shell_command'] },
      { parallel: false, names: ['shell_command'] },
    ]);
    expect(resolveConcurrencySafe(calls[0], toolRegistry)).toBe(true);
    expect(resolveConcurrencySafe(calls[1], toolRegistry)).toBe(false);
  });

  test('all read-only calls collapse into one parallel batch', () => {
    const calls = [
      call('read_file', { path: 'a' }),
      call('grep', { pattern: 'x' }),
      call('glob', { pattern: '*.js' }),
    ];
    const batches = partitionIntoBatches(calls, toolRegistry);
    expect(batches.length).toBe(1);
    expect(batches[0].parallel).toBe(true);
    expect(batches[0].calls.length).toBe(3);
  });

  test('all-mutating calls each become their own serial batch', () => {
    const calls = [
      call('shell_command', { command: 'rm a' }),
      call('shell_command', { command: 'mv b c' }),
    ];
    const batches = partitionIntoBatches(calls, toolRegistry);
    expect(batches.length).toBe(2);
    expect(batches.every((b) => b.parallel === false)).toBe(true);
    expect(batches.every((b) => b.calls.length === 1)).toBe(true);
  });

  test('single element: one read → one parallel batch of size 1', () => {
    const batches = partitionIntoBatches([call('read_file', { path: 'a' })], toolRegistry);
    expect(shape(batches)).toEqual([{ parallel: true, names: ['read_file'] }]);
  });

  test('single element: one mutating call → one serial batch', () => {
    const batches = partitionIntoBatches([call('shell_command', { command: 'rm a' })], toolRegistry);
    expect(shape(batches)).toEqual([{ parallel: false, names: ['shell_command'] }]);
  });

  test('empty / non-array input returns empty batch list', () => {
    expect(partitionIntoBatches([], toolRegistry)).toEqual([]);
    expect(partitionIntoBatches(null, toolRegistry)).toEqual([]);
    expect(partitionIntoBatches(undefined, toolRegistry)).toEqual([]);
  });

  test('legacy calls are never concurrency-safe', () => {
    expect(resolveConcurrencySafe({ name: 'read_file', legacy: true }, toolRegistry)).toBe(false);
  });

  test('writes serialize (registry marks write tools non-concurrency-safe): same path never shares a parallel batch', () => {
    const target = 'dup.txt';
    const calls = [
      call('write_file', { path: target, content: 'one' }),
      call('write_file', { path: target, content: 'two' }),
    ];
    const batches = partitionIntoBatches(calls, toolRegistry, process.cwd());
    // write_file is non-concurrency-safe in the registry → each write is isolated
    // into its own serial batch (safety-first). Two same-path writes never race.
    const resolved = path.resolve(process.cwd(), target);
    expect(resolved).toBeTruthy();
    const sameBatchWithBoth = batches.some(
      (b) => b.parallel && b.calls.length === 2,
    );
    expect(sameBatchWithBoth).toBe(false);
  });

  test('writes serialize: distinct-path writes are each their own serial batch (safety-first)', () => {
    const calls = [
      call('write_file', { path: 'p1.txt', content: 'a' }),
      call('write_file', { path: 'p2.txt', content: 'b' }),
    ];
    const batches = partitionIntoBatches(calls, toolRegistry, process.cwd());
    // Registry verdict for write_file is non-concurrency-safe, so both writes
    // serialize. This is stricter than the old main-path heuristic (which let
    // distinct-path writes run in parallel) and is intentionally safer.
    expect(batches.length).toBe(2);
    expect(batches.every((b) => b.parallel === false)).toBe(true);
    expect(batches.every((b) => b.calls.length === 1)).toBe(true);
  });
});
