'use strict';

/**
 * visionCascadeAttemptNoticeRealImage.test.js — 用**真实图片**端到端核验 OPS-MAN-145
 * 「级联逐候选提示减冗余(减少心灵噪音)」。
 *
 * 真链路:真 PIL 渲染含字 PNG → describe-and-return 级联(KHY_VISION_FALLBACK_CASCADE 门开 → 内置 GLM pin
 * 产 ≥2 候选)逐候选识图(桩:恒 404 全失败)→ 走本地 OCR 兜底 → 真 ocrSnippet/tesseract **读出 INVOICE** →
 * 断言:
 *   A) 中间「请稍候」提示:第 1 条保留完整历史首句,第 2..N 条折成减冗余 reframe(去掉「我无法直接识别图片内容」),
 *      且 finalPrompt 真含 INVOICE(OCR 兜底照常),末尾仍有 OPS-144 OCR 成功闭合(两族正交不互斥);
 *   B) 本门关(KHY_VISION_CASCADE_ATTEMPT_NOTICE=off)→ 每条退回完整历史首句(byte-revert),零 reframe,OCR 注入照常。
 *
 * 可移植性:缺 tesseract / eng / Pillow → test.skip 干净跳过。级联候选数依赖内置 GLM key,只锁结构不变量不硬编码个数。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const LEGACY_RE = /我无法直接识别图片内容。正在调用 .+ 进行识别，请稍候/;
const REFRAME_RE = /视觉模型 .+ 不可用，正在改用 .+ 继续识别/;
const CLOSURE_RE = /已改用本地 OCR/;
function visionNotices(msgs) {
  return msgs.filter((m) => (LEGACY_RE.test(m) || REFRAME_RE.test(m)) && !CLOSURE_RE.test(m));
}

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_CASCADE_ATTEMPT_NOTICE',
  'KHY_VISION_OCR_SUCCESS_CLOSURE', 'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
]);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'real-cascade-notice' });

function runCaptureMsgs(images) {
  const msgs = [];
  return runner.run({
    images,
    onChunk: (c) => { if (c && c.type === 'assistant_message' && c.content) msgs.push(String(c.content)); },
  }).then((res) => ({ res, msgs }));
}

describe('真实图片:级联逐候选提示减冗余(OPS-145)', () => {
  let py = null;
  let tmpDir = null;
  let textB64 = null;
  let ready = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_CASCADE = 'on'; // 内置 GLM pin → ≥2 候选
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off'; // 隔离
    delete process.env.KHY_GLM_VISION_MODEL;
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    if (!h.haveTesseractLang('eng')) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cascade-notice-'));
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

  test('A) 门开 → 第 1 条 legacy、其后 reframe 无冗余前缀 + 真 OCR 读出 INVOICE', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, msgs } = await runCaptureMsgs([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, '真 OCR 读出 INVOICE 并注入');
    const notices = visionNotices(msgs);
    assert.ok(notices.length >= 2, `内置 GLM pin 应产 ≥2 候选提示,实得 ${notices.length}`);
    assert.match(notices[0], LEGACY_RE, '第 1 条保留完整历史首句');
    for (let i = 1; i < notices.length; i += 1) {
      assert.match(notices[i], REFRAME_RE, `第 ${i + 1} 条应为减冗余 reframe`);
      assert.ok(!/我无法直接识别图片内容/.test(notices[i]), `第 ${i + 1} 条不得复述冗余前缀`);
    }
  });

  test('B) 本门关 → 每条退回完整历史首句(byte-revert),OCR 注入照常', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE = 'off';
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, msgs } = await runCaptureMsgs([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, 'OCR 注入不受门影响');
    const notices = visionNotices(msgs);
    assert.ok(notices.length >= 2, `门关仍应有 ≥2 条中间提示,实得 ${notices.length}`);
    for (let i = 0; i < notices.length; i += 1) {
      assert.match(notices[i], LEGACY_RE, `门关第 ${i + 1} 条应为完整历史首句`);
    }
    assert.ok(!notices.some((m) => REFRAME_RE.test(m)), '门关不得出现 reframe');
  });
});
