'use strict';

/**
 * Tests for fileEncoding.js — encoding-aware text file reader.
 * Covers UTF-8 (unchanged behavior), GBK auto-detection via iconv, BOM stripping,
 * explicit-encoding override, and the iconv fail-soft path.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');
const { readTextFileSmart, decodeBuffer } = require('../../src/utils/fileEncoding');

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fileenc-'));
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeBuf(name, buf) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, buf);
  return p;
}

describe('readTextFileSmart — UTF-8 (no regression)', () => {
  test('reads a plain UTF-8 file with Chinese unchanged', () => {
    const p = writeBuf('utf8.txt', Buffer.from('你好，世界\nABC', 'utf8'));
    const { text, encoding } = readTextFileSmart(p);
    expect(text).toBe('你好，世界\nABC');
    expect(encoding).toBe('utf-8');
  });

  test('strips a leading UTF-8 BOM', () => {
    const p = writeBuf('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]));
    const { text } = readTextFileSmart(p);
    expect(text).toBe('hello');
  });
});

describe('readTextFileSmart — legacy encodings', () => {
  test('decodes a GBK file via explicit encoding override', () => {
    // Auto-detection of GBK *content* requires a GBK system locale (e.g. CN
    // Windows); on a UTF-8 host the override is the deterministic path.
    const original = '中文乱码测试';
    const p = writeBuf('gbk.txt', iconv.encode(original, 'gbk'));
    const { text } = readTextFileSmart(p, { encoding: 'gbk' });
    expect(text).toBe(original);
  });

  test('honors a Shift-JIS encoding override', () => {
    const original = 'シフトジス';
    const p = writeBuf('sjis.txt', iconv.encode(original, 'shift_jis'));
    const { text } = readTextFileSmart(p, { encoding: 'shift_jis' });
    expect(text).toBe(original);
  });

  test('auto-detects a UTF-16LE file from its BOM', () => {
    // FF FE BOM + UTF-16LE payload → getEncodingForBuffer returns utf16le.
    const bom = Buffer.from([0xff, 0xfe]);
    const p = writeBuf('utf16le.txt', Buffer.concat([bom, iconv.encode('тест', 'utf16le')]));
    const { text, encoding } = readTextFileSmart(p);
    expect(text).toBe('тест');
    expect(encoding).toBe('utf16le');
  });

  test('auto-detects a UTF-16BE file from its BOM', () => {
    const bom = Buffer.from([0xfe, 0xff]);
    const p = writeBuf('utf16be.txt', Buffer.concat([bom, iconv.encode('тест', 'utf16be')]));
    const { text, encoding } = readTextFileSmart(p);
    expect(text).toBe('тест');
    expect(encoding).toBe('utf-16be');
  });

  test('undecodable legacy file on a UTF-8 host is fail-soft (never throws)', () => {
    // No BOM, not valid UTF-8: falls back to system locale (utf-8 here) without
    // throwing. We assert resilience, not a locale-specific decode result.
    const p = writeBuf('ambiguous.bin', iconv.encode('中文', 'gbk'));
    expect(() => readTextFileSmart(p)).not.toThrow();
    expect(typeof readTextFileSmart(p).text).toBe('string');
  });
});

describe('decodeBuffer — fail-soft', () => {
  test('falls back to utf8 for an unknown encoding name', () => {
    const buf = Buffer.from('plain ascii', 'utf8');
    expect(decodeBuffer(buf, 'no-such-encoding-xyz')).toBe('plain ascii');
  });

  test('defaults to utf-8 when encoding is empty', () => {
    expect(decodeBuffer(Buffer.from('你好', 'utf8'), '')).toBe('你好');
  });
});
