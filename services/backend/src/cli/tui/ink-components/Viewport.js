'use strict';

/**
 * Viewport — 有界视口,在页面内滚动内容,不带动输入框。
 *
 * Ink 没有原生"区域内滚动"概念,本组件通过以下方式模拟:
 *   1. 测量视口可用行数(terminal 高度 - 其他 chrome)
 *   2. 维护 scrollOffset,只渲染可见窗口内的内容
 *   3. 提供键盘滚动(↑/↓/PageUp/PageDown/g/G)
 *
 * 两种使用方式:
 *
 *   A) children 模式(原有,适合少量动态子元素):
 *      <Viewport height={h} scroll={s} onScroll={setS}>
 *        {items.map((it, i) => <Text key={i}>{it}</Text>)}
 *      </Viewport>
 *
 *   B) lines 模式(新增,适合大量预渲染行 —— O(visible) 渲染,不重建子树):
 *      <Viewport height={h} scroll={s} onScroll={setS}
 *        lines={['line1', 'line2', ...]}
 *        autoScroll />
 *
 * lines 模式优势:
 *   - 父组件一次性算好全部视觉行(含软换行),Viewport 只做切片
 *   - 不创建 React 子元素 → 数千行时内存/重渲开销显著降低
 *   - autoScroll: lines 数组变长且当前在底部 → 自动追随底部
 *
 * ── selection prop(应用内自绘选择的反色渲染,可选)──────────────────────────
 *   传 `selection={{start:{line,col}, end:{line,col}}}`(半开区间,0-based,同一
 *   坐标系即 **lines 数组下标 == 屏幕行**)时,被覆盖的那一段用 `inverse: true`
 *   反色画出来,做出终端原生拖选的观感。这是 `[DESIGN-ARCH-119]` §4.2 第二层的
 *   **渲染侧**:选区模型在 `selection.js`(纯叶子),事件在 `mouseButtons.js`。
 *
 *   **不传 / 传 null 时逐字节不变** —— 走原来的单 `<Text>` 分支,不切三段、不加
 *   任何 prop。这条是硬承诺:Viewport 是全班次热路径,任一次多余的节点切分都会
 *   在大转录上放大成可见的掉帧;而绝大多数用户从不开选择。
 *
 *   已知偏差(诚实边界):`lines` 里已含 `buildTranscriptLines` 按列宽折好的**软换行**,
 *   视觉行 ≠ 逻辑行,跨软换行复制会在折行处带一个硬 `\n`(见 `selection.js` 头部)。
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

function Viewport({
  height = 10,
  scroll = 0,
  onScroll,
  children,
  lines = null,
  autoScroll = false,
  showIndicator = true,
  emptyText = '',
  selection = null,
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  // ── lines 模式:直接切片字符串数组 ──────────────────────────────────────────
  if (lines !== null && lines !== undefined) {
    const totalLines = lines.length;
    // 指示器与内容**共用同一份高度预算**:它一旦被推进这个 `height` 高的固定盒,
    // 盒里就有 `height + 1` 个子节点,yoga 按 flexShrink 把总高摊回 `height` ——
    // 中间那一行的高度取整成 0,**内容凭空少一行**(真机现象:第11行在模型里存在、
    // 能复制出来,但屏幕上永远看不见)。所以要让指示器就得先给它扣一行。
    const contentRows = viewportContentRows(height, totalLines, showIndicator);
    const maxScroll = Math.max(0, totalLines - contentRows);
    // 贴底语义:`scroll` 为 null/undefined/负数 → **追随底部**(显示最新内容)。
    // 历史实现用 `scroll >= maxScroll` 判「之前在底部」,但调用方初值是 0 ——
    // 内容一旦长过视口(`0 >= maxScroll` 恒假),视口就永远停在**顶部**,用户看到的
    // 仍是最早那几行,「输出回显看不见」的体感一半来自这里。
    // 数字偏移仍按固定位置处理;恰好在最底(数字 == maxScroll)时继续贴底,保持旧语义。
    const isSticky = autoScroll && (scroll === null || scroll === undefined || Number(scroll) < 0);
    let clampedScroll = isSticky
      ? maxScroll
      : Math.max(0, Math.min(Number(scroll) || 0, maxScroll));
    if (autoScroll && !isSticky && Number(scroll) >= maxScroll) {
      clampedScroll = maxScroll;
    }

    // 可见窗口
    const start = clampedScroll;
    const end = Math.min(totalLines, clampedScroll + contentRows);
    const visible = lines.slice(start, end);

    // 空内容
    if (totalLines === 0 && emptyText) {
      return h(
        Box,
        { flexDirection: 'column', height },
        h(Text, { dimColor: true }, `  ${emptyText}`)
      );
    }

    const rows = [];
    const hasSelection = selection !== null && selection !== undefined;
    for (let i = 0; i < visible.length; i++) {
      const line = visible[i];
      const rowIdx = start + i;
      // ── 无反色路径:逐字节保持原样(单 Text,不加任何 prop)──────────────
      if (!hasSelection) {
        rows.push(
          h(
            Box,
            { key: `vl-${rowIdx}` },
            h(Text, null, line || ' ')
          )
        );
        continue;
      }
      const seg = sliceLineForSelection(line, rowIdx, selection);
      if (!seg.highlighted) {
        rows.push(
          h(
            Box,
            { key: `vl-${rowIdx}` },
            h(Text, null, seg.head || ' ')
          )
        );
        continue;
      }
      // 三段 Text:前 / 高亮 / 后。**不能合并成一次 Text 加嵌套**,因为 ink 的
      // `inverse` 是整节点属性;唯一能做部分反色的方式是切节点。
      rows.push(
        h(
          Box,
          { key: `vl-${rowIdx}` },
          h(Text, null, seg.head),
          h(Text, { inverse: true }, seg.mid),
          h(Text, null, seg.tail)
        )
      );
    }

    // 滚动指示器
    if (showIndicator && maxScroll > 0) {
      const above = clampedScroll;
      const below = maxScroll - clampedScroll;
      const indicatorParts = [];
      if (above > 0) indicatorParts.push(`↑${above}`);
      if (below > 0) indicatorParts.push(`↓${below}`);
      if (indicatorParts.length > 0) {
        rows.push(
          h(
            Text,
            { key: 'vp-indicator', dimColor: true, color: '#484f58' },
            `  ${indicatorParts.join(' ')}`
          )
        );
      }
    }

    // overflow:'hidden' 是硬闸:调用方按 cols 折好的行若因实际列宽更窄而二次软换行,
    // 视觉行数会超过 `height`。不裁剪的话 live 区就会长过终端 rows → ink 切到 fullscreen
    // 分支(clearTerminal)→ 备用缓冲区里转录被整片抹掉。裁剪后最坏只是少显示几行,绝不会
    // 把整块 UI 顶穿。
    return h(Box, { flexDirection: 'column', flexGrow: 1, height, overflow: 'hidden' }, ...rows);
  }

  // ── children 模式(原有逻辑,兼容 PreviewLayout 等) ───────────────────────────
  const childArray = React.Children.toArray(children).filter(Boolean);
  const totalLines = childArray.length;

  // 滚动上界:内容不足视口时不可滚。
  const maxScroll = Math.max(0, totalLines - height);
  const clampedScroll = Math.max(0, Math.min(scroll, maxScroll));

  // 可见窗口
  const visible = childArray.slice(clampedScroll, clampedScroll + height);

  // 暴露滚动方法给父组件(通过 ref 回调)
  if (Viewport._registerScroll && onScroll) {
    Viewport._registerScroll(clampedScroll, maxScroll, onScroll);
  }

  return h(
    Box,
    { flexDirection: 'column' },
    visible,
    // 滚动指示器(可选)
    showIndicator && maxScroll > 0
      ? h(
          Text,
          { dimColor: true, color: '#484f58' },
          clampedScroll > 0 ? `  ↑ ${clampedScroll} 行` : '',
          clampedScroll < maxScroll ? `  ↓ ${maxScroll - clampedScroll} 行` : ''
        )
      : null
  );
}

// 滚动命令接口(供键盘处理器调用)
Viewport._registerScroll = null;

/**
 * 把「一行文本 + 全局选区」切成 `{head, mid, tail}` 三段,`mid` 段需要反色。
 *
 * 纯函数、零 IO、绝不抛 —— 单独导出是为了让渲染侧的分段逻辑可以被直接单测,
 * 不必起 React 渲染器(ink 的测试需要构造完整 yoga 树,成本高且易脆)。
 *
 * 坐标系:`lineIdx` 是 **lines 数组下标 == 屏幕行**(0-based);`col` 也是 0-based。
 * 与 `selection.js` 完全同源 —— 那不变量正是选这个数据结构的原因(见模块头部)。
 *
 * 语义要点:
 *   - 未命中本行 → `{head: line, mid: '', tail: '', highlighted: false}`,调用方
 *     走原路径。`highlighted` 这个显式标志是为了避免调用方用 `mid === ''` 反推 ——
 *     选区宽度为 0 与「未命中」在语义上不同,虽然渲染结果一样,但反推写法会在
 *     将来某天「零宽选区也要画个光标」时静默出错。
 *   - 命中本行 → `head + mid + tail === line`(**恒等**,空行时等于 `' '`),即反色
 *     不改变文本内容,只改变显示属性。这条恒等是 `viewportSelection.test.js` 守的
 *     核心不变量:一旦分段把某个字符吞掉,复制出的文本就与屏幕不一致。
 *   - 区间是**半开** `[from, to)`:拖到第 5 列反色到第 4 列,与鼠标直觉一致。
 *   - `line` 为 falsy(空行)时按单空格处理,与无选区路径的 `line || ' '` 对齐。
 *
 * 已知偏差(诚实边界):`lines` 里已含 `buildTranscriptLines` 按列宽折好的**软换行**,
 * 视觉行 ≠ 逻辑行,跨软换行复制会在折行处带一个硬 `\n`(见 `selection.js` 头部)。
 *
 * @param {string} line 该行原文(可能为空)
 * @param {number} lineIdx 该行的全局下标(== 屏幕行)
 * @param {{start?: {line?:number,col?:number}, end?: {line?:number,col?:number}}|null} selection
 * @returns {{head: string, mid: string, tail: string, highlighted: boolean}}
 */
function _intOrNull(v) {
  // 注意 `Math.trunc(Number(null)) === 0` —— 朴素写法会把「没有行号」静默当成第 0 行,
  // 于是选区漏到第一行上。这类 coerce 陷阱是 `V-16` 专门守的。
  if (v === null || v === undefined || v === '') {
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.trunc(n);
}

/**
 * 把一个「点」的两种可能形状收敛成 `{line, col}`:
 *   · `{line, col}` —— `selection.js` 的规范点;
 *   · `{startLine/startCol}` 之类扁平 Range 字段由调用方映射后再传入(见调用点)。
 * 任一字段非有限数 → `null`(降级不反色,绝不抛)。
 * @param {{line?:*, col?:*}} p
 * @returns {{line:number, col:number}|null}
 */
function _pointOf(p) {
  if (!p || typeof p !== 'object') {
    return null;
  }
  const line = _intOrNull(p.line);
  const col = _intOrNull(p.col);
  if (line === null || col === null) {
    return null;
  }
  return { line, col };
}

function sliceLineForSelection(line, lineIdx, selection) {
  const text = typeof line === 'string' ? line : '';
  // 空行按单空格处理 —— 与无选区路径的 `line || ' '` 严格对齐。若这里返回 '',
  // 空行会在有选区时塌掉一行高度,长转录里表现为「滚到某处以后整篇错位一行」。
  const shown = text === '' ? ' ' : text;
  // 「未反色」的规范形状:**整行放 head,mid 恒为空**。
  // 早先这里误把原文同时塞进 head 和 tail,调用方拼 `head+mid+tail` 就得到双份文本
  // —— 屏幕上看不出来(两段同色、无 separator),但 `viewportSelection.test.js` 的
  // I1 恒等断言当场抓住了它。这正是把分段抽成纯函数的意义。
  const miss = { head: shown, mid: '', tail: '', highlighted: false };
  if (!selection || typeof selection !== 'object') {
    return miss;
  }
  // ⚠ 选区形状是 `selection.js` 的契约:`{anchor:{line,col}, head:{line,col}}`。
  // **不是** `{start,end}` —— 那个形状会让 normalizeSelection 静默返回 null。
  // 这里也接受已经 normalize 过的扁平 Range(`{startLine,startCol,endLine,endCol}`),
  // 因为调用方可能缓存的是归一化后的结果;两种形状都在 _pointOf 里收敛。
  const a = _pointOf(selection.anchor) || _pointOf({
    line: selection.startLine,
    col: selection.startCol,
  });
  const b = _pointOf(selection.head) || _pointOf({
    line: selection.endLine,
    col: selection.endCol,
  });
  if (!a || !b) {
    return miss;
  }
  // 就地归一化(anchor/head 的大小关系不确定 —— 用户可能反着拖)。
  // 不 require selection.js 是为了保持 Viewport 的零依赖叶子性(它是最热路径)。
  const first = a.line < b.line || (a.line === b.line && a.col <= b.col) ? a : b;
  const last = first === a ? b : a;
  const row = _intOrNull(lineIdx);
  if (row === null) {
    return miss;
  }
  const sLine = first.line;
  const eLine = last.line;
  const sCol = first.col;
  const eCol = last.col;
  if (row < sLine || row > eLine) {
    return miss;
  }
  const len = text.length;
  // 首行从 start.col 起;中间行从 0 起;末行到 end.col 止(不含)。单行选区两端都在本行。
  let from = row === sLine ? sCol : 0;
  let to = row === eLine ? eCol : len;
  if (from < 0) from = 0;
  if (to > len) to = len;
  if (to < from) to = from;
  if (from === 0 && to >= len && len > 0) {
    // 整行被选中:整行反色,省掉两个空 Text 节点。
    return { head: '', mid: text, tail: '', highlighted: true };
  }
  if (len === 0) {
    // 空行被选中:必须吐出 `' '`,否则这一行在渲染时塌成 0 高,长转录里表现为
    // 「选中一个空行以后整篇往上错位一行」。`mid` 用已塑形的 `shown` 而非 `text`。
    return { head: '', mid: shown, tail: '', highlighted: true };
  }
  return {
    head: text.slice(0, from),
    mid: text.slice(from, to),
    tail: text.slice(to),
    highlighted: true,
  };
}

/**
 * 纯叶子:盒子高 → **可用内容行数**。
 *
 * 为什么需要它:滚动指示器是第 `height + 1` 个子节点,而外层 Box 是
 * `height` 高 + `overflow:'hidden'`。yoga 会把多出来的那一行摊到所有子节点上,
 * 中间那一行的高度取整成 0 —— 内容**在视口正中凭空少一行**,而且丢的是哪一行
 * 随滚动偏移变化(实测 height=23 丢第 12 行、height=10 丢第 5 行)。
 * 指示器要占位就必须先从预算里扣一行,而不是和内容抢同一格。
 *
 * 只有「内容多到需要滚动」时才扣:内容 ≤ 盒高时不画指示器,一行都不该少。
 *
 * ⚠ 本函数返回值是 `resolveViewportOffset` / `applyStickyViewportAction` /
 *   `applyViewportScroll` / `dragAutoScroll` 里 `viewH` 参数的**唯一合法实参**。
 *   传盒子高度会让调用方算出的 maxScroll 比渲染侧大 1,贴底哨兵与选区行号
 *   会整体错位一行(同一类 bug 的第二次发生)。
 *
 * @param {number} height 视口盒子高(外层 Box 的 height)
 * @param {number} totalLines 内容总行数
 * @param {boolean} [showIndicator=true] 是否可能画指示器
 * @returns {number} 内容行数(≥1)
 */
function viewportContentRows(height, totalLines, showIndicator = true) {
  const h = Math.max(1, Math.floor(Number(height) || 1));
  const t = Math.max(0, Math.floor(Number(totalLines) || 0));
  if (showIndicator === false || t <= h) {
    return h;
  }
  return Math.max(1, h - 1);
}

/**
 * 贴底哨兵:调用方把偏移置为 `null` 即表示「跟随最新内容」。
 * @type {null}
 */
const STICKY_BOTTOM = null;

/**
 * 把(可能是哨兵值的)偏移解析成实际行偏移,已 clamp 到 [0, maxScroll]。
 * `null` / `undefined` / 负数 → maxScroll(贴底);其余按数字处理。
 * @param {number|null|undefined} s
 * @param {number} viewH
 * @param {number} total
 * @returns {number}
 */
function resolveViewportOffset(s, viewH, total) {
  const vh = Math.max(1, Math.floor(Number(viewH) || 1));
  const t = Math.max(0, Math.floor(Number(total) || 0));
  const maxScroll = Math.max(0, t - vh);
  if (s === null || s === undefined) {
    return maxScroll;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    return maxScroll;
  }
  return Math.max(0, Math.min(Math.floor(n), maxScroll));
}

/**
 * 应用一次滚动动作,返回新的偏移 state。**落到最底时回写 `null`** —— 这样
 * 「滚回底部」会自动恢复跟随,新内容进来继续贴底,不需要额外的 sticky 标志位。
 * 纯叶子:无 IO、不抛。
 * @param {string} action - 同 applyViewportScroll 的动作名
 * @param {number|null|undefined} s 当前偏移 state
 * @param {number} viewH
 * @param {number} total
 * @returns {number|null} 新偏移,或 STICKY_BOTTOM(null)
 */
function applyStickyViewportAction(action, s, viewH, total) {
  const vh = Math.max(1, Math.floor(Number(viewH) || 1));
  const t = Math.max(0, Math.floor(Number(total) || 0));
  const maxScroll = Math.max(0, t - vh);
  const cur = resolveViewportOffset(s, vh, t);
  const next = applyViewportScroll(action, { offset: cur, viewport: vh, total: t });
  const clamped = Math.max(0, Math.min(Number(next) || 0, maxScroll));
  return clamped >= maxScroll ? STICKY_BOTTOM : clamped;
}

/**
 * 纯叶子:拖动到**视口边缘**时该往哪滚、滚完指针落在哪一行（验收标准 A-09）。
 *
 * 为什么需要它：选区的两端存的是**绝对行号**（`lines` 数组下标），而鼠标只能停在
 * 屏幕内 —— 指针拖到视口最后一行就不再往下了。不做边缘滚动，选区就被**一屏**卡住，
 * 用户看到的正是「能选中，但只能选当前这一页，跨页就复制不出来」。
 *
 * 判据（一次一格，靠位移事件天然限速，不需要定时器）：
 *   - 指针在**可见区下沿或更下** → 下滚一格（把刚露出的那行纳进选区）；
 *   - 指针在**可见区上沿或更上** → 上滚一格；
 *   - 内容不超视口 / 已滚到端点 → 不动。
 * 返回的 `line` 是**滚动之后**指针所指的绝对行 —— 锚点不动、活动端跟到新行，
 * 这才是「继续扩展」而不是「跳回起点」。
 *
 * 无 IO、不抛、确定性；`offset` 直接可用于同步 App 侧的滚动 ref。
 *
 * @param {number} rawLine 指针绝对行 = 屏幕行 + 当前偏移（**未** clamp）
 * @param {number} offset 当前视口偏移（数字，已 clamp）
 * @param {number} viewH 视口高
 * @param {number} total 内容总行
 * @returns {{delta: -1|0|1, line: number, offset: number}}
 */
function dragAutoScroll(rawLine, offset, viewH, total) {
  const vh = Math.max(1, Math.floor(Number(viewH) || 1));
  const t = Math.max(0, Math.floor(Number(total) || 0));
  const maxScroll = Math.max(0, t - vh);
  const n = Number(rawLine);
  const raw = Number.isFinite(n) ? Math.trunc(n) : 0;
  const off = Math.max(0, Math.min(Math.trunc(Number(offset) || 0), maxScroll));
  let delta = 0;
  if (t > vh) {
    if (raw >= off + vh - 1 && off < maxScroll) delta = 1;
    else if (raw <= off && off > 0) delta = -1;
  }
  const last = Math.max(0, t - 1);
  return {
    delta,
    line: Math.max(0, Math.min(raw + delta, last)),
    offset: Math.max(0, Math.min(off + delta, maxScroll)),
  };
}

/**
 * 纯叶子:应用滚动动作,返回新偏移(已 clamp)。
 * 与 scrollActions 同一范式,但针对视口内偏移。
 */
function applyViewportScroll(action, { offset = 0, viewport = 10, total = 0 } = {}) {
  const maxScroll = Math.max(0, total - viewport);
  const cur = Math.max(0, Math.min(Number(offset) || 0, maxScroll));
  const half = Math.max(1, Math.floor(viewport / 2));
  const full = Math.max(1, viewport);
  let next = cur;
  switch (action) {
    case 'lineUp':
      next = cur - 1;
      break;
    case 'lineDown':
      next = cur + 1;
      break;
    case 'halfPageUp':
      next = cur - half;
      break;
    case 'halfPageDown':
      next = cur + half;
      break;
    case 'fullPageUp':
      next = cur - full;
      break;
    case 'fullPageDown':
      next = cur + full;
      break;
    case 'top':
      next = 0;
      break;
    case 'bottom':
      next = maxScroll;
      break;
    default:
      next = cur;
  }
  return Math.max(0, Math.min(next, maxScroll));
}

module.exports = Viewport;
module.exports.applyViewportScroll = applyViewportScroll;
module.exports.resolveViewportOffset = resolveViewportOffset;
module.exports.applyStickyViewportAction = applyStickyViewportAction;
module.exports.dragAutoScroll = dragAutoScroll;
module.exports.viewportContentRows = viewportContentRows;
module.exports.sliceLineForSelection = sliceLineForSelection;
module.exports.STICKY_BOTTOM = STICKY_BOTTOM;
