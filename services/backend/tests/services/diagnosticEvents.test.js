'use strict';

/**
 * Tests for diagnosticEvents.js — DiagnosticEventEmitter,
 * event emission, listener management, and attention tracking.
 */

const {
  DiagnosticEventEmitter,
  generateTraceId,
  generateSpanId,
  ATTENTION_LONG_RUNNING_MS,
  ATTENTION_STALLED_MS,
  MAX_EVENT_BUFFER,
  FLUSH_INTERVAL_MS,
} = require('../../src/services/diagnosticEvents');

afterEach(() => {
  // Clean up any global timers left by emitters
  jest.restoreAllMocks();
});

describe('generateTraceId / generateSpanId', () => {
  test('generateTraceId returns 32-char hex string', () => {
    const id = generateTraceId();
    expect(id).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
  });

  test('generateSpanId returns 16-char hex string', () => {
    const id = generateSpanId();
    expect(id).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(id)).toBe(true);
  });

  test('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('DiagnosticEventEmitter — emit', () => {
  test('emits event with correct structure', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const event = emitter.emit('test_type', { key: 'value' });

    expect(event.type).toBe('test_type');
    expect(event.seq).toBeGreaterThan(0);
    expect(event.traceId).toHaveLength(32);
    expect(event.spanId).toHaveLength(16);
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.data).toEqual({ key: 'value' });
    expect(event.attention).toBeNull();

    emitter.shutdown();
  });

  test('uses provided traceId from context', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const event = emitter.emit('test', {}, { traceId: 'abc123' });
    expect(event.traceId).toBe('abc123');
    expect(event.requestId).toBe('abc123');
    emitter.shutdown();
  });

  test('uses explicit requestId from context when provided', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const event = emitter.emit('test', {}, { traceId: 'abc123', requestId: 'req-001' });
    expect(event.traceId).toBe('abc123');
    expect(event.requestId).toBe('req-001');
    emitter.shutdown();
  });

  test('buffers events', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    emitter.emit('a', {});
    emitter.emit('b', {});
    expect(emitter.getBuffer()).toHaveLength(2);
    emitter.shutdown();
  });
});

describe('DiagnosticEventEmitter — listeners', () => {
  test('notifies type-specific listeners', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const handler = jest.fn();
    emitter.on('tool_call', handler);
    emitter.emit('tool_call', { name: 'bash' });
    emitter.emit('other_type', {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].data.name).toBe('bash');
    emitter.shutdown();
  });

  test('wildcard listener receives all events', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const handler = jest.fn();
    emitter.on('*', handler);
    emitter.emit('type_a', {});
    emitter.emit('type_b', {});
    expect(handler).toHaveBeenCalledTimes(2);
    emitter.shutdown();
  });

  test('unsubscribe function removes listener', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const handler = jest.fn();
    const unsub = emitter.on('test', handler);
    emitter.emit('test', {});
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    emitter.emit('test', {});
    expect(handler).toHaveBeenCalledTimes(1);
    emitter.shutdown();
  });
});

describe('DiagnosticEventEmitter — tool call/result', () => {
  test('emitToolCall returns spanId and tracks active span', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const spanId = emitter.emitToolCall('bash', { command: 'ls' });
    expect(typeof spanId).toBe('string');
    expect(spanId.length).toBe(16);
    emitter.shutdown();
  });

  test('emitToolResult links to tool call span', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const spanId = emitter.emitToolCall('bash', {});
    const event = emitter.emitToolResult(spanId, { output: 'ok' }, null);
    expect(event.data.toolName).toBe('bash');
    expect(event.data.success).toBe(true);
    expect(event.data.durationMs).toBeGreaterThanOrEqual(0);
    emitter.shutdown();
  });

  test('emitToolResult marks error', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    const spanId = emitter.emitToolCall('bash', {});
    const event = emitter.emitToolResult(spanId, null, new Error('command failed'));
    expect(event.data.success).toBe(false);
    expect(event.data.error).toContain('command failed');
    emitter.shutdown();
  });
});

describe('DiagnosticEventEmitter — flush and buffer', () => {
  test('flush clears buffer and returns events', () => {
    const onFlush = jest.fn();
    const emitter = new DiagnosticEventEmitter({ onFlush, flushIntervalMs: 999999 });
    emitter.emit('a', {});
    emitter.emit('b', {});

    const flushed = emitter.flush();
    expect(flushed).toHaveLength(2);
    expect(emitter.getBuffer()).toHaveLength(0);
    expect(onFlush).toHaveBeenCalledWith(expect.any(Array));
    emitter.shutdown();
  });

  test('auto-flushes when buffer reaches maxBuffer', () => {
    const onFlush = jest.fn();
    const emitter = new DiagnosticEventEmitter({
      onFlush,
      maxBuffer: 3,
      flushIntervalMs: 999999,
    });

    emitter.emit('a', {});
    emitter.emit('b', {});
    expect(onFlush).not.toHaveBeenCalled();

    emitter.emit('c', {}); // hits maxBuffer
    expect(onFlush).toHaveBeenCalled();
    emitter.shutdown();
  });
});

describe('DiagnosticEventEmitter — getSummary', () => {
  test('returns summary statistics', () => {
    const emitter = new DiagnosticEventEmitter({ flushIntervalMs: 999999 });
    emitter.emit('tool_call', {});
    emitter.emit('tool_result', { durationMs: 100, error: null });
    emitter.emit('tool_result', { durationMs: 200, error: 'fail' });
    emitter.emit('error', {});

    const summary = emitter.getSummary();
    expect(summary.eventCount).toBe(4);
    expect(summary.byType.tool_call).toBe(1);
    expect(summary.byType.tool_result).toBe(2);
    expect(summary.byType.error).toBe(1);
    expect(summary.toolCalls).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.avgToolDurationMs).toBe(150);
    emitter.shutdown();
  });
});

describe('constants', () => {
  test('ATTENTION_LONG_RUNNING_MS is 30000', () => {
    expect(ATTENTION_LONG_RUNNING_MS).toBe(30000);
  });

  test('ATTENTION_STALLED_MS is 120000', () => {
    expect(ATTENTION_STALLED_MS).toBe(120000);
  });

  test('MAX_EVENT_BUFFER is 500', () => {
    expect(MAX_EVENT_BUFFER).toBe(500);
  });
});
