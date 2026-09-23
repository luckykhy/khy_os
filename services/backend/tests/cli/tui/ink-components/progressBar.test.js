'use strict';

// ProgressBar 渲染契约测试 — BUG-103。
// 'stage' 模式此前只对 current 取下界钳制（Math.max(1,…)），没有上界：当
// current > total 时 empty = '○'.repeat(total - current) 传入负数 →
// String.prototype.repeat 抛 RangeError，整条 live-region 渲染崩掉。
// 兄弟模式 bytes/count 都用 Math.min(1, ratio) 钳制，stage 是唯一漏网的。
// inkRuntime 可廉价实例化，故直接渲染对拍。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('BUG-103 行为: stage 模式 current>total 不再崩溃且钳制到 total（ink 真渲染）', async () => {
  const TUI_PATH = path.resolve(__dirname, '../../../../src/cli/tui');
  process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';
  const R = require(require.resolve('react', { paths: [TUI_PATH] }));
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  await inkRuntime.loadInk();
  const ink = inkRuntime.get();
  const stripAnsi = require(path.resolve(__dirname, '../../../../src/utils/stripAnsi'));
  const PB = require(path.join(TUI_PATH, 'ink-components/ProgressBar'));

  // 修复前：current=7 total=5 → RangeError: Invalid count value: -2。
  let out;
  assert.doesNotThrow(() => {
    out = stripAnsi(ink.renderToString(
      R.createElement(PB, { kind: 'stage', current: 7, total: 5, label: 'done' }),
      { columns: 60 }));
  }, 'stage 溢出不得崩溃');
  // 钳制到 5/5：5 个实心点、0 个空心点。
  assert.ok(out.includes('●●●●●'), '应显示 5 个实心点，实测: ' + JSON.stringify(out));
  assert.ok(!out.includes('○'), '钳制后不应有空心点');
  assert.ok(out.includes('Step 5/5'), '步号应钳制为 5/5');

  // 正常中间态回归：current=2 total=5 → ●● + ○○○。
  const mid = stripAnsi(ink.renderToString(
    R.createElement(PB, { kind: 'stage', current: 2, total: 5, label: 'x' }),
    { columns: 60 }));
  assert.ok(mid.includes('●●○○○'), '中间态须正确显示进度，实测: ' + JSON.stringify(mid));
});
