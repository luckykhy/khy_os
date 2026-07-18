/**
 * TOON Codec — Token-Optimized Object Notation.
 *
 * Aligned with ANOLISA Tokenless TOON compression:
 * - Converts JSON to compact text representation (15-44% savings)
 * - Eliminates syntax overhead: quotes, braces, brackets, commas
 * - Preserves semantic meaning with indentation-based structure
 * - Lossless: can be decoded back to JSON
 *
 * Example:
 *   Input:  {"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}
 *   Output:
 *     users:
 *       - id: 1
 *         name: Alice
 *       - id: 2
 *         name: Bob
 *
 * Cross-platform: pure JavaScript, no dependencies.
 */

'use strict';

const INDENT = '  ';

// Decode recursion depth cap (KHY_TOON_DEPTH_CAP, default on).
//
// `_parseLines` recurses once per `key:`-ending line at increasing indent
// (line ~275) with NO depth bound, whereas the encode path IS capped
// (`_encodeValue`: `if (depth > opts.maxDepth) …`). That asymmetry is a latent
// footgun: a TOON document nested ~5000 levels deep overflows the JS stack
// (`RangeError: Maximum call stack size exceeded`).
//
// Honest reachability: `toonDecode` is an *exported* API (tokenless/index.js)
// but no internal caller currently wires it to untrusted (user/model) input, so
// this is NOT user-reachable and NOT model-reachable today — it is symmetric
// hardening of an exported codec to match encode's existing guard. The cap
// (2048) sits far above any legitimate nesting yet well below the stack limit;
// on overflow the branch returns the same `null` that encode's `<truncated>`
// marker already decodes to, so output is byte-identical for every non-
// pathological document. Off → legacy uncapped recursion (identical output,
// but overflows on adversarial nesting — the load-bearing difference).
const _TOON_DEPTH_OFF = ['0', 'false', 'off', 'no'];
const _TOON_MAX_DECODE_DEPTH = 2048;
function _toonDepthCapEnabled() {
  return !_TOON_DEPTH_OFF.includes(
    String((process.env && process.env.KHY_TOON_DEPTH_CAP) || '').trim().toLowerCase());
}

// ─── JSON → TOON Encoding ───────────────────────────────────────────────────

/**
 * Encode a JSON value to TOON format.
 * @param {*} value - Any JSON-serializable value
 * @param {object} [options]
 * @param {number} [options.maxDepth=8] - Max nesting depth
 * @param {number} [options.maxArrayItems=50] - Max array items before truncation
 * @param {number} [options.maxStringLen=512] - Max string length before truncation
 * @returns {{ toon: string, stats: { originalChars: number, toonChars: number, savedPercent: number } }}
 */
function encode(value, options = {}) {
  const maxDepth = options.maxDepth || 8;
  const maxArrayItems = options.maxArrayItems || 50;
  const maxStringLen = options.maxStringLen || 512;

  const originalJson = JSON.stringify(value);
  const originalChars = originalJson ? originalJson.length : 0;

  const lines = [];
  _encodeValue(value, 0, lines, { maxDepth, maxArrayItems, maxStringLen });
  const toon = lines.join('\n');

  const toonChars = toon.length;
  const savedPercent = originalChars > 0 ? Math.round((1 - toonChars / originalChars) * 100) : 0;

  return {
    toon,
    stats: { originalChars, toonChars, savedPercent },
  };
}

function _encodeValue(value, depth, lines, opts) {
  if (depth > opts.maxDepth) {
    lines.push(_indent(depth) + '<truncated>');
    return;
  }

  if (value === null || value === undefined) {
    lines.push(_indent(depth) + 'null');
    return;
  }

  const type = typeof value;

  if (type === 'string') {
    const str = value.length > opts.maxStringLen
      ? value.slice(0, opts.maxStringLen) + '...'
      : value;
    // Multi-line strings use | block indicator
    if (str.includes('\n')) {
      lines.push(_indent(depth) + '|');
      for (const line of str.split('\n')) {
        lines.push(_indent(depth + 1) + line);
      }
    } else {
      lines.push(_indent(depth) + str);
    }
    return;
  }

  if (type === 'number' || type === 'boolean') {
    lines.push(_indent(depth) + String(value));
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(_indent(depth) + '[]');
      return;
    }

    // Check if array of simple values (flat array)
    const allSimple = value.every(v => v === null || typeof v !== 'object');
    if (allSimple && value.length <= 10) {
      // Inline flat array
      lines.push(_indent(depth) + '[' + value.map(v => _simpleValue(v)).join(', ') + ']');
      return;
    }

    // Array of objects: use - prefix (YAML-like)
    const items = value.length > opts.maxArrayItems
      ? value.slice(0, opts.maxArrayItems)
      : value;

    for (const item of items) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        // Object item: first key on same line as -
        const keys = Object.keys(item);
        if (keys.length === 0) {
          lines.push(_indent(depth) + '- {}');
        } else {
          const firstKey = keys[0];
          const firstVal = item[firstKey];
          if (_isSimple(firstVal)) {
            lines.push(_indent(depth) + '- ' + firstKey + ': ' + _simpleValue(firstVal));
          } else {
            lines.push(_indent(depth) + '- ' + firstKey + ':');
            _encodeValue(firstVal, depth + 2, lines, opts);
          }
          // Remaining keys
          for (let i = 1; i < keys.length; i++) {
            const key = keys[i];
            const val = item[key];
            if (_isSimple(val)) {
              lines.push(_indent(depth + 1) + key + ': ' + _simpleValue(val));
            } else {
              lines.push(_indent(depth + 1) + key + ':');
              _encodeValue(val, depth + 2, lines, opts);
            }
          }
        }
      } else {
        // Non-object item
        lines.push(_indent(depth) + '- ' + _simpleValue(item));
      }
    }

    if (value.length > opts.maxArrayItems) {
      lines.push(_indent(depth) + `<... ${value.length - opts.maxArrayItems} more items>`);
    }
    return;
  }

  // Object
  if (type === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      lines.push(_indent(depth) + '{}');
      return;
    }

    for (const key of keys) {
      const val = value[key];
      if (_isSimple(val)) {
        lines.push(_indent(depth) + key + ': ' + _simpleValue(val));
      } else {
        lines.push(_indent(depth) + key + ':');
        _encodeValue(val, depth + 1, lines, opts);
      }
    }
  }
}

// ─── TOON → JSON Decoding ───────────────────────────────────────────────────

/**
 * Decode TOON text back to a JavaScript value.
 * Best-effort parsing: handles common TOON patterns.
 * @param {string} toon - TOON formatted text
 * @returns {*} Decoded value
 */
function decode(toon) {
  if (!toon || typeof toon !== 'string') return null;

  const lines = toon.split('\n');
  const result = _parseLines(lines, 0, 0, 0);
  return result.value;
}

function _parseLines(lines, startIdx, baseIndent, depth = 0) {
  if (startIdx >= lines.length) return { value: null, nextIdx: startIdx };

  // Depth cap: stop recursing past the bound so an adversarially deep document
  // cannot overflow the stack. Mirrors encode's `<truncated>` (which decodes to
  // null), so byte-identical for any document within the bound.
  if (_toonDepthCapEnabled() && depth > _TOON_MAX_DECODE_DEPTH) {
    return { value: null, nextIdx: startIdx + 1 };
  }

  const firstLine = lines[startIdx];
  const trimmed = firstLine.trim();

  // Empty or truncation marker
  if (!trimmed || trimmed === '<truncated>') {
    return { value: null, nextIdx: startIdx + 1 };
  }

  // Inline array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return { value: JSON.parse(trimmed), nextIdx: startIdx + 1 };
    } catch {
      return { value: trimmed, nextIdx: startIdx + 1 };
    }
  }

  // Empty object/array
  if (trimmed === '{}') return { value: {}, nextIdx: startIdx + 1 };
  if (trimmed === '[]') return { value: [], nextIdx: startIdx + 1 };
  if (trimmed === 'null') return { value: null, nextIdx: startIdx + 1 };
  if (trimmed === 'true') return { value: true, nextIdx: startIdx + 1 };
  if (trimmed === 'false') return { value: false, nextIdx: startIdx + 1 };

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { value: Number(trimmed), nextIdx: startIdx + 1 };
  }

  // List items (array)
  if (trimmed.startsWith('- ')) {
    const arr = [];
    let idx = startIdx;
    while (idx < lines.length) {
      const line = lines[idx];
      const indent = _getIndent(line);
      if (indent < baseIndent && idx > startIdx) break;
      if (!line.trim().startsWith('- ') && indent <= baseIndent && idx > startIdx) break;

      if (line.trim().startsWith('- ')) {
        const content = line.trim().slice(2);
        if (content.includes(': ')) {
          // Object item
          const obj = {};
          const [key, ...valParts] = content.split(': ');
          obj[key] = _parseSimple(valParts.join(': '));
          idx++;
          // Read continuation lines at deeper indent
          const itemIndent = indent + 1;
          while (idx < lines.length) {
            const nextLine = lines[idx];
            const nextIndent = _getIndent(nextLine);
            if (nextIndent <= indent || !nextLine.trim()) break;
            const nextTrimmed = nextLine.trim();
            if (nextTrimmed.includes(': ')) {
              const [nKey, ...nVal] = nextTrimmed.split(': ');
              obj[nKey] = _parseSimple(nVal.join(': '));
            }
            idx++;
          }
          arr.push(obj);
        } else {
          arr.push(_parseSimple(content));
          idx++;
        }
      } else {
        idx++;
      }
    }
    return { value: arr, nextIdx: idx };
  }

  // Key-value (object)
  if (trimmed.includes(': ') || trimmed.endsWith(':')) {
    const obj = {};
    let idx = startIdx;
    while (idx < lines.length) {
      const line = lines[idx];
      const indent = _getIndent(line);
      if (indent < baseIndent && idx > startIdx) break;
      const lt = line.trim();
      if (!lt) { idx++; continue; }

      if (lt.endsWith(':')) {
        const key = lt.slice(0, -1);
        idx++;
        const childResult = _parseLines(lines, idx, indent + 1, depth + 1);
        obj[key] = childResult.value;
        idx = childResult.nextIdx;
      } else if (lt.includes(': ')) {
        const [key, ...valParts] = lt.split(': ');
        obj[key] = _parseSimple(valParts.join(': '));
        idx++;
      } else {
        break;
      }
    }
    return { value: obj, nextIdx: idx };
  }

  // Plain string
  return { value: trimmed, nextIdx: startIdx + 1 };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _isSimple(value) {
  return value === null || value === undefined ||
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function _simpleValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  return String(value);
}

function _indent(depth) {
  return INDENT.repeat(depth);
}

function _getIndent(line) {
  const match = line.match(/^(\s*)/);
  return match ? Math.floor(match[1].length / INDENT.length) : 0;
}

function _parseSimple(str) {
  if (!str) return null;
  const trimmed = str.trim();
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

module.exports = {
  encode,
  decode,
  _toonDepthCapEnabled,
  _TOON_MAX_DECODE_DEPTH,
};
