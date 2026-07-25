/**
 * Vim text object resolution — iw, aw, i", a", i(, a(, etc.
 *
 * Returns { start, end } range for the text object around cursor.
 */

const { isWordChar, isWhitespace } = require('./motions');

// ── Bracket pair mapping ───────────────────────────────────────────

const BRACKET_PAIRS = {
  '(': ')', ')': '(',
  '[': ']', ']': '[',
  '{': '}', '}': '{',
  '<': '>', '>': '<',
};

const OPEN_BRACKETS = new Set(['(', '[', '{', '<']);

// ── Find matching bracket ──────────────────────────────────────────

function findMatchingBracket(line, pos, openChar, closeChar, searchForward) {
  let depth = 0;
  if (searchForward) {
    for (let i = pos; i < line.length; i++) {
      if (line[i] === openChar) depth++;
      if (line[i] === closeChar) {
        depth--;
        if (depth === 0) return i;
      }
    }
  } else {
    for (let i = pos; i >= 0; i--) {
      if (line[i] === closeChar) depth++;
      if (line[i] === openChar) {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

// ── Find surrounding quote ─────────────────────────────────────────

function findQuoteBounds(line, cursor, quoteChar) {
  // Find the quote pair containing cursor
  let start = -1;
  let end = -1;
  let inQuote = false;
  let quoteStart = -1;

  for (let i = 0; i < line.length; i++) {
    if (line[i] === quoteChar && (i === 0 || line[i - 1] !== '\\')) {
      if (!inQuote) {
        quoteStart = i;
        inQuote = true;
      } else {
        if (cursor >= quoteStart && cursor <= i) {
          start = quoteStart;
          end = i;
          break;
        }
        inQuote = false;
      }
    }
  }

  // If cursor is on a quote char, try to find the pair
  if (start < 0 && line[cursor] === quoteChar) {
    // Look for the closing quote
    for (let i = cursor + 1; i < line.length; i++) {
      if (line[i] === quoteChar && line[i - 1] !== '\\') {
        start = cursor;
        end = i;
        break;
      }
    }
  }

  return start >= 0 ? { start, end } : null;
}

// ── Main text object resolver ──────────────────────────────────────

/**
 * Resolve a text object to a range.
 *
 * @param {string} type - Object type: w, ", ', `, (, [, {, <, b(=()), B(={})
 * @param {string} modifier - 'i' (inner) or 'a' (around)
 * @param {string} line - Current line content
 * @param {number} cursor - Current cursor position
 * @returns {{ start: number, end: number }|null}
 */
function resolveTextObject(type, modifier, line, cursor) {
  if (line.length === 0) return null;

  switch (type) {
    // ── Word text object ──
    case 'w': {
      if (cursor >= line.length) return null;

      let start = cursor;
      let end = cursor;

      if (isWhitespace(line[cursor])) {
        // On whitespace — select whitespace run
        while (start > 0 && isWhitespace(line[start - 1])) start--;
        while (end < line.length - 1 && isWhitespace(line[end + 1])) end++;
      } else {
        const curIsWord = isWordChar(line[cursor]);
        // Expand to word boundary
        while (start > 0 && !isWhitespace(line[start - 1]) && isWordChar(line[start - 1]) === curIsWord) start--;
        while (end < line.length - 1 && !isWhitespace(line[end + 1]) && isWordChar(line[end + 1]) === curIsWord) end++;
      }

      if (modifier === 'a') {
        // Include trailing whitespace (or leading if at end)
        if (end < line.length - 1 && isWhitespace(line[end + 1])) {
          while (end < line.length - 1 && isWhitespace(line[end + 1])) end++;
        } else if (start > 0 && isWhitespace(line[start - 1])) {
          while (start > 0 && isWhitespace(line[start - 1])) start--;
        }
      }

      return { start, end };
    }

    // ── WORD text object ──
    case 'W': {
      if (cursor >= line.length) return null;

      let start = cursor;
      let end = cursor;

      if (isWhitespace(line[cursor])) {
        while (start > 0 && isWhitespace(line[start - 1])) start--;
        while (end < line.length - 1 && isWhitespace(line[end + 1])) end++;
      } else {
        while (start > 0 && !isWhitespace(line[start - 1])) start--;
        while (end < line.length - 1 && !isWhitespace(line[end + 1])) end++;
      }

      if (modifier === 'a') {
        if (end < line.length - 1 && isWhitespace(line[end + 1])) {
          while (end < line.length - 1 && isWhitespace(line[end + 1])) end++;
        } else if (start > 0 && isWhitespace(line[start - 1])) {
          while (start > 0 && isWhitespace(line[start - 1])) start--;
        }
      }

      return { start, end };
    }

    // ── Quote text objects ──
    case '"':
    case "'":
    case '`': {
      const bounds = findQuoteBounds(line, cursor, type);
      if (!bounds) return null;

      if (modifier === 'i') {
        return { start: bounds.start + 1, end: bounds.end - 1 };
      }
      return bounds;
    }

    // ── Bracket text objects ──
    case '(':
    case ')':
    case 'b': {
      return resolveBracketObject('(', ')', modifier, line, cursor);
    }

    case '[':
    case ']': {
      return resolveBracketObject('[', ']', modifier, line, cursor);
    }

    case '{':
    case '}':
    case 'B': {
      return resolveBracketObject('{', '}', modifier, line, cursor);
    }

    case '<':
    case '>': {
      return resolveBracketObject('<', '>', modifier, line, cursor);
    }

    default:
      return null;
  }
}

function resolveBracketObject(openCh, closeCh, modifier, line, cursor) {
  // Find the enclosing bracket pair
  let openPos = -1;
  let closePos = -1;

  // If cursor is on a bracket, use it as starting point
  if (line[cursor] === openCh) {
    openPos = cursor;
    closePos = findMatchingBracket(line, cursor, openCh, closeCh, true);
  } else if (line[cursor] === closeCh) {
    closePos = cursor;
    openPos = findMatchingBracket(line, cursor, openCh, closeCh, false);
  } else {
    // Cursor is in the interior (not on a bracket). Scan backward for the
    // nearest ENCLOSING opening bracket. We cannot delegate to
    // findMatchingBracket here: its depth-0 return convention assumes the scan
    // starts on a bracket (so depth pre-increments to 1), which is false for an
    // interior cursor — the old `findMatchingBracket(line, cursor, closeCh,
    // openCh, false)` call (args swapped) always returned -1, so ci(/di( with
    // the cursor inside the parens silently did nothing. Track nesting: a
    // closing bracket seen while scanning back is a nested pair to skip; the
    // first opening bracket reached at depth 0 encloses the cursor.
    let depth = 0;
    for (let i = cursor; i >= 0; i--) {
      if (line[i] === closeCh) depth++;
      else if (line[i] === openCh) {
        if (depth === 0) { openPos = i; break; }
        depth--;
      }
    }
    if (openPos >= 0) {
      closePos = findMatchingBracket(line, openPos, openCh, closeCh, true);
    }
  }

  if (openPos < 0 || closePos < 0 || openPos >= closePos) return null;

  if (modifier === 'i') {
    return { start: openPos + 1, end: closePos - 1 };
  }
  return { start: openPos, end: closePos };
}

module.exports = {
  resolveTextObject,
};
