'use strict';

/**
 * visionDescribeFailFloorUserConfigRealImage.test.js — 用**一张真实文字图**端到端复现并核验
 * 2026-07-12 用户实测失败现象的**精确配置**下,khy 仍可靠落到真 OCR 路径、读出图片文字、
 * 由原文本模型据此作答,并**确定性**向用户披露「用了 OCR」。
 *
 * 用户实测配置(区别于 visionDescribeFailFloorRealImage 的最小配置):
 *   · KHY_VISION_INTERMEDIATE_MESSAGE = on  → 用户看到「正在调用 glm-4v-flash 进行识别,请稍候...」
 *   · KHY_VISION_FAILURE_SUMMARY      = on  → 用户看到大段「图像识别失败」诊断说明
 *   · 视觉候选恒 404(describeFails)         → 用户实测「404 model_not_found / socket hang up」
 * 历史失败:此配置下模型最终谎称「消息里没有附带图片」。修复后:底线门 default-on 触发真 OCR,
 * 读出 "INVOICE",注入 prompt,剥图,原文本模型作答,末尾**确定性脚注**明显告知用户用了 OCR。
 *
 * 真链路:真 PIL 渲染带文字 PNG → describe-and-return 级联对 pinned 视觉模型识图(桩:恒 404)→
 * 全部失败 → 底线门(KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR default-on)→ 真 ocrSnippetService →
 * 真 docHelper.py → 真 tesseract 读出 "INVOICE" → 注入最终 prompt,剥图,原文本模型作答;
 * 答复不提 OCR → finishResult 确定性追加用户可见脚注(KHY_OCR_USAGE_FOOTNOTE default-on)。
 *
 * 可移植性:缺 tesseract / 缺 eng 语言包 / 缺带 Pillow 的 Python / 本机未读出目标词 → test.skip。
 *
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂)。
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

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_OCR_USAGE_FOOTNOTE',
]);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'real-floor-userconf' });

let rec;

describe('用户实测配置(中间消息开 + 失败说明开 + 视觉全 404)→ 仍落真 OCR、准确识别、确定性告知用户用了 OCR', () => {
  let py = null;
  let tmpDir = null;
  let pngB64 = null;
  let ready = false;
  let readsText = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash';
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    if (!h.haveTesseractLang('eng')) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-floor-userconf-'));
    const pngPath = path.join(tmpDir, 'invoice.png');
    const r = h.renderPng(py, {
      outPath: pngPath,
      size: [520, 140],
      bg: [255, 255, 255],
      texts: [{ xy: [14, 18], text: 'INVOICE ACME 2026', fill: [0, 0, 0] }],
      fontSize: 44,
    });
    if (r.missingPil || !r.exists) return;
    pngB64 = fs.readFileSync(pngPath).toString('base64');
    const d = h.realExtractImageOcrDetails([{ base64: pngB64, mimeType: 'image/png' }]);
    readsText = d.length > 0 && /INVOICE/i.test(d.map((x) => x.text).join(' '));
    ready = true;
  });

  after(() => {
    env.restore();
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: undefined, collectProviderSiblingModels: undefined });
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('中间消息开 + 失败说明开下:真 tesseract 读出 INVOICE、剥图、原文本模型作答、末尾确定性 OCR 脚注', async (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    if (!readsText) { t.skip('本机 tesseract 未从该图读出 INVOICE,无法制造 OCR-成功场景'); return; }

    // 用户实测配置:两条用户可见消息门全开;底线门 + 脚注门默认开。
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'on';
    process.env.KHY_VISION_FAILURE_SUMMARY = 'on';
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR; // 底线门默认开(修复)
    delete process.env.KHY_OCR_USAGE_FOOTNOTE;             // 脚注门默认开

    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: h.realExtractImageOcrDetails, // 真 OCR,非桩
      collectProviderSiblingModels: () => [],
    });
    // content 刻意不提 OCR(模拟模型忽略 OPS-124 指令)→ 确定性脚注必须兜底。
    rec = h.makeRecordingAdapter({ content: '发票抬头是 ACME,年份 2026', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);

    const res = await runner.run({ images: [{ base64: pngB64, mimeType: 'image/png' }] });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.equal(res.model, 'text-only-model', '由原文本模型作答,绝不切到已 404 的视觉模型');
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, '真 OCR 应准确读出 INVOICE 并注入 prompt');
    assert.match(rec.finalPrompt || '', /以下为图片 OCR 识别文本/, '应走 OCR 文本注入(而非「读不出」底线)');
    // 「无感明显告知用户用了 OCR」:答复正文不提 OCR → 末尾出现确定性用户可见脚注。
    assert.ok(String(res.content || '').includes(ouf.OCR_USAGE_FOOTNOTE_MARKER), '答复不提 OCR → 确定性追加用户可见脚注(明显告知用了 OCR)');
    assert.match(res.content || '', /本地 OCR 文字识别读取/, '脚注措辞明确「用了 OCR」');
    assert.match(res.content || '', /发票抬头是 ACME/, '原答复正文保留,脚注仅追加末尾(无感)');
  });
});
