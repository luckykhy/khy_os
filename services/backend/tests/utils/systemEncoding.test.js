'use strict';

/**
 * Tests for systemEncoding.getEncodingForBuffer — the deterministic, platform-
 * independent buffer sniffing path. getSystemEncoding() is OS/locale-dependent and
 * exercised indirectly by the spawn encoding tests.
 */

const { getEncodingForBuffer } = require('../../src/utils/systemEncoding');

describe('getEncodingForBuffer', () => {
  test('detects a UTF-16LE BOM', () => {
    expect(getEncodingForBuffer(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe('utf16le');
  });

  test('detects a UTF-8 BOM', () => {
    expect(getEncodingForBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8');
  });

  test('classifies valid UTF-8 (multibyte) as utf-8', () => {
    expect(getEncodingForBuffer(Buffer.from('你好世界', 'utf8'))).toBe('utf-8');
  });

  test('classifies pure ASCII as utf-8', () => {
    expect(getEncodingForBuffer(Buffer.from('hello world', 'utf8'))).toBe('utf-8');
  });

  test('returns a non-empty encoding name for invalid-UTF-8 bytes (system fallback)', () => {
    // GBK-encoded Chinese is not valid UTF-8 → must reach the system-encoding
    // fallback branch and still yield a usable encoding name (never throws/empty).
    const invalidUtf8 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // GBK "中文"
    const enc = getEncodingForBuffer(invalidUtf8);
    expect(typeof enc).toBe('string');
    expect(enc.length).toBeGreaterThan(0);
  });
});
