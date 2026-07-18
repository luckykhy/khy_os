/**
 * safeJsonParse — 3-layer JSON repair utility.
 *
 * Layer 1: Standard JSON.parse
 * Layer 2: Attempt common repairs (trailing commas, unclosed brackets/strings, unquoted keys)
 * Layer 3: Return fallback value
 *
 * Zero external dependencies — all repair logic is hand-rolled.
 */
'use strict';

/**
 * Parse a JSON string with progressive repair strategies.
 *
 * @param {string}  str       — raw JSON string (may be malformed)
 * @param {*}       fallback  — value to return if all parsing attempts fail
 * @returns {*}     Parsed object or fallback
 */
function safeJsonParse(str, fallback = {}) {
  if (!str || typeof str !== 'string') return fallback;

  const trimmed = str.trim();
  if (!trimmed) return fallback;

  // ── Layer 1: Standard parse ──────────────────────────────────────────
  try {
    return JSON.parse(trimmed);
  } catch { /* proceed to repair */ }

  // ── Layer 2: Repair and retry ────────────────────────────────────────
  let repaired = trimmed;

  // 2a: Strip trailing commas before closing brackets  ,} or ,]
  //     Also strip dangling trailing commas at end of string
  repaired = repaired.replace(/,\s*([\]}])/g, '$1');
  repaired = repaired.replace(/,\s*$/, '');

  try {
    return JSON.parse(repaired);
  } catch { /* continue */ }

  // 2b: Close unclosed strings — if odd number of unescaped quotes, append one
  const unescapedQuotes = (repaired.match(/(?<!\\)"/g) || []).length;
  if (unescapedQuotes % 2 !== 0) {
    const withQuote = repaired + '"';
    // Also try closing brackets after quote
    try {
      return JSON.parse(withQuote);
    } catch { /* continue */ }

    // Try closing brackets after the quote
    const bracketClosed = _closeBrackets(withQuote);
    if (bracketClosed !== withQuote) {
      try {
        return JSON.parse(bracketClosed);
      } catch { /* continue */ }
    }
  }

  // 2c: Close unclosed brackets/braces
  const bracketClosed = _closeBrackets(repaired);
  if (bracketClosed !== repaired) {
    try {
      return JSON.parse(bracketClosed);
    } catch { /* continue */ }
  }

  // 2d: Quote unquoted keys — {key: "val"} → {"key": "val"}
  const requoted = repaired.replace(
    /([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g,
    '$1"$2":'
  );
  if (requoted !== repaired) {
    // Apply bracket closure on requoted version too
    const requotedClosed = _closeBrackets(requoted);
    try {
      return JSON.parse(requotedClosed);
    } catch { /* continue */ }
  }

  // 2e: Combined — all repairs at once
  let combined = repaired;
  combined = combined.replace(/,\s*([\]}])/g, '$1');
  combined = combined.replace(/,\s*$/, '');
  combined = combined.replace(
    /([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g,
    '$1"$2":'
  );
  const combinedQuotes = (combined.match(/(?<!\\)"/g) || []).length;
  if (combinedQuotes % 2 !== 0) combined += '"';
  combined = _closeBrackets(combined);
  try {
    return JSON.parse(combined);
  } catch { /* final fallback */ }

  // ── Layer 3: Return fallback ─────────────────────────────────────────
  return fallback;
}

/**
 * Append missing closing brackets/braces.
 *
 * Walks the string tracking nesting depth (respecting strings and escapes).
 * Returns the original string with the necessary }/] appended.
 *
 * @param {string} str
 * @returns {string}
 */
function _closeBrackets(str) {
  const stack = []; // tracks opening brackets in order
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }

  if (stack.length === 0) return str;

  // Close in reverse order
  return str + stack.reverse().join('');
}

/**
 * Extract the first balanced JSON value (object or array) embedded in text
 * that may contain surrounding prose or markdown code fences, then parse it
 * through safeJsonParse's repair pipeline.
 *
 * This is the structured-output recovery path: when a model is asked for JSON
 * but wraps it in explanation or ```json fences, callers should consume the
 * machine-readable value via this helper instead of regex-scraping prose.
 *
 * @param {string} text      — raw text possibly containing a JSON value
 * @param {*}       fallback — value returned when no JSON value can be recovered
 * @returns {*}     Parsed object/array, or fallback
 */
function extractFirstJson(text, fallback = null) {
  if (!text || typeof text !== 'string') return fallback;

  // Strip a leading ```json / ``` fence and its closing fence, if present.
  let body = text.trim();
  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1].trim()) {
    const fenced = safeJsonParse(fenceMatch[1].trim(), undefined);
    if (fenced !== undefined) return fenced;
    body = fenceMatch[1].trim(); // fall through to balanced scan on the fenced body
  }

  // Locate the first JSON opener, then scan for its balanced close, respecting
  // string literals and escapes so braces inside strings don't mislead us.
  const openIdx = (() => {
    const obj = body.indexOf('{');
    const arr = body.indexOf('[');
    if (obj < 0) return arr;
    if (arr < 0) return obj;
    return Math.min(obj, arr);
  })();
  if (openIdx < 0) return fallback;

  const opener = body[openIdx];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0, inString = false, escaped = false;

  for (let i = openIdx; i < body.length; i++) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        return safeJsonParse(body.slice(openIdx, i + 1), fallback);
      }
    }
  }

  // Unbalanced (e.g. truncated output) — hand the tail to safeJsonParse, whose
  // bracket-closing repair can often still recover it.
  return safeJsonParse(body.slice(openIdx), fallback);
}

module.exports = { safeJsonParse, extractFirstJson };
