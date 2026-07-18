'use strict';

/**
 * ocrUsageDisclosureRealImage.test.js — 用**真实文字图 + 真实 tesseract** 核验 OPS-MAN-123 的
 * 「OCR 成功 ⟹ 无感明显告知用户用了 OCR」不变量,直击本轮目标「Khy 降级到 OCR,要能无感明显告知
 * 用户用了 OCR 但正确识别图片」。
 *
 * 链路:当前模型被判**支持视觉**(gpt-4o → keep,图保留到主级联),运行时某适配器以 404/model_not_found
 * **拒图** → shouldOcrRescue 提升为 _visionFallback → 救援网退回本地**真实** OCR。喂一张**含文字**真实
 * 图片(PIL 渲 'INVOICE 1234'),真 tesseract **读出文字** → 救援网 OCR 成功分支:注入 OCR 文本 + **无
 * 条件**追加「用了 OCR」披露 → 下游文本适配器据 OCR 文本作答,且被要求向用户明确说明用了 OCR。
 *
 * 与 wiring 测试(DI 桩控 OCR 明细)互补:此处走**真实** OCR 提取(生产镜像 extractor:真图携 base64
 * → imageService.saveBase64ToTemp → ocrSnippetService.extractImageOcrSnippet → 真 tesseract),证明
 * 「含文字真图 → 真实 OCR 读出 → 注入文本 + 披露」这条真实链路闭合。
 *
 *   修复点:披露门开(默认) → prompt 同含 OCR 读出的文字(/INVOICE/)+ 披露指令(/通过 OCR 文字识别读取/);
 *   门关:KHY_OCR_USAGE_DISCLOSURE=off → 逐字节回退(仍含 OCR 文字,但无披露指令)。
 *
 * 缺 tesseract/eng 字库/Pillow,或本机 tesseract 未能从该图读出目标词 → skip(不误判红)。
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

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_OCR_USAGE_DISCLOSURE']);
const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'gpt-4o', tag: 'real-usage' });

let rec;

let _tmpDir = null;
let _textB64 = null;
let _skip = false;
let _readsText = false;

describe('真实文字图 + 真 tesseract 读出 + OCR 成功 → 无感明显告知用户用了 OCR(OPS-MAN-123)', () => {
  before(() => {
    env.save();
    const py = h.findPython();
    if (!py || !h.haveTesseractLang()) { _skip = true; return; }
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-usage-'));
    const pngPath = path.join(_tmpDir, 'invoice.png');
    // 渲一张**含清晰文字**的图 → 真 tesseract 读出 'INVOICE 1234' → 救援网 OCR 成功分支。
    const r = h.renderPng(py, {
      outPath: pngPath,
      size: [520, 180],
      bg: [255, 255, 255],
      texts: [{ xy: [30, 50], text: 'INVOICE 1234', fill: [0, 0, 0] }],
      fontSize: 72,
    });
    if (r.missingPil || !r.exists) { _skip = true; return; }
    _textB64 = fs.readFileSync(pngPath).toString('base64');

    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    delete process.env.KHY_VISION_FALLBACK_MODEL;
    delete process.env.KHY_VISION_OCR_FALLBACK; // 救援网前置:OCR 功能门开(默认)
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });

    // 先证真 tesseract 确能从该图读出 INVOICE(否则落 OCR-空分支,测不到本轮成功路径)。
    const d = h.realExtractImageOcrDetails([{ base64: _textB64, mimeType: 'image/png' }]);
    _readsText = d.length > 0 && /INVOICE/i.test(d.map((x) => x.text).join(' '));
  });
  after(() => {
    env.restore();
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: undefined, collectProviderSiblingModels: undefined });
    if (_tmpDir) { try { fs.rmSync(_tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('修复点:真文字图 + 真 tesseract 读出 + 披露门开 → prompt 同含 OCR 文字 + 披露指令,下游据实作答', async (t) => {
    if (_skip) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    if (!_readsText) { t.skip('本机 tesseract 未从该图读出 INVOICE,无法制造 OCR-成功场景'); return; }

    delete process.env.KHY_OCR_USAGE_DISCLOSURE; // 默认开
    rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true });
    h.wireCascade(h.makeRejectAdapter(), rec);
    const res = await runner.run({ images: [{ base64: _textB64, mimeType: 'image/png' }] });
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:OCR 成功后下游收到剥图后的纯文本');
    assert.match(rec.finalPrompt || '', /INVOICE/i, '真实链路:真 tesseract 读出的文字进入 prompt(准确识别)');
    assert.match(rec.finalPrompt || '', /通过 OCR 文字识别读取/, '修复:无条件追加面向用户的「用了 OCR」披露(明显告知)');
    assert.match(rec.finalPrompt || '', /向用户明确说明/, '修复:指令模型主动向用户说明用了 OCR');
  });

  test('门关(KHY_OCR_USAGE_DISCLOSURE=off) → 逐字节回退(仍含 OCR 文字,但无披露指令)', async (t) => {
    if (_skip) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    if (!_readsText) { t.skip('本机 tesseract 未从该图读出 INVOICE'); return; }

    process.env.KHY_OCR_USAGE_DISCLOSURE = 'off';
    rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true });
    h.wireCascade(h.makeRejectAdapter(), rec);
    const res = await runner.run({ images: [{ base64: _textB64, mimeType: 'image/png' }] });
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /INVOICE/i, '门关:OCR 文字照旧读出并注入(能力不受影响)');
    assert.doesNotMatch(rec.finalPrompt || '', /通过 OCR 文字识别读取/, '门关:不注入披露(逐字节回退历史行为)');
  });
});
