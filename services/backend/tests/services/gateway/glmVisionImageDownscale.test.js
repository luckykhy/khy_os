'use strict';

/**
 * glmVisionImageDownscale.test.js — GLM 视觉过大图片降采样叶子契约锁(node:test)。
 *
 * 根因回归(「识图 HTTP 400 code 1210」第二形态,0.1.181 诊断浮现):
 *   GLM 视觉端有合并预算 `inputs tokens + max_new_tokens <= 16384`;高分辨率截图光图片就
 *   编码成 18287 input token > 16384 → 无论输出多小都 400。本叶子在发送前估算 token,超预算
 *   者等比降采样到预算内;预算内 / 非视觉模型 / 门控关 / 平台工具失败 → 原图透传(fail-soft)。
 *
 * 锁死(不触真实平台缩放 CLI —— 只验纯逻辑与「不命中即原样透传」):
 *   - 门控三态(缺省开 / 0·false·off·no 关);
 *   - token 估算随面积单调、异常输入返 0;
 *   - scale factor:预算内 → 1;超预算 → (0,1) 且面积压回目标以内;
 *   - downscaleGlmVisionImages:非视觉模型 / 门控关 / 预算内小图 → 返回**原数组引用**(0 重编码);
 *   - 绝不抛(null / 空 / 怪异输入)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  downscaleGlmVisionImages,
  downscaleImageBlocksInMessages,
  _extractBase64FromUrl,
  downscaleEnabled,
  normalizeAllEnabled,
  getMaxEdge,
  estimateVisionTokens,
  computeScaleFactor,
  TARGET_IMAGE_TOKENS,
  DEFAULT_MAX_EDGE,
} = require('../../../src/services/gateway/glmVisionImageDownscale');

// 一张 1x1 PNG(远在预算内)——用于「小图原样透传」。
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function tinyImage() {
  return { base64: TINY_PNG_BASE64, mimeType: 'image/png', dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}` };
}

test('门控:缺省 → 开;0/false/off/no → 关', () => {
  assert.strictEqual(downscaleEnabled({}), true);
  assert.strictEqual(downscaleEnabled({ KHY_GLM_VISION_IMAGE_DOWNSCALE: '1' }), true);
  assert.strictEqual(downscaleEnabled({ KHY_GLM_VISION_IMAGE_DOWNSCALE: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.strictEqual(downscaleEnabled({ KHY_GLM_VISION_IMAGE_DOWNSCALE: off }), false, `off=${off}`);
  }
});

test('token 估算:随面积单调递增,异常输入 → 0', () => {
  const small = estimateVisionTokens(100, 100);
  const big = estimateVisionTokens(1000, 1000);
  assert.ok(big > small, 'larger area → more tokens');
  assert.ok(estimateVisionTokens(0, 100) === 0);
  assert.ok(estimateVisionTokens(-1, 100) === 0);
  assert.ok(estimateVisionTokens(NaN, 100) === 0);
  assert.ok(estimateVisionTokens('x', 'y') === 0);
});

test('scale factor:预算内 → 1(不缩)', () => {
  // 小图 token 远 < 目标 → 不缩。
  assert.strictEqual(computeScaleFactor(64, 64), 1);
});

test('scale factor:超预算 → (0,1) 且缩放后面积落回目标以内', () => {
  // 构造一张明显超预算的大图。关掉统一归一化,只验预算约束本身。
  const env = { KHY_GLM_VISION_NORMALIZE_ALL: '0' };
  const W = 4000;
  const H = 3000;
  const before = estimateVisionTokens(W, H);
  assert.ok(before > TARGET_IMAGE_TOKENS, 'precondition: over budget');

  const scale = computeScaleFactor(W, H, env);
  assert.ok(scale > 0 && scale < 1, `scale in (0,1): ${scale}`);

  const after = estimateVisionTokens(Math.round(W * scale), Math.round(H * scale));
  assert.ok(after <= TARGET_IMAGE_TOKENS, `after (${after}) <= target (${TARGET_IMAGE_TOKENS})`);
});

test('统一归一化(默认开):超最大边的图按 maxEdge 收敛;长边缩到上限内', () => {
  assert.strictEqual(normalizeAllEnabled({}), true);
  assert.strictEqual(getMaxEdge({}), DEFAULT_MAX_EDGE);

  // 一张 token 仍在预算内但长边超上限的图(如 2000x400)——仅归一化触发。
  const W = 2000;
  const H = 400;
  const scale = computeScaleFactor(W, H, {});
  assert.ok(scale < 1, `normalize-all should shrink long edge: scale=${scale}`);
  const longAfter = Math.round(Math.max(W, H) * scale);
  assert.ok(longAfter <= DEFAULT_MAX_EDGE + 1, `long edge (${longAfter}) <= maxEdge (${DEFAULT_MAX_EDGE})`);
});

test('统一归一化门关 → 仅超预算才缩(长边超上限但预算内的图不动)', () => {
  const env = { KHY_GLM_VISION_NORMALIZE_ALL: '0' };
  // 2000x400 est tokens 远在预算内 → 关归一化后不缩。
  assert.ok(estimateVisionTokens(2000, 400) <= TARGET_IMAGE_TOKENS, 'precondition: in budget');
  assert.strictEqual(computeScaleFactor(2000, 400, env), 1);
});

test('maxEdge 可经 KHY_GLM_VISION_MAX_EDGE 覆盖(夹在 [512,4096])', () => {
  assert.strictEqual(getMaxEdge({ KHY_GLM_VISION_MAX_EDGE: '1024' }), 1024);
  assert.strictEqual(getMaxEdge({ KHY_GLM_VISION_MAX_EDGE: '100' }), 512); // 夹下限
  assert.strictEqual(getMaxEdge({ KHY_GLM_VISION_MAX_EDGE: '99999' }), 4096); // 夹上限
  assert.strictEqual(getMaxEdge({ KHY_GLM_VISION_MAX_EDGE: 'x' }), DEFAULT_MAX_EDGE); // 非法 → 缺省
});

test('downscaleGlmVisionImages:非视觉模型 → 原数组引用透传(0 重编码)', () => {
  const imgs = [tinyImage()];
  const out = downscaleGlmVisionImages('gpt-4o', imgs, {});
  assert.strictEqual(out, imgs, '非视觉模型必须原样返回同一引用');
});

test('downscaleGlmVisionImages:门控关 → 原数组引用透传', () => {
  const imgs = [tinyImage()];
  const out = downscaleGlmVisionImages('glm-4v-flash', imgs, { KHY_GLM_VISION_IMAGE_DOWNSCALE: '0' });
  assert.strictEqual(out, imgs);
});

test('downscaleGlmVisionImages:GLM 视觉 + 预算内小图 → 原数组引用透传(不缩)', () => {
  const imgs = [tinyImage()];
  const out = downscaleGlmVisionImages('glm-4v-flash', imgs, {});
  assert.strictEqual(out, imgs, '1x1 图远在预算内,不该重编码');
});

test('绝不抛:null / 空 / 怪异输入', () => {
  assert.strictEqual(downscaleGlmVisionImages('glm-4v-flash', null, {}), null);
  assert.deepStrictEqual(downscaleGlmVisionImages('glm-4v-flash', [], {}), []);
  const junk = [{ base64: null }, { nope: 1 }, { base64: 'not-base64-@@@' }];
  const out = downscaleGlmVisionImages('glm-4v-flash', junk, {});
  // 无有效图片可缩 → 返回原数组引用。
  assert.strictEqual(out, junk);
});

// ── _extractBase64FromUrl:抽 data URL / 裸 base64 ──
test('_extractBase64FromUrl:data URL → {mimeType,base64};非法 → null', () => {
  const p = _extractBase64FromUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
  assert.ok(p && p.base64 === TINY_PNG_BASE64 && p.mimeType === 'image/png');
  assert.strictEqual(_extractBase64FromUrl('https://example.com/a.png'), null);
  assert.strictEqual(_extractBase64FromUrl(''), null);
  assert.strictEqual(_extractBase64FromUrl(null), null);
  assert.strictEqual(_extractBase64FromUrl('short'), null);
});

// ── downscaleImageBlocksInMessages:真正命中路径(图在 body.messages 里)──
test('downscaleImageBlocksInMessages:非视觉模型 / 门控关 → 0 且不 mutate', () => {
  const mk = () => [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } },
    { type: 'text', text: 'hi' },
  ] }];
  const m1 = mk();
  assert.strictEqual(downscaleImageBlocksInMessages('gpt-4o', m1, {}), 0);
  const m2 = mk();
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', m2, { KHY_GLM_VISION_IMAGE_DOWNSCALE: '0' }), 0);
});

test('downscaleImageBlocksInMessages:预算内小图 → 0(不改 url)', () => {
  const url = `data:image/png;base64,${TINY_PNG_BASE64}`;
  const msgs = [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }];
  const n = downscaleImageBlocksInMessages('glm-4v-flash', msgs, {});
  assert.strictEqual(n, 0);
  assert.strictEqual(msgs[0].content[0].image_url.url, url, '1x1 图在预算内,url 不该被改');
});

test('downscaleImageBlocksInMessages:绝不抛(怪异 content / 缺块)', () => {
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', null, {}), 0);
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', [], {}), 0);
  const weird = [
    { role: 'system', content: 'plain string' },
    { role: 'user', content: [null, { type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'not-a-data-url' } }] },
    {},
  ];
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', weird, {}), 0);
});

test('downscaleImageBlocksInMessages:识别 image_url(字符串)/input_image/Anthropic image 三种形状', () => {
  // 均为预算内小图 → 计 0,但走通三条识别分支不抛。
  const url = `data:image/png;base64,${TINY_PNG_BASE64}`;
  const msgs = [
    { role: 'user', content: [{ type: 'image_url', image_url: url }] },              // 字符串变体
    { role: 'user', content: [{ type: 'input_image', image_url: url }] },            // Responses API
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } }] }, // Anthropic
  ];
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', msgs, {}), 0);
});
