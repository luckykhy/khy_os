'use strict';

/**
 * imageMetadataProbe.js — pure leaf: infer "format + pixel size + color mode"
 * from image header bytes alone, and synthesize a deterministic Chinese
 * "simple description". No model, no network, no subprocess.
 *
 * Background: the repo's imageService.detectFormat only returned a magic-number
 * format (png/jpeg/gif/webp) with no pixel-size information; the model-less
 * local mode (/local) could only read an image as utf8 garbage (file_view) or
 * fall back to the generic menu. This leaf fills the gap: it parses each
 * format's header for width/height/bit-depth/color-type and composes a
 * human-readable overview. That overview is deterministic even without any
 * model (size, aspect, orientation, file size), and complements optional
 * local OCR text — OCR reads "the text inside the image", this probe reads
 * "the shape of the image itself".
 *
 * Design rules:
 *   - Pure function: input is a Buffer (header bytes) plus optional sizeBytes;
 *     zero IO, zero network, zero subprocess, deterministic.
 *   - Never throws on any out-of-bounds/malformed input: return the partial
 *     info that is known, or { format:'unknown' } — never throw.
 *   - Gated by KHY_LOCAL_IMAGE_VIEW, default-on; explicit 0/false/off/no/empty
 *     disables it (callers byte-fall back when disabled).
 */

const _FALSY = new Set(['0', 'false', 'off', 'no', '']);

/**
 * Gate: KHY_LOCAL_IMAGE_VIEW defaults on; only an explicit 0/false/off/no/
 * empty string turns it off.
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  if (e.KHY_LOCAL_IMAGE_VIEW == null) {
    return true;
  }
  return !_FALSY.has(String(e.KHY_LOCAL_IMAGE_VIEW).trim().toLowerCase());
}

// ── Per-format header probes (all bounds-safe: if the header is short,
// the field is left unset rather than throwing) ─────────────────────────

function _probePng(buf) {
  // signature(8) + IHDR: width@16, height@20, bitDepth@24, colorType@25 (BE)
  if (buf.length < 26) {
    return null;
  }
  const out = { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (Number.isFinite(bitDepth)) {
    out.bitDepth = bitDepth;
  }
  // PNG color types: 0 grayscale / 2 RGB / 3 palette / 4 grayscale+alpha / 6 RGBA
  const COLOR = {
    0: '灰度',
    2: 'RGB 真彩',
    3: '索引调色板',
    4: '灰度+透明',
    6: 'RGBA 真彩+透明',
  };
  if (colorType in COLOR) {
    out.colorLabel = COLOR[colorType];
  }
  if (colorType === 4 || colorType === 6) {
    out.hasAlpha = true;
  }
  return out;
}

function _probeGif(buf) {
  // "GIFxxa" + width@6 (LE u16) + height@8 (LE u16)
  if (buf.length < 10) {
    return null;
  }
  const out = { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // Heuristic for animation: count image-separator descriptors (0x2C);
  // >1 means likely animated. Bounded scan — never unbounded.
  let frames = 0;
  const limit = Math.min(buf.length, 262144);
  for (let i = 13; i < limit; i++) {
    if (buf[i] === 0x2c) {
      frames++;
      if (frames > 1) {
        break;
      }
    }
  }
  if (frames > 1) {
    out.animated = true;
  }
  return out;
}

function _probeBmp(buf) {
  // "BM" + BITMAPINFOHEADER: width@18 (LE i32), height@22 (LE i32), bpp@28 (LE u16)
  if (buf.length < 30) {
    return null;
  }
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const out = { format: 'bmp', width: Math.abs(width), height: Math.abs(height) };
  const bpp = buf.readUInt16LE(28);
  if (Number.isFinite(bpp) && bpp > 0) {
    out.bitDepth = bpp;
  }
  return out;
}

function _probeWebp(buf) {
  // RIFF(0-3) size(4-7) WEBP(8-11) fourCC(12-15) ...
  if (buf.length < 30) {
    return null;
  }
  const cc = buf.toString('ascii', 12, 16);
  try {
    if (cc === 'VP8 ') {
      // lossy: data@20; start signature 9d 01 2a @23; width@26, height@28
      // each take the lower 14 bits (LE u16)
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return { format: 'webp', width: w, height: h, webpKind: '有损(VP8)' };
    }
    if (cc === 'VP8L') {
      // lossless: data@20, signature 0x2f @20; then 4 LE bytes:
      // 14 bits width-1, 14 bits height-1
      if (buf[20] !== 0x2f) {
        return { format: 'webp' };
      }
      const bits = buf.readUInt32LE(21);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >> 14) & 0x3fff) + 1;
      return { format: 'webp', width: w, height: h, webpKind: '无损(VP8L)' };
    }
    if (cc === 'VP8X') {
      // extended: flags@20; canvas width@24 (3 LE bytes, +1),
      // canvas height@27 (3 LE bytes, +1)
      const w = buf.readUIntLE(24, 3) + 1;
      const h = buf.readUIntLE(27, 3) + 1;
      const out = { format: 'webp', width: w, height: h, webpKind: '扩展(VP8X)' };
      if (buf[20] & 0x10) {
        out.hasAlpha = true;
      }
      if (buf[20] & 0x02) {
        out.animated = true;
      }
      return out;
    }
  } catch {
    /* malformed webp — report the format only */
  }
  return { format: 'webp' };
}

function _probeJpeg(buf) {
  // Scan markers from offset 2; read precise width/height at SOFn (BE).
  // Bounded iteration guards against a malformed infinite loop.
  const SOF = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  const len = buf.length;
  let off = 2;
  let guard = 0;
  while (off + 9 < len && guard++ < 8192) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    let marker = buf[off + 1];
    // skip 0xFF fill bytes
    while (marker === 0xff && off + 2 < len) {
      off++;
      marker = buf[off + 1];
    }
    // standalone markers carry no payload (SOI/EOI/RSTn/TEM)
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      off += 2;
      continue;
    }
    if (off + 4 > len) {
      break;
    }
    const segLen = buf.readUInt16BE(off + 2);
    if (SOF.has(marker)) {
      if (off + 8 >= len) {
        break;
      }
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      const out = { format: 'jpeg', width, height };
      const prec = buf[off + 4];
      if (Number.isFinite(prec)) {
        out.bitDepth = prec;
      }
      return out;
    }
    if (segLen < 2) {
      break;
    }
    // malformed segment length — stop
    off += 2 + segLen;
  }
  return { format: 'jpeg' };
}

/**
 * Infer metadata from image header bytes. Never throws; unrecognized
 * input yields { format:'unknown' }.
 * @param {Buffer} buf header bytes of the image file (at least the header)
 * @returns {{format:string, width?:number, height?:number, bitDepth?:number,
 *            colorLabel?:string, hasAlpha?:boolean, animated?:boolean, webpKind?:string}}
 */
function probeImageMetadata(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 4) {
      return { format: 'unknown' };
    }
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return _probePng(buf) || { format: 'png' };
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return _probeJpeg(buf) || { format: 'jpeg' };
    }
    // GIF: 47 49 46
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return _probeGif(buf) || { format: 'gif' };
    }
    // BMP: 42 4D
    if (buf[0] === 0x42 && buf[1] === 0x4d) {
      return _probeBmp(buf) || { format: 'bmp' };
    }
    // WebP: "RIFF"...."WEBP"
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return _probeWebp(buf) || { format: 'webp' };
    }
    // TIFF: II*\0 or MM\0*
    if (
      (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00)
    ) {
      return { format: 'tiff' };
    }
    return { format: 'unknown' };
  } catch {
    return { format: 'unknown' };
  }
}

// ── Description synthesis (deterministic Chinese) ─────────────────────

const _FORMAT_LABEL = {
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  bmp: 'BMP',
  tiff: 'TIFF',
  unknown: '未知格式',
};

function _gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

/** Human-readable file size. */
function _humanSize(bytes) {
  // Keep the null-return semantics; the formatting itself is delegated to
  // the shared utility.
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return require('../utils/humanBytes').humanBytes(bytes);
}

/**
 * Aspect + orientation label, e.g. "16:9(横向)" or "1.50(纵向)".
 */
function _aspectLabel(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  let orient = '方形';
  if (w > h) {
    orient = '横向';
  } else if (h > w) {
    orient = '纵向';
  }
  const g = _gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  // If the reduced ratio is still large, use a decimal ratio to avoid
  // noise like "1000:667".
  if (rw <= 40 && rh <= 40) {
    return `${rw}:${rh}(${orient})`;
  }
  return `${(w / h).toFixed(2)}:1(${orient})`;
}

/**
 * From metadata + file size, produce a deterministic Chinese "simple
 * description" (single line, no OCR). When the gate is off, return null
 * (callers byte-fall back). Never throws.
 * @param {object} meta result of probeImageMetadata
 * @param {object} [input]
 * @param {number} [input.sizeBytes] file byte size, used for the "文件大小" wording
 * @param {object} [input.env]
 * @returns {string|null}
 */
function describeImageMetadata(meta, input = {}) {
  try {
    if (!isEnabled(input.env)) {
      return null;
    }
    const m = meta || {};
    const parts = [];
    parts.push(`格式 ${_FORMAT_LABEL[m.format] || m.format || '未知格式'}`);

    if (Number.isFinite(m.width) && Number.isFinite(m.height) && m.width > 0 && m.height > 0) {
      parts.push(`尺寸 ${m.width}×${m.height} 像素`);
      const mp = (m.width * m.height) / 1e6;
      if (mp >= 0.1) {
        parts.push(`约 ${mp.toFixed(1)} 百万像素`);
      }
      const aspect = _aspectLabel(m.width, m.height);
      if (aspect) {
        parts.push(`比例 ${aspect}`);
      }
    } else {
      parts.push('尺寸未知(头部信息不足)');
    }

    const size = _humanSize(input.sizeBytes);
    if (size) {
      parts.push(`文件大小 ${size}`);
    }

    if (m.colorLabel) {
      parts.push(`色彩 ${m.colorLabel}`);
    } else if (Number.isFinite(m.bitDepth)) {
      parts.push(`位深 ${m.bitDepth}`);
    }
    if (m.webpKind) {
      parts.push(m.webpKind);
    }
    if (m.animated) {
      parts.push('可能为动图(含多帧)');
    } else if (m.hasAlpha) {
      parts.push('含透明通道');
    }

    return parts.join(' · ');
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  probeImageMetadata,
  describeImageMetadata,
  // Internal pure functions exposed for test reuse
  _humanSize,
  _aspectLabel,
};
