'use strict';

// 固定 TZ=UTC 使 toLocaleString 的分钟/年判定确定(在任何 Date 构造前设置)。
// 档位判定 ccResetTimeScale 是纯 ms 数学、与 TZ 无关;渲染层的结构断言(有无「月」、
// 有无年份、整点省分钟)在 UTC 下稳定。
process.env.TZ = 'UTC';

// ccFormatResetTime SSOT 契约测试 — 纯叶子(配额重置时刻人读化)。
// 对齐 CC src/utils/format.ts formatResetTime:>24h 补月日 / ≤24h 仅时间 /
// 整点省分钟 / 跨年补年 / am-pm 小写 strip。零 IO 零网络。
const test = require('node:test');
const assert = require('node:assert');

const {
  ccResetTimeScale,
  ccFormatResetTime,
  ccFormatResetTimeOr,
} = require('../../src/cli/ccFormat');

// 本地时间构造(TZ=UTC 已钉 → 本地即 UTC)。
const AT = (y, m0, d, h, min) => new Date(y, m0, d, h, min, 0).getTime();
const NOW = AT(2026, 6, 1, 12, 0); // 2026-07-01 12:00 UTC

// ── 档位判定(纯 ms 数学,TZ 无关)────────────────────────────────────────
test('ccResetTimeScale = CC 的 >24h→datetime / ≤24h→time 阈值', () => {
  // 距重置 47 分钟(同小时内)→ time
  assert.strictEqual(ccResetTimeScale(AT(2026, 6, 1, 12, 47), NOW), 'time');
  // 距重置 23h → time(<24h)
  assert.strictEqual(ccResetTimeScale(AT(2026, 6, 2, 11, 0), NOW), 'time');
  // 距重置 25h → datetime(>24h)
  assert.strictEqual(ccResetTimeScale(AT(2026, 6, 2, 13, 0), NOW), 'datetime');
  // 已过去(负)→ time(不 >24h)
  assert.strictEqual(ccResetTimeScale(AT(2026, 5, 30, 12, 0), NOW), 'time');
  // 边界:恰 24h → 非 >24 → time
  assert.strictEqual(ccResetTimeScale(NOW + 24 * 3600000, NOW), 'time');
  // 边界:24h + 1ms → datetime
  assert.strictEqual(ccResetTimeScale(NOW + 24 * 3600000 + 1, NOW), 'datetime');
  // 非有限 → null(绝不抛)
  assert.strictEqual(ccResetTimeScale(NaN, NOW), null);
  assert.strictEqual(ccResetTimeScale(NOW, Infinity), null);
});

// ── 渲染:时间-only vs 日期+时间 结构差异 ────────────────────────────────
test('ccFormatResetTime:≤24h 仅时间(无「月」);>24h 补月日(有「月」)', () => {
  const near = ccFormatResetTime(AT(2026, 6, 1, 15, 30), NOW); // 3.5h 后 → time
  assert.ok(!/月/.test(near), `近重置应仅时间无月: ${near}`);
  assert.ok(/\d/.test(near), `应含时间数字: ${near}`);

  const far = ccFormatResetTime(AT(2026, 6, 3, 15, 30), NOW); // 2 天后 → datetime
  assert.ok(/月/.test(far), `远重置应补月日: ${far}`);
  assert.ok(far.length > near.length, `datetime 档应更详细: ${far} vs ${near}`);
});

test('ccFormatResetTime:同年不补年;跨年补 4 位年份', () => {
  const sameYear = ccFormatResetTime(AT(2026, 6, 3, 9, 0), NOW); // 2026 内、>24h
  assert.ok(!/\d{4}/.test(sameYear), `同年不应含 4 位年: ${sameYear}`);

  const nextYear = ccFormatResetTime(AT(2027, 0, 5, 9, 0), NOW); // 2027、远 → 补年
  assert.ok(/2027/.test(nextYear), `跨年应补年份: ${nextYear}`);
});

test('ccFormatResetTime:整点省分钟(:00 比 :30 短)', () => {
  const onHour = ccFormatResetTime(AT(2026, 6, 1, 15, 0), NOW); // 整点
  const halfHour = ccFormatResetTime(AT(2026, 6, 1, 15, 30), NOW); // :30
  assert.ok(halfHour.length > onHour.length, `整点应省分钟: on='${onHour}' half='${halfHour}'`);
});

test('ccFormatResetTime:am/pm strip 对 en-US call-site 生效(小写、无空格)', () => {
  // 传入 en-US → 12 小时 + AM/PM;strip 后小写无空格。TZ=UTC 下 15:30 → 3:30 pm。
  const s = ccFormatResetTime(AT(2026, 6, 1, 15, 30), NOW, { locale: 'en-US' });
  assert.ok(/pm/.test(s), `en-US 下午应含 pm: ${s}`);
  assert.ok(!/ (AM|PM)/.test(s), `不应保留空格+大写 AM/PM: ${s}`);
});

test('ccFormatResetTime:timezoneLabel 存在则追加括号标签', () => {
  const s = ccFormatResetTime(AT(2026, 6, 1, 15, 30), NOW, { timezoneLabel: 'UTC' });
  assert.ok(/\(UTC\)$/.test(s), `应以 (UTC) 结尾: ${s}`);
});

test('ccFormatResetTime:非有限 → 空串(绝不抛)', () => {
  assert.strictEqual(ccFormatResetTime(NaN, NOW), '');
  assert.strictEqual(ccFormatResetTime(NOW, Infinity), '');
  assert.doesNotThrow(() => ccFormatResetTime(undefined, undefined));
});

// ── 门控包装 ccFormatResetTimeOr(call-site 用,入参 unix 秒)────────────────
test('ccFormatResetTimeOr:门控关 → legacy 逐字节回退', () => {
  const sec = Math.floor(AT(2026, 6, 1, 15, 30) / 1000);
  assert.strictEqual(
    ccFormatResetTimeOr(sec, NOW, 'LEGACY-UTC', { KHY_CC_FORMAT: 'off' }),
    'LEGACY-UTC',
  );
  assert.strictEqual(
    ccFormatResetTimeOr(sec, NOW, 'LEGACY-UTC', { KHY_CC_FORMAT: '0' }),
    'LEGACY-UTC',
  );
});

test('ccFormatResetTimeOr:门控开 + 有效秒 → CC 口径(≠ legacy)', () => {
  const sec = Math.floor(AT(2026, 6, 1, 15, 30) / 1000);
  const out = ccFormatResetTimeOr(sec, NOW, 'LEGACY-UTC', { KHY_CC_FORMAT: '1' });
  assert.notStrictEqual(out, 'LEGACY-UTC');
  assert.ok(/\d/.test(out), `应为人读时刻: ${out}`);
});

test('ccFormatResetTimeOr:非有限 / sec<=0 → legacy 兜底', () => {
  assert.strictEqual(ccFormatResetTimeOr(NaN, NOW, '原样', { KHY_CC_FORMAT: '1' }), '原样');
  assert.strictEqual(ccFormatResetTimeOr(0, NOW, '原样', { KHY_CC_FORMAT: '1' }), '原样');
  assert.strictEqual(ccFormatResetTimeOr(-5, NOW, '原样', { KHY_CC_FORMAT: '1' }), '原样');
  assert.strictEqual(ccFormatResetTimeOr(undefined, NOW, '原样', { KHY_CC_FORMAT: '1' }), '原样');
});
