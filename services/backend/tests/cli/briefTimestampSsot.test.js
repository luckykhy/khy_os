'use strict';

// 对齐 CC「后端逻辑也对齐」:**按龄缩放细节的绝对时间戳**(消息标签风)单一真源。
// CC src/utils/formatBriefTimestamp.ts:同日 → 仅时间;6 日内 → 周几+时间;更久 →
// 周几+月日+时间。关键后端逻辑 = 档位由 **startOfDay 的日历日差**(Math.round)决定,
// 非流逝毫秒。Khy 的「最近 AI 请求」tail 列表(router.js / handlers/security.js)此前对
// 每条都 `new Date(t.startTime).toLocaleTimeString()` = **恒仅时间、不随龄升档**(昨天的
// 请求与今天的都显 "14:30" 无从区分)。本测试验证:门控 KHY_CC_FORMAT 开 → 走 ccFormat
// SSOT 按龄缩放(同日仅时间 / 跨日补周几 / 久补月日);关 → 逐字节回退旧 toLocaleTimeString()。
const test = require('node:test');
const assert = require('node:assert');

const {
  ccBriefTimestampScale,
  ccBriefTimestamp,
  ccBriefTimestampOr,
} = require('../../src/cli/ccFormat');

// 全部取**本地正午**构造,日历日差 = 精确天数,且远离午夜边界 → 跨时区稳定。
const NOON = (y, m0, d) => new Date(y, m0, d, 12, 0, 0).getTime();
const AT = (y, m0, d, h, min) => new Date(y, m0, d, h, min, 0).getTime();
const NOW = NOON(2026, 5, 20); // 2026-06-20 12:00 本地

// ── 档位判定(纯、确定性、无本地化)──────────────────────────────────────
test('ccBriefTimestampScale = CC daysAgo 档位梯(startOfDay 日历日差)', () => {
  assert.strictEqual(ccBriefTimestampScale(AT(2026, 5, 20, 9, 30), NOW), 'time');   // 同日
  assert.strictEqual(ccBriefTimestampScale(AT(2026, 5, 19, 14, 5), NOW), 'weekday'); // 1 日前
  assert.strictEqual(ccBriefTimestampScale(AT(2026, 5, 14, 14, 5), NOW), 'weekday'); // 6 日前(<7)
  assert.strictEqual(ccBriefTimestampScale(AT(2026, 5, 13, 14, 5), NOW), 'full');    // 7 日前(≥7)
  assert.strictEqual(ccBriefTimestampScale(AT(2026, 5, 10, 14, 5), NOW), 'full');    // 10 日前
  assert.strictEqual(ccBriefTimestampScale(AT(2026, 5, 21, 8, 0), NOW), 'full');     // 未来日 → full
  // 关键:跨日但绝对时差小也升档(昨天 23:00 vs 今天 01:00,相差 2h 却跨日)。
  assert.strictEqual(
    ccBriefTimestampScale(AT(2026, 5, 19, 23, 0), AT(2026, 5, 20, 1, 0)),
    'weekday',
  );
  assert.strictEqual(ccBriefTimestampScale(NaN, NOW), null);
  assert.strictEqual(ccBriefTimestampScale(NOW, Infinity), null);
});

// ── 渲染:档位 → zh-CN 串结构(同日无周几/月、跨日有周几、久有月)──────────
test('ccBriefTimestamp 按档渲染 zh-CN 结构(同日仅时间 / 跨日补周几 / 久补月日)', () => {
  const sameDay = ccBriefTimestamp(AT(2026, 5, 20, 9, 30), NOW);
  assert.ok(!/星期/.test(sameDay) && !/月/.test(sameDay), `同日应仅时间: ${sameDay}`);
  assert.ok(/\d/.test(sameDay), `同日应含时间数字: ${sameDay}`);

  const within = ccBriefTimestamp(AT(2026, 5, 17, 14, 5), NOW); // 3 日前
  assert.ok(/星期/.test(within) && !/月/.test(within), `周内应有周几无月: ${within}`);

  const older = ccBriefTimestamp(AT(2026, 5, 10, 14, 5), NOW); // 10 日前
  assert.ok(/月/.test(older) && /星期/.test(older), `更久应有月+周几: ${older}`);

  // 升档单调:更久的串比同日的串更长(细节更多)。
  assert.ok(older.length > sameDay.length, `升档应更详细: ${older} vs ${sameDay}`);

  assert.strictEqual(ccBriefTimestamp(NaN, NOW), ''); // 非有限 → 空串(绝不抛)
});

// ── 门控包装 ccBriefTimestampOr(call-site 用)──────────────────────────────
test('ccBriefTimestampOr 门控关 → legacy 串逐字节回退(忽略缩放)', () => {
  const older = AT(2026, 5, 10, 14, 5); // 10 日前,门控开本会升档
  assert.strictEqual(ccBriefTimestampOr(older, NOW, 'LEGACY-14:05:00', { KHY_CC_FORMAT: 'off' }), 'LEGACY-14:05:00');
  assert.strictEqual(ccBriefTimestampOr(older, NOW, 'LEGACY-14:05:00', { KHY_CC_FORMAT: '0' }), 'LEGACY-14:05:00');
});

test('ccBriefTimestampOr 门控开 → CC 缩放戳(老条目升档,≠ legacy)', () => {
  const older = AT(2026, 5, 10, 14, 5);
  const out = ccBriefTimestampOr(older, NOW, 'LEGACY-14:05:00', { KHY_CC_FORMAT: '1' });
  assert.notStrictEqual(out, 'LEGACY-14:05:00');
  assert.ok(/月/.test(out) && /星期/.test(out), `门控开老条目应升档: ${out}`);
  // 同日条目门控开仍仅时间(无周几/月)。
  const sameDay = ccBriefTimestampOr(AT(2026, 5, 20, 9, 30), NOW, 'LEGACY', { KHY_CC_FORMAT: '1' });
  assert.ok(!/星期/.test(sameDay) && !/月/.test(sameDay), `同日仍仅时间: ${sameDay}`);
});

test('ccBriefTimestampOr 非有限 target → legacy 兜底(SSOT 返 "" 不吞掉)', () => {
  assert.strictEqual(ccBriefTimestampOr(NaN, NOW, '原样', { KHY_CC_FORMAT: '1' }), '原样');
  assert.strictEqual(ccBriefTimestampOr(undefined, NOW, '原样', { KHY_CC_FORMAT: '1' }), '原样');
});

test('ccBriefTimestampOr 默认(无显式门控)= 开档行为', () => {
  const prev = process.env.KHY_CC_FORMAT;
  delete process.env.KHY_CC_FORMAT;
  try {
    const out = ccBriefTimestampOr(AT(2026, 5, 10, 14, 5), NOW, 'LEGACY');
    assert.ok(/月/.test(out), `默认应开档升档: ${out}`);
  } finally {
    if (prev === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = prev;
  }
});
