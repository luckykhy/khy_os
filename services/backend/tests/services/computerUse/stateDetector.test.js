'use strict';

/**
 * stateDetector.test.js — Computer Use 环境反馈检测（截图 dHash diff + UI 结构 diff）。
 *
 * 覆盖：纯 JS PNG 解码（RGB/非隔行）、dHash 感知哈希与汉明距离、screenshotChanged
 * （相同画面 / 反色 / 区域变化 / 尺寸变化 / 非法文件）、元素身份键与集合差。
 * 全程内存生成 PNG，零真实截屏。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const sd = require('../../../src/services/computerUse/stateDetector');

// ── 测试用最小 PNG 编码器（RGB、8-bit、非隔行）─────────────────────────────

let _crcTable = null;
function _crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xff];
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

/** @param {(x:number,y:number)=>number} paint 返回 0..255 灰度 */
function encodeGrayPng(w, h, paint) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // compression/filter/interlace
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: None
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

function tmpPng(name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sd-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

// ── PNG 解码 ───────────────────────────────────────────────────────────────

describe('stateDetector — PNG 解码（纯 JS）', () => {
  test('decodePng 还原 RGB 像素（含行滤波解包）', () => {
    const buf = encodeGrayPng(4, 3, (x, y) => (y * 4 + x) * 40);
    const { width, height, data } = sd.decodePng(buf);
    expect(width).toBe(4);
    expect(height).toBe(3);
    // 像素 (2,1) → 亮度 (1*4+2)*40 = 240
    const i = (1 * 4 + 2) * 4;
    expect(data[i]).toBe(240);
    expect(data[i + 3]).toBe(255); // alpha 全 255
  });

  test('decodePng 拒绝非 PNG 文件', () => {
    expect(() => sd.decodePng(Buffer.from('not a png at all'))).toThrow();
  });

  test('decodePng 拒绝隔行 PNG（声明 interlace=1）', () => {
    const buf = encodeGrayPng(8, 8, () => 128);
    // 文件布局：签名(8) + IHDR len(4) + "IHDR"(4) + data(13)；interlace 是 data 的第 13 字节（偏移 12）
    const interlaceByte = 8 + 4 + 4 + 12;
    const mutated = Buffer.from(buf);
    mutated[interlaceByte] = 1;
    expect(() => sd.decodePng(mutated)).toThrow(/隔行/);
  });
});

// ── dHash / 截图变化 ───────────────────────────────────────────────────────

describe('stateDetector — 截图变化判定（截图 diff）', () => {
  test('相同画面 → 判定无变化', () => {
    const a = tmpPng('a.png', encodeGrayPng(64, 64, () => 128));
    const b = tmpPng('b.png', encodeGrayPng(64, 64, () => 128));
    const r = sd.screenshotChanged(a, b);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.distance).toBe(0);
  });

  test('反色（绝对亮度翻转）→ 判定有变化（dHash 对亮度鲁棒，但 luma diff 兜底）', () => {
    const a = tmpPng('a.png', encodeGrayPng(128, 128, (x, y) => (y < 64 ? 0 : 255)));
    const b = tmpPng('b.png', encodeGrayPng(128, 128, (x, y) => (y < 64 ? 255 : 0)));
    const r = sd.screenshotChanged(a, b);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.lumaDiff).toBeGreaterThan(2.0);
  });

  test('局部区域变化（四分之一变亮）→ 判定有变化', () => {
    const a = tmpPng('a.png', encodeGrayPng(128, 128, () => 128));
    const b = tmpPng('b.png', encodeGrayPng(128, 128, (x, y) => (x > 64 && y > 64 ? 255 : 128)));
    const r = sd.screenshotChanged(a, b);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
  });

  test('尺寸不同 → 判定有变化且 sizeChanged=true', () => {
    const a = tmpPng('a.png', encodeGrayPng(100, 100, () => 0));
    const b = tmpPng('b.png', encodeGrayPng(200, 200, () => 0));
    const r = sd.screenshotChanged(a, b);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.sizeChanged).toBe(true);
  });

  test('文件缺失/损坏 → 返回 ok=false（降级为无法判断）', () => {
    const a = tmpPng('a.png', encodeGrayPng(8, 8, () => 0));
    const r = sd.screenshotChanged(a, path.join(os.tmpdir(), 'no-such-file.png'));
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test('hammingDistance：相同哈希为 0，全异为 64', () => {
    expect(sd.hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(sd.hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(sd.hammingDistance('f0f0f0f0f0f0f0f0', '0f0f0f0f0f0f0f0f')).toBe(64);
  });

  test('dHash 对同一画面稳定', () => {
    const buf = encodeGrayPng(32, 32, (x, y) => ((x + y) % 5) * 40);
    const a = sd.pngInfo(tmpPng('a.png', buf));
    const b = sd.pngInfo(tmpPng('b.png', buf));
    expect(a.phash).toBe(b.phash);
  });

  test('pngDimensions 轻量读取 IHDR 宽高（不完整解码）', () => {
    const buf = encodeGrayPng(640, 480, () => 0);
    const f = tmpPng('dims.png', buf);
    expect(sd.pngDimensions(f)).toEqual({ width: 640, height: 480 });
    expect(sd.pngDimensions(path.join(os.tmpdir(), 'no-such-file.png'))).toBeNull();
  });
});

// ── 元素结构 diff ──────────────────────────────────────────────────────────

describe('stateDetector — UI 结构 diff（部件树）', () => {
  const btn = (name, x, y) => ({ role: 'button', name, center: { x, y }, clickable: true, editable: false });
  const field = (name, x, y) => ({ role: 'textfield', name, center: { x, y }, clickable: true, editable: true });

  test('新增/消失元素被识别', () => {
    const before = [btn('登录', 10, 10), field('邮箱', 10, 60)];
    const after = [btn('登录', 10, 10), btn('提交', 200, 10)];
    const d = sd.diffElements(before, after);
    expect(d.addedCount).toBe(1);
    expect(d.removedCount).toBe(1);
    expect(d.added[0].name).toBe('提交');
    expect(d.removed[0].name).toBe('邮箱');
  });

  test('单元格内小位移不误报为变化（8px 网格量化容忍）', () => {
    const before = [btn('登录', 10, 10)]; // round(10/8)=1 → 格 (1,1)
    const after = [btn('登录', 11, 11)];  // round(11/8)=1 → 仍在同一格
    const d = sd.diffElements(before, after);
    expect(d.addedCount).toBe(0);
    expect(d.removedCount).toBe(0);
    expect(d.changedCount).toBe(0);
  });

  test('跨网格位移记入变化', () => {
    const before = [btn('登录', 10, 10)]; // → (1,1)
    const after = [btn('登录', 40, 10)];  // → (5,1)
    const d = sd.diffElements(before, after);
    expect(d.addedCount).toBe(1);
    expect(d.removedCount).toBe(1);
  });

  test('同 key 数量变化记入 changed', () => {
    const before = [btn('登录', 10, 10), btn('登录', 10, 10)]; // 重复元素（数量 2）
    const after = [btn('登录', 10, 10)];                       // 数量 1
    const d = sd.diffElements(before, after);
    expect(d.changedCount).toBe(1);
  });

  test('elementKey 稳定且 elementFingerprint 排序一致', () => {
    const els = [field('邮箱', 10, 60), btn('登录', 10, 10)];
    const fp1 = sd.elementFingerprint(els);
    const fp2 = sd.elementFingerprint([els[1], els[0]]);
    expect(fp1).toBe(fp2);
    expect(fp1).toContain('button|登录');
  });
});
