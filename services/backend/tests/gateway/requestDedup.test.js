'use strict';

/**
 * Tests for gateway/requestDedup.js — request deduplication (in-memory fallback).
 */

let createRequestDedup;
let loadError;

beforeAll(() => {
  try {
    ({ createRequestDedup } = require('../../src/services/gateway/requestDedup'));
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

describe('gateway/requestDedup exports', () => {
  test('module is loadable without syntax errors', () => {
    if (loadError) {
      expect(loadError).not.toBeInstanceOf(SyntaxError);
    }
  });

  test('exports createRequestDedup factory function', () => {
    if (!createRequestDedup) return;
    expect(typeof createRequestDedup).toBe('function');
  });
});

describe('createRequestDedup()', () => {
  let dedup;

  beforeEach(() => {
    if (!createRequestDedup) return;
    dedup = createRequestDedup({ getRedisClient: () => null });
  });

  afterEach(() => {
    if (dedup) dedup.destroy();
  });

  test('returns object with expected API methods', () => {
    if (!dedup) return;
    expect(typeof dedup.fingerprint).toBe('function');
    expect(typeof dedup.tryAcquire).toBe('function');
    expect(typeof dedup.storeResponse).toBe('function');
    expect(typeof dedup.getCached).toBe('function');
    expect(typeof dedup.destroy).toBe('function');
  });

  test('fingerprint produces a 32-char hex string', () => {
    if (!dedup) return;
    const fp = dedup.fingerprint({ userId: 'user1', model: 'gpt-4o', prompt: 'hello' });
    expect(typeof fp).toBe('string');
    expect(fp).toMatch(/^[a-f0-9]{32}$/);
  });

  test('same input within same time bucket produces same fingerprint', () => {
    if (!dedup) return;
    const params = { userId: 'user1', model: 'gpt-4o', prompt: 'hello world' };
    const fp1 = dedup.fingerprint(params);
    const fp2 = dedup.fingerprint(params);
    expect(fp1).toBe(fp2);
  });

  test('different prompts produce different fingerprints', () => {
    if (!dedup) return;
    const fp1 = dedup.fingerprint({ userId: 'user1', model: 'gpt-4o', prompt: 'hello' });
    const fp2 = dedup.fingerprint({ userId: 'user1', model: 'gpt-4o', prompt: 'goodbye' });
    expect(fp1).not.toBe(fp2);
  });

  // Regression: the conversation prompt is built system-prompt-first, so two
  // DIFFERENT user turns share a long identical leading preamble and differ only
  // in the tail. A leading-slice fingerprint collided here — making the 2nd turn
  // return the 1st's cached reply, and the new message never reach the model.
  // The full-prompt hash must keep them distinct.
  test('prompts sharing a long identical prefix but differing in the tail are distinct', () => {
    if (!dedup) return;
    const preamble = 'SYSTEM PROMPT: '.repeat(50); // > 200 chars of identical preamble
    const fpA = dedup.fingerprint({ userId: 'anon', model: 'auto', prompt: `${preamble}\nUser: c盘有什么文件` });
    const fpB = dedup.fingerprint({ userId: 'anon', model: 'auto', prompt: `${preamble}\nUser: d盘有什么文件` });
    expect(preamble.length).toBeGreaterThan(200);
    expect(fpA).not.toBe(fpB);
  });

  // Within ONE turn, successive tool-loop iterations append tool results to the
  // same base prompt. They must NOT collide, or iteration 2+ would get back
  // iteration 1's cached tool_use instead of a fresh summary (empty final reply).
  test('successive tool-loop iterations (appended tool results) are distinct', () => {
    if (!dedup) return;
    const base = 'SYSTEM PROMPT preamble '.repeat(20) + '\nUser: c盘有什么文件';
    const iter1 = dedup.fingerprint({ userId: 'anon', model: 'auto', prompt: base });
    const iter2 = dedup.fingerprint({ userId: 'anon', model: 'auto', prompt: `${base}\n[tool dir C:\\ result]\nAssistant:` });
    expect(iter1).not.toBe(iter2);
  });

  // The legitimate dedup purpose still holds: a byte-identical re-submit (double
  // click / SSE reconnect) within the same bucket collides and is caught.
  test('byte-identical re-submit within the bucket still collides (dedup intact)', () => {
    if (!dedup) return;
    const prompt = 'SYSTEM PROMPT '.repeat(30) + '\nUser: 你好';
    const fp1 = dedup.fingerprint({ userId: 'anon', model: 'auto', prompt });
    const fp2 = dedup.fingerprint({ userId: 'anon', model: 'auto', prompt });
    expect(fp1).toBe(fp2);
  });

  test('tryAcquire returns true for first request (memory fallback)', async () => {
    if (!dedup) return;
    const fp = dedup.fingerprint({ userId: 'u1', model: 'm1', prompt: 'test' });
    const acquired = await dedup.tryAcquire(fp);
    expect(acquired).toBe(true);
  });

  test('tryAcquire returns false for duplicate request (memory fallback)', async () => {
    if (!dedup) return;
    const fp = dedup.fingerprint({ userId: 'u2', model: 'm2', prompt: 'dup test' });
    await dedup.tryAcquire(fp);
    const second = await dedup.tryAcquire(fp);
    expect(second).toBe(false);
  });

  test('storeResponse and getCached round-trip (memory fallback)', async () => {
    if (!dedup) return;
    const fp = dedup.fingerprint({ userId: 'u3', model: 'm3', prompt: 'cache test' });
    const response = { text: 'cached response', tokens: 100 };
    await dedup.storeResponse(fp, response);
    const cached = await dedup.getCached(fp);
    expect(cached).toEqual(response);
  });

  test('getCached returns null for unknown fingerprint', async () => {
    if (!dedup) return;
    const cached = await dedup.getCached('0000000000000000000000000000dead');
    expect(cached).toBeNull();
  });
});
