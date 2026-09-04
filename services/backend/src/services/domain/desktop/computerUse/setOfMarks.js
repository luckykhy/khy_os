'use strict';

/**
 * setOfMarks.js — Computer Use 混合感知：Set-of-Mark（SoM）视觉标注（对应「GUI Agents 综述」3.1）。
 *
 * 综述指出：混合方案（截图 + UI 树，并把 UI 元素标注到截图上）是当前最优感知方式——
 * 纯视觉定位不准（像素级坐标回归误差大），纯结构丢视觉信息（颜色/布局/图标）。
 * 本模块把可交互元素【直接画到截图上】：为每个元素画彩色描边框 + 左上角编号徽标，
 * 再送回视觉模型。Agent 输出编号即可完成定位——将「连续坐标回归」转化为「离散选择」。
 *
 * 实现零外部依赖：复用 stateDetector 的纯 JS PNG 解码（RGBA），手写 5x7 位图数字字体
 * 与 RGB PNG 编码器，不依赖 pngjs/sharp 等未声明依赖。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { decodePng } = require('./stateDetector');

// ── 样式 ──────────────────────────────────────────────────────────────────

const MARK_BORDER = { r: 0x00, g: 0x9b, b: 0xff }; // 亮蓝描边
const CHIP_BG = { r: 0xff, g: 0xff, b: 0xff }; // 白底编号徽标
const CHIP_FG = { r: 0x0a, g: 0x0a, b: 0x0a }; // 深色数字
const CHIP_BORDER = { r: 0x00, g: 0x00, b: 0x00 };
const BORDER_WIDTH = 2;

// 5x7 位图数字字体（行=顶到底，每行低 5 bit 有效，bit4..bit0 = 左..右）
const FONT = {
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
};
const FONT_W = 5;
const FONT_H = 7;
const CHIP_PAD_X = 3;
const CHIP_PAD_Y = 1;

let _seq = 0;

/** SoM 输出目录：受管临时目录 khy-desktop/marks。 */
function marksDir() {
  return path.join(os.tmpdir(), 'khy-desktop', 'marks');
}

function _ensureMarksDir() {
  const dir = marksDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ── 像素绘制（RGBA 缓冲上直接改）────────────────────────────────────────────

function _px(data, w, x, y, color) {
  if (x < 0 || y < 0 || x >= w) {
    return;
  }
  const o = (y * w + x) * 4;
  // 越过图像下界的调用由调用方裁剪，这里只兜底
  if (o + 3 >= data.length) {
    return;
  }
  data[o] = color.r;
  data[o + 1] = color.g;
  data[o + 2] = color.b;
  data[o + 3] = 255;
}

function _fillRect(data, w, h, x0, y0, x1, y1, color) {
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  const ex = Math.min(w - 1, x1 - 1);
  const ey = Math.min(h - 1, y1 - 1);
  for (let y = sy; y <= ey; y++) {
    for (let x = sx; x <= ex; x++) {
      _px(data, w, x, y, color);
    }
  }
}

function _drawRect(data, w, h, x0, y0, x1, y1, color, thickness = BORDER_WIDTH) {
  _fillRect(data, w, h, x0, y0, x1, y0 + thickness, color); // 上
  _fillRect(data, w, h, x0, y1 - thickness, x1, y1, color); // 下
  _fillRect(data, w, h, x0, y0, x0 + thickness, y1, color); // 左
  _fillRect(data, w, h, x1 - thickness, y0, x1, y1, color); // 右
}

function _drawString(data, w, h, text, x, y, color) {
  let cx = x;
  for (const ch of String(text)) {
    const rows = FONT[ch];
    if (!rows) {
      continue;
    }
    for (let row = 0; row < FONT_H; row++) {
      const bits = rows[row];
      for (let col = 0; col < FONT_W; col++) {
        if (bits & (1 << (4 - col))) {
          _px(data, w, cx + col, y + row, color);
        }
      }
    }
    cx += FONT_W + 1;
  }
}

// ── RGB PNG 编码器（8-bit 非隔行，与解码器互补）──────────────────────────────

function _crc32(buf) {
  let table = _crc32.table;
  if (!table) {
    table = _crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function _chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(_crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** 把 RGBA 缓冲编码为 RGB PNG。 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: None
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const o = rowStart + x * 4;
      raw[p++] = rgba[o];
      raw[p++] = rgba[o + 1];
      raw[p++] = rgba[o + 2];
    }
  }
  return Buffer.concat([
    sig,
    _chunk('IHDR', ihdr),
    _chunk('IDAT', zlib.deflateSync(raw)),
    _chunk('IEND', Buffer.alloc(0)),
  ]);
}

function _toRgb(rgba) {
  return rgba; // encodePng 直接读 RGBA 的前 3 字节
}

// ── 主入口 ────────────────────────────────────────────────────────────────

/** 从元素 id（e12）或 index 提取徽标编号字符串。 */
function _numberOf(el) {
  if (el && typeof el.id === 'string') {
    const m = el.id.match(/^e(\d+)$/i);
    if (m) {
      return m[1];
    }
  }
  if (el && Number.isFinite(el.index)) {
    return String(el.index + 1);
  }
  return '';
}

/**
 * 在截图上为可交互元素绘制 SoM 标记（描边框 + 编号徽标），输出新 PNG。
 * @param {string} screenshotPath 原截图（PNG）
 * @param {Array}  elements       规范化元素（含 bounds）
 * @param {object} [opts] { max=30 } 最多标注多少个（避免画面被框淹没）
 * @returns {{ path:string, markedCount:number, skipped:number }}
 *          markedCount=0 时原样返回原图路径（无标注文件）。
 */
function renderMarks(screenshotPath, elements, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 30;
  const buf = fs.readFileSync(screenshotPath);
  const { width, height, data } = decodePng(buf);
  const list = Array.isArray(elements) ? elements.slice(0, max) : [];
  let marked = 0;
  let skipped = 0;
  for (const el of list) {
    const b = el && el.bounds;
    if (!b || !(Number.isFinite(b.w) && b.w > 0) || !(Number.isFinite(b.h) && b.h > 0)) {
      skipped += 1;
      continue;
    }
    const x0 = Math.max(0, Math.round(b.x));
    const y0 = Math.max(0, Math.round(b.y));
    const x1 = Math.max(x0 + 1, Math.min(width, Math.round(b.x + b.w)));
    const y1 = Math.max(y0 + 1, Math.min(height, Math.round(b.y + b.h)));
    _drawRect(data, width, height, x0, y0, x1, y1, MARK_BORDER);

    const label = _numberOf(el);
    const chipW = label.length * (FONT_W + 1) + CHIP_PAD_X * 2;
    const chipH = FONT_H + CHIP_PAD_Y * 2;
    const cx = x0;
    let cy = y0 - chipH - 1;
    if (cy < 0) {
      cy = Math.min(Math.max(0, y0 + 2), Math.max(0, height - chipH));
    }
    _fillRect(data, width, height, cx, cy, cx + chipW, cy + chipH, CHIP_BG);
    _drawRect(data, width, height, cx, cy, cx + chipW, cy + chipH, CHIP_BORDER, 1);
    if (label) {
      _drawString(data, width, height, label, cx + CHIP_PAD_X, cy + CHIP_PAD_Y, CHIP_FG);
    }
    marked += 1;
  }

  if (marked === 0) {
    return { path: screenshotPath, markedCount: 0, skipped };
  }
  const out = path.join(_ensureMarksDir(), `som_${process.pid}_${++_seq}.png`);
  fs.writeFileSync(out, encodePng(width, height, _toRgb(data)));
  return { path: out, markedCount: marked, skipped };
}

module.exports = {
  renderMarks,
  encodePng,
  marksDir,
  FONT,
  FONT_W,
  FONT_H,
  _internals: { _numberOf, _drawRect, _fillRect, _drawString, _px },
};
