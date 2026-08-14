'use strict';

/**
 * ocrUsageFootnoteRealImage.test.js — 用**真实文字图 + 真实 tesseract** 核验 OPS-MAN-126 的
 * 「OCR 成功 + 模型不提 OCR ⟹ 确定性追加用户可见脚注」不变量,直击本轮目标「Khy 降级到 OCR,
 * 要能无感明显告知用户用了 OCR 但正确识别图片」。
 *
 * 链路:当前模型被判**支持视觉**(gpt-4o → keep,图保留到主级联),运行时某适配器以 404/model_not_found
 * **拒图** → shouldOcrRescue 提升为 _visionFallback → 救援网退回本地**真实** OCR。喂一张**含文字**真实
 * 图片(PIL 渲 'INVOICE 1234'),真 tesseract **读出文字** → 救援网 OCR 成功分支置 _ocrImageTextRead →
 * 下游文本适配器据 OCR 文本作答但**不提 OCR**(模拟模型忽略 OPS-124 指令)→ finishResult 确定性
 * 追加「用了 OCR」脚注到 result.content。
 *
 * 与 wiring 测试(DI 桩控 OCR 明细)互补:此处走**真实** OCR 提取(生产镜像 extractor:真图携 base64
 * → imageService.saveBase64ToTemp → ocrSnippetService.extractImageOcrSnippet → 真 tesseract),证明
 * 「含文字真图 → 真实 OCR 读出 → 作答不提 OCR → 确定性脚注兜底」这条真实链路闭合。
 *
 *   修复点:脚注门开(默认) → prompt 含真 OCR 读出的文字(/INVOICE/)且 res.content 末尾出现确定性脚注;
 *   门关:KHY_OCR_USAGE_FOOTNOTE=off → 逐字节回退(res.content 无脚注)。
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
const ouf = require(BE + '/src/services/gateway/ocrUsageFootnote');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_OCR_USAGE_FOOTNOTE']);
const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'gpt-4o', tag: 'real-footnote' });

let rec;

let _tmpDir = null;
let _textB64 = null;
let _skip = false;
let _readsText = false;

describe('真实文字图 + 真 tesseract 读出 + OCR 成功 + 答复不提 OCR → 确定性脚注兜底(OPS-MAN-126)', () => {
  before(() => {
    env.save();
    const py = h.findPython();
    if (!py || !h.haveTesseractLang()) { _skip = true; return; }
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-footnote-'));
    const pngPath = path.join(_tmpDir, 'invoice.png');
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

    const d = h.realExtractImageOcrDetails([{ base64: _textB64, mimeType: 'image/png' }]);
    _readsText = d.length > 0 && /INVOICE/i.test(d.map((x) => x.text).join(' '));
  });
  after(() => {
    env.restore();
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: undefined, collectProviderSiblingModels: undefined });
    if (_tmpDir) { try { fs.rmSync(_tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('修复点:真文字图 + 真 tesseract 读出 + 答复不提 OCR + 脚注门开 → res.content 末尾出现确定性脚注', async (t) => {
    if (_skip) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    if (!_readsText) { t.skip('本机 tesseract 未从该图读出 INVOICE,无法制造 OCR-成功场景'); return; }

    delete process.env.KHY_OCR_USAGE_FOOTNOTE; // 默认开
    rec = h.makeRecordingAdapter({ content: '发票编号是 1234' });
    h.wireCascade(h.makeRejectAdapter(), rec);
    const res = await runner.run({ images: [{ base64: _textB64, mimeType: 'image/png' }] });
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /INVOICE/i, '真实链路:真 tesseract 读出的文字进入 prompt(准确识别)');
    assert.ok(String(res.content || '').includes(ouf.OCR_USAGE_FOOTNOTE_MARKER), '修复:答复不提 OCR → 确定性追加用户可见脚注(明显告知)');
    assert.match(res.content || '', /本地 OCR 文字识别读取/, '脚注措辞明确「用了 OCR」');
    assert.match(res.content || '', /发票编号是 1234/, '原答复正文保留,脚注仅追加末尾');
  });

  test('门关(KHY_OCR_USAGE_FOOTNOTE=off) → 逐字节回退(res.content 无脚注)', async (t) => {
    if (_skip) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    if (!_readsText) { t.skip('本机 tesseract 未从该图读出 INVOICE'); return; }

    process.env.KHY_OCR_USAGE_FOOTNOTE = 'off';
    rec = h.makeRecordingAdapter({ content: '发票编号是 1234' });
    h.wireCascade(h.makeRejectAdapter(), rec);
    const res = await runner.run({ images: [{ base64: _textB64, mimeType: 'image/png' }] });
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /INVOICE/i, '门关:OCR 文字照旧读出并注入(能力不受影响)');
    assert.equal(res.content, '发票编号是 1234', '门关:res.content 逐字节不变(无脚注)');
  });
});
