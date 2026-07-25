'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  NATIVE_VISION_ADAPTERS,
  isEnabled,
  parseAdapterListEnv,
  adapterHandlesImagesNatively,
} = require('../src/services/gateway/adapterVisionCapability');

// ── isEnabled:门控默认开,仅 0/false/off/no 关 ──────────────────────────────
test('isEnabled 默认开(未设)', () => {
  assert.strictEqual(isEnabled({}), true);
});

test('isEnabled 仅 falsy 集合关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.strictEqual(isEnabled({ KHY_ADAPTER_NATIVE_VISION: v }), false, `应关: ${v}`);
  }
});

test('isEnabled 其余值开', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
    assert.strictEqual(isEnabled({ KHY_ADAPTER_NATIVE_VISION: v }), true, `应开: ${v}`);
  }
});

// ── 内置集:codex 原生收图 ──────────────────────────────────────────────────
test('codex 原生收图(默认门控开)', () => {
  assert.strictEqual(adapterHandlesImagesNatively('codex', {}), true);
});

test('codex 大小写/空白不敏感', () => {
  assert.strictEqual(adapterHandlesImagesNatively('  CODEX ', {}), true);
});

test('非原生收图适配器 → false', () => {
  for (const k of ['sensenova', 'trae', 'kiro', 'localLLM', 'claude', '']) {
    assert.strictEqual(adapterHandlesImagesNatively(k, {}), false, `应 false: ${k}`);
  }
});

test('null/undefined/数字 adapterKey → false 不抛', () => {
  assert.strictEqual(adapterHandlesImagesNatively(null, {}), false);
  assert.strictEqual(adapterHandlesImagesNatively(undefined, {}), false);
  assert.strictEqual(adapterHandlesImagesNatively(123, {}), false);
});

// ── 门控关 → 字节回退(恒 false,等于此能力不存在) ─────────────────────────
test('门控关 → codex 也判 false(字节回退)', () => {
  assert.strictEqual(
    adapterHandlesImagesNatively('codex', { KHY_ADAPTER_NATIVE_VISION: 'off' }),
    false
  );
});

// ── env 覆盖集:允许不改代码登记新通道 ──────────────────────────────────────
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

// ── parseAdapterListEnv:逗号/空白分隔归一小写 ──────────────────────────────
test('parseAdapterListEnv 逗号空白混合 + 归一小写', () => {
  const s = parseAdapterListEnv('Codex,  Foo\tBar ');
  assert.deepStrictEqual([...s].sort(), ['bar', 'codex', 'foo']);
});

test('parseAdapterListEnv 非字符串/空 → 空集', () => {
  assert.strictEqual(parseAdapterListEnv(null).size, 0);
  assert.strictEqual(parseAdapterListEnv(undefined).size, 0);
  assert.strictEqual(parseAdapterListEnv('').size, 0);
  assert.strictEqual(parseAdapterListEnv(42).size, 0);
});

// ── 内置集冻结、含 codex ────────────────────────────────────────────────────
test('NATIVE_VISION_ADAPTERS 含 codex 且冻结', () => {
  assert.ok(NATIVE_VISION_ADAPTERS.includes('codex'));
  assert.ok(Object.isFrozen(NATIVE_VISION_ADAPTERS));
});
