/**
 * CLI output formatting utilities.
 * All user-facing prose is in Chinese.
 */
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const Table = require('cli-table3');

const os = require('os');
const path = require('path');

// 边框风格的单一真源(纯叶子)。printTable / printErrorPanel / printHelp /
// printBacktestResult 都问它「这一屏画不画框」,避免开关散进各自的渲染分支。
const tableStyle = require('./tableStyle');

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
const MASCOT = ['  ╭━━━━━╮  ', '  ┃✦ ◈ ✦┃  ', '  ╰┳━━┳╯  '];

// Claude Code style: minimal icons, no emoji
const MASCOT_MINI = '·'; // for status lines (Claude Code: dot)
const ICON_PROMPT = '>'; // prompt arrow
const ICON_AI = '*'; // AI indicator
const ICON_BULL = '>'; // market up
const ICON_BEAR = '<'; // market down
const ICON_BOT = '*'; // AI assistant
const ICON_CHART = '#'; // chart / backtest
const ICON_GEAR = '*'; // system
const ICON_PLUG = '+'; // plugin
const ICON_HEART = '+'; // health / doctor
const ICON_ROCKET = '>'; // launch / start
const ICON_KEY = '*'; // API key
const ICON_DB = '#'; // database
const ICON_SEARCH = '*'; // search
const ICON_GATEWAY = '*'; // gateway / relay

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
  const zhu = chalk.hex('#C41E3A'); // 朱红 vermillion
  const gold = chalk.hex('#DAA520'); // 赤金 gold
  const dan = chalk.hex('#FF6B35'); // 丹砂 cinnabar
  const jade = chalk.hex('#2E8B57'); // 碧玉 jade
  const d = chalk.dim;

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
  // Use shared banner data service (single source of truth for TUI and Classic)
  const data = require('./bannerDataService').getBannerData({ version, aiProvider });
  const {
    modelName, adapterName, effortLabel, billingType,
    gatewayStatus, contextWindow, authMethod,
    greetingName, cwd, buddyLines: fallbackBuddyLines,
  } = data;

  const d = chalk.dim;
  const orange = chalk.hex('#D77757');
  const ver = version || require('../../package.json').version;
  const cols = process.stdout.columns || 80;

  // ── Buddy sprite ──
  let buddyLines = fallbackBuddyLines;
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

// Full CSI/ESC coverage: SGR colors, cursor movement (\x1b[nA..D, \x1b[n;mH),
// erase (\x1b[K, \x1b[2J), private modes (\x1b[?25l) and bare ESC finals.
// eslint-disable-next-line no-control-regex
const _ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-9;?]*[@-~])/g;

// OSC sequences (hyperlinks, window titles): \x1b]...BEL or \x1b]...ESC\ (ST).
// Lazy body + both terminators; stripped BEFORE _ANSI_PATTERN so the ST's
// ESC\ is not consumed first, which would leave the OSC body behind.
// eslint-disable-next-line no-control-regex
const _OSC_PATTERN = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;

// strip-ansi loader sentinel: undefined = not tried, null = load failed (never retry).
let _stripAnsiLib;
function stripAnsi(str) {
  if (_stripAnsiLib === undefined) {
    try {
      const mod = require('strip-ansi');
      const fn =
        typeof mod === 'function'
          ? mod
          : mod && typeof mod.default === 'function'
            ? mod.default
            : null;
      _stripAnsiLib = fn || null;
    } catch {
      _stripAnsiLib = null;
    }
  }
  if (_stripAnsiLib) {
    try {
      return _stripAnsiLib(str);
    } catch {
      _stripAnsiLib = null;
    }
  }
  return str.replace(_OSC_PATTERN, '').replace(_ANSI_PATTERN, '');
}

/**
 * Detect terminal width in columns, with a short-lived cache.
 * Priority: stdout.columns → stderr.columns → env COLUMNS → default 80.
 * Cache is invalidated by the stdout 'resize' event (registered once) and
 * additionally expires after ~500ms as a safety net for non-TTY streams.
 * @returns {number}
 */
const _TERM_COLS_CACHE_MS = 500;
let _termColsCache = 0;
let _termColsCacheAt = 0;
let _termColsRawLast = -1;
let _termColsResizeHooked = false;
function _hookTermColsResize() {
  if (_termColsResizeHooked) {
    return;
  }
  _termColsResizeHooked = true;
  try {
    if (process.stdout && typeof process.stdout.on === 'function') {
      process.stdout.on('resize', () => {
        _termColsCacheAt = 0;
      });
    }
  } catch {
    /* non-TTY / exotic stdout: TTL alone bounds staleness */
  }
}

function getTerminalColumns() {
  // Raw stdout width is re-read every call: it is cheap and lets the cache
  // react immediately when the terminal (or a test stub) changes it. The TTL
  // cache only shields the stderr/env fallback chain.
  let raw = 0;
  try {
    raw = Number(process.stdout && process.stdout.columns) || 0;
  } catch {
    raw = 0;
  }
  const now = Date.now();
  if (
    _termColsCacheAt &&
    now - _termColsCacheAt < _TERM_COLS_CACHE_MS &&
    raw === _termColsRawLast
  ) {
    return _termColsCache;
  }
  _hookTermColsResize();
  let cols = raw;
  if (!(Number.isFinite(cols) && cols > 0)) {
    try {
      cols =
        Number(process.stderr && process.stderr.columns) || parseInt(process.env.COLUMNS, 10) || 0;
    } catch {
      cols = 0;
    }
  }
  _termColsCache = Number.isFinite(cols) && cols > 0 ? cols : 80;
  _termColsRawLast = raw;
  _termColsCacheAt = now;
  return _termColsCache;
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
// string-width loader sentinel: undefined = not tried, null = load failed (never retry).
let _stringWidth;
function _computeDisplayWidth(str) {
  const stripped = stripAnsi(str);
  if (!stripped) {
    return 0;
  }

  // Fast path: pure ASCII (common for code, paths, English text)
  if (/^[\x20-\x7E]*$/.test(stripped)) {
    return stripped.length;
  }

  // Full Unicode path via string-width (handles CJK, emoji, grapheme clusters)
  if (_stringWidth === undefined) {
    try {
      const mod = require('string-width');
      const fn =
        typeof mod === 'function'
          ? mod
          : mod && typeof mod.default === 'function'
            ? mod.default
            : null;
      _stringWidth = fn || null;
    } catch {
      _stringWidth = null;
    }
  }
  if (_stringWidth) {
    try {
      return _stringWidth(stripped);
    } catch {
      /* fallback below */
    }
  }

  // Fallback: manual calculation for environments without string-width
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33bf) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fa1f) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff)
    ) {
      width += 2;
    } else if (cp >= 0x0300 && cp <= 0x036f) {
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
    if (!_displayWidthMemo) {
      _displayWidthMemo = require('./displayWidthMemo');
    }
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
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x33bf) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff)
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
    String((process.env && process.env.KHY_TRUNCATE_ANSI_LINEAR) || '')
      .trim()
      .toLowerCase()
  );
}

// Sticky CSI-SGR matcher: `y` flag anchors at lastIndex without slicing.
const _CSI_SGR_STICKY = /\x1b\[[0-9;]*m/y;

function _truncateToWidthLegacy(str, maxWidth) {
  let result = '';
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    // ANSI escape — skip entirely (zero width)
    if (cp === 0x1b) {
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
    if (cp >= 0x0300 && cp <= 0x036f) {
      continue;
    }
    const charWidth = _isWideCodePoint(cp) ? 2 : 1;
    if (w + charWidth + 3 > maxWidth) {
      // reserve 3 for '...'
      result += '...';
      break;
    }
    result += ch;
    w += charWidth;
  }
  return result;
}

function truncateToWidth(str, maxWidth) {
  if (displayWidth(str) <= maxWidth) {
    return str;
  }
  if (!_truncateAnsiLinearEnabled()) {
    return _truncateToWidthLegacy(str, maxWidth);
  }

  let result = '';
  let w = 0;
  let i = 0;
  const len = str.length;
  while (i < len) {
    const cp = str.codePointAt(i);
    const chLen = cp > 0xffff ? 2 : 1;
    // ANSI escape — consume the whole CSI-SGR sequence at zero width.
    if (cp === 0x1b) {
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
    if (cp >= 0x0300 && cp <= 0x036f) {
      i += chLen;
      continue;
    }
    const charWidth = _isWideCodePoint(cp) ? 2 : 1;
    if (w + charWidth + 3 > maxWidth) {
      // reserve 3 for '...'
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
  if (!str || typeof str !== 'string') {
    return '';
  }
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

// 启动屏的通知行历史上一律挂同一个前缀，一屏下来全是重复的字母，
// 看不出哪条讲登录、哪条讲版本。传了 label 就改成中文词前缀（「登录」「版本」
// 「清理」），靠词本身区分场景，不引入 emoji（仓库约定见本文件顶部的
// minimal icons, no emoji）。label 按显示宽度而不是字符数补齐：中文字占 2 列，
// 英文占 1 列，按 length 补会把混排的正文顶歪。
// 不传 label 时用 ASCII 'i' 前缀，避免 Windows 终端 ℹ (U+2139) 渲染为方块。
const NOTICE_LABEL_WIDTH = 4;

function printInfo(msg, label) {
  if (typeof label === 'string' && label.length > 0) {
    const pad = ' '.repeat(Math.max(0, NOTICE_LABEL_WIDTH - displayWidth(label)));
    console.log('  ' + chalk.blue(label) + pad + '  ' + msg);
    return;
  }
  console.log(chalk.blue('  i ') + msg);
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

  const dim = chalk.dim;
  const borderless = tableStyle.isBorderless(process.env);
  // 无框风格:用一个红色左竖条标示「这是错误块」,而不是画一圈框。竖条 + 正文的
  // 组合让文件浏览器/编辑器里的红色断块一眼可辨,又不会像满框那样把注意力从错误
  // 文本抢到线框上。有框风格保留圆角框,供需要的老用户用 KHY_TABLE_BORDERS=full 恢复。
  const gutter = borderless ? '  ' + chalk.red.bold('│') + ' ' : dim('  │') + '  ';
  const maxW = Math.min((process.stdout.columns || 80) - 4, 72);
  const contentW = borderless ? maxW : maxW - 4;

  const lines = [];

  // Helper: wrap text to content width
  function wrapLine(text) {
    const words = text.split(/\s+/);
    const wrapped = [];
    let cur = '';
    for (const w of words) {
      if (cur && displayWidth(cur + ' ' + w) > contentW) {
        wrapped.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    }
    if (cur) {
      wrapped.push(cur);
    }
    return wrapped.length ? wrapped : [''];
  }

  // Helper: render a content line. 无框时右侧不画 │,正文可随终端宽度自然换行。
  function addLine(text) {
    if (borderless) {
      lines.push(gutter + text);
      return;
    }
    const w = displayWidth(text);
    const pad = Math.max(0, contentW - w);
    lines.push(dim('  │') + '  ' + text + ' '.repeat(pad) + dim('│'));
  }

  function addEmpty() {
    if (borderless) {
      lines.push('');
      return;
    }
    lines.push(dim('  │') + ' '.repeat(contentW + 2) + dim('│'));
  }

  // Title bar
  if (borderless) {
    lines.push(chalk.red.bold(`  ✗ ${title}`));
  } else {
    const titleText = ` ✗ ${title} `;
    const titleW = displayWidth(titleText);
    const dashCount = Math.max(0, maxW - titleW - 2);
    lines.push(dim('  ╭─') + chalk.red.bold(titleText) + dim('─'.repeat(dashCount) + '╮'));
  }

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

  if (!borderless) {
    addEmpty();
    lines.push(dim('  ╰' + '─'.repeat(maxW) + '╯'));
  }

  console.log('');
  lines.forEach((l) => console.log(l));
  console.log('');
}

// 表格默认不画框:边框风格由纯叶子 cli/tableStyle 单点决定(门控 KHY_TABLE_BORDERS,
// 默认 minimal;设成 full 逐字节回到旧的满格框)。列靠空白分栏 —— 一屏里连着出两三张
// 表时,网格线比数据更抢眼,这正是「结果里线条太多」的来源。
function printTable(headers, rows) {
  const plainOutput =
    process.env.NO_COLOR != null ||
    String(process.env.FORCE_COLOR || '').trim() === '0' ||
    !(process.stdout && process.stdout.isTTY);
  const borderless = tableStyle.isBorderless(process.env);
  const padding = tableStyle.tablePadding(process.env);
  try {
    const chars = tableStyle.tableChars(process.env);
    const table = new Table({
      head: headers.map((h) => (plainOutput ? String(h) : chalk.cyan(h))),
      // chars 为 null(full 风格)时不传,让 cli-table3 用它自己的默认框。
      ...(chars ? { chars } : {}),
      style: {
        'padding-left': padding.paddingLeft,
        'padding-right': padding.paddingRight,
        head: plainOutput ? [] : ['cyan'],
        border: plainOutput ? [] : ['grey'],
      },
    });
    rows.forEach((row) => table.push(row));
    const rendered = table.toString();
    if (plainOutput) {
      // plain 模式是管道/重定向场景,输出大概率被机器消费:不缩进、不加线,原样给出。
      console.log(stripAnsi(rendered));
      return;
    }
    console.log(borderless ? _dressBorderlessTable(rendered) : rendered);
    return;
  } catch {
    // Fallback when cli-table3/string-width has ESM/CJS compatibility issues.
  }

  const colCount = headers.length;
  const normalizedRows = rows.map((row) => {
    const arr = Array.isArray(row) ? row : [row];
    const out = new Array(colCount).fill('');
    for (let i = 0; i < colCount; i++) {
      out[i] = String(arr[i] ?? '');
    }
    return out;
  });

  const colWidths = headers.map((h, i) => {
    const headerW = displayWidth(String(h));
    const rowW = normalizedRows.reduce(
      (max, row) => Math.max(max, displayWidth(String(row[i] ?? ''))),
      0
    );
    return Math.max(headerW, rowW);
  });

  // 无框回退:表头下压一条细线,其余靠列宽对齐。分隔线宽度按各列显示宽度加列距
  // 累加,而不是按字符数 —— 中文单元格占 2 列,按 length 算线会短一截。
  if (borderless) {
    const gap = ' '.repeat(padding.paddingRight);
    const renderRow = (cells, paint) =>
      cells
        .map((cell, i) => {
          const text = padToWidth(String(cell), colWidths[i]);
          return paint && !plainOutput ? paint(text) : text;
        })
        .join(gap)
        .replace(/\s+$/, '');
    const ruleWidth = colWidths.reduce((sum, w) => sum + w, 0) + padding.paddingRight * (colCount - 1);
    const rule = '  ' + '─'.repeat(Math.max(1, ruleWidth));

    console.log('  ' + renderRow(headers, (t) => chalk.cyan(t)));
    console.log(plainOutput ? rule : chalk.dim(rule));
    for (const row of normalizedRows) {
      console.log('  ' + renderRow(row, null));
    }
    return;
  }

  const top = `  ╭${colWidths.map((w) => '─'.repeat(w + 2)).join('┬')}╮`;
  const mid = `  ├${colWidths.map((w) => '─'.repeat(w + 2)).join('┼')}┤`;
  const bot = `  ╰${colWidths.map((w) => '─'.repeat(w + 2)).join('┴')}╯`;

  console.log(plainOutput ? top : chalk.dim(top));
  const headerLine = headers
    .map((h, i) => {
      const text = padToWidth(String(h), colWidths[i]);
      return ` ${plainOutput ? text : chalk.cyan(text)} `;
    })
    .join(plainOutput ? '│' : chalk.dim('│'));
  console.log(
    (plainOutput ? '  │' : chalk.dim('  │')) + headerLine + (plainOutput ? '│' : chalk.dim('│'))
  );
  console.log(plainOutput ? mid : chalk.dim(mid));

  for (const row of normalizedRows) {
    const rowLine = row
      .map((cell, i) => ` ${padToWidth(String(cell), colWidths[i])} `)
      .join(plainOutput ? '│' : chalk.dim('│'));
    console.log(
      (plainOutput ? '  │' : chalk.dim('  │')) + rowLine + (plainOutput ? '│' : chalk.dim('│'))
    );
  }
  console.log(plainOutput ? bot : chalk.dim(bot));
}

// 无框表格的收尾:cli-table3 只负责算列宽和补齐,缩进与表头细线由这里加。
// 之所以后处理而不是自己排版,是因为列宽计算(CJK 双宽、ANSI 不计宽、超长换行)
// 全在库里,重写一遍等于把同一个 bug 再犯一次。
//   1. 每行压 2 空格,与 printInfo/printSuccess 那一档缩进对齐;
//   2. 表头下压一条细线,否则表头会和数据糊成一片;
//   3. 抹掉行尾空白 —— 补齐留下的尾随空格在选中复制时会一起带走。
// 线宽按**去掉 ANSI 后的显示宽度**取各行最大值:中文单元格占 2 列,
// 按字符串长度算线会短一截,而这种短只有人眼能发现。
function _dressBorderlessTable(rendered) {
  const lines = String(rendered).split('\n');
  if (lines.length === 0) {
    return rendered;
  }
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''));
  const width = trimmed.reduce((max, l) => Math.max(max, displayWidth(stripAnsi(l))), 0);
  const rule = chalk.dim('  ' + '─'.repeat(Math.max(1, width)));
  const out = trimmed.map((l) => '  ' + l);
  // 只有存在数据行时才插线;单表头的空表插线只是又添一条孤零零的横杠。
  if (out.length > 1) {
    out.splice(1, 0, rule);
  }
  return out.join('\n');
}

// 内容宽度的细线:给一组「已经上过色」的行,量出它们去掉 ANSI 后的最大显示宽度,
// 按这个宽度画线。之所以不接受一个数字参数,是因为调用点原本写的都是魔法数(38 个
// 横杠),行长一变线就要么冒出去、要么缺一截 —— 让线跟着内容走,这类漂移就不存在了。
// 下限 20 是防退化:数据全空时不要吐出一条一格长的短横。
function _contentRule(rows) {
  const width = (Array.isArray(rows) ? rows : []).reduce(
    (max, r) => Math.max(max, displayWidth(stripAnsi(String(r)))),
    0
  );
  return '  ' + '─'.repeat(Math.max(20, width));
}

function printQuote(quote) {
  const change = quote.current - quote.preClose;
  const changePct = quote.preClose > 0 ? (change / quote.preClose) * 100 : 0;
  const color = change >= 0 ? chalk.red : chalk.green; // Chinese market: red = up
  const icon = change >= 0 ? ICON_BULL : ICON_BEAR;
  const arrow = change >= 0 ? '▲' : '▼';

  // 无框风格:标题 + 一条细线 + 缩进数据行(与本文件 printKeybindingsTip 同一节奏),
  // 不再画三面框。细线宽度按数据行的**实测显示宽度**取最大值 —— 原来那 38 个横杠是
  // 写死的,行长一变就要么冒出去要么缺一截。
  const borderless = tableStyle.isBorderless(process.env);
  const rows = [
    `现价  ${color(chalk.bold('¥' + quote.current.toFixed(2)))}  ${color(arrow + ' ' + (change >= 0 ? '+' : '') + changePct.toFixed(2) + '%')}`,
    `开盘  ¥${quote.open.toFixed(2)}  最高  ${chalk.red('¥' + quote.high.toFixed(2))}  最低  ${chalk.green('¥' + quote.low.toFixed(2))}`,
    `昨收  ¥${quote.preClose.toFixed(2)}  成交量  ${chalk.bold(formatVolume(quote.volume))}`,
  ];
  if (quote.date) {
    rows.push(`时间  ${chalk.dim(quote.date + ' ' + (quote.time || ''))}`);
  }

  console.log('');
  console.log(`  ${icon} ${chalk.bold(quote.name)} ${chalk.dim('(' + quote.symbol + ')')}`);
  console.log(chalk.dim(borderless ? _contentRule(rows) : '  ┌──────────────────────────────────────'));
  for (const row of rows) {
    console.log((borderless ? '  ' : '  │ ') + row);
  }
  if (!borderless) {
    console.log(chalk.dim('  └──────────────────────────────────────'));
  }
  console.log('');
}

function printBacktestResult(result) {
  const returnColor = result.totalReturn >= 0 ? chalk.red : chalk.green;
  const icon = result.totalReturn >= 0 ? ICON_BULL : ICON_BEAR;

  const borderless = tableStyle.isBorderless(process.env);

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
  // 无框风格:分组之间用空行断开,不再画 ├╌╌ 虚线 —— 一屏 16 行数据里插三条虚线,
  // 视觉噪声比它分隔出来的信息还多。装订线 │ 同样去掉,留两空格缩进即可。
  const body = rows.map(([label, value]) => {
    if (!label && !value) {
      return borderless ? '' : chalk.dim('  ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌');
    }
    const line = `${chalk.dim(padLabel(label))} ${value}`;
    return borderless ? `  ${line}` : `  │ ${line}`;
  });

  console.log('');
  console.log(`  ${ICON_CHART} ${chalk.bold('回测结果')} ${icon}`);
  console.log(chalk.dim(borderless ? _contentRule(body) : '  ┌──────────────────────────────────────'));
  body.forEach((line) => console.log(line));
  if (!borderless) {
    console.log(chalk.dim('  └──────────────────────────────────────'));
  }
  console.log('');
}

function safePercent(value, showSign = true) {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }
  const prefix = showSign && value >= 0 ? '+' : '';
  return prefix + Number(value).toFixed(2) + '%';
}

function safeNum(value, decimals = 2) {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }
  return Number(value).toFixed(decimals);
}

function formatCurrency(value) {
  return (
    '¥' +
    Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function formatVolume(vol) {
  if (!vol) {
    return '0';
  }
  if (vol >= 1e8) {
    return (vol / 1e8).toFixed(2) + '亿';
  }
  if (vol >= 1e4) {
    return (vol / 1e4).toFixed(2) + '万';
  }
  return String(vol);
}

function printHelp() {
  const pkg = require('../../package.json');
  const displayVersion = pkg.version;
  const cols = process.stdout.columns || 80;
  const contentW = Math.min(Math.max(40, cols - 6), 72);
  const dim = chalk.dim;

  // 按显示宽度补齐命令列,让中英文命令和说明保持同一列。
  const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - displayWidth(s)))}`;
  const cmdColW = Math.min(Math.floor(contentW * 0.65), 46);

  console.log('');
  console.log(`  ${chalk.cyan.bold(`khy OS v${displayVersion}`)} ${dim('命令速查')}`);
  console.log(dim('  ' + '─'.repeat(Math.min(contentW, 56))));
  console.log(`  ${dim('用法: khy <命令> [参数] [--选项]    AI: 直接输入自然语言即可对话')}`);
  console.log('');

  const groups = [
    {
      name: '核心',
      cmds: [
        ['app list|install|start|stop|status', '应用管理'],
        ['server start [--port N] | server status', '服务管理'],
        ['db init|seed|status', '数据库'],
        ['menu | clear | exit', '交互辅助'],
      ],
    },
    {
      name: 'AI 与网关',
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
      cmds: [
        ['quote|hq <代码|名称>', '实时行情'],
        ['backtest|bt <代码> [--strategy ...]', '策略回测'],
        ['data fetch <代码> | data list', '数据管理'],
        ['search <关键词> | analyze <代码>', '搜索与分析'],
      ],
    },
  ];

  groups.forEach((group, index) => {
    if (index > 0) console.log('');
    console.log(`  ${chalk.cyan.bold(group.name)}`);
    group.cmds.forEach(([cmd, desc]) => {
      console.log(`    ${pad(chalk.white(cmd), cmdColW)}  ${dim(desc)}`);
    });
  });

  console.log('');
  console.log(`  ${dim('示例:')}`);
  console.log(`    ${dim('khy gateway status     khy doctor     khy hq 茅台')}`);
  console.log(`    ${dim('khy help gateway       khy docs maintainer')}`);
  console.log(`  ${dim('更多: khy docs · 帮助主题: khy help <gateway|quant|ops>')}`);
  console.log('');

  // Keybinding cheat sheet (navigation / editing / session controls).
  printKeybindingsTip();
}

/**
 * Print the REPL keybinding cheat sheet, grouped by category.
 * Inline plain output (Rule 4: no scroll region), styled with chalk.dim/bold
 * and 2-space indentation to match the rest of the help surface.
 */
function printKeybindingsTip() {
  const dim = chalk.dim;
  const bold = chalk.bold;
  const label = (s) => chalk.white(bold(s));
  console.log(`  ${chalk.cyan.bold('快捷键')}`);
  console.log(dim('  ' + '─'.repeat(40)));
  console.log(
    `    ${label('导航')}  ${dim('Ctrl+A/E 或 Home/End(行首/尾) · ↑/↓(历史回放) · Ctrl+R(反向搜索)')}`
  );
  console.log(
    `    ${label('编辑')}  ${dim('Ctrl+W(删除单词) · Ctrl+D(删除字符/退出) · Ctrl+L(清屏)')}`
  );
  console.log(
    `    ${label('会话')}  ${dim('Ctrl+C ×1(中止请求) / ×3(强制退出) · Esc(中止/返回) · Tab(自动完成)')}`
  );
  console.log('');
}

function _normalizeHelpTopic(input = '') {
  const key = String(input || '')
    .trim()
    .toLowerCase();
  if (!key) {
    return null;
  }
  if (['gateway', 'gw', 'model', 'models', '网关', '模型'].includes(key)) {
    return 'gateway';
  }
  if (['quant', 'khyquant', 'trade', 'trading', '量化', '交易'].includes(key)) {
    return 'quant';
  }
  if (['ops', 'doctor', 'devops', '运维', '诊断', '排障'].includes(key)) {
    return 'ops';
  }
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
      [
        'gateway status --json --endpoints-only --provider <name>',
        '按 provider 过滤 endpoint 明细（支持逗号分隔）',
      ],
      [
        'gateway sample codex [--attempts 4] [--timeout-ms 12000] [--json]',
        '串行采集 Codex strict 样本并汇总 first_chunk / timeout / promptInjected',
      ],
      [
        'gateway debug-prompt [--tail 5|--adapter codex|--capsules|--why-full|--json|live|clear]',
        '查看、实时监听或清空 KHY 协议注入调试日志',
      ],
      ['gateway model', '选择默认通道与模型'],
      ['gateway prefer-remote', '一键切换到可用 API/桥接通道'],
      [
        'gateway tune-local [auto|fast|balanced|quality] [apply]',
        '本地模型参数智能匹配并写入 .env',
      ],
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

// Set by the TUI when it clears the ink frame to run a CLI command handler
// (e.g. /review, /backtest). When true, withSpinner writes directly to stdout
// because the TUI's own spinner is suspended and the screen is cleared.
// Also read by bootstrap() to show progress even when silent=true.
let tuiRunningCliCommand = false;
function isTuiRunningCliCommand() {
  return tuiRunningCliCommand;
}

// Module-level progress callback for withSpinner. When set, the spinner text
// is updated in-place with real progress from the caller.
let _spinnerProgressCb = null;

async function withSpinner(text, fn, { muteOutput = false, onProgress = null } = {}) {
  // When the Ink TUI owns the screen AND no CLI command is currently running,
  // skip all spinner stdout — TUI handles display via its own DynamicSpinner.
  // When a CLI command IS running (tuiRunningCliCommand === true), the TUI has
  // cleared its frame and we should show progress directly.
  if (process.env.KHY_INK_TUI_ACTIVE === '1' && !tuiRunningCliCommand) {
    return fn();
  }
  // On Windows, ora's ANSI cursor control conflicts with readline in REPL mode,
  // causing all output to be swallowed. Use a simple text fallback instead.
  const useSimpleSpinner = process.platform === 'win32' && process.stdin.isTTY;

  let spinner;
  if (useSimpleSpinner) {
    process.stdout.write(chalk.cyan(`  ◌ ${text}...`));
    spinner = {
      succeed: (msg) => {
        process.stdout.write('\r' + chalk.green(`  ✓ ${msg || text}`) + '\n');
      },
      fail: (msg) => {
        process.stdout.write('\r' + chalk.red(`  ✗ ${msg || text}`) + '\n');
      },
      update: (msg) => {
        process.stdout.write('\r' + chalk.cyan(`  ◌ ${msg}`) + '...'.padEnd(40));
      },
    };
  } else {
    try {
      const ora = (await import('ora')).default;
      spinner = ora({ text, indent: 2, discardStdin: false }).start();
    } catch {
      process.stdout.write(chalk.cyan(`  ◌ ${text}`));
      spinner = {
        succeed: (msg) => {
          process.stdout.write('\r' + chalk.green(`  ✓ ${msg || text}`) + '\n');
        },
        fail: (msg) => {
          process.stdout.write('\r' + chalk.red(`  ✗ ${msg || text}`) + '\n');
        },
        update: (msg) => {
          process.stdout.write('\r' + chalk.cyan(`  ◌ ${msg}`) + '...'.padEnd(40));
        },
      };
    }
  }

  // Wire up the progress callback so fn() can update spinner text in real-time.
  _spinnerProgressCb = onProgress;
  const _spinnerStart = Date.now();
  const _reportProgress = (msg) => {
    if (spinner && typeof spinner.update === 'function') {
      try {
        spinner.update(msg);
      } catch {
        /* spinner update is best-effort */
      }
    }
    if (_spinnerProgressCb) {
      _spinnerProgressCb(msg);
    }
  };

  // Auto-timer: update spinner text every second with elapsed time, even if
  // fn() never calls onProgress. Prevents the spinner from looking frozen.
  const _timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - _spinnerStart) / 1000);
    if (elapsed > 0) {
      _reportProgress(`${text} (${elapsed}s)`);
    }
  }, 1000);

  // Suppress noisy service logs (console + winston) while spinner runs
  let origLog, origWarn, origError, origLogLevel;
  if (muteOutput) {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
      const logger = require('../utils/logger');
      origLogLevel = logger.level;
      logger.level = 'silent';
    } catch {
      /* logger not available */
    }
  }

  const restore = () => {
    _spinnerProgressCb = null;
    clearInterval(_timer);
    if (!muteOutput) {
      return;
    }
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    try {
      const logger = require('../utils/logger');
      logger.level = origLogLevel || 'info';
    } catch {
      /* ignore */
    }
  };

  try {
    const result = await fn(_reportProgress);
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
  const cwdShort =
    cwd === home ? '~' : cwd.startsWith(home + path.sep) ? '~' + cwd.slice(home.length) : cwd;
  const ver = version || require('../../package.json').version;

  let modelName = '';
  try {
    const gateway = require('../services/gateway/aiGateway');
    const active = gateway.getActiveAdapter();
    modelName = active?.activeModel || '';
  } catch {
    /* best effort */
  }

  const providerText = String(aiProvider || 'AI');
  const modelText = String(modelName || '');
  const providerPart =
    modelText && !providerText.toLowerCase().includes(modelText.toLowerCase())
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
  NOTICE_LABEL_WIDTH,
  printTable,
  printQuote,
  printBacktestResult,
  printHelp,
  printKeybindingsTip,
  printHelpTopic,
  printDivider,
  // Formatting helpers
  formatCurrency,
  formatVolume,
  stripAnsi,
  displayWidth,
  getTerminalColumns,
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
  // TUI CLI command flag
  setTuiRunningCliCommand: (v) => { tuiRunningCliCommand = !!v; },
  isTuiRunningCliCommand,
};
