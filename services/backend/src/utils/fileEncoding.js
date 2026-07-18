'use strict';

/**
 * fileEncoding.js — encoding-aware text file reader.
 *
 * 读取侧曾硬编码 `fs.readFileSync(path, 'utf-8')`：遇到 GBK / Shift-JIS / Big5
 * 等遗留编码的源码或文本文件，整篇变乱码（替换符 �），且不像子进程解码侧那样
 * 经 systemEncoding 探测。本模块把"先读字节 → 探测编码 → 按编码解码 → 剥 BOM"
 * 收敛为单一入口，供文件读取工具复用：
 *   - 显式 encoding（非 'auto'）→ 直接按其解码，尊重调用方意图；
 *   - 未指定 / 'auto' → getEncodingForBuffer 探测（合法 UTF-8 恒判为 utf-8，
 *     故正常 UTF-8 文件行为与旧实现完全一致，零回归）；
 *   - 非 Node 原生可解的编码（gbk/shift_jis/big5/...）经 iconv-lite 解码，
 *     iconv 不可用时 fail-soft 回落 utf8，绝不抛错中断读取。
 */

const fs = require('fs');
const { getEncodingForBuffer } = require('./systemEncoding');

// Node Buffer 可原生解码的编码（无需 iconv）。
const NATIVE_ENCODINGS = new Set([
  'utf-8', 'utf8',
  'utf16le', 'utf-16le', 'ucs2', 'ucs-2',
  'latin1', 'binary', 'ascii',
]);

function normalizeEncoding(enc) {
  return String(enc || '').trim().toLowerCase();
}

/**
 * Decode a Buffer to string using the given encoding name.
 * Native encodings go through Buffer.toString; others through iconv-lite with a
 * fail-soft utf8 fallback. The leading UTF-8/UTF-16 BOM (U+FEFF), if any, is stripped.
 * @param {Buffer} buf
 * @param {string} encoding
 * @returns {string}
 */
function decodeBuffer(buf, encoding) {
  const enc = normalizeEncoding(encoding) || 'utf-8';
  let text;
  if (NATIVE_ENCODINGS.has(enc)) {
    text = buf.toString(enc === 'utf-8' ? 'utf8' : enc.replace('utf-16le', 'utf16le'));
  } else {
    try {
      const iconv = require('iconv-lite');
      text = iconv.encodingExists(enc) ? iconv.decode(buf, enc) : buf.toString('utf8');
    } catch {
      // iconv-lite 缺失：回落 utf8，绝不让读取因解码库不可用而失败。
      text = buf.toString('utf8');
    }
  }
  // 剥前导 BOM（U+FEFF）——utf8 解码不会自动去除，会污染首行/JSON.parse。
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

/**
 * Read a file as text with encoding auto-detection.
 * @param {string} filePath
 * @param {object} [opts]
 * @param {string} [opts.encoding] - Explicit encoding; 'auto'/unset triggers detection.
 * @param {number} [opts.maxBytes] - Bound the read to the first N bytes via a partial
 *   fd read. When the file exceeds maxBytes, only the first maxBytes bytes are
 *   read+decoded and `truncated:true` is returned. Omitting maxBytes preserves the
 *   historical full-file behavior byte-for-byte (truncated:false, totalBytes:undefined).
 * @returns {{ text: string, encoding: string, truncated: boolean, totalBytes: (number|undefined) }}
 */
function readTextFileSmart(filePath, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : 0;
  let buf;
  let truncated = false;
  let totalBytes;
  if (maxBytes) {
    const st = fs.statSync(filePath);
    totalBytes = st.size;
    if (st.size > maxBytes) {
      // Partial read: only the first maxBytes bytes — bounds memory for huge files.
      const fd = fs.openSync(filePath, 'r');
      try {
        const tmp = Buffer.alloc(maxBytes);
        const n = fs.readSync(fd, tmp, 0, maxBytes, 0);
        buf = tmp.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
      truncated = true;
    } else {
      buf = fs.readFileSync(filePath);
    }
  } else {
    buf = fs.readFileSync(filePath);
  }
  let enc = normalizeEncoding(opts.encoding);
  // FE FF 是 UTF-16BE BOM——getEncodingForBuffer 不识别它，这里先兜住。
  if (!enc || enc === 'auto') {
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) enc = 'utf-16be';
    else enc = normalizeEncoding(getEncodingForBuffer(buf));
  }
  return { text: decodeBuffer(buf, enc), encoding: enc, truncated, totalBytes };
}

module.exports = {
  NATIVE_ENCODINGS,
  decodeBuffer,
  readTextFileSmart,
};
