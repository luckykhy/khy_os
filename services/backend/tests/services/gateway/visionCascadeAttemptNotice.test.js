'use strict';

/**
 * visionCascadeAttemptNotice.test.js — 级联「每候选提示」减冗余(纯叶子,OPS-MAN-145)。
 *
 * 锁死叶子契约:
 *   - 门 KHY_VISION_CASCADE_ATTEMPT_NOTICE default-on;显式 0/false/off/no 关;
 *   - 首候选(index<=0 / 缺失)→ 历史首句「我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...」;
 *   - 后续候选(index>0,门开)→ 「视觉模型 <prev> 不可用，正在改用 <model> 继续识别...」(去冗余首句 + 含 MARKER);
 *   - 门关 → 对**所有** index 逐字节回退历史首句(byte-revert);
 *   - 畸形入参不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isCascadeAttemptNoticeEnabled,
  buildCascadeAttemptNotice,
  CASCADE_ATTEMPT_FALLBACK_MARKER,
} = require('../../../src/services/gateway/visionCascadeAttemptNotice');

const LEGACY = (m) => `我无法直接识别图片内容。正在调用 ${m} 进行识别，请稍候...`;

test('gate default-on; off words close it', () => {
  assert.strictEqual(isCascadeAttemptNoticeEnabled({}), true);
  assert.strictEqual(isCascadeAttemptNoticeEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(isCascadeAttemptNoticeEnabled({ KHY_VISION_CASCADE_ATTEMPT_NOTICE: v }), false, `off ${v}`);
  }
});

test('first candidate (index 0) → legacy full preamble', () => {
  const s = buildCascadeAttemptNotice({ index: 0, model: 'glm-4v-flash', prevModel: null, env: {} });
  assert.strictEqual(s, LEGACY('glm-4v-flash'));
});

test('missing/negative index → legacy full preamble', () => {
  assert.strictEqual(buildCascadeAttemptNotice({ model: 'm1', env: {} }), LEGACY('m1'));
  assert.strictEqual(buildCascadeAttemptNotice({ index: -1, model: 'm1', env: {} }), LEGACY('m1'));
});

test('subsequent candidate (index>0, gate on) → reframed fallback, no redundant preamble', () => {
  const s = buildCascadeAttemptNotice({ index: 1, model: 'glm-4v-flash', prevModel: 'glm/glm-4.6v-flash', env: {} });
  assert.ok(!s.includes('我无法直接识别图片内容'), 'drops redundant preamble');
  assert.match(s, new RegExp(CASCADE_ATTEMPT_FALLBACK_MARKER), 'contains fallback marker');
  assert.match(s, /glm\/glm-4\.6v-flash 不可用/, 'names prev model');
  assert.match(s, /改用 glm-4v-flash 继续识别/, 'names next model');
});

test('subsequent candidate with missing prevModel → graceful placeholder', () => {
  const s = buildCascadeAttemptNotice({ index: 2, model: 'm3', env: {} });
  assert.match(s, /上一视觉模型 不可用/);
  assert.match(s, /改用 m3 继续识别/);
});

test('gate OFF → ALL indices byte-revert to legacy', () => {
  const env = { KHY_VISION_CASCADE_ATTEMPT_NOTICE: 'off' };
  assert.strictEqual(buildCascadeAttemptNotice({ index: 0, model: 'a', prevModel: null, env }), LEGACY('a'));
  assert.strictEqual(buildCascadeAttemptNotice({ index: 3, model: 'b', prevModel: 'a', env }), LEGACY('b'));
});

test('missing model → 视觉模型 fallback name in legacy', () => {
  assert.strictEqual(buildCascadeAttemptNotice({ index: 0, env: {} }), LEGACY('视觉模型'));
});

test('never throws on junk', () => {
  assert.doesNotThrow(() => buildCascadeAttemptNotice());
  assert.doesNotThrow(() => buildCascadeAttemptNotice({ index: {}, model: {}, env: null }));
  assert.doesNotThrow(() => isCascadeAttemptNoticeEnabled(null));
});
