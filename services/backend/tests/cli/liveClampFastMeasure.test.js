'use strict';

/**
 * liveClampFastMeasure.test.js — 证明 tailTimelineToVisualRows 的「快度量」路径
 * (gate KHY_LIVE_CLAMP_FAST_MEASURE)与原「整段 measure + 分支」路径**逐字节等价**,
 * 且在大段场景下**真的省掉**了整段全量宽度扫描(displayWidth 调用数骤降)。
 *
 * 关键不变量:
 *  - 快路径(默认 on)与关态(逐字节回退)对同一输入返回 deepEqual 的 {entries, truncated}
 *    —— 覆盖:整段命中/尾切边界、多 text 段、text+tool 混合、CJK 宽字符、软换行、坏几何。
 *  - 大 text 段 + 小预算(CUT 场景)下,快路径的 displayWidth 调用数 << 关态(全量扫描被消除)。
 *
 * 运行:node --test services/backend/tests/cli/liveClampFastMeasure.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// 在 require(liveHeightClamp) 之前给 formatters.displayWidth 装计数探针;liveHeightClamp
// 懒加载并缓存该引用(_dispW),故首次 _displayWidth 调用会捕获探针。
const formatters = require('../../src/cli/formatters');
let _dwCalls = 0;
const _origDW = formatters.displayWidth;
formatters.displayWidth = function (s) { _dwCalls++; return _origDW(s); };

const clamp = require('../../src/cli/tui/ink-components/liveHeightClamp');

test.after(() => { formatters.displayWidth = _origDW; });

// 快路径 on(clamp 也 on):默认 env(不设 fast 门控);快路径 off:仅关 fast、clamp 仍 on。
const FAST_ON = { KHY_LIVE_HARD_CLAMP: 'on' };            // fast 默认 on
const FAST_OFF = { KHY_LIVE_HARD_CLAMP: 'on', KHY_LIVE_CLAMP_FAST_MEASURE: 'off' };

function lines(n, w) { // n 条各宽 w 的原始行
  const row = 'x'.repeat(w);
  return Array.from({ length: n }, () => row).join('\n');
}

// ── 等价性:快路径 vs 关态,逐字节一致 ─────────────────────────────────────────
const CASES = [
  { name: '单 text 段整段命中(小于预算)', tl: [{ type: 'text', text: lines(3, 10) }], budget: 20, cols: 80 },
  { name: '单 text 段尾切(超预算)', tl: [{ type: 'text', text: lines(50, 10) }], budget: 8, cols: 80 },
  { name: 'text 段恰好等于预算(边界)', tl: [{ type: 'text', text: lines(10, 10) }], budget: 10, cols: 80 },
  { name: 'text 段超预算 1 行(边界)', tl: [{ type: 'text', text: lines(11, 10) }], budget: 10, cols: 80 },
  { name: '软换行:宽行占多视觉行', tl: [{ type: 'text', text: lines(6, 200) }], budget: 5, cols: 80 },
  { name: 'CJK 宽字符', tl: [{ type: 'text', text: ['你好世界'.repeat(30), '第二行', '第三行'].join('\n') }], budget: 4, cols: 40 },
  { name: 'text+tool 混合', tl: [{ type: 'text', text: lines(4, 10) }, { type: 'tool', name: 't' }, { type: 'text', text: lines(30, 10) }], budget: 12, cols: 80 },
  { name: '多 text 段(前段被尾切)', tl: [{ type: 'text', text: lines(20, 10) }, { type: 'text', text: lines(3, 10) }], budget: 8, cols: 80 },
  { name: '空 text 段被跳过', tl: [{ type: 'text', text: '' }, { type: 'text', text: lines(5, 10) }], budget: 20, cols: 80 },
  { name: '坏几何 columns=0', tl: [{ type: 'text', text: lines(30, 500) }], budget: 6, cols: 0 },
  { name: '预算为 1(至少留 1 行)', tl: [{ type: 'text', text: lines(40, 300) }], budget: 1, cols: 80 },
];

for (const c of CASES) {
  test(`等价:${c.name}`, () => {
    const on = clamp.tailTimelineToVisualRows(c.tl, c.budget, c.cols, FAST_ON);
    const off = clamp.tailTimelineToVisualRows(c.tl, c.budget, c.cols, FAST_OFF);
    assert.deepEqual(on, off, `快路径与关态输出应逐字节一致:${c.name}`);
  });
}

test('_fastMeasureEnabled:默认 on;显式 off/0/false/no 关', () => {
  assert.equal(clamp._fastMeasureEnabled({}), true);
  assert.equal(clamp._fastMeasureEnabled({ KHY_LIVE_CLAMP_FAST_MEASURE: 'off' }), false);
  assert.equal(clamp._fastMeasureEnabled({ KHY_LIVE_CLAMP_FAST_MEASURE: '0' }), false);
  assert.equal(clamp._fastMeasureEnabled({ KHY_LIVE_CLAMP_FAST_MEASURE: 'false' }), false);
  assert.equal(clamp._fastMeasureEnabled({ KHY_LIVE_CLAMP_FAST_MEASURE: 'no' }), false);
  assert.equal(clamp._fastMeasureEnabled({ KHY_LIVE_CLAMP_FAST_MEASURE: 'on' }), true);
});

// ── 性能证据:大段 CUT 场景,快路径消除整段全量扫描 ───────────────────────────
test('大 text 段 + 小预算:快路径 displayWidth 调用数 << 关态(全量扫描被消除)', () => {
  const big = [{ type: 'text', text: lines(600, 10) }]; // 600 原始行,预算仅 10 视觉行 → CUT
  const budget = 10;
  const cols = 80;

  _dwCalls = 0;
  clamp.tailTimelineToVisualRows(big, budget, cols, FAST_ON);
  const onCalls = _dwCalls;

  _dwCalls = 0;
  clamp.tailTimelineToVisualRows(big, budget, cols, FAST_OFF);
  const offCalls = _dwCalls;

  assert.ok(offCalls > 400, `关态应对整段(600 行)全量扫描,实测 ${offCalls}`);
  assert.ok(onCalls < 50, `快路径应从末尾早停(~预算行),实测 ${onCalls}`);
  assert.ok(onCalls * 5 < offCalls, `快路径调用数应远少于关态(on=${onCalls} vs off=${offCalls})`);
});
