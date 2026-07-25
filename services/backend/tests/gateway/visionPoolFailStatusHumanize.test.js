'use strict';

/**
 * visionPoolFailStatusHumanize.test.js — 视觉池失败状态「人话化」减少心灵噪音接线(OPS-MAN-164;
 * /goal「减少显示的心灵噪音」)。
 *
 * 断桥:视觉→本地 OCR 兜底**成功**后,最终生成循环仍会尝试视觉池适配器并 404,
 * aiGatewayGenerateMethod 的两处适配器失败发射(~2589 / ~3202)实时打出原始诊断
 *   `visionpool 失败: OpenAI: 404 model_not_found`
 * ——但此时图片内容早已被本地 OCR 读出并据此作答,这行 404 是**次级心灵噪音**。
 *
 * 修(纯叶 visionPoolFailStatus + 门 KHY_VISION_POOL_FAIL_STATUS_HUMANIZE,default-on):
 *   门开 && OCR 已兜底(_ocrImageTextRead) && 失败池名含 vision → 换成人话
 *     「视觉通道当前不可用，已用本地 OCR 兜底」;
 *   关 / 非 OCR 兜底 / 非视觉池 → 原样 `${name} 失败: ${errMsg}` 逐字节回退(真失败保留可定位诊断)。
 *
 * 覆盖:①纯叶单元(门/兜底/池名/畸形谓词);②源级接线断言(两发射站都委派本叶);
 *      ③端到端(wireCascade 视觉位 404 → 文本位承接,门开人话化 / 门关 byte-revert);
 *      ④真实图片(真 tesseract OCR + 门开人话化,证「无识图模型也准确识别 + 无噪音」)。
 *
 * 关键:in-process 每个 e2e 用**唯一 model 名**规避 gateway 的 per-model 路由记忆污染(同名会
 * 使第 2 次起走缓存决策、跳过视觉位失败发射),这是本 god-file 的既有单例行为,非本次改动引入。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const leaf = require(BE + '/src/services/gateway/visionPoolFailStatus');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const HUMAN_RE = /视觉通道当前不可用，已用本地 OCR 兜底/;
const RAW_RE = /visionpool 失败: OpenAI: 404 model_not_found/;

// ── ① 纯叶单元 ────────────────────────────────────────────────────────────────────
describe('visionPoolFailStatus 纯叶(OPS-164)', () => {
  test('A) 门开 + OCR 已兜底 + 视觉池名 → 人话化串', () => {
    const s = leaf.buildVisionPoolFailStatus({ poolName: 'visionpool', ocrRescued: true, env: {} });
    assert.match(s || '', HUMAN_RE, '门开 + 兜底 + 视觉池 → 人话化');
  });

  test('B) 门关(off-word)→ null,调用方逐字节回退原始诊断', () => {
    for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
      const s = leaf.buildVisionPoolFailStatus({ poolName: 'visionpool', ocrRescued: true, env: { KHY_VISION_POOL_FAIL_STATUS_HUMANIZE: off } });
      assert.equal(s, null, `门关(${off})→ null`);
    }
  });

  test('C) 非 OCR 兜底(严格 !==true)→ null,真失败保留诊断', () => {
    for (const v of [false, undefined, null, 1, 'true', {}]) {
      const s = leaf.buildVisionPoolFailStatus({ poolName: 'visionpool', ocrRescued: v, env: {} });
      assert.equal(s, null, `ocrRescued=${JSON.stringify(v)} 非严格 true → null`);
    }
  });

  test('D) 非视觉池名(textonly / 空 / 非串)→ null', () => {
    for (const name of ['textonly', 'localpool', '', null, undefined, 42]) {
      const s = leaf.buildVisionPoolFailStatus({ poolName: name, ocrRescued: true, env: {} });
      assert.equal(s, null, `池名=${JSON.stringify(name)} 不含 vision → null`);
    }
    // 含 vision(大小写不敏感)才命中
    assert.match(leaf.buildVisionPoolFailStatus({ poolName: 'VisionPool', ocrRescued: true, env: {} }) || '', HUMAN_RE);
  });

  test('E) 畸形/无参 → null 且绝不抛(fail-soft)', () => {
    assert.doesNotThrow(() => leaf.buildVisionPoolFailStatus());
    assert.equal(leaf.buildVisionPoolFailStatus(), null);
    assert.equal(leaf.buildVisionPoolFailStatus({}), null);
  });

  test('F) 门谓词默认开(未设视为开)', () => {
    assert.equal(leaf.isVisionPoolFailStatusHumanizeEnabled({}), true);
    assert.equal(leaf.isVisionPoolFailStatusHumanizeEnabled({ KHY_VISION_POOL_FAIL_STATUS_HUMANIZE: 'off' }), false);
  });
});

// ── ② 源级接线断言(两发射站都委派本叶)────────────────────────────────────────────
describe('源级接线:aiGatewayGenerateMethod 两发射站委派 buildVisionPoolFailStatus(OPS-164)', () => {
  test('G) 两处 emit 失败站都调用 buildVisionPoolFailStatus 且传 poolName + ocrRescued', () => {
    const src = fs.readFileSync(BE + '/src/services/gateway/aiGatewayGenerateMethod.js', 'utf8');
    const calls = (src.match(/buildVisionPoolFailStatus\(\{[^}]*poolName[^}]*ocrRescued[^}]*\}\)/g) || []);
    assert.ok(calls.length >= 2, `两发射站都应委派本叶,实得 ${calls.length}`);
    assert.match(src, /require\('\.\/visionPoolFailStatus'\)/, '应 require 本叶');
    assert.match(src, /_ocrImageTextRead === true/, 'ocrRescued 应源自 options._ocrImageTextRead === true');
  });
});

// ── ③ 端到端(in-process,视觉位 404 → 文本位承接;唯一 model 名规避路由记忆污染)──────
describe('端到端:视觉池 404 + OCR 兜底 → 状态人话化 / 门关 byte-revert(OPS-164)', () => {
  const env = h.envSandbox(['KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL', 'KHY_TOOL_CAP_PROBE', 'KHY_VISION_POOL_FAIL_STATUS_HUMANIZE']);

  before(() => {
    env.save();
    env.set({ KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '', KHY_TOOL_CAP_PROBE: 'off' });
  });
  after(() => env.restore());

  function runCascade(model, onGateEnv) {
    if (onGateEnv === 'off') process.env.KHY_VISION_POOL_FAIL_STATUS_HUMANIZE = 'off';
    else delete process.env.KHY_VISION_POOL_FAIL_STATUS_HUMANIZE;
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => [{ text: 'INVOICE 2026' }],
      collectProviderSiblingModels: () => [],
    });
    const reject = h.makeRejectAdapter({ name: 'visionpool' });
    const rec = h.makeRecordingAdapter({ content: '已据 OCR 作答', captureImages: true });
    h.wireCascade(reject, rec);
    const runner = h.makeRunner({ prompt: '请识别图片', model, tag: 'e2e-' + model });
    const statuses = [];
    return runner.run({
      images: [{ base64: 'ZmFrZQ==', mimeType: 'image/png' }],
      onChunk: (c) => { if (c && c.type === 'status' && c.text) statuses.push(String(c.text)); },
    }).then((res) => ({ res, statuses }));
  }

  test('H) 门开 → 视觉池 404 换人话「视觉通道当前不可用…」,不再打原始 404', async () => {
    const { res, statuses } = await runCascade('e2e-humanize-on', 'default');
    assert.equal(res.success, true, '应成功兜底作答');
    assert.ok(statuses.some((s) => HUMAN_RE.test(s)), `应出现人话化状态,实得:\n${statuses.join('\n')}`);
    assert.ok(!statuses.some((s) => RAW_RE.test(s)), '门开不得再打原始 `visionpool 失败: 404`');
  });

  test('I) 门关 → 逐字节回退原始诊断 `visionpool 失败: 404`,无人话化', async () => {
    const { res, statuses } = await runCascade('e2e-humanize-off', 'off');
    assert.equal(res.success, true, '门关也应成功兜底');
    assert.ok(statuses.some((s) => RAW_RE.test(s)), `门关应保留原始诊断,实得:\n${statuses.join('\n')}`);
    assert.ok(!statuses.some((s) => HUMAN_RE.test(s)), '门关不得出现人话化(byte-revert)');
  });
});

// ── ④ 真实图片端到端(真 tesseract OCR;缺工具链干净跳过)────────────────────────────
describe('真实图片:无识图模型下准确识别 + 视觉池噪音人话化(OPS-164)', () => {
  const env = h.envSandbox(['KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL', 'KHY_TOOL_CAP_PROBE', 'KHY_VISION_POOL_FAIL_STATUS_HUMANIZE']);
  const _py = h.findPythonWithPil();
  const _toolchainOk = h.tesseractPresent() && h.haveTesseractLang('eng') && !!_py;
  let _pngPath = null;

  before(() => {
    env.save();
    env.set({ KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '', KHY_TOOL_CAP_PROBE: 'off' });
    delete process.env.KHY_VISION_POOL_FAIL_STATUS_HUMANIZE;
    if (_toolchainOk) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-164-'));
      _pngPath = path.join(dir, 'invoice.png');
      const r = h.renderPng(_py, { outPath: _pngPath, size: [720, 200], texts: [
        { xy: [30, 40], text: 'INVOICE ACME 2026', fill: [0, 0, 0] },
        { xy: [30, 110], text: 'TOTAL USD 1234', fill: [0, 0, 0] },
      ], fontSize: 44 });
      if (r.missingPil || !r.exists) _pngPath = null;
    }
  });

  after(() => {
    env.restore();
    try { if (_pngPath) fs.rmSync(path.dirname(_pngPath), { recursive: true, force: true }); } catch { /* ignore */ }
    genLeaf.setAiGatewayGenerateMethodDeps({ collectProviderSiblingModels: h.gw.collectProviderSiblingModels });
  });

  test('K) 真 PNG → 真 OCR 准确识别 + 视觉池 404 人话化(门开)', async (t) => {
    if (!_toolchainOk || !_pngPath) { t.skip('tesseract / eng / Pillow 不可用,跳过真实图片核验'); return; }
    // 用 harness 的生产镜像真实 OCR 执行器(→ tesseract)替换先前测试的桩,清空视觉候选走 ocr-fallback。
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: (imgs) => h.realExtractImageOcrDetails(imgs),
      collectProviderSiblingModels: () => [],
    });
    const reject = h.makeRejectAdapter({ name: 'visionpool' });
    const rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true });
    h.wireCascade(reject, rec);
    const runner = h.makeRunner({ prompt: '请识别这张图片里的信息', model: 'e2e-real-image-164', tag: 'e2e-real' });
    const statuses = [];
    const b64 = fs.readFileSync(_pngPath).toString('base64');
    const res = await runner.run({
      images: [{ base64: b64, mimeType: 'image/png' }],
      onChunk: (c) => { if (c && c.type === 'status' && c.text) statuses.push(String(c.text)); },
    });
    assert.equal(res.success, true, '真实图片也应成功兜底作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /1234/, '真实 OCR 文本(金额)应注入 prompt → 准确识别');
    assert.match(rec.finalPrompt || '', /INVOICE/i, '真实 OCR 文本(标记)应注入 prompt');
    assert.ok(statuses.some((s) => HUMAN_RE.test(s)), `视觉池 404 应人话化,实得:\n${statuses.join('\n')}`);
    assert.ok(!statuses.some((s) => RAW_RE.test(s)), '门开不得再打原始 404 噪音');
  });
});
