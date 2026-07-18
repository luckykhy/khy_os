'use strict';

// Unit tests for the measurement-feedback clamp (liveRegionBudget.resolveExtraReserve).
// The clamp reads ink's ACTUAL last-frame live height and raises an extra reserve so the
// live region converges below terminal rows → ink stops fullscreen-clearing every frame
// → the user can hold a mid-scroll position during generation (对齐 CC).
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const lb = require('../../../src/cli/tui/ink-components/liveRegionBudget');

const ON = {}; // 默认开
const CLAMP_OFF = { KHY_LIVE_HEIGHT_CLAMP: '0' };
const BUDGET_OFF = { KHY_LIVE_HEIGHT_BUDGET: '0' };

// ── 门控梯 ──────────────────────────────────────────────────────────────────
test('clampEnabled: 默认开', () => {
  assert.equal(lb.clampEnabled(ON), true);
  assert.equal(lb.clampEnabled(undefined), true);
});

test('clampEnabled: 0/false/off/no → 关(大小写/空白不敏感)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(lb.clampEnabled({ KHY_LIVE_HEIGHT_CLAMP: v }), false, `value ${v}`);
  }
});

// ── 门控关字节一致 ──────────────────────────────────────────────────────────
test('resolveExtraReserve: clamp 关 → 恒 0(无视 prevExtra/超顶)', () => {
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 99, rows: 30, prevExtra: 7 }, CLAMP_OFF), 0);
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 99, rows: 30, prevExtra: 0 }, CLAMP_OFF), 0);
});

test('resolveExtraReserve: budget 关 → 恒 0(整体字节回退)', () => {
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 99, rows: 30, prevExtra: 7 }, BUDGET_OFF), 0);
});

// ── 无信号 → 保持 ────────────────────────────────────────────────────────────
test('resolveExtraReserve: lastOutputHeight NaN/0/undefined → 返回 prevExtra', () => {
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: NaN, rows: 30, prevExtra: 4 }, ON), 4);
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 0, rows: 30, prevExtra: 4 }, ON), 4);
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: undefined, rows: 30, prevExtra: 4 }, ON), 4);
  // prevExtra 缺省 → 0
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: NaN, rows: 30 }, ON), 0);
});

// ── 预算内 → 滞回(保持,单向不降) ──────────────────────────────────────────
test('resolveExtraReserve: measured ≤ rows-CLAMP_MARGIN → 返回 prevExtra', () => {
  // rows=30, target = 30-2 = 28
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 25, rows: 30, prevExtra: 4 }, ON), 4);
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 28, rows: 30, prevExtra: 4 }, ON), 4, 'measured==target → overflow 0 → 保持');
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 10, rows: 30, prevExtra: 0 }, ON), 0);
});

// ── 超出 → 按量抬,收敛保持 ──────────────────────────────────────────────────
test('resolveExtraReserve: 超顶按 overflow 抬,再回落到预算内则保持', () => {
  // rows=30, target 28. measured=31 → overflow 3 → 0+3=3
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 31, rows: 30, prevExtra: 0 }, ON), 3);
  // 抬后正文缩,下一帧 measured=28 → overflow 0 → 保持 3(收敛不动点)
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 28, rows: 30, prevExtra: 3 }, ON), 3);
});

// ── 收敛循环(闭环仿真) ──────────────────────────────────────────────────────
test('resolveExtraReserve: 迭代收敛到不动点且 live ≤ rows-CLAMP_MARGIN', () => {
  const rows = 30;
  const target = rows - lb.CLAMP_MARGIN; // 28
  const base = 40; // 无钳制时 live 高度 40(远超顶)
  // 正文预览随 extra 1:1 收缩:measured = base - e
  let e = 0;
  let prev = -1;
  let steps = 0;
  while (e !== prev && steps < 1000) {
    prev = e;
    const measured = base - e;
    e = lb.resolveExtraReserve({ lastOutputHeight: measured, rows, prevExtra: e }, ON);
    steps += 1;
  }
  assert.ok(steps < 1000, 'converges (no infinite loop)');
  assert.ok((base - e) <= target, `live ${base - e} ≤ target ${target}`);
  // maxExtra 上界
  assert.ok(e <= Math.max(0, rows - lb.CLAMP_MARGIN), 'e ≤ maxExtra');
});

// ── 单调:递减 measured 不把返回压回运行最大值以下 ──────────────────────────
test('resolveExtraReserve: 单调非降(transient 高块关闭后不下调)', () => {
  const rows = 30;
  // 先超顶抬到 3
  let e = lb.resolveExtraReserve({ lastOutputHeight: 31, rows, prevExtra: 0 }, ON);
  assert.equal(e, 3);
  // 兄弟节点关闭,live 骤降到 15(远在预算内)→ 仍保持 3(单向,不下调)
  e = lb.resolveExtraReserve({ lastOutputHeight: 15, rows, prevExtra: e }, ON);
  assert.equal(e, 3, '滞回单向:不因回落而下调');
});

// ── 饱和 / 极小终端 ──────────────────────────────────────────────────────────
test('resolveExtraReserve: 极小终端 measured 巨大 → 饱和 maxExtra 且终止', () => {
  const rows = 10;
  const maxExtra = Math.max(0, rows - lb.CLAMP_MARGIN); // 8
  const e1 = lb.resolveExtraReserve({ lastOutputHeight: 999, rows, prevExtra: 0 }, ON);
  assert.equal(e1, maxExtra, '首次即饱和于 maxExtra');
  const e2 = lb.resolveExtraReserve({ lastOutputHeight: 999, rows, prevExtra: e1 }, ON);
  assert.equal(e2, e1, '下一次调用相等 → settle(终止,不消除真实超出)');
});

// ── rows 非法 → 兜底 24 口径 ─────────────────────────────────────────────────
test('resolveExtraReserve: rows 0/NaN → 走 _rows 24 兜底', () => {
  // target = 24 - 2 = 22. measured=25 → overflow 3
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 25, rows: 0, prevExtra: 0 }, ON), 3);
  assert.equal(lb.resolveExtraReserve({ lastOutputHeight: 25, rows: NaN, prevExtra: 0 }, ON), 3);
});
