'use strict';

/**
 * imageMetadataProbe.js — 纯叶子:仅凭图片文件头字节推断「格式 + 像素尺寸 + 色彩」,
 * 并据此产出一段确定性的中文「简单描述」,**完全不依赖任何模型、不联网、不调外部进程**。
 *
 * 背景(用户目标 2026-07「为了验证 OCR,给本地模式也做一个图片识别——即使没有任何模型,
 * 也能正确地简单『看图』并给出简单描述」):本仓既有 imageService.detectFormat 只认魔数
 * 返回格式名(png/jpeg/gif/webp),**没有任何像素尺寸信息**;而无模型的本地模式(/local)
 * 此前遇到图片只能读成 utf8 乱码(file_view)或走兜底菜单——用户「看不到」图。
 *
 * 本叶子补上缺失的「看图」原语:直接解析各格式的头部,拿到宽高/位深/色彩类型,
 * 组成一句人类可读的概览。这是无模型也成立的确定性事实(尺寸、比例、朝向、文件大小),
 * 与可选的本地 OCR 文本互补——OCR 读「图里的字」,本探针读「图本身的形」。
 *
 * 设计铁律:
 *  - 纯函数:入参是 Buffer(或已知 sizeBytes),零 IO、零网络、零子进程、确定性。
 *  - 绝不抛:任何越界/畸形头 → 返回已知的部分信息(或 {format:'unknown'}),而不是 throw。
 *  - 门控 KHY_LOCAL_IMAGE_VIEW 默认开;显式 0/false/off/no/空串 → 关(调用方据此字节回退)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no', '']);

/**
 * 门控:KHY_LOCAL_IMAGE_VIEW 默认开,仅显式 0/false/off/no/空串关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  if (e.KHY_LOCAL_IMAGE_VIEW == null) return true;
  return !_FALSY.has(String(e.KHY_LOCAL_IMAGE_VIEW).trim().toLowerCase());
}

// ── 各格式头部解析(全部越界安全,读不到即留空) ────────────────────────────

function _probePng(buf) {
  // 签名(8) + IHDR: 宽@16, 高@20, 位深@24, 色彩类型@25(BE)。
  if (buf.length < 26) return null;
  const out = { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (Number.isFinite(bitDepth)) out.bitDepth = bitDepth;
  // PNG 色彩类型:0 灰度 / 2 真彩(RGB) / 3 索引 / 4 灰度+α / 6 真彩+α(RGBA)
  const COLOR = { 0: '灰度', 2: 'RGB 真彩', 3: '索引调色板', 4: '灰度+透明', 6: 'RGBA 真彩+透明' };
  if (colorType in COLOR) out.colorLabel = COLOR[colorType];
  if (colorType === 4 || colorType === 6) out.hasAlpha = true;
  return out;
}

function _probeGif(buf) {
  // "GIFxxa" + 宽@6(LE u16) + 高@8(LE u16)。
  if (buf.length < 10) return null;
  const out = { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // 简易判定是否可能为动图:数一数图像描述符块(0x2C)是否 >1(有界扫描,绝不无界)。
  let frames = 0;
  const limit = Math.min(buf.length, 262144);
  for (let i = 13; i < limit; i++) {
    if (buf[i] === 0x2c) { frames++; if (frames > 1) break; }
  }
  if (frames > 1) out.animated = true;
  return out;
}

function _probeBmp(buf) {
  // "BM" + BITMAPINFOHEADER: 宽@18(LE i32), 高@22(LE i32), 位深@28(LE u16)。
  if (buf.length < 30) return null;
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const out = { format: 'bmp', width: Math.abs(width), height: Math.abs(height) };
  const bpp = buf.readUInt16LE(28);
  if (Number.isFinite(bpp) && bpp > 0) out.bitDepth = bpp;
  return out;
}

function _probeWebp(buf) {
  // RIFF(0-3) size(4-7) WEBP(8-11) fourCC(12-15) ...
  if (buf.length < 30) return null;
  const cc = buf.toString('ascii', 12, 16);
  try {
    if (cc === 'VP8 ') {
      // 有损:数据@20;起始码 9d 01 2a @23;宽@26、高@28 各取低 14 位(LE u16)。
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return { format: 'webp', width: w, height: h, webpKind: '有损(VP8)' };
    }
    if (cc === 'VP8L') {
      // 无损:数据@20,签名 0x2f @20;随后 4 字节(LE)含 14 位宽-1、14 位高-1。
      if (buf[20] !== 0x2f) return { format: 'webp' };
      const bits = buf.readUInt32LE(21);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >> 14) & 0x3fff) + 1;
      return { format: 'webp', width: w, height: h, webpKind: '无损(VP8L)' };
    }
    if (cc === 'VP8X') {
      // 扩展:标志@20;画布宽@24(3 字节 LE, 值+1)、高@27(3 字节 LE, 值+1)。
      const w = buf.readUIntLE(24, 3) + 1;
      const h = buf.readUIntLE(27, 3) + 1;
      const out = { format: 'webp', width: w, height: h, webpKind: '扩展(VP8X)' };
      if (buf[20] & 0x10) out.hasAlpha = true;
      if (buf[20] & 0x02) out.animated = true;
      return out;
    }
  } catch { /* 畸形 webp 头 → 只报格式 */ }
  return { format: 'webp' };
}

function _probeJpeg(buf) {
  // 从 offset 2 起扫描 marker,遇 SOFn 读精度/高/宽(BE)。有界迭代防畸形死循环。
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  const len = buf.length;
  let off = 2;
  let guard = 0;
  while (off + 9 < len && guard++ < 8192) {
    if (buf[off] !== 0xff) { off++; continue; }
    let marker = buf[off + 1];
    // 跳过填充 0xFF。
    while (marker === 0xff && off + 2 < len) { off++; marker = buf[off + 1]; }
    // 无载荷的独立 marker(SOI/EOI/RSTn/TEM)。
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    if (off + 4 > len) break;
    const segLen = buf.readUInt16BE(off + 2);
    if (SOF.has(marker)) {
      if (off + 8 >= len) break;
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      const out = { format: 'jpeg', width, height };
      const prec = buf[off + 4];
      if (Number.isFinite(prec)) out.bitDepth = prec;
      return out;
    }
    if (segLen < 2) break; // 畸形段长,停止。
    off += 2 + segLen;
  }
  return { format: 'jpeg' };
}

/**
 * 从图片头部字节推断元数据。绝不抛;无法识别 → { format:'unknown' }。
 * @param {Buffer} buf  图片文件的(至少)头部字节。
 * @returns {{format:string, width?:number, height?:number, bitDepth?:number,
 *            colorLabel?:string, hasAlpha?:boolean, animated?:boolean, webpKind?:string}}
 */
function probeImageMetadata(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return { format: 'unknown' };
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
    if (buf.length >= 12
      && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf.toString('ascii', 8, 12) === 'WEBP') {
      return _probeWebp(buf) || { format: 'webp' };
    }
    // TIFF: II*\0 或 MM\0*
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a)
      || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00)) {
      return { format: 'tiff' };
    }
    return { format: 'unknown' };
  } catch {
    return { format: 'unknown' };
  }
}

// ── 描述合成(确定性中文) ──────────────────────────────────────────────

const _FORMAT_LABEL = {
  png: 'PNG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', bmp: 'BMP', tiff: 'TIFF', unknown: '未知格式',
};

function _gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = b; b = a % b; a = t; }
  return a || 1;
}

/** 人类可读的文件大小。 */
function _humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 比例 + 朝向标签,如 "16:9(横向)" 或 "1.50(纵向)"。 */
function _aspectLabel(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  let orient = '方形';
  if (w > h) orient = '横向';
  else if (h > w) orient = '纵向';
  const g = _gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  // 约分后仍过大 → 用小数比,避免 "1000:667" 这类噪音。
  if (rw <= 40 && rh <= 40) return `${rw}:${rh}(${orient})`;
  return `${(w / h).toFixed(2)}:1(${orient})`;
}

/**
 * 据元数据 + 文件大小,产出一段确定性的中文「简单描述」(单行,不含 OCR)。
 * 门控关 → 返回 null(调用方据此字节回退)。绝不抛。
 * @param {object} meta  probeImageMetadata 的返回。
 * @param {object} [input]
 * @param {number} [input.sizeBytes]  文件字节数(用于「文件大小」措辞)。
 * @param {object} [input.env]
 * @returns {string|null}
 */
function describeImageMetadata(meta, input = {}) {
  try {
    if (!isEnabled(input.env)) return null;
    const m = meta || {};
    const parts = [];
    parts.push(`格式 ${_FORMAT_LABEL[m.format] || m.format || '未知格式'}`);

    if (Number.isFinite(m.width) && Number.isFinite(m.height) && m.width > 0 && m.height > 0) {
      parts.push(`尺寸 ${m.width}×${m.height} 像素`);
      const mp = (m.width * m.height) / 1e6;
      if (mp >= 0.1) parts.push(`约 ${mp.toFixed(1)} 百万像素`);
      const aspect = _aspectLabel(m.width, m.height);
      if (aspect) parts.push(`比例 ${aspect}`);
    } else {
      parts.push('尺寸未知(头部信息不足)');
    }

    const size = _humanSize(input.sizeBytes);
    if (size) parts.push(`文件大小 ${size}`);

    if (m.colorLabel) parts.push(`色彩 ${m.colorLabel}`);
    else if (Number.isFinite(m.bitDepth)) parts.push(`位深 ${m.bitDepth}`);
    if (m.webpKind) parts.push(m.webpKind);
    if (m.animated) parts.push('可能为动图/含多帧');
    else if (m.hasAlpha) parts.push('含透明通道');

    return parts.join(' · ');
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  probeImageMetadata,
  describeImageMetadata,
  // 供测试/复用的内部纯函数。
  _humanSize,
  _aspectLabel,
};
