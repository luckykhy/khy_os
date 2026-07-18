'use strict';

/**
 * imageOcrFallbackPolicy.test.js — pure-leaf decision + net-fail OCR note (node:test).
 *
 * Goal「不要一识别图片就网络中断就失败,导致接下来换那个模型都是失败」:
 *  - decideImageOcrNext 的核心不变量:**无可用视觉模型时永不返回 try-vision**,
 *    从而 imageOcr 工具不再重入网关引发逐适配器冷却级联。
 *  - 网络失败时,prep 期已提取的本地 OCR 文本要被保留为诚实降级文案。
 *  - 两道门控关闭即字节回退;函数绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  isNoCascadeEnabled,
  getTotalTimeoutMs,
  decideImageOcrNext,
  buildNoVisionNoTextMessage,
  isOcrTextOnNetFailEnabled,
  shouldApplyOcrTextOnNetFail,
  buildOcrTextOnNetFailNote,
  OCR_NETFAIL_MARKER,
  DEFAULT_TOTAL_MS,
} = require('../src/services/gateway/imageOcrFallbackPolicy');

test('gate KHY_IMAGE_OCR_NO_CASCADE defaults on, byte-reverts when falsy', () => {
  assert.equal(isNoCascadeEnabled({}), true);
  assert.equal(isNoCascadeEnabled({ KHY_IMAGE_OCR_NO_CASCADE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.equal(isNoCascadeEnabled({ KHY_IMAGE_OCR_NO_CASCADE: v }), false);
  }
});

test('getTotalTimeoutMs default 60s, override clamped to [5s,600s]', () => {
  assert.equal(getTotalTimeoutMs({}), DEFAULT_TOTAL_MS);
  assert.equal(getTotalTimeoutMs({ KHY_IMAGE_OCR_TOTAL_MS: '90000' }), 90000);
  assert.equal(getTotalTimeoutMs({ KHY_IMAGE_OCR_TOTAL_MS: '1' }), 5000); // floor
  assert.equal(getTotalTimeoutMs({ KHY_IMAGE_OCR_TOTAL_MS: '99999999' }), 600000); // ceil
  assert.equal(getTotalTimeoutMs({ KHY_IMAGE_OCR_TOTAL_MS: 'abc' }), DEFAULT_TOTAL_MS);
});

test('decision quadrant — local adequate text → use-local (no network)', () => {
  const d = decideImageOcrNext({
    localSuccess: true, localHasText: true, localNeedsAiFallback: false,
    visionAvailable: true, forceAi: false,
  });
  assert.equal(d.action, 'use-local');
});

test('decision quadrant — local insufficient + vision available → try-vision', () => {
  const d = decideImageOcrNext({
    localSuccess: false, localHasText: false, localNeedsAiFallback: true,
    visionAvailable: true, forceAi: false,
  });
  assert.equal(d.action, 'try-vision');
});

test('INVARIANT: no vision model → NEVER try-vision (no cascade)', () => {
  // 无文字 → fail-honest
  const noText = decideImageOcrNext({
    localSuccess: false, localHasText: false, localNeedsAiFallback: true,
    visionAvailable: false, forceAi: false,
  });
  assert.equal(noText.action, 'fail-honest');
  assert.notEqual(noText.action, 'try-vision');

  // 有文字(哪怕低置信) → use-local,绝不重入网关
  const withText = decideImageOcrNext({
    localSuccess: true, localHasText: true, localNeedsAiFallback: true,
    visionAvailable: false, forceAi: false,
  });
  assert.equal(withText.action, 'use-local');
  assert.notEqual(withText.action, 'try-vision');
});

test('decision — forceAi respects explicit intent but never cascades without vision', () => {
  assert.equal(decideImageOcrNext({ forceAi: true, visionAvailable: true }).action, 'try-vision');
  assert.equal(
    decideImageOcrNext({ forceAi: true, visionAvailable: false, localHasText: true, localSuccess: true }).action,
    'use-local',
  );
  assert.equal(
    decideImageOcrNext({ forceAi: true, visionAvailable: false, localHasText: false }).action,
    'fail-honest',
  );
});

test('decideImageOcrNext never throws on garbage input', () => {
  assert.doesNotThrow(() => decideImageOcrNext());
  assert.doesNotThrow(() => decideImageOcrNext(null));
  assert.doesNotThrow(() => decideImageOcrNext({ visionAvailable: 'yes', localHasText: 1 }));
});

test('buildNoVisionNoTextMessage is honest, mentions gateway model, singular/plural', () => {
  const one = buildNoVisionNoTextMessage({ count: 1 });
  assert.match(one, /这张图片/);
  assert.match(one, /khy gateway model/);
  const many = buildNoVisionNoTextMessage({ count: 3 });
  assert.match(many, /这些图片/);
  assert.doesNotThrow(() => buildNoVisionNoTextMessage());
});

test('gate KHY_OCR_TEXT_ON_NETFAIL defaults on, byte-reverts when falsy', () => {
  assert.equal(isOcrTextOnNetFailEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.equal(isOcrTextOnNetFailEnabled({ KHY_OCR_TEXT_ON_NETFAIL: v }), false);
  }
});

test('shouldApplyOcrTextOnNetFail — only network/timeout + ocrApplied + hasText', () => {
  const base = { ocrApplied: true, hasText: true, env: {} };
  assert.equal(shouldApplyOcrTextOnNetFail({ ...base, errorType: 'network' }), true);
  assert.equal(shouldApplyOcrTextOnNetFail({ ...base, errorType: 'timeout' }), true);
  assert.equal(shouldApplyOcrTextOnNetFail({ ...base, errorType: 'bad_request' }), false);
  assert.equal(shouldApplyOcrTextOnNetFail({ ...base, errorType: 'network', ocrApplied: false }), false);
  assert.equal(shouldApplyOcrTextOnNetFail({ ...base, errorType: 'network', hasText: false }), false);
  // gate off → false
  assert.equal(
    shouldApplyOcrTextOnNetFail({ ...base, errorType: 'network', env: { KHY_OCR_TEXT_ON_NETFAIL: 'off' } }),
    false,
  );
});

test('buildOcrTextOnNetFailNote preserves recognized text, null when gate off / no text', () => {
  const note = buildOcrTextOnNetFailNote({ text: 'INVOICE 12345', env: {} });
  assert.ok(note.includes(OCR_NETFAIL_MARKER));
  assert.ok(note.includes('INVOICE 12345'));
  assert.equal(buildOcrTextOnNetFailNote({ text: '   ', env: {} }), null);
  assert.equal(buildOcrTextOnNetFailNote({ text: 'x', env: { KHY_OCR_TEXT_ON_NETFAIL: '0' } }), null);
  assert.doesNotThrow(() => buildOcrTextOnNetFailNote());
});
