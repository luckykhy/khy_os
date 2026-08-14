'use strict';

/**
 * visionOcrFallback.test.js — 「带图请求失败后是否退回本地 OCR」决策纯叶子单测。
 * 守护(goal 2026-06-27「给 khy 中使用的所有模型装上眼睛」):
 *   1. 门控 KHY_VISION_OCR_FALLBACK 默认开 / 显式关闭即字节回退(恒 false)
 *   2. 带图 + 模型拒绝信号(404/400/model_not_found/bad_request)→ 应退回 OCR
 *   3. 不带图、或非拒绝类失败(网络/超时)、或成功 → 不退回(零假阳性)
 *   4. 适配器把 404 / 「不支持图像」只写进 error 文本(无结构化 code)也能识别
 *   5. fail-soft:畸形输入不抛
 */

const test = require('node:test');
const assert = require('node:assert');

const vof = require('../src/services/gateway/visionOcrFallback');

const fail = (over = {}) => ({ success: false, ...over });

// ── 1. 门控 ──────────────────────────────────────────────────────────────────
test('门控默认开(未设 env)', () => {
  assert.strictEqual(vof.isEnabled({}), true);
  assert.strictEqual(vof.isEnabled({ KHY_VISION_OCR_FALLBACK: 'true' }), true);
});

test('仅显式 0/false/off/no 关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(vof.isEnabled({ KHY_VISION_OCR_FALLBACK: v }), false, `env=${v}`);
  }
});

test('关闭后 shouldOcrRescue 恒 false(字节回退到原 404 路径)', () => {
  const r = vof.shouldOcrRescue({
    result: fail({ statusCode: 404, errorType: 'model_not_found' }),
    hasImage: true,
    env: { KHY_VISION_OCR_FALLBACK: 'off' },
  });
  assert.strictEqual(r, false);
});

// ── 2. 带图 + 模型拒绝 → 退回 OCR ────────────────────────────────────────────
test('带图 + 404 结构化 → 应退回 OCR', () => {
  assert.strictEqual(vof.shouldOcrRescue({
    result: fail({ statusCode: 404, errorType: 'model_not_found' }),
    hasImage: true,
    env: {},
  }), true);
});

test('带图 + errorType=model_not_found(无 code)→ 应退回', () => {
  assert.strictEqual(vof.shouldOcrRescue({
    result: fail({ errorType: 'model_not_found' }),
    hasImage: true,
    env: {},
  }), true);
});

test('带图 + 400 / bad_request → 应退回', () => {
  assert.strictEqual(vof.shouldOcrRescue({ result: fail({ statusCode: 400 }), hasImage: true, env: {} }), true);
  assert.strictEqual(vof.shouldOcrRescue({ result: fail({ errorType: 'bad_request' }), hasImage: true, env: {} }), true);
});

// ── 3. 零假阳性 ──────────────────────────────────────────────────────────────
test('不带图 → 不退回(即便 404)', () => {
  assert.strictEqual(vof.shouldOcrRescue({
    result: fail({ statusCode: 404, errorType: 'model_not_found' }),
    hasImage: false,
    env: {},
  }), false);
});

test('带图但失败是网络/超时(瞬时类)→ 不退回', () => {
  assert.strictEqual(vof.shouldOcrRescue({ result: fail({ statusCode: 0, errorType: 'network', error: 'fetch failed' }), hasImage: true, env: {} }), false);
  assert.strictEqual(vof.shouldOcrRescue({ result: fail({ statusCode: 504, errorType: 'timeout', error: 'idle timeout' }), hasImage: true, env: {} }), false);
});

test('结果是成功 → 不退回', () => {
  assert.strictEqual(vof.shouldOcrRescue({ result: { success: true }, hasImage: true, env: {} }), false);
  assert.strictEqual(vof.isModelRejectionResult({ success: true, statusCode: 404 }), false);
});

// ── 4. 文本兜底(无结构化 code)──────────────────────────────────────────────
test('error 文本含 404 → 识别为模型拒绝', () => {
  assert.strictEqual(vof.isModelRejectionResult(fail({ statusCode: 0, error: 'Request failed with status code 404' })), true);
});

test('error 文本含「does not support image」→ 识别为模型拒绝', () => {
  assert.strictEqual(vof.isModelRejectionResult(fail({ error: 'This model does not support image input' })), true);
  assert.strictEqual(vof.isModelRejectionResult(fail({ error: 'vision not supported on this channel' })), true);
});

test('普通业务错误(无拒绝信号)→ 不误判', () => {
  assert.strictEqual(vof.isModelRejectionResult(fail({ statusCode: 500, error: 'internal server error' })), false);
  assert.strictEqual(vof.isModelRejectionResult(fail({ statusCode: 429, errorType: 'rate_limit' })), false);
});

// ── 5. fail-soft ─────────────────────────────────────────────────────────────
test('畸形输入不抛', () => {
  assert.doesNotThrow(() => vof.shouldOcrRescue({}));
  assert.doesNotThrow(() => vof.shouldOcrRescue({ result: null, hasImage: true }));
  assert.doesNotThrow(() => vof.isModelRejectionResult(null));
  assert.strictEqual(vof.shouldOcrRescue({ result: null, hasImage: true, env: {} }), false);
});

// ── 6. buildVisionUnreadableNote ─────────────────────────────────────────────
// 守护(goal 2026-06-27 续「图片上传后无法识别」):非视觉模型 + OCR 取不到文字时,
// 绝不静默丢图让模型谎称「没收到图」,而是如实注入提示让模型大方承认 + 给方案。
test('门控关 → 返回 null(调用方据此字节回退原静默行为)', () => {
  assert.strictEqual(vof.buildVisionUnreadableNote({ count: 1, env: { KHY_VISION_OCR_FALLBACK: 'off' } }), null);
});

test('门控开 → 注入诚实指令:承认收到图、绝不谎称没收到、给换视觉模型方案', () => {
  const note = vof.buildVisionUnreadableNote({ count: 2, env: {} });
  assert.ok(typeof note === 'string' && note.length > 0);
  assert.ok(note.includes(vof.UNREADABLE_NOTE_MARKER), '应含去重标记');
  assert.ok(note.includes('2 张图片'), '应反映图片张数');
  assert.ok(note.includes('绝不'), '应命令模型绝不谎称没收到/不编造');
  assert.ok(/khy gateway model/.test(note), '应给出换视觉模型的可行方案');
});

test('count 缺省/非法 → 泛化措辞,不抛', () => {
  for (const c of [undefined, 0, -3, NaN, 'x']) {
    const note = vof.buildVisionUnreadableNote({ count: c, env: {} });
    assert.ok(typeof note === 'string' && note.includes('图片'), `count=${c}`);
    assert.ok(!note.includes('NaN'));
  }
});

test('buildVisionUnreadableNote 畸形入参不抛', () => {
  assert.doesNotThrow(() => vof.buildVisionUnreadableNote());
  assert.doesNotThrow(() => vof.buildVisionUnreadableNote(null));
});

// ── 7. buildVisionKeyConfigOffer(透明视觉降级时顺带邀请配 GLM 视觉 key)─────────
// 守护(goal 2026-07 收尾「接上」):GLM 视觉门控开、但用户尚未配置 GLM key 时,透明视觉路
// 只能退回 OCR/读不出,却离能直接看图只差一个 key。开门 → 注入一句让模型主动问「要不要配
// GLM 视觉 key」的指令;仅当调用方明确告知 key 缺失(glmKeyMissing)时才产出。
test('key 缺失 + 门控默认开 → 注入邀约:含标记 + GLM + 问一句 + 绝不透露密钥', () => {
  const offer = vof.buildVisionKeyConfigOffer({ glmKeyMissing: true, env: {} });
  assert.ok(typeof offer === 'string' && offer.length > 0, '应产出邀约');
  assert.ok(offer.includes(vof.VISION_KEY_INVITE_MARKER), '应含去重标记');
  assert.ok(/GLM/.test(offer), '应点名 GLM 视觉 key');
  assert.ok(/API Key/i.test(offer), '应提到配置 API Key');
  assert.ok(/绝不透露|不透露/.test(offer), '应命令模型绝不透露现有密钥');
});

test('key 已可用(glmKeyMissing 假)→ 返 null(无需邀约)', () => {
  assert.strictEqual(vof.buildVisionKeyConfigOffer({ glmKeyMissing: false, env: {} }), null);
  assert.strictEqual(vof.buildVisionKeyConfigOffer({ env: {} }), null);
});

test('门控关(KHY_VISION_OCR_KEY_INVITE=0/off)→ 返 null(逐字节回退,不注入)', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      vof.buildVisionKeyConfigOffer({ glmKeyMissing: true, env: { KHY_VISION_OCR_KEY_INVITE: v } }),
      null, `env=${v}`);
  }
});

test('isVisionKeyInviteEnabled:默认开 / 仅显式 0/false/off/no 关', () => {
  assert.strictEqual(vof.isVisionKeyInviteEnabled({}), true);
  assert.strictEqual(vof.isVisionKeyInviteEnabled({ KHY_VISION_OCR_KEY_INVITE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(vof.isVisionKeyInviteEnabled({ KHY_VISION_OCR_KEY_INVITE: v }), false, `env=${v}`);
  }
});

test('buildVisionKeyConfigOffer 畸形入参不抛', () => {
  assert.doesNotThrow(() => vof.buildVisionKeyConfigOffer());
  assert.doesNotThrow(() => vof.buildVisionKeyConfigOffer(null));
  assert.doesNotThrow(() => vof.buildVisionKeyConfigOffer({ glmKeyMissing: true, env: null }));
});

// ── isDescribeFailFloorEnabled(2026-07-12「Khy 无法正确读图」修复):describe 级联全失败后
//    「剥图 + OCR + 底线」与失败说明门解耦。default-on,仅显式 0/false/off/no 关 ──────────────
test('isDescribeFailFloorEnabled:默认开(未设 / 非关闭词)', () => {
  assert.strictEqual(vof.isDescribeFailFloorEnabled({}), true);
  assert.strictEqual(vof.isDescribeFailFloorEnabled({ KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR: '1' }), true);
  assert.strictEqual(vof.isDescribeFailFloorEnabled({ KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR: 'true' }), true);
});

test('isDescribeFailFloorEnabled:仅显式 0/false/off/no 关闭(字节回退)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(vof.isDescribeFailFloorEnabled({ KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR: v }), false, `env=${v}`);
  }
});

test('isDescribeFailFloorEnabled:畸形入参不抛', () => {
  assert.doesNotThrow(() => vof.isDescribeFailFloorEnabled());
  assert.doesNotThrow(() => vof.isDescribeFailFloorEnabled(null));
});
