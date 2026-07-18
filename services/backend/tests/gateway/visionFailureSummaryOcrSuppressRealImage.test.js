'use strict';

/**
 * visionFailureSummaryOcrSuppressRealImage.test.js — 用**真实图片**端到端核验 OPS-MAN-142
 * 「失败墙推迟到 OCR 结果已知后」(减少心灵噪音)。
 *
 * 真链路:真 PIL 渲染 PNG → describe-and-return 级联对 pinned 视觉模型识图(桩:恒 404)→ 全部失败 →
 * 失败墙原本无条件发射,现被推迟到 OCR 结果已知后:
 *   A) 含字图(INVOICE)→ 真 ocrSnippet/docHelper.py/tesseract **读出文字** → 失败墙**被抑制**
 *      (不甩给用户),只注入 OCR 文本 → 证「OCR 成功救回时不再自相矛盾地甩识别失败墙」;
 *   B) 无字彩块图 → 真 tesseract **读空** → 真失败 → 失败墙**照发**(用户仍需介入)。
 *
 * onChunk 捕获 emitAssistantMessage 发的失败墙(type:'assistant_message')判定其是否发射。
 * 可移植性:缺 tesseract / eng 语言包 / 带 Pillow 的 Python → test.skip 干净跳过,绝不假失败。
 * harness 统一自 `_ocrGatewayHarness`。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const WALL = /图像识别失败/;
const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS',
  'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_VISION_INTERMEDIATE_MESSAGE',
]);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'real-suppress' });

function runCaptureMsgs(images) {
  const msgs = [];
  return runner.run({
    images,
    onChunk: (c) => { if (c && c.type === 'assistant_message' && c.content) msgs.push(String(c.content)); },
  }).then((res) => ({ res, msgs }));
}

describe('真实图片:OCR 成功时失败墙被抑制 / OCR 读空时失败墙照发(OPS-142)', () => {
  let py = null;
  let tmpDir = null;
  let textB64 = null;
  let blankB64 = null;
  let ready = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash';
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    process.env.KHY_VISION_FAILURE_SUMMARY = '1'; // 父门开:有墙可谈
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    if (!h.haveTesseractLang('eng')) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fs-suppress-'));
    const textPng = path.join(tmpDir, 'invoice.png');
    const rt = h.renderPng(py, { outPath: textPng, size: [520, 140], bg: [255, 255, 255], texts: [{ xy: [14, 18], text: 'INVOICE ACME 2026', fill: [0, 0, 0] }], fontSize: 44 });
    if (rt.missingPil || !rt.exists) return;
    const blankPng = path.join(tmpDir, 'blank.png');
    const rb = h.renderPng(py, { outPath: blankPng, size: [200, 120], bg: [40, 90, 160], texts: [] }); // 无字彩块
    if (rb.missingPil || !rb.exists) return;
    textB64 = fs.readFileSync(textPng).toString('base64');
    blankB64 = fs.readFileSync(blankPng).toString('base64');
    ready = true;
  });

  after(() => {
    env.restore();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('A) 含字图 → 真 tesseract 读出 INVOICE → 失败墙被抑制,只注入 OCR 文本', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS; // 子门默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, msgs } = await runCaptureMsgs([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, '真 OCR 读出 INVOICE 并注入');
    assert.ok(!msgs.some((m) => WALL.test(m)), '修复:OCR 成功救回时那块识别失败墙被抑制,不甩给用户');
  });

  test('B) 无字彩块图 → 真 tesseract 读空 → 真失败 → 失败墙照发', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, msgs } = await runCaptureMsgs([{ base64: blankB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    // 无字图 OCR 读空(若本机 tesseract 竟从纯色块读出字则该断言让位——但通常读空)。
    if (/以下为图片 OCR 识别文本/.test(String(rec.finalPrompt || ''))) {
      t.skip('本机 tesseract 从无字彩块读出了文字,不构成 OCR 读空场景,跳过');
      return;
    }
    assert.ok(msgs.some((m) => WALL.test(m)), 'OCR 读空=真失败,失败墙照发(用户仍需介入)');
  });
});
