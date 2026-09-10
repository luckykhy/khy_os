'use strict';
const {
  isEnabled,
  shouldForceFirstToolCall,
  buildInlineImageNote,
} = require('../src/services/gateway/visionDirectTurnPolicy');
// ── isEnabled ───────────────────────────────────────────────────────────────
// ── shouldForceFirstToolCall ────────────────────────────────────────────────
// ── buildInlineImageNote ────────────────────────────────────────────────────

describe('Vision Direct Turn Policy', () => {
  test('isEnabled 默认开', () => {
      expect(isEnabled({})).toBe(true);
  });

  test('isEnabled 仅 falsy 关', () => {
      for (const v of ['0', 'false', 'off', 'no', ' OFF ']) {
        expect(isEnabled({ KHY_VISION_DIRECT_DESCRIBE: v })).toBe(false, v);
      }
      for (const v of ['1', 'true', 'on', 'whatever']) {
        expect(isEnabled({ KHY_VISION_DIRECT_DESCRIBE: v })).toBe(true, v);
      }
  });

  test('门控开 + 第一轮 + 无图 → 强制(legacy 编码任务保留)', () => {
      expect(shouldForceFirstToolCall({ iteration: 0, hasImage: false, env: {} })).toBe(true);
  });

  test('门控开 + 第一轮 + 带图 → 不强制(纯描述可直接出文本)', () => {
      expect(shouldForceFirstToolCall({ iteration: 0, hasImage: true, env: {} })).toBe(false);
  });

  test('门控开 + 非第一轮 → 一律不强制', () => {
      expect(shouldForceFirstToolCall({ iteration: 1, hasImage: false, env: {} })).toBe(false);
      expect(shouldForceFirstToolCall({ iteration: 3, hasImage: true, env: {} })).toBe(false);
  });

  test('门控关 → 字节回退 legacy(仅第一轮强制,与是否带图无关)', () => {
      const off = { KHY_VISION_DIRECT_DESCRIBE: 'off' };
      expect(shouldForceFirstToolCall({ iteration: 0, hasImage: true, env: off })).toBe(true);
      expect(shouldForceFirstToolCall({ iteration: 0, hasImage: false, env: off })).toBe(true);
      expect(shouldForceFirstToolCall({ iteration: 1, hasImage: true, env: off })).toBe(false);
  });

  test('iteration 非数字 → 不视为第一轮(不抛)', () => {
      expect(shouldForceFirstToolCall({ iteration: undefined, hasImage: false, env: {} })).toBe(false);
      expect(shouldForceFirstToolCall({})).toBe(false);
  });

  test('门控开 + count>0 → 含「内联/不要 Read」指引', () => {
      const note = buildInlineImageNote({ count: 1, env: {} });
      expect(note && note).toContain('内联');
      expect(note).toContain('一张图片');
      expect(/不要用 Read/.test(note).toBeTruthy());
  });

  test('多张图片 → 复数措辞', () => {
      const note = buildInlineImageNote({ count: 3, env: {} });
      expect(note).toContain('3 张图片');
  });

  test('门控关 → null(字节回退,不注入)', () => {
      expect(buildInlineImageNote({ count: 2, env: { KHY_VISION_DIRECT_DESCRIBE: '0' } })).toBe(null);
  });

  test('count<=0 / 非数字 → null(不抛)', () => {
      expect(buildInlineImageNote({ count: 0, env: {} })).toBe(null);
      expect(buildInlineImageNote({ count: -1, env: {} })).toBe(null);
      expect(buildInlineImageNote({ count: NaN, env: {} })).toBe(null);
      expect(buildInlineImageNote({ env: {} })).toBe(null);
  });

});
