'use strict';

/**
 * glmVisionMaxTokens.test.js — GLM 视觉模型 max_tokens 钳位叶子(纯函数)契约锁。
 *
 * 根因回归(「识图 HTTP 400 code 1210：max_tokens参数非法：限制数值范围[1,1024]」):
 *   识图链路对 max_tokens 硬编码高默认值(8192)→ 智谱端拒绝。本叶子把发往 GLM 视觉模型的
 *   max_tokens 钳进 [1,1024];非视觉模型原样透传;门控关/异常 → 逐字节回退。
 *
 * 锁死:
 *   - 命中 GLM 视觉模型(glm-4v-flash / glm-4.6v-flash,含 provider 前缀)→ 8192→1024;
 *   - 已 ≤1024 → 原样;undefined/NaN/≤0 → 给上限 1024(不误发高默认值);
 *   - 非视觉模型(glm-4.7-flash / gpt-4o)→ 原样透传(含 undefined);
 *   - 门控关(0/false/off/no)→ 原样透传;
 *   - 绝不抛(null / 非字符串 model / 怪异 env)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  clampMaxTokensForGlmVision,
  clampEnabled,
  GLM_VISION_MAX_TOKENS,
} = require('../../../src/services/gateway/glmVisionMaxTokens');

const ON = {}; // 缺省 env → 默认开

test('上限常量 = 1024', () => {
  assert.strictEqual(GLM_VISION_MAX_TOKENS, 1024);
});

test('GLM 视觉模型:超上限 → 钳到 1024', () => {
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', 8192, ON), 1024);
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4.6v-flash', 8192, ON), 1024);
  // 带 provider 前缀亦命中。
  assert.strictEqual(clampMaxTokensForGlmVision('glm/glm-4.6v-flash', 4096, ON), 1024);
  assert.strictEqual(clampMaxTokensForGlmVision('api:glm:glm-4v-flash', 2000, ON), 1024);
});

test('GLM 视觉模型:已 ≤1024 → 原样透传', () => {
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', 512, ON), 512);
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', 1024, ON), 1024);
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', 1, ON), 1);
});

test('GLM 视觉模型:undefined/NaN/≤0 → 给上限 1024(不误发高默认值)', () => {
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', undefined, ON), 1024);
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', null, ON), 1024);
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', NaN, ON), 1024);
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', 0, ON), 1024);
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', -5, ON), 1024);
});

test('GLM 视觉模型:小数 → floor 后钳位', () => {
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', 800.9, ON), 800);
});

test('非视觉模型 → 原样透传(含 undefined)', () => {
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4.7-flash', 8192, ON), 8192);
  assert.strictEqual(clampMaxTokensForGlmVision('gpt-4o', 8192, ON), 8192);
  assert.strictEqual(clampMaxTokensForGlmVision('glm-4.7-flash', undefined, ON), undefined);
});

test('门控关(0/false/off/no)→ 原样透传,不钳位', () => {
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    const env = { KHY_GLM_VISION_MAX_TOKENS_CLAMP: off };
    assert.strictEqual(clampEnabled(env), false, `off=${off}`);
    assert.strictEqual(clampMaxTokensForGlmVision('glm-4v-flash', 8192, env), 8192, `off=${off}`);
  }
});

test('门控开(缺省 / 其它值)→ 钳位', () => {
  assert.strictEqual(clampEnabled({}), true);
  assert.strictEqual(clampEnabled({ KHY_GLM_VISION_MAX_TOKENS_CLAMP: '1' }), true);
  assert.strictEqual(clampEnabled({ KHY_GLM_VISION_MAX_TOKENS_CLAMP: 'on' }), true);
});

test('绝不抛:null / 非字符串 model / 怪异输入', () => {
  assert.strictEqual(clampMaxTokensForGlmVision(null, 8192, ON), 8192);
  assert.strictEqual(clampMaxTokensForGlmVision(undefined, 8192, ON), 8192);
  assert.strictEqual(clampMaxTokensForGlmVision(12345, 8192, ON), 8192);
  assert.strictEqual(clampMaxTokensForGlmVision({}, 8192, ON), 8192);
});
