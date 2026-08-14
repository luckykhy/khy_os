'use strict';

/**
 * Tests for rateLimiter.js — fixed-window rate limiter and keyed rate limiter.
 */

const {
  createFixedWindowRateLimiter,
  createKeyedRateLimiter,
} = require('../../src/services/rateLimiter');

describe('createFixedWindowRateLimiter', () => {
  test('allows requests within limit', () => {
    let time = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 3,
      windowMs: 1000,
      now: () => time,
    });

    const r1 = limiter.consume();
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.consume();
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.consume();
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  test('blocks requests beyond limit', () => {
    let time = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: () => time,
    });

    limiter.consume();
    limiter.consume();
    const r3 = limiter.consume();
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.retryAfterMs).toBeGreaterThan(0);
  });

  test('resets after window expires', () => {
    let time = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: () => time,
    });

    limiter.consume(); // use up the quota
    const blocked = limiter.consume();
    expect(blocked.allowed).toBe(false);

    // Advance past window
    time = 1001;
    const allowed = limiter.consume();
    expect(allowed.allowed).toBe(true);
  });

  test('retryAfterMs reflects remaining window time', () => {
    let time = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 5000,
      now: () => time,
    });

    limiter.consume();
    time = 2000; // 2s into window
    const r = limiter.consume();
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(3000);
  });

  test('reset clears counter', () => {
    let time = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 60000,
      now: () => time,
    });

    limiter.consume();
    limiter.reset();
    const r = limiter.consume();
    expect(r.allowed).toBe(true);
  });

  test('getState returns diagnostics', () => {
    let time = 100;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 5,
      windowMs: 1000,
      now: () => time,
    });
    limiter.consume();
    limiter.consume();

    const state = limiter.getState();
    expect(state.count).toBe(2);
    expect(state.remaining).toBe(3);
    expect(state.maxRequests).toBe(5);
    expect(state.windowMs).toBe(1000);
  });
});

describe('createKeyedRateLimiter', () => {
  test('tracks separate limits per key', () => {
    let time = 0;
    const limiter = createKeyedRateLimiter({
      maxRequests: 1,
      windowMs: 10000,
      now: () => time,
    });

    expect(limiter.consume('keyA').allowed).toBe(true);
    expect(limiter.consume('keyA').allowed).toBe(false);
    expect(limiter.consume('keyB').allowed).toBe(true); // different key
  });

  test('reset with key clears only that key', () => {
    let time = 0;
    const limiter = createKeyedRateLimiter({
      maxRequests: 1,
      windowMs: 60000,
      now: () => time,
    });

    limiter.consume('a');
    limiter.consume('b');
    limiter.reset('a');

    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('b').allowed).toBe(false);
  });

  test('reset without key clears all', () => {
    let time = 0;
    const limiter = createKeyedRateLimiter({
      maxRequests: 1,
      windowMs: 60000,
      now: () => time,
    });

    limiter.consume('a');
    limiter.consume('b');
    limiter.reset();

    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('b').allowed).toBe(true);
  });
});
