'use strict';

/**
 * setOfMarks.test.js — Computer Use 混合感知：SoM 视觉标注（截图 + UI 树标注）。
 *
 * 覆盖：纯 JS RGB PNG 编码器、元素描边 + 编号徽标绘制、无包围盒跳过、
 * 越界元素裁剪、markedCount=0 时回退原图、编码解码 roundtrip。
 * 全程内存生成 PNG，零真实截屏。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const som = require('../../../src/services/computerUse/setOfMarks');
const sd = require('../../../src/services/computerUse/stateDetector');

// ── 测试用最小 PNG 编码器（生成原始截图）────────────────────────────────────

function _crc32(buf) {
  let table = _crc32.table;
  if (!table) {
    table = _crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
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

function encodeGrayPng(w, h, paint) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const v = paint(x, y);
      raw[p++] = v; raw[p++] = v; raw[p++] = v;
    }
  }
  return Buffer.concat([
    sig,
    _chunk('IHDR', ihdr),
    _chunk('IDAT', zlib.deflateSync(raw)),
    _chunk('IEND', Buffer.alloc(0)),
  ]);
}

let _dir = null;
function setupShot() {
  if (!_dir) _dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-som-test-'));
  const shot = path.join(_dir, 'shot.png');
  fs.writeFileSync(shot, encodeGrayPng(200, 120, () => 180));
  return shot;
}

afterAll(() => {
  if (_dir) fs.rmSync(_dir, { recursive: true, force: true });
});

const el = (id, index, b) => ({ id, index, role: 'button', name: `n${id}`, bounds: b, clickable: true, editable: false });

describe('setOfMarks — RGB PNG 编码器', () => {
  test('encodePng 输出可被 decodePng 还原的 RGB 图', () => {
    const raw = Buffer.alloc(8 * 6 * 4);
    for (let i = 0; i < raw.length; i += 4) {
      raw[i] = (i / 4) % 255; raw[i + 1] = 120; raw[i + 2] = 40; raw[i + 3] = 255;
    }
    const png = som.encodePng(8, 6, raw);
    const dec = sd.decodePng(png);
    expect(dec.width).toBe(8);
    expect(dec.height).toBe(6);
    expect(dec.data[0]).toBe(0);
    expect(dec.data[4]).toBe(1);
  });
});

describe('setOfMarks — SoM 视觉标注', () => {
  test('为有包围盒的元素画描边 + 编号，输出可解码新图', () => {
    const shot = setupShot();
    const r = som.renderMarks(shot, [el('e1', 0, { x: 20, y: 30, w: 80, h: 30 }), el('e2', 1, { x: 20, y: 70, w: 120, h: 25 })]);
    expect(r.markedCount).toBe(2);
    expect(r.path).not.toBe(shot);
    expect(fs.existsSync(r.path)).toBe(true);
    // 输出图与原图尺寸一致且像素有变化（画了框）
    const before = sd.decodePng(fs.readFileSync(shot));
    const after = sd.decodePng(fs.readFileSync(r.path));
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    let diff = 0;
    for (let i = 0; i < before.data.length; i += 4) {
      if (before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] || before.data[i + 2] !== after.data[i + 2]) diff += 1;
    }
    expect(diff).toBeGreaterThan(0);
  });

  test('无包围盒元素跳过，全无时回退原图（markedCount=0）', () => {
    const shot = setupShot();
    const r = som.renderMarks(shot, [{ id: 'e1', role: 'button', name: 'x', clickable: false, editable: false }]);
    expect(r.markedCount).toBe(0);
    expect(r.path).toBe(shot);
  });

  test('越界元素被裁剪且不抛错', () => {
    const shot = setupShot();
    const r = som.renderMarks(shot, [
      el('e1', 0, { x: -10, y: -10, w: 40, h: 40 }),   // 部分越界
      el('e2', 1, { x: 5000, y: 5000, w: 100, h: 100 }), // 完全越界
    ]);
    expect(r.markedCount).toBe(2);
    const dec = sd.decodePng(fs.readFileSync(r.path));
    expect(dec.width).toBe(200);
    expect(dec.height).toBe(120);
  });

  test('max 限制标注数量', () => {
    const shot = setupShot();
    const elements = Array.from({ length: 50 }, (_, i) => el(`e${i + 1}`, i, { x: 10, y: 10 + i * 2, w: 40, h: 10 }));
    const r = som.renderMarks(shot, elements, { max: 10 });
    expect(r.markedCount).toBe(10);
  });

  test('_numberOf 从 id 提取编号（e12 → "12"）', () => {
    expect(som._internals._numberOf({ id: 'e12', index: 11 })).toBe('12');
    expect(som._internals._numberOf({ index: 2 })).toBe('3');
    expect(som._internals._numberOf({})).toBe('');
  });
});
