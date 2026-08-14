'use strict';

/**
 * visionStripImageFloorRealImage.test.js — 用**真实图片 + 真实 tesseract** 核验 OPS-120
 * 「剥图 ⟹ 必留『图收到但读不出』痕迹」不变量:纯文本模型收到一张**无文字**的真实图片
 * (照片/纯色画布,真实 tesseract 读**空**),且用户把 OCR 兜底功能门 KHY_VISION_OCR_FALLBACK
 * **关掉** → 描述级联全失败落 else 分支 → 原 buildVisionUnreadableNote 因功能门关返 null →
 * **最小底线**兜住:剥图 + 注入「我收到了你的图片,但当前通道读不出它的内容——绝不能说没有收到
 * 图片」,由**原文本模型**作答,绝不谎称「消息里没有附带图片」。
 *
 * 与 wiring 测试(DI 桩控 OCR 明细)互补:此处走**真实** OCR 提取(经生产镜像 extractor:
 * 真图携 base64 → imageService.saveBase64ToTemp → ocrSnippetService.extractImageOcrSnippet →
 * 真 tesseract),证明「无文字真图 → 真实 OCR 读空 → 最小底线登场」这条真实链路闭合。
 *
 * 缺 tesseract/eng 字库/Pillow → skip(不误判红)。
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

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_VISION_STRIP_IMAGE_FLOOR']);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息', model: 'text-only-model', tag: 'real-strip-floor' });

let rec;

let _tmpDir = null;
let _blankB64 = null;
let _skip = false;

describe('真实图片(无文字)+ 真 tesseract 读空 + OCR 功能门关 → 最小底线兜住剥图(OPS-120)', () => {
  before(() => {
    env.save();
    const py = h.findPython();
    if (!py || !h.haveTesseractLang()) { _skip = true; return; }
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-strip-floor-'));
    const pngPath = path.join(_tmpDir, 'blank.png');
    // 渲一张**无文字**的纯色画布 → 真 tesseract 读空 → 落 else 分支(OCR 无文本)。
    const r = h.renderPng(py, {
      outPath: pngPath,
      size: [320, 200],
      bg: [120, 150, 180],
      texts: [],
    });
    if (r.missingPil || !r.exists) { _skip = true; return; }
    _blankB64 = fs.readFileSync(pngPath).toString('base64');

    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash';
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    process.env.KHY_VISION_FAILURE_SUMMARY = '1';
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
  });
  after(() => {
    env.restore();
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: undefined, collectProviderSiblingModels: undefined });
    if (_tmpDir) { try { fs.rmSync(_tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('修复点:真实无文字图 + 真 tesseract 空 + OCR 功能门关 → 剥图 + 最小底线,原文本模型作答', async (t) => {
    if (_skip) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    // 先证真 tesseract 对这张图确实读空(否则会落 OCR-文本分支,测的不是本轮断桥)。
    const realDetails = h.realExtractImageOcrDetails([{ base64: _blankB64, mimeType: 'image/png' }]);
    if (realDetails.length > 0) { t.skip('本机 tesseract 从无文字图读出了文本,无法制造 OCR-空场景'); return; }

    process.env.KHY_VISION_OCR_FALLBACK = 'off';      // 用户关掉 OCR 兜底功能(制造原说明缺席)
    delete process.env.KHY_VISION_STRIP_IMAGE_FLOOR;  // 最小底线门默认开
    rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const res = await runner.run({ images: [{ base64: _blankB64, mimeType: 'image/png' }] });
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.equal(res.model, 'text-only-model', '由原文本模型作答');
    assert.match(rec.finalPrompt || '', /\[图像无法读取\]/, '真实链路:原 OCR 说明缺席时最小底线兜住');
    assert.match(rec.finalPrompt || '', /绝不能说没有收到图片/, '堵「消息里没有附带图片」幻觉');
  });

  test('门关(KHY_VISION_STRIP_IMAGE_FLOOR=off)+ OCR 功能门关 → 逐字节回退(剥图无痕)', async (t) => {
    if (_skip) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    const realDetails = h.realExtractImageOcrDetails([{ base64: _blankB64, mimeType: 'image/png' }]);
    if (realDetails.length > 0) { t.skip('本机 tesseract 从无文字图读出了文本'); return; }

    process.env.KHY_VISION_OCR_FALLBACK = 'off';
    process.env.KHY_VISION_STRIP_IMAGE_FLOOR = 'off';
    rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const res = await runner.run({ images: [{ base64: _blankB64, mimeType: 'image/png' }] });
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '门关:仍剥图(该分支剥图本就无条件)');
    assert.doesNotMatch(rec.finalPrompt || '', /\[图像无法读取\]/, '门关:不注入底线(逐字节回退)');
  });
});
