'use strict';

/**
 * Vim text-object finding (iw, aw, i", a(, etc.) — ported from Claude Code's
 * src/vim/textObjects.ts. CC pre-segments into grapheme clusters via
 * Intl.Segmenter; here we iterate per code point (Array.from), which is correct
 * for surrogate pairs and sufficient for prompt editing.
 */
const { isVimPunctuation, isVimWhitespace, isVimWordChar } = require('./cursor');

const PAIRS = {
  '(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'],
  '[': ['[', ']'], ']': ['[', ']'],
  '{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'],
  '<': ['<', '>'], '>': ['<', '>'],
  '"': ['"', '"'], "'": ["'", "'"], '`': ['`', '`'],
};

function findTextObject(text, offset, objectType, isInner) {
  if (objectType === 'w') return findWordObject(text, offset, isInner, isVimWordChar);
  if (objectType === 'W') return findWordObject(text, offset, isInner, (ch) => !isVimWhitespace(ch));

  const pair = PAIRS[objectType];
  if (pair) {
    const [open, close] = pair;
    return open === close
      ? findQuoteObject(text, offset, open, isInner)
      : findBracketObject(text, offset, open, close, isInner);
  }
  return null;
}

function findWordObject(text, offset, isInner, isWordChar) {
  // Segment into code-point graphemes with their byte (UTF-16) indices.
  const graphemes = [];
  let idx = 0;
  for (const segment of Array.from(text)) {
    graphemes.push({ segment, index: idx });
    idx += segment.length;
  }

  let graphemeIdx = graphemes.length - 1;
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i];
    const nextStart = i + 1 < graphemes.length ? graphemes[i + 1].index : text.length;
    if (offset >= g.index && offset < nextStart) { graphemeIdx = i; break; }
  }

  const graphemeAt = (i) => (graphemes[i] ? graphemes[i].segment : '');
  const offsetAt = (i) => (i < graphemes.length ? graphemes[i].index : text.length);
  const isWs = (i) => isVimWhitespace(graphemeAt(i));
  const isWord = (i) => isWordChar(graphemeAt(i));
  const isPunct = (i) => isVimPunctuation(graphemeAt(i));

  let startIdx = graphemeIdx;
  let endIdx = graphemeIdx;

  if (isWord(graphemeIdx)) {
    while (startIdx > 0 && isWord(startIdx - 1)) startIdx--;
    while (endIdx < graphemes.length && isWord(endIdx)) endIdx++;
  } else if (isWs(graphemeIdx)) {
    while (startIdx > 0 && isWs(startIdx - 1)) startIdx--;
    while (endIdx < graphemes.length && isWs(endIdx)) endIdx++;
    return { start: offsetAt(startIdx), end: offsetAt(endIdx) };
  } else if (isPunct(graphemeIdx)) {
    while (startIdx > 0 && isPunct(startIdx - 1)) startIdx--;
    while (endIdx < graphemes.length && isPunct(endIdx)) endIdx++;
  }

  if (!isInner) {
    if (endIdx < graphemes.length && isWs(endIdx)) {
      while (endIdx < graphemes.length && isWs(endIdx)) endIdx++;
    } else if (startIdx > 0 && isWs(startIdx - 1)) {
      while (startIdx > 0 && isWs(startIdx - 1)) startIdx--;
    }
  }

  return { start: offsetAt(startIdx), end: offsetAt(endIdx) };
}

function findQuoteObject(text, offset, quote, isInner) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', offset);
  const effectiveEnd = lineEnd === -1 ? text.length : lineEnd;
  const line = text.slice(lineStart, effectiveEnd);
  const posInLine = offset - lineStart;

  const positions = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === quote) positions.push(i);
  }

  for (let i = 0; i < positions.length - 1; i += 2) {
    const qs = positions[i];
    const qe = positions[i + 1];
    if (qs <= posInLine && posInLine <= qe) {
      return isInner
        ? { start: lineStart + qs + 1, end: lineStart + qe }
        : { start: lineStart + qs, end: lineStart + qe + 1 };
    }
  }
  return null;
}

function findBracketObject(text, offset, open, close, isInner) {
  let depth = 0;
  let start = -1;
  for (let i = offset; i >= 0; i--) {
    if (text[i] === close && i !== offset) depth++;
    else if (text[i] === open) {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start === -1) return null;

  depth = 0;
  let end = -1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      if (depth === 0) { end = i; break; }
      depth--;
    }
  }
  if (end === -1) return null;

  return isInner ? { start: start + 1, end } : { start, end: end + 1 };
}

module.exports = { findTextObject };
