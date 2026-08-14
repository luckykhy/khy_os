'use strict';

// Unit tests for liveRegionBudget pure leaf — height arithmetic that keeps the
// bottom live region below terminal rows so ink never fullscreen-clears (which
// wipes scrollback and jumps the view to top).
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const lb = require('../../../src/cli/tui/ink-components/liveRegionBudget');

const ON = {}; // 默认开
const OFF = { KHY_LIVE_HEIGHT_BUDGET: '0' };

// ── 门控梯 ──────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.equal(lb.isEnabled(ON), true);
  assert.equal(lb.isEnabled(undefined), true);
});

test('isEnabled: 0/false/off/no → 关(大小写/空白不敏感)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(lb.isEnabled({ KHY_LIVE_HEIGHT_BUDGET: v }), false, `value ${v}`);
  }
});

// ── resolveTaskLineCap (Plan B) ─────────────────────────────────────────────
test('resolveTaskLineCap: 开 → clamp(floor(rows*0.30), 3, 10)', () => {
  assert.equal(lb.resolveTaskLineCap(40, ON), 10, 'floor(12)→clamp max 10');
  assert.equal(lb.resolveTaskLineCap(30, ON), 9);
  assert.equal(lb.resolveTaskLineCap(24, ON), 7);
  assert.equal(lb.resolveTaskLineCap(8, ON), 3, 'floor(2.4)=2→clamp min 3');
  assert.equal(lb.resolveTaskLineCap(1000, ON), 10, 'clamp max 10');
});

test('resolveTaskLineCap: rows 非法 → 兜底 24 行口径', () => {
  assert.equal(lb.resolveTaskLineCap(0, ON), 7);
  assert.equal(lb.resolveTaskLineCap(NaN, ON), 7);
  assert.equal(lb.resolveTaskLineCap(undefined, ON), 7);
});

test('resolveTaskLineCap: 关 → Infinity(不封顶,字节回退)', () => {
  assert.equal(lb.resolveTaskLineCap(40, OFF), Infinity);
});

// ── capTaskLines ────────────────────────────────────────────────────────────
test('capTaskLines: 超上界 → 尾切保留最末 cap 行 + hidden 计数 + hiddenLines 头切片', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `○ task ${i + 1}`);
  const r = lb.capTaskLines(lines, 40, ON); // cap 10
  assert.equal(r.lines.length, 10);
  assert.equal(r.hidden, 10);
  assert.equal(r.lines[0], '○ task 11', 'kept the TAIL (most recent)');
  assert.equal(r.lines[9], '○ task 20');
  // 刀19:hiddenLines = 被丢弃的头部 10 行(供状态分解)。
  assert.equal(r.hiddenLines.length, 10);
  assert.equal(r.hiddenLines[0], '○ task 1');
  assert.equal(r.hiddenLines[9], '○ task 10');
});

test('capTaskLines: 未超上界 → 原样、hidden 0、hiddenLines 空', () => {
  const lines = ['→ a', '○ b', '✓ c'];
  const r = lb.capTaskLines(lines, 40, ON);
  assert.deepEqual(r.lines, lines);
  assert.equal(r.hidden, 0);
  assert.deepEqual(r.hiddenLines, []);
});

test('capTaskLines: 关 → 永不封顶(原样)', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `x${i}`);
  const r = lb.capTaskLines(lines, 24, OFF);
  assert.equal(r.lines.length, 50);
  assert.equal(r.hidden, 0);
  assert.deepEqual(r.hiddenLines, []);
});

test('capTaskLines: 防呆 非数组 → 空', () => {
  assert.deepEqual(lb.capTaskLines(null, 40, ON), { lines: [], hidden: 0, hiddenLines: [] });
  assert.deepEqual(lb.capTaskLines(undefined, 40, ON), { lines: [], hidden: 0, hiddenLines: [] });
});

// ── capTaskLines 刀30:按状态生存优先级保活(进行中/错误 > 待办 > 已完成) ─────────
const PRIO_OFF = { KHY_TASK_PRIORITY_CAP: '0' };

test('capTaskLines: 优先级保活把非末尾的进行中任务救回(不再被尾切挤掉)', () => {
  // 10 行:1 个非末尾 → ip,其余全 ✓;cap=3(rows=8)。历史尾切会留末尾 3 个 ✓ 丢掉 → ip;
  // 优先级保活把 → ip 救回(rank0),另两席从 completed 按尾锚定取末尾两个。
  const lines = [
    '→ ip', '✓ c1', '✓ c2', '✓ c3', '✓ c4', '✓ c5', '✓ c6', '✓ c7', '✓ c8', '✓ c9',
  ];
  const r = lb.capTaskLines(lines, 8, ON); // cap 3
  assert.equal(r.lines.length, 3);
  assert.equal(r.hidden, 7);
  assert.ok(r.lines.includes('→ ip'), '非末尾进行中任务被救回');
  assert.deepEqual(r.lines, ['→ ip', '✓ c8', '✓ c9'], '进行中 + 末尾两个已完成(尾锚定)');
  assert.equal(r.hiddenLines.length, 7);
  assert.ok(!r.hiddenLines.includes('→ ip'), '进行中不在隐藏里');
});

test('capTaskLines: 全同档(全待办)→ 与历史尾切逐字节一致', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `○ task ${i + 1}`);
  const r = lb.capTaskLines(lines, 40, ON); // cap 10
  assert.equal(r.lines[0], '○ task 11', '同档尾锚定 = 历史尾切');
  assert.equal(r.lines[9], '○ task 20');
  assert.equal(r.hiddenLines[0], '○ task 1');
});

test('capTaskLines: 门控关 KHY_TASK_PRIORITY_CAP → 逐字节回退历史尾切(丢非末尾进行中)', () => {
  const lines = [
    '→ ip', '✓ c1', '✓ c2', '✓ c3', '✓ c4', '✓ c5', '✓ c6', '✓ c7', '✓ c8', '✓ c9',
  ];
  const r = lb.capTaskLines(lines, 8, PRIO_OFF); // cap 3,但优先级关 → 纯尾切
  assert.deepEqual(r.lines, ['✓ c7', '✓ c8', '✓ c9'], '纯尾切:末尾 3 行,进行中被丢');
  assert.ok(!r.lines.includes('→ ip'), '门控关时进行中被尾切挤掉(历史行为)');
  assert.deepEqual(r.hiddenLines.slice(0, 1), ['→ ip']);
});

test('capTaskLines: 任一行图标不可识别 → 回退历史尾切(绝不错排)', () => {
  const lines = [
    '→ ip', 'plain text no icon', '✓ c1', '✓ c2', '✓ c3', '✓ c4', '✓ c5', '✓ c6', '✓ c7', '✓ c8',
  ];
  const r = lb.capTaskLines(lines, 8, ON); // cap 3
  // selectTaskLinesByPriority 返 null(有不可识别行)→ capTaskLines 回退尾切。
  assert.deepEqual(r.lines, ['✓ c6', '✓ c7', '✓ c8'], '不可识别 → 尾切');
});

// ── taskPanelHeight ─────────────────────────────────────────────────────────
test('taskPanelHeight: n行 + chrome(4);0行→0;带提示+1', () => {
  assert.equal(lb.taskPanelHeight(5), 9);
  assert.equal(lb.taskPanelHeight(5, true), 10);
  assert.equal(lb.taskPanelHeight(0), 0);
  assert.equal(lb.taskPanelHeight(-3), 0);
  assert.equal(lb.taskPanelHeight(NaN), 0);
});

// ── resolveStreamReserve (Plan A) ───────────────────────────────────────────
test('resolveStreamReserve: 无兄弟面板 → 与 legacy 逐字节一致(9+min(tools,6))', () => {
  assert.equal(lb.resolveStreamReserve({ rows: 40, toolCount: 0 }, ON), 9);
  assert.equal(lb.resolveStreamReserve({ rows: 40, toolCount: 3 }, ON), 12);
  assert.equal(lb.resolveStreamReserve({ rows: 40, toolCount: 99 }, ON), 15, 'tool 行封顶 6');
});

test('resolveStreamReserve: 有任务清单 → reserve 纳入面板高度 + 安全余量', () => {
  // 9(base) + 0(tools) + taskPanelHeight(8)=8+4=12 + margin2 → 23
  assert.equal(lb.resolveStreamReserve({ rows: 40, toolCount: 0, taskLineCount: 8 }, ON), 23);
  // 带 hidden 提示再 +1 → 24
  assert.equal(
    lb.resolveStreamReserve({ rows: 40, toolCount: 0, taskLineCount: 8, taskHasHiddenNotice: true }, ON),
    24,
  );
});

test('resolveStreamReserve: 计划/队列/steer 叠加(均含安全余量)', () => {
  // 9 + plan(3) + margin2 = 14
  assert.equal(lb.resolveStreamReserve({ rows: 40, planActive: true }, ON), 14);
  // 9 + queue(min(3,4)+1=4) + margin2 = 15
  assert.equal(lb.resolveStreamReserve({ rows: 40, queueLen: 3 }, ON), 15);
  // 9 + steer(1) + margin2 = 12
  assert.equal(lb.resolveStreamReserve({ rows: 40, steerLen: 2 }, ON), 12);
  // 全叠:9 + task(5+4=9) + plan3 + queue(4+1=5) + steer1 + margin2 = 29
  assert.equal(
    lb.resolveStreamReserve({ rows: 40, taskLineCount: 5, planActive: true, queueLen: 10, steerLen: 1 }, ON),
    29,
  );
});

test('resolveStreamReserve: 关 → legacy 9+min(tools,6)(无视兄弟面板)', () => {
  assert.equal(lb.resolveStreamReserve({ rows: 40, toolCount: 2, taskLineCount: 20, planActive: true }, OFF), 11);
});

// ── 页脚条件行 + Windows 余量(修复 Windows Terminal 整屏重复刷进 scrollback)────────
test('resolveStreamReserve: 无协作/无主题/非 win + 无兄弟 → 与今日基线逐字节一致', () => {
  // 三项修正皆惰性 → BASE_CHROME + toolRows,不回归常规 Linux 无协作场景。
  assert.equal(
    lb.resolveStreamReserve({ rows: 40, toolCount: 0, collabActive: false, topicInFooter: false, platform: 'linux' }, ON),
    9,
  );
  assert.equal(
    lb.resolveStreamReserve({ rows: 40, toolCount: 3, collabActive: false, topicInFooter: false, platform: 'linux' }, ON),
    12,
  );
});

test('resolveStreamReserve: 协作行 → 比基线 +1(COLLAB_LINE_ROWS)', () => {
  const base = lb.resolveStreamReserve({ rows: 40, toolCount: 0, platform: 'linux' }, ON);
  assert.equal(
    lb.resolveStreamReserve({ rows: 40, toolCount: 0, collabActive: true, platform: 'linux' }, ON),
    base + lb.COLLAB_LINE_ROWS,
  );
});

test('resolveStreamReserve: 主题回退行 → +1;两者皆真 → +2', () => {
  const base = lb.resolveStreamReserve({ rows: 40, toolCount: 0, platform: 'linux' }, ON);
  assert.equal(
    lb.resolveStreamReserve({ rows: 40, toolCount: 0, topicInFooter: true, platform: 'linux' }, ON),
    base + lb.TOPIC_FOOTER_ROWS,
  );
  assert.equal(
    lb.resolveStreamReserve({ rows: 40, toolCount: 0, collabActive: true, topicInFooter: true, platform: 'linux' }, ON),
    base + lb.COLLAB_LINE_ROWS + lb.TOPIC_FOOTER_ROWS,
  );
});

test('resolveStreamReserve: platform=win32 → 额外 +WIN_SAFETY_MARGIN;linux 不加', () => {
  const linux = lb.resolveStreamReserve({ rows: 40, toolCount: 0, platform: 'linux' }, ON);
  const win = lb.resolveStreamReserve({ rows: 40, toolCount: 0, platform: 'win32' }, ON);
  assert.equal(win, linux + lb.WIN_SAFETY_MARGIN);
  // 复现用户场景:Windows + 协作 + 主题回退 → 比 legacy 高 2 + WIN_SAFETY_MARGIN。
  const legacyBase = lb.resolveStreamReserve({ rows: 40, toolCount: 0, platform: 'linux' }, ON);
  const userCase = lb.resolveStreamReserve(
    { rows: 40, toolCount: 0, collabActive: true, topicInFooter: true, platform: 'win32' }, ON);
  assert.equal(userCase, legacyBase + lb.COLLAB_LINE_ROWS + lb.TOPIC_FOOTER_ROWS + lb.WIN_SAFETY_MARGIN);
});

test('resolveStreamReserve: 页脚行/Windows 余量与兄弟面板正确累加', () => {
  // 9(base) + task(8+4=12) + siblingMargin2 + collab1 + topic1 + win2 = 27
  assert.equal(
    lb.resolveStreamReserve(
      { rows: 40, toolCount: 0, taskLineCount: 8, collabActive: true, topicInFooter: true, platform: 'win32' }, ON),
    27,
  );
});

test('resolveStreamReserve: 门控关 → 忽略页脚行/平台新入参,恒 legacy', () => {
  assert.equal(
    lb.resolveStreamReserve(
      { rows: 40, toolCount: 2, collabActive: true, topicInFooter: true, platform: 'win32' }, OFF),
    11,
  );
});

// ── 自平衡不变式(核心:streaming + 兄弟 ≈ rows,常规终端不破)──────────────────
test('不变式:常规终端下 streamingHeight + taskPanelHeight + chrome ≤ rows', () => {
  const rows = 40;
  const taskLineCount = lb.resolveTaskLineCap(rows, ON); // 满清单 10
  const reserve = lb.resolveStreamReserve({ rows, toolCount: 0, taskLineCount }, ON);
  const streamingHeight = Math.max(6, rows - reserve); // 镜像 StreamingBlock liveBudget
  const taskHeight = lb.taskPanelHeight(taskLineCount);
  // BASE_CHROME(9) 已含输入框/footer/spinner;total ≈ streaming + task + base
  const total = streamingHeight + taskHeight + lb.BASE_CHROME;
  assert.ok(total <= rows + 1, `total ${total} 应 ≲ rows ${rows}(自平衡)`);
});
