'use strict';

/**
 * zhipuGlmModel.test.js — 智谱 GLM 默认/清单收敛(修「glm-5.2 做适配」)。
 *
 * 现场:zhipu 默认模型 + builtin/preset 清单在全仓三处 SSoT 里仍停留 glm-4 世代,
 * glm-5.2 从不作默认、也不出现在可选清单里。本套件锁死这个纯叶子:
 *   - 开门(default)→ 默认 = glm-5.2,清单以 glm-5.2 打头(glm-4 系仍在,可选);
 *   - 关门(0/false/off/no)→ 逐字节回退历史默认 glm-4 与旧清单 [glm-4, glm-4-flash, glm-4-air];
 *   - 绝不抛(junk env / null)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  latestGlmModelEnabled,
  defaultZhipuModel,
  knownZhipuModels,
  LATEST_ZHIPU_MODEL,
  LEGACY_ZHIPU_MODEL,
  LATEST_ZHIPU_MODELS,
  LEGACY_ZHIPU_MODELS,
} = require('../../src/services/zhipuGlmModel');

test('constants match the documented ids', () => {
  assert.strictEqual(LATEST_ZHIPU_MODEL, 'glm-5.2');
  assert.strictEqual(LEGACY_ZHIPU_MODEL, 'glm-4');
  assert.deepStrictEqual(LEGACY_ZHIPU_MODELS, ['glm-4', 'glm-4-flash', 'glm-4-air']);
  assert.strictEqual(LATEST_ZHIPU_MODELS[0], 'glm-5.2'); // latest leads
});

test('gate default-on → latest glm-5.2', () => {
  assert.strictEqual(latestGlmModelEnabled({}), true);
  assert.strictEqual(defaultZhipuModel({}), 'glm-5.2');
  assert.strictEqual(latestGlmModelEnabled({ KHY_GLM_LATEST_MODEL: '1' }), true);
  assert.strictEqual(defaultZhipuModel({ KHY_GLM_LATEST_MODEL: 'on' }), 'glm-5.2');
});

test('gate off (0/false/off/no, case/space-insensitive) → byte-reverts to glm-4', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(latestGlmModelEnabled({ KHY_GLM_LATEST_MODEL: v }), false, v);
    assert.strictEqual(defaultZhipuModel({ KHY_GLM_LATEST_MODEL: v }), 'glm-4', v);
    assert.deepStrictEqual(knownZhipuModels({ KHY_GLM_LATEST_MODEL: v }), ['glm-4', 'glm-4-flash', 'glm-4-air'], v);
  }
});

test('knownZhipuModels() default-on → glm-5.2 first, glm-4 family retained (selectable)', () => {
  const models = knownZhipuModels({});
  assert.strictEqual(models[0], 'glm-5.2');
  assert.ok(models.includes('glm-4'), 'glm-4 still selectable');
  assert.ok(models.includes('glm-4-flash'));
  assert.ok(models.includes('glm-4-air'));
});

test('knownZhipuModels() returns a fresh copy (caller mutation is isolated)', () => {
  const a = knownZhipuModels({});
  a.push('mutant');
  assert.ok(!knownZhipuModels({}).includes('mutant'));
  assert.notStrictEqual(a, LATEST_ZHIPU_MODELS);
});

test('GLM_DEFAULT_MODEL explicit override has highest priority', () => {
  // GLM_DEFAULT_MODEL 明确指定时，优先级高于 KHY_GLM_LATEST_MODEL
  assert.strictEqual(defaultZhipuModel({ GLM_DEFAULT_MODEL: 'glm-4-flash' }), 'glm-4-flash');
  assert.strictEqual(defaultZhipuModel({ GLM_DEFAULT_MODEL: 'glm-4-air' }), 'glm-4-air');
  // 即使 KHY_GLM_LATEST_MODEL=1，GLM_DEFAULT_MODEL 仍然优先
  assert.strictEqual(defaultZhipuModel({ GLM_DEFAULT_MODEL: 'glm-4-flash', KHY_GLM_LATEST_MODEL: '1' }), 'glm-4-flash');
  // 空字符串视为未设置，回退到门控逻辑
  assert.strictEqual(defaultZhipuModel({ GLM_DEFAULT_MODEL: '', KHY_GLM_LATEST_MODEL: '0' }), 'glm-4');
  assert.strictEqual(defaultZhipuModel({ GLM_DEFAULT_MODEL: '  ', KHY_GLM_LATEST_MODEL: '1' }), 'glm-5.2');
});

test('never throws on junk env', () => {
  assert.doesNotThrow(() => defaultZhipuModel(null));
  assert.doesNotThrow(() => defaultZhipuModel(undefined));
  assert.doesNotThrow(() => latestGlmModelEnabled(null));
  assert.doesNotThrow(() => knownZhipuModels({ KHY_GLM_LATEST_MODEL: {} }));
});

test('LIVE wiring: consumers route zhipu default/list through this leaf', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const routes = read('../../src/routes/ai.js');
  assert.ok(/zhipuGlmModel/.test(routes) && /defaultZhipuModel\(\)/.test(routes), 'routes/ai.js zhipu default via leaf');
  const presets = read('../../src/services/gateway/providerPresets.js');
  assert.ok(/zhipuGlmModel/.test(presets), 'providerPresets patches zhipu via leaf');
  const builtin = read('../../src/services/gateway/builtinProviderConfig.js');
  assert.ok(/zhipuGlmModel/.test(builtin), 'builtinProviderConfig patches glm via leaf');
});
