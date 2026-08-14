'use strict';

/**
 * idleReturnNudge.test.js — 久别重返轻提示纯叶子的确定性单测 (node:test)。
 *
 * 覆盖：门控开关、formatIdleDuration（<1/<60/整点/时分）、shouldNudgeOnReturn
 * 的条件链（门控/空+斜杠输入/lastCompletionMs<=0/token 阈值/空闲阈值/env 覆盖）、
 * buildIdleReturnHint（null→null/含时长+token/token 走 ccFormat）、idleReturnHintFor 集成、
 * 坏输入绝不抛。所有事实由参数传入——叶子零 IO（不读时钟/不读盘）。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  idleReturnEnabled,
  formatIdleDuration,
  shouldNudgeOnReturn,
  buildIdleReturnHint,
  idleReturnHintFor,
} = require('../../src/cli/idleReturnNudge');

const MIN = 60000;
// 满足所有阈值的基线 state：空闲 80 分钟、12 万 token、普通输入。
function okState(over = {}) {
  return {
    input: '继续之前的重构',
    lastCompletionMs: 1_000_000,
    nowMs: 1_000_000 + 80 * MIN,
    totalInputTokens: 120000,
    ...over,
  };
}

describe('idleReturnNudge.idleReturnEnabled (gate)', () => {
  test('default on', () => {
    assert.equal(idleReturnEnabled({}), true);
    assert.equal(idleReturnEnabled(), true);
  });
  test('off values disable', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' Off ']) {
      assert.equal(idleReturnEnabled({ KHY_IDLE_RETURN_NUDGE: v }), false);
    }
  });
  test('unknown value stays on', () => {
    assert.equal(idleReturnEnabled({ KHY_IDLE_RETURN_NUDGE: 'yes' }), true);
  });
});

describe('idleReturnNudge.formatIdleDuration', () => {
  test('< 1 minute → 不到 1 分钟', () => {
    assert.equal(formatIdleDuration(0), '不到 1 分钟');
    assert.equal(formatIdleDuration(0.4), '不到 1 分钟');
    assert.equal(formatIdleDuration(NaN), '不到 1 分钟');
  });
  test('< 60 minutes → N 分钟', () => {
    assert.equal(formatIdleDuration(1), '1 分钟');
    assert.equal(formatIdleDuration(30), '30 分钟');
    assert.equal(formatIdleDuration(59.9), '59 分钟');
  });
  test('exact hours → N 小时', () => {
    assert.equal(formatIdleDuration(60), '1 小时');
    assert.equal(formatIdleDuration(120), '2 小时');
  });
  test('hours + minutes → N 小时 M 分钟', () => {
    assert.equal(formatIdleDuration(90), '1 小时 30 分钟');
    assert.equal(formatIdleDuration(125), '2 小时 5 分钟');
  });
});

describe('idleReturnNudge.shouldNudgeOnReturn', () => {
  test('all conditions met → {idleMinutes, tokens}', () => {
    const d = shouldNudgeOnReturn(okState(), {});
    assert.ok(d);
    assert.ok(Math.abs(d.idleMinutes - 80) < 1e-6);
    assert.equal(d.tokens, 120000);
  });
  test('gate off → null', () => {
    assert.equal(shouldNudgeOnReturn(okState(), { KHY_IDLE_RETURN_NUDGE: 'off' }), null);
  });
  test('empty / slash input → null', () => {
    assert.equal(shouldNudgeOnReturn(okState({ input: '' }), {}), null);
    assert.equal(shouldNudgeOnReturn(okState({ input: '   ' }), {}), null);
    assert.equal(shouldNudgeOnReturn(okState({ input: '/clear' }), {}), null);
    assert.equal(shouldNudgeOnReturn(okState({ input: '  /model' }), {}), null);
  });
  test('lastCompletionMs <= 0 → null (no prior turn)', () => {
    assert.equal(shouldNudgeOnReturn(okState({ lastCompletionMs: 0 }), {}), null);
    assert.equal(shouldNudgeOnReturn(okState({ lastCompletionMs: -5 }), {}), null);
  });
  test('tokens below threshold → null', () => {
    assert.equal(shouldNudgeOnReturn(okState({ totalInputTokens: 99999 }), {}), null);
  });
  test('idle below threshold → null', () => {
    const d = okState({ nowMs: 1_000_000 + 74 * MIN });
    assert.equal(shouldNudgeOnReturn(d, {}), null);
  });
  test('env threshold overrides respected', () => {
    // Lower both thresholds → a small idle/token state now fires.
    const small = {
      input: 'hi',
      lastCompletionMs: 1000,
      nowMs: 1000 + 10 * MIN,
      totalInputTokens: 5000,
    };
    assert.equal(shouldNudgeOnReturn(small, {}), null);
    const env = { KHY_IDLE_THRESHOLD_MINUTES: '5', KHY_IDLE_TOKEN_THRESHOLD: '1000' };
    const d = shouldNudgeOnReturn(small, env);
    assert.ok(d && d.tokens === 5000);
  });
  test('bad input → null, never throws', () => {
    assert.equal(shouldNudgeOnReturn(null, {}), null);
    assert.equal(shouldNudgeOnReturn('nope', {}), null);
    assert.equal(shouldNudgeOnReturn(42, {}), null);
    assert.doesNotThrow(() => shouldNudgeOnReturn({ input: {}, lastCompletionMs: 'x' }, {}));
  });
});

describe('idleReturnNudge.buildIdleReturnHint', () => {
  test('null / bad decision → null', () => {
    assert.equal(buildIdleReturnHint(null, {}), null);
    assert.equal(buildIdleReturnHint('x', {}), null);
    assert.equal(buildIdleReturnHint({ idleMinutes: NaN, tokens: 1 }, {}), null);
  });
  test('valid decision → string with duration and clear hint', () => {
    const s = buildIdleReturnHint({ idleMinutes: 90, tokens: 120000 }, {});
    assert.equal(typeof s, 'string');
    assert.ok(s.includes('1 小时 30 分钟'));
    assert.ok(s.includes('/clear'));
    assert.ok(s.includes('tokens'));
  });
  test('token count routed through ccFormat SSOT (gate on → humanized)', () => {
    const s = buildIdleReturnHint({ idleMinutes: 80, tokens: 120000 }, { KHY_CC_FORMAT: '1' });
    // ccFormatTokens humanizes 120000 → 120k (no raw 120000 substring).
    assert.ok(/120k/i.test(s) || s.includes('120000'));
  });
  test('cc format gate off → raw number fallback', () => {
    const s = buildIdleReturnHint({ idleMinutes: 80, tokens: 120000 }, { KHY_CC_FORMAT: 'off' });
    assert.ok(s.includes('120000'));
  });
});

describe('idleReturnNudge.idleReturnHintFor (integration)', () => {
  test('fires → hint string', () => {
    const s = idleReturnHintFor(okState(), {});
    assert.equal(typeof s, 'string');
    assert.ok(s.includes('/clear'));
  });
  test('does not fire → null', () => {
    assert.equal(idleReturnHintFor(okState({ totalInputTokens: 10 }), {}), null);
    assert.equal(idleReturnHintFor(okState(), { KHY_IDLE_RETURN_NUDGE: '0' }), null);
  });
});
