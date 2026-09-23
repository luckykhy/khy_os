'use strict';

/**
 * ccStatusBar.js —— CC 状态栏的**纯内容决策**（零 ink 依赖）
 *
 * 为什么单独成模块：状态栏同一行有两个消费者 ——
 *   ① `<CcStatusLine>`（画）② `ccMessageProjection`（拖选时逐行记账的预言机）。
 * 两边此前各写一份（投影层甚至**逐字抄**了模式映射），于是「画的是 A、账记的是 B」。
 * 现在两边都调本函数，片段选择/丢弃顺序只有一份真相。
 *
 * 为什么需要「 fitting」：状态栏在账本里只值 **1 行**（`ccLayout.js:138`
 * 「CcStatusLine = 1 row」，消息区预算据此扣减）。而组件原来只按**列数阈值**决定
 * 「这一段要不要显示」，从不按**实际显示宽度**决定「这一段还放不放得下」。
 * 段数一多（模型 │ 上下文 │ 费用 │ vim │ ⏱ │ 模式 │ ⚡命中率 │ MCP）总宽越过 cols，
 * ink 就把这一条 Box 折成 2 行 —— 帧高比账本多 1 行 ⇒ 越过终端 rows
 * ⇒ ink 走全屏分支写 `\x1b[2J` ⇒ win32 上把旧帧滚进 scrollback = 重影；
 * 同时每段被 flexbox 等比压缩，模型名从中间断词（`claude-sonnet-4` / `5`）。
 *
 * 因此这里**从右往左按重要性丢段**，并把行宽压进 cols：宁可少显示一段，
 * 也不让状态栏多占一行。
 *
 * 参考：[DESIGN-ARCH-081] Phase 2 布局结构迁移 · DESIGN-ARCH-103 H6（记账与画同源）
 */

const { visWidth, clipCell } = require('../wrapCell');
const { STATUS_SEPARATOR } = require('./ccLayout');
const { CC_COLORS } = require('../theme/ccTheme');

/**
 * 6 个后端 profile → 4 级简单模式显示（ZCode 对齐）。
 * 单一真源：所有前端模式显示必须走 getSimpleModeDisplay()。
 */
const PROFILE_TO_SIMPLE_MODE = Object.freeze({
  dontAsk: 'plan',
  strict: 'build',
  normal: 'build',
  acceptEdits: 'edit',
  auto: 'yolo',
  yolo: 'yolo',
});

const SIMPLE_MODE_DISPLAY = Object.freeze({
  plan: { label: 'plan', icon: '◈', color: CC_COLORS.info },
  build: { label: 'build', icon: '◉', color: CC_COLORS.warning },
  edit: { label: 'edit', icon: '◉', color: CC_COLORS.toolName },
  yolo: { label: 'yolo', icon: '⚡', color: CC_COLORS.error },
});

function getSimpleModeDisplay(profile) {
  const simple = PROFILE_TO_SIMPLE_MODE[profile] || 'build';
  return SIMPLE_MODE_DISPLAY[simple] || SIMPLE_MODE_DISPLAY.build;
}

/** 一行状态栏的显示宽度（含前导空格与分隔符）。 */
function lineWidth(segments) {
  return visWidth(' ' + segments.map((s) => s.text).join(STATUS_SEPARATOR));
}

/**
 * 构建**保证不超过 cols** 的状态栏片段。
 *
 * @param {object} o
 * @param {number} o.cols           终端列数（宿主传入，组件不得裸读 process.stdout）
 * @param {string} o.modelName
 * @param {string} o.contextStr      形如 `Context 100% (148k/128k)`
 * @param {string} [o.contextPct]    contextStr 的极简版（`100%`），挤不下时用
 * @param {string} [o.contextColor]
 * @param {number} [o.cost]
 * @param {string} [o.costStr]
 * @param {string} [o.vimMode]       'normal' | 'visual' | 'insert' | null
 * @param {string} [o.taskEstimate]  '2m' / '9h' …
 * @param {string} [o.permissionProfile]
 * @param {number} [o.cacheHitRate]
 * @param {{servers?: Array<{state?: string}>}} [o.mcpStatus]
 * @returns {Array<{key: string, text: string, color?: string}>}
 */
function buildStatusSegments(o) {
  const cols = Math.max(1, Math.floor(Number(o.cols) || 80));
  const contextStr = String(o.contextStr == null ? '' : o.contextStr);
  const contextPct = String(o.contextPct == null ? '' : o.contextPct)
    || (contextStr.match(/\d+%/g) || [])[0] || contextStr;

  // 全量片段（顺序 = 原 CcStatusLine 的顺序，语义不变）
  const all = [];
  all.push({ key: 'model', text: String(o.modelName == null ? '' : o.modelName), color: undefined });
  all.push({ key: 'context', text: contextStr, color: o.contextColor });
  if (Number(o.cost) > 0) {
    all.push({ key: 'cost', text: String(o.costStr == null ? '' : o.costStr), color: undefined });
  }
  if (o.vimMode) {
    all.push({
      key: 'vim',
      // '│ INST' 的竖线与列分隔符 STATUS_SEPARATOR(' │ ')同为 │，插桩段两侧夹出
      // '│ │' 双竖线（BUG-105）。vimEnabled 默认开且 CcPromptInput 的 vimMode 默认
      // 'insert' → 每个默认会话首帧即命中，非 vim 用户专属。改用 ▌（本仓 steps.js
      // FOCUS_ANCHOR 的「活动焦点」字形），1 列宽、与分隔符不复用。
      text: o.vimMode === 'normal' ? '● NORM' : o.vimMode === 'visual' ? '◒ VISU' : '▌ INST',
      color: o.vimMode === 'normal'
        ? CC_COLORS.success
        : o.vimMode === 'visual' ? CC_COLORS.warning : CC_COLORS.toolName,
    });
  }
  if (o.taskEstimate) {
    all.push({ key: 'estimate', text: `⏱ ${o.taskEstimate}`, color: CC_COLORS.info });
  }
  // 模式指示器是「现在会不会改到文件」的安全信息，与模型/上下文同级保留到最后。
  // 原来这里写着 `cols >= 50` 才显示 —— 那是**用列数阈值冒充宽度判断**：
  // 50 列放得下三段却放不下八段。现在一律先加上，挤不下由下面的丢档循环处理，
  // 所以窄终端反而比旧版多保留了这一段（旧版在 49 列直接不显示）。
  if (o.permissionProfile) {
    const disp = getSimpleModeDisplay(o.permissionProfile);
    all.push({ key: 'mode', text: `${disp.icon} ${disp.label}`, color: disp.color });
  }
  // 同理，原来 cache/MCP 段的 `cols >= 90` / `cols >= 80` 也是「列数阈值冒充
  // 宽度判断」。删掉阈值，改由丢档循环按**实际剩余宽度**决定放不放得下。
  const cache = Number(o.cacheHitRate);
  if (Number.isFinite(cache) && cache > 0) {
    all.push({
      key: 'cache',
      text: `⚡ ${Math.round(cache)}%`,
      color: cache >= 70 ? CC_COLORS.success : cache >= 40 ? CC_COLORS.warning : CC_COLORS.error,
    });
  }
  if (o.mcpStatus && Array.isArray(o.mcpStatus.servers) && o.mcpStatus.servers.length > 0) {
    const total = o.mcpStatus.servers.length;
    const connected = o.mcpStatus.servers.filter((s) => s && s.state === 'connected').length;
    all.push({
      key: 'mcp',
      text: `MCP •${connected}/${total}`,
      color: connected === total ? CC_COLORS.success : CC_COLORS.warning,
    });
  }

  // 丢弃顺序：先丢「锦上添花」，最后才动模型/上下文/模式。
  // 每一档 = 一个要丢的 key；'context→pct' 是**缩写**而不是删除。
  const TIERS = [
    ['mcp'],
    ['cache'],
    ['estimate'],
    ['vim'],
    ['cost'],
    ['SHORT_CONTEXT'],
    ['mode'],
  ];

  let shown = all;
  if (lineWidth(shown) > cols) {
    for (const tier of TIERS) {
      if (tier[0] === 'SHORT_CONTEXT') {
        const ctxIdx = shown.findIndex((s) => s.key === 'context');
        if (ctxIdx >= 0 && shown[ctxIdx].text !== contextPct) {
          shown = shown.map((s, i) => (i === ctxIdx ? { ...s, text: contextPct } : s));
        }
      } else {
        shown = shown.filter((s) => !tier.includes(s.key));
      }
      if (lineWidth(shown) <= cols) break;
    }
  }

  // 兜底：仍挤不下（窄终端 + 长模型名）就截断模型名。片段文本里没有 ANSI
  // （颜色走 Text 的 color 属性），所以「换掉模型段后的行宽」= 现行宽 −
  // 旧模型段宽 + 新模型段宽，可直接据此算预算。
  if (lineWidth(shown) > cols) {
    const modelIdx = shown.findIndex((s) => s.key === 'model');
    if (modelIdx >= 0) {
      const cur = shown[modelIdx].text;
      const spare = cols - (lineWidth(shown) - visWidth(cur));
      if (spare > 0) {
        shown = shown.map((s, i) => (i === modelIdx ? { ...s, text: clipCell(cur, spare) } : s));
      }
    }
  }
  // 最后一道保险：任何一段单独就超宽时（例如 cols < 8）整行按 cols 硬裁。
  if (lineWidth(shown) > cols) {
    const flat = ' ' + shown.map((s) => s.text).join(STATUS_SEPARATOR);
    const clipped = clipCell(flat, cols);
    shown = [{ key: 'model', text: clipped, color: undefined }];
  }
  return shown;
}

module.exports = {
  buildStatusSegments,
  getSimpleModeDisplay,
  PROFILE_TO_SIMPLE_MODE,
  SIMPLE_MODE_DISPLAY,
  lineWidth,
};
