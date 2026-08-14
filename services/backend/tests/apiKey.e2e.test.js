'use strict';

/**
 * API Key E2E Tests — verify unified hash contract.
 */

const { hashApiKey, extractPrefix, generateKey } = require('@khy/shared/utils/apiKeyHash');

describe('API Key Hash Contract', () => {
  test('hashApiKey produces consistent SHA-256 hex', () => {
    const key = 'khy_abc123def456';
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 = 64 hex chars
  });

  test('hashApiKey handles empty/null input', () => {
    expect(hashApiKey('')).toHaveLength(64);
    expect(hashApiKey(null)).toHaveLength(64);
    expect(hashApiKey(undefined)).toHaveLength(64);
    // All should hash the empty string consistently
    expect(hashApiKey('')).toBe(hashApiKey(null));
  });

  test('extractPrefix returns first 12 chars', () => {
    const key = 'khy_abcdefghijklmnop';
    expect(extractPrefix(key)).toBe('khy_abcdefgh');
    expect(extractPrefix('')).toBe('');
    expect(extractPrefix(null)).toBe('');
  });

  test('generateKey produces khy_ prefix with 48 hex chars', () => {
    const key = generateKey();
    expect(key).toMatch(/^khy_[a-f0-9]{48}$/);
    // Each call produces a unique key
    expect(generateKey()).not.toBe(key);
  });

  test('different keys produce different hashes', () => {
    const k1 = generateKey();
    const k2 = generateKey();
    expect(hashApiKey(k1)).not.toBe(hashApiKey(k2));
  });
});
