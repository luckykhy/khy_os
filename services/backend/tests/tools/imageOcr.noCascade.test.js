'use strict';

/**
 * imageOcr.noCascade.test.js — imageOcr tool no longer cascades into the gateway
 * when no vision model exists, and bounds the vision call (node:test).
 *
 * Goal「不要一识别图片就网络中断就失败,导致接下来换那个模型都是失败」:
 *  - 无视觉模型 + 本地有文字 → 直接用本地 OCR,**绝不调 aiVisionOcr**(不重入网关→不级联)。
 *  - 无视觉模型 + 本地无文字 → 诚实失败,**绝不调 aiVisionOcr**。
 *  - 有视觉模型 + 本地不充分 → 单次 aiVisionOcr。
 *  - 门控关 → 逐字节回退到旧路径(本地失败即无条件 aiVisionOcr)。
 *
 * 经 Symbol.for('khyos.imageOcr.__impl') 注入入口 stub runPython / aiVisionOcr /
 * computeVisionAvailable,避免真起 python / 真打网关。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const imageOcr = require('../../src/tools/imageOcr');
const impl = globalThis[Symbol.for('khyos.imageOcr.__impl')];
const _orig = { ...impl };

// 一个真实存在、扩展名受支持的临时图片(execute 会 fs.existsSync + 校验扩展名)。
let _imgPath;
test.before(() => {
  _imgPath = path.join(os.tmpdir(), `khy-ocr-test-${process.pid}.png`);
  fs.writeFileSync(_imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic, 内容无关(已 stub OCR)
});
test.after(() => {
  Object.assign(impl, _orig);
  try { fs.unlinkSync(_imgPath); } catch { /* ignore */ }
  delete process.env.KHY_IMAGE_OCR_NO_CASCADE;
});

function reset(overrides) {
  Object.assign(impl, _orig, overrides);
}

test('no vision model + local has text → use-local, NEVER calls aiVisionOcr', async () => {
  delete process.env.KHY_IMAGE_OCR_NO_CASCADE; // default on
  let visionCalls = 0;
  reset({
    computeVisionAvailable: () => false,
    runPython: async () => ({ success: true, text: 'HELLO 你好', confidence: 88, lang: 'chi_sim+eng' }),
    aiVisionOcr: async () => { visionCalls++; return { success: true, text: 'should-not-happen' }; },
  });
  const r = await imageOcr.execute({ imagePath: _imgPath });
  assert.equal(visionCalls, 0, 'must NOT cascade into gateway vision');
  assert.equal(r.success, true);
  assert.equal(r.method, 'tesseract');
  assert.match(r.text, /HELLO/);
  assert.match(String(r.note || ''), /本地 OCR/);
});

test('no vision model + local NO text → fail-honest, NEVER calls aiVisionOcr', async () => {
  delete process.env.KHY_IMAGE_OCR_NO_CASCADE;
  let visionCalls = 0;
  reset({
    computeVisionAvailable: () => false,
    runPython: async () => ({ success: false, needsAiFallback: true }),
    aiVisionOcr: async () => { visionCalls++; return { success: true, text: 'nope' }; },
  });
  const r = await imageOcr.execute({ imagePath: _imgPath });
  assert.equal(visionCalls, 0, 'must NOT cascade into gateway vision');
  assert.equal(r.success, false);
  assert.equal(r.method, 'none');
  assert.match(String(r.error || r.content || ''), /khy gateway model|视觉模型/);
});

test('vision available + local insufficient → single bounded aiVisionOcr call', async () => {
  delete process.env.KHY_IMAGE_OCR_NO_CASCADE;
  let visionCalls = 0;
  let lastOpts = null;
  reset({
    computeVisionAvailable: () => true,
    runPython: async () => ({ success: false, needsAiFallback: true }),
    aiVisionOcr: async (_p, opts) => { visionCalls++; lastOpts = opts; return { success: true, text: 'VISION OK', method: 'ai_vision' }; },
  });
  const r = await imageOcr.execute({ imagePath: _imgPath });
  assert.equal(visionCalls, 1, 'exactly one vision attempt');
  assert.ok(lastOpts && Number(lastOpts.totalMs) > 0, 'vision call must carry a bounded totalMs');
  assert.equal(r.success, true);
  assert.match(r.text, /VISION OK/);
});

test('gate OFF → legacy cascade (local fail → aiVisionOcr) regardless of vision', async () => {
  process.env.KHY_IMAGE_OCR_NO_CASCADE = 'off';
  let visionCalls = 0;
  let visionUnbounded = false;
  reset({
    computeVisionAvailable: () => { throw new Error('must not be consulted when gate off'); },
    runPython: async () => ({ success: false, needsAiFallback: true }),
    aiVisionOcr: async (_p, opts) => { visionCalls++; visionUnbounded = (opts === undefined); return { success: true, text: 'LEGACY' }; },
  });
  const r = await imageOcr.execute({ imagePath: _imgPath });
  assert.equal(visionCalls, 1, 'legacy path still cascades to vision');
  assert.equal(visionUnbounded, true, 'legacy path passes no totalMs (byte-revert)');
  assert.equal(r.success, true);
});

test('forceAi + vision available → straight to vision, no local OCR run', async () => {
  delete process.env.KHY_IMAGE_OCR_NO_CASCADE;
  let localCalls = 0;
  let visionCalls = 0;
  reset({
    computeVisionAvailable: () => true,
    runPython: async () => { localCalls++; return { success: true, text: 'local' }; },
    aiVisionOcr: async () => { visionCalls++; return { success: true, text: 'FORCED VISION' }; },
  });
  const r = await imageOcr.execute({ imagePath: _imgPath, forceAi: true });
  assert.equal(localCalls, 0, 'forceAi+vision skips local OCR');
  assert.equal(visionCalls, 1);
  assert.match(r.text, /FORCED VISION/);
});
