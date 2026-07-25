'use strict';

/**
 * Ink UI Components — React-like composable CLI rendering.
 *
 * Provides reusable UI components for the KHY CLI interface.
 * Uses a lightweight component model inspired by Ink (React for CLI).
 *
 * Unlike full Ink, this module:
 *   - No JSX/transpilation required
 *   - Pure Node.js, zero external dependencies
 *   - Compatible with existing chalk-based rendering
 *   - Progressive adoption: use alongside existing formatters
 *
 * Components:
 *   - Box: Flexible container with padding, borders, alignment
 *   - Text: Styled text with chalk integration
 *   - Spinner: Animated spinner with label
 *   - ProgressBar: Horizontal bar with percentage
 *   - Table: Auto-sizing table with headers
 *   - Select: Interactive single/multi-select menu
 *   - TextInput: Single-line text input
 *   - StatusBar: Persistent bottom status line
 *
 * @module inkComponents
 */

const readline = require('readline');

let chalk;
try { chalk = require('chalk'); } catch { chalk = { bold: (t) => t, dim: (t) => t, green: (t) => t, red: (t) => t, yellow: (t) => t, cyan: (t) => t, blue: (t) => t, gray: (t) => t, white: (t) => t, hex: () => (t) => t, bgRed: (t) => t, bgGreen: (t) => t, bgYellow: (t) => t, bgBlue: (t) => t, bgCyan: (t) => t, bgHex: () => (t) => t, strikethrough: (t) => t, underline: (t) => t, italic: (t) => t }; }

// ── Box Component ──

/**
 * Render a box with borders and padding.
 *
 * @param {object} props
 * @param {string} props.content - Box content (multi-line)
 * @param {string} [props.title] - Optional title in top border
 * @param {string} [props.borderStyle] - 'single' | 'double' | 'round' | 'none'
 * @param {number} [props.padding] - Internal padding
 * @param {number} [props.width] - Fixed width (auto if omitted)
 * @param {'left'|'center'|'right'} [props.align] - Content alignment
 * @param {string} [props.borderColor] - Chalk color for border
 * @returns {string}
 */
function Box(props) {
  const {
    content = '',
    title = '',
    borderStyle = 'single',
    padding = 0,
    width,
    align = 'left',
    borderColor,
  } = props;

  const lines = content.split('\n');
  const pad = ' '.repeat(padding);

  // Calculate width
  const contentWidth = width
    ? width - 2 - padding * 2
    : Math.max(...lines.map((l) => _stripAnsi(l).length), title.length + 4);

  const chars = _getBorderChars(borderStyle);
  const colorFn = borderColor ? (chalk.hex ? chalk.hex(borderColor) : chalk.white) : chalk.dim;

  const output = [];

  // Top border
  let topLine = chars.tl + chars.h.repeat(contentWidth + padding * 2) + chars.tr;
  if (title) {
    const titleStr = ` ${title} `;
    topLine = chars.tl + chars.h + titleStr + chars.h.repeat(Math.max(0, contentWidth + padding * 2 - titleStr.length - 1)) + chars.tr;
  }
  output.push(colorFn(topLine));

  // Padding top
  for (let i = 0; i < padding; i++) {
    output.push(colorFn(chars.v) + ' '.repeat(contentWidth + padding * 2) + colorFn(chars.v));
  }

  // Content lines
  for (const line of lines) {
    const stripped = _stripAnsi(line);
    const padded = _align(line, stripped.length, contentWidth, align);
    output.push(colorFn(chars.v) + pad + padded + pad + colorFn(chars.v));
  }

  // Padding bottom
  for (let i = 0; i < padding; i++) {
    output.push(colorFn(chars.v) + ' '.repeat(contentWidth + padding * 2) + colorFn(chars.v));
  }

  // Bottom border
  output.push(colorFn(chars.bl + chars.h.repeat(contentWidth + padding * 2) + chars.br));

  return output.join('\n');
}

// ── Text Component ──

/**
 * Render styled text.
 *
 * @param {string} content
 * @param {object} [style]
 * @param {boolean} [style.bold]
 * @param {boolean} [style.dim]
 * @param {boolean} [style.italic]
 * @param {boolean} [style.underline]
 * @param {string} [style.color] - Chalk color name or hex
 * @param {string} [style.bg] - Background color
 * @returns {string}
 */
function Text(content, style) {
  if (!style) return content;
  let result = content;
  if (style.bold) result = chalk.bold(result);
  if (style.dim) result = chalk.dim(result);
  if (style.italic && chalk.italic) result = chalk.italic(result);
  if (style.underline && chalk.underline) result = chalk.underline(result);
  if (style.color) {
    const fn = chalk[style.color] || (chalk.hex ? chalk.hex(style.color) : null);
    if (fn) result = fn(result);
  }
  if (style.bg) {
    const bgKey = 'bg' + style.bg.charAt(0).toUpperCase() + style.bg.slice(1);
    if (chalk[bgKey]) result = chalk[bgKey](result);
  }
  return result;
}

// ── Spinner Component ──

const { isLegacyWinTerminal: _isLegacyWin } = require('../../tools/platformUtils');
const SPINNER_FRAMES = _isLegacyWin()
  ? ['-', '\\', '|', '/']
  : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Create an animated spinner.
 *
 * @param {object} props
 * @param {string} [props.label] - Text next to spinner
 * @param {string} [props.color] - Spinner color
 * @param {number} [props.interval] - Frame interval in ms (default 80)
 * @returns {{start(), stop(), update(label), succeed(label), fail(label)}}
 */
function Spinner(props) {
  const { label = '', color = 'cyan', interval = 80 } = props || {};

  let frame = 0;
  let timer = null;
  let currentLabel = label;
  const colorFn = chalk[color] || chalk.cyan;

  function render() {
    const spinner = colorFn(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    process.stderr.write(`\r  ${spinner} ${currentLabel}  `);
    frame++;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(render, interval);
      render();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      process.stderr.write('\r' + ' '.repeat(currentLabel.length + 10) + '\r');
    },
    update(newLabel) {
      currentLabel = newLabel;
    },
    succeed(msg) {
      this.stop();
      const ok = _isLegacyWin() ? '+' : '✓';
      console.log(`  ${chalk.green(ok)} ${msg || currentLabel}`);
    },
    fail(msg) {
      this.stop();
      const fail = _isLegacyWin() ? 'x' : '✗';
      console.log(`  ${chalk.red(fail)} ${msg || currentLabel}`);
    },
  };
}

// ── ProgressBar Component ──

/**
 * Render a progress bar.
 *
 * @param {object} props
 * @param {number} props.value - Current value (0-100)
 * @param {number} [props.width] - Bar width in chars (default 30)
 * @param {string} [props.label] - Label text
 * @param {boolean} [props.showPercent] - Show percentage (default true)
 * @param {string} [props.completeChar] - Filled char (default █)
 * @param {string} [props.incompleteChar] - Empty char (default ░)
 * @returns {string}
 */
function ProgressBar(props) {
  const {
    value = 0,
    width = 30,
    label = '',
    showPercent = true,
    completeChar = _isLegacyWin() ? '#' : '█',
    incompleteChar = _isLegacyWin() ? '-' : '░',
  } = props;

  const pct = Math.max(0, Math.min(100, value));
  const filled = Math.round(pct / 100 * width);
  const empty = width - filled;

  const bar = chalk.green(completeChar.repeat(filled)) + chalk.gray(incompleteChar.repeat(empty));
  const percentStr = showPercent ? chalk.dim(` ${Math.round(pct)}%`) : '';
  const labelStr = label ? `${label} ` : '';

  return `  ${labelStr}${bar}${percentStr}`;
}

// ── Table Component ──

/**
 * Render a formatted table.
 *
 * @param {object} props
 * @param {string[]} props.headers - Column headers
 * @param {string[][]} props.rows - Data rows
 * @param {number[]} [props.widths] - Column widths (auto if omitted)
 * @param {'left'|'center'|'right'} [props.align] - Default alignment
 * @returns {string}
 */
function Table(props) {
  const { headers = [], rows = [], widths, align = 'left' } = props;

  // Auto-calculate widths
  const colWidths = widths || headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => {
      const cell = _stripAnsi(String(row[i] || ''));
      return Math.max(max, cell.length);
    }, 0);
    return Math.max(_stripAnsi(h).length, maxData, 3);
  });

  const lines = [];

  // Header
  const headerLine = headers.map((h, i) =>
    chalk.bold(_padCell(h, colWidths[i], align))
  ).join(chalk.dim(' │ '));
  lines.push('  ' + headerLine);

  // Separator
  const sep = colWidths.map((w) => '─'.repeat(w)).join('─┼─');
  lines.push(chalk.dim('  ' + sep));

  // Rows
  for (const row of rows) {
    const cells = row.map((cell, i) =>
      _padCell(String(cell || ''), colWidths[i], align)
    ).join(chalk.dim(' │ '));
    lines.push('  ' + cells);
  }

  return lines.join('\n');
}

// ── Select Component ──

/**
 * Interactive select menu.
 *
 * @param {object} props
 * @param {string} props.message - Prompt message
 * @param {Array<{label: string, value: any, description?: string}>} props.options
 * @param {boolean} [props.multi] - Multi-select mode
 * @param {boolean} [props.allowOther=false] - Append "其他(自由输入)" option (G5)
 * @param {boolean} [props.fuzzy=false] - Enable fuzzy filter when options≥5 (G4)
 * @returns {Promise<any>} Selected value(s)
 */
function Select(props) {
  const { message, options: rawOptions, multi = false, allowOther = false, fuzzy: forceFuzzy = false } = props;
  const { isLegacyWinTerminal } = require('../../tools/platformUtils');
  const _legacyWin = isLegacyWinTerminal();
  const CURSOR_CHAR = _legacyWin ? '>' : '❯';
  const SELECTED_CHAR = _legacyWin ? '(*)' : '◉';
  const UNSELECTED_CHAR = _legacyWin ? '( )' : '○';

  // G5: append "Other" option
  const OTHER_SENTINEL = '__khy_other__';
  const allOptions = allowOther
    ? [...rawOptions, { label: '其他 (自由输入)', value: OTHER_SENTINEL, description: '' }]
    : [...rawOptions];

  // G4: enable fuzzy filter when options ≥ 5
  const fuzzyEnabled = forceFuzzy || allOptions.length >= 5;

  return new Promise((resolve) => {
    let cursor = 0;
    const selected = new Set();
    let filterText = '';
    let filtered = allOptions;        // visible options after fuzzy filter
    let filteredIndices = allOptions.map((_, i) => i); // map filtered→allOptions index

    function _applyFilter() {
      if (!fuzzyEnabled || !filterText) {
        filtered = allOptions;
        filteredIndices = allOptions.map((_, i) => i);
      } else {
        const lower = filterText.toLowerCase();
        filtered = [];
        filteredIndices = [];
        for (let i = 0; i < allOptions.length; i++) {
          const lbl = allOptions[i].label.toLowerCase();
          const desc = (allOptions[i].description || '').toLowerCase();
          if (lbl.includes(lower) || desc.includes(lower) || allOptions[i].value === OTHER_SENTINEL) {
            filtered.push(allOptions[i]);
            filteredIndices.push(i);
          }
        }
      }
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let _lastRenderLines = 0; // 追踪上次渲染行数（含 preview），用于光标回退

    // G9: preview 面板 — 终端宽度≥80 时显示选中项的 preview 内容
    const _previewEnabled = (process.stdout.columns || 80) >= 80;

    function render() {
      process.stdout.write('\x1B[?25l'); // Hide cursor
      // 清除上次渲染内容
      if (_lastRenderLines > 0) {
        // 从当前位置清除上次渲染的所有行
      }
      const filterHint = fuzzyEnabled ? chalk.dim(`  (输入过滤${filterText ? `: ${filterText}` : ''})`) : '';
      process.stdout.write(`\r\x1B[K  ${chalk.bold(message)}${filterHint}\n`);

      let totalLines = 1; // 标题行

      for (let i = 0; i < filtered.length; i++) {
        const opt = filtered[i];
        const isCursor = i === cursor;
        const realIdx = filteredIndices[i];
        const isSelected = selected.has(realIdx);

        let prefix = isCursor ? chalk.cyan(CURSOR_CHAR + ' ') : '  ';
        if (multi) {
          prefix += isSelected ? chalk.green(SELECTED_CHAR + ' ') : chalk.dim(UNSELECTED_CHAR + ' ');
        }

        const label = isCursor ? chalk.cyan(opt.label) : opt.label;
        const desc = opt.description ? chalk.dim(` — ${opt.description}`) : '';
        process.stdout.write(`\x1B[K${prefix}${label}${desc}\n`);
        totalLines++;
      }

      // G9: preview 区域（选中项的 preview 字段，下方显示）
      let previewLines = 0;
      if (_previewEnabled && filtered[cursor]?.preview) {
        const previewText = String(filtered[cursor].preview);
        const pLines = previewText.split('\n').slice(0, 6); // 最多 6 行
        process.stdout.write(`\x1B[K${chalk.dim('  ─── 预览 ───')}\n`);
        previewLines++;
        for (const pl of pLines) {
          process.stdout.write(`\x1B[K  ${chalk.dim(pl)}\n`);
          previewLines++;
        }
      }

      totalLines += previewLines;
      _lastRenderLines = totalLines;

      // Move cursor back up
      process.stdout.write(`\x1B[${totalLines}A`);
    }

    function cleanup() {
      try {
        process.stdout.write('\x1B[?25h'); // Show cursor
        // 清除所有渲染行
        for (let i = 0; i < _lastRenderLines; i++) {
          process.stdout.write(`\x1B[B\x1B[K`);
        }
        process.stdout.write('\r');
      } catch { /* 终端已关闭 */ }
      rl.close();
    }

    // G5: prompt for free-text input when "Other" is selected
    async function _promptOther() {
      const otherRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((res) => {
        otherRl.question(chalk.cyan('  请输入自定义值: '), (answer) => {
          otherRl.close();
          res(answer.trim() || null);
        });
      });
    }

    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    render();

    process.stdin.on('keypress', async (ch, key) => {
      if (!key) return;

      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + filtered.length) % filtered.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % filtered.length;
        render();
      } else if (key.name === 'space' && multi) {
        const realIdx = filteredIndices[cursor];
        if (selected.has(realIdx)) selected.delete(realIdx);
        else selected.add(realIdx);
        render();
      } else if (key.name === 'return') {
        cleanup();
        if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false);
        if (multi) {
          resolve([...selected].map((i) => allOptions[i].value));
        } else {
          const val = filtered[cursor]?.value;
          if (val === OTHER_SENTINEL) {
            // G5: 自由输入模式
            const custom = await _promptOther();
            resolve(custom);
          } else {
            resolve(val ?? null);
          }
        }
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false);
        resolve(null);
      } else if (key.name === 'backspace' && fuzzyEnabled) {
        // G4: 退格删除过滤字符
        filterText = filterText.slice(0, -1);
        _applyFilter();
        render();
      } else if (fuzzyEnabled && ch && ch.length === 1 && !key.ctrl && !key.meta) {
        // G4: 输入字符过滤
        filterText += ch;
        _applyFilter();
        render();
      }
    });
  });
}

// ── StatusBar Component ──

/**
 * Create a persistent status bar at the bottom of the terminal.
 *
 * @param {object} props
 * @param {string} [props.left] - Left-aligned text
 * @param {string} [props.center] - Center text
 * @param {string} [props.right] - Right-aligned text
 * @param {string} [props.bg] - Background color
 * @returns {{update(props), destroy()}}
 */
function StatusBar(props) {
  let currentProps = props || {};
  let active = true;

  function render() {
    if (!active || !process.stdout.isTTY) return;

    const cols = process.stdout.columns || 80;
    const left = currentProps.left || '';
    const center = currentProps.center || '';
    const right = currentProps.right || '';

    const leftLen = _stripAnsi(left).length;
    const centerLen = _stripAnsi(center).length;
    const rightLen = _stripAnsi(right).length;

    const gap1 = Math.max(1, Math.floor((cols - leftLen - centerLen - rightLen) / 2));
    const gap2 = Math.max(1, cols - leftLen - gap1 - centerLen - rightLen);

    let line = left + ' '.repeat(gap1) + center + ' '.repeat(gap2) + right;
    line = line.substring(0, cols);

    const bgFn = currentProps.bg ? (chalk.bgHex ? chalk.bgHex(currentProps.bg) : chalk.bgBlue) : chalk.bgBlue;

    // Save cursor, move to bottom, render, restore cursor
    process.stdout.write(`\x1B7\x1B[${process.stdout.rows};1H${bgFn(chalk.white(line))}\x1B8`);
  }

  render();

  return {
    update(newProps) {
      currentProps = { ...currentProps, ...newProps };
      render();
    },
    destroy() {
      active = false;
      if (process.stdout.isTTY) {
        process.stdout.write(`\x1B[${process.stdout.rows};1H\x1B[K`);
      }
    },
  };
}

// ── Layout Helpers ──

/**
 * Render components vertically (column layout).
 * @param {...string} components
 * @returns {string}
 */
function VStack(...components) {
  return components.filter(Boolean).join('\n');
}

/**
 * Render components horizontally (row layout).
 * @param {string[]} components
 * @param {number} [gap] - Space between components
 * @returns {string}
 */
function HStack(components, gap) {
  const g = ' '.repeat(gap || 2);
  const lines = components.map((c) => (c || '').split('\n'));
  const maxLines = Math.max(...lines.map((l) => l.length));

  const result = [];
  for (let i = 0; i < maxLines; i++) {
    result.push(lines.map((l) => l[i] || '').join(g));
  }
  return result.join('\n');
}

// ── Internal Helpers ──

function _getBorderChars(style) {
  switch (style) {
    case 'double': return { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };
    case 'round':  return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
    case 'none':   return { tl: ' ', tr: ' ', bl: ' ', br: ' ', h: ' ', v: ' ' };
    case 'single':
    default:       return { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
  }
}

function _stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function _align(str, strippedLen, width, align) {
  const gap = Math.max(0, width - strippedLen);
  switch (align) {
    case 'center': {
      const left = Math.floor(gap / 2);
      return ' '.repeat(left) + str + ' '.repeat(gap - left);
    }
    case 'right':
      return ' '.repeat(gap) + str;
    default:
      return str + ' '.repeat(gap);
  }
}

function _padCell(str, width, align) {
  const stripped = _stripAnsi(str);
  const gap = Math.max(0, width - stripped.length);
  if (align === 'right') return ' '.repeat(gap) + str;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + str + ' '.repeat(gap - left);
  }
  return str + ' '.repeat(gap);
}

// ── Sparkline ───────────────────────────────────────────────────────────

const SPARK_CHARS = _isLegacyWin() ? ' .:=|$#@' : '▁▂▃▄▅▆▇█';

/**
 * Inline mini-chart using block characters (8-level height).
 *
 * @param {{ data: number[], width?: number, color?: string, label?: string, min?: number, max?: number }} props
 * @returns {string}
 */
function Sparkline(props) {
  const { data = [], width, color, label } = props;
  if (!data.length) return label ? `  ${label} (no data)` : '  (no data)';

  const lo = props.min !== undefined ? props.min : Math.min(...data);
  const hi = props.max !== undefined ? props.max : Math.max(...data);
  const range = hi - lo || 1;

  // Downsample if width specified and smaller than data length
  let samples = data;
  const maxW = width || Math.min(data.length, (process.stdout.columns || 80) - 10);
  if (data.length > maxW) {
    samples = [];
    const step = data.length / maxW;
    for (let i = 0; i < maxW; i++) {
      const idx = Math.min(Math.floor(i * step), data.length - 1);
      samples.push(data[idx]);
    }
  }

  let line = samples.map(v => {
    const idx = Math.round(((v - lo) / range) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[Math.max(0, Math.min(SPARK_CHARS.length - 1, idx))];
  }).join('');

  if (color) {
    try { line = chalk.hex(color)(line); } catch { /* ignore invalid color */ }
  }

  const loStr = chalk.dim(lo.toFixed(1));
  const hiStr = chalk.dim(hi.toFixed(1));
  const labelStr = label ? `${label} ` : '';
  return `  ${labelStr}${loStr} ${line} ${hiStr}`;
}

// ── BarChart ────────────────────────────────────────────────────────────

/**
 * Horizontal bar chart with auto-colored bars.
 *
 * @param {{ items: Array<{label: string, value: number, color?: string, maxValue?: number}>, width?: number, showValue?: boolean }} props
 * @returns {string}
 */
function BarChart(props) {
  const { items = [], showValue = true } = props;
  if (!items.length) return '  (no data)';

  const barWidth = props.width || Math.min(20, Math.max(10, ((process.stdout.columns || 80) - 30)));
  const maxLabel = Math.max(...items.map(it => _stripAnsi(it.label).length));
  const globalMax = Math.max(...items.map(it => it.maxValue || it.value), 1);

  const lines = items.map(it => {
    const pct = Math.max(0, Math.min(100, (it.value / globalMax) * 100));
    const filled = Math.round(pct / 100 * barWidth);
    const empty = barWidth - filled;

    const barColor = it.color
      ? (str => { try { return chalk.hex(it.color)(str); } catch { return str; } })
      : pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;

    const _lw = _isLegacyWin();
    const bar = barColor((_lw ? '#' : '█').repeat(filled)) + chalk.dim((_lw ? '-' : '░').repeat(empty));
    const lbl = _align(it.label, _stripAnsi(it.label).length, maxLabel, 'right');
    const val = showValue ? chalk.dim(` ${Math.round(pct)}%`) : '';
    return `  ${lbl}  ${bar}${val}`;
  });

  return lines.join('\n');
}

// ── selectMenu — 统一菜单选择器入口 ──
// 兼容 inquirer.prompt({ type:'list' }) 的调用接口，
// 但使用 inkComponents.Select 零依赖实现。
// 降级：当 stdin 不是 TTY 时回退到 inquirer。

/**
 * @param {object} opts
 * @param {string} opts.message — 提示文本
 * @param {Array<{name:string, value:*, description?:string}>} opts.choices — 选项列表
 * @param {boolean} [opts.multi=false] — 多选模式
 * @param {boolean} [opts.allowOther=false] — 追加"其他"自由输入选项 (G5)
 * @param {boolean} [opts.fuzzy] — 强制启用/禁用模糊过滤 (G4, 默认选项≥5自动启用)
 * @returns {Promise<*>} — 选中值，取消返回 null
 */
async function selectMenu({ message, choices, multi = false, allowOther = false, fuzzy }) {
  // When the Ink TUI owns the terminal, the raw-readline Select below would grab
  // process.stdin in cooked mode and topple the managed UI (same hazard as
  // inquirer). Route through the single native bridge (promptCompat → FormFlow)
  // so there is one prompt path, not two competing ones. fuzzy filtering has no
  // FormFlow equivalent and is simply not applied here (all rows are listed).
  const { isTuiActive, promptCompat } = require('../uiPrompt');
  if (isTuiActive()) {
    const OTHER = '__khy_other__';
    const bridgeChoices = (choices || []).map(ch =>
      typeof ch === 'string'
        ? { name: ch, value: ch }
        : { name: ch.name || ch.label || String(ch.value), value: ch.value !== undefined ? ch.value : ch.name });
    if (allowOther) bridgeChoices.push({ name: '其他 (自由输入)', value: OTHER });
    const ans = await promptCompat([{
      type: multi ? 'checkbox' : 'list', name: 'value', message, choices: bridgeChoices,
    }]);
    if (!ans || !('value' in ans)) return null; // Esc/cancel
    let value = ans.value;
    if (allowOther) {
      const askCustom = async () => {
        const r = await promptCompat([{ type: 'input', name: 'custom', message: '请输入自定义值:' }]);
        return r && r.custom ? String(r.custom).trim() : '';
      };
      if (multi && Array.isArray(value) && value.includes(OTHER)) {
        const custom = await askCustom();
        value = value.filter(v => v !== OTHER);
        if (custom) value.push(custom);
      } else if (!multi && value === OTHER) {
        value = (await askCustom()) || null;
      }
    }
    return value;
  }

  // Map inquirer-style choices to Select-style options
  const options = (choices || []).map(ch => {
    if (typeof ch === 'string') return { label: ch, value: ch };
    return {
      label: ch.name || ch.label || String(ch.value),
      value: ch.value !== undefined ? ch.value : ch.name,
      description: ch.description || '',
    };
  });

  // Require TTY for inline Select
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return Select({ message, options, multi, allowOther, fuzzy });
  }

  // Fallback to inquirer for non-TTY
  try {
    const inquirer = require('inquirer');
    const { value } = await inquirer.prompt([{
      type: multi ? 'checkbox' : 'list',
      name: 'value',
      message,
      choices: choices.map(ch => typeof ch === 'string' ? ch : { name: ch.name || ch.label, value: ch.value }),
    }]);
    return value;
  } catch {
    return null;
  }
}

module.exports = {
  Box,
  Text,
  Spinner,
  ProgressBar,
  Table,
  Select,
  selectMenu,
  StatusBar,
  VStack,
  HStack,
  Sparkline,
  BarChart,
};

// Self-register the interactive menu prompter into the service-layer port so the
// service layer (inputPreprocessor.clarifyIntent) can request a choice menu without
// reaching up into cli/* (DESIGN-ARCH-057). Null when this module is never loaded
// (headless) → callers degrade to inquirer / first candidate.
try {
  require('../../services/interactiveMenuPort').registerMenuPrompter(selectMenu);
} catch { /* port unavailable — non-cli context, services degrade to non-interactive */ }
