/**
 * Enhanced Diff Display — line-based diff computation and terminal rendering.
 *
 * Features:
 *   - Simple LCS-based line diff (no external dependencies)
 *   - Side-by-side diff for wide terminals (>120 cols)
 *   - Unified diff fallback for narrow terminals
 *   - Compact inline preview for file-write confirmations
 *
 * Uses chalk (project dependency) for colors.
 */
const chalk = require('chalk').default || require('chalk');

// ── Diff Computation ────────────────────────────────────────────────────

/**
 * Compute a line-based diff between two text strings.
 *
 * Uses a basic LCS (Longest Common Subsequence) approach for inputs
 * up to 5000 lines. For larger inputs, falls back to a simpler
 * line-by-line heuristic comparison for performance.
 *
 * @param {string} oldText - Original text content
 * @param {string} newText - New text content
 * @returns {Array<{type: 'add'|'remove'|'context', lineNum: number, content: string}>}
 */
function computeDiff(oldText, newText) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');

  // Performance guard: use simple heuristic for very large inputs
  if (oldLines.length > 5000 || newLines.length > 5000) {
    return _simpleLineDiff(oldLines, newLines);
  }

  return _lcsDiff(oldLines, newLines);
}

/**
 * LCS-based diff producing context/add/remove entries.
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {Array<{type: string, lineNum: number, content: string}>}
 */
function _lcsDiff(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS length table
  // Use a 2-row rolling array to save memory: only need current and previous row
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  // We need the full table for backtracking, so build a direction matrix
  // Directions: 0 = diagonal (match), 1 = up (skip old), 2 = left (skip new)
  const dir = new Uint8Array((m + 1) * (n + 1));

  for (let i = 1; i <= m; i++) {
    [prev, curr] = [curr, prev];
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        dir[i * (n + 1) + j] = 0; // diagonal
      } else if (prev[j] >= curr[j - 1]) {
        curr[j] = prev[j];
        dir[i * (n + 1) + j] = 1; // up
      } else {
        curr[j] = curr[j - 1];
        dir[i * (n + 1) + j] = 2; // left
      }
    }
  }

  // Backtrack to produce diff entries
  const result = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dir[i * (n + 1) + j] === 0) {
      // Match — context line
      result.push({ type: 'context', lineNum: i, content: oldLines[i - 1] });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || dir[i * (n + 1) + j] === 1)) {
      // From old, not in new — removal
      result.push({ type: 'remove', lineNum: i, content: oldLines[i - 1] });
      i--;
    } else {
      // In new, not from old — addition
      result.push({ type: 'add', lineNum: j, content: newLines[j - 1] });
      j--;
    }
  }

  result.reverse();
  return result;
}

/**
 * Simple line-by-line comparison heuristic for large inputs.
 * Compares lines at corresponding indices; marks mismatches as remove+add.
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {Array<{type: string, lineNum: number, content: string}>}
 */
function _simpleLineDiff(oldLines, newLines) {
  const result = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      result.push({ type: 'context', lineNum: i + 1, content: oldLine });
    } else {
      if (oldLine !== undefined) {
        result.push({ type: 'remove', lineNum: i + 1, content: oldLine });
      }
      if (newLine !== undefined) {
        result.push({ type: 'add', lineNum: i + 1, content: newLine });
      }
    }
  }

  return result;
}

// ── Diff Rendering ──────────────────────────────────────────────────────

/**
 * Strip ANSI escape codes for width measurement.
 * @param {string} str
 * @returns {string}
 */
// 收敛到 utils/stripAnsi 单一真源(逐字节委托,调用点不变)
const _stripAnsi = require('../../utils/stripAnsi');

/**
 * Measure display width with East Asian wide-character support.
 * @param {string} str
 * @returns {number}
 */
function _displayWidth(str) {
  const plain = _stripAnsi(String(str || ''));
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) || 0;
    const isWide = (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE6F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x2FA1F)
    );
    width += isWide ? 2 : 1;
  }
  return width;
}

/**
 * Truncate plain text to a target display width.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function _truncateToDisplayWidth(str, width) {
  const text = String(str || '');
  if (width <= 0) return '';
  let out = '';
  let used = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    const w = (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE6F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x2FA1F)
    ) ? 2 : 1;
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/**
 * Pad or truncate a string to a target visible width.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function _padToWidth(str, width) {
  const visible = _displayWidth(str);
  if (visible >= width) return str;
  return str + ' '.repeat(width - visible);
}

/**
 * Render a side-by-side diff display.
 *
 * If the terminal is wide enough (>120 columns), shows old and new
 * content side by side separated by a vertical bar. Otherwise falls
 * back to a unified diff format.
 *
 * @param {string} oldContent - Original file content
 * @param {string} newContent - New file content
 * @param {string} [filePath=''] - File path shown in the header
 * @returns {string} Rendered diff string for console output
 */
function renderSideBySideDiff(oldContent, newContent, filePath = '') {
  const termCols = process.stdout.columns || 80;
  const changes = computeDiff(oldContent, newContent);

  // Header
  const header = filePath
    ? chalk.bold.cyan(`  --- ${filePath}`)
    : chalk.bold.cyan('  --- diff');

  if (termCols <= 120) {
    // Narrow terminal: unified diff format
    return _renderUnifiedDiff(changes, header);
  }

  // Wide terminal: side-by-side
  return _renderSideBySide(changes, header, termCols);
}

/**
 * Render unified diff format.
 * @param {Array} changes
 * @param {string} header
 * @returns {string}
 */
function _renderUnifiedDiff(changes, header) {
  const lines = [header, ''];
  const maxLineNum = Math.max(1, ...changes.map(c => c.lineNum));
  const numWidth = String(maxLineNum).length;

  // Word-level diff support
  let _wordDiff, _theme;
  try {
    _wordDiff = require('../wordDiff');
    const themeRegistry = require('../themeRegistry');
    _theme = themeRegistry.getTheme().colors;
  } catch { /* fallback to line-level */ }

  for (let idx = 0; idx < changes.length; idx++) {
    const change = changes[idx];
    const num = String(change.lineNum).padStart(numWidth);

    switch (change.type) {
      case 'remove': {
        // Word-level diff: pair adjacent remove+add
        const next = changes[idx + 1];
        if (_wordDiff && _theme && next && next.type === 'add') {
          const result = _wordDiff.renderWordDiffLine(change.content, next.content, _theme);
          if (result) {
            const nextNum = String(next.lineNum).padStart(numWidth);
            lines.push(chalk.bgHex(_theme.diffRemoved).hex('#FFFFFF')(`  ${num} - `) + result.oldRendered);
            lines.push(chalk.bgHex(_theme.diffAdded).hex('#FFFFFF')(`  ${nextNum} + `) + result.newRendered);
            idx++;
            break;
          }
        }
        lines.push(chalk.red(`  ${num} - ${change.content}`));
        break;
      }
      case 'add':
        lines.push(chalk.green(`  ${num} + ${change.content}`));
        break;
      default:
        lines.push(chalk.dim(`  ${num}   ${change.content}`));
        break;
    }
  }

  return lines.join('\n');
}

/**
 * Render side-by-side diff.
 * @param {Array} changes
 * @param {string} header
 * @param {number} termCols
 * @returns {string}
 */
function _renderSideBySide(changes, header, termCols) {
  // Split available width: margin(4) + lineNum + old + separator(3) + lineNum + new
  const halfWidth = Math.floor((termCols - 7) / 2);
  const numWidth = 4; // line number column
  const contentWidth = halfWidth - numWidth - 2; // padding

  const lines = [
    header,
    chalk.dim('  ' + _padToWidth('Old', halfWidth) + ' | ' + 'New'),
    chalk.dim('  ' + '\u2500'.repeat(halfWidth) + '\u2500|\u2500' + '\u2500'.repeat(halfWidth)),
  ];

  // Pair up removals and additions for side-by-side display
  // Context lines appear on both sides
  let i = 0;
  while (i < changes.length) {
    const change = changes[i];

    if (change.type === 'context') {
      const num = String(change.lineNum).padStart(numWidth);
      const content = _truncateToDisplayWidth(change.content, contentWidth);
      const leftSide = _padToWidth(chalk.dim(`${num}  ${content}`), halfWidth);
      const rightSide = chalk.dim(`${num}  ${content}`);
      lines.push(`  ${leftSide} ${chalk.dim('|')} ${rightSide}`);
      i++;
    } else if (change.type === 'remove') {
      // Look ahead for a paired addition
      const nextChange = (i + 1 < changes.length) ? changes[i + 1] : null;
      const num = String(change.lineNum).padStart(numWidth);
      const leftContent = _truncateToDisplayWidth(change.content, contentWidth);
      const leftSide = _padToWidth(chalk.red(`${num} -${leftContent}`), halfWidth);

      if (nextChange && nextChange.type === 'add') {
        const rightSide = chalk.dim(' '.repeat(numWidth + 2));
        lines.push(`  ${leftSide} ${chalk.dim('|')} ${rightSide}`);
        i++;
      }
    } else if (change.type === 'add') {
      const num = String(change.lineNum).padStart(numWidth);
      const rightContent = _truncateToDisplayWidth(change.content, contentWidth);
      const leftSide = _padToWidth(' '.repeat(numWidth + 2), halfWidth);
      const rightSide = chalk.green(`${num} +${rightContent}`);
      lines.push(`  ${leftSide} ${chalk.dim('|')} ${rightSide}`);
      i++;
    } else {
      i++;
    }
  }

  return lines.join('\n');
}

// ── Inline Diff Preview ─────────────────────────────────────────────────

/**
 * Render a compact preview line summarizing pending file changes.
 *
 * Returns a string like:
 *   "About to modify src/cli/repl.js: +3 lines, -1 line, ~2 modified"
 *
 * @param {string} filePath - Path of the file being modified
 * @param {Array<{type: 'add'|'remove'|'context', lineNum: number, content: string}>} changes
 *   Output from computeDiff
 * @returns {string} Formatted preview string (does not write to stdout)
 */
function renderInlineDiffPreview(filePath, changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return chalk.dim(`  About to modify ${filePath}: no changes detected`);
  }

  let additions = 0;
  let removals = 0;

  for (const c of changes) {
    if (c.type === 'add') additions++;
    else if (c.type === 'remove') removals++;
  }

  // Estimate "modified" lines: paired remove+add sequences
  // A simplistic count: min(additions, removals) are likely modifications
  const modified = Math.min(additions, removals);
  const pureAdd = additions - modified;
  const pureRemove = removals - modified;

  const parts = [];
  if (pureAdd > 0) {
    parts.push(chalk.green(`+${pureAdd} line${pureAdd !== 1 ? 's' : ''}`));
  }
  if (pureRemove > 0) {
    parts.push(chalk.red(`-${pureRemove} line${pureRemove !== 1 ? 's' : ''}`));
  }
  if (modified > 0) {
    parts.push(chalk.yellow(`~${modified} modified`));
  }

  const summary = parts.length > 0 ? parts.join(', ') : chalk.dim('no effective changes');

  return `  About to modify ${chalk.bold(filePath)}: ${summary}`;
}

module.exports = {
  computeDiff,
  renderSideBySideDiff,
  renderInlineDiffPreview,
};
