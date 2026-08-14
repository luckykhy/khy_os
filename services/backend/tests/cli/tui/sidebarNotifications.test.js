'use strict';

// Migrated from scripts/tests/sidebarNotifications.test.js (Jest describe/it/expect)
// to node:test + assert. All original assertion semantics preserved 1-for-1.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const {
  buildSidebarLines,
  NOTIFY_LEVEL_COLOR,
} = require('../../../src/cli/tui/ink-components/SidebarPanel');

/** Find the notification header line index; -1 when the section is absent. */
function notifyHeaderIndex(lines) {
  return lines.findIndex((ln) => /^通知 \d+ 条$/.test(ln.text));
}

// ── 空/非法输入不渲染 ─────────────────────────────────────────────────────────
test('通知段落: 空数组 → 不渲染通知段落', () => {
  const lines = buildSidebarLines({ taskLines: [], notifications: [] });
  assert.equal(notifyHeaderIndex(lines), -1);
});

test('通知段落: 未传 notifications → 不渲染通知段落(既有行为不回归)', () => {
  const lines = buildSidebarLines({ taskLines: [] });
  assert.equal(notifyHeaderIndex(lines), -1);
});

test('通知段落: 非法输入(非数组/坏条目) → 不渲染通知段落', () => {
  const nonArray = buildSidebarLines({ taskLines: [], notifications: 'oops' });
  assert.equal(notifyHeaderIndex(nonArray), -1);
  const badEntries = buildSidebarLines({
    taskLines: [],
    notifications: [null, 42, { level: 'info', title: '', detail: '' }],
  });
  assert.equal(notifyHeaderIndex(badEntries), -1);
});

// ── 正常渲染 ─────────────────────────────────────────────────────────────────
const notifications = [
  { level: 'info', title: '后台任务完成', detail: 'build', timestamp: 1, count: 1 },
  { level: 'warn', title: '回合已取消', detail: '', timestamp: 2, count: 1 },
];

test('通知段落: 空行分隔 + bold 标题「通知 n 条」+ 每条一行', () => {
  const lines = buildSidebarLines({ taskLines: [], notifications });
  const hi = notifyHeaderIndex(lines);
  assert.ok(hi > 0, '存在通知头行');
  // Divider line above the header (section separator).
  assert.ok(/^─+$/.test(lines[hi - 1].text), `头行前应为分隔线: 「${lines[hi - 1].text}」`);
  assert.equal(lines[hi].text, '通知 2 条');
  assert.equal(lines[hi].bold, true);
  // One line per entry, in buffer order (oldest first).
  assert.equal(lines[hi + 1].text, '后台任务完成 · build');
  assert.equal(lines[hi + 2].text, '回合已取消');
  assert.equal(lines.length, hi + 3);
});

test('通知段落: detail 非空 → 文本为 `title · detail`;为空 → 仅 title', () => {
  const lines = buildSidebarLines({ taskLines: [], notifications });
  const hi = notifyHeaderIndex(lines);
  assert.ok(lines[hi + 1].text.includes(' · '));
  assert.ok(!lines[hi + 2].text.includes(' · '));
});

// ── level 配色映射 ──────────────────────────────────────────────────────────
test('通知段落: info→gray / warn→yellow / error→red(NOTIFY_LEVEL_COLOR 单一真源)', () => {
  assert.deepStrictEqual(NOTIFY_LEVEL_COLOR, { info: 'gray', warn: 'yellow', error: 'red' });
  const lines = buildSidebarLines({
    taskLines: [],
    notifications: [
      { level: 'info', title: 'i', timestamp: 1 },
      { level: 'warn', title: 'w', timestamp: 2 },
      { level: 'error', title: 'e', timestamp: 3 },
    ],
  });
  const hi = notifyHeaderIndex(lines);
  assert.equal(lines[hi + 1].color, NOTIFY_LEVEL_COLOR.info);
  assert.equal(lines[hi + 2].color, NOTIFY_LEVEL_COLOR.warn);
  assert.equal(lines[hi + 3].color, NOTIFY_LEVEL_COLOR.error);
});

test('通知段落: 未知 level → 按 info 配色降级(绝不抛错)', () => {
  const lines = buildSidebarLines({
    taskLines: [],
    notifications: [{ level: 'bogus', title: 'x', timestamp: 1 }],
  });
  const hi = notifyHeaderIndex(lines);
  assert.equal(lines[hi + 1].color, NOTIFY_LEVEL_COLOR.info);
});

// ── 合并条目与截断 ──────────────────────────────────────────────────────────
test('通知段落: 含 count 的合并条目文案原样渲染(count 由端口烘焙进 title)', () => {
  // Width 40 → innerW 38: wide enough that the merged copy is NOT truncated.
  const lines = buildSidebarLines({
    taskLines: [],
    width: 40,
    notifications: [
      { level: 'info', title: '后台任务完成（共 3 条）', detail: 'lint', timestamp: 9, count: 3 },
    ],
  });
  const hi = notifyHeaderIndex(lines);
  assert.equal(lines[hi].text, '通知 1 条');
  assert.equal(lines[hi + 1].text, '后台任务完成（共 3 条） · lint');
});

test('通知段落: 超宽文本经截断器处理(以 … 结尾且不超过内宽)', () => {
  const width = 20; // innerW = width - 2 = 18
  const longTitle = '一个非常非常非常非常长的通知标题超出看板宽度';
  const lines = buildSidebarLines({
    taskLines: [],
    width,
    notifications: [{ level: 'warn', title: longTitle, timestamp: 1 }],
  });
  const hi = notifyHeaderIndex(lines);
  const text = lines[hi + 1].text;
  assert.ok(text.endsWith('…'), `截断行应以 … 结尾: 「${text}」`);
  assert.ok(text.length < longTitle.length, '文本长度应短于原标题');
});
