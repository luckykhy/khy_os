'use strict';

/**
 * ocrSnippetTruncation.test.js �?�?*一张真实图�?*核验 extractImageOcrSnippet 新暴露的
 * `truncated` 结构化字�?当上�?OCR 全文超过 maxChars 被截断时,输出对象必须如实报告
 * truncated===true(此前该事实只有内嵌英�?`...[truncated]` 标记、从不作为结构化字段离开
 * 本服�?导致 gateway 把残缺文本当完整依据注入)�?
 *
 * 背景(/goal 2026-07-12,与低置信告诫 / 覆盖率告诫正�?本条�?*单图内文本完整�?*):
 * 纯文本模�?+ 图片 �?本地 OCR 兜底�?一张稠密文�?截图的识别文本可能超�?maxChars(默认
 * 1200)被截掉尾�?模型却被告知「请据此作答」而不知内容不完整。本测试用极�?maxChars
 * 确定性触发截�?并用�?maxChars 证明同一张干净�?*不误�?*�?
 *
 * 可移植�?�?tesseract / 缺带 Pillow �?Python �?test.skip 干净跳过,绝不假失败�?
 * 真实图片仅测试时临时生成、用后即�?绝不进仓库�?
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BE = path.resolve(__dirname, '..', '..');
const ocr = require(BE + '/src/services/ocrSnippetService');
const { findPython } = require(BE + '/src/utils/pythonPath');

function _tesseractOk() {
  try {
    return spawnSync('tesseract', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

function _pythonWithPil() {
  let py;
  try { py = findPython(); } catch { return null; }
  if (!py) return null;
  const r = spawnSync(py, ['-c', 'from PIL import Image, ImageDraw, ImageFont; print("ok")'], { encoding: 'utf8' });
  return r.status === 0 ? py : null;
}

// 渲染一张含多行较长 ASCII 文字的真�?PNG(内容可被 tesseract 稳定识别、且总长足够超过 maxChars
// 的下�?120:extractImageOcrSnippet 内部 Math.max(120, maxChars) 会把过小的上限夹�?120)�?
const _LINES = [
  'INVOICE 2026-07-12',
  'TOTAL USD 1234.56',
  'VENDOR ACME CORP',
  'REF 9F3A21XK',
  'TAX RATE 13 PCT',
  'DUE DATE 2026 08 01',
  'ITEM COUNT 42',
  'STATUS APPROVED',
  'BUYER GLOBEX LTD',
  'NOTE PAID IN FULL',
];
function _renderRealPng(py, outPath) {
  const script = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    'lines=sys.argv[2:]',
    'W,H=760,60+70*len(lines)',
    'img=Image.new("RGB",(W,H),"white")',
    'd=ImageDraw.Draw(img)',
    'try:',
    '    f=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",40)',
    'except Exception:',
    '    f=ImageFont.load_default()',
    'y=30',
    'for ln in lines:',
    '    d.text((30,y), ln, fill="black", font=f); y+=70',
    'img.save(sys.argv[1])',
    'print("saved")',
  ].join('\n');
  const r = spawnSync(py, ['-c', script, outPath, ..._LINES], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(outPath);
}

describe('extractImageOcrSnippet truncated field (real image)', () => {
  let py = null;
  let tmpDir = null;
  let pngPath = null;
  let ready = false;

  before(() => {
    if (!_tesseractOk()) return;
    py = _pythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ocr-trunc-'));
    pngPath = path.join(tmpDir, 'dense.png');
    ready = _renderRealPng(py, pngPath);
  });

  after(() => {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('�?maxChars(夹到下限 120)�?truncated===true 且文本带 [truncated] 标记', (t) => {
    if (!ready) { t.skip('tesseract / Pillow 不可�?跳过'); return; }
    // extractImageOcrSnippet 内部�?maxChars 夹到下限 120,故图中文字总长�?> 120 才能触发截断
    // (本图 10 行约 160+ 字符)。cache:false 避免与下一条大 maxChars 用例串味�?
    const res = ocr.extractImageOcrSnippet(pngPath, 'image/png', { maxChars: 120, cache: false });
    expect(res.success).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.text).toMatch(/\.\.\.\[truncated\]$/);
    expect(res.text.length <= 120 + '\n...[truncated]'.length).toBeTruthy();
  });

  test('充足 maxChars �?truncated===false(同一张干净图不误报)', (t) => {
    if (!ready) { t.skip('tesseract / Pillow 不可�?跳过'); return; }
    const res = ocr.extractImageOcrSnippet(pngPath, 'image/png', { maxChars: 100000, cache: false });
    expect(res.success).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.text).not.toMatch(/\[truncated\]/);
  });
});

