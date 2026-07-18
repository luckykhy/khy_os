'use strict';

/**
 * session handler `_relativeTime` —— CC 后端口径对齐回归。
 *
 * `khy session list` / detail 里的「N 条 · Xh ago」其相对时间走 ccFormat SSOT 的
 * ccRelativeAgeParts(CC `formatRelativeTime` 的 Math.trunc 截断 + 完整区间表)。旧本地
 * 实现已用 floor(截断对了),但缺 week 档;走 SSOT 后补上 week(7–29 天 → "Nw ago"),
 * 并保留「很旧会话 → 绝对日期」的既有产品选择(month/year 档落回 toLocaleDateString)。
 * 守护:
 *   1. 门控默认开:7d12h → "1w ago"(新增 week 档)。
 *   2. 门控关:逐字节回退旧 floor 口径(7d12h → "7d ago",无 week)。
 *   3. 截断一致性:5h30m → "5h ago"(两态相同)。
 *   4. 未来 / 未知 / 很旧(绝对日期)边界保持。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _relativeTime } = require('../src/cli/handlers/session');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ago = (ms) => Date.now() - ms;

test('门控默认开:7d12h → "1w ago"(CC week 档)', () => {
  assert.equal(_relativeTime(ago(7 * DAY + 12 * HOUR), {}), '1w ago');
});

test('门控默认开:29d → "4w ago"(trunc(29*86400/604800)=4)', () => {
  assert.equal(_relativeTime(ago(29 * DAY + HOUR), {}), '4w ago');
});

test('门控关(KHY_CC_FORMAT=0):逐字节回退旧 floor 口径(无 week 档)', () => {
  const env = { KHY_CC_FORMAT: '0' };
  assert.equal(_relativeTime(ago(7 * DAY + 12 * HOUR), env), '7d ago');
  assert.equal(_relativeTime(ago(29 * DAY + HOUR), env), '29d ago');
});

test('截断一致性:5h30m → "5h ago"(两态相同,floor=trunc)', () => {
  assert.equal(_relativeTime(ago(5 * HOUR + 30 * MIN), {}), '5h ago');
  assert.equal(_relativeTime(ago(5 * HOUR + 30 * MIN), { KHY_CC_FORMAT: '0' }), '5h ago');
});

test('分钟 / 天档两态一致', () => {
  assert.equal(_relativeTime(ago(5 * MIN + 30 * 1000), {}), '5m ago');       // trunc(5.5)=5
  assert.equal(_relativeTime(ago(3 * DAY + 5 * HOUR), {}), '3d ago');
});

test('未来 → "just now";未知(ts=0)→ "unknown"', () => {
  assert.equal(_relativeTime(Date.now() + 10 * HOUR, {}), 'just now');
  assert.equal(_relativeTime(0, {}), 'unknown');
  assert.equal(_relativeTime(null, {}), 'unknown');
});

test('很旧会话(>30 天)→ 绝对日期(month/year 档回退,两态一致)', () => {
  const old = ago(40 * DAY);
  for (const env of [{}, { KHY_CC_FORMAT: '0' }]) {
    const out = _relativeTime(old, env);
    assert.doesNotMatch(out, /ago/, `env=${JSON.stringify(env)} 应是绝对日期非「ago」`);
    assert.match(out, /\d/, '应含日期数字');
  }
});

test('绝不抛:畸形输入安全降级', () => {
  assert.doesNotThrow(() => _relativeTime('abc', {}));
  assert.doesNotThrow(() => _relativeTime(undefined, undefined));
});
