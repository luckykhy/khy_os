'use strict';

/**
 * visionModelDisplayNameRealImage.test.js — 用**真实图片**端到端核验 OPS-MAN-150
 * 「级联中间提示显示归一去 provider 前缀(减少心灵噪音)」。
 *
 * 真链路:真 PIL 渲染含字 PNG → describe-and-return 级联(KHY_VISION_FALLBACK_CASCADE 门开 → 内置 GLM pin,
 * 首候选 `glm/glm-4.6v-flash` 带路由前缀)逐候选识图(桩:恒 404 全失败)→ 走本地 OCR 兜底 →
 * 真 ocrSnippet/tesseract **读出 INVOICE** → 断言:
 *   A) 本门开(默认)→ 任一中间「请稍候」提示 prose **不含**带前缀 `glm/glm-4.6v-flash`,首候选显示裸
 *      `glm-4.6v-flash`;且 finalPrompt 真含 INVOICE(OCR 兜底照常,归一仅作用于显示不碰路由)。
 *   B) 本门关(KHY_VISION_MODEL_DISPLAY_NAME=off)→ 逐字节回退,首候选重现带前缀 `glm/glm-4.6v-flash`,
 *      OCR 注入照常。
 *
 * 可移植性:缺 tesseract / eng / Pillow → test.skip 干净跳过。候选数依赖内置 GLM key,只锁「前缀是否入 prose」不变量。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const NOTICE_RE = /(我无法直接识别图片内容。正在调用 .+ 进行识别|视觉模型 .+ 不可用，正在改用 .+ 继续识别)/;
const CLOSURE_RE = /已改用本地 OCR/;
const PREFIXED_RE = /glm\/glm-4\.6v-flash/;
const BARE_FIRST_RE = /(?<!\/)glm-4\.6v-flash/;
function visionNotices(msgs) {
  return msgs.filter((m) => NOTICE_RE.test(m) && !CLOSURE_RE.test(m));
}

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_CASCADE_ATTEMPT_NOTICE',
  'KHY_VISION_MODEL_DISPLAY_NAME',
  'KHY_VISION_OCR_SUCCESS_CLOSURE', 'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
]);
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'text-only-model', tag: 'real-display-name' });

function runCaptureMsgs(images) {
  const msgs = [];
  return runner.run({
    images,
    onChunk: (c) => { if (c && c.type === 'assistant_message' && c.content) msgs.push(String(c.content)); },
  }).then((res) => ({ res, msgs }));
}

describe('真实图片:级联中间提示显示归一去前缀(OPS-150)', () => {
  let py = null;
  let tmpDir = null;
  let textB64 = null;
  let ready = false;

  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_CASCADE = 'on'; // 内置 GLM pin,首候选带 glm/ 前缀
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off'; // 隔离:失败墙非本族
    delete process.env.KHY_GLM_VISION_MODEL;
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE; // 中间提示门默认开
    delete process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE; // OPS-145 门默认开
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    if (!h.haveTesseractLang('eng')) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-display-name-'));
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

  test('A) 门开 → 中间提示不含 glm/ 前缀,首候选裸名 + 真 OCR 读出 INVOICE', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    delete process.env.KHY_VISION_MODEL_DISPLAY_NAME; // 默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, msgs } = await runCaptureMsgs([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, '真 OCR 读出 INVOICE 并注入');
    const notices = visionNotices(msgs);
    assert.ok(notices.length >= 1, `应至少一条中间提示,实得 ${notices.length}`);
    for (const n of notices) {
      assert.ok(!PREFIXED_RE.test(n), `中间提示不得泄漏带前缀路由 id:${n}`);
    }
    assert.match(notices[0], BARE_FIRST_RE, '首候选应显示裸 glm-4.6v-flash');
  });

  test('B) 本门关 → 逐字节回退首候选重现 glm/ 前缀,OCR 注入照常', async (t) => {
    if (!ready) { t.skip('tesseract / eng / Pillow 不可用,跳过'); return; }
    process.env.KHY_VISION_MODEL_DISPLAY_NAME = 'off';
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: h.realExtractImageOcrDetails, collectProviderSiblingModels: () => [] });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails: true });
    h.wireSingle(rec);
    const { res, msgs } = await runCaptureMsgs([{ base64: textB64, mimeType: 'image/png' }]);
    assert.equal(res.success, true);
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, 'OCR 注入不受门影响');
    const notices = visionNotices(msgs);
    assert.ok(notices.length >= 1, `门关仍应有中间提示,实得 ${notices.length}`);
    assert.ok(
      notices.some((n) => PREFIXED_RE.test(n)),
      '门关时首候选应逐字节回退带前缀 glm/glm-4.6v-flash',
    );
  });
});
