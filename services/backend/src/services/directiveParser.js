'use strict';

/**
 * directiveParser.js — Inline directive tag parsing with code block masking.
 *
 * Ported from OpenClaw's directive-tags.ts.
 * Safely strips inline directives ([[audio_as_voice]], [[reply_to: ID]])
 * from message text WITHOUT touching directives inside code blocks.
 *
 * Core technique: "sentinel masking" — replaces fenced code blocks with
 * unique Unicode placeholders before directive regex runs, then restores them.
 * This prevents false-positive stripping of directives in code examples.
 */

// Private Use Area char — guaranteed not to appear in normal text
const BLOCK_SENTINEL_SEED = '\uE000';
const MAX_REPLY_ID_LENGTH = 256;

// Sentinel construction guard (KHY_DIRECTIVE_SENTINEL_LINEAR, default on).
// `_createSentinel` originally grew the sentinel one seed char at a time and
// rescanned the ENTIRE text (`text.includes`) on every iteration. When the raw
// user message contains a run of k consecutive seed chars (U+E000 — trivially
// present in garbled / crafted-unicode paste), the loop runs k times and each
// rescan is O(len) -> O(n^2): a ~200 KB paste of U+E000 freezes the turn ~32 s.
// The dispatch (`extractDirectives`/`stripDirectives` on the raw userMessage,
// cli/ai.js:5052) wraps this in try/catch, but a hang never throws, so the
// guard is useless — this is a real, user-reachable DoS.
//
// The terminating sentinel is provably `SEED * (longestRun + 1)` where
// longestRun is the longest run of consecutive seed chars in the text, so a
// single linear pass yields the byte-identical sentinel without the rescan.
// Off -> legacy grow-and-rescan loop (identical output, quadratic).
const _SENTINEL_LINEAR_OFF = ['0', 'false', 'off', 'no'];
function _sentinelLinearEnabled() {
  return !_SENTINEL_LINEAR_OFF.includes(
    String((process.env && process.env.KHY_DIRECTIVE_SENTINEL_LINEAR) || '').trim().toLowerCase());
}

// Directive regex patterns
const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const ALL_DIRECTIVES_RE = /\s*(?:\[\[\s*audio_as_voice\s*\]\]|\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\])\s*/gi;

// Fenced code block pattern (triple backticks/tildes + indented blocks)
const CODE_BLOCK_RE = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\n]*|(?:(?:^|\n)(?:    |\t)[^\n]*)+/gm;

/**
 * Create a sentinel string guaranteed not to appear in the input text.
 */
function _createSentinel(text) {
  if (!_sentinelLinearEnabled()) {
    // Legacy grow-and-rescan (O(n^2) on a run of seed chars).
    let sentinel = BLOCK_SENTINEL_SEED;
    while (text.includes(sentinel)) {
      sentinel += BLOCK_SENTINEL_SEED;
    }
    return sentinel;
  }
  // Linear: the loop above terminates at the smallest sentinel length k for
  // which `text` contains no run of k consecutive seed chars, i.e.
  // k = (longest run of seed chars in text) + 1. Compute that run in one pass
  // — the resulting sentinel is byte-identical to the legacy loop's output.
  const seed = BLOCK_SENTINEL_SEED;
  let longestRun = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === seed) {
      run += 1;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }
  return seed.repeat(longestRun + 1);
}

/**
 * Strip unsafe characters from a reply directive ID.
 * Removes control chars, brackets to prevent injection.
 *
 * @param {string} rawId
 * @returns {string|undefined}
 */
function sanitizeReplyId(rawId) {
  const trimmed = rawId?.trim();
  if (!trimmed) return undefined;

  let result = '';
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    // Skip control chars (0-31, 127) and brackets
    if ((code >= 0 && code <= 31) || code === 127 || ch === '[' || ch === ']') continue;
    result += ch;
  }

  const cleaned = result.trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_REPLY_ID_LENGTH ? cleaned.slice(0, MAX_REPLY_ID_LENGTH) : cleaned;
}

/**
 * Extract all directives from text without modifying it.
 *
 * @param {string} text
 * @returns {{ audioAsVoice: boolean, replyTo: string|null, replyToCurrent: boolean }}
 */
function extractDirectives(text) {
  if (!text || typeof text !== 'string') {
    return { audioAsVoice: false, replyTo: null, replyToCurrent: false };
  }

  // Mask code blocks first
  const { masked, blocks, sentinel } = _maskCodeBlocks(text);

  const audioAsVoice = AUDIO_TAG_RE.test(masked);
  AUDIO_TAG_RE.lastIndex = 0;

  let replyTo = null;
  let replyToCurrent = false;
  REPLY_TAG_RE.lastIndex = 0;
  const replyMatch = REPLY_TAG_RE.exec(masked);
  if (replyMatch) {
    if (replyMatch[1]) {
      replyTo = sanitizeReplyId(replyMatch[1]);
    } else {
      replyToCurrent = true;
    }
  }

  return { audioAsVoice, replyTo, replyToCurrent };
}

/**
 * Strip all directive tags from text, preserving code blocks.
 * Maintains word boundaries at removal points.
 *
 * @param {string} text
 * @returns {string}
 */
function stripDirectives(text) {
  if (!text || typeof text !== 'string') return text || '';

  const { masked, blocks, sentinel } = _maskCodeBlocks(text);

  // Strip directives from masked text
  ALL_DIRECTIVES_RE.lastIndex = 0;
  let stripped = masked.replace(ALL_DIRECTIVES_RE, (match, offset) => {
    // Preserve word boundaries
    const before = masked[offset - 1];
    const after = masked[offset + match.length];
    if (before && after && !/\s/.test(before) && !/\s/.test(after)) {
      return ' ';
    }
    return '';
  });

  // Restore code blocks
  if (blocks.length > 0) {
    const placeholderRe = new RegExp(`${_escapeRegex(sentinel)}(\\d+)${_escapeRegex(sentinel)}`, 'g');
    stripped = stripped.replace(placeholderRe, (_, idx) => blocks[Number(idx)] || '');
  }

  return stripped.trim();
}

/**
 * Normalize whitespace in text while preserving code blocks.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeWhitespace(text) {
  if (!text) return '';

  const { masked, blocks, sentinel } = _maskCodeBlocks(text);

  let normalized = masked
    .replace(/\r\n/g, '\n')
    .replace(/([^\s])[ \t]{2,}([^\s])/g, '$1 $2')
    .replace(/^\n+/, '')
    .replace(/^[ \t](?=\S)/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  // Restore code blocks
  if (blocks.length > 0) {
    const placeholderRe = new RegExp(`${_escapeRegex(sentinel)}(\\d+)${_escapeRegex(sentinel)}`, 'g');
    normalized = normalized.replace(placeholderRe, (_, idx) => blocks[Number(idx)] || '');
  }

  return normalized;
}

// ── Internal ─────────────────────────────────────────────────────

/**
 * Mask code blocks with sentinel placeholders.
 */
function _maskCodeBlocks(text) {
  const sentinel = _createSentinel(text);
  const blocks = [];

  const masked = text.replace(CODE_BLOCK_RE, (block) => {
    blocks.push(block);
    return `${sentinel}${blocks.length - 1}${sentinel}`;
  });

  return { masked, blocks, sentinel };
}

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  extractDirectives,
  stripDirectives,
  normalizeWhitespace,
  sanitizeReplyId,
  AUDIO_TAG_RE,
  REPLY_TAG_RE,
  MAX_REPLY_ID_LENGTH,
  _createSentinel,
  _sentinelLinearEnabled,
};
