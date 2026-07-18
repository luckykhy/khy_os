'use strict';

/**
 * visionStripImageFloorWiring.test.js — 端到端锁定 2026-07-12 用户实测「Khy 无法正确读图 /
 * 消息里没有附带图片」的**第二条控制流断桥修复**(OPS-120,承 OPS-118)。
 *
 * 断桥(reproduce 于 /tmp,已固化为本测试):纯文本模型收到图 → decideVisionRouting 判
 * switch-model → describe-and-return 级联对视觉模型识图,视觉模型 404 全部失败 → 落「剥图 +
 * OCR 兜底 + 底线」的 else 分支(OCR 无文本)。**该分支里剥图是无条件的**(images: undefined),
 * 但「收到图但读不出」说明 buildVisionUnreadableNote 受 **KHY_VISION_OCR_FALLBACK**(OCR **功能门**)
 * 约束——用户把 OCR 兜底功能关掉时该文案返 null → 说明不注入,**图却照样被剥** → 文本模型收到
 * 一条既无图、又无任何说明的裸 prompt → 如实却荒谬地回「消息里没有附带图片 / 当前对话中没有任何
 * 图片附件。我无法描述不存在的内容」。
 *
 * 修复(独立 default-on 门 KHY_VISION_STRIP_IMAGE_FLOOR,与 OCR 功能门正交):说明缺席时退回
 * 一条**不提 OCR 的最小诚实底线**,保住「剥图 ⟹ 必留『图收到但读不出』痕迹」不变量。
 *   A) OCR 功能门**关** + OCR 无文本 + 底线门开(默认) → **修复点**:剥图 + 注入最小底线,
 *      由**原文本模型**作答,不再谎称没收到图;
 *   B) OCR 功能门关 + OCR 无文本 + 底线门**关**(KHY_VISION_STRIP_IMAGE_FLOOR=off) → **逐字节回退**
 *      历史行为(剥图无痕);
 *   C) OCR 功能门**开** + OCR 无文本 → 仍用**原** buildVisionUnreadableNote(提「本地 OCR 未提取」),
 *      最小底线不登场(证明无回归,只在原说明缺席时兜底);
 *   D) OCR 有文本 → 注入 OCR 文本块(本轮改动不触碰,回归保护)。
 *
 * 手法:与 visionDescribeFailFloorWiring 同款自包含 harness(记录型 adapter + DI),
 * KHY_VISION_FALLBACK_MODEL 钉一个视觉模型逼出 switch-model;describe-pass 返回 404 失败;
 * OCR 明细由 DI 桩控。harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const fb = require(BE + '/src/services/gateway/visionOcrFallback');
const h = require('./_ocrGatewayHarness');

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true, describe: true, describeFails: true });
  h.wireSingle(rec);
}

const runner = h.makeRunner({
  prompt: '请先描述图片中的关键信息，再推断我想做什么',
  model: 'text-only-model',
  tag: 'strip-floor',
});

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_VISION_INTERMEDIATE_MESSAGE',
  'KHY_VISION_OCR_FALLBACK', 'KHY_VISION_STRIP_IMAGE_FLOOR',
]);

const _OCR_TEXT_DETAIL = [{ text: '发票 金额 100', confidence: 90, needsAiFallback: false, truncated: false, lang: 'chi_sim', requestedLang: 'chi_sim', orientationCorrected: 0, upscaledFactor: 0 }];

describe('visionOcrFallback 纯叶子:最小诚实底线(buildStrippedImageFloorNote / isStripImageFloorEnabled)', () => {
  test('isStripImageFloorEnabled 默认开;仅显式 0/false/off/no 关', () => {
    assert.equal(fb.isStripImageFloorEnabled({}), true, '缺省默认开');
    assert.equal(fb.isStripImageFloorEnabled({ KHY_VISION_STRIP_IMAGE_FLOOR: '1' }), true);
    for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(fb.isStripImageFloorEnabled({ KHY_VISION_STRIP_IMAGE_FLOOR: off }), false, `off-word: ${off}`);
    }
    assert.equal(fb.isStripImageFloorEnabled({ KHY_VISION_STRIP_IMAGE_FLOOR: 'yes' }), true, '非 off-word 视为开');
  });

  test('buildStrippedImageFloorNote 门开:返最小底线(含「绝不能说没有收到图片」,刻意不提 OCR)', () => {
    const note = fb.buildStrippedImageFloorNote({ count: 2, env: {} });
    assert.ok(note, '门开应返底线');
    assert.match(note, /\[图像无法读取\]/, '复用统一首行标记');
    assert.match(note, /2 张图片/, 'count 措辞');
    assert.match(note, /绝不能说没有收到图片/, '核心不变量:命令模型别谎称没收到图');
    assert.doesNotMatch(note, /OCR/, '刻意不提 OCR(本条恰在 OCR 功能门关闭时登场)');
  });

  test('buildStrippedImageFloorNote 门关:返 null(调用方逐字节回退)', () => {
    assert.equal(fb.buildStrippedImageFloorNote({ count: 1, env: { KHY_VISION_STRIP_IMAGE_FLOOR: 'off' } }), null);
  });

  test('buildStrippedImageFloorNote 畸形入参:泛化措辞且绝不抛', () => {
    for (const bad of [{ count: 0 }, { count: -3 }, { count: NaN }, {}, { count: 'x' }]) {
      const note = fb.buildStrippedImageFloorNote({ ...bad, env: {} });
      assert.ok(note && /图片/.test(note), '缺省泛化「图片」');
      assert.doesNotMatch(note, /NaN|undefined|-3|张 张/);
    }
  });
});

describe('视觉描述级联全失败 → 剥图必留痕最小底线(修「没有附带图片」第二条断桥·OPS-120)', () => {
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash'; // 逼出 switch-model
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';        // 确定性:_attempts 仅主模型
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    process.env.KHY_VISION_FAILURE_SUMMARY = '1';           // 失败说明开(与 OPS-118 路径无关地证第二断桥)
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;  // 底线路径门默认开
  });
  after(() => env.restore());

  test('A) 修复点:OCR 功能门关 + OCR 无文本 → 剥图 + 注入最小底线,原文本模型作答(不再谎称没收到图)', async () => {
    process.env.KHY_VISION_OCR_FALLBACK = 'off';            // 用户关掉 OCR 兜底功能
    delete process.env.KHY_VISION_STRIP_IMAGE_FLOOR;        // 最小底线门默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.equal(res.model, 'text-only-model', '由原文本模型作答,不切到已 404 的视觉模型');
    assert.match(rec.finalPrompt || '', /\[图像无法读取\]/, '修复:说明缺席时最小底线兜住,堵「没有附带图片」幻觉');
    assert.match(rec.finalPrompt || '', /绝不能说没有收到图片/);
  });

  test('B) 门关(KHY_VISION_STRIP_IMAGE_FLOOR=off)+ OCR 功能门关 → 逐字节回退历史行为(剥图无痕)', async () => {
    process.env.KHY_VISION_OCR_FALLBACK = 'off';
    process.env.KHY_VISION_STRIP_IMAGE_FLOOR = 'off';
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '门关:仍剥图(该分支剥图本就无条件)');
    assert.doesNotMatch(rec.finalPrompt || '', /\[图像无法读取\]/, '门关:不注入底线(逐字节回退)');
  });

  test('C) 无回归:OCR 功能门开 + OCR 无文本 → 仍用原 buildVisionUnreadableNote(提「本地 OCR 未提取」),最小底线不登场', async () => {
    process.env.KHY_VISION_OCR_FALLBACK = '1';              // OCR 功能门开
    delete process.env.KHY_VISION_STRIP_IMAGE_FLOOR;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.match(rec.finalPrompt || '', /本地 OCR 未能从图中提取/, '门开:用原 OCR 说明(证只在原说明缺席时兜底,无回归)');
    assert.match(rec.finalPrompt || '', /绝不能说没有收到图片/);
  });

  test('D) 回归保护:OCR 有文本 → 注入 OCR 文本块(本轮改动不触碰此分支)', async () => {
    process.env.KHY_VISION_OCR_FALLBACK = 'off';            // 即便功能门关,有文本仍注入(该分支本就不受功能门约束)
    delete process.env.KHY_VISION_STRIP_IMAGE_FLOOR;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.match(rec.finalPrompt || '', /以下为图片 OCR 识别文本/);
    assert.match(rec.finalPrompt || '', /发票 金额 100/);
  });
});
