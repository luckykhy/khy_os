'use strict';

/**
 * imageMetadataProbe.test.js — 纯叶子「凭文件头推断格式/尺寸/色彩 + 中文简单描述」回归。
 * 零 IO:所有图片头用 Buffer 现造,不落盘、不调 OCR/网络/模型。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../src/services/imageMetadataProbe');

// ── 头部构造工具 ──────────────────────────────────────────────────────

function pngHeader(width, height, bitDepth = 8, colorType = 6) {
  const b = Buffer.alloc(26);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);        // IHDR length
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = bitDepth;
  b[25] = colorType;
  return b;
}

function gifHeader(width, height) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function bmpHeader(width, height, bpp = 24) {
  const b = Buffer.alloc(30);
  b.write('BM', 0, 'ascii');
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(bpp, 28);
  return b;
}

function webpVp8lHeader(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(0, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b.writeUInt32LE(0, 16);
  b[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}

function jpegHeader(width, height) {
  // SOI + SOF0(marker C0, len 17, precision 8, height, width, 3 comps...)
  const b = Buffer.alloc(20);
  b[0] = 0xff; b[1] = 0xd8;      // SOI
  b[2] = 0xff; b[3] = 0xc0;      // SOF0
  b.writeUInt16BE(17, 4);        // segment length
  b[6] = 8;                      // precision
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

// ── 探测 ──────────────────────────────────────────────────────────────

describe('probeImageMetadata — format + dimensions', () => {
  test('PNG: dims + RGBA color + alpha', () => {
    const m = probe.probeImageMetadata(pngHeader(1920, 1080, 8, 6));
    assert.equal(m.format, 'png');
    assert.equal(m.width, 1920);
    assert.equal(m.height, 1080);
    assert.equal(m.hasAlpha, true);
    assert.match(m.colorLabel, /RGBA/);
  });

  test('PNG: indexed color type 3, no alpha', () => {
    const m = probe.probeImageMetadata(pngHeader(64, 64, 8, 3));
    assert.equal(m.format, 'png');
    assert.equal(m.hasAlpha, undefined);
    assert.match(m.colorLabel, /索引/);
  });

  test('GIF: little-endian dims', () => {
    const m = probe.probeImageMetadata(gifHeader(800, 600));
    assert.equal(m.format, 'gif');
    assert.equal(m.width, 800);
    assert.equal(m.height, 600);
  });

  test('BMP: dims (abs of possibly-negative height)', () => {
    const m = probe.probeImageMetadata(bmpHeader(320, -240, 24));
    assert.equal(m.format, 'bmp');
    assert.equal(m.width, 320);
    assert.equal(m.height, 240);
    assert.equal(m.bitDepth, 24);
  });

  test('WebP VP8L: 14-bit dims', () => {
    const m = probe.probeImageMetadata(webpVp8lHeader(1000, 750));
    assert.equal(m.format, 'webp');
    assert.equal(m.width, 1000);
    assert.equal(m.height, 750);
    assert.match(m.webpKind, /VP8L/);
  });

  test('JPEG: scans SOF0 for dims', () => {
    const m = probe.probeImageMetadata(jpegHeader(1280, 960));
    assert.equal(m.format, 'jpeg');
    assert.equal(m.width, 1280);
    assert.equal(m.height, 960);
  });

  test('unknown/garbage → { format: "unknown" }, never throws', () => {
    assert.equal(probe.probeImageMetadata(Buffer.from([1, 2, 3, 4, 5])).format, 'unknown');
    assert.equal(probe.probeImageMetadata(Buffer.alloc(0)).format, 'unknown');
    assert.equal(probe.probeImageMetadata(null).format, 'unknown');
    assert.equal(probe.probeImageMetadata('not a buffer').format, 'unknown');
  });

  test('truncated PNG header → format known, dims absent, no throw', () => {
    const short = pngHeader(100, 100).subarray(0, 18); // cut before height
    const m = probe.probeImageMetadata(short);
    assert.equal(m.format, 'png'); // magic still recognized
    assert.equal(m.width, undefined);
  });
});

// ── 描述合成 ────────────────────────────────────────────────────────────

describe('describeImageMetadata — deterministic Chinese summary', () => {
  test('full description: format + size + aspect + color', () => {
    const meta = probe.probeImageMetadata(pngHeader(1920, 1080, 8, 6));
    const desc = probe.describeImageMetadata(meta, { sizeBytes: 480 * 1024, env: {} });
    assert.match(desc, /PNG/);
    assert.match(desc, /1920×1080/);
    assert.match(desc, /16:9/);
    assert.match(desc, /横向/);
    assert.match(desc, /480\.0 KB/);
    assert.match(desc, /百万像素/);
  });

  test('square image → 方形', () => {
    const meta = probe.probeImageMetadata(gifHeader(512, 512));
    const desc = probe.describeImageMetadata(meta, { sizeBytes: 1024, env: {} });
    assert.match(desc, /方形/);
    assert.match(desc, /1:1/);
  });

  test('portrait image → 纵向', () => {
    const meta = probe.probeImageMetadata(bmpHeader(600, 800));
    const desc = probe.describeImageMetadata(meta, { env: {} });
    assert.match(desc, /纵向/);
  });

  test('unknown dims → honest "尺寸未知"', () => {
    const desc = probe.describeImageMetadata({ format: 'png' }, { env: {} });
    assert.match(desc, /尺寸未知/);
  });

  test('odd ratio falls back to decimal ratio (no noisy gcd)', () => {
    const meta = probe.probeImageMetadata(jpegHeader(1000, 667));
    const desc = probe.describeImageMetadata(meta, { env: {} });
    assert.match(desc, /:1/); // decimal form like "1.50:1"
    assert.doesNotMatch(desc, /1000:667/);
  });

  test('gate off → describeImageMetadata returns null (byte-revert)', () => {
    const meta = probe.probeImageMetadata(pngHeader(10, 10));
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(probe.isEnabled({ KHY_LOCAL_IMAGE_VIEW: v }), false);
      assert.equal(probe.describeImageMetadata(meta, { env: { KHY_LOCAL_IMAGE_VIEW: v } }), null);
    }
    assert.equal(probe.isEnabled({}), true);
    assert.equal(probe.isEnabled({ KHY_LOCAL_IMAGE_VIEW: '1' }), true);
  });

  test('never throws on malformed meta', () => {
    assert.doesNotThrow(() => probe.describeImageMetadata(null, { env: {} }));
    assert.doesNotThrow(() => probe.describeImageMetadata(undefined, {}));
  });
});
