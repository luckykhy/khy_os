'use strict';

/**
 * resumeAdvisor 相对时间标签 —— CC 后端口径对齐回归。
 *
 * 「不只显示对齐,更要 CC 显示背后的后端逻辑对齐」:启动发现横幅里的「N 分钟/小时/
 * 天前更新」其背后的取整算法必须就是 CC `formatRelativeTime` 那套 **Math.trunc 截断**
 * (绝不向上虚报),而不是旧的 `Math.round`(把 23h59m30s 报成「1 天前」、90s 报成
 * 「2 分钟前」)。本测试守护:
 *   1. 门控默认开:_ageLabel 走 ccFormat SSOT 的截断口径 + 周/月/年档。
 *   2. 门控关(KHY_CC_FORMAT=0):逐字节回退到旧的基于 ageMinutes 的 round 口径。
 *   3. formatStartupHint 端到端把 env + ageMs 串到 _ageLabel。
 *   4. 中文本地化保留(不被强行换成英文 "ago")。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _ageLabel, formatStartupHint } = require('../src/services/resumeAdvisor');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('门控默认开:CC 截断口径(23h59m30s → 23 小时前,绝不进位成 1 天前)', () => {
  const ageMs = 23 * HOUR + 59 * MIN + 30 * 1000;
  // legacy 的 ageMinutes 会 round 成 1440(=「1 天前」),这里证明 CC 口径不受其影响。
  assert.equal(_ageLabel(1440, {}, ageMs), '23 小时前');
});

test('门控默认开:90s → 1 分钟前(legacy round 会虚报成 2 分钟前)', () => {
  assert.equal(_ageLabel(2, {}, 90 * 1000), '1 分钟前');
});

test('门控默认开:<1 分钟 → 刚刚', () => {
  assert.equal(_ageLabel(1, {}, 30 * 1000), '刚刚');
  assert.equal(_ageLabel(0, {}, 0), '刚刚');
});

test('门控默认开:补齐周/月/年档(CC 完整区间表)', () => {
  assert.equal(_ageLabel(null, {}, 7 * DAY), '1 周前');
  assert.equal(_ageLabel(null, {}, 29 * DAY), '4 周前'); // trunc(29*86400/604800)=4
  assert.equal(_ageLabel(null, {}, 30 * DAY), '1 个月前');
  assert.equal(_ageLabel(null, {}, 400 * DAY), '1 年前');
});

test('门控关(KHY_CC_FORMAT=0):逐字节回退旧 round 口径', () => {
  const env = { KHY_CC_FORMAT: '0' };
  // 旧口径只认 ageMinutes:1440 → hours=24 → days=1 → 「1 天前」(即旧虚报行为,字节等价)。
  assert.equal(_ageLabel(1440, env, 23 * HOUR + 59 * MIN + 30 * 1000), '1 天前');
  assert.equal(_ageLabel(2, env, 90 * 1000), '2 分钟前');
  assert.equal(_ageLabel(0, env, 0), '刚刚');
  assert.equal(_ageLabel(90, env, null), '1 小时前'); // floor(90/60)=1
});

test('拿不到原始 ms(ageMs 缺省)→ 即使门控开也回退 legacy', () => {
  assert.equal(_ageLabel(90, {}), '1 小时前');       // floor(90/60)
  assert.equal(_ageLabel(1500, {}, null), '1 天前'); // floor(1500/60)=25h → floor(25/24)=1
});

test('formatStartupHint 端到端:env + ageMs 串到 _ageLabel(默认开)', () => {
  const pending = {
    taskId: 't1',
    userMessage: '构建内核',
    iterations: 3,
    status: 'in_progress',
    ageMs: 23 * HOUR + 59 * MIN + 30 * 1000,
    ageMinutes: 1440,
  };
  const hint = formatStartupHint(pending, { env: {} });
  assert.match(hint, /23 小时前更新/);
  assert.doesNotMatch(hint, /1 天前/);
});

test('formatStartupHint 端到端:门控关 → legacy「1 天前」', () => {
  const pending = {
    taskId: 't1', userMessage: '构建内核', iterations: 3, status: 'in_progress',
    ageMs: 23 * HOUR + 59 * MIN + 30 * 1000, ageMinutes: 1440,
  };
  const hint = formatStartupHint(pending, { env: { KHY_CC_FORMAT: '0' } });
  assert.match(hint, /1 天前更新/);
});

test('绝不抛:畸形输入安全降级', () => {
  assert.doesNotThrow(() => _ageLabel(null, {}, NaN));
  assert.doesNotThrow(() => _ageLabel(undefined, undefined, undefined));
  assert.equal(_ageLabel(null, {}, null), '');
});
