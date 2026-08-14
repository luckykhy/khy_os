'use strict';

/**
 * recognizeImage.defaultModel.test.js — 锁死识图工具默认视觉模型的池限定 pin 修复。
 *
 * /goal「图像发送后为什么直接 404」根因:工具默认发**裸** `glm-4.6v-flash`,该 id 已被判视觉
 * → 视觉路由 keep、从不改道 GLM 池 → 裸 id 落到当前激活的自定义 `api` 池 → 上游无此模型 →
 * `model_not_found` 404。修复:默认改用带 `glm/` 前缀的池限定 pin(门控 KHY_RECOGNIZE_IMAGE_POOL_PIN,
 * 默认开;关 → 逐字节回退裸 id)。显式 model 参数始终优先。
 *
 * 经工具 execute → 注入的 _impl.recognize 捕获实际下发的 model(不触真网关)。node:test。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const tool = require('../../src/tools/recognizeImage');
const impl = globalThis[Symbol.for('khyos.recognizeImage.__impl')];

// 让工具跳过真实读图,并捕获最终下发给网关的 model。
function stubCapture() {
  const calls = [];
  impl.normalizeImageInput = () => ({ image: { url: 'https://example.com/x.png' } });
  impl.recognize = async ({ model }) => { calls.push(model); return { success: true, text: 'ok', model }; };
  return calls;
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  return (async () => {
    try { return await fn(); }
    finally {
      if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
    }
  })();
}

test('default model is the pool-qualified pin (glm/glm-4.6v-flash) when gate default-on', async () => {
  await withEnv('KHY_RECOGNIZE_IMAGE_POOL_PIN', undefined, async () => {
    const calls = stubCapture();
    await tool.execute({ image: 'https://example.com/x.png' });
    assert.strictEqual(calls[0], 'glm/glm-4.6v-flash');
  });
});

test('gate OFF (KHY_RECOGNIZE_IMAGE_POOL_PIN=0) → byte-revert to bare glm-4.6v-flash', async () => {
  await withEnv('KHY_RECOGNIZE_IMAGE_POOL_PIN', '0', async () => {
    const calls = stubCapture();
    await tool.execute({ image: 'https://example.com/x.png' });
    assert.strictEqual(calls[0], 'glm-4.6v-flash');
  });
});

test('explicit model param always overrides the default (both gate states)', async () => {
  for (const gate of [undefined, '0']) {
    await withEnv('KHY_RECOGNIZE_IMAGE_POOL_PIN', gate, async () => {
      const calls = stubCapture();
      await tool.execute({ image: 'https://example.com/x.png', model: 'my/custom-vlm' });
      assert.strictEqual(calls[0], 'my/custom-vlm');
    });
  }
});
