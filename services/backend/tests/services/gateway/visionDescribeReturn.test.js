'use strict';

/**
 * visionDescribeReturn.test.js — 「describe-and-return」纯叶子契约 SSoT。
 *
 * 用户诉求:纯文本模型收图时,视觉模型应**描述图片并回传原文本模型作答**,而非
 * switch 替换直接接管。本套件锁死叶子的纯部分:
 *   - 门控默认开;关(0/false/off/no,大小写/空格不敏感)→ 逐字节回退(false);
 *   - buildDescribePrompt 产「只描述、不作答」中性指令(逐字抄录文字);
 *   - buildDescriptionInjection 含来源模型名 + 描述;空输入 → 空串(供调用方回退);
 *   - 绝不抛(null / 非字符串 / junk env)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isVisionDescribeReturnEnabled,
  buildDescribePrompt,
  buildDescriptionInjection,
} = require('../../../src/services/gateway/visionDescribeReturn');

test('gate default-on', () => {
  assert.strictEqual(isVisionDescribeReturnEnabled({}), true);
  assert.strictEqual(isVisionDescribeReturnEnabled(undefined), true);
  assert.strictEqual(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: '1' }), true);
  assert.strictEqual(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: 'on' }), true);
  assert.strictEqual(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: 'true' }), true);
});

test('gate off — CANON off-words (case/space-insensitive)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'False']) {
    assert.strictEqual(
      isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: v }),
      false,
      `expected off for ${JSON.stringify(v)}`,
    );
  }
});

test('gate never throws on junk env', () => {
  assert.strictEqual(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: 123 }), true);
  assert.strictEqual(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: {} }), true);
  assert.strictEqual(isVisionDescribeReturnEnabled({ KHY_VISION_DESCRIBE_RETURN: null }), true);
});

test('buildDescribePrompt is a neutral describe-only instruction', () => {
  const p = buildDescribePrompt();
  assert.ok(typeof p === 'string' && p.length > 0);
  // 只描述、不作答的核心约束
  assert.ok(/描述/.test(p), 'mentions 描述');
  assert.ok(/逐字/.test(p), 'requires verbatim text transcription');
  assert.ok(/不要.*回答|不要.*提问|不要评价/.test(p), 'forbids answering/evaluating');
});

test('buildDescriptionInjection includes source model name and description', () => {
  const out = buildDescriptionInjection(['一张登录页截图,标题「Sign in」'], { model: 'glm/glm-4.6v-flash' });
  assert.ok(out.includes('glm/glm-4.6v-flash'), 'names the vision model');
  assert.ok(out.includes('据此作答'), 'tells text model to answer from it');
  assert.ok(out.includes('Sign in'), 'carries the description body verbatim');
});

test('buildDescriptionInjection without model still labels source', () => {
  const out = buildDescriptionInjection(['内容 X'], {});
  assert.ok(out.includes('视觉模型'), 'generic vision-model label');
  assert.ok(out.includes('内容 X'));
  assert.ok(!out.includes('「」'), 'no empty model-name braces');
});

test('buildDescriptionInjection multi-image numbers each block', () => {
  const out = buildDescriptionInjection(['甲', '乙'], { model: 'm' });
  assert.ok(out.includes('【图片1 描述】'));
  assert.ok(out.includes('【图片2 描述】'));
  assert.ok(out.includes('甲') && out.includes('乙'));
});

test('buildDescriptionInjection empty/blank input → empty string (caller falls back)', () => {
  assert.strictEqual(buildDescriptionInjection([], { model: 'm' }), '');
  assert.strictEqual(buildDescriptionInjection(['', '   '], { model: 'm' }), '');
  assert.strictEqual(buildDescriptionInjection([null, undefined], { model: 'm' }), '');
});

test('buildDescriptionInjection accepts a bare string and never throws', () => {
  assert.doesNotThrow(() => buildDescriptionInjection('单段描述', { model: 'm' }));
  const out = buildDescriptionInjection('单段描述', { model: 'm' });
  assert.ok(out.includes('单段描述'));
  assert.doesNotThrow(() => buildDescriptionInjection(null));
  assert.strictEqual(buildDescriptionInjection(null), '');
});
