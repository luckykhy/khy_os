'use strict';

// selectionRelocate — 锚点重定位的**纯函数**单测（[DESIGN-ARCH-132] 第一期）。
//
// ── 与本目录其它文件的分工 ──────────────────────────────────────────────────
//   selectionAnchorDrift.test.js 是**端到端探针**：串起 mouseButtons → selection
//   → extractText，证明「不接线时会漂移」（D-02/D-04 红）。它测的是**行为**。
//
//   本文件是**纯函数单测**：只喂 `relocateLine` / `relocateSelection` /
//   `extractTextRelocated` 三个函数，钉住它们三档置信的判定与降级。它测的是**规则**。
//
// 为什么要分开：探针要等到第二期接线后才会变绿，在那之前它是「红的」——
// 而红的测试跑在 CI 里会被当成失败。所以第一期的验收必须是**只有纯函数单测**，
// 且它们现在就全绿。两者共同构成「先证明缺陷存在、再证明修复生效」的闭环。
//
// ── 三档置信（本文件的核心）──────────────────────────────────────────────────
//   1. 精确命中 —— 指纹在目标数组里**唯一**出现 → 采用它；
//   2. 偏移补偿 —— 指纹出现多次 → 取离原行号**最近**的（最小位移，确定性）；
//   3. 失配降级 —— 指纹为空 / 找不到 → 返回 clamp 后的原行号（保持今天的行为）。
// 第 3 档是**诚实边界**：宁可维持现状，也不猜一个行号。
//
// `node --test`。

const test = require('node:test');
const assert = require('node:assert');

const sel = require('../../../src/cli/tui/selection');

// ════════════════════════════════════════════════════════════════════════════
// R-01..R-03:relocateLine 的三档置信
// ════════════════════════════════════════════════════════════════════════════

test('R-01 精确命中:指纹唯一出现 → 采用它(头部插入 3 行的场景)', () => {
  const t0 = ['L00', 'L01', 'L02', 'L03', 'L04'];
  const t1 = ['N00', 'N01', 'N02'].concat(t0); // 原 L03 现在是下标 6

  const got = sel.relocateLine(t0, t1, { line: 3, col: 0, fp: t0[3] });
  assert.strictEqual(got, 6, 'L03 被头顶 3 行顶下去 → 必须重定位到 6');
});

test('R-02 精确命中:内容未变时恒等(零回归的底线)', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'];
  for (let i = 0; i < lines.length; i++) {
    assert.strictEqual(
      sel.relocateLine(lines, lines, { line: i, col: 0, fp: lines[i] }),
      i,
      `内容不动时第 ${i} 行必须重定位到自己`
    );
  }
});

test('R-03 偏移补偿:指纹出现多次 → 取离原行号最近的(确定性,不猜)', () => {
  // 三行完全相同的内容 —— 真实场景:连续空行、重复的日志行。
  const t0 = ['same', 'same', 'same', 'x', 'y'];
  const t1 = ['HEAD', 'same', 'same', 'same', 'x', 'y']; // 又插了一行 HEAD
  // 原下标 1 的 'same' —— 在 t1 里是 {1,2,3}。离 1 最近的是 1。
  assert.strictEqual(
    sel.relocateLine(t0, t1, { line: 1, col: 0, fp: 'same' }),
    1,
    '多命中时取最小位移,且并列时取靠前的 —— 不得随机'
  );
  // 原下标 2 → 在 t1 里最近的是 2(距离 0)
  assert.strictEqual(sel.relocateLine(t0, t1, { line: 2, col: 0, fp: 'same' }), 2);
});

test('R-03b 偏移补偿:位移对称时取靠前的那个(保证确定性)', () => {
  // 制造「上下各一,距离相等」:用 3 个元素、原行号居中间隔 2。
  const t0 = ['same', 'mid1', 'mid2', 'same'];
  const t1 = ['same', 'mid1', 'mid2', 'same'];
  // 原下标 0 与 3 都是 'same';让原行号是 0 → t1 里命中 {0,3},距 0 分别 0 和 3
  assert.strictEqual(sel.relocateLine(t0, t1, { line: 0, col: 0, fp: 'same' }), 0);
  // 若原行号是 1,命中仍是 {0,3},距 1 分别 1 和 2 → 取 0
  assert.strictEqual(
    sel.relocateLine(t0, t1, { line: 1, col: 0, fp: 'same' }),
    0,
    '并列外的最近者;确定性由循环顺序保证'
  );
});

test('R-04 失配降级:指纹在目标里找不到 → 返回 clamp 后的原行号', () => {
  const t0 = ['a', 'b', 'c'];
  const t1 = ['x', 'y', 'z', 'w']; // 内容全换
  assert.strictEqual(
    sel.relocateLine(t0, t1, { line: 1, col: 0, fp: 'b' }),
    1,
    '"b" 在 t1 不存在 → 维持今天的行为(原行号),不猜'
  );
});

test('R-05 失配降级:锚点没带指纹(老调用方)→ 纯行号,与历史逐字节一致', () => {
  const lines = ['a', 'b', 'c'];
  assert.strictEqual(sel.relocateLine(lines, lines, { line: 1, col: 0 }), 1);
  assert.strictEqual(sel.relocateLine(lines, lines, { line: 1, col: 0, fp: '' }), 1);
  assert.strictEqual(sel.relocateLine(lines, lines, { line: 1, col: 0, fp: null }), 1);
});

test('R-06 越界:原行号超过目标长度 → clamp 到末行', () => {
  const t0 = ['a', 'b', 'c', 'd', 'e'];
  const t1 = ['a', 'b', 'c'];
  // 指纹 'e' 在 t1 不存在 → 走失配降级,原行号 4 clamp 到 2
  assert.strictEqual(sel.relocateLine(t0, t1, { line: 4, col: 0, fp: 'e' }), 2, 'clamp 到末行');
  // 指纹 'c' 在 t1 里唯一 → 精确命中到 2
  assert.strictEqual(sel.relocateLine(t0, t1, { line: 2, col: 0, fp: 'c' }), 2);
});

test('R-07 空目标数组 → 0(不抛,不返回 -1)', () => {
  assert.strictEqual(sel.relocateLine(['a'], [], { line: 0, col: 0, fp: 'a' }), 0);
});

test('R-08 指纹归一化:缩进/折行处空白差异不该让同一行认不出来', () => {
  // T0 里的行首有两格缩进,T1 里折行重排后缩进变了 —— 归一化后应仍能认出。
  const t0 = ['  indented', 'other'];
  const t1 = ['other', 'indented'];
  assert.strictEqual(
    sel.relocateLine(t0, t1, { line: 0, col: 2, fp: t0[0] }),
    1,
    '折叠空白后 "  indented" === "indented",应命中下标 1'
  );
});

test('R-09 绝不抛:畸形输入一律 fail-soft', () => {
  assert.doesNotThrow(() => sel.relocateLine(null, null, null));
  assert.doesNotThrow(() => sel.relocateLine('nope', 42, { line: -5, col: -3, fp: 7 }));
  assert.doesNotThrow(() => sel.relocateLine(undefined, undefined, undefined));
  assert.strictEqual(sel.relocateLine(null, null, null), 0);
});

test('R-10 不改入参:两个行数组与端点对象都不被写坏', () => {
  const t0 = ['a', 'b', 'c'];
  const t1 = ['x', 'a', 'b', 'c'];
  const p = { line: 1, col: 3, fp: 'b' };
  const t0Copy = t0.slice();
  const t1Copy = t1.slice();
  const pCopy = { ...p };
  sel.relocateLine(t0, t1, p);
  assert.deepStrictEqual(t0, t0Copy, 'from 不得被改');
  assert.deepStrictEqual(t1, t1Copy, 'to 不得被改');
  assert.deepStrictEqual(p, pCopy, 'point 不得被改');
});

// ════════════════════════════════════════════════════════════════════════════
// R-11..R-13:relocateSelection —— 两端各自重定位
// ════════════════════════════════════════════════════════════════════════════

test('R-11 两端各自重定位:折行重排使两端位移量不同', () => {
  // T0:用户选了 A 段(下标 1..3)。
  const t0 = ['HEAD', 'A1', 'A2', 'A3', 'TAIL'];
  // T1:HEAD 前插了一行,B 段折行后 A 段整体下移 1 → 1..3 变 2..4。
  const t1 = ['NEW', 'HEAD', 'A1', 'A2', 'A3', 'TAIL'];
  const selection = {
    anchor: { line: 1, col: 0, fp: 'A1' },
    head: { line: 3, col: 2, fp: 'A3' },
    dragging: false,
  };
  const got = sel.relocateSelection(selection, t0, t1);
  assert.strictEqual(got.anchor.line, 2, 'anchor 重定位到 2');
  assert.strictEqual(got.head.line, 4, 'head 重定位到 4');
  assert.strictEqual(got.anchor.col, 0, '列不动(列是行内偏移,与行位移无关)');
  assert.strictEqual(got.head.col, 2, '列不动');
});

test('R-12 丢弃指纹:重定位后不再携带 fp(已消费)', () => {
  const t0 = ['a', 'b'];
  const t1 = ['z', 'a', 'b'];
  const got = sel.relocateSelection(
    { anchor: { line: 0, col: 0, fp: 'a' }, head: { line: 1, col: 0, fp: 'b' }, dragging: false },
    t0,
    t1
  );
  assert.strictEqual(got.anchor.fp, undefined, 'fp 已消费 → 不得残留');
  assert.strictEqual(got.head.fp, undefined);
});

test('R-13 dragging 状态保留 + 畸形输入 fail-soft', () => {
  const lines = ['a', 'b'];
  const got = sel.relocateSelection(
    { anchor: { line: 0, col: 0 }, head: { line: 1, col: 0 }, dragging: true },
    lines,
    lines
  );
  assert.strictEqual(got.dragging, true, 'dragging 必须原样带过');
  assert.doesNotThrow(() => sel.relocateSelection(null, lines, lines));
  assert.deepStrictEqual(
    sel.relocateSelection(null, lines, lines),
    sel.createSelection(),
    'null 选区 → 空选区'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// R-14..R-16:extractTextRelocated —— 降级兼容是接线安全的前提
// ════════════════════════════════════════════════════════════════════════════

test('R-14 不传 fromLines → 与 extractText 逐字节相同(接线前的零回归保证)', () => {
  const lines = ['L00', 'L01', 'L02', 'L03', 'L04'];
  const s = {
    anchor: { line: 1, col: 0 },
    head: { line: 3, col: 0 },
    dragging: false,
  };
  assert.strictEqual(
    sel.extractTextRelocated(lines, undefined, s),
    sel.extractText(lines, s),
    '第三参不传时必须退化为 extractText —— 这是「接线不接线都不变」的凭据'
  );
  assert.strictEqual(sel.extractTextRelocated(lines, null, s), sel.extractText(lines, s));
  assert.strictEqual(sel.extractTextRelocated(lines, 'nope', s), sel.extractText(lines, s));
});

test('R-15 传了 fromLines 且锚点带指纹 → 取到的是用户看到的那段(修复生效)', () => {
  // 这就是 selectionAnchorDrift D-02 的场景,但走**纯函数**路径:
  // T0 用户看中 L10..L14;T1 头上插了 3 行。
  const t0 = Array.from({ length: 20 }, (_, i) => `L${String(i).padStart(2, '0')}`);
  const t1 = ['N00', 'N01', 'N02'].concat(t0);

  const selection = {
    anchor: { line: 10, col: 0, fp: t0[10] },
    // head 在 T0 的末行行尾 —— 但 head 的列是按 T0 的 L14 算的
    head: { line: 14, col: t0[14].length, fp: t0[14] },
    dragging: false,
  };

  const got = sel.extractTextRelocated(t1, t0, selection);
  assert.strictEqual(
    got,
    'L10\nL11\nL12\nL13\nL14',
    '重定位后再切片才能取到用户看到的那 5 行(这正是 D-02 期望的行为)'
  );
});

test('R-16 传了 fromLines 但锚点无指纹 → 仍是旧行为(渐进接线,逐调用方切换)', () => {
  const t0 = Array.from({ length: 20 }, (_, i) => `L${String(i).padStart(2, '0')}`);
  const t1 = ['N00', 'N01', 'N02'].concat(t0);
  const selection = {
    anchor: { line: 10, col: 0 },
    head: { line: 14, col: t0[14].length },
    dragging: false,
  };
  // 无指纹 → 仍按行号 10..14 取 t1 → 取到的是被顶下去的错位内容(L10..L14 是 N00.. 之后)
  // 断言它**不等于**正确内容,以此钉住「没接线就没修好」,避免假绿的中间态。
  const got = sel.extractTextRelocated(t1, t0, selection);
  assert.notStrictEqual(
    got,
    'L10\nL11\nL12\nL13\nL14',
    '无指纹时不重定位 → 必然漂移(这证明修复确实依赖指纹,不是别处碰巧对了)'
  );
});
