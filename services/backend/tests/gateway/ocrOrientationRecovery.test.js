'use strict';

/**
 * ocrOrientationRecovery.test.js — 用**一张真实旋转图片**端到端核验「没有识图模型下准确识别图片」+
 * 方向自动校正(第五条正交轴,唯一「纠正型」):真实 extractImageOcrSnippet → 真 docHelper.py →
 * 真 tesseract,把一张**旋转 90° 的发票图**喂进纯 OCR 路径,验证:
 *   (a) 门关(KHY_OCR_AUTO_ORIENT=off):逐字节回退历史行为——原图方向识别出的是乱码(不含 INVOICE)、
 *       orientationCorrected===0、needsAiFallback===true(低置信);
 *   (b) 门开(default-on):docHelper 暴力试 90/180/270 旋正,文字被**真正复原**——text 命中 INVOICE、
 *       orientationCorrected>0,纯叶 computeCorrectedOrientations 报出角度并渲染诚实告诫;
 *   (c) 门开 + 正向图(对照):good 图绝不被误旋转——orientationCorrected===0、无告诫、文字照常识别。
 *
 * 背景(/goal 2026-07-12,直击「能在没有识别图形的模型下,准确识别图片」尤其被旋转的图):tesseract
 * OSD(--psm 0)在稀疏文字上不可靠("Too few characters"),故 docHelper 改用暴力多方向取置信度最高者。
 * 旋转图在原方向读出「看着置信度不低」的乱码(conf~51),置信度轴只能警告、无法复原;本轴真正把文字读对。
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
const orientLeaf = require(BE + '/src/services/gateway/ocrOrientationNotice');
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

// 渲染一张正向的发票图,并把它旋转 deg 度后保存到 outPath(deg=0 即正向)。
function _renderRotatedPng(py, outPath, deg) {
  const script = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    'deg=int(sys.argv[2])',
    'img=Image.new("RGB",(640,160),"white")',
    'd=ImageDraw.Draw(img)',
    'try:',
    '    f=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",44)',
    'except Exception:',
    '    f=ImageFont.load_default()',
    'd.text((24,20), "INVOICE ACME 2026", fill="black", font=f)',
    'd.text((24,80), "TOTAL USD 1234", fill="black", font=f)',
    'if deg: img=img.rotate(deg, expand=True)',
    'img.save(sys.argv[1]); print("saved")',
  ].join('\n');
  const r = spawnSync(py, ['-c', script, outPath, String(deg)], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(outPath);
}

function _withGate(value, fn) {
  const saved = process.env.KHY_OCR_AUTO_ORIENT;
  if (value === undefined) delete process.env.KHY_OCR_AUTO_ORIENT;
  else process.env.KHY_OCR_AUTO_ORIENT = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.KHY_OCR_AUTO_ORIENT;
    else process.env.KHY_OCR_AUTO_ORIENT = saved;
  }
}

describe('OCR 方向自动校正 + 准确识别(real rotated image, no vision model)', () => {
  let py = null;
  let tmpDir = null;
  let rotatedPath = null;
  let uprightPath = null;
  let ready = false;

  before(() => {
    const langs = _tesseractLangs();
    if (!langs || !langs.includes('eng')) return; // 需 tesseract + eng 语言包
    py = _pythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-orient-'));
    rotatedPath = path.join(tmpDir, 'rotated90.png');
    uprightPath = path.join(tmpDir, 'upright.png');
    ready = _renderRotatedPng(py, rotatedPath, 90) && _renderRotatedPng(py, uprightPath, 0);
  });

  after(() => {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('门关:旋转图逐字节回退历史行为——原方向乱码,orientationCorrected=0,低置信', (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    const res = _withGate('off', () =>
      ocr.extractImageOcrSnippet(rotatedPath, 'image/png', { lang: 'eng', maxChars: 100000, cache: false }));
    assert.equal(res.success, true, `OCR 仍应产出结果: ${res.error || ''}`);
    // 历史行为:旋转图在原方向读出乱码,不含真实 token
    assert.doesNotMatch(res.text.toUpperCase(), /INVOICE/, '门关:原方向不应识别出 INVOICE(乱码)');
    assert.equal(res.orientationCorrected, 0, '门关:绝不旋正');
    // 关键洞见:此乱码置信度 ~62(>=60),needsAiFallback===false —— 正是「看着置信度不低的
    // 乱码」逃过置信度轴(OPS-104)的那一类,只有纠正型的方向轴能真正读对它。
    assert.notEqual(res.needsAiFallback, undefined, 'needsAiFallback 字段应存在');
    assert.deepEqual(orientLeaf.computeCorrectedOrientations([res]), [], '无校正 → 无角度');
  });

  test('门开:旋转图被旋正,文字真正复原——命中 INVOICE/1234,orientationCorrected>0,告诫触发', (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    const res = _withGate('1', () =>
      ocr.extractImageOcrSnippet(rotatedPath, 'image/png', { lang: 'eng', maxChars: 100000, cache: false }));
    assert.equal(res.success, true, `OCR 应成功: ${res.error || ''}`);
    // 核心:被旋转的图在没有识图模型下也被**准确识别**
    assert.match(res.text.toUpperCase(), /INVOICE/, '门开:旋正后应准确识别 INVOICE');
    assert.match(res.text.toUpperCase(), /1234/, '门开:旋正后应准确识别金额 1234');
    assert.ok(Number(res.orientationCorrected) > 0, `应记录旋正角度 (got ${res.orientationCorrected})`);
    const degs = orientLeaf.computeCorrectedOrientations([res]);
    assert.equal(degs.length, 1, '应报出一个旋正角度');
    const notice = orientLeaf.buildOrientationNotice({ corrected: degs, env: {} });
    assert.ok(notice, '应渲染方向校正诚实告诫');
    assert.match(notice, /旋转校正/);
    assert.match(notice, new RegExp(`${degs[0]}°`), '告诫应指名旋正角度');
  });

  test('门开 + 正向图(对照):good 图绝不被误旋转——orientationCorrected=0,无告诫,照常识别', (t) => {
    if (!ready) { t.skip('tesseract / eng 语言包 / Pillow 不可用,跳过'); return; }
    const res = _withGate('1', () =>
      ocr.extractImageOcrSnippet(uprightPath, 'image/png', { lang: 'eng', maxChars: 100000, cache: false }));
    assert.equal(res.success, true, `OCR 应成功: ${res.error || ''}`);
    assert.match(res.text.toUpperCase(), /INVOICE/, '正向图照常准确识别');
    assert.equal(res.orientationCorrected, 0, '正向高置信图绝不被误旋转(不做无谓校正)');
    assert.deepEqual(orientLeaf.computeCorrectedOrientations([res]), [], '无校正 → 无角度');
    assert.equal(orientLeaf.buildOrientationNotice({ corrected: [], env: {} }), null, '无校正不得误报告诫');
  });
});
