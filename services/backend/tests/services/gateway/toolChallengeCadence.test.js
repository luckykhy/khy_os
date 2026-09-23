'use strict';

/**
 * toolChallengeCadence.test.js — 「每 N 次请求放行一次原生挑战」的节流器不变量。
 *
 * 这个节流器存在的唯一目的:让一个**被误判为 text 的模型**还有机会用原生调用翻案,
 * 而不是只能等 7 天 TTL(见 BUG-014)。所以它的不变量都是「偏保守」方向的:
 * 配置错了不能退化成「每次都挑战」,身份不明不挑战,任何异常都不改变 wire。
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const cadence = require('../../../src/services/gateway/toolChallengeCadence');

beforeEach(() => {
  cadence._reset();
});

describe('isEnabled — 门控 KHY_TOOL_CAP_CHALLENGE（默认开）', () => {
  test('unset → ON', () => {
    assert.equal(cadence.isEnabled({}), true);
  });
  test('falsy → OFF（大小写/空白不敏感）', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', '  false ', 'No']) {
      assert.equal(cadence.isEnabled({ KHY_TOOL_CAP_CHALLENGE: v }), false, `"${v}"`);
    }
  });
  test('其他值 → ON', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
      assert.equal(cadence.isEnabled({ KHY_TOOL_CAP_CHALLENGE: v }), true);
    }
  });
});

describe('everyRequests — 间隔（配置错误不得退化成「每次都挑战」）', () => {
  test('默认 10', () => {
    assert.equal(cadence.everyRequests({}), cadence.DEFAULT_EVERY);
    assert.equal(cadence.everyRequests({}), 10);
  });
  test('显式值生效', () => {
    assert.equal(cadence.everyRequests({ KHY_TOOL_CAP_CHALLENGE_EVERY: '3' }), 3);
    assert.equal(cadence.everyRequests({ KHY_TOOL_CAP_CHALLENGE_EVERY: ' 50 ' }), 50);
  });
  test('小于下限 / 非法 / 垃圾值 → 回落默认（不变成每 1 次都挑战）', () => {
    for (const v of ['1', '0', '-5', 'abc', '', 'NaN']) {
      const got = cadence.everyRequests({ KHY_TOOL_CAP_CHALLENGE_EVERY: v });
      assert.equal(got, cadence.DEFAULT_EVERY, `"${v}" 应回落默认`);
      assert.ok(got >= cadence.MIN_EVERY);
    }
  });

  test('小数点按 parseInt 截断（与同族数值 env 的既有语义一致，不为它另立一套）', () => {
    assert.equal(cadence.everyRequests({ KHY_TOOL_CAP_CHALLENGE_EVERY: '2.9' }), 2);
    // 截断后仍受下限保护:0.9 → 0 → 回落默认
    assert.equal(cadence.everyRequests({ KHY_TOOL_CAP_CHALLENGE_EVERY: '0.9' }), cadence.DEFAULT_EVERY);
  });
});

describe('decideChallenge — 纯判定', () => {
  test('第 N 次挑战，其余不挑战', () => {
    assert.equal(cadence.decideChallenge(10, 10), true);
    assert.equal(cadence.decideChallenge(20, 10), true);
    assert.equal(cadence.decideChallenge(9, 10), false);
    assert.equal(cadence.decideChallenge(1, 10), false);
  });
  test('enabled=false → 永不挑战', () => {
    assert.equal(cadence.decideChallenge(10, 10, { enabled: false }), false);
  });
  test('非法输入 → false（偏保守方向）', () => {
    for (const [n, e] of [
      [0, 10],
      [-1, 10],
      [NaN, 10],
      [10, NaN],
      [10, 1],
      [10, 0],
    ]) {
      assert.equal(cadence.decideChallenge(n, e), false, `n=${n} e=${e}`);
    }
  });
});

describe('shouldChallenge — 计数 + 门控 + fail-safe', () => {
  test('按 key 独立计数：互不干扰', () => {
    const env = { KHY_TOOL_CAP_CHALLENGE_EVERY: '3' };
    const a = [];
    const b = [];
    for (let i = 0; i < 3; i++) {
      a.push(cadence.shouldChallenge('route-a', env));
      b.push(cadence.shouldChallenge('route-b', env));
    }
    assert.deepEqual(a, [false, false, true]);
    assert.deepEqual(b, [false, false, true]);
  });

  test('每 N 次恰好挑战一次（N=4，前 12 次）', () => {
    const env = { KHY_TOOL_CAP_CHALLENGE_EVERY: '4' };
    const hits = [];
    for (let i = 1; i <= 12; i++) {
      if (cadence.shouldChallenge('r', env)) hits.push(i);
    }
    assert.deepEqual(hits, [4, 8, 12]);
  });

  test('空/缺失 key → 不计数、不挑战（身份不明就别动 wire）', () => {
    for (const k of ['', null, undefined, '   ']) {
      assert.equal(cadence.shouldChallenge(k, {}), false);
    }
  });

  test('门控关 → 不挑战，也不该被误当成挑战', () => {
    const env = { KHY_TOOL_CAP_CHALLENGE: '0', KHY_TOOL_CAP_CHALLENGE_EVERY: '2' };
    for (let i = 0; i < 5; i++) {
      assert.equal(cadence.shouldChallenge('r', env), false);
    }
  });

  test('key 大小写/空白归一（同一通道不会因写法不同各记一份）', () => {
    const env = { KHY_TOOL_CAP_CHALLENGE_EVERY: '2' };
    assert.equal(cadence.shouldChallenge('  Route-X  ', env), false);
    assert.equal(cadence.shouldChallenge('route-x', env), true, '第二次应命中同一计数器');
  });

  test('绝不抛：junk key 不抛', () => {
    for (const k of [42, {}, [], () => {}, Symbol('x')]) {
      assert.doesNotThrow(() => cadence.shouldChallenge(k, {}));
    }
  });
});
