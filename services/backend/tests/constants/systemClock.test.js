'use strict';

/**
 * systemClock.test.js — 纯叶子「系统时间注入」契约(node:test,零 IO、确定性)。
 *
 * 验收要点:
 *  - 门控 isEnabled:未设/任意非关键字 → 开;0/false/off/no(含大小写/空白) → 关。
 *  - formatSystemClockLines 关闭态 = 历史单行 ` - Current date: YYYY-MM-DD`(byte-revert 锚)。
 *  - formatSystemClockLines 开启态:注入 (now, offsetMinutes, timeZone) → 与宿主时区无关的
 *    确定性富时间(日期 + 星期 + 时刻 + UTC 偏移 + IANA 时区 + ISO 8601)。
 *  - clockCacheKey:关 → '';开 → `t<bucket>`,同桶稳定、跨桶变化;桶粒度受门控控制。
 *  - fail-soft:坏 now 回退到「现在」不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const clock = require('../../src/constants/systemClock');

test('isEnabled 默认开;仅显式 0/false/off/no 关', () => {
  assert.equal(clock.isEnabled({}), true);
  assert.equal(clock.isEnabled({ KHY_SYSTEM_CLOCK: '1' }), true);
  assert.equal(clock.isEnabled({ KHY_SYSTEM_CLOCK: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(clock.isEnabled({ KHY_SYSTEM_CLOCK: v }), false, v);
  }
});

test('formatSystemClockLines 关闭态 = 历史单行(byte-revert)', () => {
  // 固定本地日期:用 offset 无关的 legacyDateLine 语义 —— 关闭态走本地 getter,
  // 故用一个本地已知的 Date。断言格式为 ` - Current date: YYYY-MM-DD` 单行。
  const now = new Date(2026, 6, 2, 14, 35, 42); // 本地 2026-07-02
  const lines = clock.formatSystemClockLines({ now, env: { KHY_SYSTEM_CLOCK: 'off' } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], ' - Current date: 2026-07-02');
  // 与 legacyDateLine 一致
  assert.equal(lines[0], clock.legacyDateLine(now));
});

test('formatSystemClockLines 开启态:注入 offset/tz → 宿主时区无关的确定性富时间', () => {
  // UTC 时刻 2026-07-02T06:35:42Z,注入 +480 分(UTC+8)→ 本地墙钟 14:35:42。
  const now = new Date(Date.UTC(2026, 6, 2, 6, 35, 42));
  const lines = clock.formatSystemClockLines({
    now,
    env: {},
    offsetMinutes: 480,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], ' - Current date: 2026-07-02 (Thursday)');
  assert.equal(lines[1], ' - Current time: 14:35:42 (UTC+08:00, Asia/Shanghai)');
  assert.equal(lines[2], ' - Current timestamp (ISO 8601): 2026-07-02T14:35:42+08:00');
});

test('formatSystemClockLines:负偏移(UTC-05:00)与无 tz 时省略 IANA', () => {
  // UTC 2026-01-01T00:30:00Z,注入 -300 分(UTC-5)→ 本地 2025-12-31 19:30:00,星期三。
  const now = new Date(Date.UTC(2026, 0, 1, 0, 30, 0));
  const lines = clock.formatSystemClockLines({ now, env: {}, offsetMinutes: -300, timeZone: '' });
  assert.equal(lines[0], ' - Current date: 2025-12-31 (Wednesday)');
  assert.equal(lines[1], ' - Current time: 19:30:00 (UTC-05:00)');
  assert.equal(lines[2], ' - Current timestamp (ISO 8601): 2025-12-31T19:30:00-05:00');
});

test('clockCacheKey:关 → \'\';开 → 同桶稳定、跨桶变化', () => {
  const t0 = new Date(Date.UTC(2026, 6, 2, 6, 0, 0));
  assert.equal(clock.clockCacheKey({ now: t0, env: { KHY_SYSTEM_CLOCK: 'off' } }), '');

  const env60 = { KHY_SYSTEM_CLOCK_BUCKET_SECONDS: '60' };
  const k0 = clock.clockCacheKey({ now: t0, env: env60 });
  const kSame = clock.clockCacheKey({ now: new Date(t0.getTime() + 59_000), env: env60 });
  const kNext = clock.clockCacheKey({ now: new Date(t0.getTime() + 61_000), env: env60 });
  assert.match(k0, /^t\d+$/);
  assert.equal(k0, kSame, '同一 60s 桶内 key 稳定');
  assert.notEqual(k0, kNext, '跨桶 key 变化');
});

test('clockCacheKey:桶粒度受 KHY_SYSTEM_CLOCK_BUCKET_SECONDS 控制', () => {
  const t0 = new Date(Date.UTC(2026, 6, 2, 6, 0, 0));
  // 3600s 桶:相隔 30 分钟仍同桶。
  const env = { KHY_SYSTEM_CLOCK_BUCKET_SECONDS: '3600' };
  const a = clock.clockCacheKey({ now: t0, env });
  const b = clock.clockCacheKey({ now: new Date(t0.getTime() + 30 * 60_000), env });
  assert.equal(a, b);
});

test('fail-soft:坏 now 回退不抛;缺 env 用 process.env', () => {
  assert.doesNotThrow(() => clock.formatSystemClockLines({ now: new Date('not-a-date'), env: {} }));
  const lines = clock.formatSystemClockLines({ now: NaN, env: {} });
  assert.ok(Array.isArray(lines) && lines.length >= 1);
  assert.doesNotThrow(() => clock.formatSystemClockLines());
  assert.doesNotThrow(() => clock.clockCacheKey());
});
