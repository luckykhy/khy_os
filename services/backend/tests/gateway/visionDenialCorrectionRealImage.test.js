'use strict';

/**
 * visionDenialCorrectionRealImage.test.js — 用**真实图片**端到端复现并核验 OPS-MAN-138(2026-07-12
 * 用户实测失败现象的确定性纠正)。
 *
 * 复现的失败(paste-cache 92c0154d):纯文本模型 + 带图 → 视觉描述级联全 404 → 落 OCR 兜底,但图是
 * **非文字类**(此处真 PIL 渲一张纯彩色块、无任何文字)→ 真 tesseract **读不出文字** → aiGateway 空 OCR
 * 站点无条件剥图 + 注入「收到图但读不出」诚实底线(仅 prompt 指令)→ 模型**无视指令**,正文谎称「消息里
 * 没有附带图片」。历史:到此为止,用户被误导以为没上传图。修复后:finishResult 成功侧确定性纠正脚注
 * (KHY_VISION_DENIAL_CORRECTION default-on)检测到 _ocrFallbackApplied && !_ocrImageTextRead && 模型否认
 * → 末尾追加用户可见「已收到图片·当前通道无法识别」纠正,把真相无条件送达。
 *
 * 真链路:真 PIL 渲**无字彩块** PNG → describe-and-return 级联对 pinned 视觉模型识图(桩:恒 404)→
 * 全部失败 → 底线门(KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR default-on)→ 真 ocrSnippetService →
 * 真 docHelper.py → 真 tesseract **读空**(无字)→ 剥图 + 注入诚实底线(prompt),_ocrFallbackApplied=true
 * 但 _ocrImageTextRead **不置**;原文本模型作答**故意否认收到图** → finishResult 确定性追加纠正脚注。
 *
 * 可移植性:缺 tesseract / 缺带 Pillow 的 Python / 本机竟从彩块读出文字(制造不出空 OCR)→ test.skip。
 *
 * harness 统一自 `_ocrGatewayHarness`。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const vdc = require(BE + '/src/services/gateway/visionDenialCorrection');
const ouf = require(BE + '/src/services/gateway/ocrUsageFootnote');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_VISION_DENIAL_CORRECTION',
  'KHY_VISION_DENIAL_CORRECTION_OCR_READ',
]);;
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'denial-correct' });

let rec;

describe('真无字图 → 视觉全 404 → 真 OCR 读空 → 模型谎称没收到图 → 确定性纠正脚注兜底', () => {
  let py = null;
  let tmpDir = null;
  let pngB64 = null;
  let ready = false;
  let ocrEmpty = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash';
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    if (!h.tesseractPresent()) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-denial-correct-'));
    const pngPath = path.join(tmpDir, 'blank.png');
    // 故意无字:纯彩色块,texts=[] → 真 tesseract 应读不出任何文字 → 制造空 OCR 场景。
    const r = h.renderPng(py, {
      outPath: pngPath,
      size: [320, 200],
      bg: [40, 120, 200],
      texts: [],
    });
    if (r.missingPil || !r.exists) return;
    pngB64 = fs.readFileSync(pngPath).toString('base64');
    const d = h.realExtractImageOcrDetails([{ base64: pngB64, mimeType: 'image/png' }]);
    // 本机从彩块读出了文字 → 制造不出空 OCR 场景,跳过(可移植性)。
    ocrEmpty = !(d.length > 0 && d.some((x) => String(x.text || '').trim().length > 0));
    ready = true;
  });

  after(() => {
    env.restore();
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: undefined, collectProviderSiblingModels: undefined });
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('空 OCR + 模型否认收到图 → 剥图、原文本模型作答、末尾确定性纠正脚注', async (t) => {
    if (!ready) { t.skip('tesseract / Pillow 不可用,跳过'); return; }
    if (!ocrEmpty) { t.skip('本机从无字彩块读出了文字,制造不出空 OCR 场景,跳过'); return; }

    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR; // 底线门默认开
    delete process.env.KHY_VISION_DENIAL_CORRECTION;       // 纠正门默认开

    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: h.realExtractImageOcrDetails, // 真 OCR(无字 → 读空)
      collectProviderSiblingModels: () => [],
    });
    // content 刻意复刻实测失败语料:模型无视诚实底线指令,谎称没收到图。
    rec = h.makeRecordingAdapter({
      content: '我注意到你发了一条结构化提示,但消息里没有附带图片。当前对话中没有任何图片附件,我无法描述不存在的内容。',
      captureImages: true, describe: true, describeFails: true,
    });
    h.wireSingle(rec);

    const res = await runner.run({ images: [{ base64: pngB64, mimeType: 'image/png' }] });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.equal(res.model, 'text-only-model', '由原文本模型作答');
    assert.ok(!/以下为图片 OCR 识别文本/.test(rec.finalPrompt || ''), '空 OCR → 不应走 OCR-文本注入');
    // 核心:模型正文否认收到图 → finishResult 确定性追加用户可见纠正脚注。
    assert.ok(String(res.content || '').includes(vdc.DENIAL_CORRECTION_MARKER), '模型否认收到图 → 确定性追加纠正脚注');
    assert.match(res.content || '', /已经收到/, '脚注明确「图片已收到」');
    assert.match(res.content || '', /并非「没有图片」/, '脚注直接反驳「没有图片」的谎称');
    assert.match(res.content || '', /消息里没有附带图片/, '原答复正文保留,脚注仅追加末尾');
  });

  test('门关(KHY_VISION_DENIAL_CORRECTION=off)→ 逐字节回退:无纠正脚注', async (t) => {
    if (!ready) { t.skip('tesseract / Pillow 不可用,跳过'); return; }
    if (!ocrEmpty) { t.skip('制造不出空 OCR 场景,跳过'); return; }

    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    process.env.KHY_VISION_DENIAL_CORRECTION = 'off'; // 纠正门关

    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: h.realExtractImageOcrDetails,
      collectProviderSiblingModels: () => [],
    });
    rec = h.makeRecordingAdapter({
      content: '我注意到你发了一条结构化提示,但消息里没有附带图片。',
      captureImages: true, describe: true, describeFails: true,
    });
    h.wireSingle(rec);

    const res = await runner.run({ images: [{ base64: pngB64, mimeType: 'image/png' }] });

    assert.equal(res.success, true);
    assert.ok(!String(res.content || '').includes(vdc.DENIAL_CORRECTION_MARKER), '门关 → 不追加纠正脚注(逐字节回退)');
  });
});

// ── OPS-MAN-140:OCR **成功读出文本** + 模型**仍否认收到图** → OCR-成功变体纠正取代普通「用了 OCR」脚注 ──
// 复现:纯文本模型 + 带**含字**图 → 视觉级联全 404 → 底线门 → 真 tesseract **读出文字** → _ocrImageTextRead=true
// → OCR 文本注入 prompt;但模型无视注入的文本、正文仍谎称「没有图片附件」。历史该格 ocrUsageFootnote(:858)
// 只追加「以上关于这张图片的内容是通过 OCR 读取的」——与模型的否认自相矛盾且不纠正否认。修复后:branch-1 检测到
// detectImageDenial 命中 → 改用 OCR-成功变体(独立 marker + 「已成功读出、是模型没采用、据 OCR 重新作答」)
// 取代普通脚注(不叠加,避免心灵噪音)。门关 → 落回普通 ocrUsageFootnote,逐字节回退。
const runnerRead = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'denial-ocr-read' });

describe('真含字图 → 视觉全 404 → 真 OCR 读出文字 → 模型仍谎称没收到图 → OCR-成功变体纠正(OPS-140)', () => {
  let py = null;
  let tmpDir = null;
  let pngB64 = null;
  let ready = false;
  let ocrHasText = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash';
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    if (!h.tesseractPresent()) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-denial-ocr-read-'));
    const pngPath = path.join(tmpDir, 'receipt.png');
    // 故意含字:唯一可被 tesseract 稳定识别的 ASCII → 真 OCR 应读出文字 → 制造 _ocrImageTextRead=true 场景。
    const r = h.renderPng(py, {
      outPath: pngPath,
      size: [720, 200],
      bg: [255, 255, 255],
      texts: [
        { xy: [30, 40], text: 'RECEIPT NO 7788', fill: [0, 0, 0] },
        { xy: [30, 110], text: 'PAID USD 4321.00', fill: [0, 0, 0] },
      ],
      fontSize: 44,
    });
    if (r.missingPil || !r.exists) return;
    pngB64 = fs.readFileSync(pngPath).toString('base64');
    const d = h.realExtractImageOcrDetails([{ base64: pngB64, mimeType: 'image/png' }]);
    // 本机 tesseract 确实从含字图读出文字 → 才能制造 OCR-成功场景;读空(缺字库等)→ 跳过(可移植性)。
    ocrHasText = d.length > 0 && d.some((x) => String(x.text || '').trim().length > 0);
    ready = true;
  });

  after(() => {
    env.restore();
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: undefined, collectProviderSiblingModels: undefined });
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('OCR 读出文字 + 模型否认收到图 → 注入 OCR 文本、追加 OCR-成功变体纠正(取代普通脚注)', async (t) => {
    if (!ready) { t.skip('tesseract / Pillow 不可用,跳过'); return; }
    if (!ocrHasText) { t.skip('本机 tesseract 从含字图读不出文字,制造不出 OCR-成功场景,跳过'); return; }

    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;       // 底线门默认开
    delete process.env.KHY_VISION_DENIAL_CORRECTION_OCR_READ;   // OCR-成功变体子门默认开

    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: h.realExtractImageOcrDetails, // 真 OCR(含字 → 读出文字)
      collectProviderSiblingModels: () => [],
    });
    // content 复刻实测:模型无视注入的 OCR 文本,仍谎称没收到图(且未提 OCR,避免命中 ACK 正则)。
    rec = h.makeRecordingAdapter({
      content: '关键发现:当前对话中没有任何图片附件。你发送的是一条纯文本的结构化提示,我无法描述不存在的内容。',
      captureImages: true, describe: true, describeFails: true,
    });
    h.wireSingle(rec);

    const res = await runnerRead.run({ images: [{ base64: pngB64, mimeType: 'image/png' }] });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.equal(res.model, 'text-only-model', '由原文本模型作答');
    // OCR 成功:文本注入 prompt(区别空 OCR 路径),_ocrImageTextRead=true。
    assert.match(rec.finalPrompt || '', /以下为图片 OCR 识别文本/, 'OCR 成功 → 文本块注入 prompt');
    assert.match(rec.finalPrompt || '', /7788|4321/, '真实 OCR 文字应注入 prompt');
    // 核心:OCR-成功变体纠正取代普通「用了 OCR」脚注。
    assert.ok(String(res.content || '').includes(vdc.DENIAL_CORRECTION_OCR_READ_MARKER), '追加 OCR-成功变体纠正 marker');
    assert.ok(!String(res.content || '').includes(ouf.OCR_USAGE_FOOTNOTE_MARKER), '取代普通脚注(不叠加,避免心灵噪音)');
    assert.ok(!String(res.content || '').includes(vdc.DENIAL_CORRECTION_MARKER), '不是空 OCR 变体');
    assert.match(res.content || '', /已成功读出/, '点明 OCR 已读出文字');
    assert.match(res.content || '', /并非「没有图片」/, '直接反驳「没有图片」的谎称');
    assert.match(res.content || '', /据 OCR/, '给出「据 OCR 文本重新作答」出路');
    assert.match(res.content || '', /当前对话中没有任何图片附件/, '原答复正文保留,脚注仅追加末尾');
  });

  test('子门关(KHY_VISION_DENIAL_CORRECTION_OCR_READ=off)→ 逐字节回退到普通 ocrUsageFootnote', async (t) => {
    if (!ready) { t.skip('tesseract / Pillow 不可用,跳过'); return; }
    if (!ocrHasText) { t.skip('制造不出 OCR-成功场景,跳过'); return; }

    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    process.env.KHY_VISION_DENIAL_CORRECTION_OCR_READ = 'off'; // 子门关

    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: h.realExtractImageOcrDetails,
      collectProviderSiblingModels: () => [],
    });
    rec = h.makeRecordingAdapter({
      content: '关键发现:当前对话中没有任何图片附件。我无法描述不存在的内容。',
      captureImages: true, describe: true, describeFails: true,
    });
    h.wireSingle(rec);

    const res = await runnerRead.run({ images: [{ base64: pngB64, mimeType: 'image/png' }] });

    assert.equal(res.success, true);
    // 子门关 → 不走 OCR-成功变体;落回普通 ocrUsageFootnote(历史行为,逐字节回退)。
    assert.ok(!String(res.content || '').includes(vdc.DENIAL_CORRECTION_OCR_READ_MARKER), '子门关 → 无 OCR-成功变体 marker');
    assert.ok(String(res.content || '').includes(ouf.OCR_USAGE_FOOTNOTE_MARKER), '落回普通「用了 OCR」脚注(历史行为)');
  });
});
