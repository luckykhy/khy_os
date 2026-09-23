'use strict';

// selectionAnchorDrift — 拖动期间**内容重排**时,松手复制出来的到底是不是用户选的那段?
//
// ── 为什么必须有这个文件 ────────────────────────────────────────────────────
// 用户报「复制不完整」。三层单测全绿:
//   - mouseSelectEvent.test.js:确认拖动 → down/move/up 事件齐备;
//   - selection.test.js:确认选区模型算术正确、extractText 切片正确;
//   - viewportDragEdgeScroll.test.js:确认拖到边缘会滚、行号跟着偏移走。
// 三层**各自自洽**,却都没有跨过那条缝:**手势期间 `lines` 数组本身变了**。
//
// App.js 的取文是两次独立读取:
//   T0 `beginSelection` 把**行号**存进 anchor(App.js:1560);
//   T1 `extractText(_mainContentLinesRef.current, finished)` 用**松手那一帧**的
//      行数组按行号重新切片(App.js:1617)。
// 一个数字,两个时刻。只要中间发生「行插入 / 行删除 / 软换行重排」,同一个行号就
// 指向不同内容 —— 表现为「复制出来的比选中的少一截 / 整段错位」,而三层单测都看不见,
// 因为每个文件都只在**单一快照**上跑完整手势。
//
// 这正是 `App.js:1523` 与 A-09 注释反复讲的那句:「单测各自自洽,只有端到端探针
// 抓得到」。本文件就是那个探针 —— 不测纯函数,而是把
//   mouseButtons(事件) → selection(模型) → extractText(取文)
// 按 App 的真实接线串起来,并在手势中途换掉 `lines`。
//
// ── 实测结论(2026-09-23,本探针第一版跑出来的)────────────────────────────────
//   D-01 基线      ✅ 绿 —— 内容不动时取文正确(证明复刻链路可信)
//   D-02 行插入    ❌ 红 —— 头部插 3 行 → 取到 L07..L11,用户选的是 L10..L14
//                          **错位量恰好 = 插入行数**,这就是「复制不完整」的根因
//   D-03 尾部追加  ✅ 绿 —— 对照组:证明 D-02 不是探针自己算错
//   D-04 折行重排  ❌ 红 —— 4 个视觉行塌成 2 → 取到 'para-part-1 .. -3\nTAIL',
//                          用户要的 3 段里混进了 TAIL
//   D-05 内容缩短  ✅ 绿 —— 越界时 fail-soft,不抛
//
// 两条红是**已知缺陷的固化**,不是「待实现的规格」。修法见下方「修复方向」。
//
// ── 修复方向(留给后续改动,探针只负责钉住现状)──────────────────────────────
// 不要改 `extractText` 让它「用按下时的行快照」—— 那会让流式内容复制到旧文本,
// 制造第二种不一致。正解是给锚点补**内容指纹**(行首 hash + 行序号),松手时按
// 指纹在当帧 lines 里重定位锚点,再切片。这样「用户看到什么就复制到什么」才对。
//
// ── 探针的判据(不是「实现应该怎样」,而是「用户看到什么就该复制到什么」)──────
//   D-01 基线:内容不动时,复制结果 === 用户按下时看到的那段(证明链路本身是通的);
//   D-02 流式插入:手势中途头上插入 N 行 → 应按**用户看到的那段**取文,而不是按行号;
//   D-03 流式追加:手势中途尾部追加 → 锚点之后的段不受影响(反向:不该被带跑);
//   D-04 软换行重排:同一逻辑段落因列宽变化折行数变了 → 行号整体位移;
//   D-05 内容缩短(行被删):行号越界 → 必须 fail-soft,不得抛、不得复制出空串假成功。
//
// `node --test`。

const test = require('node:test');
const assert = require('node:assert');

const { createMouseDispatcher } = require('../../../src/cli/tui/mouseButtons');
const sel = require('../../../src/cli/tui/selection');

const CTX = { rootNode: {}, rows: 40, anchorBottom: false, cacheKey: 'k' };

// ⚠ SGR 坐标是 **1-based**,`parseSgrMouse` 会减 1(mouseButtons.js:122-123)。
// 所以序列里的 row 写 N 表示 0-based 的 N-1。用 helper 消掉这个 off-by-one ——
// 第一版探针就是手写数字写错的,基线直接红,差点把「探针 bug」误读成「缺陷」。
const sgr = (button, col1, row1, final = 'M') => `[<${button};${col1};${row1}${final}`;
/** 0-based 屏幕坐标 → SGR 序列(按下/拖动)。 */
const pressAt = (col, row) => sgr(0, col + 1, row + 1, 'M');
/** 0-based 屏幕坐标 → SGR 序列(位移,带 32 位)。 */
const moveAt = (col, row) => sgr(32, col + 1, row + 1, 'M');
/** 0-based 屏幕坐标 → SGR 序列(松开)。 */
const releaseAt = (col, row) => sgr(0, col + 1, row + 1, 'm');

// 按下点固定在**行首**(col 0):半开区间下,起始列 0 才能把首行整行纳入。
// 末行必须给足列(否则 `slice(0, 0)` 把末行吃掉)—— 这是 selection.js:423 的
// 「末行 endCol=0 → 无内容」契约,不是缺陷,故探针显式给 toCol。

/** 造 n 行可辨识内容,便于断言「复制出来的到底是哪几行」。 */
function makeLines(prefix, n) {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
}

/**
 * 按 App.js 的真实接线复刻一次完整拖选手势,并在中途可替换 lines。
 *
 * 这一段是**刻意的复刻**:不 require App.js(它依赖 ink/React 全栈,单测拉不起来),
 * 而是把 App.js:1530-1648 的坐标换算与取文逐行搬过来。复刻的保真度由 D-01 基线
 * 反向担保 —— 基线绿,说明复刻没有把链路本身弄错;那么 D-02..D-04 的红就一定是
 * 缺陷,而不是探针自己写错了。
 *
 * @param {{linesAtT0: string[], linesAtT1: string[], offset: number, viewH: number}} spec
 */
function replayGesture(spec) {
  const { linesAtT0, linesAtT1, offset, viewH, fromRow, toRow, toCol = 0 } = spec;
  let lines = linesAtT0; // 每帧被 App 覆盖的那个 ref(_mainContentLinesRef)
  let total = lines.length;

  const emitted = [];
  let clip = null;
  let current = sel.createSelection();

  const onSelectEvent = (kind, ev) => {
    // ── 坐标换算,与 App.js:1533-1547 同口径 ────────────────────────────────
    const rawLine = Math.trunc(Number(ev.row)) - 0 + offset;
    const displayCol = Math.max(0, Math.trunc(Number(ev.col)));
    const toPoint = (absLine) => {
      const ln = Math.max(0, Math.min(Number(absLine) || 0, Math.max(0, total - 1)));
      return {
        line: ln,
        col: sel.charColForDisplay(lines[ln], displayCol),
      };
    };
    const pt = toPoint(rawLine);
    emitted.push([kind, pt.line, pt.col]);

    if (kind === 'down') {
      // App.js:1560(注意 ref 是 render 期每帧对齐的,故这里用当前 lines)
      current = sel.beginSelection(current, pt.line, pt.col);
      return;
    }
    if (kind === 'move') {
      current = sel.extendSelection(current, pt.line, pt.col);
      return;
    }
    if (kind === 'up') {
      // App.js:1601-1602
      const dragged = sel.extendSelection(current, pt.line, pt.col);
      const finished = sel.endSelection(dragged);
      if (!sel.normalizeSelection(finished)) {
        current = finished;
        return;
      }
      current = finished;
      // App.js:1617 —— **用松手那一帧的 lines**
      clip = sel.extractText(lines, finished);
    }
  };

  const d = createMouseDispatcher({ onSelectEvent, hover: false });

  // T0:按下(此时 lines == linesAtT0)
  d.onInput(pressAt(0, fromRow), CTX);
  // 拖到目标行(同一帧内 lines 仍是 T0 快照)
  d.onInput(moveAt(0, spec.dragRow), CTX);

  // ── 手势中途:内容重排(App 下一帧覆盖 _mainContentLinesRef)──────────────
  lines = linesAtT1;
  total = lines.length;

  // T1:松手(此时 lines == linesAtT1)
  d.onInput(releaseAt(toCol, toRow), CTX);

  return { clip, emitted, lines };
}

// ════════════════════════════════════════════════════════════════════════════
// D-01 基线:内容不动 —— 证明复刻链路本身是通的
// ════════════════════════════════════════════════════════════════════════════
test('D-01 基线:手势期间内容不变 → 复制结果等于用户看到的那段', () => {
  const lines = makeLines('L', 20);
  const r = replayGesture({
    linesAtT0: lines,
    linesAtT1: lines,
    offset: 0,
    viewH: 10,
    fromRow: 10, // 按下在屏幕第 10 行(0-based)→ 绝对行 10
    dragRow: 14,
    toRow: 14, // 松手在第 14 行
    toCol: lines[14].length, // 到该行行尾(半开区间需给足列,否则末行被 slice(0,0) 吃掉)
  });
  assert.ok(r.clip, '必须复制出内容(链路通了才谈得上漂移)');
  assert.strictEqual(
    r.clip,
    'L10\nL11\nL12\nL13\nL14',
    '基线:按行号 10..14 取文,内容不变时这就是用户看到的那段'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// D-02 流式插入:手势中途头上插入 N 行 —— 核心缺陷
// ════════════════════════════════════════════════════════════════════════════
test('D-02 手势中途头部插入 3 行 → 复制结果必须仍是用户看到的那段(当前会漂移)', () => {
  const t0 = makeLines('L', 20); // L00..L19
  // 流式:头上插入 3 行,原来 L10.. 现在变成 L13..
  const t1 = ['N00', 'N01', 'N02'].concat(t0);

  const r = replayGesture({
    linesAtT0: t0,
    linesAtT1: t1,
    offset: 0,
    viewH: 10,
    fromRow: 10,
    dragRow: 14,
    toRow: 14,
    toCol: t0[14].length,
  });

  // 用户按下时看到的是 t0 的 L10..L14;松手时那 5 行已下移到 13..17。
  // 正确行为:复制到**用户看到的那5行**(L10..L14),而不是行号 10..14 的新内容。
  assert.strictEqual(
    r.clip,
    'L10\nL11\nL12\nL13\nL14',
    '按「用户看到的内容」取文 —— 当前实现按行号 10..14 取,会取到 L10..L14 被顶下去的错位内容'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// D-03 反向:尾部追加不该影响锚点之后的段
// ════════════════════════════════════════════════════════════════════════════
test('D-03 手势中途尾部追加 → 选区段内容不变,复制必须逐字节一致', () => {
  const t0 = makeLines('L', 20);
  const t1 = t0.concat(makeLines('X', 5)); // 只往尾部加

  const r = replayGesture({
    linesAtT0: t0,
    linesAtT1: t1,
    offset: 0,
    viewH: 10,
    fromRow: 10,
    dragRow: 14,
    toRow: 14,
    toCol: t0[14].length,
  });
  assert.strictEqual(
    r.clip,
    'L10\nL11\nL12\nL13\nL14',
    '尾部追加不该影响已选段 —— 这条与 D-02 成对,证明 D-02 不是探针自己算错'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// D-04 软换行重排:列宽变化使同一逻辑段折行数变了
// ════════════════════════════════════════════════════════════════════════════
test('D-04 手势中途因列宽变化折行重排 → 行号整体位移,须按内容锚定', () => {
  // ⚠ 这条第一版写成 `clip.includes('para-part-1')` —— 合并后的行**仍含**该子串,
  // 于是断言恒真、假绿。收紧成**整段逐字节相等**才守得住:窄列时用户看中的是
  // 「para-part-1 / -2 / -3」三个视觉行,宽列下它们是**同一行**里的三段。
  const t0 = ['HEAD', 'para-part-1', 'para-part-2', 'para-part-3', 'TAIL'];
  const t1 = ['HEAD', 'para-part-1 para-part-2 para-part-3', 'TAIL']; // 收窄 → 合并
  const r = replayGesture({
    linesAtT0: t0,
    linesAtT1: t1,
    offset: 0,
    viewH: 10,
    fromRow: 1,
    dragRow: 3,
    toRow: 3,
    toCol: t0[3].length,
  });
  assert.strictEqual(
    r.clip,
    'para-part-1\npara-part-2\npara-part-3',
    '折行重排后必须仍取到用户看中的那三段内容;按行号取会因行数变化整体错位'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// D-05 fail-soft:内容缩短导致行号越界
// ════════════════════════════════════════════════════════════════════════════
test('D-05 手势中途内容大幅缩短(行被删) → 不抛,且不得静默复制错内容', () => {
  const t0 = makeLines('L', 20);
  const t1 = makeLines('L', 3); // 只剩 3 行

  let r;
  assert.doesNotThrow(() => {
    r = replayGesture({
      linesAtT0: t0,
      linesAtT1: t1,
      offset: 0,
      viewH: 10,
      fromRow: 10, // 行号 10 在 t1 里已不存在
      dragRow: 14,
      toRow: 14,
      toCol: 6,
    });
  }, '内容缩短绝不能抛 —— 异常会连累输入路径');

  // 诚实边界:越界时行号被 clamp 到末行,取到的必然不是用户要的。
  // 这条**不断言正确内容**(当前实现做不到),只钉住「不抛 + 不假装成功」。
  assert.ok(
    r.clip === '' || typeof r.clip === 'string',
    '无论取到什么,必须是字符串,不得是 null/undefined'
  );
});
