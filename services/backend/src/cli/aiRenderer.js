/**
 * AI Output Renderer — Claude Code-style terminal output.
 *
 * 1:1 replication of Claude Code's visual system:
 *   - ⏺ dot indicators (not emoji) with exact RGB colors
 *   - English tool names: Bash, Read, Write, Search, Update
 *   - Red/green diff with word-level highlights
 *   - Tree-style collapsible tool use display
 *
 * Color reference (Claude Code dark theme):
 *   claude:    rgb(215,119,87)  — brand orange
 *   success:   rgb(78,186,101)  — green
 *   error:     rgb(255,107,128) — red/pink
 *   warning:   rgb(255,193,7)   — amber
 *   subtle:    rgb(80,80,80)    — dim gray
 *   bashBorder:rgb(253,93,177)  — pink
 *   diffAdded: rgb(34,92,43)    — deep green bg
 *   diffRemoved:rgb(122,41,54)  — deep red bg
 *   diffAddedWord: rgb(56,166,96) — bright green word highlight
 *   diffRemovedWord:rgb(179,89,107)— bright red word highlight
 */
const renderTheme = require('./renderTheme');
const {
  c,
  THEME,
  themeRegistry,
  setInteractiveGuard,
  isInteractiveInputActive,
  SPINNER_FRAMES,
  SPINNER_ACTIVE_CHAR,
  REDUCED_MOTION_DOT,
  THINKING_VERBS,
  PHASE_LABELS,
  TOOL_DISPLAY_NAMES,
  TOOL_KIND_ALIASES,
  _formatElapsed,
  _normalizeStatusTextForDedupe,
  normalizeToolKind,
  getToolDisplayName,
  summarizeToolDetail,
  getToolKindLabel,
  DOT_PENDING,
  DOT_INDICATOR,
  DOT_SUCCESS,
  DOT_ERROR,
  DOT_DONE,
  TASK_PENDING,
  TASK_IN_PROGRESS,
  TASK_COMPLETED,
  TOOL_FAMILY_ICONS,
  getToolFamilyIcon,
  TREE_LAST,
  TREE_MID,
} = renderTheme;
const { displayWidth, padToWidth, truncateToWidth } = require('./formatters');

// Rail-aware terminal width for text wrapping. Single source: tui/effectiveCols
// subtracts the right-rail (task board) reserved columns; never throws — a
// missing leaf degrades to the legacy raw-columns reading.
function _effectiveWrapCols() {
  try {
    return require('./tui/effectiveCols').effectiveCols(80);
  } catch {
    return process.stdout.columns || 80;
  }
}

// CJK (含标点/假名/谚文/全角) 行检测——判定「这一行是中文散文」。命中任一即认为该行
// 需要按中文排版规则对待:不硬换行,整行交给终端软折行(见 wrapLine)。
const _CJK_LINE_RE = /[⺀-㎿㐀-䶿一-鿿ꀀ-꓏가-힯豈-﫿︰-﹯！-｠￠-￦]|[\u{20000}-\u{2FA1F}]/u;

const { DynamicSpinner, renderUserMessage } = require('./spinner');

// ── Diff Renderer (extracted to diffRenderer.js) ────────────────────────
const { renderDiff, renderStructuredDiff, renderResponseWithDiffs } = require('./diffRenderer');

// ── Markdown Rendering (extracted to ./markdownRenderer.js) ──────────────
const { renderMarkdownLite } = require('./markdownRenderer');

// ── Step / Process Tracking (extracted to ./steps.js) ──────────────────
const {
  startSparkle,
  printStepLine,
  printStepDetail,
  ProcessTracker,
  printCompactingNotice,
  printProcessStep,
  printToolCall,
  printActionHint,
  printThinkingStep,
} = require('./steps');

// ── Mermaid re-export (used by module.exports) ──────────────────────────
const { renderMermaidBlock: _renderMermaidBlock } = require('./mermaid');

// ── Interactive Prompt ──────────────────────────────────────────────────

/**
 * Present numbered options to the user and wait for selection.
 * Returns the selected option(s) or null if cancelled.
 *
 * @param {string} question - The question to ask
 * @param {Array<{label: string, description?: string}>} options
 * @param {object} [opts]
 * @param {boolean} [opts.multiSelect=false]
 * @param {readline.Interface} [opts.rl] - existing readline to reuse
 * @returns {Promise<string|string[]|null>}
 */
async function askInlineQuestion(question, options, opts = {}) {
  const readline = require('readline');
  const stdin = process.stdin;
  const stdout = process.stdout;
  const header = opts.header || '';
  const hasPreview = !opts.multiSelect && options.some((opt) => opt.preview);
  const canUseArrowMenu =
    !opts.multiSelect &&
    Boolean(
      stdin && stdout && stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function'
    );

  // Claude Code style: arrow-key navigable menu for single-select
  if (canUseArrowMenu) {
    // Build choices compatible with promptChoiceMenu style
    const choices = options.map((opt, i) => ({
      label: opt.label + (opt.description ? c().dim(` — ${opt.description}`) : ''),
      value: opt.label,
      aliases: [String(i + 1)],
      preview: opt.preview || '',
    }));
    // Add "Other" choice
    choices.push({
      label: c().dim('Other (free input)'),
      value: '__other__',
      aliases: [String(options.length + 1), 'o', 'other'],
      preview: '',
    });

    const PURPLE = '#B388FF';
    return new Promise((resolve) => {
      let selected = 0;
      const typed = '';
      let renderedLines = 0;
      const wasRawMode = Boolean(stdin.isRaw);

      // Pause the REPL's readline if provided
      const rl = opts.rl;
      if (rl && typeof rl.pause === 'function') {
        try {
          rl.pause();
        } catch {
          /* ignore */
        }
      }

      const cleanup = (resultValue) => {
        stdin.off('data', onData);
        if (typeof stdin.setRawMode === 'function') {
          try {
            stdin.setRawMode(wasRawMode);
          } catch {
            /* ignore */
          }
        }
        if (renderedLines > 0) {
          try {
            readline.moveCursor(stdout, 0, -renderedLines);
          } catch {
            /* ignore */
          }
          try {
            readline.cursorTo(stdout, 0);
          } catch {
            /* ignore */
          }
          try {
            readline.clearScreenDown(stdout);
          } catch {
            /* ignore */
          }
        }
        const resumeMainRl = () => {
          if (rl && typeof rl.resume === 'function') {
            try {
              rl.resume();
            } catch {
              /* ignore */
            }
          }
        };
        // Handle "Other" — prompt for free text
        if (resultValue === '__other__') {
          // Keep main REPL paused while collecting free input.
          // Resuming it too early causes duplicate key handling.
          const rl2 = readline.createInterface({ input: stdin, output: stdout });
          rl2.question(c().dim('  Enter custom text: '), (text) => {
            rl2.close();
            try {
              stdin.resume();
            } catch {
              /* ignore */
            }
            resumeMainRl();
            resolve(text.trim() || null);
          });
          return;
        }
        resumeMainRl();
        resolve(resultValue);
      };

      const render = () => {
        if (renderedLines > 0) {
          try {
            readline.moveCursor(stdout, 0, -renderedLines);
          } catch {
            /* ignore */
          }
          try {
            readline.cursorTo(stdout, 0);
          } catch {
            /* ignore */
          }
          try {
            readline.clearScreenDown(stdout);
          } catch {
            /* ignore */
          }
        }
        const lines = [];
        // Display header chip if present
        const headerPrefix = header ? c().bgCyan.black.bold(` ${header} `) + ' ' : '';
        lines.push(`  ${headerPrefix}${c().hex(THEME.warning).bold(question)}`);

        // Side-by-side layout when preview exists
        if (hasPreview && choices[selected].preview) {
          const preview = choices[selected].preview;
          const maxWidth = stdout.columns || 80;
          const leftWidth = Math.floor(maxWidth * 0.5);

          // Left panel: options
          for (let i = 0; i < choices.length; i++) {
            const marker = i === selected ? c().hex(PURPLE)('\u276F') : ' ';
            const num = `${i + 1}.`;
            const label = i === selected ? c().bold(choices[i].label) : choices[i].label;
            lines.push(`   ${marker} ${num} ${label}`);
          }
          lines.push('');
          lines.push(`  ${c().dim('\u2191/\u2193 navigate \u00B7 Enter select \u00B7 Esc skip')}`);
          lines.push('');
          lines.push(`  ${c().dim('Preview:')}`);
          // Right panel: preview content (simplified - actual side-by-side requires more complex layout)
          const previewLines = preview.split('\n').slice(0, 10); // Limit preview height
          for (const pl of previewLines) {
            // Width-aware truncation so CJK preview lines do not overflow the
            // panel (a raw char slice would render up to 2\u00d7 the column budget).
            lines.push(`  ${c().gray('\u2502')} ${truncateToWidth(pl, maxWidth - 6)}`);
          }
        } else {
          // Standard vertical layout
          for (let i = 0; i < choices.length; i++) {
            const marker = i === selected ? c().hex(PURPLE)('\u276F') : ' ';
            const num = `${i + 1}.`;
            const label = i === selected ? c().bold(choices[i].label) : choices[i].label;
            lines.push(`   ${marker} ${num} ${label}`);
          }
          lines.push('');
          lines.push(`  ${c().dim('Use arrow keys to navigate, Enter to select, Esc to skip')}`);
        }
        stdout.write(`${lines.join('\n')}\n`);
        renderedLines = lines.length;
      };

      const onData = (chunk) => {
        const key = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        // Esc or Ctrl+C → cancel
        if (key === '\u0003' || key === '\u001b') {
          cleanup(null);
          return;
        }
        // Arrow up
        if (key === '\u001b[A') {
          selected = (selected - 1 + choices.length) % choices.length;
          render();
          return;
        }
        // Arrow down
        if (key === '\u001b[B') {
          selected = (selected + 1) % choices.length;
          render();
          return;
        }
        // Tab
        if (key === '\t') {
          selected = (selected + 1) % choices.length;
          render();
          return;
        }
        // Enter
        if (key === '\r' || key === '\n') {
          cleanup(choices[selected].value);
          return;
        }
        // Number keys for quick select
        if (key.length === 1 && key >= '1' && key <= '9') {
          const idx = parseInt(key, 10) - 1;
          if (idx >= 0 && idx < choices.length) {
            cleanup(choices[idx].value);
            return;
          }
        }
        // '0' → skip
        if (key === '0') {
          cleanup(null);
          return;
        }
      };

      try {
        stdin.resume();
      } catch {
        /* ignore */
      }
      try {
        stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
      stdin.on('data', onData);
      render();
    });
  }

  // Fallback for multiSelect or non-TTY: numbered list
  console.log('');
  console.log(c().hex(THEME.warning)(`  ? ${question}`));
  console.log('');

  options.forEach((opt, i) => {
    const num = c().cyan(`  [${i + 1}]`);
    const label = c().white(opt.label);
    const desc = opt.description ? c().dim(` — ${opt.description}`) : '';
    console.log(`${num} ${label}${desc}`);
  });
  console.log(c().dim(`  [${options.length + 1}] Other (free input)`));
  console.log(c().dim(`  [0] Skip`));
  console.log('');

  const rl =
    opts.rl ||
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  return new Promise((resolve) => {
    const prompt = opts.multiSelect
      ? c().dim('  Select (comma-separated, e.g. 1,3): ')
      : c().dim('  Select: ');

    rl.question(prompt, (answer) => {
      if (!opts.rl) {
        rl.close();
      }

      const trimmed = answer.trim();
      if (!trimmed || trimmed === '0') {
        resolve(null);
        return;
      }

      const lastIdx = options.length + 1;
      if (trimmed === String(lastIdx)) {
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl2.question(c().dim('  Enter: '), (text) => {
          rl2.close();
          resolve(text.trim() || null);
        });
        return;
      }

      if (opts.multiSelect) {
        const indices = trimmed.split(/[,，\s]+/).map((s) => parseInt(s, 10) - 1);
        const selected = indices
          .filter((i) => i >= 0 && i < options.length)
          .map((i) => options[i].label);
        resolve(selected.length > 0 ? selected : null);
      } else {
        const idx = parseInt(trimmed, 10) - 1;
        if (idx >= 0 && idx < options.length) {
          resolve(options[idx].label);
        } else {
          resolve(trimmed);
        }
      }
    });
  });
}

// ── AI Response Renderer ────────────────────────────────────────────────

// Full-width punctuation forbidden at a line start (中文行首禁则). When a wrap
// would push one of these to the head of the next line, it sticks to the end
// of the previous line instead, overflowing the width budget by ≤1 cell.
const _NO_HEAD_PUNCT = new Set(Array.from('，。、；：！？）】》〉』」”’…・'));

// SGR reset sequence appended at wrapped line ends so each emitted line is
// style-complete on its own (callers console.log lines independently).
const _SGR_RESET = '\x1b[0m';
const _ANSI_SPLIT_RE = /(\x1b\[[0-9;]*m)/;
const _ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g;

/**
 * Iterate a string yielding SGR escape sequences atomically and every other
 * codepoint one at a time, so an escape sequence can never be split.
 * @param {string} text
 */
function* _ansiAwareCodepoints(text) {
  for (const part of text.split(_ANSI_SPLIT_RE)) {
    if (part === '') {
      continue;
    }
    if (part.charCodeAt(0) === 0x1b) {
      yield { text: part, ansi: true };
    } else {
      for (const ch of part) {
        yield { text: ch, ansi: false };
      }
    }
  }
}

/**
 * Update the active SGR style list with sequences found in text.
 * A reset (\x1b[0m / \x1b[m or any all-zero params) clears the list; other
 * SGR sequences append so they can be replayed on continuation lines.
 * @param {string[]} active
 * @param {string} text
 */
function _trackSgr(active, text) {
  if (text.indexOf('\x1b') === -1) {
    return;
  }
  _ANSI_SGR_RE.lastIndex = 0;
  let m;
  while ((m = _ANSI_SGR_RE.exec(text))) {
    const params = m[1].split(';');
    if (params.every((p) => p === '' || p === '0')) {
      active.length = 0;
    } else {
      // A leading 0 (e.g. \x1b[0;31m) resets before applying new styles.
      if (params[0] === '' || params[0] === '0') {
        active.length = 0;
      }
      active.push(m[0]);
    }
  }
}

/**
 * Trim trailing whitespace that is only followed by SGR sequences while
 * keeping the sequences themselves in place.
 * @param {string} text
 * @returns {string}
 */
function _trimEndPreserveAnsi(text) {
  if (text.indexOf('\x1b') === -1) {
    return text.trimEnd();
  }
  let out = text;
  let m;
  while ((m = out.match(/\s+((?:\x1b\[[0-9;]*m)*)$/))) {
    out = out.slice(0, m.index) + m[1];
  }
  return out;
}

/**
 * Wrap a line at terminal width.
 * Width measurement delegates to formatters.displayWidth so CJK/full-width
 * handling stays consistent CLI-wide (no duplicated range tables here).
 *
 * Wrapping units (greedy fill — a unit that fits the remaining width is
 * NEVER pushed to the next line):
 * - a run of narrow non-space chars (Latin word, number, path) is one
 *   unbreakable unit; hard-split at codepoint level only when the unit
 *   itself is wider than a whole line;
 * - every wide (2-column) character — CJK ideographs, kana, full-width
 *   punctuation — is an independent breakable unit;
 * - zero-width chars (combining marks) attach to the preceding unit;
 * - full-width closing punctuation never lands at a line start (行首禁则):
 *   it sticks to the previous character, overflowing the budget by ≤1 cell.
 * Iteration is codepoint-based (for...of), so surrogate pairs are never
 * split. ANSI SGR escapes are preserved: they participate as zero-width
 * tokens, active styles are tracked while packing, every wrapped line gets
 * a trailing reset and the next line replays the active styles so each
 * emitted line is style-complete when logged independently.
 * Skips lines inside code blocks (prefixed with │) and bare-URL lines.
 * @param {string} line
 * @param {number} maxWidth
 * @returns {string}
 */
function wrapLine(line, maxWidth) {
  if (maxWidth <= 0) {
    return line;
  }
  // Strip ANSI for length measurement, use displayWidth for CJK support
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (displayWidth(stripped) <= maxWidth) {
    return line;
  }

  // Don't wrap code block lines (contain │ indicator)
  if (stripped.includes('│')) {
    return line;
  }

  // Don't wrap a pure horizontal-rule line (consecutive ─, possibly with an
  // ANSI dim prefix and leading indent). Its width intentionally tracks the
  // rail-aware render columns; a mid-rule newline would split it into the
  // "staircase" fragments. `stripped` is already ANSI-free, so this only matches
  // a line that is nothing but box-drawing horizontals and whitespace — normal
  // prose is never touched.
  if (/^\s*─+\s*$/.test(stripped)) {
    return line;
  }

  // Don't hard-wrap lines that are essentially a bare URL (optional leading
  // indent / list marker / numbering). Inserting a newline mid-URL would break
  // the link across terminal rows so a mouse drag only grabs the current row.
  // Leaving the line intact lets the terminal soft-wrap it as one logical line,
  // keeping the whole URL selectable in a single drag. The leading-marker class
  // covers raw markdown bullets/numbers *and* markdownLite's rendered `›` glyph.
  if (/^[\s›>\-*•\d.)、]*https?:\/\/\S+$/.test(stripped)) {
    return line;
  }

  // 中文散文行:不做硬换行,交给终端软折行(同 URL 情形的处理理由)。硬换行会在中文↔拉丁
  // 边界处 (a) 把边界空格吃成换行——「纯文本模型 deepseek-v4-flash」被拆成两行;(b) 让
  // 收尾标点「，。」」等落到下一行行首(违反中文行首禁则),两者都读作丑陋的句中断行。留整行
  // 让终端在真实边缘按逻辑整句软折行,同一句话得以「接着显示」。仅对含 CJK 的散文行生效——
  // 纯拉丁/代码/表格(含 │)行为逐字节不变。
  if (_CJK_LINE_RE.test(stripped)) {
    return line;
  }

  // Tokenize into units: whitespace runs stay single chars, narrow non-space
  // chars merge into word units, wide chars stand alone. ANSI SGR escapes
  // become zero-width units (or ride inside the word being built so a
  // mid-word style change never creates an artificial break opportunity).
  const units = [];
  let word = '';
  const flushWord = () => {
    if (word !== '') {
      // displayWidth strips ANSI, so embedded escapes contribute zero width.
      units.push({ text: word, width: displayWidth(word), kind: 'word' });
      word = '';
    }
  };
  for (const tok of _ansiAwareCodepoints(line)) {
    if (tok.ansi) {
      if (word !== '') {
        word += tok.text;
      } else {
        units.push({ text: tok.text, width: 0, kind: 'ansi' });
      }
      continue;
    }
    const ch = tok.text;
    const w = displayWidth(ch);
    if (/\s/.test(ch)) {
      flushWord();
      units.push({ text: ch, width: w, kind: 'space' });
    } else if (w >= 2) {
      flushWord();
      units.push({ text: ch, width: w, kind: 'wide' });
    } else if (w === 0) {
      // Combining mark: attach to whatever precedes it, contributing no width.
      if (word !== '') {
        word += ch;
      } else if (units.length > 0 && units[units.length - 1].kind !== 'ansi') {
        units[units.length - 1].text += ch;
      } else {
        word = ch;
      }
    } else {
      word += ch;
    }
  }
  flushWord();

  const lines = [];
  const activeStyles = [];
  let cur = '';
  let curW = 0;
  // Emptiness/indent checks must ignore replayed style prefixes.
  const hasVisible = () => _stripAnsi(cur).trimEnd() !== '';
  const append = (text, width) => {
    cur += text;
    curW += width;
    _trackSgr(activeStyles, text);
  };
  const flushLine = () => {
    let text = _trimEndPreserveAnsi(cur);
    // Close open styles so each emitted line stands alone, then replay them
    // at the start of the continuation line.
    if (activeStyles.length > 0) {
      text += _SGR_RESET;
    }
    lines.push(text);
    cur = activeStyles.join('');
    curW = 0;
  };

  for (const unit of units) {
    if (unit.kind === 'ansi') {
      // Zero-width: always fits, never wraps.
      append(unit.text, 0);
      continue;
    }
    if (unit.kind === 'space') {
      // Drop whitespace landing at the start of a continuation line; keep
      // original leading indentation on the first line.
      if (_stripAnsi(cur) === '' && lines.length > 0) {
        continue;
      }
      append(unit.text, unit.width);
      continue;
    }
    if (curW + unit.width <= maxWidth) {
      // Fits in the remaining width — never wrap a unit that fits.
      append(unit.text, unit.width);
      continue;
    }
    if (unit.kind === 'wide' && _NO_HEAD_PUNCT.has(unit.text[0]) && hasVisible()) {
      // Line-start-forbidden punctuation: keep it on the current line.
      append(unit.text, unit.width);
      continue;
    }
    if (unit.width > maxWidth) {
      // Single unit wider than a whole line: hard-split at codepoint level,
      // first filling whatever width remains on the current line. Escape
      // sequences embedded in the unit are kept atomic.
      for (const tok of _ansiAwareCodepoints(unit.text)) {
        if (tok.ansi) {
          append(tok.text, 0);
          continue;
        }
        const w = displayWidth(tok.text);
        if (curW + w > maxWidth && hasVisible()) {
          flushLine();
        }
        append(tok.text, w);
      }
      continue;
    }
    flushLine();
    append(unit.text, unit.width);
  }
  // Final line: keep the original trailing style state (no forced reset) so
  // lines that intentionally leave styles open behave as before wrapping.
  if (hasVisible()) {
    lines.push(_trimEndPreserveAnsi(cur));
  }

  return lines.join('\n');
}

function _stripAnsi(text = '') {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function _isUnicodeGuideEnabled() {
  const mode = String(process.env.KHY_UNICODE_GUIDE || 'auto')
    .trim()
    .toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(mode)) {
    return false;
  }
  if (['1', 'true', 'on', 'yes'].includes(mode)) {
    return true;
  }
  // auto: only when terminal width is reasonable.
  const cols = process.stdout.columns || 80;
  return cols >= 70;
}

function _getUnicodeGuideDensity() {
  const raw = String(process.env.KHY_UNICODE_GUIDE_DENSITY || 'box')
    .trim()
    .toLowerCase();
  if (raw === 'light' || raw === 'box' || raw === 'heavy') {
    return raw;
  }
  return 'box';
}

/**
 * Decorate response lines with lightweight Unicode guide markers.
 * Goal: improve scanability without altering semantics.
 */
function _decorateResponseWithUnicode(text) {
  if (!_isUnicodeGuideEnabled()) {
    return text;
  }
  const density = _getUnicodeGuideDensity();
  const lines = String(text || '').split('\n');
  const calloutKinds = [
    { pattern: /^(tip|提示|提示信息)[:：]\s*(.*)$/i, icon: '✦', label: 'Tip' },
    { pattern: /^(warning|警告|注意|风险)[:：]\s*(.*)$/i, icon: '⚠', label: 'Warning' },
    {
      pattern: /^(next step|下一步|建议|recommendation)[:：]\s*(.*)$/i,
      icon: '➜',
      label: 'Next Step',
    },
    { pattern: /^(summary|总结|结果|结论|conclusion)[:：]\s*(.*)$/i, icon: '✓', label: 'Summary' },
    { pattern: /^(example|示例|例子)[:：]\s*(.*)$/i, icon: '◉', label: 'Example' },
    { pattern: /^(note|说明|备注)[:：]\s*(.*)$/i, icon: '◌', label: 'Note' },
  ];

  function wrapUnicodeText(input, width) {
    const source = String(input || '').replace(/\r/g, '');
    if (!source) {
      return [''];
    }
    const result = [];
    for (const paragraph of source.split('\n')) {
      if (!paragraph) {
        result.push('');
        continue;
      }
      let current = '';
      let currentWidth = 0;
      for (const ch of Array.from(paragraph)) {
        const chWidth = displayWidth(ch);
        if (current && currentWidth + chWidth > width) {
          result.push(current);
          current = ch;
          currentWidth = chWidth;
        } else {
          current += ch;
          currentWidth += chWidth;
        }
      }
      if (current) {
        result.push(current);
      }
    }
    return result.length > 0 ? result : [''];
  }

  function buildCalloutBox(indent, icon, label, body) {
    // Rail-aware width (see renderAiResponse): boxes wider than the effective
    // container soft-wrap and break the border art.
    const cols = Math.max(40, _effectiveWrapCols() - 12);
    const maxInnerWidth = Math.max(18, Math.min(56, cols - 4));
    const title = `${icon} ${label}`;
    const bodyLines = wrapUnicodeText(body, maxInnerWidth);
    const widestBody = bodyLines.reduce((max, line) => Math.max(max, displayWidth(line)), 0);
    const innerWidth = Math.max(Math.min(maxInnerWidth, widestBody), displayWidth(title), 16);
    const heavy = density === 'heavy';
    const topLeft = heavy ? '┏' : '╭';
    const topRight = heavy ? '┓' : '╮';
    const bottomLeft = heavy ? '┗' : '╰';
    const bottomRight = heavy ? '┛' : '╯';
    const h = heavy ? '━' : '─';
    const v = heavy ? '┃' : '│';
    const top = `${indent}${topLeft}${h.repeat(innerWidth + 2)}${topRight}`;
    const titleLine = `${indent}${v} ${padToWidth(title, innerWidth)} ${v}`;
    const contentLines = bodyLines.map(
      (line) => `${indent}${v} ${padToWidth(line, innerWidth)} ${v}`
    );
    const bottom = `${indent}${bottomLeft}${h.repeat(innerWidth + 2)}${bottomRight}`;
    return [top, titleLine, ...contentLines, bottom].join('\n');
  }

  return lines
    .map((line) => {
      const plain = _stripAnsi(line);
      const trimmed = plain.trim();
      if (!trimmed) {
        return line;
      }

      // Preserve code/diff/table box rendering lines.
      if (/^\s*[│┌└├╭╰]/.test(plain)) {
        return line;
      }
      if (/^\s*[-+@]{3,}/.test(trimmed)) {
        return line;
      }

      const indent = (plain.match(/^(\s*)/) || [])[1] || '';
      const withPrefix = (mark) => line.replace(/^(\s*)/, `$1${mark} `);

      for (const kind of calloutKinds) {
        const m = trimmed.match(kind.pattern);
        if (m) {
          const body = String(m[2] || '').trim();
          const fallbackBody = body || trimmed.replace(kind.pattern, '$2').trim() || '';
          if (density === 'light') {
            return `${indent}${kind.icon} ${kind.label}: ${fallbackBody}`;
          }
          return buildCalloutBox(indent, kind.icon, kind.label, fallbackBody);
        }
      }

      if (/^(注意|警告|warning|风险)[:：]/i.test(trimmed)) {
        return withPrefix('⚠');
      }
      if (/^(提示|tip)[:：]/i.test(trimmed)) {
        return withPrefix('*');
      }
      if (/^(结果|结论|summary|总结)[:：]/i.test(trimmed)) {
        return withPrefix('✓');
      }
      if (/^(下一步|建议|next|recommendation)[:：]/i.test(trimmed)) {
        return withPrefix('>');
      }
      if (/^(原因|reason)[:：]/i.test(trimmed)) {
        return withPrefix('-');
      }
      if (/^(命令|command)[:：]/i.test(trimmed)) {
        return withPrefix('$');
      }

      return line;
    })
    .join('\n');
}

// NOTE: a previous revision scraped tool-call-looking prose lines (e.g.
// `Read(path=...)`) out of the model's final answer and rendered them as an
// authoritative "工具步骤" table. That made the displayed process steps depend on
// what the model merely *wrote*, not on what was actually executed. Process steps
// are now driven solely by structured tool_use events during the loop
// (repl.js/toolDisplay/useQueryBridge); the final-answer renderer no longer
// fabricates a step table from prose. See [project_structured_results_audit].

/**
 * Render a complete AI response with all formatting.
 * @param {string} text - raw AI response text
 * @param {object} [opts]
 * @param {object} [opts.chalk] - chalk instance
 * @returns {string} rendered text for console output
 */
function renderAiResponse(text) {
  if (!text) {
    return '';
  }

  // 输出层软 bug 主动监听(goal 2026-06-25):REPL 的单一收口。在任何 markdown/diff/wrap
  // 变换之前,对**原始模型文本**检测并简单修复乱码(strip 零星 U+FFFD)与未闭合代码围栏;
  // 不可修复(整段乱码)落错误日志。render:true 永不抛(抛会把要展示的回答整段弄没)。
  // fail-soft:监听器缺失/异常直接用原文继续。TUI 走 Transcript.normalizeCommitted,二者对称。
  try {
    text = require('../services/outputIntegrityMonitor').guardText(text, {
      source: 'repl-render',
      render: true,
    }).text;
  } catch {
    /* monitor absent/erroring — render raw text unchanged */
  }

  // First handle diff blocks
  let rendered = renderResponseWithDiffs(text);

  // Then apply markdown-lite. Pass the SAME rail-aware width the wrapLine pass
  // below measures against (_effectiveWrapCols), so a horizontal rule (---, ***,
  // ___) is generated at the rail-aware column count instead of the full terminal
  // width; otherwise the rule is wider than the wrap budget and wrapLine breaks
  // it into the "staircase" fragments when a sidebar/rail is active.
  rendered = renderMarkdownLite(rendered, _effectiveWrapCols());

  // Add lightweight Unicode guidance markers where useful.
  rendered = _decorateResponseWithUnicode(rendered);

  // Word-wrap long lines to the EFFECTIVE width (rail-aware single source:
  // effectiveCols already subtracts the right-rail reserved columns via
  // railLayout.contentCols; measuring against the raw terminal width made
  // lines soft-wrap inside the narrower container and look truncated).
  const cols = _effectiveWrapCols() - 6; // leave margin for │ prefix
  if (cols > 20) {
    rendered = rendered
      .split('\n')
      .map((l) => wrapLine(l, cols))
      .join('\n');
  }

  // 排版间距后处理：呼吸感
  rendered = _normalizeSpacing(rendered);

  return rendered;
}

/**
 * 排版间距后处理 — 增加内容块之间的呼吸感。
 * - 标题前确保空行（如果前一行非空）
 * - 代码块边框前后确保空行
 * - 连续 3+ 空行压缩为 2 行
 */
function _normalizeSpacing(text) {
  const lines = text.split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = _stripAnsiForSpacing(line);
    const prevStripped = i > 0 ? _stripAnsiForSpacing(result[result.length - 1] || '') : '';
    const prevIsBlank = prevStripped.trim() === '';

    // 标题行 (━━ / – ) 或代码块顶部 (╭─) 前插入空行
    if (
      !prevIsBlank &&
      (/^\s*━━/.test(stripped) || /^\s*–\s/.test(stripped) || /^\s*╭─/.test(stripped))
    ) {
      result.push('');
    }

    result.push(line);

    // 代码块底部 (╰─) 或分隔线 (━━.*━━) 后确保下一行不紧贴
    // (在下一轮迭代的 prevIsBlank 检查中自然处理)
  }

  // 压缩连续 3+ 空行为 2 行
  const compressed = [];
  let blankCount = 0;
  for (const line of result) {
    if (line.trim() === '') {
      blankCount++;
      if (blankCount <= 2) {
        compressed.push(line);
      }
    } else {
      blankCount = 0;
      compressed.push(line);
    }
  }
  return compressed.join('\n');
}

// 收敛到 utils/stripAnsi 单一真源(逐字节委托,调用点不变)
const _stripAnsiForSpacing = require('../utils/stripAnsi');

// ── Panels (extracted to ./panels.js) ────────────────────────────────
const {
  TaskPlanTracker,
  InitPhaseTracker,
  printExecutionBrief,
  collapseExecutionBrief,
  printCompletionPanel,
  printCollapseCounter,
} = require('./panels');

// ── Tool Display (extracted to ./toolDisplay.js) ─────────────────────
const _toolDisplayAll = require('./toolDisplay');
// Separate public exports (to spread into module.exports) from internal helpers
const {
  _expandableOutputs: _td_expandableOutputs,
  _escapeRegex: _td_escapeRegex,
  _extractParamValue: _td_extractParamValue,
  _truncateText: _td_truncateText,
  _truncateDisplayWidth: _td_truncateDisplayWidth,
  _truncateNaturalText: _td_truncateNaturalText,
  _sanitizeToolTableCell: _td_sanitizeToolTableCell,
  _extractLooseToolParams: _td_extractLooseToolParams,
  _coerceToolParams: _td_coerceToolParams,
  ...toolDisplay
} = _toolDisplayAll;

// ── Transparency Integration ──────────────────────────────────────────
// Extracted to ./transparency.js — thin wrappers over transparencyService.
const transparency = require('./transparency');

module.exports = {
  setInteractiveGuard,
  DynamicSpinner,
  ProcessTracker,
  TaskPlanTracker,
  // Tool display (extracted to ./toolDisplay.js)
  ...toolDisplay,
  renderDiff,
  renderStructuredDiff,
  renderResponseWithDiffs,
  renderMarkdownLite,
  renderAiResponse,
  renderUserMessage,
  askInlineQuestion,
  printStepLine,
  printStepDetail,
  printCompactingNotice,
  printProcessStep,
  printToolCall,
  printActionHint,
  printThinkingStep,
  startSparkle,
  getToolDisplayName,
  getToolFamilyIcon,
  getToolKindLabel,
  normalizeToolKind,
  THEME,
  PHASE_LABELS,
  TOOL_DISPLAY_NAMES,
  TOOL_FAMILY_ICONS,
  DOT_PENDING,
  DOT_INDICATOR,
  DOT_SUCCESS,
  DOT_ERROR,
  DOT_DONE,
  TASK_PENDING,
  TASK_IN_PROGRESS,
  TASK_COMPLETED,
  SPINNER_FRAMES,
  TREE_LAST,
  TREE_MID,
  isInteractiveInputActive,
  renderMermaidBlock: _renderMermaidBlock,
  // Completion & collapse
  InitPhaseTracker,
  printExecutionBrief,
  collapseExecutionBrief,
  printCompletionPanel,
  printCollapseCounter,
  // Transparency layer
  ...transparency,
};

// Self-register the compaction-result renderer on the neutral UI port so the
// services layer (contextCompressor) prints results without a reverse require
// (DESIGN-ARCH-021, Batch 2). Legit cli → services direction; exports unchanged.
try {
  require('../services/compactionUiPort').registerCompactionResultRenderer(
    module.exports.printCompactionResult
  );
} catch {
  /* port unavailable — services degrade to no-op */
}
