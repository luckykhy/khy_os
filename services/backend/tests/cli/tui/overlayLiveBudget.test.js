'use strict';

// overlayLiveBudget.test — 独占输入的全屏覆盖层 live 预算叶子。
// 纯叶子:零 IO、确定性、绝不抛。覆盖:ownsLiveRegion 判定(含 /khyos 补齐与 legacy 回退)、
// overlayBodyRows 预算与地板、门控字节回退、坏输入兜底,以及本次修复的核心不变量——
// 「覆盖层总高严格 < 终端 rows」(ink 全屏重绘的触发条件是 >= rows)。

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/cli/tui/ink-components/overlayLiveBudget');
const { ownsLiveRegion, overlayBodyRows, isEnabled, OVERLAY_CHROME } = leaf;

const OFF = { KHY_OVERLAY_LIVE_BUDGET: '0' };

test('门控默认开;仅显式 falsy 关闭', () => {
  assert.equal(isEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(isEnabled({ KHY_OVERLAY_LIVE_BUDGET: v }), false, `off word ${JSON.stringify(v)}`);
  }
  for (const v of ['1', 'true', 'yes', '']) {
    assert.equal(isEnabled({ KHY_OVERLAY_LIVE_BUDGET: v }), true, `on word ${JSON.stringify(v)}`);
  }
});

test('ownsLiveRegion:开 → modelPicker 与 khyosOpen 都算独占', () => {
  assert.equal(ownsLiveRegion({ modelPicker: true }, {}), true);
  assert.equal(ownsLiveRegion({ khyosOpen: true }, {}), true);
  assert.equal(ownsLiveRegion({ modelPicker: true, khyosOpen: true }, {}), true);
  assert.equal(ownsLiveRegion({}, {}), false);
  assert.equal(ownsLiveRegion({ modelPicker: false, khyosOpen: false }, {}), false);
});

test('ownsLiveRegion:关 → 逐字节回退「只认 modelPicker」(历史行为)', () => {
  assert.equal(ownsLiveRegion({ modelPicker: true }, OFF), true);
  assert.equal(ownsLiveRegion({ khyosOpen: true }, OFF), false); // 关门即恢复旧同屏行为
  assert.equal(ownsLiveRegion({}, OFF), false);
});

test('ownsLiveRegion:坏入参不抛,按 falsy 处理', () => {
  assert.equal(ownsLiveRegion(undefined, {}), false);
  assert.equal(ownsLiveRegion(null, {}), false);
  assert.equal(ownsLiveRegion({ khyosOpen: 'yes' }, {}), true); // 真值即独占
});

test('overlayBodyRows:开 → rows-8;关 → rows-6(历史 maxBody 逐字节一致)', () => {
  assert.equal(overlayBodyRows(40, {}), 32);
  assert.equal(overlayBodyRows(40, OFF), 34);
  assert.equal(overlayBodyRows(24, {}), 16);
  assert.equal(overlayBodyRows(24, OFF), 18);
});

test('overlayBodyRows:地板 6 守住极小终端(开/关同地板)', () => {
  for (const r of [1, 5, 8, 12]) {
    assert.ok(overlayBodyRows(r, {}) >= 6, `rows=${r} 开`);
    assert.ok(overlayBodyRows(r, OFF) >= 6, `rows=${r} 关`);
  }
  assert.equal(overlayBodyRows(10, {}), 6);
});

test('overlayBodyRows:非有限/≤0 行数 → 兜底按 24 行(部分 Windows 终端报 0)', () => {
  for (const bad of [0, -5, NaN, Infinity, undefined, null, 'abc']) {
    assert.equal(overlayBodyRows(bad, {}), 16, `bad rows ${String(bad)}`);
  }
});

test('核心不变量:常规终端下「正文 + chrome」严格 < rows(不触发 ink 全屏重绘)', () => {
  // ink: outputHeight >= stdout.rows → clearTerminal 全屏分支。必须严格小于。
  for (let rows = 14; rows <= 120; rows++) {
    const total = overlayBodyRows(rows, {}) + OVERLAY_CHROME;
    assert.ok(total < rows, `rows=${rows} 总高=${total} 未守住 < rows`);
  }
});

test('回归对照:关门时旧预算在贴顶(即本次要修的 bug 形态)', () => {
  // 旧路径 rows-6 + chrome 5 = rows-1 → 再叠输入框/页脚必然 >= rows。
  const rows = 40;
  assert.equal(overlayBodyRows(rows, OFF) + OVERLAY_CHROME, rows - 1);
});
