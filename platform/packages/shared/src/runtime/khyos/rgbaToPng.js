'use strict';

/**
 * rgbaToPng — encode a raw RGBA pixel buffer as a PNG (truecolour + alpha, 8-bit).
 *
 * Why this exists: QEMU 6.x's HMP `screendump` only writes P6 PPM (~2.36 MB for
 * the kernel's 1024x768 desktop). Streaming that raw over a WebSocket at a few fps
 * is wasteful, and the desktop is mostly flat UI colours that DEFLATE crushes to a
 * few tens of KB. Node ships zlib, so a compact, dependency-free PNG encoder is
 * the natural transport: parse PPM (ppmFrame) → RGBA → PNG here → base64 → browser
 * <img>/canvas.
 *
 * This is a PURE LEAF: (rgba, width, height) → Buffer(PNG). No I/O, no env. It
 * emits a minimal but fully spec-conformant PNG — 8-bit, colour type 6 (RGBA),
 * one IDAT, per-scanline filter 0 (None). Filter 0 keeps the encoder simple and
 * correct; DEFLATE still compresses the flat desktop well. CRC-32 is computed per
 * chunk exactly per the PNG spec so the output loads in any decoder.
 */

const zlib = require('zlib');

// PNG's CRC-32 (same polynomial as zlib's), table built once.
const _CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function _crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Build one PNG chunk: length(4) + type(4) + data + crc(4). */
function _chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(_crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * @param {Uint8Array|Buffer} rgba - width*height*4 bytes, R,G,B,A per pixel
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} a complete PNG file
 */
function rgbaToPng(rgba, width, height) {
  if (!width || !height || width < 0 || height < 0) {
    throw new Error(`rgbaToPng: bad dimensions ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (rgba.length < expected) {
    throw new Error(`rgbaToPng: short pixel buffer (need ${expected}, have ${rgba.length})`);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // compression: DEFLATE
  ihdr[11] = 0; // filter method: adaptive (only method 0 exists)
  ihdr[12] = 0; // interlace: none

  // Prefix every scanline with filter byte 0 (None), then DEFLATE the lot.
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  let dst = 0;
  let src = 0;
  for (let y = 0; y < height; y++) {
    raw[dst++] = 0; // filter: None
    // Copy one scanline. rgba may be a Uint8Array — Buffer.from(view) shares no
    // memory but a manual copy avoids allocating a subarray Buffer per row.
    for (let x = 0; x < stride; x++) raw[dst++] = rgba[src++];
  }
  const idatData = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    signature,
    _chunk('IHDR', ihdr),
    _chunk('IDAT', idatData),
    _chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { rgbaToPng, _crc32 };
