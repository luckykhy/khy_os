'use strict';

const {
  parseSubscriptionUserinfo,
  isEnabled,
} = require('../../src/services/subscriptionUserinfo');

describe('subscriptionUserinfo', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns false when flag is off', () => {
      expect(isEnabled({ KHY_PROXY_SUB_USERINFO: '0' })).toBe(false);
    });

    test('returns false when parent flag is off', () => {
      expect(isEnabled({ KHY_PROXY_SUBSCRIPTION: '0' })).toBe(false);
    });
  });

  describe('parseSubscriptionUserinfo', () => {
    test('parses valid header', () => {
      const result = parseSubscriptionUserinfo('upload=1024; download=2048; total=100000; expire=1710000000', {});
      expect(result.upload).toBe(1024);
      expect(result.download).toBe(2048);
      expect(result.total).toBe(100000);
      expect(result.used).toBe(3072);
      expect(result.remaining).toBe(96928);
    });

    test('calculates used ratio', () => {
      const result = parseSubscriptionUserinfo('upload=500; download=500; total=1000', {});
      expect(result.usedRatio).toBe(1);
    });

    test('calculates expire days', () => {
      const nowMs = 1700000000000;
      const expireSec = Math.floor(nowMs / 1000) + 86400 * 30; // 30 days from now
      const result = parseSubscriptionUserinfo(`expire=${expireSec}`, {}, { nowMs });
      expect(result.expireDays).toBe(30);
    });

    test('returns null for empty header', () => {
      expect(parseSubscriptionUserinfo('', {})).toBeNull();
    });

    test('returns null when disabled', () => {
      expect(parseSubscriptionUserinfo('upload=1024', { KHY_PROXY_SUB_USERINFO: '0' })).toBeNull();
    });

    test('returns null for invalid header', () => {
      expect(parseSubscriptionUserinfo('invalid data without equals', {})).toBeNull();
    });

    test('handles partial fields', () => {
      const result = parseSubscriptionUserinfo('upload=1024', {});
      expect(result.upload).toBe(1024);
      expect(result.download).toBeNull();
      expect(result.total).toBeNull();
    });

    test('caps usedRatio at 1', () => {
      const result = parseSubscriptionUserinfo('upload=1000; download=1000; total=1000', {});
      expect(result.usedRatio).toBe(1);
    });
  });
});
