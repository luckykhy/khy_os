/**
 * TOON Codec — encode half (JSON → Token-Optimized Object Notation).
 *
 * Pure functions, zero dependencies. Split verbatim from toonCodec.js so the
 * whole `account/tokenless` directory stays ≤400 lines (M1 managed discipline).
 * The public surface is re-assembled by the toonCodec.js host, byte-for-
 * identical: `encode` here is the exact same function reference the host re-exports.
 */

'use strict';

const INDENT = '  ';

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
    const str =
      value.length > opts.maxStringLen ? value.slice(0, opts.maxStringLen) + '...' : value;
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
    const allSimple = value.every((v) => v === null || typeof v !== 'object');
    if (allSimple && value.length <= 10) {
      // Inline flat array
      lines.push(_indent(depth) + '[' + value.map((v) => _simpleValue(v)).join(', ') + ']');
      return;
    }

    // Array of objects: use - prefix (YAML-like)
    const items = value.length > opts.maxArrayItems ? value.slice(0, opts.maxArrayItems) : value;

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

function _isSimple(value) {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function _simpleValue(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

function _indent(depth) {
  return INDENT.repeat(depth);
}

module.exports = {
  encode,
  _encodeValue,
  _isSimple,
  _simpleValue,
  _indent,
};
