'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * _toolResultNormalizer.js — Normalize tool result field names.
 *
 * Tools use inconsistent field names for their primary text payload:
 *   content, output, data, result, message, answer, matches, files,
 *   items, edits, locations, diagnostics, resources, skills, symbols,
 *   actions, signatures, entries, counts, selected, hover, task...
 *
 * This normalizer adds a `content` field pointing to the primary text,
 * WITHOUT removing the original fields. Fully backward compatible.
 *
 * Phase 2B: Extended from 5 fields to 20+ fields.
 * Phase R2-4A: Large result persistence (>50K chars → temp file + preview).
 * Phase R2-4B: Empty result placeholder for non-error results.
 */

/**
 * Serialize a value into a string suitable for `content`.
 * Arrays → newline-separated, objects → JSON.
 * @param {*} value
 * @returns {string}
 */
function _serializeContent(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    // Array of strings → newline join; array of objects → JSON
    if (value.every(v => typeof v === 'string')) return value.join('\n');
    return JSON.stringify(value);
  }
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

// Priority-ordered list of known primary text payload fields.
// Earlier entries take precedence.
const _PRIMARY_TEXT_FIELDS = [
  'output', 'data', 'result', 'message', 'answer',
];

// Secondary structured data fields — tools that return arrays/objects
// under these names. Serialized to string for `content`.
const _STRUCTURED_FIELDS = [
  'matches', 'files', 'items', 'edits', 'locations',
  'diagnostics', 'resources', 'skills', 'symbols',
  'actions', 'signatures', 'entries', 'counts',
  'selected', 'hover', 'task', 'results',
];

// ── MCP CallToolResult normalization ─────────────────────────────
// MCP protocol returns: { content: Array<TextContent|ImageContent|EmbeddedResource>, isError?: boolean }
// KHY pipeline expects: { content: string, success: boolean, error?: string, _contentBlocks?: Array }

const _MCP_CONTENT_TYPES = new Set(['text', 'image', 'resource']);

/**
 * Detect if a raw result is an MCP CallToolResult.
 * Heuristic: content is an Array of typed objects, and `success` field is absent
 * (KHY internal results always set `success`).
 */
function _isMCPCallToolResult(raw) {
  if (!Array.isArray(raw.content) || raw.content.length === 0) return false;
  if (raw.success !== undefined) return false; // KHY internal result, not MCP
  const first = raw.content[0];
  return first && typeof first === 'object' && _MCP_CONTENT_TYPES.has(first.type);
}

/**
 * Convert MCP CallToolResult into KHY's internal format.
 * - Extracts text → `content` (string)
 * - Extracts images → `_contentBlocks` (Anthropic format)
 * - Maps `isError` → `success` / `error`
 */
function _normalizeMCPResult(raw) {
  const textParts = [];
  const contentBlocks = [];
  let hasImages = false;

  for (const item of raw.content) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
      contentBlocks.push({ type: 'text', text: item.text });
    } else if (item.type === 'image') {
      // MCP: { type:"image", data: base64, mimeType: "image/png" }
      // Anthropic: { type:"image", source: { type:"base64", media_type, data } }
      const mime = item.mimeType || 'image/png';
      const data = item.data || '';
      textParts.push(`[Image: ${mime}]`);
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data },
      });
      hasImages = true;
    } else if (item.type === 'resource') {
      // MCP EmbeddedResource
      const uri = item.resource?.uri || '';
      const text = item.resource?.text || '';
      const blob = item.resource?.blob || '';
      const mime = item.resource?.mimeType || 'application/octet-stream';
      if (text) {
        textParts.push(text);
        contentBlocks.push({ type: 'text', text: `[Resource: ${uri}]\n${text}` });
      } else if (blob && mime.startsWith('image/')) {
        textParts.push(`[Resource: ${uri}]`);
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mime, data: blob },
        });
        hasImages = true;
      } else {
        textParts.push(`[Resource: ${uri}]`);
        contentBlocks.push({ type: 'text', text: `[Resource: ${uri}, ${mime}]` });
      }
    }
  }

  const contentText = textParts.join('\n') || '(MCP tool completed with no output)';
  const isError = !!raw.isError;

  const result = {
    ...raw,
    success: !isError,
    content: contentText,
  };

  // Preserve structured blocks when there are images (for Anthropic adapter path)
  if (hasImages && contentBlocks.length > 0) {
    result._contentBlocks = contentBlocks;
  }

  if (isError) {
    result.error = contentText;
  }

  return result;
}

/**
 * Normalize a tool result to always include a `content` field.
 *
 * @param {*} raw - Raw tool result
 * @returns {*} Result with `content` field added (if not already present)
 */
function normalizeToolResult(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (Array.isArray(raw)) return raw;

  // Image results → generate Anthropic image content block for structured pass-through.
  // Must run BEFORE the content check so image tools get _contentBlocks even if they set content.
  if (raw.type === 'image' && raw.base64 && raw.mimeType) {
    if (raw.content === undefined) {
      raw.content = `[Image: ${raw.file || raw.format || 'image'}]`;
    }
    raw._contentBlocks = [{
      type: 'image',
      source: { type: 'base64', media_type: raw.mimeType, data: raw.base64 },
    }];
    return raw;
  }

  // MCP CallToolResult: { content: [{type:"text", text:...}, ...], isError?: boolean }
  // Must run BEFORE the generic "already has content" early return, because MCP
  // returns content as an Array (not string), which downstream would JSON.stringify.
  if (_isMCPCallToolResult(raw)) {
    return _normalizeMCPResult(raw);
  }

  // Already has content — nothing to do
  if (raw.content !== undefined) return raw;

  // Priority 1: well-known text output fields
  for (const field of _PRIMARY_TEXT_FIELDS) {
    if (raw[field] != null && raw[field] !== '') {
      return { ...raw, content: _serializeContent(raw[field]) };
    }
  }

  // Priority 2: structured data fields (arrays/objects)
  for (const field of _STRUCTURED_FIELDS) {
    if (raw[field] != null && raw[field] !== '') {
      return { ...raw, content: _serializeContent(raw[field]) };
    }
  }

  // Priority 3: path-only results (e.g. writeFile)
  if (raw.path && raw.success) {
    return { ...raw, content: `OK: ${raw.path}` };
  }

  // Priority 4: error results — use error field for content
  if (raw.error) {
    const errText = typeof raw.error === 'string'
      ? raw.error
      : (raw.error.message || JSON.stringify(raw.error));
    return { ...raw, content: errText };
  }

  // Priority 5: fallback — collect all non-meta fields
  const payload = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'success' || k === 'error' || k.startsWith('_')) continue;
    if (v != null && v !== '' && v !== false) payload[k] = v;
  }
  if (Object.keys(payload).length > 0) {
    return { ...raw, content: JSON.stringify(payload) };
  }

  return raw;
}

// ── Phase R2-4A: Large result persistence ─────────────────────

const DEFAULT_PERSIST_THRESHOLD = 50000; // 50K chars

/**
 * Persist large tool results to a temp file and replace content with
 * a preview + file path hint. Learned from CC's maybePersistLargeToolResult
 * and OC's truncation-to-file delegate pattern.
 *
 * @param {object} result - Normalized tool result (must have `content`)
 * @param {string} [toolName='tool'] - Tool name for context
 * @param {object} [opts]
 * @param {number} [opts.maxChars=50000] - Threshold for persistence
 * @returns {object} Same result, potentially with truncated content + _persistedPath
 */
function maybePersistLargeResult(result, toolName = 'tool', { maxChars = DEFAULT_PERSIST_THRESHOLD } = {}) {
  if (!result || typeof result !== 'object') return result;
  const content = result.content;
  if (typeof content !== 'string' || content.length <= maxChars) return result;

  try {
    const tmpDir = path.join(os.tmpdir(), 'khy-tool-results');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${toolName}-${Date.now()}.txt`);
    fs.writeFileSync(tmpPath, content, 'utf-8');

    const previewFront = content.slice(0, 2000);
    const previewBack = content.slice(-1000);
    const omitted = content.length - 3000;
    result.content = previewFront
      + `\n\n... [${omitted} chars truncated] ...\n\n`
      + previewBack
      + `\n\nFull output saved to: ${tmpPath}`
      + '\nUse Read tool with offset/limit to process this file.';
    result._persistedPath = tmpPath;
  } catch { /* persistence failure is non-critical — return original */ }
  return result;
}

// ── Phase R2-4B: Empty result placeholder ─────────────────────

/**
 * Ensure non-error results with empty content get a standard placeholder.
 * Prevents model confusion when a tool succeeds but produces no output.
 * Learned from CC's `(toolName completed with no output)` pattern.
 *
 * @param {object} result - Tool result
 * @param {string} [toolName='tool'] - Tool name
 * @returns {object} Same result with content guaranteed non-empty for successes
 */
function ensureNonEmptyContent(result, toolName = 'tool') {
  if (!result || typeof result !== 'object') return result;
  if (result.success === false) return result; // errors keep their own content
  if (!result.content && result.content !== 0) {
    result.content = `(${toolName} completed with no output)`;
  }
  return result;
}

module.exports = {
  normalizeToolResult,
  maybePersistLargeResult,
  ensureNonEmptyContent,
  // Exposed for downstream safety checks
  _isMCPCallToolResult,
};
