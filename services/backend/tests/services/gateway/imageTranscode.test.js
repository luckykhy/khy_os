'use strict';

/**
 * imageTranscode.test.js — model-safe image transcoding fallback.
 *
 * Pins the contract: model-unfriendly (HEIC/TIFF/BMP/SVG) and oversized images
 * are re-encoded to JPEG via ffmpeg; when ffmpeg is absent or conversion fails,
 * the original image is returned UNCHANGED (transparent degradation).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mod = require('../../../src/services/gateway/adapters/_imageTranscode');
const {
  transcodeImagesIfNeeded,
  _needsTranscode,
  _resetFfmpegCache,
  _MAX_BYTES,
} = mod;

function img(base64, mimeType) {
  return { base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}` };
}
const SMALL_PNG = img(Buffer.from('tiny-png').toString('base64'), 'image/png');
const HEIC = img(Buffer.from('heic-bytes').toString('base64'), 'image/heic');
const TIFF = img(Buffer.from('tiff-bytes').toString('base64'), 'image/tiff');

test('_needsTranscode: problematic formats yes, normal small no, url-only no', () => {
  assert.strictEqual(_needsTranscode(HEIC), true);
  assert.strictEqual(_needsTranscode(TIFF), true);
  assert.strictEqual(_needsTranscode(img(Buffer.from('x').toString('base64'), 'image/bmp')), true);
  assert.strictEqual(_needsTranscode(SMALL_PNG), false);
  assert.strictEqual(_needsTranscode({ url: 'https://x/y.png' }), false); // no bytes
  assert.strictEqual(_needsTranscode(null), false);
});

test('_needsTranscode: oversized accepted format → yes', () => {
  const bigB64 = 'A'.repeat(Math.ceil((_MAX_BYTES + 1024) * 4 / 3));
  assert.strictEqual(_needsTranscode(img(bigB64, 'image/png')), true);
});

test('transcode: no-op fast path returns the SAME array (nothing needs work)', async () => {
  const input = [SMALL_PNG, { url: 'https://x/y.png' }];
  const out = await transcodeImagesIfNeeded(input);
  assert.strictEqual(out, input); // identity — untouched
});

test('transcode: ffmpeg absent → images returned unchanged (degradation)', async () => {
  // Force "no ffmpeg" by pointing PATH at an empty dir and resetting the cache.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-noffmpeg-'));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = emptyDir;
    _resetFfmpegCache();
    const out = await transcodeImagesIfNeeded([HEIC]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].mimeType, 'image/heic'); // unchanged
    assert.strictEqual(out[0].base64, HEIC.base64);
  } finally {
    process.env.PATH = savedPath;
    _resetFfmpegCache();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('transcode: real end-to-end via a fake ffmpeg on PATH → HEIC becomes JPEG', async () => {
  // Install a stub `ffmpeg` that writes deterministic bytes to its output path
  // (the last argv). This genuinely drives execFile + temp-file read-back.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fakebin-'));
  const ffmpegPath = path.join(binDir, 'ffmpeg');
  fs.writeFileSync(
    ffmpegPath,
    '#!/bin/sh\nfor a in "$@"; do out="$a"; done\nprintf "FAKEJPEGDATA" > "$out"\n',
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
    _resetFfmpegCache();

    const out = await transcodeImagesIfNeeded([HEIC, SMALL_PNG]);
    assert.strictEqual(out.length, 2);

    // HEIC entry transcoded to jpeg with the fake output bytes.
    assert.strictEqual(out[0].mimeType, 'image/jpeg');
    assert.strictEqual(Buffer.from(out[0].base64, 'base64').toString(), 'FAKEJPEGDATA');
    assert.match(out[0].dataUrl, /^data:image\/jpeg;base64,/);

    // Small png left untouched (didn't need transcode).
    assert.strictEqual(out[1], SMALL_PNG);
  } finally {
    process.env.PATH = savedPath;
    _resetFfmpegCache();
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('transcode: fake ffmpeg that produces empty output → keep original (fail-safe)', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fakebin2-'));
  const ffmpegPath = path.join(binDir, 'ffmpeg');
  // Writes nothing to the output → _transcodeOne sees empty buffer → null → keep.
  fs.writeFileSync(ffmpegPath, '#!/bin/sh\nfor a in "$@"; do out="$a"; done\n: > "$out"\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
    _resetFfmpegCache();
    const out = await transcodeImagesIfNeeded([TIFF]);
    assert.strictEqual(out[0], TIFF); // original preserved
  } finally {
    process.env.PATH = savedPath;
    _resetFfmpegCache();
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
