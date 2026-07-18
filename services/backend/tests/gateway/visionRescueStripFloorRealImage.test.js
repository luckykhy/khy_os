'use strict';

/**
 * visionRescueStripFloorRealImage.test.js — 用**真实图片 + 真实 tesseract** 核验 OPS-122
 * post-failure 救援网的「剥图 ⟹ 必留痕」不变量:当前模型被判**支持视觉**(gpt-4o → keep,图保留
 * 到主级联),运行时某适配器以 404/model_not_found **拒图** → shouldOcrRescue 提升为 _visionFallback
 * → 救援网退回本地**真实** OCR。喂一张**无文字**真实图片(纯色/渐变画布,真 tesseract 读**空**)→
 * 救援网 OCR 无文本 → **修复点**:剥图 + 注入「我收到了你的图片,但当前通道读不出它的内容——绝不能
 * 说没有收到图片」,由下游文本适配器据实作答,绝不谎称「消息里没有附带图片」。
 *
 * 与 wiring 测试(DI 桩控 OCR 明细)互补:此处走**真实** OCR 提取(经生产镜像 extractor:真图携
 * base64 → imageService.saveBase64ToTemp → ocrSnippetService.extractImageOcrSnippet → 真 tesseract),
 * 证明「无文字真图 → 真实 OCR 读空 → 救援网剥图 + 留痕」这条真实链路闭合。
 *
 * 关键差异(vs Site1 OPS-120 真图测):救援网前置条件是 OCR 功能门 KHY_VISION_OCR_FALLBACK **开**
 * (否则 shouldOcrRescue 恒 false,_visionFallback 不触发);故此处注入的是原 buildVisionUnreadableNote,
 * 由独立门 KHY_VISION_RESCUE_STRIP_FLOOR 决定「OCR 无文本时是否剥图 + 留痕」。
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

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_VISION_STRIP_IMAGE_FLOOR', 'KHY_VISION_RESCUE_STRIP_FLOOR']);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息', model: 'gpt-4o', tag: 'real-rescue-floor' });

let rec;

let _tmpDir = null;
let _blankB64 = null;
let _skip = false;

describe('真实无文字图 + 真 tesseract 读空 + post-failure 救援网 → 剥图必留痕(OPS-122)', () => {
  before(() => {
    env.save();
    const py = h.findPython();
    if (!py || !h.haveTesseractLang()) { _skip = true; return; }
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-rescue-floor-'));
    const pngPath = path.join(_tmpDir, 'blank.png');
    // 渲一张**无文字**的纯色画布 → 真 tesseract 读空 → 救援网 OCR 无文本分支。
    const r = h.renderPng(py, {
      outPath: pngPath,
      size: [320, 200],
      bg: [120, 150, 180],
      texts: [],
    });
    if (r.missingPil || !r.exists) { _skip = true; return; }
    _blankB64 = fs.readFileSync(pngPath).toString('base64');

    // gpt-4o=keep(视觉可用)→ 图保留到主级联,404 拒图发生在运行时 → 救援网。
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    delete process.env.KHY_VISION_FALLBACK_MODEL;
    // 救援网前置条件:OCR 功能门开(默认),否则 shouldOcrRescue 恒 false。
    delete process.env.KHY_VISION_OCR_FALLBACK;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
  });
  after(() => {
    env.restore();
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: undefined, collectProviderSiblingModels: undefined });
    if (_tmpDir) { try { fs.rmSync(_tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('修复点:真实无文字图 + 真 tesseract 空 + 救援网触发 → 剥图 + 留痕,下游文本适配器据实作答', async (t) => {
    if (_skip) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    // 先证真 tesseract 对这张图确实读空(否则会落 OCR-文本分支,测的不是本轮断桥)。
    const realDetails = h.realExtractImageOcrDetails([{ base64: _blankB64, mimeType: 'image/png' }]);
    if (realDetails.length > 0) { t.skip('本机 tesseract 从无文字图读出了文本,无法制造 OCR-空场景'); return; }

    delete process.env.KHY_VISION_RESCUE_STRIP_FLOOR; // 救援底线门默认开
    rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true });
    h.wireCascade(h.makeRejectAdapter(), rec);
    const res = await runner.run({ images: [{ base64: _blankB64, mimeType: 'image/png' }] });
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:救援网 OCR 无文本时,下游非视觉适配器永不收到裸图');
    assert.match(rec.finalPrompt || '', /\[图像无法读取\]/, '真实链路:救援网剥图同时留下「图收到但读不出」痕迹');
    assert.match(rec.finalPrompt || '', /绝不能说没有收到图片/, '堵「消息里没有附带图片」幻觉');
  });

  test('门关(KHY_VISION_RESCUE_STRIP_FLOOR=off) → 逐字节回退(裸图存活到下游,无痕)', async (t) => {
    if (_skip) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    const realDetails = h.realExtractImageOcrDetails([{ base64: _blankB64, mimeType: 'image/png' }]);
    if (realDetails.length > 0) { t.skip('本机 tesseract 从无文字图读出了文本'); return; }

    process.env.KHY_VISION_RESCUE_STRIP_FLOOR = 'off';
    rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true });
    h.wireCascade(h.makeRejectAdapter(), rec);
    const res = await runner.run({ images: [{ base64: _blankB64, mimeType: 'image/png' }] });
    assert.equal(res.success, true);
    assert.ok(Array.isArray(rec.finalImages) && rec.finalImages.length > 0, '门关:裸图存活到下游(逐字节回退历史行为)');
    assert.doesNotMatch(rec.finalPrompt || '', /\[图像无法读取\]/, '门关:不注入底线(逐字节回退)');
  });
});
