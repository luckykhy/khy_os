'use strict';

/**
 * visionDescribeFailFloorRealImage.test.js — 用**一张真实图片**端到端核验 2026-07-12 修复:
 * 「纯文本模型 + 视觉模型全 404 + 失败说明门关」这一**用户实测失败配置**下,khy 仍**可靠落到
 * 真 OCR 路径**、读出真实图片文字、由**原文本模型**据此作答——不再把图留给已 404 的视觉模型、
 * 不再让模型谎称「消息里没有附带图片」。直击 /goal「能在没有识别图形的模型下,准确识别图片」。
 *
 * 真链路:真 PIL 渲染带文字 PNG → describe-and-return 级联对 pinned 视觉模型识图(桩:恒 404)→
 * 全部失败 → 底线门(KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR default-on)触发 → 真 ocrSnippetService →
 * 真 docHelper.py → 真 tesseract 读出 "INVOICE" → 注入最终 prompt,剥图,原文本模型作答。
 *
 * 关键:extractImageOcrDetails 用**真实**实现(经 _filePath 走真 tesseract),非 DI 桩;
 * KHY_VISION_FAILURE_SUMMARY='off' 正是用户失败现象里的配置(说明门关时底线曾被一并跳过)。
 *
 * 可移植性:缺 tesseract / 缺 eng 语言包 / 缺带 Pillow 的 Python → test.skip 干净跳过,绝不假失败。
 *
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

function _renderInvoicePng(py, outPath) {
  const r = h.renderPng(py, {
    outPath,
    size: [520, 140],
    bg: [255, 255, 255],
    texts: [{ xy: [14, 18], text: 'INVOICE ACME 2026', fill: [0, 0, 0] }],
    fontSize: 44,
  });
  return !r.missingPil && r.exists;
}

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_VISION_INTERMEDIATE_MESSAGE']);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'real-floor' });

let rec;

describe('真实图片:纯文本模型 + 视觉全 404 + 失败说明关 → 仍落真 OCR、准确识别、原文本模型作答', () => {
  let py = null;
  let tmpDir = null;
  let pngB64 = null;
  let ready = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash';
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    if (!h.haveTesseractLang('eng')) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-floor-real-'));
    const pngPath = path.join(tmpDir, 'invoice.png');
    if (!_renderInvoicePng(py, pngPath)) return;
    pngB64 = fs.readFileSync(pngPath).toString('base64'); // 图从对话到达时携 base64
    ready = true;
  });

  after(() => {
    env.restore();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('失败说明关(用户失败配置)下,真 tesseract 读出 INVOICE 并注入,剥图,原文本模型作答', async (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off';        // 用户失败现象里的配置
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR; // 底线门默认开(修复)
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: h.realExtractImageOcrDetails, // 真 OCR,非桩
      collectProviderSiblingModels: () => [],
    });
    rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);

    const res = await runner.run({ images: [{ base64: pngB64, mimeType: 'image/png' }] });

    assert.equal(res.success, true, '应成功作答');
    const stripped = Array.isArray(rec.finalImages) ? rec.finalImages.length === 0 : !rec.finalImages;
    assert.ok(stripped, '不变量:非视觉模型永不收到裸图');
    assert.equal(res.model, 'text-only-model', '由原文本模型作答,绝不切到已 404 的视觉模型');
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, '真 OCR 应准确读出 INVOICE 并注入 prompt');
    assert.match(rec.finalPrompt || '', /以下为图片 OCR 识别文本/, '应走 OCR 文本注入(而非「读不出」底线)');
  });
});
