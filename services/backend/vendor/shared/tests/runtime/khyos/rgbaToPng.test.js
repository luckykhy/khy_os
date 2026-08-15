'use strict';

/**
 * rgbaToPng.test.js — the dependency-free PNG encoder for desktop frames.
 *
 * Guards: valid PNG signature + IHDR fields, CRC-32 correctness (a known vector),
 * dimension/short-buffer validation, and a full round-trip — encode a known RGBA
 * bitmap, then DEFLATE-inflate the IDAT and confirm the filtered scanlines
 * reproduce the exact input pixels. That last check is what proves the bytes a
 * browser decoder sees are the pixels we put in.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { rgbaToPng, _crc32 } = require('../../../src/runtime/khyos/rgbaToPng');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk PNG chunks: returns [{ type, data }...]. */
function readChunks(png) {
  const chunks = [];
  let i = 8; // past signature
  while (i < png.length) {
    const len = png.readUInt32BE(i);
    const type = png.toString('ascii', i + 4, i + 8);
    const data = png.subarray(i + 8, i + 8 + len);
    chunks.push({ type, data });
    i += 12 + len; // len(4)+type(4)+data+crc(4)
  }
  return chunks;
}

describe('rgbaToPng', () => {
  test('CRC-32 matches the standard "123456789" test vector', () => {
    // The canonical CRC-32 check value for the ASCII string "123456789".
    assert.equal(_crc32(Buffer.from('123456789', 'ascii')) >>> 0, 0xcbf43926);
  });

  test('emits a valid signature and IHDR for the given dimensions', () => {
    const rgba = new Uint8Array(2 * 2 * 4).fill(0);
    const png = rgbaToPng(rgba, 2, 2);
    assert.ok(png.subarray(0, 8).equals(PNG_SIG), 'signature');
    const chunks = readChunks(png);
    assert.equal(chunks[0].type, 'IHDR');
    assert.equal(chunks[0].data.readUInt32BE(0), 2); // width
    assert.equal(chunks[0].data.readUInt32BE(4), 2); // height
    assert.equal(chunks[0].data[8], 8); // bit depth
    assert.equal(chunks[0].data[9], 6); // colour type RGBA
    assert.equal(chunks[chunks.length - 1].type, 'IEND');
  });

  test('round-trips: inflated IDAT scanlines reproduce input pixels', () => {
    // 2x2 image, distinct pixels.
    const px = [
      10, 20, 30, 255, 40, 50, 60, 255, // row 0
      70, 80, 90, 255, 100, 110, 120, 255, // row 1
    ];
    const rgba = Uint8Array.from(px);
    const png = rgbaToPng(rgba, 2, 2);
    const idat = readChunks(png).find((c) => c.type === 'IDAT');
    const raw = zlib.inflateSync(idat.data);
    // Each row = 1 filter byte (0) + width*4 pixel bytes.
    const stride = 2 * 4;
    assert.equal(raw.length, (stride + 1) * 2);
    assert.equal(raw[0], 0, 'row 0 filter byte');
    assert.deepEqual(Array.from(raw.subarray(1, 1 + stride)), px.slice(0, stride));
    assert.equal(raw[1 + stride], 0, 'row 1 filter byte');
    assert.deepEqual(Array.from(raw.subarray(2 + stride, 2 + 2 * stride)), px.slice(stride));
  });

  test('every chunk CRC verifies', () => {
    const png = rgbaToPng(new Uint8Array(1 * 1 * 4).fill(255), 1, 1);
    let i = 8;
    while (i < png.length) {
      const len = png.readUInt32BE(i);
      const typeAndData = png.subarray(i + 4, i + 8 + len);
      const storedCrc = png.readUInt32BE(i + 8 + len);
      assert.equal(_crc32(typeAndData), storedCrc);
      i += 12 + len;
    }
  });

  test('rejects bad dimensions and short buffers', () => {
    assert.throws(() => rgbaToPng(new Uint8Array(4), 0, 1), /dimension/);
    assert.throws(() => rgbaToPng(new Uint8Array(4), 2, 2), /short/); // needs 16 bytes
  });
});
