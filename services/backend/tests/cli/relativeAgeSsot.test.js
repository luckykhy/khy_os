'use strict';

// 对齐 CC「后端逻辑也对齐」:毫秒龄差 → 人类可读「多久以前」的**单一真源收敛**。
// CC src/utils/format.ts `formatRelativeTime` 用 **Math.trunc 截断**(绝不进位)+ 完整
// year→second 区间表。router.js 的「可恢复任务检查点」列表此前用 `Math.round(ageMs/60000)`
// 算分钟数(向上虚报:90s→"2m",且无单位升档:3 天显成 "4320m")。本测试验证:门控
// KHY_CC_FORMAT 开时 router `_ccTaskAge` 复用 ccFormat SSOT(经 resumeAdvisor `_ageLabel`)
// 给 CC 截断口径 + 周/天/小时/分钟升档的中文标签;门控关时逐字节回退旧的「Nm 前」串。
const test = require('node:test');
const assert = require('node:assert');

const { _ccTaskAge } = require('../../src/cli/router');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function withGate(val, fn) {
  const prev = process.env.KHY_CC_FORMAT;
  if (val === undefined) delete process.env.KHY_CC_FORMAT;
  else process.env.KHY_CC_FORMAT = val;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = prev;
  }
}

// legacy 串构造器:复刻 router 旧口径 `${Math.round(ageMs/60000)}m 前`。
const legacyOf = (ageMs) => `${Math.round(ageMs / 60000)}m 前`;

// ── 门控开:CC Math.trunc 截断 + 单位升档(忽略 legacy)─────────────────
test('_ccTaskAge 门控开 = CC 截断口径中文标签(修掉 round 虚报 + 单位升档)', () => {
  withGate('1', () => {
    // 90s:旧 round(1.5)=2 → "2m 前"(虚报);CC trunc → "1 分钟前"。
    assert.strictEqual(_ccTaskAge(90 * 1000, legacyOf(90 * 1000)), '1 分钟前');
    // 23h59m:旧 → "1439m 前"(无升档);CC → "23 小时前"。
    assert.strictEqual(_ccTaskAge(23 * HOUR + 59 * MIN, legacyOf(23 * HOUR + 59 * MIN)), '23 小时前');
    // 3 天:旧 → "4320m 前";CC → "3 天前"。
    assert.strictEqual(_ccTaskAge(3 * DAY, legacyOf(3 * DAY)), '3 天前');
    // 1 周:CC → "1 周前"。
    assert.strictEqual(_ccTaskAge(WEEK, legacyOf(WEEK)), '1 周前');
    // <1s:CC second 档 → "刚刚"(无数字)。
    assert.strictEqual(_ccTaskAge(500, legacyOf(500)), '刚刚');
    // 整分钟:5 分钟 → "5 分钟前"。
    assert.strictEqual(_ccTaskAge(5 * MIN, legacyOf(5 * MIN)), '5 分钟前');
  });
});

// ── 门控关:逐字节回退到 router 旧的「Nm 前」串 ──────────────────────────
test('_ccTaskAge 门控关 = 旧「Nm 前」串逐字节回退', () => {
  withGate('off', () => {
    assert.strictEqual(_ccTaskAge(90 * 1000, legacyOf(90 * 1000)), '2m 前'); // round(1.5)=2
    assert.strictEqual(_ccTaskAge(3 * DAY, legacyOf(3 * DAY)), '4320m 前');
    assert.strictEqual(_ccTaskAge(5 * MIN, legacyOf(5 * MIN)), '5m 前');
  });
});

// ── 边界:非有限 ageMs → legacy 兜底(绝不抛、绝不空串)──────────────────
test('_ccTaskAge 非有限 ageMs → legacy 兜底', () => {
  withGate('1', () => {
    assert.strictEqual(_ccTaskAge(NaN, '原样'), '原样');
    assert.strictEqual(_ccTaskAge(undefined, '原样'), '原样');
    assert.strictEqual(_ccTaskAge(Infinity, '原样'), '原样');
  });
});

// ── 默认(无显式门控)= 开档行为(CC 口径)──────────────────────────────
test('_ccTaskAge 默认(无门控)= 开档(CC 截断口径)', () => {
  withGate(undefined, () => {
    assert.strictEqual(_ccTaskAge(90 * 1000, legacyOf(90 * 1000)), '1 分钟前');
    assert.strictEqual(_ccTaskAge(3 * DAY, legacyOf(3 * DAY)), '3 天前');
  });
});
