'use strict';

// 离线确定性单测:liveHeightClamp 纯叶子(把 StreamingBlock 流式预览的尾切度量从「原始行数」
// 升级为「视觉行数」——含终端软换行 + CJK 宽字符——使 live 区每一帧都 < 终端 rows,不触发 ink
// 全屏重绘)。零 IO、零网络、可 CI 复跑。覆盖:门控默认开 + 四 falsy 关字节回退;wrappedRows
// (窄/宽/CJK/坏几何);measureVisualRows(空/多行);tailToVisualRows(视觉行尾切 vs 原始行尾切
// 更紧、至少 1 行、truncated 正确、gate-off 委托);tailTimelineToVisualRows(text 按视觉行、tool 按
// toolCostOf 回调计真实渲染行数(未传/异常/非有限/<1 → 1 回退;单条超预算仍保留)、gate-off 委托);
// 敌意 env / NaN columns 不抛。
//
// 运行: node --test services/backend/tests/cli/tui/liveHeightClamp.test.js

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/cli/tui/ink-components/liveHeightClamp');
const {
  isEnabled,
  wrappedRows,
  measureVisualRows,
  tailToVisualRows,
  tailTimelineToVisualRows,
  OFF_VALUES,
} = leaf;

// ── isEnabled(门控默认开) ─────────────────────────────────────────────────────

test('isEnabled defaults on (unset / empty / "1" / "on")', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_LIVE_HARD_CLAMP: '' }), true);
  assert.strictEqual(isEnabled({ KHY_LIVE_HARD_CLAMP: '1' }), true);
  assert.strictEqual(isEnabled({ KHY_LIVE_HARD_CLAMP: 'on' }), true);
});

test('isEnabled off for the four falsy values (case-insensitive, trimmed)', () => {
  for (const v of OFF_VALUES) {
    assert.strictEqual(isEnabled({ KHY_LIVE_HARD_CLAMP: v }), false, v);
    assert.strictEqual(isEnabled({ KHY_LIVE_HARD_CLAMP: v.toUpperCase() }), false, v);
  }
  assert.strictEqual(isEnabled({ KHY_LIVE_HARD_CLAMP: ' Off ' }), false);
});

// ── wrappedRows(单行视觉行数) ─────────────────────────────────────────────────

test('wrappedRows: narrow line = 1 row', () => {
  assert.strictEqual(wrappedRows('hi', 80), 1);
  assert.strictEqual(wrappedRows('', 80), 1); // 空行仍占一屏行
});

test('wrappedRows: wide line soft-wraps to ceil(width/columns)', () => {
  assert.strictEqual(wrappedRows('x'.repeat(200), 80), 3); // ceil(200/80)=3
  assert.strictEqual(wrappedRows('x'.repeat(80), 80), 1);  // exactly fills one row
  assert.strictEqual(wrappedRows('x'.repeat(81), 80), 2);
});

test('wrappedRows: CJK full-width counted at width 2 (via displayWidth)', () => {
  // 40 CJK chars = display width 80 → exactly one 80-col row
  assert.strictEqual(wrappedRows('字'.repeat(40), 80), 1);
  // 41 CJK chars = display width 82 → two rows
  assert.strictEqual(wrappedRows('字'.repeat(41), 80), 2);
});

test('wrappedRows: bad geometry (columns <=0 / NaN) → 1 (no over-trim)', () => {
  assert.strictEqual(wrappedRows('x'.repeat(200), 0), 1);
  assert.strictEqual(wrappedRows('x'.repeat(200), -5), 1);
  assert.strictEqual(wrappedRows('x'.repeat(200), NaN), 1);
});

// ── measureVisualRows(多行求和) ───────────────────────────────────────────────

test('measureVisualRows: empty string = 0', () => {
  assert.strictEqual(measureVisualRows('', 80), 0);
  assert.strictEqual(measureVisualRows(null, 80), 0);
});

test('measureVisualRows: sums wrappedRows over newline-split lines', () => {
  assert.strictEqual(measureVisualRows('a\nb\nc', 80), 3);
  // one short line + one line that wraps to 3 rows = 4 visual rows
  assert.strictEqual(measureVisualRows('short\n' + 'x'.repeat(200), 80), 4);
});

// ── tailToVisualRows(视觉行尾切) ──────────────────────────────────────────────

test('tailToVisualRows: keeps last lines within visual-row budget, truncated flag set', () => {
  // 5 lines each wrapping to 2 visual rows @80; budget 4 rows → keep last 2 lines
  const wide = Array.from({ length: 5 }, () => 'x'.repeat(120)).join('\n');
  const r = tailToVisualRows(wide, 4, 80, {});
  assert.strictEqual(r.text.split('\n').length, 2);
  assert.strictEqual(r.truncated, true);
});

test('tailToVisualRows: keeps at least 1 line even when it self-overflows budget', () => {
  const oneHuge = 'y'.repeat(500); // 7 visual rows @80
  const r = tailToVisualRows(oneHuge, 3, 80, {});
  assert.strictEqual(r.text, oneHuge); // the sole line is kept
  assert.strictEqual(r.truncated, false); // nothing dropped
});

test('tailToVisualRows: short text within budget returned whole, not truncated', () => {
  const r = tailToVisualRows('a\nb\nc', 10, 80, {});
  assert.strictEqual(r.text, 'a\nb\nc');
  assert.strictEqual(r.truncated, false);
});

test('tailToVisualRows: visual-row cut is TIGHTER than raw-line cut (anti-overshoot)', () => {
  // Same input, same numeric budget: gate-on visual measure keeps FEWER raw lines
  // than gate-off raw-line measure, proving the clamp actually prevents overshoot.
  const wide = Array.from({ length: 5 }, () => 'x'.repeat(120)).join('\n');
  const on = tailToVisualRows(wide, 4, 80, {});
  const off = tailToVisualRows(wide, 4, 80, { KHY_LIVE_HARD_CLAMP: 'off' });
  assert.ok(
    on.text.split('\n').length < off.text.split('\n').length,
    `visual cut (${on.text.split('\n').length}) should keep fewer lines than raw cut (${off.text.split('\n').length})`,
  );
});

test('tailToVisualRows: gate off → byte-identical to raw-line tail for all falsy values', () => {
  const wide = Array.from({ length: 5 }, (_v, i) => `line${i}-` + 'x'.repeat(120)).join('\n');
  // Reference raw-line tail (last `budget` lines).
  const rawLast4 = wide.split('\n').slice(-4).join('\n');
  for (const v of OFF_VALUES) {
    const r = tailToVisualRows(wide, 4, 80, { KHY_LIVE_HARD_CLAMP: v });
    assert.strictEqual(r.text, rawLast4, `gate-off ${v} text`);
    assert.strictEqual(r.truncated, true, `gate-off ${v} truncated`);
  }
});

test('tailToVisualRows: empty text → {"", false}', () => {
  assert.deepStrictEqual(tailToVisualRows('', 5, 80, {}), { text: '', truncated: false });
});

// ── tailTimelineToVisualRows(时间线视觉行尾切) ─────────────────────────────────

test('tailTimelineToVisualRows: text counted by visual rows, tool = 1 row', () => {
  const tl = [
    { type: 'text', text: 'old' },
    { type: 'tool', name: 'Bash' },
    { type: 'text', text: 'w' + 'x'.repeat(120) }, // 2 visual rows @80
  ];
  // budget 3 rows: last text (2 rows) + tool (1 row) = 3 → drops the leading 'old'
  const r = tailTimelineToVisualRows(tl, 3, 80, {});
  assert.deepStrictEqual(r.entries.map((e) => e.type), ['tool', 'text']);
  assert.strictEqual(r.truncated, true);
});

test('tailTimelineToVisualRows: whole timeline fits → not truncated', () => {
  const tl = [
    { type: 'text', text: 'a' },
    { type: 'tool', name: 'Read' },
    { type: 'text', text: 'b' },
  ];
  const r = tailTimelineToVisualRows(tl, 10, 80, {});
  assert.strictEqual(r.entries.length, 3);
  assert.strictEqual(r.truncated, false);
});

test('tailTimelineToVisualRows: gate off delegates to raw-line timeline tail', () => {
  const tl = [
    { type: 'text', text: 'old' },      // 1 raw line
    { type: 'tool', name: 'Bash' },     // 1 row
    { type: 'text', text: 'w' + 'x'.repeat(120) }, // 1 raw line (raw mode ignores wrap)
  ];
  // raw budget 3 keeps all three; ON would have dropped 'old' (see test above)
  const off = tailTimelineToVisualRows(tl, 3, 80, { KHY_LIVE_HARD_CLAMP: '0' });
  assert.strictEqual(off.entries.length, 3);
  assert.strictEqual(off.truncated, false);
});

test('tailTimelineToVisualRows: non-array timeline → empty, not thrown', () => {
  assert.deepStrictEqual(tailTimelineToVisualRows(null, 5, 80, {}), { entries: [], truncated: false });
  assert.deepStrictEqual(tailTimelineToVisualRows(undefined, 5, 80, {}), { entries: [], truncated: false });
});

// ── toolCostOf(tool 条目按回调计真实渲染行) ──────────────────────────────────

test('toolCostOf: absent callback → tool still counted as 1 row (historical)', () => {
  // budget 2: text 1 + tool 1 + text 1 = 3 > 2 → drops the leading text; with a
  // real-billing callback the same shape would keep even fewer (see next test).
  const tl = [
    { type: 'text', text: 'old' },
    { type: 'tool', name: 'Bash', tool: { big: true } },
    { type: 'text', text: 'last' },
  ];
  const r = tailTimelineToVisualRows(tl, 2, 80, {});
  assert.deepStrictEqual(r.entries.map((e) => e.type), ['tool', 'text']);
  assert.strictEqual(r.truncated, true);
});

test('toolCostOf: callback real billing shrinks the window in the SAME frame (anti-overshoot)', () => {
  // text 1 + tool 21 + text 4: budget 26 keeps ALL three (billing exact, not 1+1+1);
  // budget 22 drops the leading 4-row text because the 21-row tool is honestly billed
  // (historical 1-row billing would have kept it: 1+1+4 = 6 ≤ 22).
  const tl = [
    { type: 'text', text: 'a\nb\nc\nd' }, // 4 visual rows
    { type: 'tool', name: 'Bash', tool: {} },
    { type: 'text', text: 'z' },          // 1 row
  ];
  const cost = () => 21;
  const all = tailTimelineToVisualRows(tl, 26, 80, {}, null, cost);
  assert.strictEqual(all.entries.length, 3);
  assert.strictEqual(all.truncated, false); // 4 + 21 + 1 = 26 exactly fits
  const tight = tailTimelineToVisualRows(tl, 22, 80, {}, null, cost);
  assert.deepStrictEqual(tight.entries.map((e) => e.type), ['tool', 'text']);
  assert.strictEqual(tight.truncated, true);
});

test('toolCostOf: single entry over budget is still kept (last-entry floor, same as text)', () => {
  // A 20-row collapsed shell body billed honestly cannot fit budget 10, but the
  // sole tool entry must stay visible — loop exits with used > max; entries ABOVE
  // it (collected later by the backwards walk) are dropped instead.
  const tl = [
    { type: 'text', text: 'head' },
    { type: 'tool', name: 'Bash', tool: {} },
  ];
  const r = tailTimelineToVisualRows(tl, 10, 80, {}, null, () => 20);
  assert.deepStrictEqual(r.entries.map((e) => e.type), ['tool']);
  assert.strictEqual(r.truncated, true); // the 'head' text above stayed out of budget
});

test('toolCostOf: throwing callback / non-finite / <1 return → billed as 1 (fail-soft)', () => {
  const tl = [
    { type: 'text', text: 'old' },
    { type: 'tool', name: 'x', tool: {} },
  ];
  // budget 2: honest billing would keep only the tool (cost 21); fallback 1 keeps text too
  const hostile = () => { throw new Error('estimator bug'); };
  const r = tailTimelineToVisualRows(tl, 2, 80, {}, null, hostile);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.truncated, false);
  for (const bad of [() => NaN, () => Infinity, () => 0, () => -3, () => 'x']) {
    const rb = tailTimelineToVisualRows(tl, 2, 80, {}, null, bad);
    assert.strictEqual(rb.entries.length, 2, `non-finite/low callback billed as 1: ${bad()}`);
  }
});

test('toolCostOf: fractional cost floored (2.9 → 2), not rounded up', () => {
  const tl = [
    { type: 'tool', name: 'x', tool: {} },
    { type: 'text', text: 't' },
  ];
  // budget 3: floored 2 + text 1 = 3 fits; un-floored 2.9 + 1 = 3.9 would drop the text
  const r = tailTimelineToVisualRows(tl, 3, 80, {}, null, () => 2.9);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.truncated, false);
});

// ── 绝不抛(敌意 env / 坏几何) ────────────────────────────────────────────────

test('tailToVisualRows: does not throw on hostile env (null prototype)', () => {
  const hostile = Object.create(null);
  assert.doesNotThrow(() => tailToVisualRows('a\nb\nc', 2, 80, hostile));
});

test('tailToVisualRows: NaN columns does not throw, still bounds raw lines', () => {
  // NaN columns → wrappedRows=1/line → budget 2 keeps last 2 lines
  const r = tailToVisualRows('a\nb\nc', 2, NaN, {});
  assert.strictEqual(r.text, 'b\nc');
  assert.strictEqual(r.truncated, true);
});

test('tailTimelineToVisualRows: does not throw on hostile env / bad columns', () => {
  const tl = [{ type: 'text', text: 'a' }, { type: 'tool', name: 'x' }];
  const hostile = Object.create(null);
  assert.doesNotThrow(() => tailTimelineToVisualRows(tl, 3, NaN, hostile));
});

test('tailToVisualRows: non-finite budget → raw-line fallback, does not throw', () => {
  assert.doesNotThrow(() => tailToVisualRows('a\nb\nc', NaN, 80, {}));
  // NaN budget → raw fallback with max=1 → keep last line
  const r = tailToVisualRows('a\nb\nc', NaN, 80, {});
  assert.strictEqual(r.text, 'c');
  assert.strictEqual(r.truncated, true);
});
