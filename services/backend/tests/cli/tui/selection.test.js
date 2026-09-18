'use strict';

// selection — 应用内自绘文本选择的**验收标准**（可执行版）。
//
// 对应文档：
//   docs/03_DESIGN_设计/[DESIGN-ARCH-119] TUI文本选择与复制-验收标准.md §2 §3 §4
//
// 本文件是 `services/backend/src/cli/tui/selection.js` 的第二层（自绘选择）验收标准。
// 每个 `test(...)` 的标题前缀（S-01、S-06、S-21…）与文档里的编号一一对应，
// 便于「先读文档、再跑测试」的双向核对。
//
// 纪律（与 scrollActions.js 同范式）：
//   - 纯叶子：零 IO、绝不抛、确定性（同输入同输出）；
//   - 不改入参：返回新对象（React 靠引用变化重渲）；
//   - 半开区间：选区 = `[start, end)`，`extractText` 取 `slice(from, to)`。
//
// ⚠ 实现前先读文档 §1.1 的契约表；本文件不解释设计理由，只规定「做成什么样算通过」。
//
// 运行：node --test tests/cli/tui/selection.test.js

const test = require('node:test');
const assert = require('node:assert');

const {
  createSelection,
  beginSelection,
  extendSelection,
  endSelection,
  clearSelection,
  hasSelection,
  normalizeSelection,
  expandToWord,
  expandToLine,
  extractText,
  selectionRangeFor,
  wordBoundaryAt,
} = require('../../../src/cli/tui/selection');

// ── 通用夹具（与文档 §2 一致）────────────────────────────────────────────────
const LINES = [
  'hello world',                 // 0
  'second line here',            // 1
  'D:/Portable/khy-os/a.js',     // 2  ← 路径行，双击必须整体选中
  '',                            // 3  ← 空行
  '末行中文内容',                 // 4
];

/** 便捷构造：按下 → 拖动 → 松手。 */
function drag(fromLine, fromCol, toLine, toCol) {
  const s0 = beginSelection(createSelection(), fromLine, fromCol);
  const s1 = extendSelection(s0, toLine, toCol);
  return endSelection(s1);
}

// ════════════════════════════════════════════════════════════════════════════
// §2 核心功能 —— selection 模型层
// ════════════════════════════════════════════════════════════════════════════

// ── S-01 新建空选区 ─────────────────────────────────────────────────────────
test('S-01 createSelection 返回完全空的选区', () => {
  const s = createSelection();
  assert.deepStrictEqual(
    s,
    { anchor: null, head: null, dragging: false },
    '空选区的形状是硬契约:三个字段一个都不能少'
  );
  assert.equal(hasSelection(s), false, '空选区当然没有选中内容');
});

// ── S-02 按下建立锚点 ───────────────────────────────────────────────────────
test('S-02 beginSelection 建立锚点,但零宽不算「有选中」', () => {
  const s = beginSelection(createSelection(), 1, 3);
  assert.deepStrictEqual(s.anchor, { line: 1, col: 3 }, '锚点 = 按下点');
  assert.deepStrictEqual(s.head, { line: 1, col: 3 }, '活动端同起点');
  assert.equal(s.dragging, true, '按下即进入拖动态');
  assert.equal(
    hasSelection(s),
    false,
    '锚点与活动端相同 = 零宽 → 尚未选中内容(否则「点一下」就会复制空串)'
  );
});

// ── S-03 拖动只改活动端 ─────────────────────────────────────────────────────
test('S-03 extendSelection 只移动活动端,锚点必须纹丝不动', () => {
  const s0 = beginSelection(createSelection(), 0, 0);
  const s1 = extendSelection(s0, 0, 5);
  assert.deepStrictEqual(s1.anchor, { line: 0, col: 0 }, '锚点固定是选区的定义');
  assert.deepStrictEqual(s1.head, { line: 0, col: 5 }, '活动端跟随指针');
  assert.equal(s1.dragging, true);
});

// ── S-04 松手冻结选区 ───────────────────────────────────────────────────────
test('S-04 endSelection 只把 dragging 置假,端点位不变', () => {
  const s1 = extendSelection(beginSelection(createSelection(), 0, 0), 0, 5);
  const s2 = endSelection(s1);
  assert.equal(s2.dragging, false, '松手退出拖动态');
  assert.deepStrictEqual(s2.anchor, { line: 0, col: 0 }, '松手不得重置锚点');
  assert.deepStrictEqual(s2.head, { line: 0, col: 5 }, '松手不得重置活动端');
  assert.equal(hasSelection(s2), true, '松手后选区仍然有效(否则复制不到东西)');
});

// ── S-05 hasSelection 的三态(含最易漏的跨行零宽)────────────────────────────
test('S-05 hasSelection:无锚点 / 同行零宽 / 同行非零宽 / 跨行零宽', () => {
  assert.equal(hasSelection(createSelection()), false, '无锚点');

  const zeroWidthSameLine = endSelection(
    extendSelection(beginSelection(createSelection(), 0, 0), 0, 0)
  );
  assert.equal(hasSelection(zeroWidthSameLine), false, '同行零宽 = 无内容');

  const sameLine = drag(0, 0, 0, 1);
  assert.equal(hasSelection(sameLine), true, '同行非零宽 = 有内容(最高频场景)');

  const zeroWidthCrossLine = drag(0, 0, 1, 0);
  assert.equal(
    hasSelection(zeroWidthCrossLine),
    true,
    '跨行零宽 = 有内容(拖到下一行行首,列相同但跨行,必须算选中)'
  );
});

// ── S-06 正向单行抽取(半开区间)──────────────────────────────────────────────
test('S-06 extractText 单行:半开区间 [0,5) 得 5 个字符', () => {
  const s = drag(0, 0, 0, 5);
  assert.equal(
    extractText(LINES, s),
    'hello',
    '半开区间:extend 到列 5 → 取 slice(0,5) = 5 字符。闭区间会多一个字符'
  );
});

// ── S-07 反向单行抽取 ───────────────────────────────────────────────────────
test('S-07 反向拖选(活动端在锚点之前)结果必须与正向一致', () => {
  const forward = drag(0, 0, 0, 5);
  const backward = drag(0, 5, 0, 0);
  assert.equal(extractText(LINES, backward), extractText(LINES, forward), '方向不影响结果');
  assert.deepStrictEqual(
    normalizeSelection(backward),
    { startLine: 0, startCol: 0, endLine: 0, endCol: 5 },
    'normalizeSelection 负责交换,调用方不必判方向'
  );
});

// ── S-08 跨行抽取 ───────────────────────────────────────────────────────────
test('S-08 extractText 跨行:首行 slice(startCol) / 末行 slice(0,endCol) / 中间整行', () => {
  const s = drag(0, 6, 2, 5);
  assert.equal(
    extractText(LINES, s),
    'world\nsecond line here\nD:/Po',
    "行间以 '\\n' 连接;末行取 slice(0,5)"
  );
});

// ── S-09 跨三行且含空行(空行必须产出分隔符)──────────────────────────────────
test('S-09 跨行含空行:空行必须产出一个 \\n,不得被 filter 掉', () => {
  const s = drag(1, 0, 4, 2);
  assert.equal(
    extractText(LINES, s),
    'second line here\nD:/Portable/khy-os/a.js\n\n末行',
    '空行 → 连续的 \\n;若实现用 filter(Boolean) 去空行,这条必红'
  );
});

// ── S-10 整行选区(三击语义)──────────────────────────────────────────────────
test('S-10 expandToLine 选中整视觉行,且不含换行符', () => {
  const s = expandToLine(LINES, 1);
  assert.equal(extractText(LINES, s), 'second line here', '三击 = 该视觉行,不带 \\n');
});

// ── S-11 空选区抽取 → 空串 ──────────────────────────────────────────────────
test('S-11 extractText 对空选区返回空串(而非 null/undefined)', () => {
  assert.strictEqual(extractText(LINES, createSelection()), '', '无选区');
  const zero = endSelection(extendSelection(beginSelection(createSelection(), 0, 2), 0, 2));
  assert.strictEqual(extractText(LINES, zero), '', '零宽选区');
});

// ── S-12 selectionRangeFor 的分行区间 ───────────────────────────────────────
test('S-12 selectionRangeFor 按行给出 [from,to),选区外的行返回 null', () => {
  const s = drag(1, 3, 3, 2);
  assert.deepStrictEqual(
    selectionRangeFor(LINES, s, 1),
    { from: 3, to: LINES[1].length },
    '首行:从 startCol 到行尾 —— 端点是**具体列号**,不是 Infinity'
  );
  assert.deepStrictEqual(
    selectionRangeFor(LINES, s, 2),
    { from: 0, to: LINES[2].length },
    '中间行:整行'
  );
  assert.deepStrictEqual(
    selectionRangeFor(LINES, s, 3),
    { from: 0, to: 2 },
    '末行:从行首到 endCol'
  );
  assert.strictEqual(selectionRangeFor(LINES, s, 0), null, '选区之前的行');
  assert.strictEqual(selectionRangeFor(LINES, s, 4), null, '选区之后的行');
});

// ── S-13 selectionRangeFor 的单行与零宽边界 ─────────────────────────────────
test('S-13 selectionRangeFor 单行只命中该行;零宽行返回 null', () => {
  const single = drag(0, 2, 0, 5);
  assert.deepStrictEqual(selectionRangeFor(LINES, single, 0), { from: 2, to: 5 }, '单行区间');
  assert.strictEqual(selectionRangeFor(LINES, single, 1), null, '其余行不受影响');

  const zero = endSelection(extendSelection(beginSelection(createSelection(), 0, 3), 0, 3));
  assert.strictEqual(selectionRangeFor(LINES, zero, 0), null, '零宽 → 无内容可反色');
});

// ════════════════════════════════════════════════════════════════════════════
// §3 词边界(双击)
// ════════════════════════════════════════════════════════════════════════════

// ── S-20 词字符集:路径行任意一列都命中整条 ─────────────────────────────────
test('S-20 wordBoundaryAt 对路径行任意列都返回整条路径', () => {
  const path = LINES[2];
  for (let col = 0; col < path.length; col++) {
    const b = wordBoundaryAt(path, col);
    assert.deepStrictEqual(
      b,
      { from: 0, to: path.length },
      `列 ${col} 落在路径内 → 整条选中(词字符集必须含 / \\ . : ~ @ + -)`
    );
  }
});

// ── S-21 双击路径必须整体选中(朴素 \b 必红的场景)──────────────────────────
test('S-21 doubleClick 路径:整条选中,不得被 / 或 . 切断', () => {
  const s = expandToWord(LINES, 2, 9); // 落在 khy-os 中间
  assert.equal(
    extractText(LINES, s),
    'D:/Portable/khy-os/a.js',
    '朴素 \\b 会在 Portable 处停 — 这正是 CC 文档专门规避的坑'
  );
});

// ── S-22 双击落在词中间/词首/词尾结果一致 ───────────────────────────────────
test('S-22 expandToWord 落在同词内任意列,结果一致', () => {
  const at = (col) => extractText(LINES, expandToWord(LINES, 0, col));
  const head = at(0);
  const mid = at(2);
  const tail = at(4);
  assert.equal(mid, head, '词中间 = 词首');
  assert.equal(tail, head, '词尾最后一字符 = 词首');
  assert.equal(head, 'hello', '结果就是那个词');
});

// ── S-23 双击落在空白处:不抛,且确定性 ─────────────────────────────────────
test('S-23 expandToWord 落在空白处不得抛,且同输入同输出', () => {
  const a = expandToWord(['a  b'], 0, 1);
  const b = expandToWord(['a  b'], 0, 1);
  assert.ok(a && typeof a === 'object', '必须返回合法 Selection');
  assert.deepStrictEqual(a, b, '确定性:同输入同输出(具体取空串还是空格段由实现决定)');
  assert.doesNotThrow(
    () => extractText(['a  b'], a),
    '抽取不得抛'
  );
});

// ── S-24 双击 CJK 内容 ──────────────────────────────────────────────────────
test('S-24 expandToWord 对中文内容不抛,且结果是原行子串', () => {
  const s = expandToWord(LINES, 4, 2);
  const out = extractText(LINES, s);
  assert.equal(typeof out, 'string', '必须返回字符串');
  assert.ok(LINES[4].includes(out), '结果必须是原行的子串(不得凭空造字)');
});

// ── S-25 双击越界 ───────────────────────────────────────────────────────────
test('S-25 expandToWord 越界坐标不得抛', () => {
  assert.doesNotThrow(() => expandToWord(LINES, 0, 999), '列越界 → 按行尾处理');
  assert.doesNotThrow(() => expandToWord(LINES, 999, 0), '行越界');
  assert.doesNotThrow(() => expandToWord([], 0, 0), '空数组');
});

// ════════════════════════════════════════════════════════════════════════════
// §4 边界情况 —— 全部 fail-soft
// ════════════════════════════════════════════════════════════════════════════

// ── S-30 越界坐标 clamp ─────────────────────────────────────────────────────
test('S-30 越界坐标被 clamp,不得抛', () => {
  assert.doesNotThrow(
    () => beginSelection(createSelection(), 999, 999),
    '行/列越界'
  );
  const s = extendSelection(beginSelection(createSelection(), 2, 2), -5, -5);
  assert.doesNotThrow(() => extractText(LINES, s), '负坐标抽取不得抛');
});

// ── S-31 lines 异常值 ───────────────────────────────────────────────────────
test('S-31 lines 为 null/undefined/空/非数组 → 返回空串,不抛', () => {
  const s = drag(0, 0, 0, 3);
  for (const bad of [null, undefined, [], 'not-an-array', 42, {}]) {
    assert.strictEqual(
      extractText(bad, s),
      '',
      `lines = ${JSON.stringify(bad)} 必须返回空串`
    );
  }
  assert.strictEqual(extractText(LINES, null), '', 'sel = null');
  assert.strictEqual(extractText(LINES, undefined), '', 'sel = undefined');
});

// ── S-32 sel 形状损坏 ───────────────────────────────────────────────────────
test('S-32 sel 形状损坏 → false / 空串 / null,不抛', () => {
  for (const bad of [null, undefined, {}, 42, 'x']) {
    assert.strictEqual(hasSelection(bad), false, `hasSelection(${JSON.stringify(bad)})`);
  }
  assert.strictEqual(
    hasSelection({ anchor: null, head: { line: 0, col: 1 } }),
    false,
    '半空(只有活动端)→ 视为无选区'
  );
  assert.strictEqual(extractText(LINES, { anchor: 'x', head: 123 }), '', '类型错乱 → 空串');
  assert.strictEqual(normalizeSelection(null), null, 'normalizeSelection(null) → null');
});

// ── S-33 行内含 null(投影可能有洞)──────────────────────────────────────────
test('S-33 lines 含 null 行 → 按空串处理,仍产出分隔 \\n', () => {
  const lines = ['a', null, 'c'];
  const s = drag(0, 0, 2, 1);
  assert.equal(
    extractText(lines, s),
    'a\n\nc',
    'null 行 → 空串,但行间 \\n 仍在(渲染层已有 `line || \' \'` 兜底,文本层同样要健壮)'
  );
});

// ── S-34 数字/字符串坐标(宽松解析)──────────────────────────────────────────
test('S-34 坐标接受字符串数字;NaN 不得抛', () => {
  const s = beginSelection(createSelection(), '1', '3');
  assert.deepStrictEqual(s.anchor, { line: 1, col: 3 }, '字符串数字按数字处理');
  assert.doesNotThrow(() => beginSelection(createSelection(), NaN, 0), 'NaN 不得抛');
});

// ── S-35 极端规模不爆栈 ─────────────────────────────────────────────────────
test('S-35 5000 行(等于 App 的 CAP)全选不爆栈', () => {
  const big = new Array(5000).fill('x').map((_, i) => `line ${i}`);
  const s = drag(0, 0, 4999, 6);
  const out = extractText(big, s);
  assert.ok(out.length > 0, '必须有内容');
  assert.ok(out.startsWith('line 0'), '首行从 startCol 起');
  // 末行 `'line 4999'.slice(0, 6)` = `'line 4'`(半开区间,6 个字符)
  assert.ok(out.endsWith('line 4'), '末行到 endCol 止:slice(0,6) = "line 4"');
});

// ── S-36 冻结性:纯函数不得改入参(React 重渲的命门)────────────────────────
test('S-36 extendSelection 不得原地改入参(否则 React 不重渲,选区画不出来)', () => {
  const s0 = beginSelection(createSelection(), 0, 0);
  const snapshot = JSON.parse(JSON.stringify(s0));
  const s1 = extendSelection(s0, 2, 3);
  assert.deepStrictEqual(s0, snapshot, '原对象必须未被改动');
  assert.notStrictEqual(s1, s0, '必须返回新对象(引用变化才触发重渲)');
});

// ── S-37 clearSelection 等价于 createSelection ──────────────────────────────
test('S-37 clearSelection 与 createSelection 等价', () => {
  assert.deepStrictEqual(clearSelection(), createSelection(), '清空 = 全新空选区');
});
