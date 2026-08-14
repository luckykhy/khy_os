'use strict';

/**
 * agnesImageModel.test.js — agnes 文生图默认模型收敛(修「Agnes 2.0 Flash 调不出来」)。
 *
 * 现场:imageGenService 文生图默认历史 hardcode 成 agnes-image-2.1-flash,想用官方统一
 * agnes-image-2.0-flash 时无从默认命中。本套件锁死这个纯叶子:
 *   - 开门(default)→ 文生图默认 = 官方统一 agnes-image-2.0-flash;
 *   - 关门(0/false/off/no)→ 逐字节回退历史默认 agnes-image-2.1-flash;
 *   - knownAgnesImageModels() 恒列出 [2.0, 2.1] 两个官方登记、可显式选中的模型;
 *   - 绝不抛(junk env / null)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  unifiedImageModelEnabled,
  defaultAgnesGenModel,
  knownAgnesImageModels,
  UNIFIED_AGNES_IMAGE_MODEL,
  UPGRADED_AGNES_IMAGE_MODEL,
  LEGACY_AGNES_GEN_MODEL,
  KNOWN_AGNES_IMAGE_MODELS,
} = require('../../src/services/agnesImageModel');

test('constants match the officially-documented ids', () => {
  assert.strictEqual(UNIFIED_AGNES_IMAGE_MODEL, 'agnes-image-2.0-flash');
  assert.strictEqual(UPGRADED_AGNES_IMAGE_MODEL, 'agnes-image-2.1-flash');
  assert.strictEqual(LEGACY_AGNES_GEN_MODEL, 'agnes-image-2.1-flash'); // legacy default == upgraded id
});

test('gate default-on → unified 2.0-flash', () => {
  assert.strictEqual(unifiedImageModelEnabled({}), true);
  assert.strictEqual(defaultAgnesGenModel({}), 'agnes-image-2.0-flash');
  // truthy / unrelated values keep it on
  assert.strictEqual(unifiedImageModelEnabled({ KHY_AGNES_UNIFIED_IMAGE_MODEL: '1' }), true);
  assert.strictEqual(defaultAgnesGenModel({ KHY_AGNES_UNIFIED_IMAGE_MODEL: 'on' }), 'agnes-image-2.0-flash');
});

test('gate off (0/false/off/no, case/space-insensitive) → byte-reverts to 2.1-flash', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(unifiedImageModelEnabled({ KHY_AGNES_UNIFIED_IMAGE_MODEL: v }), false, v);
    assert.strictEqual(defaultAgnesGenModel({ KHY_AGNES_UNIFIED_IMAGE_MODEL: v }), 'agnes-image-2.1-flash', v);
  }
});

test('knownAgnesImageModels() lists both documented models, 2.0 first (default) then 2.1 (optional)', () => {
  assert.deepStrictEqual(knownAgnesImageModels(), ['agnes-image-2.0-flash', 'agnes-image-2.1-flash']);
  assert.deepStrictEqual(KNOWN_AGNES_IMAGE_MODELS, ['agnes-image-2.0-flash', 'agnes-image-2.1-flash']);
});

test('knownAgnesImageModels() returns a fresh copy (caller mutation is isolated)', () => {
  const a = knownAgnesImageModels();
  a.push('mutant');
  assert.deepStrictEqual(knownAgnesImageModels(), ['agnes-image-2.0-flash', 'agnes-image-2.1-flash']);
  assert.notStrictEqual(a, KNOWN_AGNES_IMAGE_MODELS);
});

test('never throws on junk env', () => {
  assert.doesNotThrow(() => defaultAgnesGenModel(null));
  assert.doesNotThrow(() => defaultAgnesGenModel(undefined));
  assert.doesNotThrow(() => unifiedImageModelEnabled(null));
  assert.doesNotThrow(() => defaultAgnesGenModel({ KHY_AGNES_UNIFIED_IMAGE_MODEL: {} }));
});

test('LIVE wiring: imageGenService routes gen default through this leaf', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/services/imageGenService.js'),
    'utf8',
  );
  assert.ok(/require\('\.\/agnesImageModel'\)/.test(src), 'should require the leaf');
  assert.ok(/defaultAgnesGenModel\(process\.env\)/.test(src), 'gen default should delegate to the leaf');
  assert.ok(/knownAgnesImageModels\(\)/.test(src), 'catalog should enumerate known models via the leaf');
});
