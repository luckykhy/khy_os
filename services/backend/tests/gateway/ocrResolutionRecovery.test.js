'use strict';

/**
 * ocrResolutionRecovery.test.js — 用**一张真实低分辨率图片**端到端核验「没有识图模型下准确识别图片」+
 * 低分辨率自动放大(第六条正交轴、第二条「纠正型」,与方向轴并列):真实 extractImageOcrSnippet →
 * 真 docHelper.py → 真 tesseract,把一张**被硬缩小到极低分辨率的发票图**喂进纯 OCR 路径,验证:
 *   (a) 门关(KHY_OCR_UPSCALE=off):逐字节回退历史行为——原始尺寸下 tesseract 读不出任何东西
 *       (success:false 或空文本、不含 INVOICE)、upscaledFactor===0;
 *   (b) 门开(default-on):docHelper 暴力试 2/3/4× 放大取置信度最高者,文字被**真正复原**——text 命中
 *       INVOICE、upscaledFactor>1,纯叶 computeUpscaledFactors 报出倍数并渲染诚实告诫;
 *   (c) 门开 + 高清图(对照):清晰图绝不被无谓放大——upscaledFactor===0、无告诫、文字照常识别。
 *
 * 背景(/goal 2026-07-12,直击「能在没有识别图形的模型下,准确识别图片」尤其分辨率过低的小图):
 * tesseract 想要 ~300 DPI;分辨率过低的小图在原始尺寸下 OCR 出空/乱码,放大后才可靠识别。方向轴管
 * 「转正」,本轴管「放大」——两条纠正型轴正交。关键差异:低分辨率图在原尺寸下读出的是**空**(而非
 * 方向轴那种「看着置信度不低的乱码」),故门关分支须容忍 success:false。
 *
 * 可移植性:缺 tesseract / 缺 eng 语言包 / 缺带 Pillow 的 Python → test.skip 干净跳过,绝不假失败。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BE = path.resolve(__dirname, '..', '..');
const ocr = require(BE + '/src/services/ocrSnippetService');
const resLeaf = require(BE + '/src/services/gateway/ocrResolutionNotice');
const { findPython } = require(BE + '/src/utils/pythonPath');

function _tesseractLangs() {
  try {
    const r = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return String(r.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.toLowerCase().startsWith('list of available'));
  } catch {
    return null;
  }
}

function _pythonWithPil() {
  let py;
  try { py = findPython(); } catch { return null; }
  if (!py) return null;
  const r = spawnSync(py, ['-c', 'from PIL import Image, ImageDraw, ImageFont; print("ok")'], { encoding: 'utf8' });
  return r.status === 0 ? py : null;
}

// 渲染一张清晰的发票图,再按 scale 硬缩小(scale<1 → 低分辨率;scale=1 → 高清对照)。
// 低分辨率图在原始尺寸下 tesseract 读不出,只有放大后才可靠识别。
function _renderLowResPng(py, outPath, scale) {
  const script = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    'scale=float(sys.argv[2])',
    'img=Image.new("RGB",(460,120),"white")',
    'd=ImageDraw.Draw(img)',
    'try:',
    '    f=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",40)',
    'except Exception:',
    '    f=ImageFont.load_default()',
    'd.text((12,16), "INVOICE ACME 2026", fill="black", font=f)',
    'if scale != 1.0:',
    '    w,h=img.size',
    '    nw,nh=max(1,int(w*scale)),max(1,int(h*scale))',
    '    img=img.resize((nw,nh), Image.LANCZOS)',
    'img.save(sys.argv[1]); print("saved")',
  ].join('\n');
  const r = spawnSync(py, ['-c', script, outPath, String(scale)], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(outPath);
}

function _withGate(value, fn) {
  const saved = process.env.KHY_OCR_UPSCALE;
  if (value === undefined) delete process.env.KHY_OCR_UPSCALE;
  else process.env.KHY_OCR_UPSCALE = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.KHY_OCR_UPSCALE;
    else process.env.KHY_OCR_UPSCALE = saved;
  }
}

describe('OCR 低分辨率自动放大 + 准确识别(real low-res image, no vision model)', () => {
  let py = null;
  let tmpDir = null;
  let lowResPath = null;
  let hiResPath = null;
  let ready = false;

  before(() => {
    const langs = _tesseractLangs();
    if (!langs || !langs.includes('eng')) return; // 需 tesseract + eng 语言包
    py = _pythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-res-'));
    lowResPath = path.join(tmpDir, 'lowres.png');
    hiResPath = path.join(tmpDir, 'hires.png');
    // 0.20 → 约 92×24,原尺寸 tesseract 读不出(success:false);放大 2× 后可靠识别。
    // 高清对照保持 1.0(460×120)。倍数经端到端实测:native-off=false → gate-on up=2 命中 INVOICE。
    ready = _renderLowResPng(py, lowResPath, 0.20) && _renderLowResPng(py, hiResPath, 1.0);
  });

  after(() => {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('门关:低分辨率图逐字节回退历史行为——原尺寸读不出,upscaledFactor=0', (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    const res = _withGate('off', () =>
      ocr.extractImageOcrSnippet(lowResPath, 'image/png', { lang: 'eng', maxChars: 100000, cache: false }));
    // 关键差异:低分辨率图在原尺寸下 tesseract 读出的是**空**(而非方向轴那种乱码),故门关
    // 可能 success:false 或空文本 —— 无论哪种,都**不应**识别出 INVOICE、也不应有放大记录。
    const recovered = res && res.success === true && /INVOICE/.test(String(res.text || '').toUpperCase());
    assert.equal(recovered, false, '门关:原始尺寸不应识别出 INVOICE');
    assert.equal(Number(res.upscaledFactor) || 0, 0, '门关:绝不放大');
    assert.deepEqual(resLeaf.computeUpscaledFactors([res]), [], '无放大 → 无倍数');
  });

  test('门开:低分辨率图被放大,文字真正复原——命中 INVOICE,upscaledFactor>1,告诫触发', (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    const res = _withGate('1', () =>
      ocr.extractImageOcrSnippet(lowResPath, 'image/png', { lang: 'eng', maxChars: 100000, cache: false }));
    assert.equal(res.success, true, `OCR 应成功: ${res.error || ''}`);
    // 核心:分辨率过低的图在没有识图模型下也被**准确识别**
    assert.match(String(res.text || '').toUpperCase(), /INVOICE/, '门开:放大后应准确识别 INVOICE');
    assert.ok(Number(res.upscaledFactor) > 1, `应记录放大倍数 (got ${res.upscaledFactor})`);
    const factors = resLeaf.computeUpscaledFactors([res]);
    assert.equal(factors.length, 1, '应报出一个放大倍数');
    const notice = resLeaf.buildResolutionNotice({ upscaled: factors, env: {} });
    assert.ok(notice, '应渲染低分辨率放大诚实告诫');
    assert.match(notice, /自动放大/);
    assert.match(notice, new RegExp(`${factors[0]}×`), '告诫应指名放大倍数');
  });

  test('门开 + 高清图(对照):清晰图绝不被无谓放大——upscaledFactor=0,无告诫,照常识别', (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    const res = _withGate('1', () =>
      ocr.extractImageOcrSnippet(hiResPath, 'image/png', { lang: 'eng', maxChars: 100000, cache: false }));
    assert.equal(res.success, true, `OCR 应成功: ${res.error || ''}`);
    assert.match(String(res.text || '').toUpperCase(), /INVOICE/, '高清图照常准确识别');
    assert.equal(Number(res.upscaledFactor) || 0, 0, '高清高置信图绝不被无谓放大');
    assert.deepEqual(resLeaf.computeUpscaledFactors([res]), [], '无放大 → 无倍数');
    assert.equal(resLeaf.buildResolutionNotice({ upscaled: [], env: {} }), null, '无放大不得误报告诫');
  });
});
