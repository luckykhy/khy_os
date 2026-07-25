'use strict';

/**
 * contextSuggestions.js —— `/context` 网格的配套后端逻辑(纯叶子)。
 *
 * 移植自 Claude Code `src/utils/contextSuggestions.ts` 的
 * `generateContextSuggestions`:在 context 占用出现可优化信号时,产出
 * 一组可操作建议(near-capacity → 建议 /compact、大工具结果、Read 膨胀、
 * Memory 文件膨胀、autocompact 关闭),并按 severity(warning 先)+ 预计
 * 可节省 token 降序排序。
 *
 * 设计原则:
 * - 纯叶子:零 IO、确定性、绝不抛;全部输入由调用方注入。
 * - honest-NA:khy 的 `/context` 目前能真实提供 percentage 与按类别
 *   (categories)分解;per-tool-call 分解(toolCallsByType)与逐个 memory
 *   文件(memoryFiles)属于可选扩展契约 —— 上游能提供时才激活对应检查,
 *   缺失时跳过而非伪造数据。
 * - 门控 KHY_CONTEXT_SUGGESTIONS 默认开;关闭时 analyze 返回 []。
 */

const { formatTokens } = require('./contextBreakdown');

// -- 触发阈值(对齐 CC contextSuggestions.ts)
const LARGE_TOOL_RESULT_PERCENT = 15; // 工具结果 > 15% context
const LARGE_TOOL_RESULT_TOKENS = 10000;
const READ_BLOAT_PERCENT = 5; // Read 结果 > 5% context
const NEAR_CAPACITY_PERCENT = 80;
const MEMORY_HIGH_PERCENT = 5;
const MEMORY_HIGH_TOKENS = 5000;

// CC canonical 工具名(khy 与之对齐)
const BASH_TOOL_NAME = 'Bash';
const FILE_READ_TOOL_NAME = 'Read';
const GREP_TOOL_NAME = 'Grep';
const WEB_FETCH_TOOL_NAME = 'WebFetch';
const MEMORY_CATEGORY_NAME = 'Memory files';

/** 门控:默认开;仅 {0,false,off,no} 关闭。 */
function contextSuggestionsEnabled(env = process.env) {
  const raw = env && env.KHY_CONTEXT_SUGGESTIONS;
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function _num(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function _pct(part, whole) {
  const w = _num(whole);
  if (w <= 0) return 0;
  return (_num(part) / w) * 100;
}

/**
 * 生成 context 优化建议。
 *
 * @param {object} input
 * @param {number} input.percentage       总占用百分比(0-100)。
 * @param {number} [input.contextWindow]  context 窗口 token 上限(rawMaxTokens)。
 * @param {Array}  [input.categories]     analyzeContextBreakdown().categories,用于 Memory 类别兜底。
 * @param {Array}  [input.memoryFiles]    可选:[{path,tokens}] 逐个 memory 文件(提供时给出最大文件明细)。
 * @param {Array}  [input.toolCallsByType] 可选:[{name,callTokens,resultTokens}] per-tool-call 分解。
 * @param {boolean} [input.isAutoCompactEnabled] 可选:autocompact 是否开启(明确 false 才触发对应建议)。
 * @param {object} [env]
 * @returns {Array<{severity,title,detail,savingsTokens?}>}
 */
function analyzeContextSuggestions(input = {}, env = process.env) {
  if (!contextSuggestionsEnabled(env)) return [];
  if (!input || typeof input !== 'object') return [];

  const data = {
    percentage: _num(input.percentage),
    rawMaxTokens: _num(input.contextWindow),
    categories: Array.isArray(input.categories) ? input.categories : [],
    memoryFiles: Array.isArray(input.memoryFiles) ? input.memoryFiles : [],
    toolCallsByType: Array.isArray(input.toolCallsByType) ? input.toolCallsByType : null,
    isAutoCompactEnabled:
      typeof input.isAutoCompactEnabled === 'boolean' ? input.isAutoCompactEnabled : null,
  };

  const suggestions = [];

  _checkNearCapacity(data, suggestions);
  _checkLargeToolResults(data, suggestions);
  _checkReadResultBloat(data, suggestions);
  _checkMemoryBloat(data, suggestions);
  _checkAutoCompactDisabled(data, suggestions);

  // 排序:warning 优先,然后按预计可节省 token 降序。
  suggestions.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'warning' ? -1 : 1;
    }
    return (_num(b.savingsTokens) || 0) - (_num(a.savingsTokens) || 0);
  });

  return suggestions;
}

// -- near-capacity(≥ 80%)→ warning:建议立即 /compact
function _checkNearCapacity(data, suggestions) {
  if (data.percentage >= NEAR_CAPACITY_PERCENT) {
    const willAutoCompact = data.isAutoCompactEnabled === true;
    suggestions.push({
      severity: 'warning',
      title: `Context is ${Math.round(data.percentage)}% full`,
      detail: willAutoCompact
        ? 'Autocompact will trigger soon, which discards older messages. Use /compact now to control what gets kept.'
        : 'Autocompact is disabled. Use /compact to free space, or enable autocompact in /config.',
    });
  }
}

// -- 大工具结果(> 15% 且 > 10k token)——依赖可选 toolCallsByType
function _checkLargeToolResults(data, suggestions) {
  if (!data.toolCallsByType) return;
  for (const tool of data.toolCallsByType) {
    if (!tool || typeof tool !== 'object') continue;
    const resultTokens = _num(tool.resultTokens);
    const percent = _pct(resultTokens, data.rawMaxTokens);
    if (percent >= LARGE_TOOL_RESULT_PERCENT && resultTokens >= LARGE_TOOL_RESULT_TOKENS) {
      const s = _getLargeToolSuggestion(String(tool.name || ''), resultTokens, percent);
      if (s) suggestions.push(s);
    }
  }
}

// -- 按工具类型给出建议与节省比例(对齐 CC getLargeToolSuggestion)
function _getLargeToolSuggestion(toolName, tokens, percent) {
  const tokenStr = formatTokens(tokens);
  const p = percent.toFixed(0);
  switch (toolName) {
    case BASH_TOOL_NAME:
      return {
        severity: 'info',
        title: `Bash results using ${tokenStr} tokens (${p}%)`,
        detail: 'Large command output is filling context. Redirect verbose output to a file, or filter with head/grep.',
        savingsTokens: Math.floor(tokens * 0.5),
      };
    case FILE_READ_TOOL_NAME:
      return {
        severity: 'info',
        title: `Read results using ${tokenStr} tokens (${p}%)`,
        detail: 'File reads are large. Use offset/limit for big files, or reference earlier reads instead of re-reading.',
        savingsTokens: Math.floor(tokens * 0.3),
      };
    case GREP_TOOL_NAME:
      return {
        severity: 'info',
        title: `Grep results using ${tokenStr} tokens (${p}%)`,
        detail: 'Search results are large. Narrow the pattern or scope the path to reduce matches.',
        savingsTokens: Math.floor(tokens * 0.3),
      };
    case WEB_FETCH_TOOL_NAME:
      return {
        severity: 'info',
        title: `WebFetch results using ${tokenStr} tokens (${p}%)`,
        detail: 'Fetched pages are large. Prefer a targeted prompt so only the needed content is kept.',
        savingsTokens: Math.floor(tokens * 0.4),
      };
    default:
      if (percent >= 20) {
        return {
          severity: 'info',
          title: `${toolName} using ${tokenStr} tokens (${p}%)`,
          detail: 'This tool is consuming a significant portion of context.',
          savingsTokens: Math.floor(tokens * 0.2),
        };
      }
      return null;
  }
}

// -- Read 膨胀(≥ 5% 且 ≥ 10k,且未被 15% band 覆盖)——依赖可选 toolCallsByType
function _checkReadResultBloat(data, suggestions) {
  if (!data.toolCallsByType) return;
  const readTool = data.toolCallsByType.find((t) => t && t.name === FILE_READ_TOOL_NAME);
  if (!readTool) return;

  const resultTokens = _num(readTool.resultTokens);
  const totalReadTokens = _num(readTool.callTokens) + resultTokens;
  const totalReadPercent = _pct(totalReadTokens, data.rawMaxTokens);
  const readPercent = _pct(resultTokens, data.rawMaxTokens);

  // 已被 checkLargeToolResults 覆盖则跳过(避免重复)
  if (totalReadPercent >= LARGE_TOOL_RESULT_PERCENT && totalReadTokens >= LARGE_TOOL_RESULT_TOKENS) {
    return;
  }

  if (readPercent >= READ_BLOAT_PERCENT && resultTokens >= LARGE_TOOL_RESULT_TOKENS) {
    suggestions.push({
      severity: 'info',
      title: `File reads using ${formatTokens(resultTokens)} tokens (${readPercent.toFixed(0)}%)`,
      detail: 'If you are re-reading files, consider referencing earlier reads. Use offset/limit for large files.',
      savingsTokens: Math.floor(resultTokens * 0.3),
    });
  }
}

// -- Memory 文件膨胀(≥ 5% 且 ≥ 5k)——优先逐文件明细,否则用 category 总量兜底
function _checkMemoryBloat(data, suggestions) {
  let totalMemoryTokens = data.memoryFiles.reduce((sum, f) => sum + _num(f && f.tokens), 0);

  // 无逐文件数据时,从 categories 找 'Memory files' 类别总量(honest 兜底)
  let haveFiles = data.memoryFiles.length > 0;
  if (!haveFiles) {
    const cat = data.categories.find((c) => c && c.name === MEMORY_CATEGORY_NAME);
    if (cat) totalMemoryTokens = _num(cat.tokens);
  }

  const memoryPercent = _pct(totalMemoryTokens, data.rawMaxTokens);
  if (memoryPercent < MEMORY_HIGH_PERCENT || totalMemoryTokens < MEMORY_HIGH_TOKENS) return;

  let detail;
  if (haveFiles) {
    const largestFiles = [...data.memoryFiles]
      .sort((a, b) => _num(b && b.tokens) - _num(a && a.tokens))
      .slice(0, 3)
      .map((f) => `${_basename(String((f && f.path) || ''))} (${formatTokens(_num(f && f.tokens))})`)
      .join(', ');
    detail = `Largest: ${largestFiles}. Use /memory to review and prune stale entries.`;
  } else {
    detail = 'Use /memory to review and prune stale entries.';
  }

  suggestions.push({
    severity: 'info',
    title: `Memory files using ${formatTokens(totalMemoryTokens)} tokens (${memoryPercent.toFixed(0)}%)`,
    detail,
    savingsTokens: Math.floor(totalMemoryTokens * 0.3),
  });
}

// -- autocompact 关闭且 50% ≤ pct < 80%
function _checkAutoCompactDisabled(data, suggestions) {
  if (
    data.isAutoCompactEnabled === false &&
    data.percentage >= 50 &&
    data.percentage < NEAR_CAPACITY_PERCENT
  ) {
    suggestions.push({
      severity: 'info',
      title: 'Autocompact is disabled',
      detail:
        'Without autocompact, you will hit context limits and lose the conversation. Enable it in /config or use /compact manually.',
    });
  }
}

/** 纯字符串 basename(不触碰 path 模块以保持零 IO 叶子纯度)。 */
function _basename(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 将建议渲染为 CLI 行(供 `/context` 与 CtxInspectTool 复用)。
 * warning → ⚠,info → ℹ;有 savingsTokens 时附「可省 ~Nk」。
 *
 * @param {Array} suggestions analyzeContextSuggestions() 输出
 * @param {object} [opts] { title?: string }
 * @param {object} [env]
 * @returns {string[]}
 */
function renderContextSuggestionLines(suggestions, opts = {}, env = process.env) {
  if (!contextSuggestionsEnabled(env)) return [];
  if (!Array.isArray(suggestions) || suggestions.length === 0) return [];

  const lines = [];
  const heading = opts && typeof opts.title === 'string' ? opts.title : '优化建议';
  lines.push(heading);
  for (const s of suggestions) {
    if (!s || typeof s !== 'object') continue;
    const glyph = s.severity === 'warning' ? '⚠' : 'ℹ';
    let head = `${glyph} ${s.title || ''}`.trim();
    const save = _num(s.savingsTokens);
    if (save > 0) head += ` — 可省 ~${formatTokens(save)}`;
    lines.push(head);
    if (s.detail) lines.push(`  ${s.detail}`);
  }
  return lines;
}

module.exports = {
  contextSuggestionsEnabled,
  analyzeContextSuggestions,
  renderContextSuggestionLines,
  // 阈值导出便于测试断言边界
  NEAR_CAPACITY_PERCENT,
  LARGE_TOOL_RESULT_PERCENT,
  LARGE_TOOL_RESULT_TOKENS,
  READ_BLOAT_PERCENT,
  MEMORY_HIGH_PERCENT,
  MEMORY_HIGH_TOKENS,
};
