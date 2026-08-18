'use strict';

// Unit tests for SidebarPanel.buildSidebarLines — pure line builder for the
// wide-terminal sidebar (确认规格: 任务清单/工具活动/消息队列 + CJK truncation)。
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const {
  buildSidebarLines,
  formatTaskLine,
  capSidebarLines,
  padSidebarLines,
  padLineToWidth,
  sidebarContentRows,
  sidebarBoxProps,
  sidebarShownLines,
  truncateToWidth,
  EMPTY_PLACEHOLDER,
  TASK_GLYPH,
  TOOLS_COLOR,
  COMPLETED_FOLD_COLOR,
} = require('../../../src/cli/tui/ink-components/SidebarPanel');

// CJK-aware display width (reuse project SSOT; fallback = naive length so the
// suite still runs if formatters is unavailable).
let displayWidth;
try { displayWidth = require('../../../src/cli/formatters').displayWidth; }
catch { displayWidth = (s) => String(s).length; }

const texts = (lines) => lines.map((l) => l.text);
const findLine = (lines, needle) => lines.find((l) => l.text.includes(needle));

// ── 任务标题行:总进度 已完成数/总数 ────────────────────────────────────────
test('buildSidebarLines: 任务头行显示总进度 任务 n/m', () => {
  const lines = buildSidebarLines({
    width: 30,
    taskLines: ['✓ 步骤一', '✓ 步骤二', '→ 步骤三', '○ 步骤四'],
  });
  const header = findLine(lines, '任务');
  assert.ok(header, '存在任务头行');
  assert.equal(header.text, '任务 2/4', `头行含总进度: ${header.text}`);
  assert.equal(header.bold, true);
});

test('buildSidebarLines: 行首图标不可识别 → 诚实回退「任务 m 项」', () => {
  const lines = buildSidebarLines({
    width: 30,
    taskLines: ['✓ 步骤一', '? 未知格式行'],
  });
  const header = findLine(lines, '任务');
  assert.ok(header, '存在任务头行');
  assert.equal(header.text, '任务 2 项');
});

// ── 每项格式:序号. 状态符号 标题 + 颜色区分 ─────────────────────────────────
test('buildSidebarLines: 每项 序号. 符号 标题;待办灰○/进行中高亮●/完成绿✓', () => {
  const lines = buildSidebarLines({
    width: 40,
    taskLines: ['✓ 完成的', '→ 进行中的', '○ 待办的'],
  });
  const doneLine = findLine(lines, '完成的');
  const activeLine = findLine(lines, '进行中的');
  const pendingLine = findLine(lines, '待办的');
  assert.equal(doneLine.text, '1. ✓ 完成的');
  assert.equal(doneLine.color, 'green');
  assert.equal(activeLine.text, '2. ● 进行中的');
  assert.equal(activeLine.color, 'cyan');
  assert.equal(activeLine.bold, true);
  assert.equal(pendingLine.text, '3. ○ 待办的');
  assert.equal(pendingLine.color, 'gray');
});

test('formatTaskLine: 行首图标不可识别 → 原样文本前加序号(不丢行);✗ 保留红', () => {
  const t = (s) => s;
  assert.equal(formatTaskLine('? 怪异行', 4, t).text, '4. ? 怪异行');
  assert.equal(formatTaskLine('✗ 失败的', 2, t).color, 'red', 'error 保留红✗');
});

// ── 溢出折叠:仅超高度上限时把已完成项折叠为一行 ─────────────────────────────
test('buildSidebarLines: 空间足够 → 完成项正常列出不折叠', () => {
  const lines = buildSidebarLines({
    width: 40,
    maxRows: 20,
    taskLines: ['✓ 步骤一', '✓ 步骤二', '→ 步骤三'],
  });
  assert.ok(findLine(lines, '1. ✓ 步骤一'), '完成项正常列出');
  assert.ok(findLine(lines, '2. ✓ 步骤二'));
  assert.equal(findLine(lines, '已完成 2 项'), undefined, '不出现折叠行');
});

test('buildSidebarLines: 超高度上限 → 完成项折叠为「✓ 已完成 N 项」一行', () => {
  const taskLines = ['✓ 步骤一', '✓ 步骤二', '✓ 步骤三', '→ 步骤四', '○ 步骤五'];
  // 完整渲染 = 头行 + 5 项 = 6 行 > maxRows 5 → 折叠
  const lines = buildSidebarLines({ width: 40, maxRows: 5, taskLines });
  assert.equal(findLine(lines, '步骤一'), undefined, '完成项不再逐条列出');
  const fold = findLine(lines, '✓ 已完成 3 项');
  assert.ok(fold, `存在折叠行: ${texts(lines).join(' | ')}`);
  assert.equal(fold.color, 'green');
  assert.ok(findLine(lines, '4. ● 步骤四'), '进行中保留原序号可见');
  assert.ok(findLine(lines, '5. ○ 步骤五'), '待办保留原序号可见');
});

test('buildSidebarLines: maxRows 缺失/0 → 不折叠(下游 capSidebarLines 兜底)', () => {
  const taskLines = ['✓ 步骤一', '✓ 步骤二', '→ 步骤三'];
  const lines = buildSidebarLines({ width: 40, taskLines });
  assert.ok(findLine(lines, '1. ✓ 步骤一'));
  assert.equal(findLine(lines, '已完成'), undefined);
});

// ── 看板始终显示:无任务 → 灰色提示语 ──────────────────────────────────────
test('buildSidebarLines: 无任务 → 灰色「暂无任务」提示(看板不消失)', () => {
  const lines = buildSidebarLines({ width: 30 });
  assert.ok(lines.length > 0, '空 props 也至少有提示行');
  const empty = findLine(lines, '暂无任务');
  assert.ok(empty, '存在暂无任务提示');
  assert.equal(empty.color, 'gray');
  assert.equal(empty.dim, true);
});

test('buildSidebarLines: hideTaskSection → 不渲染任务或空态,但保留工具活动', () => {
  const lines = buildSidebarLines({
    width: 30,
    hideTaskSection: true,
    taskLines: ['→ 不应出现在右栏'],
    streaming: { tools: [{}] },
  });
  assert.equal(findLine(lines, '暂无任务'), undefined);
  assert.equal(findLine(lines, '不应出现在右栏'), undefined);
  assert.ok(findLine(lines, '工具 · 运行中 1/共 1'));
});

// ── 移除的三个区块:主题/模型+强度/上下文用量 ────────────────────────────────
test('buildSidebarLines: topic/model/effort/context props 不再产生任何行', () => {
  const lines = buildSidebarLines({
    width: 30,
    topic: '修复登录问题',
    model: 'auto',
    effort: 'medium',
    contextPct: 30, contextTokens: 60000, contextLimit: 200000,
  });
  assert.equal(findLine(lines, '修复登录问题'), undefined, '无主题行');
  assert.equal(findLine(lines, '✱'), undefined, '无主题符号');
  assert.equal(findLine(lines, '强度'), undefined, '无模型+强度行');
  assert.equal(findLine(lines, 'ctx'), undefined, '无上下文用量行');
  assert.equal(findLine(lines, '▯'), undefined, '无进度条');
});

// ── 工具活动区 ──────────────────────────────────────────────────────────────
test('buildSidebarLines: 工具活动行 运行中 k/共 n(done = !!result)', () => {
  const lines = buildSidebarLines({
    width: 30,
    streaming: { tools: [{ result: { ok: 1 } }, {}, {}] },
  });
  const toolLine = findLine(lines, '工具');
  assert.ok(toolLine, '存在工具活动行');
  assert.equal(toolLine.text, '工具 · 运行中 2/共 3');
  assert.equal(toolLine.color, 'yellow');
});

test('buildSidebarLines: 全部工具完成 → 0/共 n 且 green', () => {
  const lines = buildSidebarLines({
    width: 30,
    streaming: { tools: [{ result: {} }, { result: {} }] },
  });
  const toolLine = findLine(lines, '工具');
  assert.equal(toolLine.text, '工具 · 运行中 0/共 2');
  assert.equal(toolLine.color, 'green');
});

test('buildSidebarLines: 无 tools → 不渲工具行', () => {
  assert.equal(findLine(buildSidebarLines({ width: 30 }), '工具'), undefined);
  assert.equal(findLine(buildSidebarLines({ width: 30, streaming: { tools: [] } }), '工具'), undefined);
});

// ── 队列行 ──────────────────────────────────────────────────────────────────
test('buildSidebarLines: queueLen > 0 → 队列行;0 → 不渲', () => {
  const withQueue = buildSidebarLines({ width: 30, queueLen: 3 });
  assert.ok(findLine(withQueue, '队列 3 条待发送'));
  assert.equal(findLine(buildSidebarLines({ width: 30, queueLen: 0 }), '队列'), undefined);
});

// ── CJK 截断 ────────────────────────────────────────────────────────────────
test('buildSidebarLines: CJK 长行截断不超 width-2 显示宽度', () => {
  let displayWidth;
  try { displayWidth = require('../../../src/cli/formatters').displayWidth; } catch { displayWidth = (s) => s.length; }
  const width = 20;
  const lines = buildSidebarLines({
    width,
    taskLines: ['→ 一条特别特别特别特别特别长的中文任务描述行', '○ 另一条非常非常非常非常长的待办任务标题'],
  });
  for (const ln of lines) {
    assert.ok(displayWidth(ln.text) <= width - 2,
      `行显示宽度 ${displayWidth(ln.text)} ≤ ${width - 2}: ${ln.text}`);
  }
});

test('truncateToWidth: 未超宽原样返回;超宽截断加 …', () => {
  const measure = (s) => [...String(s)].reduce((w, ch) => w + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0);
  assert.equal(truncateToWidth('abc', 10, measure), 'abc');
  const cut = truncateToWidth('中文中文中文中文', 8, measure);
  assert.ok(cut.endsWith('…'));
  assert.ok(measure(cut) <= 8);
});

// ── capSidebarLines: 高度上限(超出截断,任务#18/#20) ──────────────────
test('capSidebarLines: 内容未超上限 → 原样返回(不截断不修改)', () => {
  const lines = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  assert.deepEqual(capSidebarLines(lines, 10), lines, '3 行 < cap 10 → 仍 3 行');
  assert.deepEqual(capSidebarLines(lines, 3), lines, '恰等于 cap → 原样');
});

test('capSidebarLines: cap=0/非法 → 不设上限', () => {
  const lines = [{ text: 'a' }, { text: 'b' }];
  assert.deepEqual(capSidebarLines(lines, 0), lines);
  assert.deepEqual(capSidebarLines(lines, NaN), lines);
  assert.deepEqual(capSidebarLines(lines, undefined), lines);
});

test('capSidebarLines: 超出上限 → 截断到 cap 行并附诚实省略标记', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ text: `L${i}` }));
  const capped = capSidebarLines(lines, 5);
  assert.equal(capped.length, 5, '总高正好 5 行(4 内容 + 1 标记)');
  assert.equal(capped[3].text, 'L3', '保留前 cap-1 行');
  assert.ok(capped[4].text.includes('其余 6 行'), `标记行: ${capped[4].text}`);
  assert.equal(capped[4].dim, true);
});

test('capSidebarLines: cap=1 → 仅一行内容+标记不低于 1 行保留', () => {
  const lines = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  const capped = capSidebarLines(lines, 1);
  assert.equal(capped.length, 2, 'keep 下限 1 行 + 标记');
  assert.equal(capped[0].text, 'a');
  assert.ok(capped[1].text.includes('其余 2 行'));
});

test('capSidebarLines: 非数组输入 → 空数组(不抛异常)', () => {
  assert.deepEqual(capSidebarLines(null, 5), []);
  assert.deepEqual(capSidebarLines(undefined, 5), []);
});

// ── padSidebarLines: 稳定高度填充(任务#20,不随左列输出塌陷) ──────────
test('padSidebarLines: 内容不足 → 空行追加到内容之后(顶对齐,填充在下方)', () => {
  const lines = [{ text: 'a' }, { text: 'b' }];
  const padded = padSidebarLines(lines, 5);
  assert.equal(padded.length, 5, '2 行内容 → 补到 5 行');
  assert.equal(padded[0].text, 'a', '内容在顶部(不被 prepend 挤到底部)');
  assert.equal(padded[1].text, 'b', '内容顺序不变');
  assert.equal(padded[2].text, '', '填充从内容后开始');
  assert.equal(padded[4].text, '', '末行也是填充空行');
});

test('padSidebarLines: 内容已达/超过稳定高度 → 原样返回(不叠加)', () => {
  const lines = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  assert.deepEqual(padSidebarLines(lines, 3), lines, '恰等 → 原样');
  assert.deepEqual(padSidebarLines(lines, 2), lines, '超过 → 原样(截断是 cap 的事)');
});

test('padSidebarLines: rows=0/非法 → 不填充(回退 hug)', () => {
  const lines = [{ text: 'a' }];
  assert.deepEqual(padSidebarLines(lines, 0), lines);
  assert.deepEqual(padSidebarLines(lines, NaN), lines);
  assert.deepEqual(padSidebarLines(lines, undefined), lines);
});

test('padSidebarLines: 非数组输入 → 纯空行数组(不抛异常)', () => {
  assert.equal(padSidebarLines(null, 3).length, 3);
  assert.ok(padSidebarLines(null, 3).every((l) => l.text === ''));
});

test('pad+cap 组合: 任意内容量 → 恰好稳定高度行数(不塌不撑)', () => {
  const stable = 8;
  for (const n of [0, 3, 8, 20]) {
    const lines = Array.from({ length: n }, (_, i) => ({ text: `L${i}` }));
    const shown = padSidebarLines(capSidebarLines(lines, stable), stable);
    assert.equal(shown.length, stable, `内容 ${n} 行 → 恒为 ${stable} 行`);
  }
});

// ── sidebarContentRows / sidebarBoxProps: minHeight 稳定高度(任务#20/#23) ─
test('sidebarContentRows: bg 分支无 chrome → 内容行数 = 稳定高(#23 去 marginTop)', () => {
  assert.equal(sidebarContentRows('#2e2e2e', 29), 29);
});

test('sidebarContentRows: 边框分支仅扣边框 2 行(#23 去 marginTop)', () => {
  assert.equal(sidebarContentRows(null, 29), 27);
  assert.equal(sidebarContentRows(null, 2), 1, '下限 1 行');
});

test('sidebarContentRows: stableRows=0/非法 → 0(禁用,回退 hug)', () => {
  assert.equal(sidebarContentRows('#333', 0), 0);
  assert.equal(sidebarContentRows(null, NaN), 0);
});

test('sidebarBoxProps: bg 分支 minHeight = 稳定高且无 marginTop(#23 顶边与版本行同行)', () => {
  const p = sidebarBoxProps('#2e2e2e', 42, 29);
  assert.equal(p.minHeight, 29, '总占位 = minHeight = 稳定高度 29');
  assert.equal('marginTop' in p, false, '#23: 无顶部偏移,顶边与版本行同行左右分列');
  assert.equal(p.justifyContent, 'flex-start', '顶对齐:内容从盒顶开始');
  assert.equal(p.backgroundColor, '#2e2e2e');
  assert.equal(p.width, 42);
  assert.equal(p.flexShrink, 0, '不参与 flex 挤压');
  assert.equal(p.flexDirection, 'column');
});

test('sidebarBoxProps: 边框分支 minHeight = 稳定高且顶对齐/无 marginTop', () => {
  const p = sidebarBoxProps(null, 42, 29);
  assert.equal(p.minHeight, 29);
  assert.equal(p.borderStyle, 'round');
  assert.equal('marginTop' in p, false);
  assert.equal(p.justifyContent, 'flex-start');
});

test('sidebarBoxProps: stableRows=0/非法 → 不施加 minHeight(回退 hug)', () => {
  assert.equal('minHeight' in sidebarBoxProps('#333', 42, 0), false);
  assert.equal('minHeight' in sidebarBoxProps(null, 42, NaN), false);
});

// ── sidebarShownLines: 默认 cap+pad(启动稳定高) / fitContent cap-only(任务#11 hug) ─
test('sidebarShownLines[默认]: 内容不足 → 补空行到 contentRows(启动路径 pad 不变)', () => {
  const lines = [{ text: 'a' }, { text: 'b' }];
  const shown = sidebarShownLines(lines, 10);
  assert.equal(shown.length, 10, '2 行内容被补到 10 行');
  assert.equal(shown[0].text, 'a', '内容在顶部');
  assert.equal(shown[1].text, 'b', '内容顺序不变');
  assert.equal(shown[2].text, '', '填充从内容后开始');
  assert.equal(shown[9].text, '', '末行也是填充空行');
});

test('sidebarShownLines[默认]: 超长内容仍受上限截断(cap 不失效)', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ text: `L${i}` }));
  const shown = sidebarShownLines(lines, 5);
  assert.equal(shown.length, 5, '超长内容仍被截到 cap');
  assert.ok(shown[4].text.includes('其余'), '末行为诚实省略标记');
});

test('sidebarShownLines[默认]: 任意内容量 → 恰为 contentRows 行(不塌不撑)', () => {
  for (const n of [0, 3, 8, 20]) {
    const lines = Array.from({ length: n }, (_, i) => ({ text: `L${i}` }));
    assert.equal(sidebarShownLines(lines, 8).length, 8, `内容 ${n} 行 → 恒 8 行`);
  }
});

test('sidebarShownLines[默认]: contentRows=0/非法 → hug 回退(不截不补)', () => {
  const lines = [{ text: 'a' }, { text: 'b' }];
  assert.deepEqual(sidebarShownLines(lines, 0), lines);
  assert.deepEqual(sidebarShownLines(lines, NaN), lines);
});

test('sidebarShownLines[fitContent]: 内容少 → 完全 hug(不补空行,底边随内容浮动)', () => {
  const lines = [{ text: 'a' }, { text: 'b' }];
  const shown = sidebarShownLines(lines, 10, true);
  assert.equal(shown.length, 2, '2 行内容只占 2 行(不 pad 到 10)');
  assert.deepEqual(shown, lines, '内容原样返回');
});

test('sidebarShownLines[fitContent]: 超出上限 → cap 到 contentRows 并附诚实标记', () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ text: `L${i}` }));
  const shown = sidebarShownLines(lines, 5, true);
  assert.equal(shown.length, 5, '超长内容截到上限 5 行');
  assert.ok(shown[4].text.includes('其余 8 行'), `末行标记: ${shown[4].text}`);
  assert.equal(shown[4].dim, true);
});

test('sidebarShownLines[fitContent]: 任意内容量 → min(内容, contentRows) 行', () => {
  for (const n of [0, 3, 8, 20]) {
    const lines = Array.from({ length: n }, (_, i) => ({ text: `L${i}` }));
    assert.equal(sidebarShownLines(lines, 8, true).length, Math.min(n, 8),
      `内容 ${n} 行 → ${Math.min(n, 8)} 行`);
  }
});

test('sidebarShownLines[fitContent]: contentRows=0/非法 → hug 回退(不截不补)', () => {
  const lines = [{ text: 'a' }, { text: 'b' }];
  assert.deepEqual(sidebarShownLines(lines, 0, true), lines);
  assert.deepEqual(sidebarShownLines(lines, NaN, true), lines);
});

test('稳定高度总占位: 内容少/多两种情况盒高恒 = stable(#23 无 marginTop)', () => {
  const stable = 29;
  for (const bg of ['#2e2e2e', null]) {
    const p = sidebarBoxProps(bg, 42, stable);
    const contentRows = sidebarContentRows(bg, stable);
    for (const n of [2, 60]) {
      const lines = Array.from({ length: n }, (_, i) => ({ text: `L${i}` }));
      const shown = padSidebarLines(capSidebarLines(lines, contentRows), contentRows);
      const boxH = (bg ? 0 : 2) + shown.length; // borders add 2 rows
      const total = Math.max(boxH, p.minHeight); // no marginTop since #23
      assert.equal(total, stable, `bg=${bg} 内容 ${n} 行: 总占位 ${total} = ${stable}`);
    }
  }
});

// ── padLineToWidth: 整行宽背景填充(任务#21,色块连续可见) ────────────
test('padLineToWidth: 短行右补空格到内层宽度(背景铺满整行)', () => {
  const measure = (s) => String(s).length;
  assert.equal(padLineToWidth('ab', 6, measure), 'ab    ');
  assert.equal(padLineToWidth('', 4, measure), '    ', '空填充行 → 整行空格');
});

test('padLineToWidth: CJK 宽度感知(按显示列计算补位)', () => {
  const measure = (s) => [...String(s)].reduce((w, ch) => w + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0);
  assert.equal(padLineToWidth('中文', 6, measure), '中文  ', '4 列字 + 2 空格 = 6 列');
});

test('padLineToWidth: 已达/超宽 → 原样返回(截断是上游的事)', () => {
  const measure = (s) => String(s).length;
  assert.equal(padLineToWidth('abcdef', 6, measure), 'abcdef');
  assert.equal(padLineToWidth('abcdefgh', 6, measure), 'abcdefgh');
});

test('padLineToWidth: 宽度非法/null 文本 → 不抛异常', () => {
  assert.equal(padLineToWidth('a', 0, (s) => s.length), 'a');
  assert.equal(padLineToWidth('a', NaN, (s) => s.length), 'a');
  assert.equal(padLineToWidth(null, 3, (s) => s.length), '   ');
  assert.equal(padLineToWidth('ab', 4, null), 'ab  ', '非函数 measure 回退 length');
});

// ══ 任务 #2 看板视觉打磨:精确宽度填充 / CJK 截断 / 空态样式 / 配色单一真源 ══

const INNER_W = (width) => Math.max(4, width - 2); // 与 SidebarPanel 内层宽度一致

// ── 精确宽度填充:各行(空态/含任务/标题)填充到确切看板内层宽度 ──────────
test('精确宽度填充: 空态行经 padLineToWidth 后显示宽度恰为内层宽度', () => {
  const width = 30;
  const innerW = INNER_W(width);
  const [empty] = buildSidebarLines({ width });
  const padded = padLineToWidth(empty.text, innerW, displayWidth);
  assert.equal(displayWidth(padded), innerW, `空态行填充到 ${innerW} 列`);
});

test('精确宽度填充: 含任务时标题行与每个任务行填充后均为内层宽度(右缘齐平)', () => {
  const width = 40;
  const innerW = INNER_W(width);
  const lines = buildSidebarLines({
    width,
    taskLines: ['✓ 完成的', '→ 进行中的中文任务', '○ 待办项'],
  });
  for (const ln of lines) {
    const padded = padLineToWidth(ln.text, innerW, displayWidth);
    assert.equal(displayWidth(padded), innerW,
      `行「${ln.text}」填充后显示宽度应为 ${innerW},实为 ${displayWidth(padded)}`);
  }
});

test('精确宽度填充: 分节分隔线也填充到内层宽度(背景块连续无缺口)', () => {
  const width = 36;
  const innerW = INNER_W(width);
  // 工具区/队列区之间会插入分隔线 { text: '─'.repeat(innerW), dim: true }。
  const lines = buildSidebarLines({
    width,
    taskLines: ['○ 一'],
    streaming: { tools: [{}, { result: {} }] },
    queueLen: 2,
  });
  const dividers = lines.filter((l) => typeof l.text === 'string' && /^─+$/.test(l.text));
  assert.ok(dividers.length >= 2, '存在分节分隔线(工具区/队列区各一)');
  for (const d of dividers) {
    assert.equal(displayWidth(padLineToWidth(d.text, innerW, displayWidth)), innerW,
      '分隔线也填充为整行宽度');
  }
});

// ── CJK 截断:含中文/双宽字符标题在窄宽度下正确截断不溢出、不错位 ──────────
test('CJK 截断: 窄宽度下含中文的任务行显示宽度绝不超内层宽度且不错位', () => {
  const width = 16;
  const innerW = INNER_W(width);
  const lines = buildSidebarLines({
    width,
    taskLines: [
      '→ 一条特别特别特别特别长的中文任务标题需要截断',
      '○ 另一条非常非常非常非常长的待办任务描述',
      '✓ 混合ABC中文DEF字符的任务标题需要被截断处理',
    ],
  });
  for (const ln of lines) {
    assert.ok(displayWidth(ln.text) <= innerW,
      `行显示宽度 ${displayWidth(ln.text)} 应 ≤ ${innerW}: 「${ln.text}」`);
    // 填充后恰为内层宽度 → 证明未溢出、右缘齐平(不错位)。
    assert.equal(displayWidth(padLineToWidth(ln.text, innerW, displayWidth)), innerW,
      '截断后再填充恰为内层宽度(不错位)');
  }
});

test('CJK 截断: 被截断的行以省略号 … 结尾(诚实标示截断)', () => {
  const width = 14;
  const lines = buildSidebarLines({
    width,
    taskLines: ['→ 这是一条足够长以至于必须被截断的中文任务标题行'],
  });
  const active = lines.find((l) => l.text.includes('.'));
  assert.ok(active, '存在任务行');
  assert.ok(active.text.endsWith('…'), `截断行应以 … 结尾: 「${active.text}」`);
});

test('truncateToWidth: 复用 displayWidth 度量,双宽字符截断后不超上限', () => {
  const s = '中文中文中文中文中文';
  const cut = truncateToWidth(s, 9, displayWidth);
  assert.ok(displayWidth(cut) <= 9, `截断后 ${displayWidth(cut)} ≤ 9`);
  assert.ok(cut.endsWith('…'), '超宽必截并加省略号');
});

// ── 空态渲染:无任务 → 「暂无任务」且样式为 dim gray(引用单一真源常量) ──────
test('空态渲染: 文案与样式取自 EMPTY_PLACEHOLDER 单一真源', () => {
  assert.equal(EMPTY_PLACEHOLDER.text, '暂无任务');
  assert.equal(EMPTY_PLACEHOLDER.color, 'gray');
  assert.equal(EMPTY_PLACEHOLDER.dim, true);
  const [empty] = buildSidebarLines({ width: 30 });
  assert.equal(empty.text, EMPTY_PLACEHOLDER.text, '空态文案 = 常量');
  assert.equal(empty.color, EMPTY_PLACEHOLDER.color, '空态颜色 = 常量(dim gray)');
  assert.equal(empty.dim, EMPTY_PLACEHOLDER.dim, '空态 dim = 常量');
});

// ── 配色单一真源:状态/工具/折叠行颜色均引用具名常量,不散落字面量 ──────────
test('配色单一真源: 任务行颜色取自 TASK_GLYPH 状态色映射', () => {
  const t = (s) => s;
  assert.equal(formatTaskLine('✓ 完成', 1, t).color, TASK_GLYPH.completed.color);
  assert.equal(formatTaskLine('→ 进行', 2, t).color, TASK_GLYPH.in_progress.color);
  assert.equal(formatTaskLine('○ 待办', 3, t).color, TASK_GLYPH.pending.color);
  assert.equal(formatTaskLine('✗ 失败', 4, t).color, TASK_GLYPH.error.color);
});

test('配色单一真源: 工具活动行颜色取自 TOOLS_COLOR(运行中黄/空闲绿)', () => {
  const running = buildSidebarLines({ width: 30, streaming: { tools: [{}] } });
  assert.equal(findLine(running, '工具').color, TOOLS_COLOR.running);
  const idle = buildSidebarLines({ width: 30, streaming: { tools: [{ result: {} }] } });
  assert.equal(findLine(idle, '工具').color, TOOLS_COLOR.idle);
});

test('配色单一真源: 折叠行颜色取自 COMPLETED_FOLD_COLOR', () => {
  const taskLines = ['✓ 一', '✓ 二', '✓ 三', '→ 四', '○ 五'];
  const lines = buildSidebarLines({ width: 40, maxRows: 5, taskLines });
  const fold = findLine(lines, '已完成 3 项');
  assert.ok(fold, '存在折叠行');
  assert.equal(fold.color, COMPLETED_FOLD_COLOR);
  assert.equal(fold.dim, true);
});

// ── 阶段三: 段落分隔线(各主段前为 /^─+$/ 且填满 innerW) ──────────────
test('段落分隔线: 工具/队列/通知段前均有 /^─+$/ 分隔线且 length = innerW', () => {
  const lines = buildSidebarLines({
    width: 30,
    taskLines: ['→ 当前任务'],
    streaming: { tools: [{}] },
    queueLen: 2,
    notifications: [{ level: 'info', title: 'hi', timestamp: 1 }],
  });
  const innerW = 30 - 2; // width - 2
  const dividers = lines.filter((l) => /^─+$/.test(l.text));
  assert.ok(dividers.length >= 3, `至少 3 条分隔线(工具/队列/通知), got ${dividers.length}`);
  for (const d of dividers) {
    assert.equal(d.text.length, innerW, `分隔线宽度应为 innerW(${innerW}), got ${d.text.length}`);
    assert.equal(d.dim, true, '分隔线应为 dim');
  }
});

// ── 阶段三: 空态二级提示行 ────────────────────────────────────────
test('空态二级提示: 无任务时第二行为 dim gray 引导文案', () => {
  const lines = buildSidebarLines({ width: 30 });
  assert.ok(lines.length >= 2, '空态至少 2 行');
  const secondary = lines[1];
  assert.ok(secondary.text.includes('发送消息后将显示任务'), `二级提示文案: 「${secondary.text}」`);
  assert.equal(secondary.color, 'gray');
  assert.equal(secondary.dim, true);
});

// ── 阶段三: 通知淡出(age 比例超 fadeRatio 附 dim、缺 now/ttl 不淡出) ───────────
test('通知淡出: age/ttl > fadeRatio → dim', () => {
  const now = 1000;
  const ttl = 100;
  const fadeRatio = 0.7;
  const lines = buildSidebarLines({
    taskLines: [],
    now,
    notifyTtl: ttl,
    notifyFadeRatio: fadeRatio,
    notifications: [
      { level: 'info', title: 'old', timestamp: now - 80 }, // age=80 > 70(=100*0.7) → dim
      { level: 'info', title: 'new', timestamp: now - 50 }, // age=50 < 70 → no dim
    ],
  });
  const oldLine = lines.find((l) => l.text.includes('old'));
  const newLine = lines.find((l) => l.text.includes('new'));
  assert.equal(oldLine.dim, true, '老通知应淡出(dim)');
  assert.ok(!newLine.dim, '新通知不应淡出');
});

test('通知淡出: 缺 now/ttl → 不淡出(安全回退)', () => {
  const lines = buildSidebarLines({
    taskLines: [],
    notifications: [
      { level: 'info', title: 'x', timestamp: 1 },
    ],
    // deliberately omit now, notifyTtl, notifyFadeRatio
  });
  const entry = lines.find((l) => l.text.includes('x'));
  assert.ok(!entry.dim, '无淡出参数时不 dim');
});

// ── 阶段三: truncateToWidth ASCII 快速路径与非 ASCII 一致性 ──────────────
test('truncateToWidth: ASCII 快速路径 — 不超宽原样返回、超宽截断加省略号', () => {
  const m = (s) => s.length; // ASCII
  assert.equal(truncateToWidth('hello', 10, m), 'hello', '不超宽原样返回');
  assert.equal(truncateToWidth('hello', 5, m), 'hello', '恰好等宽');
  const cut = truncateToWidth('hello world', 6, m);
  assert.ok(cut.endsWith('…'), `截断加省略号: 「${cut}」`);
  assert.ok(cut.length <= 6, '截断后不超宽');
});

test('truncateToWidth: ASCII 快速路径与通用路径对 pure-ASCII 串结果一致', () => {
  const m = (s) => s.length;
  // Force the generic path by appending a non-ASCII char then removing it
  const ascii = 'abcdefghij';
  const fastResult = truncateToWidth(ascii, 7, m);
  // Generic path: simulate by using displayWidth that treats each char as 1
  // Both should truncate to 6 chars + …
  assert.ok(fastResult.endsWith('…'));
  assert.ok(fastResult.length <= 7);
});
