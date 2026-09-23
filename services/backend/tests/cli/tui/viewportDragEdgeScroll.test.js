'use strict';

// viewportDragEdgeScroll — 拖动到**视口边缘**时该不该滚、滚完指针落在哪一行。
//
// 背景(为什么这个文件必须存在):
//   用户报「可以选中,但只能选中当前这一页,拖到末尾跨页就复制不出来」。根因不是
//   选区模型,而是坐标换算的前提本身:选区两端存**绝对行号**,而鼠标只能停在
//   **窗口边界内** —— SGR 1002 不会报告越过最后一行的位移。所以不做边缘自动滚动,
//   选区就被一屏高度硬封顶,再怎么走鼠标也长不出去。
//
//   验收标准 `[DESIGN-ARCH-119]` A-09 早就写了这一条(视口 5 行 / 内容 20 行,拖出
//   上沿 → 偏移上移、`endLine` 增大),但首版既没实现、也没按该条的「允许简化」标注
//   deferred、更没有 fallback 的「拖出视口不崩且选区被 clamp」测试 —— 静默不做。
//   本文件把三件事一次补齐:实现、A-09 形状的正例、简化的边界例。
//
//   与 #12(贴底态偏移)同源的教训:App 侧曾手写 `Number(rawScroll)` 解析偏移,而
//   贴底哨兵是 `null` ⇒ `Number(null) === 0` ⇒「跟随最新」被当成「停在顶部」,屏幕
//   行整体错 maxScroll 行。所以偏移解析只能走 Viewport 的 `resolveViewportOffset`
//   (见 T3)—— 两处口径一旦分叉,选区就指向看不见的那些行。
//
// `node --test`。

const test = require('node:test');
const assert = require('node:assert');
const vp = require('../../../src/cli/tui/ink-components/Viewport');
const sel = require('../../../src/cli/tui/selection');

const { dragAutoScroll, resolveViewportOffset, applyStickyViewportAction } = vp;

/** 造 n 行可辨识内容,便于断言复制出来的到底是哪几行。 */
function makeLines(n) {
  return Array.from({ length: n }, (_, i) => `L${String(i).padStart(2, '0')} 内容`);
}

// ── T1 纯叶子 + fail-soft ───────────────────────────────────────────────────
test('T1 dragAutoScroll 是确定性纯函数,垃圾入参不抛', () => {
  assert.strictEqual(typeof dragAutoScroll, 'function');
  const call = () => dragAutoScroll(undefined, NaN, null, {});
  assert.doesNotThrow(call);
  const r = call();
  assert.deepStrictEqual(r, { delta: 0, line: 0, offset: 0 });
  // 同一入参 → 同一输出(不读时钟、不读全局)
  assert.deepStrictEqual(dragAutoScroll(9, 2, 5, 20), dragAutoScroll(9, 2, 5, 20));
});

// ── T2 边缘判据 ─────────────────────────────────────────────────────────────
test('T2 下沿/上沿各滚一格,中段与端点不动', () => {
  const VIEW = 5;
  const TOTAL = 20; // maxScroll = 15

  // 指针落在可见区最后一行(下沿)→ 下滚一格,行号跟着偏移走一格
  assert.deepStrictEqual(dragAutoScroll(2 + VIEW - 1, 2, VIEW, TOTAL), {
    delta: 1,
    line: 3 + VIEW - 1,
    offset: 3,
  });
  // 指针落在可见区第一行(上沿)→ 上滚一格
  assert.deepStrictEqual(dragAutoScroll(4, 4, VIEW, TOTAL), { delta: -1, line: 3, offset: 3 });
  // 视口中间 → 不动
  assert.deepStrictEqual(dragAutoScroll(6, 4, VIEW, TOTAL), { delta: 0, line: 6, offset: 4 });
  // 已在最底:下沿无滚动空间 → 不动(不越界)
  assert.deepStrictEqual(dragAutoScroll(19, 15, VIEW, TOTAL), { delta: 0, line: 19, offset: 15 });
  // 已在最顶:上沿不动
  assert.deepStrictEqual(dragAutoScroll(0, 0, VIEW, TOTAL), { delta: 0, line: 0, offset: 0 });
  // 指针越界(终端把行号钳在窗口内,给什么都不该崩)→ 行号 clamp 到内容末行
  assert.deepStrictEqual(dragAutoScroll(999, 0, VIEW, TOTAL), { delta: 1, line: 19, offset: 1 });
  assert.deepStrictEqual(dragAutoScroll(-3, 10, VIEW, TOTAL), { delta: -1, line: 0, offset: 9 });
});

test('T2b 内容不超视口 → 永远不滚,行号只被 clamp(A-09 允许的简化)', () => {
  for (const raw of [-5, 0, 3, 4, 99]) {
    const r = dragAutoScroll(raw, 0, 10, 5);
    assert.strictEqual(r.delta, 0, `raw=${raw} 不该滚`);
    assert.strictEqual(r.offset, 0);
    assert.ok(r.line >= 0 && r.line <= 4, `raw=${raw} 行号必须 clamp 在 [0,4],实为 ${r.line}`);
  }
  // total=0(空转录)也不崩
  assert.deepStrictEqual(dragAutoScroll(7, 0, 5, 0), { delta: 0, line: 0, offset: 0 });
});

// ── T3 贴底哨兵的偏移口径(与渲染同源)──────────────────────────────────────
test('T3 贴底态 null 解析成 maxScroll,而非 0', () => {
  const VIEW = 10;
  const TOTAL = 30;
  assert.strictEqual(resolveViewportOffset(null, VIEW, TOTAL), TOTAL - VIEW);
  assert.strictEqual(resolveViewportOffset(undefined, VIEW, TOTAL), TOTAL - VIEW);
  assert.strictEqual(resolveViewportOffset(-1, VIEW, TOTAL), TOTAL - VIEW);
  // 反例守护:手写 `Number(rawScroll)` 会把 null 读成 0 —— 那正是「复制出来的是
  // 看不见的最早几行」的根因,任何时候都不许回到 App 侧。
  assert.notStrictEqual(Number(null), TOTAL - VIEW);
  // 数字偏移原样尊重(已 clamp)
  assert.strictEqual(resolveViewportOffset(5, VIEW, TOTAL), 5);
  assert.strictEqual(resolveViewportOffset(9999, VIEW, TOTAL), TOTAL - VIEW);
});

// ── T4 A-09 正例:选区跨过一屏 ─────────────────────────────────────────────
test('T4 A-09 拖到下沿自动滚动:偏移变化且方向正确,选区继续扩展', () => {
  const lines = makeLines(30);
  const VIEW = 10;
  let offset = 5; // 用户往上滚过一段,可见 5..14
  const screenRow = VIEW - 1; // 指针到这儿就再也给不出更大行号

  let s = sel.beginSelection(sel.clearSelection(), offset, 0); // 按下于可见首行
  const firstPageEnd = offset + VIEW - 1;
  let grew = false;
  for (let i = 0; i < 15; i++) {
    const rawLine = screenRow + offset;
    const d = dragAutoScroll(rawLine, offset, VIEW, lines.length);
    if (d.delta !== 0) {
      // App 侧真实做法:状态走 applyStickyViewportAction,再同步镜像 ref
      const sticky = applyStickyViewportAction(d.delta > 0 ? 'lineDown' : 'lineUp', offset, VIEW, lines.length);
      offset = resolveViewportOffset(sticky, VIEW, lines.length);
      s = sel.extendSelection(s, d.line, 0);
      grew = true;
    }
  }
  assert.ok(grew, '位移必须真的推动偏移');
  assert.strictEqual(offset, lines.length - VIEW, '一路拖到底 → 偏移回到 maxScroll');
  const range = sel.normalizeSelection(sel.endSelection(s));
  assert.ok(range.endLine > firstPageEnd, `选区必须长过一屏(${firstPageEnd}),实为 ${range.endLine}`);
  assert.strictEqual(range.endLine, 29);
  const rows = sel.extractText(lines, s).split('\n');
  assert.strictEqual(rows.length, 25, '复制出的行数 = 整段跨度,而不是一屏');
  assert.strictEqual(rows[0], lines[5]);
  assert.strictEqual(rows[23], lines[28]);
  // 活动端停在末行的**第 0 列** ⇒ 半开区间 `[start,end)` 不含该行正文,
  // 所以最后一项是空串。这是 selection.js 的既有契约,不是拖选滚动的副作用。
  assert.strictEqual(rows[24], '');
});

test('T4b A-09 反方向:拖出上沿时偏移上移、选区向上扩展', () => {
  const lines = makeLines(30);
  const VIEW = 10;
  let offset = 20;
  let s = sel.beginSelection(sel.clearSelection(), 29, 0); // 按下于可见末行
  for (let i = 0; i < 6; i++) {
    const d = dragAutoScroll(0 + offset, offset, VIEW, lines.length); // 指针停在屏幕第 0 行
    if (d.delta === 0) break;
    const sticky = applyStickyViewportAction('lineUp', offset, VIEW, lines.length);
    offset = resolveViewportOffset(sticky, VIEW, lines.length);
    s = sel.extendSelection(s, d.line, 0);
  }
  assert.strictEqual(offset, 14, '上沿拖动 → 偏移上移 6 行');
  const range = sel.normalizeSelection(s);
  assert.strictEqual(range.startLine, 14);
  assert.strictEqual(range.endLine, 29);
});

// ── T5 贴底语义不被拖选破坏 ────────────────────────────────────────────────
test('T5 拖到底时回写贴底哨兵,新内容进来继续跟随', () => {
  const VIEW = 5;
  const TOTAL = 12; // maxScroll = 7
  let sticky = 6;
  for (let i = 0; i < 3; i++) {
    sticky = applyStickyViewportAction('lineDown', sticky, VIEW, TOTAL);
  }
  assert.strictEqual(sticky, null, '滚到最底应回写 STICKY_BOTTOM,而不是停在数字 7');
  assert.strictEqual(resolveViewportOffset(sticky, VIEW, TOTAL), 7);
});

// ── T6 接线护栏 ─────────────────────────────────────────────────────────────
// App.js 的 `onSelectEvent` 在没有 ink 渲染 harness 的情况下取不到(整棵组件树要
// 起 stdin),所以这里刮源码守三条**曾经真错过的**接线。纯函数全绿也挡不住接线丢失:
// 「偏移方向写反」「col 按字符下标切」两次都是三层单测各自自洽、只有端到端才暴露。
test('T6 App.js 的拖选接线:走 Viewport 口径 + 真的调用边缘滚动', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../src/cli/tui/ink-components/App.js'),
    'utf-8'
  );
  const start = src.indexOf('const onSelectEvent = React.useCallback');
  assert.ok(start > 0, 'onSelectEvent 必须存在');
  const body = src.slice(start, start + 6000);

  // (1) 边缘滚动真的被调用,且只在 move 分支滚
  assert.match(body, /vp\.dragAutoScroll\(/, 'move 分支必须调用 dragAutoScroll');
  assert.match(body, /kind === 'move'[\s\S]{0,900}dragAutoScroll/, '滚动必须发生在 move 分支内');

  // (2) 偏移只能走 Viewport 的解析器。手写的 `Number(rawScroll)` 会把贴底哨兵
  //     `null` 读成 0 ⇒ 选区指向看不见的最早几行(#12 的根因)。
  assert.match(body, /vp\.resolveViewportOffset\(rawScroll/, '偏移口径必须与渲染同源');
  assert.ok(
    !/Number\(rawScroll\)/.test(body),
    '不许在 App 侧手写解析贴底哨兵(Number(null) === 0 会把贴底读成置顶)'
  );

  // (3) 滚完必须同步镜像 ref:handler 里读的是 ref,而 state 要到下一次 render 才回写
  //     (见 App.js 的 `_mainViewportScrollRef.current = mainViewportScroll`)。
  //     不镜像的话,紧接其后的 `up` 事件仍按旧偏移换算 ⇒ 松手定稿的那一屏不是看到的那一屏。
  assert.match(body, /_mainViewportScrollRef\.current = sticky/, '主布局滚动要镜像 ref');
  assert.match(body, /_previewViewportScrollRef\.current = sticky/, 'preview 布局滚动要镜像 ref');

  // (4) 字符列换算必须落在**滚动后**的那一行上(col 依赖该行文本),所以取点要收口成一处。
  assert.match(body, /const toPoint = /, '取点必须收口,便于按最终行换算列');
  assert.match(body, /pt = toPoint\(drag\.line\)/, '滚动后要用新行重算选区点');
});
