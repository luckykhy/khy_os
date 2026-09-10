'use strict';
const {
  NATIVE_VISION_ADAPTERS,
  isEnabled,
  parseAdapterListEnv,
  adapterHandlesImagesNatively,
} = require('../src/services/gateway/adapterVisionCapability');
// ── isEnabled:门控默认开,仅 0/false/off/no 关 ──────────────────────────────
// ── 内置集:codex 原生收图 ──────────────────────────────────────────────────
// ── 门控关 → 字节回退(恒 false,等于此能力不存在) ─────────────────────────
// ── env 覆盖集:允许不改代码登记新通道 ──────────────────────────────────────
// ── parseAdapterListEnv:逗号/空白分隔归一小写 ──────────────────────────────
// ── 内置集冻结、含 codex ────────────────────────────────────────────────────

describe('Adapter Vision Capability', () => {
  test('isEnabled 默认开(未设)', () => {
      expect(isEnabled({})).toBe(true);
  });

  test('isEnabled 仅 falsy 集合关', () => {
      for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
        expect(isEnabled({ KHY_ADAPTER_NATIVE_VISION: v })).toBe(false, `应关: ${v}`);
      }
  });

  test('isEnabled 其余值开', () => {
      for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
        expect(isEnabled({ KHY_ADAPTER_NATIVE_VISION: v })).toBe(true, `应开: ${v}`);
      }
  });

  test('codex 原生收图(默认门控开)', () => {
      expect(adapterHandlesImagesNatively('codex')).toBe({});
  });

  test('codex 大小写/空白不敏感', () => {
      expect(adapterHandlesImagesNatively('  CODEX ')).toBe({});
  });

  test('cli 仅在实际适配器报告文件视觉时判定原生', () => {
      const adapter = { handlesImagesNatively: () => true };
      expect(adapterHandlesImagesNatively('cli')).toBe({}, { adapter, options: {} });
      assert.strictEqual(
        adapterHandlesImagesNatively('cli', {}, { adapter: { handlesImagesNatively: () => false }, options: {} }),
        false
      );
      expect(adapterHandlesImagesNatively('cli')).toBe({}, { options: {} });
  });

  test('非原生收图适配器 → false', () => {
      for (const k of ['sensenova', 'trae', 'kiro', 'localLLM', 'claude', '']) {
        expect(adapterHandlesImagesNatively(k)).toBe({});
      }
  });

  test('null/undefined/数字 adapterKey → false 不抛', () => {
      expect(adapterHandlesImagesNatively(null)).toBe({});
      expect(adapterHandlesImagesNatively(undefined)).toBe({});
      expect(adapterHandlesImagesNatively(123)).toBe({});
  });

  test('门控关 → codex 也判 false(字节回退)', () => {
      assert.strictEqual(
        adapterHandlesImagesNatively('codex', { KHY_ADAPTER_NATIVE_VISION: 'off' }),
        false
      );
  });

  test('KHY_NATIVE_VISION_ADAPTERS 可登记新原生通道', () => {
      assert.strictEqual(
        adapterHandlesImagesNatively('myvision', { KHY_NATIVE_VISION_ADAPTERS: 'myvision, other' }),
        true
      );
  });

  test('env 覆盖集在门控关时仍不生效(门控优先)', () => {
      assert.strictEqual(
        adapterHandlesImagesNatively('myvision', {
          KHY_ADAPTER_NATIVE_VISION: '0',
          KHY_NATIVE_VISION_ADAPTERS: 'myvision',
        }),
        false
      );
  });

  test('parseAdapterListEnv 逗号空白混合 + 归一小写', () => {
      const s = parseAdapterListEnv('Codex,  Foo\tBar ');
      expect([...s].sort()).toBe(['bar', 'codex', 'foo']);
  });

  test('parseAdapterListEnv 非字符串/空 → 空集', () => {
      expect(parseAdapterListEnv(null).size).toBe(0);
      expect(parseAdapterListEnv(undefined).size).toBe(0);
      expect(parseAdapterListEnv('').size).toBe(0);
      expect(parseAdapterListEnv(42).size).toBe(0);
  });

  test('NATIVE_VISION_ADAPTERS 含 codex 且冻结', () => {
      expect(NATIVE_VISION_ADAPTERS).toContain('codex');
      expect(Object.isFrozen(NATIVE_VISION_ADAPTERS).toBeTruthy());
  });

});
