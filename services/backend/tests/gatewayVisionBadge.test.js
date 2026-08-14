'use strict';

/**
 * gatewayVisionBadge.test.js — `khy gateway model` 选择器视觉徽章 `_formatVisionTag` 纯函数测试。
 *
 * 诉求(/goal「glm-4.6v-flash 要能在模型列表看见并标注视觉理解模型」):选择器行为具备识图
 * 能力的模型追加「👁 视觉」徽章。视觉判定复用单一真源 visionCapability.isVisionCapableModel。
 *
 * 覆盖:GLM 视觉模型命中(glm-4.6v-flash / glm-4v-flash / glm-4.6v)、纯文本/生成模型不命中
 * (glm-4.7-flash / agnes-2.0-flash / cogview-3-flash)、model.modality==='vision' 直接命中、
 * 坏输入安全默认(空/null)、门控 KHY_MODEL_VISION_BADGE=off 逐字节回退(空串)。绝不抛。
 *
 * 注:_formatVisionTag 读 process.env(门控),故门关用例通过临时改写 env 验证后恢复。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gateway = require('../src/cli/handlers/gateway');
const { _formatVisionTag } = gateway.__test__;

// 剥 ANSI 颜色码,只断言可见文本。
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

test('GLM 视觉模型 → 含「👁 视觉」徽章', () => {
  for (const id of ['glm-4.6v-flash', 'glm-4v-flash', 'glm-4.6v']) {
    const tag = strip(_formatVisionTag({ id }));
    assert.ok(tag.includes('视觉'), `${id} 应带视觉徽章: ${JSON.stringify(tag)}`);
    assert.ok(tag.includes('👁'), `${id} 应带眼睛图标: ${JSON.stringify(tag)}`);
  }
});

test('纯文本/图像生成模型 → 无徽章(空串)', () => {
  for (const id of ['glm-4.7-flash', 'agnes-2.0-flash', 'cogview-3-flash', 'deepseek-chat']) {
    assert.strictEqual(_formatVisionTag({ id }), '', `${id} 不应带视觉徽章`);
  }
});

test('model.modality==="vision" → 直接命中(不依赖名字启发)', () => {
  const tag = strip(_formatVisionTag({ id: 'some-unknown-multimodal-x', modality: 'vision' }));
  assert.ok(tag.includes('视觉'), tag);
});

test('坏输入 → 空串,绝不抛', () => {
  assert.doesNotThrow(() => _formatVisionTag());
  assert.strictEqual(_formatVisionTag({}), '');
  assert.strictEqual(_formatVisionTag(null), '');
  assert.strictEqual(_formatVisionTag({ id: '' }), '');
});

test('门控 KHY_MODEL_VISION_BADGE=off → 空串(逐字节回退:行不含徽章)', () => {
  const prev = process.env.KHY_MODEL_VISION_BADGE;
  try {
    process.env.KHY_MODEL_VISION_BADGE = 'off';
    assert.strictEqual(_formatVisionTag({ id: 'glm-4.6v-flash' }), '');
  } finally {
    if (prev === undefined) delete process.env.KHY_MODEL_VISION_BADGE;
    else process.env.KHY_MODEL_VISION_BADGE = prev;
  }
});
