'use strict';

/**
 * visionFailureSummaryOcrSuppressWiring.test.js — OPS-MAN-142(承 OPS-138/140,直服「减少显示的
 * 心灵噪音」)端到端锁定「失败墙推迟到 OCR 结果已知后」接线。
 *
 * 断桥(2026-07-12 用户实测 paste-cache 92c0154d):纯文本模型收到图 → describe-and-return 级联对
 * 视觉模型识图全失败 → aiGatewayGenerateMethod 在 **OCR 兜底之前** 无条件 emitAssistantMessage 那块
 * 含「图像识别失败…粘贴 GLM API Key」的失败墙。当图是**含字图**、随后本地 OCR **成功读出文字**时,
 * 那块吓人失败墙**已经甩给用户**——与紧接着的「已用 OCR 成功识别」自相矛盾,是日志里最响的心灵噪音。
 *
 * 修复(独立 default-on 门 KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS,与父门 KHY_VISION_FAILURE_SUMMARY
 * 正交):把失败墙**推迟**到 OCR 结果已知之后再决定是否发射。
 *   A) 子门开(默认) + OCR 有文本 → **修复点**:失败墙被抑制(不发),只注入 OCR 文本;
 *   B) 子门开(默认) + OCR 无文本 → 真失败 → 补发被推迟的失败墙(用户仍需介入);
 *   C) 子门关(KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS=off) + OCR 有文本 → **逐字节回退**:失败墙
 *      于 OCR 之前照旧发射(即便随后 OCR 成功);
 *   D) 父门关(KHY_VISION_FAILURE_SUMMARY=off) → 从不构造失败墙(不因子门推迟而重复/复活)。
 *
 * 手法:与 visionDescribeFailFloorWiring 同款自包含 harness(记录型 describe-fail 适配器 + DI),
 * onChunk 捕获 assistant_message 观测失败墙是否发射。OCR 明细由 DI 桩控。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true, describe: true, describeFails: true });
  h.wireSingle(rec);
}

const runner = h.makeRunner({
  prompt: '请先描述图片中的关键信息，再推断我想做什么',
  model: 'text-only-model',
  tag: 'fail-suppress',
});

// 捕获 emitAssistantMessage 发射的失败墙(type:'assistant_message')。
function runCaptureMsgs(extra) {
  const msgs = [];
  return runner.run(Object.assign({
    onChunk: (c) => { if (c && c.type === 'assistant_message' && c.content) msgs.push(String(c.content)); },
  }, extra)).then((res) => ({ res, msgs }));
}
const WALL = /图像识别失败/;

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS',
  'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_VISION_INTERMEDIATE_MESSAGE',
]);

const _OCR_TEXT_DETAIL = [{ text: '发票 金额 100', confidence: 90, needsAiFallback: false, truncated: false, lang: 'chi_sim', requestedLang: 'chi_sim', orientationCorrected: 0, upscaledFactor: 0 }];

describe('失败墙推迟到 OCR 结果已知后(OPS-142·减少心灵噪音)', () => {
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash'; // 逼出 switch-model → describe 级联
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    process.env.KHY_VISION_FAILURE_SUMMARY = '1'; // 父门开:确保有墙可谈
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR; // 底线门默认开
  });
  after(() => env.restore());

  test('A) 修复点:子门开 + OCR 有文本 → 失败墙被抑制(不发),只注入 OCR 文本', async () => {
    delete process.env.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS; // 默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /发票 金额 100/, 'OCR 文本仍注入(救回成功)');
    assert.ok(!msgs.some((m) => WALL.test(m)), '修复:OCR 成功时那块吓人失败墙被抑制,不甩给用户');
  });

  test('B) 子门开 + OCR 无文本 → 真失败 → 补发被推迟的失败墙', async () => {
    delete process.env.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.ok(msgs.some((m) => WALL.test(m)), 'OCR 读空=真失败,失败墙照发(用户仍需介入)');
  });

  test('C) 子门关(=off) + OCR 有文本 → 逐字节回退:失败墙于 OCR 前照旧发射', async () => {
    process.env.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS = 'off';
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /发票 金额 100/, 'OCR 文本仍注入');
    assert.ok(msgs.some((m) => WALL.test(m)), '门关:失败墙于 OCR 之前无条件发射(历史行为)');
  });

  test('D) 父门关(KHY_VISION_FAILURE_SUMMARY=off) → 从不构造失败墙(子门推迟不复活它)', async () => {
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off';
    delete process.env.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS; // 子门开也不该复活父门关掉的墙
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    assert.ok(!msgs.some((m) => WALL.test(m)), '父门关:buildVisionFailureMessage 返 null,墙从不存在');
  });
});
