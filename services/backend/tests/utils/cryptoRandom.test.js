'use strict';

const {
  randomBytes,
  randomHex,
  randomBase64,
  randomUUID,
  randomInt,
  randomString,
  generateToken,
  generateId,
} = require('../../src/utils/cryptoRandom');

describe('cryptoRandom', () => {
  test('randomBytes returns buffer of correct length', () => {
    const result = randomBytes(32);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(32);
  });

  test('randomHex returns hex string of correct length', () => {
    const result = randomHex(16);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  test('randomBase64 returns base64 string', () => {
    const result = randomBase64(16);
    expect(result).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test('randomUUID returns valid UUID v4', () => {
    const result = randomUUID();
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('randomInt returns value in range', () => {
    for (let i = 0; i < 100; i++) {
      const result = randomInt(10, 20);
      expect(result).toBeGreaterThanOrEqual(10);
      expect(result).toBeLessThan(20);
    }
  });

  test('randomInt throws for invalid range', () => {
    expect(() => randomInt(10, 5)).toThrow();
    expect(() => randomInt(10, 10)).toThrow();
  });

  test('randomString returns string of correct length', () => {
    const result = randomString(32);
    expect(result.length).toBe(32);
  });

  test('randomString uses custom alphabet', () => {
    const result = randomString(10, 'abc');
    expect(result).toMatch(/^[abc]{10}$/);
  });

  test('generateToken returns 64 char hex', () => {
    const result = generateToken();
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test('generateId returns 16 char hex', () => {
    const result = generateId();
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });
});
