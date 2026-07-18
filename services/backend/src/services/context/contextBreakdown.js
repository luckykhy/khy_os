'use strict';

/**
 * contextBreakdown.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「学 CC 的显示,但**更重背后的逻辑与后端的功能**」+「TUI 缺少的
 * 显示多学 CC」。这是对齐 CC `/context` 的 **per-category 上下文分解 + 彩色网格**
 * (`src/utils/analyzeContext.ts` 后端分析器 + `src/components/ContextVisualization.tsx`
 * 呈现层)的后端逻辑移植。
 *
 * 背景:khy 既有 `/context` / CtxInspectTool 只显示上下文**总量**(used/limit/百分比/
 * 会话累计),历史上刻意跳过 CC 的 per-category 网格,理由是「khy 不携带 per-category
 * 数据 → honest-NA 不臆造」(见 contextPanelDetail.js 诚实边界①)。但该前提只在
 * call-site 不收集数据源时成立——system prompt 文本、工具定义 JSON、记忆文件、会话消息
 * **都是 khy 手里实实在在的数据**,只需在 call-site 收集后喂进本叶子按 token 估算 SSOT
 * 分解。故 goal「注重后端功能」的正解 = 补齐后端分解逻辑,而非继续 honest-NA。
 *
 * 本叶子只负责**纯逻辑**:接收 call-site 注入的 sections(每段带 name + text 或 tokens),
 * 用注入的 estimateTokens 算每类 token,追加 Autocompact buffer(reserved)与 Free space,
 * 再按 CC 完全相同的网格算法(每类占 round(tokens/window × TOTAL_SQUARES) 个方块,
 * 非 Free space 至少 1 格;末方块按小数填充度 squareFullness)生成 10×10 网格,最后渲染
 * 成 CC 风格 TUI 行(⛁ 满格 / ⛀ 半格 / ⛶ 空闲 / ⛝ 预留 + 右侧图例)。
 *
 * 数据源收集(IO)由 call-site 负责;收集不到的类别**省略**(honest-NA,不臆造 0 也不
 * 显空行)。门控关 / 坏输入 → 返回空,call-site 逐字节回退到今日纯总量输出。
 *
 * 门控 KHY_CONTEXT_BREAKDOWN(默认开;{0,false,off,no} 关)。
 *
 * 忠实移植的 CC 判据(可在参考源码核实):
 *   · analyzeContext.ts:1030-1118 类别顺序与名称(System prompt → System tools →
 *     MCP tools → Custom agents → Memory files → Skills → Messages);
 *   · :1122-1125 actualUsage = Σ 非 deferred tokens;
 *   · :1171-1176 freeTokens = max(0, window - actualUsage - reserved);
 *   · :1202-1250 GRID_WIDTH×GRID_HEIGHT=100(窄屏高 5),每类方块数与 squareFullness;
 *   · ContextVisualization.tsx:141-159 方块符号;:181-199 图例行格式。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/**
 * 是否启用 per-category 上下文分解网格。默认开(unset → 开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function contextBreakdownEnabled(env = process.env) {
  const raw = env && env.KHY_CONTEXT_BREAKDOWN;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/**
 * CC 类别的规范顺序(对齐 analyzeContext.ts 的 push 顺序)。call-site 传入的 sections
 * 若命中此表则按此序排列;未命中的按传入序追加在其后(在 reserved/free 之前)。
 */
const CATEGORY_ORDER = [
  'System prompt',
  'System tools',
  'MCP tools',
  'Custom agents',
  'Memory files',
  'Skills',
  'Messages',
];

const RESERVED_NAME = 'Autocompact buffer';
const FREE_NAME = 'Free space';

/** 安全非负整数(负/非有限/NaN → 0)。 */
// 收敛到 utils/toNonNegInt 单一真源(逐字节委托,调用点不变)
const _nonNegInt = require('../../utils/toNonNegInt');

/**
 * 数字→紧凑 token 文本,对齐 CC `formatTokens`:
 *   >= 1e6 → `x.xM`;>= 1e3 → `x.xk`(去掉多余 `.0`);否则原数。
 * @param {number} n
 * @returns {string}
 */
function formatTokens(n) {
  const v = _nonNegInt(n);
  if (v >= 1_000_000) return _trimZero(v / 1_000_000) + 'M';
  if (v >= 1_000) return _trimZero(v / 1_000) + 'k';
  return String(v);
}

function _trimZero(x) {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * 由注入 sections 构造 per-category 分解。
 *
 * @param {object}   input
 * @param {Array<{name:string, tokens?:number, text?:string, color?:string, isDeferred?:boolean}>} input.sections
 *        每段:tokens 优先;否则由 text 经 estimateTokens 估算;两者皆无 → 该段 0 token 被丢弃。
 * @param {number}   input.contextWindow   上下文窗口上限 token(<=0 → 分解不可算,返回 null)。
 * @param {number}   [input.reservedTokens] Autocompact buffer 预留 token(默认 0,不显)。
 * @param {function} [input.estimateTokens] 文本→token 估算器(缺省时 text-only 段被跳过)。
 * @param {object}   [env]
 * @returns {null | {
 *   categories: Array<{name,tokens,color?,isDeferred?}>,
 *   actualUsage: number, reservedTokens: number, freeTokens: number,
 *   totalTokens: number, contextWindow: number, percentage: number
 * }}
 *   门控关 / 无有效 sections / contextWindow<=0 → null(call-site 回退)。
 */
function analyzeContextBreakdown(input = {}, env = process.env) {
  if (!contextBreakdownEnabled(env)) return null;

  const contextWindow = _nonNegInt(input && input.contextWindow);
  if (contextWindow <= 0) return null;

  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  const estimate = typeof input.estimateTokens === 'function' ? input.estimateTokens : null;

  // 归一每段为 { name, tokens, color, isDeferred }。tokens 优先;否则 text→estimate。
  const normalized = [];
  for (const sec of rawSections) {
    if (!sec || typeof sec.name !== 'string' || !sec.name.trim()) continue;
    let tokens = 0;
    if (sec.tokens != null) {
      tokens = _nonNegInt(sec.tokens);
    } else if (typeof sec.text === 'string' && estimate) {
      try {
        tokens = _nonNegInt(estimate(sec.text));
      } catch {
        tokens = 0;
      }
    }
    if (tokens <= 0) continue; // 0 token 类别不显(对齐 CC:cat.tokens > 0 才 push)
    normalized.push({
      name: sec.name.trim(),
      tokens,
      color: typeof sec.color === 'string' ? sec.color : undefined,
      isDeferred: !!sec.isDeferred,
    });
  }

  if (normalized.length === 0) return null;

  // 按 CATEGORY_ORDER 排序;未命中者稳定追加在末尾(保留传入序)。
  const orderIndex = (name) => {
    const i = CATEGORY_ORDER.indexOf(name);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  const categories = normalized
    .map((c, i) => ({ c, i }))
    .sort((a, b) => orderIndex(a.c.name) - orderIndex(b.c.name) || a.i - b.i)
    .map((x) => x.c);

  // actualUsage:只算非 deferred(deferred 工具不占当前上下文,仅供可见性)。
  const actualUsage = categories.reduce((s, c) => s + (c.isDeferred ? 0 : c.tokens), 0);

  const reservedTokens = _nonNegInt(input.reservedTokens);
  const freeTokens = Math.max(0, contextWindow - actualUsage - reservedTokens);

  // reserved / free 作为特殊类别追加在末尾(对齐 CC 网格末尾放置)。
  if (reservedTokens > 0) {
    categories.push({ name: RESERVED_NAME, tokens: reservedTokens, color: 'reserved', reserved: true });
  }
  categories.push({ name: FREE_NAME, tokens: freeTokens, color: 'free', free: true });

  const percentage = contextWindow > 0
    ? Math.min(100, Math.round((actualUsage / contextWindow) * 100))
    : 0;

  return {
    categories,
    actualUsage,
    reservedTokens,
    freeTokens,
    totalTokens: actualUsage,
    contextWindow,
    percentage,
  };
}

/**
 * 由分解结果构造 GRID_HEIGHT×GRID_WIDTH 网格(对齐 CC 算法)。
 * 每类方块数 = round(tokens/window × TOTAL);非 Free space 至少 1 格。末方块 squareFullness
 * = 小数填充度(用于选 ⛁ 满 / ⛀ 半)。deferred 类别不进网格(不占上下文)。
 *
 * @param {Array} categories  analyzeContextBreakdown().categories
 * @param {number} contextWindow
 * @param {object} [opts]
 * @param {number} [opts.width=10]
 * @param {number} [opts.height=10]  窄屏可传 5
 * @returns {Array<Array<{categoryName:string, color?:string, squareFullness:number, reserved?:boolean, free?:boolean}>>}
 */
function buildContextGrid(categories, contextWindow, opts = {}) {
  const width = _nonNegInt(opts.width) || 10;
  const height = _nonNegInt(opts.height) || 10;
  const total = width * height;
  const cw = _nonNegInt(contextWindow);
  const cats = Array.isArray(categories) ? categories : [];
  if (total <= 0 || cw <= 0) return [];

  // 展开成方块序列。
  const squares = [];
  for (const cat of cats) {
    if (!cat || cat.isDeferred) continue; // deferred 不占格
    const exact = (cat.tokens / cw) * total;
    let count = Math.round(exact);
    if (cat.name !== FREE_NAME) count = Math.max(1, count);
    for (let k = 0; k < count && squares.length < total; k++) {
      // 末方块的填充度:最后一格取小数部分(0 视为满 1.0)。
      let fullness = 1.0;
      if (k === count - 1) {
        const frac = exact - Math.floor(exact);
        fullness = frac > 0 ? frac : 1.0;
      }
      squares.push({
        categoryName: cat.name,
        color: cat.color,
        squareFullness: fullness,
        reserved: !!cat.reserved,
        free: !!cat.free,
      });
    }
  }
  // 不足 total 用 Free space 补齐(防呈现层留空)。
  while (squares.length < total) {
    squares.push({ categoryName: FREE_NAME, color: 'free', squareFullness: 1.0, free: true });
  }

  // 折成 height 行 × width 列。
  const rows = [];
  for (let r = 0; r < height; r++) {
    rows.push(squares.slice(r * width, r * width + width));
  }
  return rows;
}

/**
 * 方块 → 显示符号(对齐 ContextVisualization.tsx:141-159)。
 *   Free space → '⛶'  预留 → '⛝'  满(fullness>=0.7)→ '⛁'  否则 → '⛀'
 */
function _squareGlyph(sq) {
  if (!sq) return ' ';
  if (sq.free) return '⛶';
  if (sq.reserved) return '⛝';
  return sq.squareFullness >= 0.7 ? '⛁' : '⛀';
}

/**
 * 渲染完整 TUI 行(网格 + 图例),纯文本无 ANSI(着色交调用方按 color 名映射)。
 * 门控关 / 空分解 → []。
 *
 * @param {object} breakdown  analyzeContextBreakdown() 返回
 * @param {object} [opts]
 * @param {number} [opts.width=10]
 * @param {number} [opts.height=10]
 * @param {string} [opts.model]   图例首行模型名(可选)
 * @param {object} [env]
 * @returns {string[]}  逐行文本(网格行 + 空行 + `按类别估算占用` + 各类别图例行)
 */
function renderContextBreakdownLines(breakdown, opts = {}, env = process.env) {
  if (!contextBreakdownEnabled(env)) return [];
  if (!breakdown || !Array.isArray(breakdown.categories) || breakdown.categories.length === 0) return [];

  const width = _nonNegInt(opts.width) || 10;
  const height = _nonNegInt(opts.height) || 10;
  const grid = buildContextGrid(breakdown.categories, breakdown.contextWindow, { width, height });

  const lines = [];

  // 网格(每格符号 + 空格,对齐 CC `'⛁ '`)。
  for (const row of grid) {
    lines.push(row.map(_squareGlyph).join(' '));
  }

  // 图例首行:model · used/limit tokens (pct%)。
  const model = typeof opts.model === 'string' && opts.model.trim() ? opts.model.trim() + ' · ' : '';
  lines.push('');
  lines.push(`${model}${formatTokens(breakdown.totalTokens)}/${formatTokens(breakdown.contextWindow)} tokens (${breakdown.percentage}%)`);
  lines.push('按类别估算占用');

  const cw = breakdown.contextWindow;
  for (const cat of breakdown.categories) {
    // Free space / reserved 也列(对齐 CC 底部单列),但 0 token 的普通类别不会进来。
    const glyph = cat.free ? '⛶' : cat.reserved ? '⛝' : cat.isDeferred ? ' ' : '⛁';
    const pct = cat.isDeferred ? 'N/A' : `${((cat.tokens / cw) * 100).toFixed(1)}%`;
    lines.push(`${glyph} ${cat.name}: ${formatTokens(cat.tokens)} tokens (${pct})`);
  }

  return lines;
}

module.exports = {
  contextBreakdownEnabled,
  analyzeContextBreakdown,
  buildContextGrid,
  renderContextBreakdownLines,
  formatTokens,
  CATEGORY_ORDER,
  RESERVED_NAME,
  FREE_NAME,
};
