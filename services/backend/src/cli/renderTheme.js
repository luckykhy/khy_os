/**
 * renderTheme.js — Theme constants, tool metadata, and formatting helpers
 * extracted from aiRenderer.js for modularity.
 *
 * Provides: THEME proxy, spinner config, dot/task indicators, phase labels,
 * tool display names, tool kind aliases, tool family icons, and related
 * utility functions.
 */
let _chalk;
const c = () => (_chalk ??= (require('chalk').default || require('chalk')));
const { displayWidth, padToWidth, truncateToWidth } = require('./formatters');
// Duration formatting SSOT — the faithful CC `formatDuration` port (cli/ccFormat),
// the SAME source HUD / turnStats / CompactionProgress / agent-tree already share.
const { ccFormatEnabled: _ccFormatEnabled, ccFormatDuration: _ccFormatDuration } = require('./ccFormat');

// ── Claude Code Theme Colors ───────────────────────────────────────────
// Theme is now data-driven via themeRegistry. THEME is a Proxy for backward compat.
const themeRegistry = require('./themeRegistry');
const THEME = new Proxy({}, {
  get(_, prop) { return themeRegistry.getTheme().colors[prop]; },
  ownKeys() { return Object.keys(themeRegistry.getTheme().colors); },
  getOwnPropertyDescriptor(_, prop) {
    const colors = themeRegistry.getTheme().colors;
    if (prop in colors) return { value: colors[prop], enumerable: true, configurable: true };
  },
  has(_, prop) { return prop in themeRegistry.getTheme().colors; },
});

let _interactiveGuard = null;

function setInteractiveGuard(fn) {
  _interactiveGuard = typeof fn === 'function' ? fn : null;
}

function isInteractiveInputActive() {
  try {
    return !!(_interactiveGuard && _interactiveGuard());
  } catch {
    return false;
  }
}

// ── Dynamic Spinner (Claude Code SpinnerGlyph exact match) ────────────
// Spinner sequence adapted for Khy-OS parity:
// keep the first frame as a solid dot, then cycle sparkle glyphs.
// Animation bounces forward then reverse for smooth cycling.
function _getSpinnerCharacters() {
  const theme = themeRegistry.getTheme();
  if (theme.spinnerChars) {
    const key = process.platform === 'darwin' ? 'darwin' : 'fallback';
    if (theme.spinnerChars[key]) return theme.spinnerChars[key];
  }
  if (process.platform === 'darwin') {
    return ['●', '✢', '✳', '✶', '✻', '✽'];
  }
  return ['●', '*', '+', '×', '+', '*'];
}
const _SPINNER_CHARS = _getSpinnerCharacters();
// Bounce: forward + reverse (excluding endpoints to avoid double-pause)
const SPINNER_FRAMES = [..._SPINNER_CHARS, ..._SPINNER_CHARS.slice(1, -1).reverse()];
const SPINNER_ACTIVE_CHAR = _SPINNER_CHARS[0];
const REDUCED_MOTION_DOT = SPINNER_ACTIVE_CHAR;

// Default UI language policy:
// - If explicit UI language is English, keep English thinking verbs.
// - Otherwise default to Chinese verbs for better local readability.
const _uiLangPref = String(process.env.KHY_UI_LANG || process.env.KHY_LANGUAGE || '').trim().toLowerCase();
const _preferEnglishUi = /^(en|en-us|english)\b/.test(_uiLangPref);
const _zhThinkingVerbs = ['解析请求', '校验约束', '整理上下文', '评估风险', '规划步骤', '归纳要点', '执行当前步骤', '汇总结果'];
const _enThinkingVerbs = ['Parsing request', 'Checking constraints', 'Organizing context', 'Evaluating risk', 'Planning steps', 'Summarizing findings', 'Executing current step', 'Preparing response'];
const THINKING_VERBS = (() => {
  const themed = themeRegistry.getTheme().thinkingVerbs;
  if (_preferEnglishUi) return Array.isArray(themed) && themed.length > 0 ? themed : _enThinkingVerbs;
  if (Array.isArray(themed) && themed.length > 0) {
    const joined = themed.join('');
    if (/[\u3400-\u9fff]/.test(joined)) return themed;
  }
  return _zhThinkingVerbs;
})();

const PHASE_LABELS = Object.assign({
  init:       '正在初始化',
  security:   '安全检查中',
  preprocess: '预处理输入',
  request:    '请求上游模型',
  thinking:   '分析约束与计划',
  analyzing:  '正在分析',
  generating: '生成最终答复',
  tools:      '执行工具步骤',
  explore:    '正在搜索',
  reading:    '正在读取文件',
  writing:    '正在写入文件',
  tool:       '执行工具步骤',
  done:       '交付完成',
  // 工具级细粒度标签 (G7)
  'tool:bash':       '正在执行命令',
  'tool:shell':      '正在执行命令',
  'tool:read':       '正在读取文件',
  'tool:readfile':   '正在读取文件',
  'tool:write':      '正在写入文件',
  'tool:writefile':  '正在写入文件',
  'tool:createfile': '正在创建文件',
  'tool:edit':       '正在编辑文件',
  'tool:editfile':   '正在编辑文件',
  'tool:multiedit':  '正在编辑文件',
  'tool:glob':       '正在搜索文件',
  'tool:grep':       '正在搜索代码',
  'tool:find':       '正在搜索文件',
  'tool:search':     '正在搜索',
  'tool:websearch':  '正在联网搜索',
  'tool:webfetch':   '正在抓取网页',
  'tool:agent':      '子代理执行中',
  'tool:task':       '任务执行中',
  'tool:todowrite':  '正在更新待办',
  'tool:notebookedit': '正在编辑笔记',
  'tool:ls':         '正在列出文件',
}, themeRegistry.getTheme().phaseLabels);

/**
 * Format elapsed seconds into a human-readable duration.
 *
 * Routes through the faithful CC `formatDuration` SSOT (cli/ccFormat) — the SAME
 * source HUD / turnStats / CompactionProgress / agent-tree already share — so the
 * spinner, step lines and task panel keep the trailing `0s` at whole minutes
 * ("2m 0s") and roll into h/d ("1h 2m 3s"), exactly like CC's SpinnerAnimationRow
 * which calls formatDuration() with no options. Sub-minute is byte-identical to
 * the legacy floor (ccFormatDuration's `${Math.floor(n/1000)}s` for n<60000).
 * Gate off (KHY_CC_FORMAT=0) → byte-identical legacy口径: drops the `0s` at minute
 * marks ("2m") and never rolls into hours (unbounded "123m 4s").
 */
function _formatElapsed(totalSec) {
  const sec = Math.floor(totalSec);
  if (_ccFormatEnabled(process.env)) {
    return _ccFormatDuration(Math.max(0, sec) * 1000);
  }
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

function _normalizeStatusTextForDedupe(text = '') {
  return String(text || '')
    .replace(/\d+(\.\d+)?s\b/gi, 'Xs')
    .replace(/\b\d+ms\b/gi, 'Xms')
    .replace(/\s+/g, ' ')
    .trim();
}

// Map tool names to Claude Code's userFacingName
const _defaultToolNames = {
  bash:          'Bash',
  shell:         'Bash',
  shellcommand:  'Bash',
  command:       'Bash',
  read:          '读取',
  readfile:      '读取',
  write:         '写入',
  writefile:     '写入',
  createfile:    '写入',
  edit:          '修改',
  editfile:      '修改',
  multiedit:     '修改',
  notebookedit:  '修改',
  glob:          '搜索',
  grep:          '搜索',
  find:          '搜索',
  findfiles:     '搜索',
  search:        '搜索',
  searchcontent: '搜索',
  websearch:     '搜索',
  webfetch:      '抓取',
  todowrite:     '待办',
  notebookread:  '读取',
  agent:         '代理',
  task:          '任务',
  ls:            '搜索',
};
const TOOL_DISPLAY_NAMES = Object.assign({}, _defaultToolNames, themeRegistry.getTheme().toolDisplayNames);

const TOOL_KIND_ALIASES = {
  read: 'reading',
  readfile: 'reading',
  ls: 'explore',
  glob: 'explore',
  grep: 'explore',
  find: 'explore',
  findfiles: 'explore',
  search: 'explore',
  searchcontent: 'explore',
  websearch: 'explore',
  webfetch: 'explore',
  todowrite: 'tools',
  notebookread: 'reading',
  task: 'explore',
  bash: 'explore',
  shell: 'explore',
  shellcommand: 'explore',
  command: 'explore',
  write: 'writing',
  writefile: 'writing',
  createfile: 'writing',
  edit: 'writing',
  editfile: 'writing',
  multiedit: 'writing',
  notebookedit: 'writing',
};

// ── Tool-kind helpers ─────────────────────────────────────────────────

function normalizeToolKind(name = '') {
  const raw = String(name).toLowerCase().replace(/[\s_-]/g, '');
  return TOOL_KIND_ALIASES[raw] || 'tools';
}

/**
 * Map internal tool name to Claude Code's userFacingName.
 * e.g. "shell_command" -> "Bash", "read_file" -> "Read", "glob" -> "Search"
 */
function getToolDisplayName(name = '') {
  const raw = String(name).toLowerCase().replace(/[\s_-]/g, '');
  return TOOL_DISPLAY_NAMES[raw] || name;
}

function summarizeToolDetail(name = '', params = '') {
  const kind = normalizeToolKind(name);
  const text = String(params || '').trim().replace(/\s+/g, ' ');
  const short = text.length > 60 ? `${text.slice(0, 60)}...` : text;
  return { kind, short };
}

function getToolKindLabel(name = '') {
  const raw = String(name).toLowerCase().replace(/[\s_-]/g, '');
  // 优先使用 tool: 前缀的细粒度中文标签 (G7)
  if (PHASE_LABELS[`tool:${raw}`]) return PHASE_LABELS[`tool:${raw}`];
  const kind = normalizeToolKind(name);
  return PHASE_LABELS[kind] || '工具';
}

// ── Process Step Indicators (Claude Code style) ────────────────────────

// Match Claude Code's exact indicator symbols
// Claude Code uses ● (BLACK_CIRCLE) for all statuses, colored by state
const _isMac = process.platform === 'darwin';
const DOT_PENDING  = '○';                     // not started
const DOT_INDICATOR = '●';                    // in-progress (colored by context)
const DOT_SUCCESS  = '●';                     // completed (green)
const DOT_ERROR    = '●';                     // failed (red)
const DOT_DONE     = '●';                     // finished (dimmed)

// ── Task Plan Indicators ──────────────────────────────────────────────
const TASK_PENDING     = '☐';
const TASK_IN_PROGRESS = '■';
const TASK_COMPLETED   = '✔';

// ── Tool Family Icons ─────────────────────────────────────────────────
// 不同工具类别用不同图标，一眼区分操作类型
// 旧版 Windows 终端 (Consolas) 缺少 ⌕⊙◐☐，降级为 ASCII
const { isLegacyWinTerminal: _isLegacyWinTerm } = require('../tools/platformUtils');
const _lwt = _isLegacyWinTerm();

const TOOL_FAMILY_ICONS = {
  bash: _lwt ? '>' : '▶',       // 执行
  shell: _lwt ? '>' : '▶',
  shellcommand: _lwt ? '>' : '▶',
  command: _lwt ? '>' : '▶',
  read: _lwt ? '>' : '▷',       // 读取
  readfile: _lwt ? '>' : '▷',
  notebookread: _lwt ? '>' : '▷',
  write: _lwt ? '+' : '◆',      // 写入
  writefile: _lwt ? '+' : '◆',
  createfile: _lwt ? '+' : '◆',
  edit: _lwt ? '~' : '◇',       // 编辑
  editfile: _lwt ? '~' : '◇',
  multiedit: _lwt ? '~' : '◇',
  notebookedit: _lwt ? '~' : '◇',
  glob: _lwt ? '?' : '⌕',       // 搜索
  grep: _lwt ? '?' : '⌕',
  find: _lwt ? '?' : '⌕',
  findfiles: _lwt ? '?' : '⌕',
  search: _lwt ? '?' : '⌕',
  searchcontent: _lwt ? '?' : '⌕',
  ls: _lwt ? '?' : '⌕',
  websearch: _lwt ? '@' : '⊙',  // 网络
  webfetch: _lwt ? '@' : '⊙',
  agent: _lwt ? '*' : '◐',      // 代理
  task: _lwt ? '*' : '◐',
  todowrite: _lwt ? '#' : '☐',  // 任务
};

/**
 * 获取工具家族图标，未匹配的返回默认 ●
 */
function getToolFamilyIcon(toolName) {
  const name = String(toolName).toLowerCase().replace(/[\s_-]/g, '');
  return TOOL_FAMILY_ICONS[name] || DOT_INDICATOR;
}

const TREE_LAST    = _lwt ? '`-' : '⎿';                     // Claude Code uses ⎿ for tree branches
const TREE_MID     = _lwt ? '|-' : '├';

module.exports = {
  // Lazy chalk accessor
  c,
  // Theme
  THEME,
  themeRegistry,
  // Interactive guard
  setInteractiveGuard,
  isInteractiveInputActive,
  // Spinner
  _getSpinnerCharacters,
  SPINNER_FRAMES,
  SPINNER_ACTIVE_CHAR,
  REDUCED_MOTION_DOT,
  // Labels & verbs
  THINKING_VERBS,
  PHASE_LABELS,
  // Tool metadata
  TOOL_DISPLAY_NAMES,
  TOOL_KIND_ALIASES,
  TOOL_FAMILY_ICONS,
  // Formatting helpers
  _formatElapsed,
  _normalizeStatusTextForDedupe,
  // Tool-kind functions
  normalizeToolKind,
  getToolDisplayName,
  summarizeToolDetail,
  getToolKindLabel,
  getToolFamilyIcon,
  // Dot indicators
  DOT_PENDING,
  DOT_INDICATOR,
  DOT_SUCCESS,
  DOT_ERROR,
  DOT_DONE,
  // Task indicators
  TASK_PENDING,
  TASK_IN_PROGRESS,
  TASK_COMPLETED,
  // Tree glyphs
  TREE_LAST,
  TREE_MID,
};
