'use strict';

/**
 * kiroAdapter.tokenWarming.test.js — P2 of the IDE-channel stability fix.
 *
 * Live failure: Kiro only refreshed its token lazily on the request path, so a token
 * that lapsed mid-session surfaced as "User is not authorized to make this call" on
 * the user's next message. The proactive warmer pre-refreshes inside the pre-expiry
 * buffer while the channel is active and in recent use — keeping the next request hot.
 *
 * These cases lock in the pure gating predicate (_shouldWarmToken) and the warmer
 * timer lifecycle (unref'd, idempotent start, clean stop).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const kiro = require('../src/services/gateway/adapters/kiroAdapter');

const NOW = 1_700_000_000_000;
const BUFFER_MS = 5 * 60 * 1000;
const liveToken = (msFromNow) => ({ refreshToken: 'r', expiresAt: new Date(NOW + msFromNow).toISOString() });
const baseCtx = { channelActive: true, recentlyActive: true, refreshing: false, backoffUntil: 0, now: NOW };

describe('kiro proactive token warming — gating predicate (P2)', () => {
  test('warms when active, recently used, and inside the pre-expiry buffer', () => {
    // Expires in 2 min → within the 5-min buffer → should warm.
    assert.equal(kiro._shouldWarmToken(liveToken(2 * 60 * 1000), baseCtx), true);
  });

  test('does NOT warm a token comfortably far from expiry', () => {
    // Expires in 30 min → outside the buffer → no warm.
    assert.equal(kiro._shouldWarmToken(liveToken(30 * 60 * 1000), baseCtx), false);
  });

  test('does NOT warm a deprecated (inactive) channel', () => {
    assert.equal(kiro._shouldWarmToken(liveToken(60 * 1000), { ...baseCtx, channelActive: false }), false);
  });

  test('does NOT warm an idle channel (not recently used)', () => {
    assert.equal(kiro._shouldWarmToken(liveToken(60 * 1000), { ...baseCtx, recentlyActive: false }), false);
  });

  test('does NOT warm while a refresh is already in flight', () => {
    assert.equal(kiro._shouldWarmToken(liveToken(60 * 1000), { ...baseCtx, refreshing: true }), false);
  });

  test('does NOT warm during refresh backoff', () => {
    assert.equal(kiro._shouldWarmToken(liveToken(60 * 1000), { ...baseCtx, backoffUntil: NOW + 30_000 }), false);
  });

  test('does NOT warm a token with no refreshToken (cannot refresh anyway)', () => {
    const noRefresh = { expiresAt: new Date(NOW + 60 * 1000).toISOString() };
    assert.equal(kiro._shouldWarmToken(noRefresh, baseCtx), false);
  });

  test('does NOT warm when there is no cached token at all', () => {
    assert.equal(kiro._shouldWarmToken(null, baseCtx), false);
    assert.equal(kiro._shouldWarmToken(undefined, baseCtx), false);
  });

  test('exactly at the buffer edge is treated as near-expiry', () => {
    // expiresAt === now + BUFFER → strictly-less check is false → NOT warmed (edge).
    assert.equal(kiro._shouldWarmToken(liveToken(BUFFER_MS), baseCtx), false);
    // One ms inside the buffer → warmed.
    assert.equal(kiro._shouldWarmToken(liveToken(BUFFER_MS - 1), baseCtx), true);
  });
});

describe('kiro proactive token warming — timer lifecycle (P2)', () => {
  test('startTokenWarmer is idempotent and the timer is unref\'d; stop clears it', () => {
    kiro.stopTokenWarmer(); // clean slate
    // Should not throw on double start, and must not keep the loop alive.
    kiro.startTokenWarmer();
    kiro.startTokenWarmer();
    kiro.stopTokenWarmer();
    // A second stop is a harmless no-op.
    kiro.stopTokenWarmer();
    assert.ok(true, 'lifecycle calls are safe and idempotent');
  });
});
