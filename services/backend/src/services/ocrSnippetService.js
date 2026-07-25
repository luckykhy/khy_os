'use strict';

/**
 * ocrSnippetService.js
 *
 * OCR helpers for multimodal fallback:
 * - Image OCR via docHelper.py (pytesseract)
 * - Scanned-PDF OCR via pdftoppm + image OCR
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const { searchExecutable } = require('../tools/platformUtils');

const DOC_HELPER = path.join(__dirname, 'docHelper.py');
const IMAGE_OCR_MAX_BYTES = Math.max(
  512 * 1024,
  parseInt(String(process.env.KHY_MULTIMODAL_IMAGE_OCR_MAX_BYTES || String(20 * 1024 * 1024)), 10) || (20 * 1024 * 1024)
);
const IMAGE_OCR_MAX_CHARS = Math.max(
  200,
  parseInt(String(process.env.KHY_MULTIMODAL_IMAGE_OCR_MAX_CHARS || '1200'), 10) || 1200
);
const IMAGE_OCR_TIMEOUT_MS = Math.max(
  800,
  parseInt(String(process.env.KHY_MULTIMODAL_IMAGE_OCR_TIMEOUT_MS || '4000'), 10) || 4000
);
const PDF_OCR_MAX_PAGES = Math.max(
  1,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_OCR_MAX_PAGES || '2'), 10) || 2
);
const PDF_OCR_TOTAL_BUDGET_MS = Math.max(
  1200,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_OCR_TOTAL_BUDGET_MS || '7000'), 10) || 7000
);
const OCR_LANG = String(process.env.KHY_MULTIMODAL_OCR_LANG || 'chi_sim+eng').trim() || 'chi_sim+eng';
const OCR_CACHE_ENABLED = !['0', 'false', 'off'].includes(
  String(process.env.KHY_MULTIMODAL_OCR_CACHE_ENABLED || 'true').trim().toLowerCase()
);
const OCR_CACHE_TTL_MS = Math.max(
  1000,
  parseInt(String(process.env.KHY_MULTIMODAL_OCR_CACHE_TTL_MS || String(10 * 60 * 1000)), 10) || (10 * 60 * 1000)
);
const OCR_CACHE_MAX_ENTRIES = Math.max(
  16,
  parseInt(String(process.env.KHY_MULTIMODAL_OCR_CACHE_MAX_ENTRIES || '256'), 10) || 256
);
const OCR_CACHE_HASH_MAX_BYTES = Math.max(
  128 * 1024,
  parseInt(String(process.env.KHY_MULTIMODAL_OCR_CACHE_HASH_MAX_BYTES || String(64 * 1024 * 1024)), 10) || (64 * 1024 * 1024)
);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp', '.gif']);
const _ocrCache = new Map();

// 收敛到 utils/safeStatSync 单一真源(逐字节委托,调用点不变)
const _safeStat = require('../utils/safeStatSync');

function _normalize(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function _truncate(text = '', maxChars = IMAGE_OCR_MAX_CHARS) {
  const normalized = _normalize(text);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n...[truncated]`;
}

// 与 _truncate 产出**逐字节等价**的 text,但额外报告是否发生了截断。用于图像 OCR 输出对象:
// 上游 tesseract 提取的**全文**可能超过 maxChars 被截掉尾部(仅留 `...[truncated]` 内嵌英文
// 标记),这个「被截断」事实此前从不作为结构化字段离开本服务 → gateway 把残缺文本当「请据此
// 作答」的完整依据注入,纯文本模型据此作答却不知内容不完整。本函数把该事实显式化(truncated),
// 供上层追加诚实告诫。text 分支与 _truncate 完全一致,保证既有 text 值逐字节不变。
function _truncateInfo(text = '', maxChars = IMAGE_OCR_MAX_CHARS) {
  const normalized = _normalize(text);
  if (!normalized) return { text: '', truncated: false };
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, maxChars)}\n...[truncated]`, truncated: true };
}

function _cloneValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function _isCacheEnabled(options = {}) {
  if (options.cache !== undefined) return !!options.cache;
  return OCR_CACHE_ENABLED;
}

function _pruneCache(now = Date.now()) {
  for (const [key, item] of _ocrCache.entries()) {
    if (!item || (now - Number(item.at || 0)) > OCR_CACHE_TTL_MS) {
      _ocrCache.delete(key);
    }
  }
  if (_ocrCache.size <= OCR_CACHE_MAX_ENTRIES) return;
  const sorted = [..._ocrCache.entries()]
    .sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0));
  const overflow = _ocrCache.size - OCR_CACHE_MAX_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    _ocrCache.delete(sorted[i][0]);
  }
}

function _readCache(key = '', options = {}) {
  if (!_isCacheEnabled(options)) return null;
  const cacheKey = String(key || '').trim();
  if (!cacheKey) return null;
  const now = Date.now();
  _pruneCache(now);
  const hit = _ocrCache.get(cacheKey);
  if (!hit) return null;
  if ((now - Number(hit.at || 0)) > OCR_CACHE_TTL_MS) {
    _ocrCache.delete(cacheKey);
    return null;
  }
  return _cloneValue(hit.value);
}

function _writeCache(key = '', value = null, options = {}) {
  if (!_isCacheEnabled(options)) return;
  const cacheKey = String(key || '').trim();
  if (!cacheKey || !value || typeof value !== 'object' || value.success !== true) return;
  const now = Date.now();
  _ocrCache.set(cacheKey, {
    at: now,
    value: _cloneValue(value),
  });
  _pruneCache(now);
}

function _normalizePathForKey(filePath = '') {
  const resolved = path.resolve(String(filePath || '').trim());
  if (process.platform === 'win32') return resolved.toLowerCase();
  return resolved;
}

function _computeFileHashSync(filePath = '', maxBytes = OCR_CACHE_HASH_MAX_BYTES) {
  const resolved = path.resolve(String(filePath || '').trim());
  const stat = _safeStat(resolved);
  if (!stat || !stat.isFile()) return '';
  const limit = Math.max(64 * 1024, parseInt(String(maxBytes || OCR_CACHE_HASH_MAX_BYTES), 10) || OCR_CACHE_HASH_MAX_BYTES);
  const hash = crypto.createHash('sha1');
  const fd = fs.openSync(resolved, 'r');
  const chunkSize = Math.min(1024 * 1024, limit);
  const buffer = Buffer.allocUnsafe(chunkSize);
  let offset = 0;
  let remaining = limit;
  let readTotal = 0;
  try {
    while (remaining > 0) {
      const toRead = Math.min(chunkSize, remaining);
      const bytesRead = fs.readSync(fd, buffer, 0, toRead, offset);
      if (!bytesRead || bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      offset += bytesRead;
      readTotal += bytesRead;
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  if (stat.size > readTotal) {
    hash.update(`:truncated:${stat.size - readTotal}`);
  }
  return hash.digest('hex');
}

async function _computeFileHashAsync(filePath = '', maxBytes = OCR_CACHE_HASH_MAX_BYTES) {
  const resolved = path.resolve(String(filePath || '').trim());
  const stat = _safeStat(resolved);
  if (!stat || !stat.isFile()) return '';
  const limit = Math.max(64 * 1024, parseInt(String(maxBytes || OCR_CACHE_HASH_MAX_BYTES), 10) || OCR_CACHE_HASH_MAX_BYTES);
  const hash = crypto.createHash('sha1');
  return new Promise((resolve) => {
    let bytes = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (stat.size > bytes) {
        hash.update(`:truncated:${stat.size - bytes}`);
      }
      resolve(hash.digest('hex'));
    };
    const stream = fs.createReadStream(resolved, {
      highWaterMark: 1024 * 1024,
    });
    stream.on('data', (chunk) => {
      if (bytes >= limit) return;
      const remain = limit - bytes;
      const slice = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
      if (slice.length > 0) {
        hash.update(slice);
        bytes += slice.length;
      }
      if (bytes >= limit) {
        stream.destroy();
      }
    });
    stream.on('error', () => {
      if (settled) return;
      settled = true;
      resolve('');
    });
    stream.on('close', finish);
    stream.on('end', finish);
  });
}

function _buildImageCacheKey(filePath = '', stat = null, hash = '', options = {}) {
  if (!stat || !hash) return '';
  const lang = String(options.lang || OCR_LANG).trim() || OCR_LANG;
  const maxChars = Math.max(
    120,
    parseInt(String(options.maxChars || IMAGE_OCR_MAX_CHARS), 10) || IMAGE_OCR_MAX_CHARS
  );
  const timeoutMs = Math.max(
    800,
    parseInt(String(options.timeoutMs || IMAGE_OCR_TIMEOUT_MS), 10) || IMAGE_OCR_TIMEOUT_MS
  );
  return [
    'ocr:image',
    _normalizePathForKey(filePath),
    `mtime=${Math.floor(Number(stat.mtimeMs || 0))}`,
    `size=${Number(stat.size || 0)}`,
    `sha1=${hash}`,
    `lang=${lang}`,
    `maxChars=${maxChars}`,
    `timeoutMs=${timeoutMs}`,
  ].join('|');
}

function _buildPdfCacheKey(filePath = '', stat = null, hash = '', options = {}) {
  if (!stat || !hash) return '';
  const maxPages = Math.max(
    1,
    parseInt(String(options.maxPages || PDF_OCR_MAX_PAGES), 10) || PDF_OCR_MAX_PAGES
  );
  const maxChars = Math.max(
    120,
    parseInt(String(options.maxChars || IMAGE_OCR_MAX_CHARS), 10) || IMAGE_OCR_MAX_CHARS
  );
  const lang = String(options.lang || OCR_LANG).trim() || OCR_LANG;
  const timeoutMs = Math.max(
    800,
    parseInt(String(options.timeoutMs || IMAGE_OCR_TIMEOUT_MS), 10) || IMAGE_OCR_TIMEOUT_MS
  );
  const totalBudgetMs = Math.max(
    timeoutMs,
    parseInt(String(options.totalBudgetMs || PDF_OCR_TOTAL_BUDGET_MS), 10) || PDF_OCR_TOTAL_BUDGET_MS
  );
  return [
    'ocr:pdf_scan',
    _normalizePathForKey(filePath),
    `mtime=${Math.floor(Number(stat.mtimeMs || 0))}`,
    `size=${Number(stat.size || 0)}`,
    `sha1=${hash}`,
    `maxPages=${maxPages}`,
    `maxChars=${maxChars}`,
    `lang=${lang}`,
    `timeoutMs=${timeoutMs}`,
    `totalBudgetMs=${totalBudgetMs}`,
  ].join('|');
}

function _run(cmd, args = [], timeoutMs = IMAGE_OCR_TIMEOUT_MS) {
  return spawnSync(cmd, args, {
    encoding: 'utf-8',
    timeout: Math.max(800, parseInt(String(timeoutMs || IMAGE_OCR_TIMEOUT_MS), 10) || IMAGE_OCR_TIMEOUT_MS),
    maxBuffer: 8 * 1024 * 1024,
  });
}

function _runAsync(cmd, args = [], timeoutMs = IMAGE_OCR_TIMEOUT_MS) {
  const ms = Math.max(800, parseInt(String(timeoutMs || IMAGE_OCR_TIMEOUT_MS), 10) || IMAGE_OCR_TIMEOUT_MS);
  return new Promise((resolve) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    let timer = null;
    let child = null;

    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(payload || { status: 1, stdout, stderr });
    };

    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        status: 1,
        stdout,
        stderr: String(error?.message || error || 'spawn failed'),
      });
      return;
    }

    const appendChunk = (prev, chunk) => {
      if (!chunk) return prev;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      let out = `${prev}${text}`;
      if (out.length > 8 * 1024 * 1024) {
        out = out.slice(out.length - (8 * 1024 * 1024));
      }
      return out;
    };

    child.stdout?.on('data', (chunk) => {
      stdout = appendChunk(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendChunk(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({
        status: 1,
        stdout,
        stderr: stderr || String(error?.message || error || 'spawn error'),
      });
    });
    child.on('close', (code) => {
      finish({
        status: Number.isInteger(code) ? code : 1,
        stdout,
        stderr,
      });
    });

    timer = setTimeout(() => {
      try { safeKill(child, 'SIGKILL', 0); } catch { /* ignore */ }
      finish({
        status: 124,
        stdout,
        stderr: stderr || `timeout after ${ms}ms`,
      });
    }, ms);
    timer.unref?.();
  });
}

function _resolvePython() {
  try {
    const { findPython } = require('../utils/pythonPath');
    return findPython();
  } catch {
    return process.platform === 'win32' ? 'python' : 'python3';
  }
}

function _parseDocHelperJson(raw = '') {
  try {
    return JSON.parse(String(raw || '').trim() || '{}');
  } catch {
    return null;
  }
}

function _validateImageInput(filePath = '', mimeType = '') {
  const resolved = path.resolve(String(filePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) {
    return { ok: false, failure: { success: false, error: `file not found: ${resolved || filePath}` } };
  }
  const stat = _safeStat(resolved);
  if (!stat || !stat.isFile()) return { ok: false, failure: { success: false, error: 'input is not a file' } };
  if (stat.size <= 0) return { ok: false, failure: { success: false, error: 'empty file' } };
  if (stat.size > IMAGE_OCR_MAX_BYTES) {
    return { ok: false, failure: { success: false, error: `image too large (${Math.round(stat.size / 1024 / 1024)}MB)` } };
  }
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(resolved).toLowerCase();
  const isImage = mime.startsWith('image/') || IMAGE_EXTS.has(ext);
  if (!isImage) {
    return { ok: false, failure: { success: false, error: `unsupported image type: ${mime || ext || 'unknown'}` } };
  }
  return { ok: true, value: { resolved, stat } };
}

function _ocrImageWithDocHelper(filePath = '', options = {}) {
  const timeoutMs = Math.max(
    800,
    parseInt(String(options.timeoutMs || IMAGE_OCR_TIMEOUT_MS), 10) || IMAGE_OCR_TIMEOUT_MS
  );
  const lang = String(options.lang || OCR_LANG).trim() || OCR_LANG;
  const python = _resolvePython();
  const result = _run(python, [DOC_HELPER, 'ocr', filePath, lang], timeoutMs);
  if (result.status !== 0) {
    return {
      success: false,
      error: String(result.stderr || result.stdout || `python exited ${result.status}`).trim(),
      engine: 'docHelper',
    };
  }
  const parsed = _parseDocHelperJson(result.stdout || '');
  if (!parsed || typeof parsed !== 'object') {
    return { success: false, error: 'docHelper returned invalid JSON', engine: 'docHelper' };
  }
  if (!parsed.success) {
    return { success: false, error: String(parsed.error || 'ocr failed'), engine: 'docHelper' };
  }
  const text = _normalize(parsed.text || '');
  if (!text) return { success: false, error: 'ocr returned empty text', engine: 'docHelper' };
  return {
    success: true,
    engine: 'tesseract',
    text,
    confidence: Number(parsed.confidence || 0) || 0,
    needsAiFallback: parsed.needsAiFallback === true,
    lang: parsed.lang || lang,
    requestedLang: parsed.requestedLang || lang,
    orientationCorrected: Number(parsed.orientationCorrected) || 0,
    upscaledFactor: Number(parsed.upscaledFactor) || 0,
  };
}

async function _ocrImageWithDocHelperAsync(filePath = '', options = {}) {
  const timeoutMs = Math.max(
    800,
    parseInt(String(options.timeoutMs || IMAGE_OCR_TIMEOUT_MS), 10) || IMAGE_OCR_TIMEOUT_MS
  );
  const lang = String(options.lang || OCR_LANG).trim() || OCR_LANG;
  const python = _resolvePython();
  const result = await _runAsync(python, [DOC_HELPER, 'ocr', filePath, lang], timeoutMs);
  if (result.status !== 0) {
    return {
      success: false,
      error: String(result.stderr || result.stdout || `python exited ${result.status}`).trim(),
      engine: 'docHelper',
    };
  }
  const parsed = _parseDocHelperJson(result.stdout || '');
  if (!parsed || typeof parsed !== 'object') {
    return { success: false, error: 'docHelper returned invalid JSON', engine: 'docHelper' };
  }
  if (!parsed.success) {
    return { success: false, error: String(parsed.error || 'ocr failed'), engine: 'docHelper' };
  }
  const text = _normalize(parsed.text || '');
  if (!text) return { success: false, error: 'ocr returned empty text', engine: 'docHelper' };
  return {
    success: true,
    engine: 'tesseract',
    text,
    confidence: Number(parsed.confidence || 0) || 0,
    needsAiFallback: parsed.needsAiFallback === true,
    lang: parsed.lang || lang,
    requestedLang: parsed.requestedLang || lang,
    orientationCorrected: Number(parsed.orientationCorrected) || 0,
    upscaledFactor: Number(parsed.upscaledFactor) || 0,
  };
}

function extractImageOcrSnippet(filePath = '', mimeType = '', options = {}) {
  const checked = _validateImageInput(filePath, mimeType);
  if (!checked.ok) return checked.failure;
  const maxChars = Math.max(
    120,
    parseInt(String(options.maxChars || IMAGE_OCR_MAX_CHARS), 10) || IMAGE_OCR_MAX_CHARS
  );
  const fileHash = _computeFileHashSync(checked.value.resolved, options.cacheHashMaxBytes);
  const cacheKey = _buildImageCacheKey(checked.value.resolved, checked.value.stat, fileHash, {
    ...options,
    maxChars,
  });
  const cached = _readCache(cacheKey, options);
  if (cached) return cached;
  const result = _ocrImageWithDocHelper(checked.value.resolved, options);
  if (!result.success) return result;
  const { text: _text, truncated: _truncated } = _truncateInfo(result.text, maxChars);
  const output = {
    success: true,
    engine: result.engine || 'tesseract',
    text: _text,
    confidence: result.confidence || 0,
    needsAiFallback: result.needsAiFallback === true,
    truncated: _truncated,
    lang: result.lang || String(options.lang || OCR_LANG),
    requestedLang: result.requestedLang || String(options.lang || OCR_LANG),
    orientationCorrected: Number(result.orientationCorrected) || 0,
    upscaledFactor: Number(result.upscaledFactor) || 0,
  };
  _writeCache(cacheKey, output, options);
  return output;
}

async function extractImageOcrSnippetAsync(filePath = '', mimeType = '', options = {}) {
  const checked = _validateImageInput(filePath, mimeType);
  if (!checked.ok) return checked.failure;
  const maxChars = Math.max(
    120,
    parseInt(String(options.maxChars || IMAGE_OCR_MAX_CHARS), 10) || IMAGE_OCR_MAX_CHARS
  );
  const fileHash = await _computeFileHashAsync(checked.value.resolved, options.cacheHashMaxBytes);
  const cacheKey = _buildImageCacheKey(checked.value.resolved, checked.value.stat, fileHash, {
    ...options,
    maxChars,
  });
  const cached = _readCache(cacheKey, options);
  if (cached) return cached;
  const result = await _ocrImageWithDocHelperAsync(checked.value.resolved, options);
  if (!result.success) return result;
  const { text: _text, truncated: _truncated } = _truncateInfo(result.text, maxChars);
  const output = {
    success: true,
    engine: result.engine || 'tesseract',
    text: _text,
    confidence: result.confidence || 0,
    needsAiFallback: result.needsAiFallback === true,
    truncated: _truncated,
    lang: result.lang || String(options.lang || OCR_LANG),
    requestedLang: result.requestedLang || String(options.lang || OCR_LANG),
    orientationCorrected: Number(result.orientationCorrected) || 0,
    upscaledFactor: Number(result.upscaledFactor) || 0,
  };
  _writeCache(cacheKey, output, options);
  return output;
}

function _collectPngPages(tempDir = '', prefix = '') {
  const out = [];
  const base = path.basename(prefix);
  let names = [];
  try { names = fs.readdirSync(tempDir); } catch { return out; }
  const pattern = new RegExp(`^${base}-(\\d+)\\.png$`, 'i');
  for (const name of names) {
    const m = name.match(pattern);
    if (!m) continue;
    out.push({
      page: Math.max(1, parseInt(String(m[1]), 10) || 1),
      path: path.join(tempDir, name),
    });
  }
  return out.sort((a, b) => a.page - b.page);
}

function _cleanupDir(tempDir = '') {
  if (!tempDir) return;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function _validatePdfInput(filePath = '', mimeType = '') {
  const resolved = path.resolve(String(filePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) {
    return { ok: false, failure: { success: false, error: `file not found: ${resolved || filePath}` } };
  }
  const stat = _safeStat(resolved);
  if (!stat || !stat.isFile()) return { ok: false, failure: { success: false, error: 'input is not a file' } };
  if (stat.size <= 0) return { ok: false, failure: { success: false, error: 'empty file' } };
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(resolved).toLowerCase();
  const isPdf = mime === 'application/pdf' || ext === '.pdf';
  if (!isPdf) {
    return { ok: false, failure: { success: false, error: `unsupported document type: ${mime || ext || 'unknown'}` } };
  }
  if (!searchExecutable('pdftoppm')) {
    return { ok: false, failure: { success: false, error: 'pdftoppm not installed' } };
  }
  return { ok: true, value: { resolved, stat } };
}

function extractScannedPdfOcrSnippet(filePath = '', mimeType = '', options = {}) {
  const checked = _validatePdfInput(filePath, mimeType);
  if (!checked.ok) return checked.failure;
  const maxPages = Math.max(
    1,
    parseInt(String(options.maxPages || PDF_OCR_MAX_PAGES), 10) || PDF_OCR_MAX_PAGES
  );
  const maxChars = Math.max(
    120,
    parseInt(String(options.maxChars || IMAGE_OCR_MAX_CHARS), 10) || IMAGE_OCR_MAX_CHARS
  );
  const timeoutMs = Math.max(
    800,
    parseInt(String(options.timeoutMs || IMAGE_OCR_TIMEOUT_MS), 10) || IMAGE_OCR_TIMEOUT_MS
  );
  const fileHash = _computeFileHashSync(checked.value.resolved, options.cacheHashMaxBytes);
  const cacheKey = _buildPdfCacheKey(checked.value.resolved, checked.value.stat, fileHash, {
    ...options,
    maxPages,
    maxChars,
    timeoutMs,
  });
  const cached = _readCache(cacheKey, options);
  if (cached) return cached;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-pdf-ocr-'));
  const outPrefix = path.join(tempDir, 'page');

  try {
    const convert = _run(
      'pdftoppm',
      ['-f', '1', '-l', String(maxPages), '-png', checked.value.resolved, outPrefix],
      timeoutMs
    );
    if (convert.status !== 0) {
      return {
        success: false,
        error: String(convert.stderr || convert.stdout || `pdftoppm exited ${convert.status}`).trim(),
        engine: 'pdftoppm',
      };
    }
    const images = _collectPngPages(tempDir, outPrefix).slice(0, maxPages);
    if (images.length === 0) {
      return { success: false, error: 'pdftoppm produced no image pages', engine: 'pdftoppm' };
    }
    const lines = [];
    for (const item of images) {
      const ocr = extractImageOcrSnippet(item.path, 'image/png', {
        ...options,
        maxChars: Math.max(80, Math.floor(maxChars / Math.max(1, images.length))),
        timeoutMs,
        cache: false,
      });
      if (!ocr.success || !ocr.text) continue;
      lines.push(`[Page ${item.page}] ${ocr.text}`);
    }
    if (lines.length === 0) {
      return { success: false, error: 'ocr produced no text from scanned pdf', engine: 'tesseract' };
    }
    const output = {
      success: true,
      engine: 'tesseract+pdftoppm',
      text: _truncate(lines.join('\n'), maxChars),
      pageCount: lines.length,
    };
    _writeCache(cacheKey, output, options);
    return output;
  } finally {
    _cleanupDir(tempDir);
  }
}

async function extractScannedPdfOcrSnippetAsync(filePath = '', mimeType = '', options = {}) {
  const checked = _validatePdfInput(filePath, mimeType);
  if (!checked.ok) return checked.failure;
  const maxPages = Math.max(
    1,
    parseInt(String(options.maxPages || PDF_OCR_MAX_PAGES), 10) || PDF_OCR_MAX_PAGES
  );
  const maxChars = Math.max(
    120,
    parseInt(String(options.maxChars || IMAGE_OCR_MAX_CHARS), 10) || IMAGE_OCR_MAX_CHARS
  );
  const timeoutMs = Math.max(
    800,
    parseInt(String(options.timeoutMs || IMAGE_OCR_TIMEOUT_MS), 10) || IMAGE_OCR_TIMEOUT_MS
  );
  const totalBudgetMs = Math.max(
    timeoutMs,
    parseInt(String(options.totalBudgetMs || PDF_OCR_TOTAL_BUDGET_MS), 10) || PDF_OCR_TOTAL_BUDGET_MS
  );
  const fileHash = await _computeFileHashAsync(checked.value.resolved, options.cacheHashMaxBytes);
  const cacheKey = _buildPdfCacheKey(checked.value.resolved, checked.value.stat, fileHash, {
    ...options,
    maxPages,
    maxChars,
    timeoutMs,
    totalBudgetMs,
  });
  const cached = _readCache(cacheKey, options);
  if (cached) return cached;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-pdf-ocr-'));
  const outPrefix = path.join(tempDir, 'page');
  const startedAt = Date.now();
  try {
    const convert = await _runAsync(
      'pdftoppm',
      ['-f', '1', '-l', String(maxPages), '-png', checked.value.resolved, outPrefix],
      timeoutMs
    );
    if (convert.status !== 0) {
      return {
        success: false,
        error: String(convert.stderr || convert.stdout || `pdftoppm exited ${convert.status}`).trim(),
        engine: 'pdftoppm',
      };
    }
    const images = _collectPngPages(tempDir, outPrefix).slice(0, maxPages);
    if (images.length === 0) {
      return { success: false, error: 'pdftoppm produced no image pages', engine: 'pdftoppm' };
    }
    const lines = [];
    for (let index = 0; index < images.length; index += 1) {
      const item = images[index];
      const remaining = totalBudgetMs - (Date.now() - startedAt);
      if (remaining < 300) break;
      const perPageTimeout = Math.max(700, Math.min(timeoutMs, remaining));
      const ocr = await extractImageOcrSnippetAsync(item.path, 'image/png', {
        ...options,
        maxChars: Math.max(80, Math.floor(maxChars / Math.max(1, images.length))),
        timeoutMs: perPageTimeout,
        cache: false,
      });
      if (!ocr.success || !ocr.text) continue;
      lines.push(`[Page ${item.page}] ${ocr.text}`);
    }
    if (lines.length === 0) {
      return { success: false, error: 'ocr produced no text from scanned pdf', engine: 'tesseract' };
    }
    const output = {
      success: true,
      engine: 'tesseract+pdftoppm',
      text: _truncate(lines.join('\n'), maxChars),
      pageCount: lines.length,
    };
    _writeCache(cacheKey, output, options);
    return output;
  } finally {
    _cleanupDir(tempDir);
  }
}

module.exports = {
  extractImageOcrSnippet,
  extractImageOcrSnippetAsync,
  extractScannedPdfOcrSnippet,
  extractScannedPdfOcrSnippetAsync,
};
