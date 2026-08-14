'use strict';

/**
 * zhipuRetiredRemap.test.js — 修「glm-4.5 硬撞 404」。
 *
 * 现场:用户在 khy 里选中 glm-4.5(智谱已下线/不存在的模型名),连纯文本「你好」都 model_not_found
 * 404。zhipuFreeModels.remapRetiredZhipuModel 在发出前把已知下线名重映射到有效免费旗舰 glm-4.7-flash。
 * 本套件锁死这个纯叶子:
 *   - 下线名(glm-4.5 / glm-4.5-flash,大小写/空白容忍)→ glm-4.7-flash;
 *   - 有效名 / 未知名 / 空 → 原样(严格 exact-match,绝不臆造);
 *   - glm-4.5v* 视觉护栏 → 原样(绝不误伤有效视觉代);
 *   - 门关(0/false/off/no)→ 逐字节回退原入参;
 *   - junk env / null → 绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  remapRetiredZhipuModel,
  RETIRED_ZHIPU_REMAP,
} = require('../../src/services/gateway/zhipuFreeModels');

test('constants: retired map targets the valid free flagship', () => {
  assert.strictEqual(RETIRED_ZHIPU_REMAP['glm-4.5'], 'glm-4.7-flash');
  assert.strictEqual(RETIRED_ZHIPU_REMAP['glm-4.5-flash'], 'glm-4.7-flash');
  assert.throws(() => { RETIRED_ZHIPU_REMAP['glm-4.5'] = 'x'; }, 'frozen'); // Object.freeze
});

test('retired names → glm-4.7-flash (case/space tolerant)', () => {
  assert.strictEqual(remapRetiredZhipuModel('glm-4.5', {}), 'glm-4.7-flash');
  assert.strictEqual(remapRetiredZhipuModel('glm-4.5-flash', {}), 'glm-4.7-flash');
  assert.strictEqual(remapRetiredZhipuModel(' GLM-4.5 ', {}), 'glm-4.7-flash');
  assert.strictEqual(remapRetiredZhipuModel('GLM-4.5-FLASH', {}), 'glm-4.7-flash');
});

test('valid model names pass through unchanged', () => {
  for (const m of ['glm-4.7-flash', 'glm-4', 'glm-4-flash', 'glm-5.2', 'glm-4.6v-flash', 'glm-4v-flash']) {
    assert.strictEqual(remapRetiredZhipuModel(m, {}), m, m);
  }
});

test('glm-4.5v* vision guard: never remapped (valid vision generation)', () => {
  assert.strictEqual(remapRetiredZhipuModel('glm-4.5v', {}), 'glm-4.5v');
  assert.strictEqual(remapRetiredZhipuModel('glm-4.5v-flash', {}), 'glm-4.5v-flash');
  assert.strictEqual(remapRetiredZhipuModel(' GLM-4.5V ', {}), ' GLM-4.5V '); // guard 前先 trim 判定，但原样返回入参
});

test('unknown / empty names pass through unchanged (no fabrication)', () => {
  assert.strictEqual(remapRetiredZhipuModel('gpt-4o', {}), 'gpt-4o');
  assert.strictEqual(remapRetiredZhipuModel('random-model', {}), 'random-model');
  assert.strictEqual(remapRetiredZhipuModel('', {}), '');
  assert.strictEqual(remapRetiredZhipuModel('   ', {}), '   ');
});

test('gate off (0/false/off/no, case/space-insensitive) → byte-reverts input', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(remapRetiredZhipuModel('glm-4.5', { KHY_ZHIPU_FREE_MODELS: v }), 'glm-4.5', v);
  }
});

test('never throws on junk env / null model', () => {
  assert.doesNotThrow(() => remapRetiredZhipuModel(null));
  assert.doesNotThrow(() => remapRetiredZhipuModel(undefined, {}));
  assert.doesNotThrow(() => remapRetiredZhipuModel('glm-4.5', null));
  assert.doesNotThrow(() => remapRetiredZhipuModel('glm-4.5', { KHY_ZHIPU_FREE_MODELS: {} }));
  assert.strictEqual(remapRetiredZhipuModel(null), null);
});

test('LIVE wiring: apiAdapter.generate routes glm pool through remapRetiredZhipuModel', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/gateway/adapters/apiAdapter.js'), 'utf8');
  assert.ok(/remapRetiredZhipuModel/.test(src), 'apiAdapter references remapRetiredZhipuModel');
  assert.ok(/isGlmPoolKey/.test(src), 'apiAdapter gates remap on glm pool via isGlmPoolKey');
});
