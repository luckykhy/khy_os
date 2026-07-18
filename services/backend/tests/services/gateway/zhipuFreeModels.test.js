'use strict';

/**
 * zhipuFreeModels.test.js — 「智谱 key 配好后自动加入免费模型」纯叶子契约锁死。
 *
 *   - 免费模型清单/端点常量与文档一致(7 条,cogview/cogvideox 属图像/视频);
 *   - 门开(default)→ 聊天 id 为对话+视觉(5 条),augmentGlmPoolModels 对 glm 池追加免费聊天模型;
 *   - 门关(0/false/off/no)→ 全部逐字节回退(清单空、augment 原样返回入参);
 *   - 非 glm poolKey 绝不受影响;绝不抛(null / 非数组 / junk env)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  ZHIPU_ENDPOINT,
  ZHIPU_FREE_MODELS,
  zhipuFreeModelsEnabled,
  isGlmPoolKey,
  listZhipuFreeModels,
  zhipuFreeChatModelIds,
  zhipuFreeModelIds,
  augmentGlmPoolModels,
} = require('../../../src/services/gateway/zhipuFreeModels');

test('constants: 7 free models, correct endpoint, cogview/cogvideox tagged image/video', () => {
  assert.strictEqual(ZHIPU_ENDPOINT, 'https://open.bigmodel.cn/api/paas/v4');
  assert.strictEqual(ZHIPU_FREE_MODELS.length, 7);
  const ids = ZHIPU_FREE_MODELS.map((m) => m.id);
  assert.deepStrictEqual(ids, [
    'glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash',
    'glm-4-flash-250414', 'glm-4v-flash', 'cogview-3-flash', 'cogvideox-flash',
  ]);
  assert.strictEqual(ZHIPU_FREE_MODELS.find((m) => m.id === 'cogview-3-flash').modality, 'image');
  assert.strictEqual(ZHIPU_FREE_MODELS.find((m) => m.id === 'cogvideox-flash').modality, 'video');
  // glm-4.5-flash 已下线,不得出现
  assert.ok(!ids.includes('glm-4.5-flash'));
});

test('gate default-on (unset / 1 / on)', () => {
  assert.strictEqual(zhipuFreeModelsEnabled({}), true);
  assert.strictEqual(zhipuFreeModelsEnabled({ KHY_ZHIPU_FREE_MODELS: '1' }), true);
  assert.strictEqual(zhipuFreeModelsEnabled({ KHY_ZHIPU_FREE_MODELS: 'on' }), true);
});

test('chat ids exclude image/video (5 chat+vision ids)', () => {
  const chat = zhipuFreeChatModelIds({});
  assert.deepStrictEqual(chat, [
    'glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash',
    'glm-4-flash-250414', 'glm-4v-flash',
  ]);
  assert.ok(!chat.includes('cogview-3-flash'));
  assert.ok(!chat.includes('cogvideox-flash'));
  assert.strictEqual(zhipuFreeModelIds({}).length, 7); // 全量含 image/video
});

test('isGlmPoolKey tolerant of case/space', () => {
  assert.strictEqual(isGlmPoolKey('glm'), true);
  assert.strictEqual(isGlmPoolKey(' GLM '), true);
  assert.strictEqual(isGlmPoolKey('deepseek'), false);
  assert.strictEqual(isGlmPoolKey(''), false);
  assert.strictEqual(isGlmPoolKey(null), false);
});

test('augment: glm pool gets free chat models appended (existing kept, deduped)', () => {
  const out = augmentGlmPoolModels('glm', ['glm-4.7-flash'], {});
  // existing 'glm-4.7-flash' 保留在前且不重复,其余 4 个追加
  assert.strictEqual(out[0], 'glm-4.7-flash');
  assert.strictEqual(out.filter((m) => m === 'glm-4.7-flash').length, 1);
  for (const id of ['glm-4.6v-flash', 'glm-4.1v-thinking-flash', 'glm-4-flash-250414', 'glm-4v-flash']) {
    assert.ok(out.includes(id), id);
  }
  assert.strictEqual(out.length, 5);
  // 不含 image/video
  assert.ok(!out.includes('cogview-3-flash'));
});

test('augment: empty static (占位/离线) → full 5 free chat models', () => {
  assert.deepStrictEqual(augmentGlmPoolModels('glm', [], {}), [
    'glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash',
    'glm-4-flash-250414', 'glm-4v-flash',
  ]);
});

test('augment: object-shaped existing {id} deduped case-insensitively', () => {
  const out = augmentGlmPoolModels('glm', [{ id: 'GLM-4.7-Flash' }], {});
  // 大小写不敏感去重:不重复追加 glm-4.7-flash
  assert.strictEqual(out.filter((m) => (typeof m === 'string' ? m : m.id).toLowerCase() === 'glm-4.7-flash').length, 1);
});

test('augment: non-glm poolKey untouched (strict superset only for glm)', () => {
  assert.deepStrictEqual(augmentGlmPoolModels('deepseek', ['deepseek-chat'], {}), ['deepseek-chat']);
  assert.deepStrictEqual(augmentGlmPoolModels('openai', [], {}), []);
});

test('gate off (0/false/off/no) → byte-revert everywhere', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    const env = { KHY_ZHIPU_FREE_MODELS: v };
    assert.strictEqual(zhipuFreeModelsEnabled(env), false, v);
    assert.deepStrictEqual(listZhipuFreeModels(env), [], v);
    assert.deepStrictEqual(zhipuFreeChatModelIds(env), [], v);
    assert.deepStrictEqual(zhipuFreeModelIds(env), [], v);
    // augment 原样返回入参内容(byte-revert)
    assert.deepStrictEqual(augmentGlmPoolModels('glm', ['x'], env), ['x'], v);
    assert.deepStrictEqual(augmentGlmPoolModels('glm', [], env), [], v);
  }
});

test('never throws on junk input', () => {
  assert.doesNotThrow(() => augmentGlmPoolModels('glm', null, {}));
  assert.doesNotThrow(() => augmentGlmPoolModels(null, undefined, null));
  assert.doesNotThrow(() => listZhipuFreeModels(null));
  assert.deepStrictEqual(augmentGlmPoolModels('glm', null, {}), [
    'glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash',
    'glm-4-flash-250414', 'glm-4v-flash',
  ]);
});

test('listZhipuFreeModels returns fresh copies (caller cannot corrupt frozen source)', () => {
  const a = listZhipuFreeModels({});
  a[0].id = 'mutated';
  assert.strictEqual(ZHIPU_FREE_MODELS[0].id, 'glm-4.7-flash');
});
