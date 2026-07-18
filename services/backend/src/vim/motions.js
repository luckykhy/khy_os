/**
 * Vim motion resolution — maps motion keys to { start, end } ranges.
 *
 * All motions operate on a single line string with a cursor position.
 */

// ── Word character classification ──────────────────────────────────

function isWordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t';
}

function isBigWordChar(ch) {
  return ch !== undefined && !isWhitespace(ch);
}

// ── Word boundary helpers ──────────────────────────────────────────

function findWordEnd(line, pos, bigWord) {
  const len = line.length;
  if (pos >= len - 1) return len - 1;

  let p = pos + 1;
  // Skip whitespace
  while (p < len && isWhitespace(line[p])) p++;
  if (p >= len) return len - 1;

  if (bigWord) {
    while (p < len - 1 && isBigWordChar(line[p + 1])) p++;
  } else {
    const startIsWord = isWordChar(line[p]);
    while (p < len - 1) {
      const nextIsWord = isWordChar(line[p + 1]);
      if (startIsWord !== nextIsWord || isWhitespace(line[p + 1])) break;
      p++;
    }
  }
  return p;
}

function findNextWord(line, pos, bigWord) {
  const len = line.length;
  if (pos >= len - 1) return len - 1;

  let p = pos;
  if (bigWord) {
    // Skip current WORD
    while (p < len && isBigWordChar(line[p])) p++;
    // Skip whitespace
    while (p < len && isWhitespace(line[p])) p++;
  } else {
    const startIsWord = isWordChar(line[p]);
    if (isWhitespace(line[p])) {
      // Currently on whitespace — skip it
      while (p < len && isWhitespace(line[p])) p++;
    } else {
      // Skip current word class
      while (p < len && !isWhitespace(line[p]) && isWordChar(line[p]) === startIsWord) p++;
      // Skip whitespace after word
      while (p < len && isWhitespace(line[p])) p++;
    }
  }
  return Math.min(p, len - 1);
}

function findPrevWord(line, pos, bigWord) {
  if (pos <= 0) return 0;

  let p = pos - 1;
  // Skip whitespace backwards
  while (p > 0 && isWhitespace(line[p])) p--;

  if (bigWord) {
    while (p > 0 && isBigWordChar(line[p - 1])) p--;
  } else {
    const endIsWord = isWordChar(line[p]);
    while (p > 0 && !isWhitespace(line[p - 1]) && isWordChar(line[p - 1]) === endIsWord) p--;
  }
  return p;
}

// ── Find character in line ─────────────────────────────────────────

function findCharForward(line, pos, ch) {
  const idx = line.indexOf(ch, pos + 1);
  return idx >= 0 ? idx : -1;
}

function findCharBackward(line, pos, ch) {
  const idx = line.lastIndexOf(ch, pos - 1);
  return idx >= 0 ? idx : -1;
}

// ── First non-whitespace position ──────────────────────────────────

function firstNonBlank(line) {
  for (let i = 0; i < line.length; i++) {
    if (!isWhitespace(line[i])) return i;
  }
  return 0;
}

// ── Main motion resolver ───────────────────────────────────────────

/**
 * Resolve a motion key to a cursor range.
 *
 * @param {string} key - Motion key (h, l, w, b, e, W, B, E, 0, ^, $, f, F, t, T, ;, ,)
 * @param {string} line - Current line content
 * @param {number} cursor - Current cursor position
 * @param {number} count - Repeat count (default 1)
 * @param {string|null} findChar - Character for f/F/t/T motions
 * @param {string|null} findDirection - 'f' | 'F' | 't' | 'T' for find motions
 * @param {object|null} lastFind - { direction, char } from persistent state for ;/,
 * @returns {{ start: number, end: number, inclusive: boolean }|null}
 */
function resolveMotion(key, line, cursor, count = 1, findChar = null, findDirection = null, lastFind = null) {
  const len = line.length;
  if (len === 0) return null;

  const start = cursor;
  let end = cursor;

  switch (key) {
    // ── Character motions ──
    case 'h':
      end = Math.max(0, cursor - count);
      return { start, end, inclusive: false };

    case 'l':
      end = Math.min(len - 1, cursor + count);
      return { start, end, inclusive: false };

    // ── Word motions ──
    case 'w': {
      let p = cursor;
      for (let i = 0; i < count; i++) p = findNextWord(line, p, false);
      return { start, end: p, inclusive: false };
    }

    case 'W': {
      let p = cursor;
      for (let i = 0; i < count; i++) p = findNextWord(line, p, true);
      return { start, end: p, inclusive: false };
    }

    case 'b': {
      let p = cursor;
      for (let i = 0; i < count; i++) p = findPrevWord(line, p, false);
      return { start: p, end: start, inclusive: false };
    }

    case 'B': {
      let p = cursor;
      for (let i = 0; i < count; i++) p = findPrevWord(line, p, true);
      return { start: p, end: start, inclusive: false };
    }

    case 'e': {
      let p = cursor;
      for (let i = 0; i < count; i++) p = findWordEnd(line, p, false);
      return { start, end: p, inclusive: true };
    }

    case 'E': {
      let p = cursor;
      for (let i = 0; i < count; i++) p = findWordEnd(line, p, true);
      return { start, end: p, inclusive: true };
    }

    // ── Line motions ──
    case '0':
      return { start: 0, end: start, inclusive: false };

    case '^':
      end = firstNonBlank(line);
      return { start: Math.min(start, end), end: Math.max(start, end), inclusive: false };

    case '$':
      return { start, end: Math.max(0, len - 1), inclusive: true };

    // ── Find motions ──
    case 'f':
    case 'F':
    case 't':
    case 'T': {
      const dir = findDirection || key;
      const ch = findChar;
      if (!ch) return null;

      let target = -1;
      for (let i = 0; i < count; i++) {
        const searchFrom = target >= 0 ? target : cursor;
        if (dir === 'f' || dir === 't') {
          target = findCharForward(line, i === 0 ? cursor : target, ch);
        } else {
          target = findCharBackward(line, i === 0 ? cursor : target, ch);
        }
        if (target < 0) return null;
      }

      // t/T stop one short
      if (dir === 't' && target > cursor) target--;
      if (dir === 'T' && target < cursor) target++;

      return {
        start: Math.min(start, target),
        end: Math.max(start, target),
        inclusive: dir === 'f' || dir === 'F',
      };
    }

    // ── Repeat find ──
    case ';':
    case ',': {
      if (!lastFind) return null;
      let dir = lastFind.direction;
      if (key === ',') {
        // Reverse direction
        dir = dir === 'f' ? 'F' : dir === 'F' ? 'f' : dir === 't' ? 'T' : 't';
      }
      return resolveMotion(dir, line, cursor, count, lastFind.char, dir, null);
    }

    default:
      return null;
  }
}

module.exports = {
  resolveMotion,
  isWordChar,
  isWhitespace,
  findNextWord,
  findPrevWord,
  findWordEnd,
  firstNonBlank,
};
