'use strict';

/**
 * CcTranscriptView.js — CC 风格转录视图（Claude Code Ctrl+O 对齐）
 *
 * 设计：
 * - 时间戳 + 模型信息 + 可展开工具调用
 * - 每条消息显示发送时间、角色、模型名
 * - 工具调用可展开查看完整参数和结果
 * - 键盘导航：↑/↓ 浏览，Enter 展开/折叠，Esc 关闭
 *
 * 分页滚动（[DESIGN-ARCH-085] §4.1 / [DESIGN-ARCH-087] §2 / BUG-76）：
 * - 预算的单位是**终端行数**，不是消息条数。一条消息至少 2 行（头 + 正文），
 *   展开工具后更多 —— 旧的 `VISIBLE_WINDOW = 8`（条数）在 12 行终端上照画 30 行，
 *   ink 因此走全屏分支写 `\x1b[2J`（win32 把旧帧滚进回滚缓冲 = 整屏残影）。
 * - 视口由「选中下标 + 逐行累计」决定：从选中那条起往下塞满预算为止，
 *   所以高亮项永远在屏上（与 ./CcCommandPalette.js 的 BUG-61 判据同一条）。
 * - 每一行**渲染前**就按显示宽度裁/折好（../wrapCell 同源），行数与渲染不可能漂移；
 *   标题栏与提示语同属行会计，放不下就换紧凑版并被裁切，绝不折成第二行。
 * - 上方/下方有隐藏内容时显示 `⋯ (N above/below)` 指示器（CcScrollIndicators），
 *   两侧各至多 1 行，已计入 chrome。
 * - 键盘：↑/↓ 单条浏览，PageUp/PageDown 翻页（半页），g/G 跳到顶/底（无新增按键）
 *
 * 参考：Claude Code Transcript Viewer（Ctrl+O）
 * 对齐：[DESIGN-ARCH-088] 快捷键系统
 */

const React = require('react');
const { Box, Text, useInput } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');
const { STATUS_SEPARATOR } = require('../utils/ccLayout');
const { CcScrollIndicators } = require('../components/CcScrollIndicators');
const { applyScroll } = require('../scrollActions');
const { wrapCell, clipCell, visWidth } = require('../wrapCell');
const ccLayout = require('./ccOverlayLayout');

/** 标题栏 1 行 + 上/下滚动指示器各 1 行（指示器可能不渲染，按最坏情况计费）。 */
const CHROME_ROWS = 3;
/** 单条消息正文最多显示几行（其余以「… 另有 K 行」明说，不静默丢）。 */
const CONTENT_ROW_CAP = 4;
/** 门控 KHY_CC_OVERLAY_FIT 关时的旧选取语义：一屏 8 **条**。 */
const LEGACY_WINDOW = 8;
/** 正文/工具块的左缩进（列）。 */
const BODY_INDENT = 2;

const HINT_FULL = '↑/↓ 浏览 · PgUp/Dn 翻页 · g/G 顶底 · Enter 展开 · Esc 关闭';
const HINT_COMPACT = '↑↓ 浏览 · PgUp/Dn 翻页 · Enter 展开 · Esc 关闭';
const HINT_TINY = '↑↓ 浏览 · Esc 关闭';

/**
 * 格式化时间戳
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * 把一段带色的 span 序列塞进 `w` 列：放得下的整段保留，第一个放不下的裁切，其后的丢掉。
 * 出口保证 `visWidth(合计) <= w` —— 即「这一行只占 1 视觉行」是构造出来的，不是估计出来的。
 */
function _fitSpans(spans, w) {
  const limit = Math.max(1, Math.floor(Number(w) || 1));
  let used = 0;
  const out = [];
  for (const s of spans) {
    const room = limit - used;
    if (room <= 0) break;
    const text = String(s && s.text != null ? s.text : '');
    if (!text) continue;
    const width = visWidth(text);
    if (width <= room) {
      out.push({ ...s, text });
      used += width;
      continue;
    }
    const cut = clipCell(text, room);
    if (cut) out.push({ ...s, text: cut });
    break;
  }
  return out;
}

/**
 * 把一条消息建模成行数组：`{ indent, spans }`，每元素恰好一个视觉行。
 *
 * @param {object} msg
 * @param {object} p
 * @param {number} p.inner 去掉左右 padding 后的可用列数
 * @param {number} p.budget 列表区可用行数（单条消息自身也不得超过它，否则「至少一条」形同虚设）
 * @param {boolean} p.expanded 工具调用是否展开
 */
function _messageRows(msg, { inner, budget, expanded }) {
  const rows = [];
  const isUser = msg.role === 'user';
  const ts = formatTimestamp(msg.timestamp || msg.id);

  rows.push({
    indent: 0,
    spans: _fitSpans([
      { text: ts, color: CC_COLORS.dimColor },
      { text: ' ' + STATUS_SEPARATOR + ' ', color: CC_COLORS.dimColor },
      {
        text: isUser ? '你' : (msg.model || '小K'),
        bold: true,
        color: isUser ? CC_COLORS.toolName : CC_COLORS.success,
      },
    ], inner),
  });

  const bodyW = Math.max(4, inner - BODY_INDENT);
  const body = String(msg.content || msg.text || '');
  if (body) {
    const lines = wrapCell(body, bodyW);
    const shown = lines.length > CONTENT_ROW_CAP ? lines.slice(0, CONTENT_ROW_CAP) : lines;
    for (const line of shown) rows.push({ indent: BODY_INDENT, spans: [{ text: line || ' ' }] });
    if (shown.length < lines.length) {
      rows.push({
        indent: BODY_INDENT,
        spans: [{ text: `… 另有 ${lines.length - shown.length} 行`, color: CC_COLORS.dimColor }],
      });
    }
  }

  const steps = Array.isArray(msg.steps) ? msg.steps : [];
  if (steps.length > 0) {
    rows.push({
      indent: BODY_INDENT,
      spans: [{
        text: `${expanded ? '▾' : '▸'} ${steps.length} 个工具调用`,
        color: CC_COLORS.dimColor,
      }],
    });
    if (expanded) {
      for (const step of steps) {
        const parts = [
          { text: '│ ', color: CC_COLORS.dimColor },
          {
            text: step.tool || 'unknown',
            color: step.status === 'error' ? CC_COLORS.error : CC_COLORS.toolName,
          },
        ];
        if (step.input) parts.push({ text: ` ← ${String(step.input)}`, color: CC_COLORS.dimColor });
        if (step.result) parts.push({ text: ` → ${String(step.result)}`, color: CC_COLORS.dimColor });
        rows.push({ indent: BODY_INDENT, spans: _fitSpans(parts, bodyW) });
      }
    }
  }

  // 单条自己就超预算时（长会话 + 矮终端）就地截断：宁可少看，也不许把整帧顶出屏幕。
  const maxRows = Math.max(2, Math.floor(Number(budget) || 0) || rows.length);
  if (rows.length > maxRows) {
    const dropped = rows.length - (maxRows - 1);
    rows.length = maxRows - 1;
    rows.push({
      indent: 0,
      spans: [{ text: `… 本条还有 ${dropped} 行未显示`, color: CC_COLORS.dimColor }],
    });
  }
  return rows;
}

/**
 * 行会计视口（纯函数，可单测）：从 `anchor` 那条起往下塞满 `budget` 行为止。
 *
 * 为什么锚在选中项而不是「页首」：一旦窗口起点与选中下标各算各的，
 * ↓ 过一页之后高亮项就跑到屏外（BUG-71/72 的原病灶）。锚在选中项 ⇒
 * 每按一次方向键，画面恰好平移一条消息，高亮恒在屏上。
 *
 * 只为窗口内的消息建模（O(可见)），长会话里不会为几百条消息逐字折行。
 *
 * @param {object} p
 * @param {Array} p.messages
 * @param {number} p.inner 可用显示列数（已去掉左右 padding）
 * @param {number} p.budget 列表区可用行数；`Infinity` = 不设行限（门控关的旧语义）
 * @param {number} p.anchor 选中消息下标
 * @param {(i:number)=>boolean} [p.isExpanded] 该消息的工具调用是否展开
 * @param {number} [p.maxItems] 条数上限（门控关时 = 旧的 8 条）
 * @returns {{visible: Array<{index:number, rows: Array}>, used: number, above: number, below: number}}
 */
function transcriptWindow({ messages, inner, budget, anchor, isExpanded, maxItems }) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const start = Math.min(Math.max(0, Math.floor(Number(anchor) || 0)), Math.max(0, total - 1));
  const capItems = Number.isFinite(Number(maxItems)) && Number(maxItems) > 0
    ? Math.floor(Number(maxItems))
    : 0;
  const visible = [];
  let used = 0;
  for (let i = total ? start : 0; i < total; i += 1) {
    const rows = _messageRows(list[i], {
      inner,
      budget,
      expanded: typeof isExpanded === 'function' ? Boolean(isExpanded(i)) : false,
    });
    if (i > start && used + rows.length > budget) break;
    visible.push({ index: i, rows });
    used += rows.length;
    if (capItems && visible.length >= capItems) break;
    if (used >= budget) break;
  }
  const last = visible.length ? visible[visible.length - 1].index : start;
  return {
    visible,
    used,
    above: start,
    below: Math.max(0, total - last - 1),
  };
}

/**
 * 转录视图组件
 *
 * @param {object} props
 * @param {Array} props.messages 全部消息（含时间戳/角色/模型/工具步骤）
 * @param {function} props.onClose Esc / 关闭
 * @param {number} [props.cols] 宿主（CcApp）终端列数；缺省走 ../effectiveDims
 * @param {number} [props.rows] 宿主终端行数；缺省走 ../effectiveDims
 */
function CcTranscriptView({ messages = [], onClose, cols, rows }) {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [expandedTools, setExpandedTools] = React.useState(new Set());

  const msgList = Array.isArray(messages) ? messages : [];
  const total = msgList.length;
  const termCols = ccLayout.termSize('cols', cols);
  const termRows = ccLayout.termSize('rows', rows);
  // 全窗口视图无框可用，按实际 chrome 计费（不吃 MIN_CHROME=5 的带框地板）。
  // 门控关 → 预算不设限，退回旧的「一屏 8 条」选取语义（裁宽仍生效：那是病灶本身）。
  const fit = ccLayout.isEnabled();
  const budget = fit
    ? ccLayout.rowBudget(termRows, CHROME_ROWS, { minChrome: CHROME_ROWS })
    : Number.POSITIVE_INFINITY;
  const inner = Math.max(8, termCols - 2);

  const win = transcriptWindow({
    messages: msgList,
    inner,
    budget,
    anchor: selectedIndex,
    isExpanded: (i) => expandedTools.has(i),
    maxItems: fit ? 0 : LEGACY_WINDOW,
  });
  const { above, below } = win;
  const pageCount = Math.max(1, win.visible.length);

  // 键盘导航：单条浏览 + 翻页 + 顶/底跳转，走 scrollActions.applyScroll（单一真源）
  useInput((input, key) => {
    if (key.escape) {
      onClose?.();
      return;
    }
    const nav = (action) => setSelectedIndex((i) => applyScroll(action, {
      offset: i, viewport: pageCount, total,
    }));
    if (key.upArrow) { nav('lineUp'); return; }
    if (key.downArrow) { nav('lineDown'); return; }
    if (key.pageUp) { nav('halfPageUp'); return; }
    if (key.pageDown) { nav('halfPageDown'); return; }
    if (input === 'g') { nav('top'); return; }
    if (input === 'G') { nav('bottom'); return; }
    if (key.return) {
      setExpandedTools((prev) => {
        const next = new Set(prev);
        if (next.has(selectedIndex)) {
          next.delete(selectedIndex);
        } else {
          next.add(selectedIndex);
        }
        return next;
      });
    }
  });

  const h = React.createElement;
  const spanNode = (s, si) => h(Text, {
    key: si,
    color: s.color,
    bold: s.bold || undefined,
    dimColor: s.dim || undefined,
  }, s.text);

  const leadW = visWidth('转录视图') + visWidth(` ${total} 条`) + visWidth(' · ');
  const room = inner - leadW;
  const hint = visWidth(HINT_FULL) <= room ? HINT_FULL
    : (visWidth(HINT_COMPACT) <= room ? HINT_COMPACT : HINT_TINY);
  const titleSpans = _fitSpans([
    { text: '转录视图', bold: true, color: CC_COLORS.brand },
    { text: ` ${total} 条`, color: CC_COLORS.dimColor },
    { text: ` · ${hint}`, color: CC_COLORS.dimColor },
  ], inner);

  return h(Box, { flexDirection: 'column', flexGrow: 1 },
    // 标题栏（恒 1 行：放不下换紧凑版，仍超则裁切，绝不折行）
    h(Box, { paddingX: 1 }, ...titleSpans.map(spanNode)),

    // 顶部滚动指示器（[DESIGN-ARCH-087] §2：上方有 N 条 → ⋯ (N above)）
    h(CcScrollIndicators, { key: 'scroll-top', above, below: 0 }),

    // 消息列表（视口内，逐行计费）
    h(Box, { flexDirection: 'column', flexGrow: 1 },
      win.visible.map((entry) => {
        const isSelected = entry.index === selectedIndex;
        return h(Box, {
          key: `tv-${entry.index}`,
          flexDirection: 'column',
          paddingX: 1,
          backgroundColor: isSelected ? CC_COLORS.selectedBg : undefined,
        },
          entry.rows.map((row, ri) => h(Box, { key: ri, marginLeft: row.indent },
            ...row.spans.map(spanNode))),
        );
      }),
    ),

    // 底部滚动指示器（[DESIGN-ARCH-087] §2：下方有 N 条 → ⋯ (N below)）
    h(CcScrollIndicators, { key: 'scroll-bottom', above: 0, below }),
  );
}

module.exports = {
  CcTranscriptView: React.memo(CcTranscriptView),
  transcriptWindow,
};
