'use strict';

/**
 * ppmFrame — parse a binary P6 PPM (what QEMU's `screendump` writes) into a flat
 * RGBA pixel buffer a browser <canvas> ImageData can consume directly.
 *
 * QEMU's HMP `screendump <file>` (no `-f` format arg, universally available since
 * long before 6.x) always emits a binary P6 PPM: an ASCII header
 *
 *     P6\n<width> <height>\n<maxval>\n
 *
 * (whitespace between tokens may be spaces or newlines; a single '#' comment line
 * is legal anywhere in the header) followed by width*height*3 raw bytes of RGB,
 * one byte per channel when maxval < 256. The kernel desktop renders at 1024x768,
 * so a frame is ~2.36 MB of RGB — we transcode to RGBA (adding an opaque alpha)
 * so the frontend can `ctx.putImageData` with zero further work.
 *
 * This is a PURE LEAF: it takes a Buffer and returns { width, height, rgba } (or
 * throws a descriptive Error on a malformed header). No I/O, no QEMU, no env — so
 * it is trivially unit-testable and reused identically by any capture path.
 *
 * We intentionally support ONLY P6 with maxval < 256 (single-byte channels),
 * because that is exactly and only what QEMU screendump produces. A 16-bit
 * (maxval 256..65535, big-endian two-byte) or ASCII P3 variant is rejected with a
 * clear error rather than silently mis-decoded.
 */

/**
 * Scan the ASCII PPM header, tolerating the whitespace/comment rules above.
 * Returns { width, height, maxval, dataOffset } — dataOffset is the index of the
 * first pixel byte (one whitespace byte after maxval is consumed, per the spec).
 * Throws on anything that is not a well-formed P6 header.
 */
function parsePpmHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) {
    throw new Error('PPM: empty or non-buffer input');
  }
  if (buf[0] !== 0x50 /* 'P' */ || buf[1] !== 0x36 /* '6' */) {
    throw new Error('PPM: not a binary P6 image (bad magic)');
  }

  // Walk the header token by token starting after "P6". Whitespace-delimited,
  // '#' begins a comment to end-of-line. We need three integers: w, h, maxval.
  let i = 2;
  const nums = [];
  const isWs = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

  while (nums.length < 3) {
    // Skip whitespace and full comment lines.
    while (i < buf.length && isWs(buf[i])) i++;
    if (i < buf.length && buf[i] === 0x23 /* '#' */) {
      while (i < buf.length && buf[i] !== 0x0a) i++;
      continue;
    }
    if (i >= buf.length) throw new Error('PPM: truncated header');
    // Read one decimal integer.
    let n = 0;
    let sawDigit = false;
    while (i < buf.length && buf[i] >= 0x30 && buf[i] <= 0x39) {
      n = n * 10 + (buf[i] - 0x30);
      sawDigit = true;
      i++;
    }
    if (!sawDigit) throw new Error('PPM: malformed header (expected an integer)');
    nums.push(n);
  }

  const [width, height, maxval] = nums;
  if (width <= 0 || height <= 0) throw new Error('PPM: non-positive dimensions');
  if (maxval <= 0 || maxval > 255) {
    // 16-bit PPM (maxval > 255) uses two bytes/channel — not what screendump
    // emits, and this fast path does not decode it.
    throw new Error(`PPM: unsupported maxval ${maxval} (only 8-bit channels supported)`);
  }
  // Exactly ONE whitespace byte separates the header from the pixel data.
  if (i >= buf.length || !isWs(buf[i])) {
    throw new Error('PPM: missing whitespace before pixel data');
  }
  const dataOffset = i + 1;
  return { width, height, maxval, dataOffset };
}

/**
 * Decode a P6 PPM buffer to { width, height, rgba } where rgba is a Uint8Array of
 * length width*height*4 (opaque alpha). Throws on a malformed header or a pixel
 * region shorter than width*height*3.
 */
function ppmToRgba(buf) {
  const { width, height, dataOffset } = parsePpmHeader(buf);
  const pixels = width * height;
  const needed = pixels * 3;
  if (buf.length - dataOffset < needed) {
    throw new Error(
      `PPM: pixel data truncated (need ${needed} bytes, have ${buf.length - dataOffset})`
    );
  }
  const rgba = new Uint8Array(pixels * 4);
  let src = dataOffset;
  let dst = 0;
  for (let p = 0; p < pixels; p++) {
    rgba[dst++] = buf[src++]; // R
    rgba[dst++] = buf[src++]; // G
    rgba[dst++] = buf[src++]; // B
    rgba[dst++] = 255; // A (opaque)
  }
  return { width, height, rgba };
}

module.exports = { parsePpmHeader, ppmToRgba };
