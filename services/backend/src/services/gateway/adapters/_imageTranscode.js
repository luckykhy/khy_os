'use strict';

/**
 * _imageTranscode.js — model-safe image transcoding fallback (ffmpeg-based).
 *
 * Vision APIs commonly reject HEIC/HEIF/TIFF/BMP/SVG and oversized images.
 * This converts such images to JPEG (downsizing oversized ones) using the
 * ffmpeg already required for video analysis — zero new npm dependency.
 *
 * Contract (best-effort, never throws):
 *   - Operates on the normalized image shape from _imageCompat:
 *       { base64, mimeType, dataUrl, url? }
 *   - When ffmpeg is absent, or a conversion fails, the ORIGINAL image is
 *     returned unchanged (transparent degradation — current behavior preserved).
 *   - url-only images (no base64 bytes) are left untouched (nothing to transcode).
 *   - Non-pixel fields the caller attached (e.g. _filePath) are preserved.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const _execFileAsync = promisify(execFile);

// Common, first-class photo formats that the major vision APIs (Anthropic /
// OpenAI) nonetheless do NOT accept as raw bytes — BMP and TIFF among them.
// These are legitimate photos; we transcode them to JPEG purely so the model
// endpoint will accept them, NOT because the format is exotic. Natively
// accepted formats (png / jpeg / webp / gif) are never touched here.
const _TRANSCODE_TO_JPEG_MIMES = new Set([
  'image/heic', 'image/heif',
  'image/tiff', 'image/x-tiff',
  'image/bmp', 'image/x-ms-bmp', // BMP is a common photo format, just not API-accepted raw
  'image/svg+xml',
]);

// Re-encode (and downscale) any base64 image whose decoded size exceeds this,
// even for otherwise-accepted formats (png/jpeg/webp).
const _MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const _MAX_DIM = 2048;              // longest side after downscale (px)
const _FFMPEG_TIMEOUT_MS = 20_000;

const _EXT_BY_MIME = {
  'image/heic': '.heic', 'image/heif': '.heif',
  'image/tiff': '.tiff', 'image/x-tiff': '.tiff',
  'image/bmp': '.bmp', 'image/x-ms-bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/webp': '.webp', 'image/gif': '.gif',
};

let _ffmpeg; // cache: string path | null | undefined(uncached)

function _resolveFfmpeg() {
  if (_ffmpeg !== undefined) return _ffmpeg;
  try {
    const { searchExecutable } = require('../../../tools/platformUtils');
    _ffmpeg = searchExecutable('ffmpeg') || null;
  } catch {
    _ffmpeg = null;
  }
  return _ffmpeg;
}

// Test seam: reset the ffmpeg-detection cache between cases.
function _resetFfmpegCache() { _ffmpeg = undefined; }

function _approxBytes(base64 = '') {
  // base64 decodes to ~3/4 of its character length.
  return Math.floor((String(base64).length * 3) / 4);
}

function _needsTranscode(img) {
  if (!img || !img.base64) return false; // url-only or empty → nothing to do
  const mime = String(img.mimeType || '').toLowerCase();
  if (_TRANSCODE_TO_JPEG_MIMES.has(mime)) return true;
  return _approxBytes(img.base64) > _MAX_BYTES;
}

async function _transcodeOne(img, ffmpegPath) {
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-img-xcode-'));
    const inExt = _EXT_BY_MIME[String(img.mimeType || '').toLowerCase()] || '.img';
    const inPath = path.join(dir, `in${inExt}`);
    const outPath = path.join(dir, 'out.jpg');
    fs.writeFileSync(inPath, Buffer.from(img.base64, 'base64'));

    // Downscale-only (never upscale) to fit within _MAX_DIM × _MAX_DIM while
    // preserving aspect ratio, take a single frame, re-encode as JPEG.
    const vf = `scale='min(${_MAX_DIM},iw)':'min(${_MAX_DIM},ih)':force_original_aspect_ratio=decrease`;
    await _execFileAsync(ffmpegPath, [
      '-y', '-loglevel', 'error',
      '-i', inPath,
      '-frames:v', '1',
      '-vf', vf,
      '-f', 'image2', outPath,
    ], { timeout: _FFMPEG_TIMEOUT_MS });

    const buf = fs.readFileSync(outPath);
    if (!buf || buf.length === 0) return null;
    const base64 = buf.toString('base64');
    return {
      base64,
      mimeType: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${base64}`,
    };
  } catch {
    return null; // fail-safe: caller keeps the original image
  } finally {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * Transcode model-unfriendly / oversized images to JPEG when ffmpeg is present.
 * @param {Array<object>} images - normalized images ({ base64, mimeType, ... })
 * @returns {Promise<Array<object>>} same array shape; converted entries replaced,
 *          everything else (and the whole array on no-op) returned unchanged.
 */
async function transcodeImagesIfNeeded(images) {
  if (!Array.isArray(images) || images.length === 0) return images;
  if (!images.some(_needsTranscode)) return images; // fast path

  const ffmpegPath = _resolveFfmpeg();
  if (!ffmpegPath) return images; // no ffmpeg → transparent degradation

  const out = [];
  for (const img of images) {
    if (!_needsTranscode(img)) { out.push(img); continue; }
    const conv = await _transcodeOne(img, ffmpegPath); // eslint-disable-line no-await-in-loop
    out.push(conv ? { ...img, ...conv } : img);
  }
  return out;
}

module.exports = {
  transcodeImagesIfNeeded,
  // test seams
  _needsTranscode,
  _resolveFfmpeg,
  _resetFfmpegCache,
  _transcodeOne,
  _TRANSCODE_TO_JPEG_MIMES,
  _MAX_BYTES,
  _MAX_DIM,
};
