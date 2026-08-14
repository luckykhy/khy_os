'use strict';

/**
 * imageOcrFallbackRealImage.test.js — 用**一张真实图片**端到端核验「纯文本模型 + 图片输入
 * + 无可用视觉模型 → 本地 OCR 兜底」。
 *
 * 背景(/goal 2026-07-11「需要你用一张真实图片核验」):姊妹测试 imageOcrFallbackWiring
 * 已锁定接线,但它把 extractImageOcrTexts **打桩**返回固定文本,并未真正驱动本地 OCR 执行器
 * (ocrSnippetService → docHelper.py → tesseract)。本测试补上最后一环:
 *
 *   - 在测试时用 Pillow 渲染一张**含已知文字**的真实 PNG(不落任何仓库固件);
 *   - 不打桩 extractImageOcrTexts —— require('aiGateway') 加载时已把**真实** OCR 执行器
 *     (ocrSnippetService → docHelper.py → tesseract)注入 genLeaf,本测试原样使用它;
 *   - 驱动真实 generate() 走纯文本模型 + 无视觉候选,钉死两个不变量:
 *       ① 非视觉模型永不收到裸图(adapter 的 options.images 必为空);
 *       ② 真实 OCR 文本落进最终 prompt(原文本模型据此作答)。
 *
 * 可移植性:tesseract 或可用 Python(带 Pillow)缺任一 → test.skip 干净跳过,CI 保持确定性,
 * 绝不因缺工具链而假失败。真实图片仅在测试时临时生成、用后即删,绝不进仓库、绝不落盘残留。
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

// 已知文字:唯一、可被 tesseract 稳定识别的 ASCII(避开字库/语言依赖)。
const _OCR_MARK = 'INVOICE 2026-07-11';
const _OCR_AMOUNT = 'TOTAL USD 1234.56';

// 用 Pillow 渲染一张含 _OCR_MARK / _OCR_AMOUNT 的真实 PNG,返回是否成功落盘。
function _renderRealPng(py, outPath) {
  const r = h.renderPng(py, {
    outPath,
    size: [720, 200],
    bg: [255, 255, 255],
    texts: [
      { xy: [30, 40], text: _OCR_MARK, fill: [0, 0, 0] },
      { xy: [30, 110], text: _OCR_AMOUNT, fill: [0, 0, 0] },
    ],
    fontSize: 44,
  });
  return !r.missingPil && r.exists;
}

// ── 环境隔离:同姊妹测试,关掉会额外发起 adapter 调用/改路由的旁路门 ──
const env = h.envSandbox(['KHY_TOOL_CAP_PROBE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL']);
const runner = h.makeRunner({ prompt: '请识别这张图片里的信息', model: 'text-only-model', tag: 'real' });

let rec;

const _py = h.findPythonWithPil();
const _toolchainOk = h.tesseractPresent() && !!_py;

describe('image → OCR fallback with a REAL image (text-only model, vision unavailable)', () => {
  let _pngPath;

  before(() => {
    env.save();
    env.set({ KHY_TOOL_CAP_PROBE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '' });
    if (_toolchainOk) {
      _pngPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-real-')), 'invoice.png');
      if (!_renderRealPng(_py, _pngPath)) _pngPath = null;
    }
  });

  after(() => {
    env.restore();
    // 真实图片用后即删,绝不残留。
    try {
      if (_pngPath) {
        fs.rmSync(path.dirname(_pngPath), { recursive: true, force: true });
      }
    } catch { /* best-effort cleanup */ }
    // 只重置本测试改写过的 sibling 桩;extractImageOcrTexts 从未被覆盖(见下),故无需恢复。
    genLeaf.setAiGatewayGenerateMethodDeps({
      collectProviderSiblingModels: h.gw.collectProviderSiblingModels,
    });
  });

  test('真实 PNG → 真实 tesseract OCR 文本落进纯文本模型的 prompt,且裸图被剥离', async (t) => {
    if (!_toolchainOk) {
      t.skip('tesseract 或带 Pillow 的 Python 不可用,跳过真实图片核验(CI 保持确定性)');
      return;
    }
    assert.ok(_pngPath, '真实 PNG 应已渲染');

    // 关键:**不覆盖** extractImageOcrTexts —— require('aiGateway') 在模块加载时已把**真实**
    // 执行器(→ ocrSnippetService → docHelper.py → tesseract)经 setAiGatewayGenerateMethodDeps
    // 注入到 genLeaf。这里只把当前 provider 的视觉候选清空 → 走 ocr-fallback。
    genLeaf.setAiGatewayGenerateMethodDeps({
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true });
    h.wireSingle(rec);

    // 用生产同形的 base64 图片入参(前端/工具真实传入的形状,经 imageService.saveBase64ToTemp
    // 落临时文件再交 tesseract);裸 { _filePath } 会被 normalizeImages 规范化丢弃,不是生产形状。
    const b64 = fs.readFileSync(_pngPath).toString('base64');
    const res = await runner.run({ images: [{ base64: b64, mimeType: 'image/png' }] });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量①:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /1234\.56/, '不变量②:真实 OCR 文本(金额)应注入 prompt');
    assert.match(rec.finalPrompt || '', /INVOICE/i, '不变量②:真实 OCR 文本(标记)应注入 prompt');
    assert.match(rec.finalPrompt || '', /不支持视觉|OCR/, '应带有兜底说明');
  });
});
