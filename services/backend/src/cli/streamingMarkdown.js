'use strict';

/**
 * MarkdownStreamState -- incremental markdown renderer for streaming output.
 *
 * Instead of re-rendering the entire accumulated text on every chunk,
 * this tracks block boundaries (prose, code fences, tables, lists, headings)
 * and only commits rendering at block boundaries.
 *
 * Block states:
 *   'prose'      -- normal text, committed on blank line or heading
 *   'code_fence' -- inside ```...```, committed on closing fence
 *   'table'      -- inside |...|, committed on first non-pipe line
 *   'list'       -- bullet/numbered list, committed on blank line or heading
 *
 * The caller provides a renderFn callback that receives each committed block.
 * This keeps the state machine decoupled from any specific renderer.
 */

// ── Pattern constants ──────────────────────────────────────────────

const FENCE_OPEN_RE = /^(`{3,})([\w+-]*)\s*$/;
const FENCE_CLOSE_PREFIX = '```';
const HEADING_RE = /^#{1,6}\s/;
const TABLE_RE = /^\s*\|/;
const ULIST_RE = /^\s*[-*+]\s/;
const OLIST_RE = /^\s*\d+[.)]\s/;
const BLANK_RE = /^\s*$/;

// 围栏起始行语言段字符集收敛到纯叶子 cli/fenceLangCharset(门控 KHY_FENCE_LANG_CHARSET
// 默认开:语言段额外收 `.`/`#`,认得 ```c# / ```f# / ```asp.net;关 → 逐字节回退历史正则)。
// 懒加载 + fail-soft:叶子不可用 → 用本地历史 FENCE_OPEN_RE。
let _fenceOpenRegexFn;
function _fenceOpenRe() {
  try {
    if (_fenceOpenRegexFn === undefined) {
      _fenceOpenRegexFn = require('./fenceLangCharset').fenceOpenRegex;
    }
    if (typeof _fenceOpenRegexFn === 'function') return _fenceOpenRegexFn(process.env);
  } catch {
    /* 落历史正则 */
  }
  return FENCE_OPEN_RE;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Determine the block type for a line in 'prose' or 'list' context.
 * Returns one of: 'heading', 'fence_open', 'table', 'list', 'blank', 'prose'.
 */
function classifyLine(line) {
  if (BLANK_RE.test(line)) return 'blank';
  if (_fenceOpenRe().test(line)) return 'fence_open';
  if (HEADING_RE.test(line)) return 'heading';
  if (TABLE_RE.test(line)) return 'table';
  if (ULIST_RE.test(line) || OLIST_RE.test(line)) return 'list';
  return 'prose';
}

// ── MarkdownStreamState ────────────────────────────────────────────

class MarkdownStreamState {
  /**
   * @param {function(string):void} renderFn - called with each committed block
   */
  constructor(renderFn) {
    if (typeof renderFn !== 'function') {
      throw new TypeError('renderFn must be a function');
    }
    this._renderFn = renderFn;
    this._state = 'prose';
    this._buffer = '';          // accumulated text for current block
    this._committed = '';       // all committed (rendered) text
    this._fenceLang = '';       // language tag of current code fence
    this._fenceTicks = 3;       // backtick count of the opening fence
    this._remainder = '';       // partial line not yet terminated by \n
  }

  /**
   * Feed incremental text delta into the state machine.
   * @param {string} delta - new text chunk from streaming
   */
  feed(delta) {
    if (!delta) return;

    // Prepend any leftover partial line from the previous feed
    const input = this._remainder + delta;

    // Split into complete lines + a possible trailing partial line.
    // We only process complete lines (terminated by \n). The trailing
    // fragment without a \n is held in _remainder until the next feed
    // or flush.
    const lastNl = input.lastIndexOf('\n');
    if (lastNl < 0) {
      // No complete line yet -- just accumulate
      this._remainder = input;
      return;
    }

    const processable = input.slice(0, lastNl + 1); // includes the final \n
    this._remainder = input.slice(lastNl + 1);

    const lines = processable.split('\n');
    // The last element after split on a string ending with \n is always ''
    // so we process all elements except the trailing empty string.
    for (let i = 0; i < lines.length - 1; i++) {
      this._processLine(lines[i]);
    }
  }

  /**
   * Process a single complete line (without trailing \n).
   * @param {string} line
   */
  _processLine(line) {
    switch (this._state) {

      case 'code_fence':
        this._handleCodeFenceLine(line);
        break;

      case 'table':
        this._handleTableLine(line);
        break;

      case 'list':
        this._handleListLine(line);
        break;

      case 'prose':
      default:
        this._handleProseLine(line);
        break;
    }
  }

  // ── State handlers ───────────────────────────────────────────────

  /**
   * Inside a code fence: accumulate until we see the closing fence.
   */
  _handleCodeFenceLine(line) {
    this._buffer += line + '\n';
    // Closing fence: same or more backticks, optional whitespace
    const trimmed = line.trim();
    if (trimmed.length >= this._fenceTicks &&
        /^`+$/.test(trimmed) &&
        trimmed.length >= this._fenceTicks) {
      // Verify it is actually all backticks and at least as many as the opener
      const tickCount = trimmed.length;
      if (tickCount >= this._fenceTicks) {
        this._commitBuffer();
        this._state = 'prose';
        this._fenceLang = '';
        this._fenceTicks = 3;
      }
    }
  }

  /**
   * Inside a table: accumulate pipe-starting lines, commit on non-pipe line.
   */
  _handleTableLine(line) {
    const kind = classifyLine(line);
    if (kind === 'table') {
      this._buffer += line + '\n';
    } else if (kind === 'blank') {
      // Blank line after table -- commit the table, add the blank to next block
      this._commitBuffer();
      this._state = 'prose';
      this._buffer = line + '\n';
    } else {
      // Non-table, non-blank line -- commit the table, then handle new line
      this._commitBuffer();
      this._state = 'prose';
      this._handleProseLine(line);
    }
  }

  /**
   * Inside a list: accumulate list items and continuation lines.
   * Commit on blank line or heading.
   */
  _handleListLine(line) {
    const kind = classifyLine(line);
    if (kind === 'blank') {
      // Blank line after list -- commit
      this._buffer += line + '\n';
      this._commitBuffer();
      this._state = 'prose';
    } else if (kind === 'heading') {
      // Heading terminates the list
      this._commitBuffer();
      this._state = 'prose';
      this._handleProseLine(line);
    } else if (kind === 'fence_open') {
      this._commitBuffer();
      this._enterFence(line);
    } else if (kind === 'table') {
      this._commitBuffer();
      this._state = 'table';
      this._buffer = line + '\n';
    } else {
      // list item or continuation prose within a list
      this._buffer += line + '\n';
    }
  }

  /**
   * Default prose state: accumulate until we hit a boundary.
   */
  _handleProseLine(line) {
    const kind = classifyLine(line);

    switch (kind) {
      case 'blank':
        // Blank line -- commit current block (including the blank line)
        this._buffer += line + '\n';
        this._commitBuffer();
        break;

      case 'heading':
        // Heading -- commit any prior content, then commit the heading itself
        if (this._buffer.trim()) {
          this._commitBuffer();
        }
        this._buffer = line + '\n';
        this._commitBuffer();
        break;

      case 'fence_open':
        // Code fence -- commit prior, enter fence state
        if (this._buffer.trim()) {
          this._commitBuffer();
        }
        this._enterFence(line);
        break;

      case 'table':
        // Table start -- commit prior, enter table state
        if (this._buffer.trim()) {
          this._commitBuffer();
        }
        this._state = 'table';
        this._buffer = line + '\n';
        break;

      case 'list':
        // List start -- commit prior, enter list state
        if (this._buffer.trim()) {
          this._commitBuffer();
        }
        this._state = 'list';
        this._buffer = line + '\n';
        break;

      case 'prose':
      default:
        this._buffer += line + '\n';
        break;
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
   * Enter code_fence state with the opening line.
   */
  _enterFence(line) {
    const m = line.match(_fenceOpenRe());
    this._fenceTicks = m ? m[1].length : 3;
    this._fenceLang = m ? (m[2] || '') : '';
    this._state = 'code_fence';
    this._buffer = line + '\n';
  }

  /**
   * Commit the current buffer via renderFn and reset the buffer.
   */
  _commitBuffer() {
    const text = this._buffer;
    if (text) {
      this._committed += text;
      this._renderFn(text);
    }
    this._buffer = '';
  }

  /**
   * Flush any remaining buffered content (call at end of stream).
   */
  flush() {
    // If there is a partial line (no trailing \n), add it to the buffer
    if (this._remainder) {
      this._buffer += this._remainder;
      this._remainder = '';
    }
    // Commit whatever is left
    if (this._buffer) {
      this._commitBuffer();
    }
    // Reset state for safety
    this._state = 'prose';
    this._fenceLang = '';
    this._fenceTicks = 3;
  }

  /**
   * Get total rendered output so far (all committed text).
   * @returns {string}
   */
  getOutput() {
    return this._committed;
  }

  /**
   * Reset state for new response.
   */
  reset() {
    this._state = 'prose';
    this._buffer = '';
    this._committed = '';
    this._fenceLang = '';
    this._fenceTicks = 3;
    this._remainder = '';
  }
}

module.exports = { MarkdownStreamState };
