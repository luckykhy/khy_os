'use strict';

/**
 * wordDiff.js — Word-level diff highlighting for terminal output.
 *
 * Implements Claude Code-style word-level diff: tokenize lines into
 * word/whitespace/punctuation tokens, compute LCS, and highlight only
 * the changed words using THEME.diffAddedWord / THEME.diffRemovedWord.
 *
 * Falls back to line-level coloring when the changed fraction of the line
 * exceeds CHANGE_THRESHOLD (0.4), matching Claude Code's CHANGE_THRESHOLD
 * heuristic. CC (StructuredDiff/Fallback.tsx::generateWordDiffElements) measures
 * that fraction by VISIBLE CHARACTER LENGTH (changed chars / total chars, incl.
 * whitespace + the unchanged common text). The legacy khy metric counted
 * NON-WHITESPACE TOKENS instead, which flips the word-vs-solid decision near the
 * boundary (a few long-identifier renames vs many short tokens). Gate
 * KHY_WORD_DIFF_CHAR_RATIO (default on) selects CC's char-length metric; off →
 * byte-identical legacy token-count metric.
 */

let _chalk;
const c = () => (_chalk ??= (require('chalk').default || require('chalk')));

const CHANGE_THRESHOLD = 0.4; // >40% of the line changed → fall back to line-level

// LCS is O(m·n) in BOTH time and memory: computeWordDiff allocates a dp matrix of
// (m+1)·(n+1) Uint16 cells plus a (m+1)·(n+1) Uint8 direction matrix. For two long
// lines (e.g. a minified-JS line, a 100k-char log line, or pasted adversarial input)
// that product explodes into gigabytes → the process OOM-kills, and even short of OOM
// an ~8k-token line freezes rendering for seconds. A giant line is never a meaningful
// WORD-level diff anyway, so when the token product exceeds this budget we fall back to
// whole-line colouring — the same escape valve the CHANGE_THRESHOLD branch already uses.
// 1M cells ≈ a 1000×1000-token diff: ~3MB of matrices, ~30ms. Real diff lines are far
// smaller, so this changes nothing for normal input and only trips on pathological ones.
const MAX_LCS_CELLS = 1_000_000;

// Gate for the O(m·n) overflow guard (default on). Off (=0/false/off/no) → legacy
// unguarded LCS, byte-identical output but vulnerable to OOM/hang on huge lines
// (honest escape hatch, not the recommended state).
function wordDiffGuardEnabled(env = process.env) {
  const flag = String((env && env.KHY_WORD_DIFF_GUARD) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// Gate for the CC-aligned char-length change-ratio metric (default on). Off
// (=0/false/off/no) → legacy non-whitespace token-count metric, byte-identical.
function wordDiffCharRatioEnabled(env = process.env) {
  const flag = String((env && env.KHY_WORD_DIFF_CHAR_RATIO) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * Tokenize a line into word / whitespace / punctuation tokens.
 * CJK characters are each their own token for fine-grained diffing.
 *
 * @param {string} line
 * @returns {string[]}
 */
function tokenizeLine(line) {
  if (!line) return [];
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line.charCodeAt(i);

    // Surrogate pair (astral code point: emoji, rare CJK ext-B+, etc.) — must be
    // kept as ONE token. Splitting it by UTF-16 code unit would emit two lone
    // surrogates that render as the replacement char (encoding-safety req ③).
    if (ch >= 0xD800 && ch <= 0xDBFF && i + 1 < line.length) {
      const lo = line.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        tokens.push(line.slice(i, i + 2));
        i += 2;
        continue;
      }
    }

    // CJK Unified Ideographs + extensions + common CJK ranges
    if ((ch >= 0x4E00 && ch <= 0x9FFF) ||   // CJK Unified Ideographs
        (ch >= 0x3400 && ch <= 0x4DBF) ||   // CJK Extension A
        (ch >= 0xF900 && ch <= 0xFAFF) ||   // CJK Compatibility Ideographs
        (ch >= 0x3000 && ch <= 0x303F) ||   // CJK Symbols and Punctuation
        (ch >= 0xFF00 && ch <= 0xFFEF)) {   // Fullwidth Forms
      tokens.push(line[i]);
      i++;
      continue;
    }

    // Whitespace run
    if (ch === 32 || ch === 9) {
      let j = i;
      while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
      tokens.push(line.slice(i, j));
      i = j;
      continue;
    }

    // Word run: letters, digits, underscore
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) ||
        (ch >= 48 && ch <= 57) || ch === 95) {
      let j = i;
      while (j < line.length) {
        const cc = line.charCodeAt(j);
        if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
            (cc >= 48 && cc <= 57) || cc === 95) {
          j++;
        } else {
          break;
        }
      }
      tokens.push(line.slice(i, j));
      i = j;
      continue;
    }

    // Single punctuation character
    tokens.push(line[i]);
    i++;
  }
  return tokens;
}

/**
 * Compute word-level diff between two token arrays using LCS.
 * Returns arrays of changed ranges for old and new tokens.
 *
 * @param {string[]} oldTokens
 * @param {string[]} newTokens
 * @param {object} [env]  env for the change-ratio metric gate (default process.env)
 * @returns {{ oldRanges: boolean[], newRanges: boolean[], changeRatio: number }}
 *   oldRanges[i] = true means oldTokens[i] was removed/changed
 *   newRanges[i] = true means newTokens[i] was added/changed
 */
function computeWordDiff(oldTokens, newTokens, env = process.env) {
  const m = oldTokens.length;
  const n = newTokens.length;

  // Fast path: identical
  if (m === n && oldTokens.every((t, i) => t === newTokens[i])) {
    return { oldRanges: new Array(m).fill(false), newRanges: new Array(n).fill(false), changeRatio: 0 };
  }

  // Overflow guard: the LCS matrices below are O(m·n) in time AND memory. A huge
  // line (minified JS, long log line, pasted blob) would OOM-kill the process or
  // freeze rendering for seconds. Word-level diffing a line that large is
  // meaningless anyway, so signal "whole line changed" (changeRatio = 1 > the
  // CHANGE_THRESHOLD) — both renderWordDiffLine and computeWordDiffSegments already
  // treat that as "fall back to solid line-level colouring". This never throws and
  // never allocates the matrices. Gate off → legacy unguarded path (byte-identical
  // output on small input, but no OOM/hang protection on pathological input).
  if (wordDiffGuardEnabled(env) && (m + 1) * (n + 1) > MAX_LCS_CELLS) {
    return {
      oldRanges: new Array(m).fill(true),
      newRanges: new Array(n).fill(true),
      changeRatio: 1,
    };
  }

  // LCS using 2-row rolling array for space efficiency
  // But we need backtracking, so build direction matrix
  const dir = new Uint8Array((m + 1) * (n + 1)); // 0=diag, 1=up, 2=left
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        dir[i * (n + 1) + j] = 0;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        dp[i][j] = dp[i - 1][j];
        dir[i * (n + 1) + j] = 1;
      } else {
        dp[i][j] = dp[i][j - 1];
        dir[i * (n + 1) + j] = 2;
      }
    }
  }

  // Backtrack to find which tokens are in LCS
  const oldInLCS = new Array(m).fill(false);
  const newInLCS = new Array(n).fill(false);
  let i = m, j = n;
  while (i > 0 && j > 0) {
    const d = dir[i * (n + 1) + j];
    if (d === 0) {
      oldInLCS[i - 1] = true;
      newInLCS[j - 1] = true;
      i--; j--;
    } else if (d === 1) {
      i--;
    } else {
      j--;
    }
  }

  // Ranges: tokens NOT in LCS are changed
  const oldRanges = oldInLCS.map(v => !v);
  const newRanges = newInLCS.map(v => !v);

  // Change ratio. CC (StructuredDiff/Fallback.tsx::generateWordDiffElements):
  //   totalLength   = removedLineText.length + addedLineText.length   (incl. whitespace)
  //   changedLength = Σ (added||removed) part.value.length
  //   changeRatio   = changedLength / totalLength
  // tokenizeLine partitions each line exactly (Σ token.length === line.length), so
  // summing changed-token char lengths / all-token char lengths reproduces CC's
  // metric byte-for-byte — INCLUDING leading indentation and the unchanged common
  // text in the denominator. Gate off → legacy non-whitespace TOKEN-COUNT metric
  // (whitespace excluded from both numerator and denominator), byte-identical.
  let changeRatio;
  if (wordDiffCharRatioEnabled(env)) {
    let changedLen = 0;
    let totalLen = 0;
    for (let idx = 0; idx < m; idx++) {
      totalLen += oldTokens[idx].length;
      if (oldRanges[idx]) changedLen += oldTokens[idx].length;
    }
    for (let idx = 0; idx < n; idx++) {
      totalLen += newTokens[idx].length;
      if (newRanges[idx]) changedLen += newTokens[idx].length;
    }
    changeRatio = totalLen > 0 ? changedLen / totalLen : 0;
  } else {
    const totalNonWS = oldTokens.filter(t => t.trim()).length + newTokens.filter(t => t.trim()).length;
    const changedNonWS = oldTokens.filter((t, idx) => oldRanges[idx] && t.trim()).length +
                          newTokens.filter((t, idx) => newRanges[idx] && t.trim()).length;
    changeRatio = totalNonWS > 0 ? changedNonWS / totalNonWS : 0;
  }

  return { oldRanges, newRanges, changeRatio };
}

/**
 * Render a pair of old/new lines with word-level diff highlighting.
 * Returns { oldRendered, newRendered } with ANSI-colored strings.
 *
 * If the change ratio exceeds CHANGE_THRESHOLD, returns null to signal
 * the caller should fall back to line-level coloring.
 *
 * @param {string} oldLine
 * @param {string} newLine
 * @param {{ diffRemoved: string, diffAdded: string, diffRemovedWord: string, diffAddedWord: string }} theme
 * @returns {{ oldRendered: string, newRendered: string } | null}
 */
function renderWordDiffLine(oldLine, newLine, theme, env = process.env) {
  const oldTokens = tokenizeLine(oldLine);
  const newTokens = tokenizeLine(newLine);

  const { oldRanges, newRanges, changeRatio } = computeWordDiff(oldTokens, newTokens, env);

  // Fall back to line-level if too many changes
  if (changeRatio > CHANGE_THRESHOLD) return null;

  const chalk = c();

  // Build old line: unchanged tokens get line bg, changed tokens get word bg
  const lineBgOld = chalk.bgHex(theme.diffRemoved).hex('#FFFFFF');
  const wordBgOld = chalk.bgHex(theme.diffRemovedWord).hex('#FFFFFF').bold;

  let oldRendered = '';
  for (let i = 0; i < oldTokens.length; i++) {
    oldRendered += oldRanges[i] ? wordBgOld(oldTokens[i]) : lineBgOld(oldTokens[i]);
  }

  // Build new line: unchanged tokens get line bg, changed tokens get word bg
  const lineBgNew = chalk.bgHex(theme.diffAdded).hex('#FFFFFF');
  const wordBgNew = chalk.bgHex(theme.diffAddedWord).hex('#FFFFFF').bold;

  let newRendered = '';
  for (let i = 0; i < newTokens.length; i++) {
    newRendered += newRanges[i] ? wordBgNew(newTokens[i]) : lineBgNew(newTokens[i]);
  }

  return { oldRendered, newRendered };
}

/**
 * Coalesce adjacent tokens of the same changed-state into display segments.
 * @param {string[]} tokens
 * @param {boolean[]} ranges  ranges[i] === true → tokens[i] changed
 * @returns {Array<{text: string, changed: boolean}>}
 */
function _coalesceSegments(tokens, ranges) {
  const segs = [];
  for (let i = 0; i < tokens.length; i++) {
    const changed = !!ranges[i];
    const last = segs.length ? segs[segs.length - 1] : null;
    if (last && last.changed === changed) last.text += tokens[i];
    else segs.push({ text: tokens[i], changed });
  }
  return segs;
}

/**
 * Word-level diff as renderer-agnostic SEGMENTS (not ANSI strings), so a UI that
 * paints with structured colour attributes — e.g. the ink TUI's
 * `<Text backgroundColor>` — can highlight the changed sub-spans the same way the
 * classic ANSI path (`renderWordDiffLine`) does. Faithful to CC's
 * StructuredDiffFallback: pair a removed line with its added counterpart, run a
 * token diff, and only highlight at the word level when the change ratio is at or
 * below CHANGE_THRESHOLD; otherwise fall back to whole-line colouring.
 *
 * @param {string} oldLine
 * @param {string} newLine
 * @returns {{
 *   old: Array<{text: string, changed: boolean}>,
 *   new: Array<{text: string, changed: boolean}>,
 *   wordLevel: boolean
 * }}
 *   When `wordLevel` is false the segment arrays are a single whole-line span
 *   (changed:false) — the caller renders the entire line at the line background,
 *   byte-identical to today's line-level rendering.
 */
function computeWordDiffSegments(oldLine, newLine, env = process.env) {
  const oldStr = String(oldLine ?? '');
  const newStr = String(newLine ?? '');
  const wholeLine = () => ({
    old: oldStr ? [{ text: oldStr, changed: false }] : [],
    new: newStr ? [{ text: newStr, changed: false }] : [],
    wordLevel: false,
  });
  try {
    const oldTokens = tokenizeLine(oldStr);
    const newTokens = tokenizeLine(newStr);
    const { oldRanges, newRanges, changeRatio } = computeWordDiff(oldTokens, newTokens, env);
    // Too much of the line changed → word-level highlighting is just noise; fall
    // back to a solid line (matches CC's CHANGE_THRESHOLD branch).
    if (changeRatio > CHANGE_THRESHOLD) return wholeLine();
    return {
      old: _coalesceSegments(oldTokens, oldRanges),
      new: _coalesceSegments(newTokens, newRanges),
      wordLevel: true,
    };
  } catch {
    // Never throw from a display helper — fall back to whole-line spans.
    return wholeLine();
  }
}

module.exports = {
  tokenizeLine,
  computeWordDiff,
  renderWordDiffLine,
  computeWordDiffSegments,
  wordDiffCharRatioEnabled,
  wordDiffGuardEnabled,
  CHANGE_THRESHOLD,
  MAX_LCS_CELLS,
};
