'use strict';

/**
 * webFetchDecode — charset-aware decode + HTML→readable-text extraction for the
 * `webFetch` compat tool.
 *
 * Why this exists: the previous webFetch did `await response.text()`, which
 * decodes EVERY body as UTF-8 regardless of the server's declared charset.
 * Chinese news sites (xinhuanet/people/chinanews) still serve GB2312/GBK, so
 * the model received mojibake raw HTML — semantically useless — and produced an
 * empty turn ("✓ 网络搜索完成" with no answer). This module:
 *   1. detects the charset from the Content-Type header, then from an in-body
 *      <meta charset>/<meta http-equiv> sniff, defaulting to utf-8;
 *   2. decodes the raw bytes with TextDecoder (Node's full-ICU build supports
 *      gbk/gb2312/gb18030/big5), with a utf-8 fallback if the label is unknown;
 *   3. for HTML, strips scripts/styles/markup and returns collapsed readable
 *      text instead of tag soup.
 *
 * Pure and dependency-free (no cheerio/iconv-lite — those are not guaranteed to
 * be present in the backend node_modules). Operates on a Buffer so it is fully
 * unit-testable without a network.
 */

// Charset label aliases → a label TextDecoder understands.
function normalizeCharset(raw) {
  const c = String(raw || '').trim().toLowerCase().replace(/["']/g, '');
  if (!c) return 'utf-8';
  if (c === 'gb2312' || c === 'gb_2312-80' || c === 'gbk' || c === 'gb-2312' || c === 'csgb2312') return 'gbk';
  if (c === 'gb18030') return 'gb18030';
  if (c === 'big5' || c === 'big-5' || c === 'cn-big5' || c === 'csbig5') return 'big5';
  if (c === 'utf8' || c === 'utf-8' || c === 'unicode-1-1-utf-8') return 'utf-8';
  if (c === 'latin1' || c === 'iso-8859-1' || c === 'iso8859-1') return 'windows-1252';
  return c; // pass through (utf-16le, shift_jis, euc-jp, windows-125x, …)
}

function detectCharset(buffer, contentTypeHeader) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentTypeHeader || '');
  if (fromHeader) return normalizeCharset(fromHeader[1]);
  // Sniff the first 4 KB as latin1 (bytes 1:1) to read the <meta> declaration
  // without first committing to a decoding.
  const head = buffer.slice(0, 4096).toString('latin1');
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (metaCharset) return normalizeCharset(metaCharset[1]);
  const metaHttp = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head);
  if (metaHttp) return normalizeCharset(metaHttp[1]);
  return 'utf-8';
}

function decodeBuffer(buffer, charset) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

const ENTITY_MAP = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&mdash;': '—',
  '&ndash;': '–', '&hellip;': '…', '&middot;': '·', '&copy;': '©',
  '&raquo;': '»', '&laquo;': '«',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const cp = parseInt(h, 16);
      try {
        const r = require('./htmlEntityCodePointGuard').safeDecodeCodePoint(cp, _, process.env);
        if (r !== null) return r;
      } catch { /* fail-soft → legacy expression below */ }
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = parseInt(d, 10);
      try {
        const r = require('./htmlEntityCodePointGuard').safeDecodeCodePoint(cp, _, process.env);
        if (r !== null) return r;
      } catch { /* fail-soft → legacy expression below */ }
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&[a-z]+;/gi, (m) => (Object.prototype.hasOwnProperty.call(ENTITY_MAP, m) ? ENTITY_MAP[m] : m));
}

function looksLikeHtml(decoded, contentType) {
  if (/html/i.test(contentType || '')) return true;
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(decoded.slice(0, 2048));
}

function htmlToText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  // Map block-level boundaries to newlines so paragraphs stay separated.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|ul|ol|table)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v ]+/g, ' ');
  s = s.replace(/ *\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * decodeAndExtract — turn raw response bytes into readable text.
 * @param {Buffer} buffer raw body bytes (from response.arrayBuffer()).
 * @param {string} contentTypeHeader the Content-Type response header.
 * @param {number} maxChars hard cap on the returned content length.
 * @returns {{content, charset, isHtml, truncated, rawChars}}
 */
function decodeAndExtract(buffer, contentTypeHeader, maxChars) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const charset = detectCharset(buf, contentTypeHeader);
  const decoded = decodeBuffer(buf, charset);
  const isHtml = looksLikeHtml(decoded, contentTypeHeader);
  let text = isHtml ? htmlToText(decoded) : decoded;
  const rawChars = text.length;
  // Non-silent honesty: a successful fetch that yields no extractable prose
  // (e.g. a JS-rendered SPA shell) must say so rather than return "".
  if (!text && decoded.trim().length === 0) {
    text = '';
  } else if (!text) {
    text = '[webFetch] 已抓取页面，但未提取到可读正文（可能为脚本渲染页面，需启用浏览器渲染）。';
  }
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 20000;
  let truncated = false;
  if (text.length > cap) {
    text = `${text.slice(0, cap)}\n... [truncated ${text.length - cap} chars]`;
    truncated = true;
  }
  return { content: text, charset, isHtml, truncated, rawChars };
}

module.exports = {
  decodeAndExtract,
  normalizeCharset,
  detectCharset,
  decodeBuffer,
  htmlToText,
  decodeEntities,
  looksLikeHtml,
};
