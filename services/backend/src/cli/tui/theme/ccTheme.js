'use strict';

/**
 * ccTheme.js —— CC 主题色板
 *
 * 基于 Claude Code 官方实现。核心设计原则：
 * 1. 完全继承终端颜色主题，不强制覆盖
 * 2. 工具标识使用青色系（#00D4D4 暗色 / #008B8B 亮色）
 * 3. 语义颜色：绿=成功、红=错误、黄=警告、灰=系统
 * 4. 粗体用于工具名称和斜杠命令
 *
 * 参考：[DESIGN-ARCH-081] Phase 1: 配色与主题系统
 */

const CC_COLORS = Object.freeze({
  // 工具标识色（核心品牌色 —— 青色系，低饱和度对齐 ZCode #00a6b3）
  toolName: '#00B4B4',       // 暗色终端：青色（工具名称）
  toolNameLight: '#008B8B',  // 亮色终端：深青色
  toolBorder: '#00B4B4',     // 工具调用边框/下划线

  // 语义状态色（暗色终端，低饱和度对齐 ZCode）
  success: '#22C55E',        // 绿色 — 完成/成功 ✓
  successLight: '#16A34A',   // 深绿色 — 亮色终端
  error: '#EF4444',          // 红色 — 错误/失败 ✗
  errorLight: '#DC2626',     // 深红色 — 亮色终端
  warning: '#F59E0B',        // 黄色 — 警告/进行中 ⏳
  warningLight: '#D97706',   // 深黄色 — 亮色终端
  info: '#3B82F6',           // 蓝色 — 信息/链接

  // 中性色（暗色终端）
  text: undefined,           // 终端默认前景色（不覆盖）
  textSecondary: '#A0A0A0',  // 次要文字
  dim: 'dim',                // Ink dim 修饰符
  dimColor: '#6B7280',       // 灰色 — 系统消息/标签
  border: '#374151',         // 分割线/边框
  background: undefined,     // 终端默认背景（不覆盖）

  // 亮色终端覆盖
  lightText: '#1A1A1A',      // 主文字
  lightTextSecondary: '#666666', // 次要文字
  lightBgSecondary: '#F5F5F5',   // 次要背景
  lightBgToolResult: '#F0F0F0', // 工具结果块背景
  lightBgThinking: '#F9F9F9',   // 思考折叠块背景
  lightBgError: '#FFF0F0',      // 错误块背景
  lightBorder: '#E0E0E0',       // 边框

  // 特殊组件色
  inactive: '#555555',       // 非活跃态
  highlight: '#2563EB',      // 高亮背景（低饱和度蓝）
  selectedBg: '#2563EB20',   // 选中项背景（带透明度）
  link: '#00B4B4',           // 超链接（下划线）

  // 品牌色（橙色，低饱和度）
  brand: '#C97557',          // CC/Khy 橙色品牌色
  brandLight: '#D89878',     // 亮色
  brandDark: '#A85E3F',      // 暗色
  secondary: '#6366F1',      // 紫蓝色（分割线/标签页）
});

// ── ANSI 码缓存 ──────────────────────────────────────────────────────────────

const ANSI = Object.freeze({
  toolBold: '\x1B[1;36m',    // 粗体 + 青色
  success: '\x1B[32m',       // 绿色
  error: '\x1B[31m',         // 红色
  warning: '\x1B[33m',       // 黄色
  system: '\x1B[90m',        // 亮黑色（灰色）
  bold: '\x1B[1m',           // 粗体
  italic: '\x1B[3m',         // 斜体
  underline: '\x1B[4m',      // 下划线
  reset: '\x1B[0m',          // 重置
});

// ── 主题元数据 ──────────────────────────────────────────────────────────────

const CC_THEME = Object.freeze({
  name: 'claude-code',
  colors: CC_COLORS,
  ansi: ANSI,
  spacing: Object.freeze({
    messageGap: 1,             // marginTop between messages
    streamingGap: 1,           // marginTop before streaming text
    inputPaddingX: 2,          // horizontal padding in input area
    statusBarPaddingX: 1,      // horizontal padding in status bar
  }),
  borders: Object.freeze({
    useBorder: false,          // CC mode: no border on input
    borderColor: '#30363D',
    focusBorderColor: '#D77757',
  }),
  animation: Object.freeze({
    spinnerFrames: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
    spinnerColor: '#D77757',
    logoAnimation: true,
  }),
});

// ── 语义色 token（DESIGN-ARCH-102 §4.6）──────────────────────────────────────
// 7 个语义 token：accent / muted / success / warn / danger / border / focus。
// 组件应取用语义 token（经 resolvePalette 解算），而非直接取 CC_COLORS 的字面
// hex——字面量表只是「token → 默认值」映射的真源，配色层由 resolvePalette 统一
// 适配 NO_COLOR / CLICOLOR / colorDepth 三档。
const SEMANTIC = Object.freeze({
  accent: '#00B4B4', // 强调（工具名/链接/输入框边框）
  muted: '#A0A0A0', // 次要文字
  success: '#22C55E',
  warn: '#F59E0B',
  danger: '#EF4444',
  border: '#374151',
  focus: '#D77757',
});

// 16 色降级档：truecolor→256→16 三档思路（btop 同款），把 7 token 映射到 ANSI
// 基本 16 色，低色终端不至于全黑。
const ANSI16 = Object.freeze({
  accent: '\x1B[36',
  muted: '\x1B[90',
  success: '\x1B[32',
  warn: '\x1B[33',
  danger: '\x1B[31',
  border: '\x1B[90',
  focus: '\x1B[33',
});

/**
 * 解算 7 语义 token 到当前终端可用颜色（DESIGN-ARCH-102 §4.6 P2-7）。
 * 检测链：NO_COLOR > CLICOLOR_FORCE > CLICOLOR > tty。
 *   - NO_COLOR 非空           → 全灰阶（零彩色）
 *   - CLICOLOR_FORCE 非 0     → 强制彩色
 *   - CLICOLOR=0 && 非 force  → 全灰阶
 *   - colorDepth < 8（16 色档）→ 映射到 ANSI16 基本色
 * @param {object} [env]
 * @param {{colorDepth?: number}} [caps] 来自 terminalCapabilities.detectCapabilities
 * @returns {Record<string, string>} accent/muted/… → 可用颜色值（SGR 前缀或 hex）
 */
function resolvePalette(env = process.env, caps = {}) {
  const v = (k) => String((env && env[k]) || '').trim();
  const noColor = v('NO_COLOR');
  const clicolorForce = v('CLICOLOR_FORCE');
  const clicolor = v('CLICOLOR');
  const isTty = !!caps.isTTY;
  const depth = Number(caps.colorDepth) > 0 ? Number(caps.colorDepth) : 24;

  let gray = false;
  if (noColor !== '') gray = true; // NO_COLOR 最高优先级（哪怕 CLICOLOR_FORCE）
  else if (clicolorForce === '0' && clicolor === '0') gray = true;
  else if (clicolor === '0' && !isTty) gray = true;

  if (gray) {
    const g = '#808080';
    return { accent: g, muted: g, success: g, warn: g, danger: g, border: g, focus: g };
  }

  // 16 色档（colorDepth < 8）→ 基本 ANSI 色映射；truecolor/256 → 用默认 hex。
  if (depth < 8) {
    const out = {};
    for (const k of Object.keys(SEMANTIC)) {
      out[k] = ANSI16[k] + 'm' + SEMANTIC[k];
    }
    return out;
  }
  return Object.assign({}, SEMANTIC);
}

module.exports = { CC_COLORS, ANSI, CC_THEME, SEMANTIC, ANSI16, resolvePalette };
