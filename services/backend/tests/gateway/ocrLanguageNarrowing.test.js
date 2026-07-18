'use strict';

/**
 * ocrLanguageNarrowing.test.js — 用**一张真实图片**端到端核验「没有识图模型下准确识别图片」+
 * 语言包窄化诚实:真实 extractImageOcrSnippet → 真 docHelper.py → 真 tesseract 提取,验证
 *   (a) 请求本机已装语言(eng)→ 文字被**准确识别**、requestedLang===lang、无误报语言告诫;
 *   (b) 请求含未装语言(eng+zzz,zzz 永不存在)→ 文字仍提取(eng 生效),但 requestedLang 保留
 *       原始请求、lang 被窄化成 eng,纯叶 computeDroppedLangs 报出 ['zzz'] 并渲染诚实告诫。
 *
 * 背景(/goal 2026-07-12,第四条正交诚实轴,直击「准确识别图片」):docHelper.py 把请求语言经
 * _resolve_lang 窄化成本机装了 traineddata 的子集,此前只返回窄化后的 lang、从不返回原始请求 →
 * 缺语言包时被丢弃语言的文字被沉默吞掉。本测试证明该事实现已如实穿过 service 抵达纯叶。
 *
 * 可移植性:缺 tesseract / 缺 eng 语言包 / 缺带 Pillow 的 Python → test.skip 干净跳过,绝不假失败。
 * 用 'zzz' 这个绝不存在的语言码保证「未装语言」在任何机器上都成立,不依赖具体 jpn/chi_sim 是否装。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BE = path.resolve(__dirname, '..', '..');
const ocr = require(BE + '/src/services/ocrSnippetService');
const langLeaf = require(BE + '/src/services/gateway/ocrLanguageNotice');
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

function _renderRealPng(py, outPath) {
  const script = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    'img=Image.new("RGB",(520,110),"white")',
    'd=ImageDraw.Draw(img)',
    'try:',
    '    f=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",40)',
    'except Exception:',
    '    f=ImageFont.load_default()',
    'd.text((20,20), "INVOICE ACME 2026", fill="black", font=f)',
    'd.text((20,65), "TOTAL USD 1234", fill="black", font=f)',
    'img.save(sys.argv[1]); print("saved")',
  ].join('\n');
  const r = spawnSync(py, ['-c', script, outPath], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(outPath);
}

describe('OCR 语言包窄化诚实 + 准确识别(real image, no vision model)', () => {
  let py = null;
  let tmpDir = null;
  let pngPath = null;
  let ready = false;

  before(() => {
    const langs = _tesseractLangs();
    if (!langs || !langs.includes('eng')) return; // 需 tesseract + eng 语言包
    py = _pythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-lang-'));
    pngPath = path.join(tmpDir, 'inv.png');
    ready = _renderRealPng(py, pngPath);
  });

  after(() => {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('已装语言(eng):准确识别文字,requestedLang===lang,无误报语言告诫', (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    const res = ocr.extractImageOcrSnippet(pngPath, 'image/png', { lang: 'eng', maxChars: 100000, cache: false });
    assert.equal(res.success, true, `OCR 应成功: ${res.error || ''}`);
    // 准确识别:关键 token 必须出现(证明「没有识图模型下」也能提取图片信息)
    assert.match(res.text.toUpperCase(), /INVOICE/, '应准确识别出 INVOICE');
    assert.match(res.text.toUpperCase(), /1234/, '应准确识别出金额 1234');
    assert.equal(res.requestedLang, 'eng', 'requestedLang 应为原始请求 eng');
    assert.equal(res.lang, 'eng', '已装 → 生效语言 eng,未被窄化');
    assert.deepEqual(langLeaf.computeDroppedLangs([res]), [], '无缺包 → 无丢弃');
    assert.equal(langLeaf.buildLanguageNotice({ dropped: langLeaf.computeDroppedLangs([res]), env: {} }), null,
      '无窄化不得误报语言告诫');
  });

  test('含未装语言(eng+zzz):文字仍提取,lang 窄化为 eng,requestedLang 保留,纯叶报 [zzz] 并告诫', (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    const res = ocr.extractImageOcrSnippet(pngPath, 'image/png', { lang: 'eng+zzz', maxChars: 100000, cache: false });
    assert.equal(res.success, true, `OCR 应成功(eng 生效): ${res.error || ''}`);
    assert.match(res.text.toUpperCase(), /INVOICE/, 'eng 部分仍准确识别');
    assert.equal(res.requestedLang, 'eng+zzz', 'requestedLang 保留原始请求(含未装 zzz)');
    assert.equal(res.lang, 'eng', 'zzz 未装 → 被窄化,生效仅 eng');
    const dropped = langLeaf.computeDroppedLangs([res]);
    assert.deepEqual(dropped, ['zzz'], '纯叶应算出被丢弃语言 zzz');
    const notice = langLeaf.buildLanguageNotice({ dropped, env: {} });
    assert.ok(notice, '应渲染语言包缺失诚实告诫');
    assert.match(notice, /未安装以下 OCR 语言包/);
    assert.match(notice, /zzz/, '告诫应指名被丢弃的 zzz');
  });
});
