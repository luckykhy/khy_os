/**
 * TOON Codec — decode half (TOON text → JSON).
 *
 * Pure functions, zero dependencies. Split verbatim from toonCodec.js so the
 * whole `account/tokenless` directory stays ≤400 lines (M1 managed discipline).
 * The public surface is re-assembled by the toonCodec.js host, byte-for-
 * identical: `decode` / `_toonDepthCapEnabled` / `_TOON_MAX_DECODE_DEPTH` here
 * are the exact same references the host re-exports.
 */

'use strict';

const INDENT = '  ';

// Decode recursion depth cap (KHY_TOON_DEPTH_CAP, default on).
//
// `_parseLines` recurses once per `key:`-ending line at increasing indent
// with NO depth bound, whereas the encode path IS capped
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
    String((process.env && process.env.KHY_TOON_DEPTH_CAP) || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * Decode TOON text back to a JavaScript value.
 * Best-effort parsing: handles common TOON patterns.
 * @param {string} toon - TOON formatted text
 * @returns {*} Decoded value
 */
function decode(toon) {
  if (!toon || typeof toon !== 'string') {
    return null;
  }

  const lines = toon.split('\n');
  const result = _parseLines(lines, 0, 0, 0);
  return result.value;
}

function _parseLines(lines, startIdx, baseIndent, depth = 0) {
  if (startIdx >= lines.length) {
    return { value: null, nextIdx: startIdx };
  }

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
  if (trimmed === '{}') {
    return { value: {}, nextIdx: startIdx + 1 };
  }
  if (trimmed === '[]') {
    return { value: [], nextIdx: startIdx + 1 };
  }
  if (trimmed === 'null') {
    return { value: null, nextIdx: startIdx + 1 };
  }
  if (trimmed === 'true') {
    return { value: true, nextIdx: startIdx + 1 };
  }
  if (trimmed === 'false') {
    return { value: false, nextIdx: startIdx + 1 };
  }

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
      if (indent < baseIndent && idx > startIdx) {
        break;
      }
      if (!line.trim().startsWith('- ') && indent <= baseIndent && idx > startIdx) {
        break;
      }

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
            if (nextIndent <= indent || !nextLine.trim()) {
              break;
            }
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
      if (indent < baseIndent && idx > startIdx) {
        break;
      }
      const lt = line.trim();
      if (!lt) {
        idx++;
        continue;
      }

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

function _getIndent(line) {
  const match = line.match(/^(\s*)/);
  return match ? Math.floor(match[1].length / INDENT.length) : 0;
}

function _parseSimple(str) {
  if (!str) {
    return null;
  }
  const trimmed = str.trim();
  if (trimmed === 'null') {
    return null;
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

module.exports = {
  decode,
  _parseLines,
  _toonDepthCapEnabled,
  _TOON_MAX_DECODE_DEPTH,
  _getIndent,
  _parseSimple,
};
