'use strict';

/**
 * ocrRescuePrepClosureDedupRealImage.test.js — 用**真实图片**端到端核验 OPS-MAN-148
 * 「Site1 prep-status 与 OCR-成功闭合的跨层去重」(减少显示的心灵噪音:同一 OCR 降级不发两遍永久公告)。
 *
 * 真链路:真 PIL 渲染含字 PNG → describe-and-return 级联(内置 GLM pin → ≥2 候选,桩恒 404 全失败)→
 * 走本地 OCR 兜底 → 真 ocrSnippet/docHelper.py/tesseract **读出文字** → 非 verbose,同时收 status
 * 与 assistant_message 两条流,断言:
 *   A) 去重门开(默认)→ **只有闭合**(assistant_message 含「视觉模型均不可用…本地 OCR 成功识别」),
 *      **无冗余 prep-status**(status 无「已降级用本地 OCR 成功提取」),finalPrompt 真含 INVOICE = 净 1 条公告;
 *   B) 去重门关 → prep-status 与闭合**并存**(byte-revert)= 2 条公告,finalPrompt 仍含 INVOICE。
 *
 * 可移植性:缺 tesseract / eng / Pillow → test.skip 干净跳过,绝不假失败。harness 统一自 `_ocrGatewayHarness`。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const PREP_RE = /已降级用本地 OCR 成功提取/;
const CLOSURE_RE = /视觉模型均不可用[\s\S]*本地 OCR 成功识别/;
const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_SUCCESS_CLOSURE',
  'KHY_OCR_RESCUE_STATUS_PREP', 'KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_STATUS_VERBOSITY',
]);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'real-prep-closure-dedup' });

function runCaptureBoth(images) {
  const statuses = [];
  const msgs = [];
  return runner.run({
    images,
    onChunk: (c) => {
      if (!c) return;
      if (c.type === 'status' && c.text) statuses.push(String(c.text));
      else if (c.type === 'assistant_message' && c.content) msgs.push(String(c.content));
    },
  }).then((res) => ({ res, statuses, msgs }));
}

describe('真实图片:Site1 prep/闭合跨层去重(OPS-148)', () => {
  let py = null;
  let tmpDir = null;
  let textB64 = null;
  let ready = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_CASCADE = 'on'; // 触发多候选级联 → Site1
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off'; // 隔离:只观察两条公告
    delete process.env.KHY_GLM_VISION_MODEL; // 默认开 → GLM pin 候选就绪
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    delete process.env.KHY_STATUS_VERBOSITY; // auto → 非 verbose(prep-status 才会发)
    if (!h.haveTesseractLang('eng')) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-prep-closure-'));
    const textPng = path.join(tmpDir, 'invoice.png');
    const rt = h.renderPng(py, { outPath: textPng, size: [520, 140], bg: [255, 255, 255], texts: [{ xy: [14, 18], text: 'INVOICE ACME 2026', fill: [0, 0, 0] }], fontSize: 44 });
    if (rt.missingPil || !rt.exists) return;
    textB64 = fs.readFileSync(textPng).toString('base64');
    ready = true;
  });

  after(() => {
    env.restore();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('A) 去重门开(默认)→ 只发闭合,无冗余 prep-status = 净 1 条公告', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    delete process.env.KHY_OCR_RESCUE_STATUS_PREP;
    delete process.env.KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP; // 默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, statuses, msgs } = await runCaptureBoth([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, '真 OCR 读出 INVOICE 并注入');
    assert.ok(msgs.some((m) => CLOSURE_RE.test(m)), '闭合仍发(明显告知用了 OCR)');
    assert.ok(!statuses.some((s) => PREP_RE.test(s)),
      `去重门开:冗余 prep-status 应被抑制;实收 status=${JSON.stringify(statuses)}`);
  });

  test('B) 去重门关 → prep-status 与闭合并存(byte-revert)= 2 条公告', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    delete process.env.KHY_OCR_RESCUE_STATUS_PREP;
    process.env.KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP = 'off';
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, statuses, msgs } = await runCaptureBoth([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, 'OCR 注入不受门影响');
    assert.ok(msgs.some((m) => CLOSURE_RE.test(m)), '门关:闭合照发');
    assert.ok(statuses.some((s) => PREP_RE.test(s)),
      `去重门关:prep-status 逐字节回退并存;实收 status=${JSON.stringify(statuses)}`);
  });
});
