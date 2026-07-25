'use strict';

/**
 * visionModelDisplayName.test.js — 视觉模型名「显示归一」去 provider 路由前缀(纯叶子,OPS-MAN-150)。
 *
 * 锁死叶子契约:
 *   - 门 KHY_VISION_MODEL_DISPLAY_NAME default-on;显式 0/false/off/no 关;
 *   - 门开 → 去最后一个 '/' 前的 provider 段,**保留大小写**:
 *       `glm/glm-4.6v-flash` → `glm-4.6v-flash`;`zhipu/GLM-4.6V` → `GLM-4.6V`;
 *   - 无前缀 → 原样;门关 → 原样(逐字节回退,含前缀);
 *   - 前缀存在但去后为空(末尾即 '/')→ 保守回退原样,绝不产出空名;
 *   - null/undefined/畸形入参不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isVisionModelDisplayNameEnabled,
  toDisplayModelName,
  FLAG,
} = require('../../../src/services/gateway/visionModelDisplayName');

test('FLAG name is stable', () => {
  assert.strictEqual(FLAG, 'KHY_VISION_MODEL_DISPLAY_NAME');
});

test('gate default-on; off words close it', () => {
  assert.strictEqual(isVisionModelDisplayNameEnabled({}), true);
  assert.strictEqual(isVisionModelDisplayNameEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No', 'FALSE']) {
    assert.strictEqual(
      isVisionModelDisplayNameEnabled({ KHY_VISION_MODEL_DISPLAY_NAME: v }),
      false,
      `off word ${v}`,
    );
  }
});

test('gate on → strips provider prefix, preserves case', () => {
  assert.strictEqual(toDisplayModelName('glm/glm-4.6v-flash', {}), 'glm-4.6v-flash');
  assert.strictEqual(toDisplayModelName('zhipu/GLM-4.6V', {}), 'GLM-4.6V');
  // 多级前缀 → 只保留最后一段(与 _bareId lastIndexOf('/') 语义一致)。
  assert.strictEqual(toDisplayModelName('a/b/Claude-Opus-4-6', {}), 'Claude-Opus-4-6');
});

test('gate on → bare id (no prefix) returned unchanged, case preserved', () => {
  assert.strictEqual(toDisplayModelName('glm-4v-flash', {}), 'glm-4v-flash');
  assert.strictEqual(toDisplayModelName('gpt-5.3-codex-review', {}), 'gpt-5.3-codex-review');
  assert.strictEqual(toDisplayModelName('Claude-Opus-4-6', {}), 'Claude-Opus-4-6');
});

test('gate OFF → byte-revert (prefix preserved verbatim)', () => {
  const env = { KHY_VISION_MODEL_DISPLAY_NAME: 'off' };
  assert.strictEqual(toDisplayModelName('glm/glm-4.6v-flash', env), 'glm/glm-4.6v-flash');
  assert.strictEqual(toDisplayModelName('zhipu/GLM-4.6V', env), 'zhipu/GLM-4.6V');
  assert.strictEqual(toDisplayModelName('glm-4v-flash', env), 'glm-4v-flash');
});

test('trailing-slash prefix → conservative fallback to original (never empty)', () => {
  assert.strictEqual(toDisplayModelName('glm/', {}), 'glm/');
});

test('null / undefined / malformed inputs never throw', () => {
  assert.doesNotThrow(() => toDisplayModelName());
  assert.doesNotThrow(() => toDisplayModelName(null, {}));
  assert.doesNotThrow(() => toDisplayModelName(undefined, null));
  assert.doesNotThrow(() => toDisplayModelName(123, {}));
  assert.doesNotThrow(() => isVisionModelDisplayNameEnabled(null));
  // null → 空串(与 String(model==null?'':...) 一致),不抛。
  assert.strictEqual(toDisplayModelName(null, {}), '');
  assert.strictEqual(toDisplayModelName(undefined, {}), '');
});

test('whitespace-only / empty → returned as-is (no crash)', () => {
  assert.strictEqual(toDisplayModelName('', {}), '');
  // 纯空白:trim 后为空 → 保守回退原始 raw。
  assert.strictEqual(toDisplayModelName('   ', {}), '   ');
});
