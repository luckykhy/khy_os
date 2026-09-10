'use strict';
// Unit tests for the file-read-limit pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).
const frl = require('../../src/tools/fileReadLimit');
const ON = {}; // 默认开
const OFF = { KHY_FILE_READ_LIMIT: '0' };
// ── 门控梯 ──────────────────────────────────────────────────────────────────
// ── resolveMaxBytes ────────────────────────────────────────────────────────
// ── resolveMaxLines ────────────────────────────────────────────────────────
// ── partialOnOversizeEnabled ───────────────────────────────────────────────
// ── buildOversizeNotice ────────────────────────────────────────────────────

describe('File Read Limit', () => {
  test('isEnabled: 默认开', () => {
      expect(frl.isEnabled(ON)).toBe(true);
      expect(frl.isEnabled(undefined)).toBe(true);
  });

  test('isEnabled: 0/false/off/no → 关', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
        expect(frl.isEnabled({ KHY_FILE_READ_LIMIT: v })).toBe(false);
      }
  });

  test('resolveMaxBytes: 门控开 → 2MB 默认', () => {
      expect(frl.resolveMaxBytes(ON, 500 * 1024)).toBe(frl.DEFAULT_MAX_BYTES);
  });

  test('resolveMaxBytes: 门控开 + env 覆盖', () => {
      expect(frl.resolveMaxBytes({ KHY_FILE_READ_MAX_BYTES: '1048576' }, 500 * 1024)).toBe(1048576);
  });

  test('resolveMaxBytes: 门控关 → 回退 call-site legacy', () => {
      expect(frl.resolveMaxBytes(OFF, 500 * 1024)).toBe(500 * 1024);
      expect(frl.resolveMaxBytes(OFF, 123456)).toBe(123456);
  });

  test('resolveMaxBytes: legacy 缺省/非法 → 内置 500KB', () => {
      expect(frl.resolveMaxBytes(OFF)).toBe(frl.LEGACY_MAX_BYTES);
      expect(frl.resolveMaxBytes(OFF, -1)).toBe(frl.LEGACY_MAX_BYTES);
      expect(frl.resolveMaxBytes(OFF, NaN)).toBe(frl.LEGACY_MAX_BYTES);
  });

  test('resolveMaxBytes: 门控开但 env 覆盖非法 → 2MB 默认', () => {
      expect(frl.resolveMaxBytes({ KHY_FILE_READ_MAX_BYTES: 'abc' }, 500 * 1024)).toBe(frl.DEFAULT_MAX_BYTES);
      expect(frl.resolveMaxBytes({ KHY_FILE_READ_MAX_BYTES: '0' }, 500 * 1024)).toBe(frl.DEFAULT_MAX_BYTES);
  });

  test('resolveMaxLines: 门控开 → 5000 默认;env 覆盖;门控关 → legacy', () => {
      expect(frl.resolveMaxLines(ON, 2000)).toBe(frl.DEFAULT_MAX_LINES);
      expect(frl.resolveMaxLines({ KHY_FILE_READ_MAX_LINES: '8000' }, 2000)).toBe(8000);
      expect(frl.resolveMaxLines(OFF, 2000)).toBe(2000);
      expect(frl.resolveMaxLines(OFF, 999)).toBe(999);
  });

  test('partialOnOversizeEnabled: 跟随门控', () => {
      expect(frl.partialOnOversizeEnabled(ON)).toBe(true);
      expect(frl.partialOnOversizeEnabled(OFF)).toBe(false);
  });

  test('buildOversizeNotice: 含总字节、上限与续读路径', () => {
      const s = frl.buildOversizeNotice({ totalBytes: 3000000, maxBytes: 2097152 });
      expect(s).toMatch(/3000000 字节/);
      expect(s).toMatch(/2097152 字节/);
      expect(s).toMatch(/offset\/limit/);
      expect(s).toMatch(/KHY_FILE_READ_MAX_BYTES/);
  });

  test('buildOversizeNotice: 防呆缺参不抛', () => {
      const s = frl.buildOversizeNotice({});
      expect(s).toMatch(/较大/);
      expect(typeof s === 'string' && s.length > 0).toBeTruthy();
  });

});
