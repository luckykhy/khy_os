'use strict';

/**
 * ocrUsageFootnoteWiring.test.js — 端到端锁定本轮(OPS-MAN-126,承 OPS-124)新断桥:OCR 成功路径上
 * 缺一条**确定性**的「用了 OCR」用户可见披露。
 *
 * 断桥:OPS-124(ocrUsageNotice)只在 prompt 里给模型一条**指令**要求它披露用了 OCR。那是**建议**:
 * 模型可忽略 → 正文对 OCR 只字不提 → 用户不知情 → 目标里的「**明显**告知用户」失守。finishResult 成功侧
 * 本有一整族**确定性**真值脚注(answerVerifier/modelIdentityTruth/cacheMetricsTruth),唯独「用了 OCR」
 * 这条透明性没有对应的确定性脚注。
 *
 * 修复(独立 default-on 门 KHY_OCR_USAGE_FOOTNOTE,与 OPS-124 去重协同):确有 OCR 文本读出
 * (_ocrImageTextRead)+ 作答成功 + 正文**尚未**提到 OCR 时,在 result.content 末尾**确定性**追加脚注。
 *   A) 门开 + 模型忽略指令(答复不提 OCR) → **修复点**:result.content 末尾出现确定性脚注(明显告知);
 *   B) 门开 + 模型合规(答复已提 OCR) → 去重:**不追加**脚注(保持无感、不重复披露);
 *   C) 门关(KHY_OCR_USAGE_FOOTNOTE=off) → 逐字节回退(答复无脚注);
 *   D) 无回归:OCR **无文本**(读不出) → _ocrImageTextRead 未置 → 不追加脚注。
 *
 * 手法:复用 ocrUsageDisclosureWiring 的双适配器 harness——视觉可用模型(gpt-4o)逼 keep-routing →
 * #1 以 404 拒图触发 post-failure 救援网(Site3,置 _ocrImageTextRead)→ #2 记录型文本适配器承接、
 * 回填 result.content。脚注作用于 finishResult 的 result.content(非 prompt),故用 _adapterContent
 * 控制模型答复是否提 OCR。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./_ocrGatewayHarness');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const ouf = require(BE + '/src/services/gateway/ocrUsageFootnote');

let adapterContent = '已作答'; // 默认不提 OCR(模拟模型忽略 OPS-124 指令)

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_OCR_USAGE_FOOTNOTE']);
const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'gpt-4o', tag: 'usage-footnote' });

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: () => adapterContent });
  h.wireCascade(h.makeRejectAdapter(), rec);
}

const _OCR_TEXT_DETAIL = [{ text: '发票 金额 100', confidence: 90, needsAiFallback: false, truncated: false, lang: 'chi_sim', requestedLang: 'chi_sim', orientationCorrected: 0, upscaledFactor: 0 }];

describe('ocrUsageFootnote 纯叶:isFootnoteEnabled + answerAlreadyDisclosesOcr', () => {
  test('门默认开;仅显式 0/false/off/no 关', () => {
    assert.equal(ouf.isFootnoteEnabled({}), true);
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.equal(ouf.isFootnoteEnabled({ KHY_OCR_USAGE_FOOTNOTE: off }), false, `off-word ${off}`);
    }
  });
  test('answerAlreadyDisclosesOcr:提到 OCR/文字识别 → true,否则 false', () => {
    assert.equal(ouf.answerAlreadyDisclosesOcr('我通过 OCR 读到了发票金额'), true);
    assert.equal(ouf.answerAlreadyDisclosesOcr('这是经光学字符识别得到的'), true);
    assert.equal(ouf.answerAlreadyDisclosesOcr('这段文字识别自图片'), true);
    assert.equal(ouf.answerAlreadyDisclosesOcr('发票金额是 100 元'), false);
    assert.equal(ouf.answerAlreadyDisclosesOcr(''), false);
    assert.equal(ouf.answerAlreadyDisclosesOcr(null), false);
  });
});

describe('OCR 成功路径「使用 OCR」确定性脚注端到端(OPS-MAN-126)', () => {
  before(() => {
    env.save();
    env.set({ KHY_VISION_FALLBACK_CASCADE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_INTERMEDIATE_MESSAGE: 'off', KHY_VISION_FALLBACK_MODEL: undefined, KHY_VISION_OCR_FALLBACK: undefined });
    // 救援网前置:OCR 功能门必须开(否则 shouldOcrRescue 恒 false,_visionFallback 不触发)。
  });
  after(() => {
    env.restore();
    adapterContent = '已作答';
  });

  test('A) 修复点:门开 + 模型答复不提 OCR → result.content 末尾出现确定性脚注(明显告知)', async () => {
    env.set({ KHY_OCR_USAGE_FOOTNOTE: undefined }); // 默认开
    adapterContent = '发票金额是 100 元'; // 模型忽略了 OPS-124 指令,只字不提 OCR
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /OCR 图像文本识别结果/, '不变量:OCR 文本仍注入(准确识别不回退)');
    assert.ok(String(res.content || '').includes(ouf.OCR_USAGE_FOOTNOTE_MARKER), '修复:确定性追加用户可见 OCR 脚注');
    assert.match(res.content || '', /本地 OCR 文字识别读取/, '脚注措辞明确「用了 OCR」');
    assert.match(res.content || '', /发票金额是 100 元/, '原答复正文保留,脚注仅追加在末尾');
  });

  test('B) 去重:门开 + 模型答复已提 OCR → 不追加脚注(保持无感、不重复披露)', async () => {
    env.set({ KHY_OCR_USAGE_FOOTNOTE: undefined });
    adapterContent = '我通过 OCR 识别到发票金额是 100 元'; // 模型合规(OPS-124 指令生效)
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(!String(res.content || '').includes(ouf.OCR_USAGE_FOOTNOTE_MARKER), '去重:正文已披露 OCR → 不追加脚注');
    assert.match(res.content || '', /我通过 OCR 识别到/, '原答复正文逐字节保留');
  });

  test('C) 门关(KHY_OCR_USAGE_FOOTNOTE=off) → 逐字节回退(答复无脚注)', async () => {
    env.set({ KHY_OCR_USAGE_FOOTNOTE: 'off' });
    adapterContent = '发票金额是 100 元';
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.equal(res.content, '发票金额是 100 元', '门关:result.content 逐字节不变(无脚注)');
  });

  test('D) 无回归:OCR 无文本(读不出) → _ocrImageTextRead 未置 → 不追加脚注', async () => {
    env.set({ KHY_OCR_USAGE_FOOTNOTE: undefined });
    adapterContent = '发票金额是 100 元';
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(!String(res.content || '').includes(ouf.OCR_USAGE_FOOTNOTE_MARKER), 'OCR 无文本 → 无 OCR 读出可披露,不追加脚注');
  });
});
