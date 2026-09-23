'use strict';

// bootLayout.test — 启动屏帧高阶梯的纯叶子单测（[DESIGN-ARCH-134] §7.1 #1）。
//
// 这是对 H1 硬约束的确定性锁定：帧高必须 ≤ rows − 1，否则 ink 进 fullscreen 分支
// （`node_modules/ink/build/ink.js:320`），spinner 每 80ms 一帧 = 整屏清屏重印。
// 用 node:test 写 —— CI 的 `test:node` 是 `node --test tests/**/*.test.js` 全量 glob，
// 任何引用未定义 `describe`/`test` 的文件都会落地即红（`tests/tui/liveFrameGeometry.test.js` 前科）。

const test = require('node:test');
const assert = require('node:assert');

const {
  plan,
  RUNGS,
  FIXED_ROWS,
  TAIL_ROWS,
  BEAT_ROWS,
  PROGRESS_ROWS,
  MIN_CENTER_COLS,
  frameRowsOf,
} = require('../../../src/cli/tui/bootLayout');

test('阶梯阈值：各档恰好在其 rows 门槛上被选中', () => {
  assert.equal(plan({ rows: 80 }).rung, 'F');
  assert.equal(plan({ rows: 30 }).rung, 'F');
  assert.equal(plan({ rows: 26 }).rung, 'F');
  assert.equal(plan({ rows: 25 }).rung, 'G');
  assert.equal(plan({ rows: 24 }).rung, 'H');
  assert.equal(plan({ rows: 17 }).rung, 'H');
  assert.equal(plan({ rows: 16 }).rung, 'I');
  assert.equal(plan({ rows: 15 }).rung, 'J');
  assert.equal(plan({ rows: 10 }).rung, 'J');
  assert.equal(plan({ rows: 3 }).rung, 'J');
});

test('降级顺序：brandRows 严格单调递减 F→G→H→I→J', () => {
  const rows = RUNGS.map((r) => r.clover * 9 + r.wordmark + r.tagline);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i] < rows[i - 1], `第 ${i} 档 brandRows 必须严格小于上一档`);
  }
  assert.deepEqual(rows, [11, 10, 2, 1, 0]);
});

test('账本闭合：frameRows = FIXED_ROWS + brandRows + TAIL_ROWS（逐档）', () => {
  for (const r of RUNGS) {
    const brandRows = r.clover * 9 + r.wordmark + r.tagline;
    assert.equal(frameRowsOf(r), FIXED_ROWS + brandRows + TAIL_ROWS, `档 ${r.id}`);
  }
});

test('账本常量与文档一致（防静默漂移）', () => {
  assert.equal(BEAT_ROWS, 6, 'S1：六拍行数恒定 6');
  assert.equal(PROGRESS_ROWS, 3, 'ProgressBar 自带 marginY 1×2 + 内容 1 行');
  assert.equal(TAIL_ROWS, 1, '阻断/降级汇总行恒按 1 行预留（保守侧）');
  assert.equal(FIXED_ROWS, 13, 'paddingY 2 + 空行 1 + 进度 3 + 六拍 6 + 尾空行 1');
});

test('rows 非法/缺失 → 保守 I 档（帧高 15 ≤ 改造前 17，永不比现状差）', () => {
  for (const bad of [undefined, null, 0, -1, NaN, 'abc', {}, []]) {
    const p = plan({ rows: bad });
    assert.equal(p.rung, 'I', `rows=${String(bad)} 应落 I 档`);
    assert.equal(p.frameRows, 15);
    assert.ok(p.frameRows <= 17, '必须 ≤ 现状帧高 17，这是回滚语义的担保');
  }
});

test('窄终端保护：cols < 40 放弃居中，其余一律居中', () => {
  assert.equal(plan({}).center, true, 'cols 缺省 → 居中');
  assert.equal(plan({ cols: 80 }).center, true);
  assert.equal(plan({ cols: 40 }).center, true);
  assert.equal(plan({ cols: 39 }).center, false);
  assert.equal(plan({ cols: 20 }).center, false);
  assert.equal(plan({ cols: 0 }).center, true, '0 视为非法，不触发保护');
  assert.equal(plan({ cols: -5 }).center, true);
  assert.equal(plan({ cols: '120' }).center, true, '字符串数字按数值判');
});

test('plan 返回新对象：改动结果不得污染下一次调用', () => {
  const a = plan({ rows: 30 });
  a.clover = false;
  a.brandRows = 999;
  const b = plan({ rows: 30 });
  assert.equal(b.clover, true);
  assert.equal(b.brandRows, 11);
  assert.notEqual(a, b);
});

test('每档的 rung 字段自洽：brandRows 与 clover/wordmark/tagline 一致', () => {
  for (const r of RUNGS) {
    const p = plan({ rows: 80, cols: 80 });
    void p;
    const expected = r.clover * 9 + r.wordmark + r.tagline;
    assert.equal(frameRowsOf(r) - 13 - 1, expected, `档 ${r.id}`);
  }
});
