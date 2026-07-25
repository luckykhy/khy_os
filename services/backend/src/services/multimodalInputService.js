'use strict';

/**
 * multimodalInputService.js
 *
 * Normalizes multi-modal inputs for chat:
 * - Detects inline local file paths from user text (image/audio/video/document)
 * - Converts local image files to gateway-ready image payloads
 * - Builds a compact media manifest for non-image files
 * - Suggests preferred adapters by media capability registry
 */

const fs = require('fs');
const path = require('path');

const imageService = require('./imageService');
const { mediaRegistry } = require('./mediaUnderstanding');
const mediaTranscription = require('./mediaTranscriptionService');
const documentSnippet = require('./documentSnippetService');
const ocrSnippet = require('./ocrSnippetService');
const archiveManifestPolicy = require('./archiveManifestPolicy');
const archiveInspect = require('./archiveInspectService');

const EXT_MIME_MAP = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'application/xml',
  '.log': 'text/plain',
});

// Quote/bracket delimiters that may wrap a pasted file path. ASCII (" ' `) plus
// CJK/fullwidth variants — a Chinese IME commonly wraps a pasted path in
// “ ” ‘ ’ 「 」 『 』 instead of ASCII quotes. The ASCII-only class used before
// left a fullwidth-quoted path undetectable: it stayed as prompt text and the
// model tried to `Read` the path string instead of seeing the image. Keeping the
// set in one constant holds the open, close, and inner-negation classes in sync.
// (String.fromCharCode keeps the source pure-ASCII: 0022/0027/0060 = " ' ` ; 201C..201F =
//  “ ” ‘ ’ ; 300C..300F = 「 」 『 』.)
const PATH_QUOTE_CHARS = String.fromCharCode(0x22, 0x27, 0x60, 0x201C, 0x201D, 0x2018, 0x2019, 0x300C, 0x300D, 0x300E, 0x300F);

const INLINE_MAX_FILES = 6;
const SNIPPET_MAX_CHARS = Math.max(
  800,
  parseInt(String(process.env.KHY_MULTIMODAL_SNIPPET_MAX_CHARS || '2400'), 10) || 2400
);
const SNIPPET_MAX_BYTES = Math.max(
  2048,
  parseInt(String(process.env.KHY_MULTIMODAL_SNIPPET_MAX_BYTES || '131072'), 10) || 131072
);
const TRANSCRIBE_MAX_FILES = Math.max(
  1,
  parseInt(String(process.env.KHY_MULTIMODAL_TRANSCRIBE_MAX_FILES || '2'), 10) || 2
);
const TRANSCRIBE_MAX_CHARS = Math.max(
  600,
  parseInt(String(process.env.KHY_MULTIMODAL_TRANSCRIBE_MAX_CHARS || '3200'), 10) || 3200
);
const TRANSCRIBE_TOTAL_BUDGET_MS = Math.max(
  1500,
  parseInt(String(process.env.KHY_MULTIMODAL_TRANSCRIBE_TOTAL_BUDGET_MS || '8000'), 10) || 8000
);
const TRANSCRIBE_PREPARE_TIMEOUT_MS = Math.max(
  1200,
  parseInt(String(process.env.KHY_MULTIMODAL_TRANSCRIBE_PREPARE_TIMEOUT_MS || '6000'), 10) || 6000
);
const DOC_SNIPPET_MAX_FILES = Math.max(
  1,
  parseInt(String(process.env.KHY_MULTIMODAL_DOC_SNIPPET_MAX_FILES || '2'), 10) || 2
);
const DOC_SNIPPET_TOTAL_BUDGET_MS = Math.max(
  1200,
  parseInt(String(process.env.KHY_MULTIMODAL_DOC_SNIPPET_TOTAL_BUDGET_MS || '5000'), 10) || 5000
);
const DOC_SNIPPET_PREPARE_TIMEOUT_MS = Math.max(
  1000,
  parseInt(String(process.env.KHY_MULTIMODAL_DOC_SNIPPET_PREPARE_TIMEOUT_MS || '3500'), 10) || 3500
);
const IMAGE_OCR_MAX_FILES = Math.max(
  1,
  parseInt(String(process.env.KHY_MULTIMODAL_IMAGE_OCR_MAX_FILES || '2'), 10) || 2
);
const IMAGE_OCR_TOTAL_BUDGET_MS = Math.max(
  1200,
  parseInt(String(process.env.KHY_MULTIMODAL_IMAGE_OCR_TOTAL_BUDGET_MS || '5000'), 10) || 5000
);
const IMAGE_OCR_PREPARE_TIMEOUT_MS = Math.max(
  900,
  parseInt(String(process.env.KHY_MULTIMODAL_IMAGE_OCR_PREPARE_TIMEOUT_MS || '2800'), 10) || 2800
);
const IMAGE_OCR_MAX_CHARS = Math.max(
  120,
  parseInt(String(process.env.KHY_MULTIMODAL_IMAGE_OCR_MAX_CHARS || '1200'), 10) || 1200
);
const ARCHIVE_MAX_FILES = Math.max(
  1,
  parseInt(String(process.env.KHY_MULTIMODAL_ARCHIVE_MAX_FILES || '2'), 10) || 2
);
const ARCHIVE_TOTAL_BUDGET_MS = Math.max(
  1500,
  parseInt(String(process.env.KHY_MULTIMODAL_ARCHIVE_TOTAL_BUDGET_MS || '8000'), 10) || 8000
);
const ARCHIVE_PREPARE_TIMEOUT_MS = Math.max(
  1000,
  parseInt(String(process.env.KHY_MULTIMODAL_ARCHIVE_PREPARE_TIMEOUT_MS || '5000'), 10) || 5000
);

const PROVIDER_TO_ADAPTERS = Object.freeze({
  claude: ['claude', 'api', 'relay_api'],
  'gpt4-vision': ['codex', 'api', 'relay_api'],
  gemini: ['api', 'relay_api'],
  ollama: ['ollama', 'localLLM'],
});

function _toFilePath(rawPath = '') {
  let text = String(rawPath || '').trim();
  if (!text) return '';
  if (/^file:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      text = decodeURIComponent(u.pathname || '');
      if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(text)) {
        text = text.slice(1);
      }
    } catch {
      text = text.replace(/^file:\/\/(?:localhost)?/i, '');
      try { text = decodeURIComponent(text); } catch { /* ignore */ }
    }
  }
  return path.resolve(text);
}

function _mimeFromPath(filePath = '') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  // 压缩包不在 EXT_MIME_MAP(归档是独立第 5 类输入,见 archiveManifestPolicy)。门控关时
  // mimeForArchive 返 '' → 逐字节回退到「无 mime → unknown → 丢弃」的今日行为。
  return EXT_MIME_MAP[ext] || archiveManifestPolicy.mimeForArchive(filePath) || '';
}

function _kindFromMime(mimeType = '') {
  const lower = String(mimeType || '').toLowerCase();
  if (!lower) return 'unknown';
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('video/')) return 'video';
  if (lower.startsWith('text/') || lower === 'application/pdf' || lower.includes('json') || lower.includes('xml')) {
    return 'document';
  }
  // 压缩包:第 5 类输入。门控关时 isArchiveMime 恒 false → 落回 'unknown'(今日行为)。
  if (archiveManifestPolicy.isArchiveMime(lower)) return 'archive';
  return 'unknown';
}

function _isTextLikeMime(mimeType = '') {
  const lower = String(mimeType || '').toLowerCase();
  return lower.startsWith('text/')
    || lower.includes('json')
    || lower.includes('xml')
    || lower.includes('yaml')
    || lower.includes('csv');
}

function _safeFileStat(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return stat && stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function _formatBytes(sizeBytes = 0, env = process.env) {
  // 字节→人类可读单一真源:门控 KHY_CC_FORMAT 开 → 走 CC `formatFileSize` 同口径
  // (与 health/storage/aiUploadStore/archive 等所有展示面统一);关 → 逐字节回退本地旧口径。
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../cli/ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(Number(sizeBytes || 0));
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  const n = Number(sizeBytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${Math.round(n)}B`;
}

function _stripEdgePunctuation(token = '') {
  // PATH_QUOTE_CHARS is appended to both edge classes so leading/trailing ASCII
  // *and* CJK/fullwidth quotes (from a Chinese IME) are stripped — e.g. a path
  // pasted wrapped in fullwidth double quotes on Windows.
  const lead = new RegExp('^[<({\\[' + PATH_QUOTE_CHARS + ']+');
  const trail = new RegExp('[>)}\\],;.!?' + PATH_QUOTE_CHARS + ']+$');
  return String(token || '')
    .replace(lead, '')
    .replace(trail, '')
    .trim();
}

function _looksLikeMediaPath(token = '') {
  if (!token) return false;
  const cleaned = _stripEdgePunctuation(token);
  if (!cleaned) return false;
  const ext = path.extname(cleaned).toLowerCase();
  // 压缩包扩展名不在 EXT_MIME_MAP,但仍是可识别的媒体输入(门控关时 isArchivePath 恒 false
  // → 逐字节回退到「不识别 → 不作为内联媒体」的今日行为)。
  if (!EXT_MIME_MAP[ext] && !archiveManifestPolicy.isArchivePath(cleaned)) return false;
  return /^file:\/\//i.test(cleaned)
    || /^\/|^\.\.?\/|^[A-Za-z]:[\\/]/.test(cleaned);
}

function detectInlineMediaPaths(text = '', maxFiles = INLINE_MAX_FILES) {
  const source = String(text || '').trim();
  if (!source) return [];

  const out = [];
  const seen = new Set();

  const pushCandidate = (rawPath) => {
    if (!rawPath || out.length >= maxFiles) return;
    const cleaned = _stripEdgePunctuation(rawPath);
    if (!cleaned || !_looksLikeMediaPath(cleaned)) return;
    const resolved = _toFilePath(cleaned);
    if (!resolved || seen.has(resolved)) return;
    const stat = _safeFileStat(resolved);
    if (!stat) return;
    seen.add(resolved);
    const mimeType = _mimeFromPath(resolved);
    out.push({
      source: 'inline',
      path: resolved,
      name: path.basename(resolved),
      mimeType: mimeType || 'application/octet-stream',
      kind: _kindFromMime(mimeType),
      sizeBytes: stat.size,
    });
  };

  // Built from PATH_QUOTE_CHARS so a path wrapped in ASCII or CJK/fullwidth
  // quotes is captured. The inner negation class [^<quotes>]+ also uses the same
  // set so a fullwidth closing quote terminates the match correctly.
  const quotedPattern = new RegExp(
    '[' + PATH_QUOTE_CHARS + '](file://[^' + PATH_QUOTE_CHARS + ']+|(?:[A-Za-z]:[\\\\/]|/|\\./|\\.\\./)[^' + PATH_QUOTE_CHARS + ']+)[' + PATH_QUOTE_CHARS + ']',
    'g'
  );
  let m = quotedPattern.exec(source);
  while (m) {
    pushCandidate(m[1]);
    if (out.length >= maxFiles) break;
    m = quotedPattern.exec(source);
  }
  if (out.length >= maxFiles) return out;

  for (const token of source.split(/\s+/)) {
    if (out.length >= maxFiles) break;
    pushCandidate(token);
  }

  return out;
}

function _readTextSnippet(filePath = '', maxBytes = SNIPPET_MAX_BYTES, maxChars = SNIPPET_MAX_CHARS) {
  try {
    const stat = _safeFileStat(filePath);
    if (!stat || stat.size <= 0 || stat.size > maxBytes) return '';
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw) return '';
    const normalized = String(raw).replace(/\r\n/g, '\n').trim();
    if (!normalized) return '';
    return normalized.length > maxChars
      ? `${normalized.slice(0, maxChars)}\n...[truncated]`
      : normalized;
  } catch {
    return '';
  }
}

// Native document passthrough: send the raw PDF/text as an Anthropic `document`
// block so vision-capable models (Opus 4.x) read it at full fidelity instead of
// relying only on lossy text extraction. Default on; cap guards request size.
const NATIVE_DOC_MAX_BYTES = Math.max(
  1024,
  parseInt(String(process.env.KHY_NATIVE_DOC_MAX_BYTES || '10485760'), 10) || 10485760
);

function _isNativeDocPassthroughEnabled(options = {}) {
  const raw = String(
    (options && options.multimodalNativeDocPassthrough)
    ?? process.env.KHY_NATIVE_DOC_PASSTHROUGH
    ?? 'true'
  ).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function _readDocBase64(filePath = '', maxBytes = NATIVE_DOC_MAX_BYTES) {
  try {
    const stat = _safeFileStat(filePath);
    if (!stat || stat.size <= 0 || stat.size > maxBytes) return '';
    return fs.readFileSync(filePath).toString('base64');
  } catch {
    return '';
  }
}

// Cap for native text-source documents. Distinct from NATIVE_DOC_MAX_BYTES
// (which sizes compressed binary PDFs): raw text expands ~1 byte/token, so a
// 1 MB ceiling (~256k tokens) stays inside even the 1M context window. Oversized
// text falls back to the truncated snippet path.
const NATIVE_TEXT_MAX_BYTES = Math.max(
  1024,
  parseInt(String(process.env.KHY_NATIVE_TEXT_MAX_BYTES || '1048576'), 10) || 1048576
);

// Read a text-like document in full (bounded) for a native `document` block with
// `source.type:'text'`, giving Opus the whole file instead of a 2400-char snippet.
function _readDocText(filePath = '', maxBytes = NATIVE_TEXT_MAX_BYTES) {
  try {
    const stat = _safeFileStat(filePath);
    if (!stat || stat.size <= 0 || stat.size > maxBytes) return '';
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw) return '';
    const normalized = String(raw).replace(/\r\n/g, '\n').trim();
    return normalized || '';
  } catch {
    return '';
  }
}

function _resolveMediaEntries(userMessage = '', options = {}) {
  const explicit = Array.isArray(options.media) ? options.media : [];
  const inline = detectInlineMediaPaths(userMessage, INLINE_MAX_FILES);
  const items = [];

  for (const item of explicit) {
    if (!item || typeof item !== 'object') continue;
    const filePath = item.path || item.filePath || item.file || '';
    const resolvedPath = filePath ? _toFilePath(filePath) : '';
    const mimeType = String(item.mimeType || item.mediaType || _mimeFromPath(resolvedPath) || '').toLowerCase();
    const kind = _kindFromMime(mimeType);
    items.push({
      source: 'explicit',
      path: resolvedPath,
      name: item.name || (resolvedPath ? path.basename(resolvedPath) : ''),
      mimeType,
      kind,
      sizeBytes: Number(item.sizeBytes || 0) || 0,
      base64: item.base64 || '',
      url: item.url || item.dataUrl || '',
    });
  }

  return [...items, ...inline];
}

function _normalizeImageInput(entry = {}) {
  if (entry.base64) {
    return {
      base64: String(entry.base64),
      mimeType: String(entry.mimeType || 'image/png'),
    };
  }
  if (entry.url) {
    return { url: String(entry.url) };
  }
  if (entry.path) {
    const image = imageService.readImageFromFile(entry.path);
    return {
      base64: image.base64,
      mimeType: image.mimeType,
    };
  }
  return null;
}

function suggestAdaptersForMediaKinds(mediaKinds = []) {
  const uniqueKinds = [...new Set((mediaKinds || []).map(x => String(x || '').toLowerCase()).filter(Boolean))];
  if (uniqueKinds.length === 0) return [];

  const defaultOrdered = String(process.env.KHY_MULTIMODAL_PREFERRED_ADAPTERS || 'claude,codex,api,relay_api')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const mimeProbeMap = {
    image: 'image/png',
    audio: 'audio/mpeg',
    video: 'video/mp4',
    document: 'application/pdf',
  };

  const out = [];
  const seen = new Set();
  for (const kind of uniqueKinds) {
    const probeMime = mimeProbeMap[kind];
    if (!probeMime) continue;
    const providers = mediaRegistry.buildFallbackChain(probeMime, 0);
    for (const provider of providers) {
      const mapped = PROVIDER_TO_ADAPTERS[String(provider?.id || '').toLowerCase()] || [];
      for (const adapter of mapped) {
        const key = String(adapter || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }
  }

  for (const adapter of defaultOrdered) {
    const key = String(adapter || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }

  return out;
}

function _isTranscribeEnabled(options = {}) {
  if (options.multimodalTranscribe !== undefined) {
    return !!options.multimodalTranscribe;
  }
  const explicit = String(process.env.KHY_MULTIMODAL_TRANSCRIBE || '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(explicit)) return false;
  if (['true', '1', 'on', 'yes'].includes(explicit)) return true;
  const runtimeIsKhy = String(process.env.KHY_RUNTIME_MODE || '').trim().toLowerCase() === 'khy';
  return runtimeIsKhy;
}

function _isImageOcrEnabled(options = {}) {
  if (options.multimodalImageOcr !== undefined) {
    return !!options.multimodalImageOcr;
  }
  const explicit = String(process.env.KHY_MULTIMODAL_IMAGE_OCR || '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(explicit)) return false;
  if (['true', '1', 'on', 'yes'].includes(explicit)) return true;
  const runtimeIsKhy = String(process.env.KHY_RUNTIME_MODE || '').trim().toLowerCase() === 'khy';
  return runtimeIsKhy;
}

function _sliceTranscript(text = '', maxChars = TRANSCRIBE_MAX_CHARS) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n...[transcript truncated]`;
}

function _isPdfDocument(mimeType = '', filePath = '') {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'application/pdf') return true;
  return path.extname(String(filePath || '')).toLowerCase() === '.pdf';
}

function prepareMultimodalInput(userMessage = '', options = {}) {
  const message = String(userMessage || '');
  const resolved = _resolveMediaEntries(message, options);
  const warnings = [];
  const images = Array.isArray(options.images) ? [...options.images] : [];
  const nonImageMedia = [];
  const mediaKinds = new Set(images.length > 0 ? ['image'] : []);
  const snippetSections = [];
  const transcriptSections = [];
  const pendingPdfDocuments = [];
  const pendingImageOcr = [];
  const pendingArchives = [];
  const documents = []; // native Anthropic document blocks (base64/text) for vision models
  const nativeDocEnabled = _isNativeDocPassthroughEnabled(options);
  const transcribeEnabled = _isTranscribeEnabled(options);
  const imageOcrEnabled = _isImageOcrEnabled(options);
  const transcribeLanguage = String(
    options.multimodalTranscribeLanguage
    || process.env.KHY_MULTIMODAL_TRANSCRIBE_LANGUAGE
    || 'auto'
  ).trim();
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  const deferPdfSnippet = !!options.multimodalDeferPdfSnippet;
  const deferImageOcr = !!options.multimodalDeferImageOcr;
  let transcribeCount = 0;

  for (const entry of resolved) {
    const kind = String(entry.kind || '').toLowerCase();
    const mimeType = String(entry.mimeType || '').toLowerCase();
    const stat = entry.path ? _safeFileStat(entry.path) : null;
    const sizeBytes = Number(entry.sizeBytes || stat?.size || 0) || 0;
    const label = entry.name || (entry.path ? path.basename(entry.path) : 'media');

    if (!kind || kind === 'unknown') {
      warnings.push(`未识别媒体类型: ${label}`);
      continue;
    }
    mediaKinds.add(kind);

    if (kind === 'image') {
      try {
        const normalized = _normalizeImageInput(entry);
        if (normalized) {
          images.push(normalized);
          if (imageOcrEnabled && deferImageOcr && entry.path) {
            pendingImageOcr.push({
              name: label,
              mimeType: mimeType || 'image/png',
              path: entry.path,
            });
          }
          continue;
        }
        warnings.push(`图片输入无效: ${label}`);
      } catch (err) {
        warnings.push(`图片加载失败: ${label} (${err.message || 'unknown error'})`);
      }
      continue;
    }

    nonImageMedia.push({
      kind,
      mimeType: mimeType || 'application/octet-stream',
      name: label,
      path: entry.path || '',
      sizeBytes,
      source: entry.source || 'unknown',
    });

    if (kind === 'document' && entry.path) {
      // Native passthrough (additive): give the Claude adapter the raw bytes as a
      // `document` block. Non-vision adapters ignore `documents` and still get the
      // text snippet below, so this is zero-regression. PDFs go base64; the text
      // snippet path already covers text-like docs, so we only base64 PDFs here.
      if (nativeDocEnabled && _isPdfDocument(mimeType, entry.path)) {
        const b64 = _readDocBase64(entry.path);
        if (b64) {
          documents.push({ name: label, mimeType: mimeType || 'application/pdf', base64: b64 });
        }
      } else if (nativeDocEnabled && _isTextLikeMime(mimeType)) {
        // Native text-source document (csv/txt/json/code/...): full content so
        // vision-capable models read the whole file with citations, instead of
        // only the truncated snippet below. Additive — the snippet still runs so
        // non-Claude adapters (which ignore `documents`) are byte-identical.
        const fullText = _readDocText(entry.path);
        if (fullText) {
          documents.push({ name: label, mimeType: 'text/plain', text: fullText });
        }
      }
      let snippet = '';
      if (_isTextLikeMime(mimeType)) {
        snippet = _readTextSnippet(entry.path, SNIPPET_MAX_BYTES, SNIPPET_MAX_CHARS);
      } else if (_isPdfDocument(mimeType, entry.path)) {
        if (deferPdfSnippet) {
          pendingPdfDocuments.push({
            name: label,
            mimeType: mimeType || 'application/pdf',
            path: entry.path,
          });
        } else {
          const extracted = documentSnippet.extractDocumentSnippet(entry.path, mimeType, {
            maxChars: SNIPPET_MAX_CHARS,
          });
          if (extracted && extracted.success && extracted.text) {
            snippet = extracted.text;
          } else if (extracted && extracted.error) {
            warnings.push(`文档提取失败: ${label} (${extracted.error})`);
          }
        }
      }
      if (snippet) {
        snippetSections.push({
          name: label,
          mimeType: mimeType || 'text/plain',
          snippet,
        });
      }
    }

    if (kind === 'archive' && entry.path) {
      // 压缩包是第 5 类输入:同步阶段只登记 + 让它进 nonImageMedia(清单头会列出
      // 「- ARCHIVE: name」,确保即便后续列目录失败/超时,模型也确定性知道有个压缩包,
      // 不再像今日那样被静默丢弃)。真正的目录列出在异步阶段按预算进行(镜像 PDF defer)。
      pendingArchives.push({
        name: label,
        mimeType: mimeType || archiveManifestPolicy.mimeForArchive(entry.path) || 'application/octet-stream',
        path: entry.path,
        sizeBytes,
      });
    }

    if (
      transcribeEnabled
      && (kind === 'audio' || kind === 'video')
      && entry.path
      && transcribeCount < TRANSCRIBE_MAX_FILES
    ) {
      transcribeCount += 1;
      if (onStatus) {
        try {
          onStatus({
            phase: 'request',
            message: `多模态转写: 正在处理 ${kind} 文件 ${label}...`,
          });
        } catch { /* best effort */ }
      }
      const tr = mediaTranscription.transcribeMediaFile(entry.path, mimeType, {
        language: transcribeLanguage,
      });
      if (tr && tr.success && tr.text) {
        transcriptSections.push({
          kind,
          name: label,
          mimeType: mimeType || 'application/octet-stream',
          engine: tr.engine || '',
          text: _sliceTranscript(tr.text, TRANSCRIBE_MAX_CHARS),
        });
      } else if (tr && tr.error) {
        warnings.push(`媒体转写失败: ${label} (${tr.error})`);
      }
    }
  }

  const uniqueKinds = [...mediaKinds];
  const preferredAdapters = suggestAdaptersForMediaKinds(uniqueKinds);

  let promptAugment = '';
  if (nonImageMedia.length > 0) {
    const lines = ['[Multimodal Inputs]'];
    for (const item of nonImageMedia.slice(0, 8)) {
      lines.push(
        `- ${item.kind.toUpperCase()}: ${item.name} (${item.mimeType}, ${_formatBytes(item.sizeBytes)})`
      );
    }
    if (nonImageMedia.length > 8) {
      lines.push(`- ... ${nonImageMedia.length - 8} more media files`);
    }
    lines.push('If direct binary parsing is unavailable on current adapter, explain constraints and provide the best next actionable workflow.');

    for (const section of snippetSections.slice(0, 3)) {
      lines.push('');
      lines.push(`[Document Snippet] ${section.name} (${section.mimeType})`);
      lines.push('```text');
      lines.push(section.snippet);
      lines.push('```');
    }
    for (const section of transcriptSections.slice(0, TRANSCRIBE_MAX_FILES)) {
      lines.push('');
      lines.push(`[Media Transcript] ${section.kind.toUpperCase()}: ${section.name} (${section.mimeType}${section.engine ? `, ${section.engine}` : ''})`);
      lines.push('```text');
      lines.push(section.text);
      lines.push('```');
    }

    promptAugment = lines.join('\n');
  }

  return {
    images,
    mediaKinds: uniqueKinds,
    nonImageMedia,
    preferredAdapters,
    warnings,
    promptAugment,
    detectedCount: resolved.length,
    pendingPdfDocuments,
    pendingImageOcr,
    pendingArchives,
    documents,
  };
}

function _timeoutResult(timeoutMs = 0) {
  return {
    success: false,
    error: `multimodal operation timeout after ${Math.max(0, Number.parseInt(String(timeoutMs || 0), 10) || 0)}ms`,
    engine: 'timeout',
  };
}

function _withTimeout(promise, timeoutMs) {
  const ms = Math.max(300, Number.parseInt(String(timeoutMs || 0), 10) || 300);
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(_timeoutResult(ms)), ms);
      timer.unref?.();
    }),
  ]);
}

function _appendTranscriptSections(promptAugment = '', transcriptSections = []) {
  if (!Array.isArray(transcriptSections) || transcriptSections.length === 0) {
    return String(promptAugment || '');
  }
  const lines = [];
  for (const section of transcriptSections.slice(0, TRANSCRIBE_MAX_FILES)) {
    lines.push('');
    lines.push(`[Media Transcript] ${section.kind.toUpperCase()}: ${section.name} (${section.mimeType}${section.engine ? `, ${section.engine}` : ''})`);
    lines.push('```text');
    lines.push(section.text);
    lines.push('```');
  }
  const base = String(promptAugment || '').trim();
  if (!base) return lines.join('\n').trim();
  return `${base}\n${lines.join('\n')}`.trim();
}

function _appendDocumentSections(promptAugment = '', snippetSections = []) {
  if (!Array.isArray(snippetSections) || snippetSections.length === 0) {
    return String(promptAugment || '');
  }
  const lines = [];
  for (const section of snippetSections.slice(0, 3)) {
    lines.push('');
    lines.push(`[Document Snippet] ${section.name} (${section.mimeType})`);
    lines.push('```text');
    lines.push(section.snippet);
    lines.push('```');
  }
  const base = String(promptAugment || '').trim();
  if (!base) return lines.join('\n').trim();
  return `${base}\n${lines.join('\n')}`.trim();
}

function _appendArchiveSections(promptAugment = '', archiveBlocks = []) {
  const blocks = (Array.isArray(archiveBlocks) ? archiveBlocks : [])
    .map(b => String(b || '').trim())
    .filter(Boolean);
  if (blocks.length === 0) return String(promptAugment || '');
  const joined = blocks.map(b => `\n${b}`).join('\n');
  const base = String(promptAugment || '').trim();
  if (!base) return joined.trim();
  return `${base}\n${joined}`.trim();
}

function _appendImageOcrSections(promptAugment = '', ocrSections = []) {
  if (!Array.isArray(ocrSections) || ocrSections.length === 0) {
    return String(promptAugment || '');
  }
  const lines = [];
  for (const section of ocrSections.slice(0, IMAGE_OCR_MAX_FILES)) {
    const extra = [];
    if (section.engine) extra.push(section.engine);
    if (Number.isFinite(section.confidence)) extra.push(`confidence=${Math.round(section.confidence)}`);
    lines.push('');
    lines.push(`[Image OCR] ${section.name} (${section.mimeType}${extra.length > 0 ? `, ${extra.join(', ')}` : ''})`);
    lines.push('```text');
    lines.push(section.text);
    lines.push('```');
  }
  const base = String(promptAugment || '').trim();
  if (!base) return lines.join('\n').trim();
  return `${base}\n${lines.join('\n')}`.trim();
}

async function prepareMultimodalInputAsync(userMessage = '', options = {}) {
  const base = prepareMultimodalInput(userMessage, {
    ...options,
    multimodalTranscribe: false,
    multimodalDeferPdfSnippet: true,
    multimodalDeferImageOcr: true,
  });
  if (!Array.isArray(base.warnings)) base.warnings = [];

  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  const imageOcrEnabled = _isImageOcrEnabled(options);

  if (imageOcrEnabled) {
    const imageCandidates = (Array.isArray(base.pendingImageOcr) ? base.pendingImageOcr : [])
      .filter(item => item && item.path)
      .slice(0, IMAGE_OCR_MAX_FILES);
    if (imageCandidates.length > 0) {
      const imageTotalBudgetMs = Math.max(
        1000,
        Number.parseInt(String(options.multimodalImageOcrTotalBudgetMs || IMAGE_OCR_TOTAL_BUDGET_MS), 10) || IMAGE_OCR_TOTAL_BUDGET_MS
      );
      const imagePerFileTimeoutMs = Math.max(
        700,
        Number.parseInt(String(options.multimodalImageOcrPrepareTimeoutMs || IMAGE_OCR_PREPARE_TIMEOUT_MS), 10) || IMAGE_OCR_PREPARE_TIMEOUT_MS
      );
      const ocrFn = typeof ocrSnippet.extractImageOcrSnippetAsync === 'function'
        ? ocrSnippet.extractImageOcrSnippetAsync.bind(ocrSnippet)
        : async (...args) => ocrSnippet.extractImageOcrSnippet(...args);
      const imageStartedAt = Date.now();
      const ocrSections = [];

      for (let index = 0; index < imageCandidates.length; index += 1) {
        const elapsed = Date.now() - imageStartedAt;
        const remaining = imageTotalBudgetMs - elapsed;
        const current = imageCandidates[index];
        if (!current) continue;
        if (remaining < 300) {
          base.warnings.push(`图片OCR跳过: 预算已用尽（${index}/${imageCandidates.length}）`);
          break;
        }
        if (onStatus) {
          try {
            onStatus({
              phase: 'request',
              message: `多模态OCR: 正在识别 ${index + 1}/${imageCandidates.length} 图片 ${current.name}...`,
            });
          } catch { /* best effort */ }
        }
        const boundedTimeout = Math.max(700, Math.min(imagePerFileTimeoutMs, remaining));
        const extracted = await _withTimeout(
          ocrFn(current.path, current.mimeType || 'image/png', {
            maxChars: IMAGE_OCR_MAX_CHARS,
            timeoutMs: boundedTimeout,
            lang: options.multimodalImageOcrLang,
          }),
          boundedTimeout + 300
        );
        if (extracted && extracted.success && extracted.text) {
          ocrSections.push({
            name: current.name,
            mimeType: current.mimeType || 'image/png',
            engine: extracted.engine || '',
            confidence: Number(extracted.confidence || 0),
            text: extracted.text,
          });
        } else if (extracted && extracted.error) {
          base.warnings.push(`图片OCR失败: ${current.name} (${extracted.error})`);
        }
      }

      if (ocrSections.length > 0) {
        base.promptAugment = _appendImageOcrSections(base.promptAugment, ocrSections);
      }
    }
  }

  const pendingPdf = (Array.isArray(base.pendingPdfDocuments) ? base.pendingPdfDocuments : [])
    .filter(item => item && item.path)
    .slice(0, DOC_SNIPPET_MAX_FILES);
  if (pendingPdf.length > 0) {
    const docTotalBudgetMs = Math.max(
      1000,
      Number.parseInt(String(options.multimodalDocSnippetTotalBudgetMs || DOC_SNIPPET_TOTAL_BUDGET_MS), 10) || DOC_SNIPPET_TOTAL_BUDGET_MS
    );
    const docPerFileTimeoutMs = Math.max(
      800,
      Number.parseInt(String(options.multimodalDocSnippetPrepareTimeoutMs || DOC_SNIPPET_PREPARE_TIMEOUT_MS), 10) || DOC_SNIPPET_PREPARE_TIMEOUT_MS
    );
    const extractDocFn = typeof documentSnippet.extractDocumentSnippetAsync === 'function'
      ? documentSnippet.extractDocumentSnippetAsync.bind(documentSnippet)
      : async (...args) => documentSnippet.extractDocumentSnippet(...args);
    const docStartedAt = Date.now();
    const docSections = [];

    for (let index = 0; index < pendingPdf.length; index += 1) {
      const elapsed = Date.now() - docStartedAt;
      const remaining = docTotalBudgetMs - elapsed;
      const current = pendingPdf[index];
      if (!current) continue;
      if (remaining < 300) {
        base.warnings.push(`文档提取跳过: 预算已用尽（${index}/${pendingPdf.length}）`);
        break;
      }
      if (onStatus) {
        try {
          onStatus({
            phase: 'request',
            message: `多模态文档提取: 正在处理 ${index + 1}/${pendingPdf.length} PDF 文件 ${current.name}...`,
          });
        } catch { /* best effort */ }
      }
      const boundedTimeout = Math.max(700, Math.min(docPerFileTimeoutMs, remaining));
      const extracted = await _withTimeout(
        extractDocFn(current.path, current.mimeType || 'application/pdf', {
          maxChars: SNIPPET_MAX_CHARS,
          timeoutMs: boundedTimeout,
          totalBudgetMs: boundedTimeout + 300,
        }),
        boundedTimeout + 300
      );
      if (extracted && extracted.success && extracted.text) {
        docSections.push({
          name: current.name,
          mimeType: current.mimeType || 'application/pdf',
          snippet: extracted.text,
        });
      } else if (extracted && extracted.error) {
        base.warnings.push(`文档提取失败: ${current.name} (${extracted.error})`);
      }
    }

    if (docSections.length > 0) {
      base.promptAugment = _appendDocumentSections(base.promptAugment, docSections);
    }
  }

  // ── 压缩包目录列出(第 5 类输入;镜像 PDF defer:预算化、绝不阻塞、绝不抛)──────
  if (archiveManifestPolicy.isEnabled()) {
    const pendingArchives = (Array.isArray(base.pendingArchives) ? base.pendingArchives : [])
      .filter(item => item && item.path)
      .slice(0, ARCHIVE_MAX_FILES);
    if (pendingArchives.length > 0) {
      const archiveTotalBudgetMs = Math.max(
        1000,
        Number.parseInt(String(options.multimodalArchiveTotalBudgetMs || ARCHIVE_TOTAL_BUDGET_MS), 10) || ARCHIVE_TOTAL_BUDGET_MS
      );
      const archivePerFileTimeoutMs = Math.max(
        800,
        Number.parseInt(String(options.multimodalArchivePrepareTimeoutMs || ARCHIVE_PREPARE_TIMEOUT_MS), 10) || ARCHIVE_PREPARE_TIMEOUT_MS
      );
      const archiveStartedAt = Date.now();
      const archiveBlocks = [];
      for (let index = 0; index < pendingArchives.length; index += 1) {
        const elapsed = Date.now() - archiveStartedAt;
        const remaining = archiveTotalBudgetMs - elapsed;
        const current = pendingArchives[index];
        if (!current) continue;
        if (remaining < 300) {
          base.warnings.push(`压缩包列目录跳过: 预算已用尽（${index}/${pendingArchives.length}）`);
          break;
        }
        if (onStatus) {
          try {
            onStatus({
              phase: 'request',
              message: `多模态压缩包: 正在列出 ${index + 1}/${pendingArchives.length} ${current.name}...`,
            });
          } catch { /* best effort */ }
        }
        const boundedTimeout = Math.max(700, Math.min(archivePerFileTimeoutMs, remaining));
        const manifest = await _withTimeout(
          archiveInspect.inspectArchiveToManifest(current.path, current.mimeType, { name: current.name }),
          boundedTimeout + 300
        );
        // _withTimeout 超时返回 {success:false,engine:'timeout'} 对象;成功返回清单字符串。
        if (typeof manifest === 'string' && manifest.trim()) {
          archiveBlocks.push(manifest);
        } else if (manifest && manifest.engine === 'timeout') {
          base.warnings.push(`压缩包列目录超时: ${current.name}`);
        }
      }
      if (archiveBlocks.length > 0) {
        base.promptAugment = _appendArchiveSections(base.promptAugment, archiveBlocks);
      }
    }
  }

  const transcribeEnabled = _isTranscribeEnabled(options);
  if (!transcribeEnabled) return base;

  const candidates = (Array.isArray(base.nonImageMedia) ? base.nonImageMedia : [])
    .filter(item => item && (item.kind === 'audio' || item.kind === 'video') && item.path)
    .slice(0, TRANSCRIBE_MAX_FILES);
  if (candidates.length === 0) return base;

  const transcribeLanguage = String(
    options.multimodalTranscribeLanguage
    || process.env.KHY_MULTIMODAL_TRANSCRIBE_LANGUAGE
    || 'auto'
  ).trim();
  const totalBudgetMs = Math.max(
    1200,
    Number.parseInt(String(options.multimodalTranscribeTotalBudgetMs || TRANSCRIBE_TOTAL_BUDGET_MS), 10) || TRANSCRIBE_TOTAL_BUDGET_MS
  );
  const perFileTimeoutMs = Math.max(
    1200,
    Number.parseInt(String(options.multimodalTranscribePrepareTimeoutMs || TRANSCRIBE_PREPARE_TIMEOUT_MS), 10) || TRANSCRIBE_PREPARE_TIMEOUT_MS
  );
  const transcribeFn = typeof mediaTranscription.transcribeMediaFileAsync === 'function'
    ? mediaTranscription.transcribeMediaFileAsync.bind(mediaTranscription)
    : async (...args) => mediaTranscription.transcribeMediaFile(...args);

  const startedAt = Date.now();
  const transcriptSections = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const elapsed = Date.now() - startedAt;
    const remaining = totalBudgetMs - elapsed;
    const current = candidates[index];
    if (!current) continue;
    if (remaining < 400) {
      base.warnings.push(`媒体转写跳过: 预算已用尽（${index}/${candidates.length}）`);
      break;
    }
    if (onStatus) {
      try {
        onStatus({
          phase: 'request',
          message: `多模态转写: 正在处理 ${index + 1}/${candidates.length} ${current.kind} 文件 ${current.name}...`,
        });
      } catch { /* best effort */ }
    }
    const boundedTimeout = Math.max(800, Math.min(perFileTimeoutMs, remaining));
    const tr = await _withTimeout(
      transcribeFn(current.path, current.mimeType, {
        language: transcribeLanguage,
        timeoutMs: boundedTimeout,
      }),
      boundedTimeout + 300
    );
    if (tr && tr.success && tr.text) {
      transcriptSections.push({
        kind: current.kind,
        name: current.name,
        mimeType: current.mimeType || 'application/octet-stream',
        engine: tr.engine || '',
        text: _sliceTranscript(tr.text, TRANSCRIBE_MAX_CHARS),
      });
    } else if (tr && tr.error) {
      base.warnings.push(`媒体转写失败: ${current.name} (${tr.error})`);
    }
  }

  if (transcriptSections.length > 0) {
    base.promptAugment = _appendTranscriptSections(base.promptAugment, transcriptSections);
  }
  return base;
}

module.exports = {
  EXT_MIME_MAP,
  detectInlineMediaPaths,
  suggestAdaptersForMediaKinds,
  prepareMultimodalInput,
  prepareMultimodalInputAsync,
  _formatBytes, // exported for ccFormat file-size SSOT routing test
};
