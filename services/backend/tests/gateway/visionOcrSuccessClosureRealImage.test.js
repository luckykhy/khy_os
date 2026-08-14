'use strict';

/**
 * visionOcrSuccessClosureRealImage.test.js — 用**真实图片**端到端核验 OPS-MAN-144
 * 「describe-fail → OCR-成功的用户可见闭合」(无感明显告知用了 OCR + 闭合悬空「请稍候」承诺)。
 *
 * 真链路:真 PIL 渲染含字 PNG → describe-and-return 级联对 pinned 视觉模型识图(桩:恒 404 全失败)→
 * 走本地 OCR 兜底 → 真 ocrSnippet/docHelper.py/tesseract **读出文字** → 断言:
 *   A) 发一条闭合 assistant_message(含「视觉模型均不可用」+「本地 OCR 成功识别」),
 *      且 finalPrompt 真含 OCR 文本(INVOICE)→ 证「真图 OCR 成功救回时无感明显告知用了 OCR」;
 *   B) 闭合门关 → 无闭合(byte-revert),OCR 注入照常。
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

const CLOSURE = /视觉模型均不可用[\s\S]*本地 OCR 成功识别/;
const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_SUCCESS_CLOSURE',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
]);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'real-closure' });

function runCaptureMsgs(images) {
  const msgs = [];
  return runner.run({
    images,
    onChunk: (c) => { if (c && c.type === 'assistant_message' && c.content) msgs.push(String(c.content)); },
  }).then((res) => ({ res, msgs }));
}

describe('真实图片:OCR 成功兜底时发用户可见闭合(OPS-144)', () => {
  let py = null;
  let tmpDir = null;
  let textB64 = null;
  let ready = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash';
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off'; // 隔离:只观察闭合
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    if (!h.haveTesseractLang('eng')) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-closure-'));
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

  test('A) 含字图 → 真 tesseract 读出 INVOICE → 发 OCR 成功闭合', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, msgs } = await runCaptureMsgs([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, '真 OCR 读出 INVOICE 并注入');
    assert.ok(msgs.some((m) => CLOSURE.test(m)), '真图 OCR 成功救回时发一条无感明显的 OCR 闭合');
  });

  test('B) 闭合门关 → 无闭合(byte-revert),OCR 注入照常', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    process.env.KHY_VISION_OCR_SUCCESS_CLOSURE = 'off';
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, msgs } = await runCaptureMsgs([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, 'OCR 注入不受门影响');
    assert.ok(!msgs.some((m) => CLOSURE.test(m)), '门关不发闭合(byte-revert)');
  });
});
