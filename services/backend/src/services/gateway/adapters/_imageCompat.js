/**
 * Unified image normalization helpers for gateway adapters.
 *
 * Input accepted:
 * - string URL / data URL / raw base64
 * - { base64, mimeType }
 * - { url }
 * - { data } where data can be data URL or base64
 * - OpenAI-like { image_url: { url } }
 * - Anthropic-like { source: { data, media_type } }
 */

const DATA_URL_RE = /^data:([^;,]+)?;base64,([a-z0-9+/=\r\n]+)$/i;
const HTTP_OR_FILE_URL_RE = /^(https?:\/\/|file:\/\/)/i;
const BASE64_RE = /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i;

function _cleanBase64(value = '') {
  return String(value || '').replace(/\s+/g, '').trim();
}

// Canonicalize non-standard image MIME labels to the IANA form that strict
// vision APIs (Anthropic / Google) require. `jpg` and `jpeg` are the SAME
// format — only the label differs — so this is a relabel, never a transcode.
// Applied once at normalization so every adapter emits an accepted media_type.
const _MIME_ALIASES = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/svg': 'image/svg+xml',
  'image/x-ms-bmp': 'image/bmp',
  'image/x-tiff': 'image/tiff',
};
function canonicalMime(mime) {
  const m = String(mime || '').trim().toLowerCase();
  if (!m) return 'image/png';
  return _MIME_ALIASES[m] || m;
}

function _parseDataUrl(raw = '') {
  const text = String(raw || '').trim();
  const matched = text.match(DATA_URL_RE);
  if (!matched) return null;
  const mimeType = canonicalMime(matched[1]);
  const base64 = _cleanBase64(matched[2] || '');
  if (!base64) return null;
  return { mimeType, base64, dataUrl: `data:${mimeType};base64,${base64}` };
}

function _looksLikeBase64(raw = '', minLen = 64) {
  const text = _cleanBase64(raw);
  if (!text || text.length < minLen) return false;
  return BASE64_RE.test(text);
}

// normalizeImageItem / normalizeDocItem are the boundary that coerces UNTRUSTED
// image/document items (from request payloads, provider structures, internal
// callers) into a canonical shape, and their documented contract is "return null
// for anything we can't handle". A field that is a non-string object with a
// hostile/throwing `toString` (or a Symbol) makes an internal `String(...)`
// coercion throw, which would otherwise propagate out of this normalization
// boundary. Wrap the impls so the boundary NEVER throws — an un-coercible item is
// simply unusable (null). Byte-identical for every input that doesn't throw
// (i.e. all real string/URL/base64 items).
function normalizeImageItem(item) {
  try {
    return _normalizeImageItemImpl(item);
  } catch {
    return null;
  }
}

function _normalizeImageItemImpl(item) {
  if (!item) return null;

  if (typeof item === 'string') {
    const text = item.trim();
    if (!text) return null;

    const dataUrlParsed = _parseDataUrl(text);
    if (dataUrlParsed) return { ...dataUrlParsed };

    if (HTTP_OR_FILE_URL_RE.test(text)) return { url: text };

    if (_looksLikeBase64(text, 64)) {
      const base64 = _cleanBase64(text);
      const mimeType = 'image/png';
      return { base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}` };
    }

    return null;
  }

  if (typeof item !== 'object') return null;

  const imageUrlObj = item.image_url;
  const objectUrl = (
    item.url
    || item.imageUrl
    || item.dataUrl
    || (typeof imageUrlObj === 'string' ? imageUrlObj : '')
    || (imageUrlObj && typeof imageUrlObj.url === 'string' ? imageUrlObj.url : '')
  );
  if (objectUrl) {
    const dataUrlParsed = _parseDataUrl(objectUrl);
    if (dataUrlParsed) return { ...dataUrlParsed };
    if (HTTP_OR_FILE_URL_RE.test(String(objectUrl).trim())) return { url: String(objectUrl).trim() };
  }

  const sourceObj = item.source && typeof item.source === 'object' ? item.source : null;
  let mimeType = (
    item.mimeType
    || item.mediaType
    || item.media_type
    || (sourceObj ? (sourceObj.media_type || sourceObj.mediaType) : '')
    || 'image/png'
  );
  mimeType = canonicalMime(mimeType);

  const base64Candidate = (
    item.base64
    || item.data
    || (sourceObj ? sourceObj.data : '')
    || ''
  );
  if (base64Candidate) {
    const parsedFromDataField = _parseDataUrl(base64Candidate);
    if (parsedFromDataField) return { ...parsedFromDataField };
    const base64 = _cleanBase64(base64Candidate);
    if (_looksLikeBase64(base64, 1)) {
      return { base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}` };
    }
  }

  return null;
}

function normalizeImages(images = []) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const out = [];
  for (const item of images) {
    const normalized = normalizeImageItem(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function toCodexInputImages(images = []) {
  const normalized = normalizeImages(images);
  return normalized
    .map((img) => {
      const imageUrl = img.url || img.dataUrl || '';
      if (!imageUrl) return null;
      return { type: 'input_image', image_url: imageUrl };
    })
    .filter(Boolean);
}

function toAnthropicImageBlocks(images = []) {
  const normalized = normalizeImages(images);
  return normalized
    .map((img) => {
      if (!img.base64) return null;
      const mimeType = img.mimeType || 'image/png';
      return {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: img.base64 },
      };
    })
    .filter(Boolean);
}

/**
 * Normalize a single document item for native Anthropic `document` blocks.
 *
 * Accepts:
 *  - { base64, mimeType }                  → base64 source (e.g. application/pdf)
 *  - { data } as data URL or raw base64    → base64 source
 *  - { url } / string http(s) URL          → url source
 *  - { text } / { source:{type:'text'} }   → plain-text document source
 *  - string data URL / raw base64          → base64 source
 *
 * Returns `{ kind:'base64'|'url'|'text', mimeType, data?, url?, text?, title? }`
 * or null when nothing usable is present.
 */
function normalizeDocItem(item) {
  if (!item) return null;

  if (typeof item === 'string') {
    const text = item.trim();
    if (!text) return null;
    const parsed = _parseDataUrl(text);
    if (parsed) return { kind: 'base64', mimeType: parsed.mimeType, data: parsed.base64 };
    if (HTTP_OR_FILE_URL_RE.test(text)) return { kind: 'url', url: text };
    if (_looksLikeBase64(text, 64)) {
      return { kind: 'base64', mimeType: 'application/pdf', data: _cleanBase64(text) };
    }
    return null;
  }

  if (typeof item !== 'object') return null;

  const title = item.name || item.title || undefined;
  const sourceObj = item.source && typeof item.source === 'object' ? item.source : null;

  // Explicit plain-text document.
  const textCandidate = (
    item.text
    || (sourceObj && sourceObj.type === 'text' ? (sourceObj.data || sourceObj.text) : '')
    || ''
  );
  if (textCandidate && typeof textCandidate === 'string') {
    return { kind: 'text', mimeType: 'text/plain', text: String(textCandidate), title };
  }

  // URL source.
  const url = item.url || item.dataUrl || (sourceObj && sourceObj.type === 'url' ? sourceObj.url : '');
  if (url && typeof url === 'string') {
    const parsed = _parseDataUrl(url);
    if (parsed) return { kind: 'base64', mimeType: parsed.mimeType, data: parsed.base64, title };
    if (HTTP_OR_FILE_URL_RE.test(url.trim())) return { kind: 'url', url: url.trim(), title };
  }

  // Base64 source.
  let mimeType = String(
    item.mimeType || item.mediaType || item.media_type
    || (sourceObj ? (sourceObj.media_type || sourceObj.mediaType) : '')
    || 'application/pdf'
  ).trim() || 'application/pdf';
  const base64Candidate = item.base64 || item.data || (sourceObj ? sourceObj.data : '') || '';
  if (base64Candidate && typeof base64Candidate === 'string') {
    const parsed = _parseDataUrl(base64Candidate);
    if (parsed) return { kind: 'base64', mimeType: parsed.mimeType, data: parsed.base64, title };
    const base64 = _cleanBase64(base64Candidate);
    if (_looksLikeBase64(base64, 1)) return { kind: 'base64', mimeType, data: base64, title };
  }

  return null;
}

/**
 * Convert document items to native Anthropic `document` content blocks.
 * Used by the Claude adapter to give vision-capable models (Opus 4.x) the raw
 * PDF/text for full-fidelity reading, alongside any text-extraction fallback.
 * @param {object[]|string[]} documents
 * @returns {object[]} Anthropic document blocks
 */
function toAnthropicDocumentBlocks(documents = []) {
  if (!Array.isArray(documents) || documents.length === 0) return [];
  const out = [];
  for (const item of documents) {
    const doc = normalizeDocItem(item);
    if (!doc) continue;
    let source = null;
    if (doc.kind === 'base64' && doc.data) {
      source = { type: 'base64', media_type: doc.mimeType || 'application/pdf', data: doc.data };
    } else if (doc.kind === 'url' && doc.url) {
      source = { type: 'url', url: doc.url };
    } else if (doc.kind === 'text' && doc.text) {
      source = { type: 'text', media_type: 'text/plain', data: doc.text };
    }
    if (!source) continue;
    const block = { type: 'document', source };
    if (doc.title) block.title = String(doc.title).slice(0, 200);
    // Enable Anthropic citations so the model can cite exact source spans
    // (PDF pages / text ranges). Env kill-switch, default on.
    if (process.env.KHY_DOC_CITATIONS !== '0') {
      block.citations = { enabled: true };
    }
    out.push(block);
  }
  return out;
}

function toOllamaBase64Images(images = []) {
  const normalized = normalizeImages(images);
  return normalized
    .map(img => img.base64 || '')
    .filter(Boolean);
}

/**
 * Convert normalized images to OpenAI vision content blocks.
 * Works for OpenAI, 智谱 (glm-4v), and any OpenAI-compatible provider.
 * @param {object[]} images - Raw or already normalized
 * @returns {{ type: 'image_url', image_url: { url: string, detail: string } }[]}
 */
function toOpenAIVisionBlocks(images = []) {
  const normalized = normalizeImages(images);
  return normalized
    .map((img) => {
      const url = img.dataUrl || img.url || '';
      if (!url) return null;
      return { type: 'image_url', image_url: { url, detail: 'auto' } };
    })
    .filter(Boolean);
}

/**
 * Convert normalized images to Google Gemini inline data format.
 * @param {object[]} images - Raw or already normalized
 * @returns {{ inlineData: { mimeType: string, data: string } }[]}
 */
function toGoogleInlineData(images = []) {
  const normalized = normalizeImages(images);
  return normalized
    .map((img) => {
      if (!img.base64) return null;
      return { inlineData: { mimeType: img.mimeType || 'image/png', data: img.base64 } };
    })
    .filter(Boolean);
}

function attachImagesToOpenAIMessages(messages = [], images = []) {
  const imageBlocks = toOpenAIVisionBlocks(images);
  if (imageBlocks.length === 0) return messages;
  const next = Array.isArray(messages)
    ? messages.map((msg) => (msg && typeof msg === 'object' ? { ...msg } : msg))
    : [];

  let userIndex = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (String(next[i]?.role || '').toLowerCase() === 'user') {
      userIndex = i;
      break;
    }
  }

  if (userIndex < 0) {
    next.push({
      role: 'user',
      content: [{ type: 'text', text: 'Please analyze the attached image(s).' }, ...imageBlocks],
    });
    return next;
  }

  const target = next[userIndex] || { role: 'user', content: '' };
  if (typeof target.content === 'string') {
    target.content = [{ type: 'text', text: target.content || '' }, ...imageBlocks];
  } else if (Array.isArray(target.content)) {
    target.content = [...target.content, ...imageBlocks];
  } else {
    target.content = [{ type: 'text', text: String(target.content || '') }, ...imageBlocks];
  }
  next[userIndex] = target;
  return next;
}

module.exports = {
  canonicalMime,
  normalizeImageItem,
  normalizeImages,
  normalizeDocItem,
  toAnthropicDocumentBlocks,
  toCodexInputImages,
  toAnthropicImageBlocks,
  toOllamaBase64Images,
  toOpenAIVisionBlocks,
  toGoogleInlineData,
  attachImagesToOpenAIMessages,
};
