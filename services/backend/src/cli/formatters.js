/**
 * CLI output formatting utilities.
 * All user-facing prose is in Chinese.
 */
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const Table = require('cli-table3');
const os = require('os');
const path = require('path');

// ── Mascot & themed icons ────────────────────────────────────────────────────

// Legacy mascot (kept for backward compatibility)
const MASCOT_LEGACY = [
  '  ╭─────╮    ',
  '  │ ◉ ◉ │    ',
  '╭─┤ ▽▽▽ ├─╮  ',
  '│ ╰─┬─┬─╯ │  ',
  '╰───┤ ├───╯  ',
  '  ╭─┴─┴─╮    ',
  '  │ KHY │    ',
  '  ╰─────╯    ',
];

// Legendary flash card pet — Claude Code style pixel art (3 lines tall)
const MASCOT = [
  '  ╭━━━━━╮  ',
  '  ┃✦ ◈ ✦┃  ',
  '  ╰┳━━┳╯  ',
];

// Claude Code style: minimal icons, no emoji
const MASCOT_MINI = '·';       // for status lines (Claude Code: dot)
const ICON_PROMPT = '>';       // prompt arrow
const ICON_AI = '*';           // AI indicator
const ICON_BULL = '>';         // market up
const ICON_BEAR = '<';         // market down
const ICON_BOT = '*';          // AI assistant
const ICON_CHART = '#';        // chart / backtest
const ICON_GEAR = '*';         // system
const ICON_PLUG = '+';         // plugin
const ICON_HEART = '+';        // health / doctor
const ICON_ROCKET = '>';       // launch / start
const ICON_KEY = '*';          // API key
const ICON_DB = '#';           // database
const ICON_SEARCH = '*';       // search
const ICON_GATEWAY = '*';      // gateway / relay

// Random farewell messages
const TIPS = [
  'Run /init to create a khy.md file with project instructions',
  'Use /clear to start fresh when switching topics',
  'Press Ctrl+C to interrupt, type resume to continue',
  'Use /btw to ask a quick side question without interrupting',
  'Drag and drop files into the terminal to include them',
  'Use arrow keys to navigate through command history',
  'Run khy gateway status to check model provider status',
];

function getClassicMonsterPetLines(color = chalk.hex('#D77757')) {
  // 玄鸟凤凰 — Chinese phoenix (Xuan Niao) in traditional palette
  const zhu  = chalk.hex('#C41E3A');  // 朱红 vermillion
  const gold = chalk.hex('#DAA520');  // 赤金 gold
  const dan  = chalk.hex('#FF6B35');  // 丹砂 cinnabar
  const jade = chalk.hex('#2E8B57');  // 碧玉 jade
  const d    = chalk.dim;

  return [
    `       ${gold('▄█▄')}`,
    `     ${gold('▄█')}${zhu('▀█▀')}${gold('█▄')}`,
    `     ${zhu('█▌')}${jade('░')}${gold('▀')}${jade('░')}${zhu('▐█')}`,
    `      ${zhu('▜███▛')}`,
    `  ${gold('▗▟')}${dan('██')}${zhu('████')}${dan('██')}${gold('▙▖')}`,
    `   ${gold('▝▀▀')}${dan('▄')}${zhu('██')}${dan('▄')}${gold('▀▀▘')}`,
    `       ${d('▐▌')}`,
  ];
}

/**
 * Print startup banner — Claude Code aligned layout.
 *
 * Layout (source-level 1:1 match with Claude Code):
 *
 *   [buddy sprite]  khy OS vX.Y.Z
 *                   Model with effort · Billing Type
 *                   /working/directory
 *
 * Clean single-column. No tips, no activity panel.
 * Buddy sprite renders to the left if terminal is wide enough.
 */
function printBanner(version, aiProvider) {
  const d = chalk.dim;
  const orange = chalk.hex('#D77757');

  // Get active model info
  let modelName = '';
  let adapterName = '';
  let effortLabel = 'high effort';
  let billingType = 'API Usage Billing';
  try {
    const gateway = require('../services/gateway/aiGateway');
    const active = gateway.getActiveAdapter();
    if (active) {
      adapterName = active.name || active.type || '';
      modelName = active.activeModel || process.env.GATEWAY_PREFERRED_MODEL || '';
    }
  } catch { /* best effort */ }

  if (!modelName) {
    modelName = process.env.GATEWAY_PREFERRED_MODEL || process.env.OLLAMA_MODEL || 'auto';
  }
  // CC 后端口径对齐:横幅显示友好模型名("Opus 4.8")而非裸 slug,与 TUI 页脚 /
  // welcome 横幅走同一个 SSOT(cli/ccModelName)。门控关 / require 失败 → 裸 slug 原样。
  try {
    const fn = require('./ccModelName').formatModelLabel;
    if (typeof fn === 'function') modelName = fn(modelName);
  } catch { /* keep raw slug */ }
  if (!adapterName) {
    adapterName = process.env.GATEWAY_PREFERRED_ADAPTER || aiProvider || 'auto';
  }

  // Determine billing type from adapter
  if (/ollama|local|llama/i.test(adapterName)) {
    billingType = 'Local Model';
  } else if (/relay|web|clipboard/i.test(adapterName)) {
    billingType = 'Relay';
  }

  // Effort level
  try {
    const ai = require('./ai');
    const effort = ai.getEffort ? ai.getEffort() : 'high';
    const labels = { max: 'max effort', high: 'high effort', medium: 'medium effort', low: 'low effort' };
    effortLabel = labels[effort] || 'high effort';
  } catch { /* best effort */ }

  const cwd = process.cwd();
  const home = os.homedir();
  const cwdShort = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const ver = version || require('../../package.json').version;
  const cols = process.stdout.columns || 80;

  // ── Buddy sprite (Claude Code style: companion renders left of text) ──
  let buddyLines = [];
  try {
    const buddyModule = require('../buddy');
    const companion = buddyModule.getActiveCompanion ? buddyModule.getActiveCompanion() : null;
    if (companion && companion.sprite) {
      buddyLines = companion.sprite;
    }
  } catch { /* no buddy */ }

  // Fallback pet sprite (classic little monster)
  if (!buddyLines || buddyLines.length === 0) {
    buddyLines = getClassicMonsterPetLines(orange);
  }

  // ── Render: sprite left, info right ──
  // Always keep the CLI pet visible; on narrow terminals, switch to stacked mode.
  const hasSprite = Array.isArray(buddyLines) && buddyLines.length >= 3;
  const sideBySide = hasSprite && cols > 50;
  const spriteWidth = sideBySide ? 16 : 0;

  console.log('');

  if (sideBySide) {
    // Align text info with the middle rows of the sprite
    const infoLines = [
      `${chalk.bold('khy OS')} ${d(`v${ver}`)}`,
      d(`${modelName} with ${effortLabel} · ${billingType}`),
      d(cwdShort),
    ];
    const infoStart = Math.max(0, Math.floor((buddyLines.length - infoLines.length) / 2));
    for (let i = 0; i < buddyLines.length; i++) {
      const sprite = padToWidth(buddyLines[i] || '', spriteWidth);
      const info = infoLines[i - infoStart] || '';
      console.log(`${sprite}  ${info}`);
    }
  } else if (hasSprite) {
    // Narrow terminal: show pet first, then metadata lines.
    console.log(buddyLines[0] || '');
    console.log(buddyLines[1] || '');
    console.log(buddyLines[2] || '');
    console.log(`  ${chalk.bold('khy OS')} ${d(`v${ver}`)}`);
    console.log(`  ${d(`${modelName} with ${effortLabel} · ${billingType}`)}`);
    console.log(`  ${d(cwdShort)}`);
  } else {
    // Ultimate fallback: text-only mode
    console.log(`    ${chalk.bold('khy OS')} ${d(`v${ver}`)}`);
    console.log(`    ${d(`${modelName} with ${effortLabel} · ${billingType}`)}`);
    console.log(`    ${d(cwdShort)}`);
  }

  console.log('');
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Calculate the visual display width of a string, accounting for:
 * - CJK characters (2 columns each)
 * - Emoji (2 columns each)
 * - ANSI escape codes (0 columns)
 * - Combining characters (0 columns)
 */
/**
 * Calculate display width of a string.
 * Uses string-width for accurate CJK/emoji/grapheme width calculation,
 * with a fast ASCII-only path for common cases.
 * Strips ANSI escape codes before measuring.
 */
let _stringWidth;
function _computeDisplayWidth(str) {
  const stripped = stripAnsi(str);
  if (!stripped) return 0;

  // Fast path: pure ASCII (common for code, paths, English text)
  if (/^[\x20-\x7E]*$/.test(stripped)) return stripped.length;

  // Full Unicode path via string-width (handles CJK, emoji, grapheme clusters)
  if (!_stringWidth) {
    try { _stringWidth = require('string-width'); } catch { /* fallback below */ }
  }
  if (_stringWidth) {
    try { return _stringWidth(stripped); } catch { /* fallback below */ }
  }

  // Fallback: manual calculation for environments without string-width
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3040 && cp <= 0x33BF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0xA000 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x2FA1F) ||
      (cp >= 0x1F300 && cp <= 0x1F9FF)
    ) {
      width += 2;
    } else if (cp >= 0x0300 && cp <= 0x036F) {
      width += 0;
    } else {
      width += 1;
    }
  }
  return width;
}

// 显示宽度按字符串 LRU 记忆(纯叶子;门控 KHY_DISPLAY_WIDTH_MEMO 默认开)。渲染热路径每键对整行重测
// 宽度(主输入刷新每按键两次),而 displayWidth 是其字符串实参的纯函数 → 可安全记忆。惰性 require
// 避免加载期环依赖;叶子缺失/异常 → 直接 _computeDisplayWidth(逐字节回退)。
let _displayWidthMemo;
function displayWidth(str) {
  try {
    if (!_displayWidthMemo) _displayWidthMemo = require('./displayWidthMemo');
    return _displayWidthMemo.getDisplayWidth(str, _computeDisplayWidth, process.env);
  } catch {
    return _computeDisplayWidth(str);
  }
}

/**
 * Pad a string to a target display width, accounting for CJK characters.
 * @param {string} str - raw or ANSI-colored string
 * @param {number} targetWidth
 * @param {string} [fill=' ']
 * @returns {string}
 */
function padToWidth(str, targetWidth, fill = ' ') {
  const currentWidth = displayWidth(str);
  const needed = Math.max(0, targetWidth - currentWidth);
  return str + fill.repeat(needed);
}

/**
 * Truncate a string to a maximum display width, adding '...' if truncated.
 * @param {string} str
 * @param {number} maxWidth
 * @returns {string}
 */
// Wide (double-width) code-point ranges. Shared by both the legacy and the
// linear truncation paths so their width accounting stays byte-identical.
function _isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115F) ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3040 && cp <= 0x33BF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7AF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE30 && cp <= 0xFE6F) ||
    (cp >= 0xFF01 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x20000 && cp <= 0x2FA1F) ||
    (cp >= 0x1F300 && cp <= 0x1F9FF)
  );
}

// ANSI-aware truncation guard (KHY_TRUNCATE_ANSI_LINEAR, default on).
//
// The legacy ESC branch below is both quadratic AND wrong: on every ESC byte
// (cp 0x1B) it evaluated `str.slice([...str].indexOf(ch))`, which (a) spreads
// the ENTIRE string into an array to locate the escape and (b) always returns
// the FIRST ESC's offset, not the current one. A garbled / mojibake paste that
// carries a run of raw ESC bytes ahead of any width-bearing text therefore
// grinds O(n^2) — measured ~13 s at 40 000 ESC, ~55 s at 80 000. On top of that
// the `for (k …)` "skip" loop is dead code (it allocates an iterator and does
// nothing), so the CSI sequence body (`[0;31m`) leaks into the width count.
//
// The linear path walks code points by index and, at each ESC, matches a CSI
// colour sequence with a STICKY regex anchored at the current offset (no slice,
// no full-string spread) — appending it verbatim at zero width. For any input
// WITHOUT an ESC byte the two paths are byte-identical (the ESC branch is never
// taken), so real callers — which pass ANSI-stripped plain text — are
// unaffected; only crafted ESC paste changes, and there the linear path is both
// correct and bounded. Off -> legacy quadratic/leaky branch (load-bearing).
const _TRUNCATE_ANSI_OFF = ['0', 'false', 'off', 'no'];
function _truncateAnsiLinearEnabled() {
  return !_TRUNCATE_ANSI_OFF.includes(
    String((process.env && process.env.KHY_TRUNCATE_ANSI_LINEAR) || '').trim().toLowerCase());
}

// Sticky CSI-SGR matcher: `y` flag anchors at lastIndex without slicing.
const _CSI_SGR_STICKY = /\x1b\[[0-9;]*m/y;

function _truncateToWidthLegacy(str, maxWidth) {
  let result = '';
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    // ANSI escape — skip entirely (zero width)
    if (cp === 0x1B) {
      // Fast-skip ESC[...m sequences
      const rest = str.slice([...str].indexOf(ch));
      const m = rest.match(/^\x1b\[[0-9;]*m/);
      if (m) {
        // Skip ANSI chars without adding width
        for (let k = 1; k < m[0].length; k++) {
          const iter = str[Symbol.iterator]();
          // Can't easily skip in for-of; ANSI in truncation input is rare — treat as w=0
        }
      }
      continue;
    }
    // Combining characters — zero width
    if (cp >= 0x0300 && cp <= 0x036F) continue;
    const charWidth = _isWideCodePoint(cp) ? 2 : 1;
    if (w + charWidth + 3 > maxWidth) { // reserve 3 for '...'
      result += '...';
      break;
    }
    result += ch;
    w += charWidth;
  }
  return result;
}

function truncateToWidth(str, maxWidth) {
  if (displayWidth(str) <= maxWidth) return str;
  if (!_truncateAnsiLinearEnabled()) return _truncateToWidthLegacy(str, maxWidth);

  let result = '';
  let w = 0;
  let i = 0;
  const len = str.length;
  while (i < len) {
    const cp = str.codePointAt(i);
    const chLen = cp > 0xFFFF ? 2 : 1;
    // ANSI escape — consume the whole CSI-SGR sequence at zero width.
    if (cp === 0x1B) {
      _CSI_SGR_STICKY.lastIndex = i;
      const m = _CSI_SGR_STICKY.exec(str);
      if (m) {
        result += m[0];
        i = _CSI_SGR_STICKY.lastIndex;
      } else {
        // Lone/non-SGR ESC: drop the ESC byte (legacy parity: zero width, not appended).
        i += chLen;
      }
      continue;
    }
    // Combining characters — zero width, dropped (legacy parity).
    if (cp >= 0x0300 && cp <= 0x036F) { i += chLen; continue; }
    const charWidth = _isWideCodePoint(cp) ? 2 : 1;
    if (w + charWidth + 3 > maxWidth) { // reserve 3 for '...'
      result += '...';
      break;
    }
    result += str.slice(i, i + chLen);
    w += charWidth;
    i += chLen;
  }
  return result;
}

/**
 * Safe string for terminal output — replace any characters that might
 * cause rendering issues in terminals that don't support full Unicode.
 */
function safeTerminalString(str) {
  if (!str || typeof str !== 'string') return '';
  // Replace null bytes and other control characters (except newline/tab)
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function printSuccess(msg) {
  console.log(chalk.green('  ✓ ') + msg);
}

function printError(msg) {
  console.log(chalk.red('  ✗ ') + msg);
}

function printWarn(msg) {
  console.log(chalk.yellow('  ⚠ ') + msg);
}

function printInfo(msg) {
  console.log(chalk.blue('  ℹ ') + msg);
}

/**
 * Structured error panel with rounded border.
 * Shows title, message, reason, suggestions, and optional collapsed stack trace.
 *
 * @param {{ title?: string, message: string, reason?: string, suggestions?: string[], stack?: string }} opts
 */
function printErrorPanel(opts) {
  const title = opts.title || 'Error';
  const message = opts.message || '';
  const reason = opts.reason || '';
  const suggestions = opts.suggestions || [];
  const stack = opts.stack || '';

  const maxW = Math.min((process.stdout.columns || 80) - 4, 72);
  const innerW = maxW - 4; // 2 border + 2 padding

  const dim = chalk.dim;
  const lines = [];

  // Helper: wrap text to inner width
  function wrapLine(text) {
    const words = text.split(/\s+/);
    const wrapped = [];
    let cur = '';
    for (const w of words) {
      if (cur && displayWidth(cur + ' ' + w) > innerW) {
        wrapped.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    }
    if (cur) wrapped.push(cur);
    return wrapped.length ? wrapped : [''];
  }

  // Helper: render a padded content line inside the box
  function addLine(text) {
    const w = displayWidth(text);
    const pad = Math.max(0, innerW - w);
    lines.push(dim('  │') + '  ' + text + ' '.repeat(pad) + dim('│'));
  }

  function addEmpty() {
    lines.push(dim('  │') + ' '.repeat(innerW + 2) + dim('│'));
  }

  // Title bar
  const titleText = ` ✗ ${title} `;
  const titleW = displayWidth(titleText);
  const dashCount = Math.max(0, maxW - titleW - 2);
  lines.push(dim('  ╭─') + chalk.red.bold(titleText) + dim('─'.repeat(dashCount) + '╮'));

  addEmpty();

  // Message
  for (const ml of wrapLine(message)) {
    addLine(ml);
  }

  // Reason
  if (reason) {
    addEmpty();
    for (const rl of wrapLine('Reason: ' + reason)) {
      addLine(chalk.yellow(rl));
    }
  }

  // Suggestions
  if (suggestions.length > 0) {
    addEmpty();
    addLine(chalk.dim('Suggestions:'));
    for (let i = 0; i < suggestions.length; i++) {
      for (const sl of wrapLine(`${i + 1}. ${suggestions[i]}`)) {
        addLine('  ' + sl);
      }
    }
  }

  // Stack (collapsed hint)
  if (stack) {
    addEmpty();
    addLine(chalk.dim('▸ Stack trace (ctrl+o to expand)'));
  }

  addEmpty();
  lines.push(dim('  ╰' + '─'.repeat(maxW) + '╯'));

  console.log('');
  lines.forEach(l => console.log(l));
  console.log('');
}

function printTable(headers, rows) {
  const plainOutput = process.env.NO_COLOR != null
    || String(process.env.FORCE_COLOR || '').trim() === '0'
    || !(process.stdout && process.stdout.isTTY);
  try {
    const table = new Table({
      head: headers.map(h => plainOutput ? String(h) : chalk.cyan(h)),
      style: {
        'padding-left': 1,
        'padding-right': 1,
        head: plainOutput ? [] : ['cyan'],
        border: plainOutput ? [] : ['grey'],
      },
    });
    rows.forEach(row => table.push(row));
    const rendered = table.toString();
    console.log(plainOutput ? stripAnsi(rendered) : rendered);
    return;
  } catch {
    // Fallback when cli-table3/string-width has ESM/CJS compatibility issues.
  }

  const colCount = headers.length;
  const normalizedRows = rows.map(row => {
    const arr = Array.isArray(row) ? row : [row];
    const out = new Array(colCount).fill('');
    for (let i = 0; i < colCount; i++) out[i] = String(arr[i] ?? '');
    return out;
  });

  const colWidths = headers.map((h, i) => {
    const headerW = displayWidth(String(h));
    const rowW = normalizedRows.reduce((max, row) => Math.max(max, displayWidth(String(row[i] ?? ''))), 0);
    return Math.max(headerW, rowW);
  });

  const top = `  ╭${colWidths.map(w => '─'.repeat(w + 2)).join('┬')}╮`;
  const mid = `  ├${colWidths.map(w => '─'.repeat(w + 2)).join('┼')}┤`;
  const bot = `  ╰${colWidths.map(w => '─'.repeat(w + 2)).join('┴')}╯`;

  console.log(plainOutput ? top : chalk.dim(top));
  const headerLine = headers
    .map((h, i) => {
      const text = padToWidth(String(h), colWidths[i]);
      return ` ${plainOutput ? text : chalk.cyan(text)} `;
    })
    .join(plainOutput ? '│' : chalk.dim('│'));
  console.log((plainOutput ? '  │' : chalk.dim('  │')) + headerLine + (plainOutput ? '│' : chalk.dim('│')));
  console.log(plainOutput ? mid : chalk.dim(mid));

  for (const row of normalizedRows) {
    const rowLine = row
      .map((cell, i) => ` ${padToWidth(String(cell), colWidths[i])} `)
      .join(plainOutput ? '│' : chalk.dim('│'));
    console.log((plainOutput ? '  │' : chalk.dim('  │')) + rowLine + (plainOutput ? '│' : chalk.dim('│')));
  }
  console.log(plainOutput ? bot : chalk.dim(bot));
}

function printQuote(quote) {
  const change = quote.current - quote.preClose;
  const changePct = quote.preClose > 0 ? (change / quote.preClose) * 100 : 0;
  const color = change >= 0 ? chalk.red : chalk.green; // Chinese market: red = up
  const icon = change >= 0 ? ICON_BULL : ICON_BEAR;
  const arrow = change >= 0 ? '▲' : '▼';

  console.log('');
  console.log(`  ${icon} ${chalk.bold(quote.name)} ${chalk.dim('(' + quote.symbol + ')')}`);
  console.log(chalk.dim('  ┌──────────────────────────────────────'));
  console.log(`  │ 现价  ${color(chalk.bold('¥' + quote.current.toFixed(2)))}  ${color(arrow + ' ' + (change >= 0 ? '+' : '') + changePct.toFixed(2) + '%')}`);
  console.log(`  │ 开盘  ¥${quote.open.toFixed(2)}  最高  ${chalk.red('¥' + quote.high.toFixed(2))}  最低  ${chalk.green('¥' + quote.low.toFixed(2))}`);
  console.log(`  │ 昨收  ¥${quote.preClose.toFixed(2)}  成交量  ${chalk.bold(formatVolume(quote.volume))}`);
  if (quote.date) console.log(`  │ 时间  ${chalk.dim(quote.date + ' ' + (quote.time || ''))}`);
  console.log(chalk.dim('  └──────────────────────────────────────'));
  console.log('');
}

function printBacktestResult(result) {
  const returnColor = result.totalReturn >= 0 ? chalk.red : chalk.green;
  const icon = result.totalReturn >= 0 ? ICON_BULL : ICON_BEAR;

  console.log('');
  console.log(`  ${ICON_CHART} ${chalk.bold('回测结果')} ${icon}`);
  console.log(chalk.dim('  ┌──────────────────────────────────────'));

  const rows = [
    ['品种', result.symbol],
    ['区间', `${result.startDate} → ${result.endDate}`],
    ['', ''],
    ['初始资金', formatCurrency(result.initialCapital)],
    ['最终资金', chalk.bold(formatCurrency(result.finalCapital))],
    ['总收益率', returnColor(chalk.bold(safePercent(result.totalReturn)))],
    ['年化收益', returnColor(safePercent(result.annualizedReturn))],
    ['', ''],
    ['最大回撤', chalk.yellow(safePercent(result.maxDrawdown, false))],
    ['夏普比率', safeNum(result.sharpeRatio, 4)],
    ['胜率', safePercent(result.winRate, false)],
    ['', ''],
    ['交易次数', String(result.totalTrades || 0)],
    ['盈利次数', chalk.red(String(result.winningTrades || 0))],
    ['亏损次数', chalk.green(String(result.losingTrades || 0))],
    ['交易天数', String(result.tradingDays || 0)],
  ];

  // Pad labels by display width, not char count: labels mix 2-char (品种 → 4
  // cols) and 4-char (初始资金 → 8 cols) CJK, so padEnd would leave the value
  // column ragged. Pad to a fixed 10-column gutter so values line up.
  const padLabel = (s) => s + ' '.repeat(Math.max(0, 10 - displayWidth(s)));
  rows.forEach(([label, value]) => {
    if (!label && !value) {
      console.log(chalk.dim('  ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌'));
      return;
    }
    console.log(`  │ ${chalk.dim(padLabel(label))} ${value}`);
  });

  console.log(chalk.dim('  └──────────────────────────────────────'));
  console.log('');
}

function safePercent(value, showSign = true) {
  if (value === undefined || value === null || isNaN(value)) return '-';
  const prefix = showSign && value >= 0 ? '+' : '';
  return prefix + Number(value).toFixed(2) + '%';
}

function safeNum(value, decimals = 2) {
  if (value === undefined || value === null || isNaN(value)) return '-';
  return Number(value).toFixed(decimals);
}

function formatCurrency(value) {
  return '¥' + Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatVolume(vol) {
  if (!vol) return '0';
  if (vol >= 1e8) return (vol / 1e8).toFixed(2) + '亿';
  if (vol >= 1e4) return (vol / 1e4).toFixed(2) + '万';
  return String(vol);
}

function printHelp() {
  const pkg = require('../../package.json');
  const displayVersion = pkg.version;
  const cols = process.stdout.columns || 80;
  const boxW = Math.min(cols - 4, 72);
  const innerW = boxW - 4; // "│ " + content + " │"
  const dim = chalk.dim;
  const hr = '─'.repeat(boxW - 2);

  // Helper: pad ANSI- and CJK-safe (double-width glyphs counted as 2 columns,
  // so right borders stay aligned for Chinese labels).
  const vis = (s) => displayWidth(s);
  const pad = (s, w) => { const g = Math.max(0, w - vis(s)); return s + ' '.repeat(g); };
  const row = (s) => dim('  │ ') + pad(s, innerW) + dim(' │');
  const emptyRow = () => row('');

  console.log('');
  // Title bar
  const titleText = ` khy OS v${displayVersion} — 命令速查 `;
  // Measure the title by display width: "命令速查" + "—" are double-width, so
  // raw .length would under-count and stretch the top border past the body.
  const titleDashes = boxW - 2 - displayWidth(titleText);
  const tLeft = Math.floor(titleDashes / 2);
  const tRight = titleDashes - tLeft;
  console.log(dim(`  ╭${'─'.repeat(Math.max(1, tLeft))}`) + chalk.cyan.bold(titleText) + dim(`${'─'.repeat(Math.max(1, tRight))}╮`));
  console.log(emptyRow());
  console.log(row(dim('用法: khy <命令> [参数] [--选项]    AI: 直接输入自然语言即可对话')));
  console.log(emptyRow());

  const { isLegacyWinTerminal } = require('../tools/platformUtils');
  const _lw = isLegacyWinTerminal();

  const groups = [
    {
      name: '核心',
      icon: _lw ? '*' : '▸',
      cmds: [
        ['app list|install|start|stop|status', '应用管理'],
        ['server start [--port N] | server status', '服务管理'],
        ['db init|seed|status', '数据库'],
        ['menu | clear | exit', '交互辅助'],
      ],
    },
    {
      name: 'AI 与网关',
      icon: _lw ? '+' : '◆',
      cmds: [
        ['gateway status|model|prefer-remote|config|relay', '通道状态与切换'],
        ['models list|pull|import|set|delete', '本地模型管理'],
        ['ai status|config|owner', 'AI 配置与权限'],
        ['-p --output-format json|stream-json', '非交互结构化输出'],
        ['image2web <图片|paste> [提示] [--out *.html]', '截图还原网页'],
        ['kiro|cursor|claude|codex|trae --list', '查看 IDE 模型'],
      ],
    },
    {
      name: '诊断与运维',
      icon: _lw ? '?' : '⌕',
      cmds: [
        ['doctor', '环境诊断'],
        ['docs maintainer', '维护入口与分层验证'],
        ['init [--force]', '初始化/重置'],
        ['publish check|build|pypi|testpypi', 'PyPI 发布'],
        ['verify workflow [--adapter ...] [--autofix]', '工作流测试'],
        ['monitor selfcheck status|run', '底座自检'],
        ['proxy quickstart | proxy client add|list', '代理与令牌'],
        ['linux status|net|run', '系统排查'],
      ],
    },
    {
      name: '量化应用',
      icon: _lw ? '#' : '◐',
      cmds: [
        ['quote|hq <代码|名称>', '实时行情'],
        ['backtest|bt <代码> [--strategy ...]', '策略回测'],
        ['data fetch <代码> | data list', '数据管理'],
        ['search <关键词> | analyze <代码>', '搜索与分析'],
      ],
    },
  ];

  // Calculate optimal column width
  const cmdColW = Math.min(Math.floor(innerW * 0.65), 46);
  const descColW = innerW - cmdColW - 3; // 3 for " │ " separator

  groups.forEach((group) => {
    console.log(row(`${chalk.cyan(group.icon)} ${chalk.cyan.bold(group.name)}`));
    console.log(row(dim('─'.repeat(innerW))));
    group.cmds.forEach(([cmd, desc]) => {
      const cmdStr = pad(chalk.white(cmd), cmdColW);
      console.log(row(`  ${cmdStr} ${dim(desc)}`));
    });
    console.log(emptyRow());
  });

  // Examples section
  console.log(row(dim('示例:')));
  console.log(row(dim('  khy gateway status     khy doctor     khy hq 茅台')));
  console.log(row(dim('  khy help gateway       khy docs maintainer')));
  console.log(emptyRow());
  console.log(row(dim('更多: khy docs · 帮助主题: khy help <gateway|quant|ops>')));

  // Bottom border
  console.log(dim(`  ╰${hr}╯`));
  console.log('');
}

function _normalizeHelpTopic(input = '') {
  const key = String(input || '').trim().toLowerCase();
  if (!key) return null;
  if (['gateway', 'gw', 'model', 'models', '网关', '模型'].includes(key)) return 'gateway';
  if (['quant', 'khyquant', 'trade', 'trading', '量化', '交易'].includes(key)) return 'quant';
  if (['ops', 'doctor', 'devops', '运维', '诊断', '排障'].includes(key)) return 'ops';
  return null;
}

function printHelpTopic(topicInput = '') {
  const topic = _normalizeHelpTopic(topicInput);
  if (!topic) {
    printWarn(`未知帮助主题: ${topicInput}`);
    printInfo('可用主题: gateway | quant | ops');
    printInfo('示例: khy help gateway');
    return false;
  }

  console.log('');
  console.log(`  ${MASCOT_MINI} ${chalk.bold('khy help')} ${chalk.cyan(topic)}`);
  console.log('');

  if (topic === 'gateway') {
    const rows = [
      ['gateway status', '查看通道可用性与实测告警'],
      ['gateway status --json', '输出机器可读 JSON（含 endpoint 明细）'],
      ['gateway status --json --endpoints-only', '仅输出 endpoint 明细（快速模式，不做连通探测）'],
      ['gateway status --json --endpoints-only --provider <name>', '按 provider 过滤 endpoint 明细（支持逗号分隔）'],
      ['gateway sample codex [--attempts 4] [--timeout-ms 12000] [--json]', '串行采集 Codex strict 样本并汇总 first_chunk / timeout / promptInjected'],
      ['gateway debug-prompt [--tail 5|--adapter codex|--capsules|--why-full|--json|live|clear]', '查看、实时监听或清空 KHY 协议注入调试日志'],
      ['gateway model', '选择默认通道与模型'],
      ['gateway prefer-remote', '一键切换到可用 API/桥接通道'],
      ['gateway tune-local [auto|fast|balanced|quality] [apply]', '本地模型参数智能匹配并写入 .env'],
      ['gateway config', '配置网关参数（endpoint/key/timeout）'],
      ['gateway relay', '启动 Web 中转'],
      ['models list|pull|import|set|delete', '管理本地模型（Ollama）'],
      ['image2web <图片|paste> [提示] [--out *.html]', '截图还原网页并自动保存为 html'],
      ['ai config', '配置 API 密钥'],
      ['proxy quickstart', '一键启动代理并输出接入参数'],
    ];
    rows.forEach(([cmd, desc]) => {
      console.log(`    ${chalk.white(cmd.padEnd(34))} ${chalk.dim(desc)}`);
    });
    console.log('');
    console.log(chalk.dim('  示例:'));
    console.log(chalk.dim('    khy gateway status'));
    console.log(chalk.dim('    khy gateway prefer-remote'));
    console.log(chalk.dim('    khy gateway model'));
    console.log(chalk.dim('    khy image2web ./landing.png 还原成网页 --out landing.html'));
    console.log(chalk.dim('    khy ai run qwen3.5:4b'));
    console.log('');
    return true;
  }

  if (topic === 'quant') {
    const rows = [
      ['hq|quote <代码|名称>', '查看实时行情'],
      ['search <关键词>', '搜索标的'],
      ['data fetch <代码> | data list', '下载/列出数据'],
      ['bt|backtest <代码> [--strategy ...]', '执行策略回测'],
      ['strategy list | backtest list', '查看策略/历史回测'],
      ['analyze <代码>', 'AI 辅助分析'],
      ['cache clear', '清理缓存'],
    ];
    rows.forEach(([cmd, desc]) => {
      console.log(`    ${chalk.white(cmd.padEnd(34))} ${chalk.dim(desc)}`);
    });
    console.log('');
    console.log(chalk.dim('  示例:'));
    console.log(chalk.dim('    khy hq 茅台'));
    console.log(chalk.dim('    khy bt sh600519 --strategy 1'));
    console.log(chalk.dim('    khy analyze sz000001'));
    console.log('');
    return true;
  }

  // ops
  const rows = [
    ['doctor', '环境诊断（依赖/网络/服务）'],
    ['docs maintainer', '维护入口、维护地图、分层验证命令'],
    ['init [--force]', '初始化或强制重置'],
    ['publish check|build|pypi|testpypi', 'PyPI 构建、检查、发布'],
    ['verify workflow [--adapter ...] [--timeout N] [--autofix]', 'T1-T5 稳定性工作流测试'],
    ['monitor selfcheck status|run', '底座自检状态/立即执行'],
    ['linux status|net|run', '系统网络排障'],
    ['proxy status|quickstart', '代理状态与快速启动'],
    ['server status', '后端服务状态'],
    ['db status', '数据库状态'],
  ];
  rows.forEach(([cmd, desc]) => {
    console.log(`    ${chalk.white(cmd.padEnd(34))} ${chalk.dim(desc)}`);
  });
  console.log('');
  console.log(chalk.dim('  示例:'));
  console.log(chalk.dim('    khy doctor'));
  console.log(chalk.dim('    khy docs maintainer'));
  console.log(chalk.dim('    khy monitor selfcheck run'));
  console.log(chalk.dim('    khy linux net'));
  console.log('');
  return true;
}

async function withSpinner(text, fn, { muteOutput = false } = {}) {
  // When TUI is active, skip all spinner stdout — TUI handles display.
  if (process.stdout.isTTY) return fn();
  // On Windows, ora's ANSI cursor control conflicts with readline in REPL mode,
  // causing all output to be swallowed. Use a simple text fallback instead.
  const useSimpleSpinner = process.platform === 'win32' && process.stdin.isTTY;

  let spinner;
  if (useSimpleSpinner) {
    // Simple fallback: just print the text, no animated spinner
    process.stdout.write(chalk.cyan(`  ◌ ${text}...`));
    spinner = {
      succeed: (msg) => { process.stdout.write('\r' + chalk.green(`  ✓ ${msg || text}`) + '\n'); },
      fail: (msg) => { process.stdout.write('\r' + chalk.red(`  ✗ ${msg || text}`) + '\n'); },
    };
  } else {
    try {
      const ora = (await import('ora')).default;
      // discardStdin: false prevents ora from pausing/closing stdin,
      // which would destroy any active readline interface and crash the REPL.
      spinner = ora({ text, indent: 2, discardStdin: false }).start();
    } catch {
      // ora dynamic import may fail — fall back to simple text spinner
      process.stdout.write(chalk.cyan(`  ◌ ${text}`));
      spinner = {
        succeed: (msg) => { process.stdout.write('\r' + chalk.green(`  ✓ ${msg || text}`) + '\n'); },
        fail: (msg) => { process.stdout.write('\r' + chalk.red(`  ✗ ${msg || text}`) + '\n'); },
      };
    }
  }

  // Suppress noisy service logs (console + winston) while spinner runs
  let origLog, origWarn, origError, origLogLevel;
  if (muteOutput) {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    // Also silence winston console transport
    try {
      const logger = require('../utils/logger');
      origLogLevel = logger.level;
      logger.level = 'silent';
    } catch { /* logger not available */ }
  }

  const restore = () => {
    if (!muteOutput) return;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    try {
      const logger = require('../utils/logger');
      logger.level = origLogLevel || 'info';
    } catch { /* ignore */ }
  };

  try {
    const result = await fn();
    restore();
    spinner.succeed();
    return result;
  } catch (err) {
    restore();
    spinner.fail(err.message);
    throw err;
  }
}

function printDivider(label) {
  if (label) {
    const line = '─'.repeat(Math.max(0, 22 - stripAnsi(label).length));
    console.log(chalk.dim(`  ── ${label} ${line}`));
  } else {
    console.log(chalk.dim('  ' + '─'.repeat(40)));
  }
}

// Farewell messages (randomly chosen on exit)
const FAREWELLS = [
  '任务完成，随时回来继续。再见！',
  '平台已待命，下次见！',
  '保持节奏，持续迭代。再见！',
  '祝你开发顺利，下次见！',
  '理性决策，稳步推进。再见！',
];

function getRandomFarewell() {
  return FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)];
}

/**
 * Print startup banner for AI-only / lite mode.
 * Aligned with Claude Code's compact banner:
 *   [sprite]  khy OS vX.Y.Z
 *             model · provider
 *             ~/cwd
 */
function printLiteBanner(version, aiProvider) {
  const d = chalk.dim;
  const orange = chalk.hex('#D77757');

  const cwd = process.cwd();
  const home = os.homedir();
  const cwdShort = cwd === home
    ? '~'
    : (cwd.startsWith(home + path.sep) ? '~' + cwd.slice(home.length) : cwd);
  const ver = version || require('../../package.json').version;

  let modelName = '';
  try {
    const gateway = require('../services/gateway/aiGateway');
    const active = gateway.getActiveAdapter();
    modelName = active?.activeModel || '';
  } catch { /* best effort */ }

  const providerText = String(aiProvider || 'AI');
  const modelText = String(modelName || '');
  const providerPart = (
    modelText && !providerText.toLowerCase().includes(modelText.toLowerCase())
  )
    ? `${modelText} · ${providerText}`
    : providerText;

  const petLines = getClassicMonsterPetLines(orange);

  console.log('');
  console.log(`${petLines[0]}  ${chalk.bold('khy OS')} ${d(`v${ver}`)}`);
  console.log(`${petLines[1]}    ${d(providerPart)}`);
  console.log(`${petLines[2]}    ${d(cwdShort)}`);
  console.log('');
}

module.exports = {
  // Output functions
  printBanner,
  printLiteBanner,
  printSuccess,
  printError,
  printErrorPanel,
  printWarn,
  printInfo,
  printTable,
  printQuote,
  printBacktestResult,
  printHelp,
  printHelpTopic,
  printDivider,
  // Formatting helpers
  formatCurrency,
  formatVolume,
  stripAnsi,
  displayWidth,
  padToWidth,
  truncateToWidth,
  _truncateAnsiLinearEnabled,
  _truncateToWidthLegacy,
  safeTerminalString,
  // Spinner
  withSpinner,
  // Theme icons (for use in other modules)
  MASCOT_MINI,
  ICON_PROMPT,
  ICON_AI,
  ICON_BOT,
  ICON_CHART,
  ICON_GEAR,
  ICON_ROCKET,
  ICON_KEY,
  ICON_DB,
  ICON_SEARCH,
  ICON_HEART,
  ICON_PLUG,
  ICON_BULL,
  ICON_BEAR,
  ICON_GATEWAY,
  getClassicMonsterPetLines,
  // Farewell
  getRandomFarewell,
};
