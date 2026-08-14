'use strict';

/**
 * protocolArbitration 纯叶子单测 —— 多协议冲突仲裁。
 *
 * 覆盖:
 *   · resolveArbitration 矩阵语义:mathSolve+laziness 同时生效 → 抑制 laziness(败者),
 *     保留 mathSolve(胜者),产出仲裁记录(winner/loser/axis/reason);
 *   · 只有其一生效 → 不抑制(需两者同时);
 *   · 无关协议 → 不抑制(不臆造冲突);
 *   · describe/arbitrate 门控:关(KHY_PROTOCOL_ARBITRATION ∈ {0,false,off,no})→ 空抑制
 *     (no-op,directiveComposer 逐字节回退);
 *   · buildArbitrationNotice:空数组 → 空串;有记录 → 含采用/弃用/理由,用 label 人话化;
 *   · 绝不抛(坏输入 → 安全默认)。
 *
 * node:test(非 jest)。运行:`node --test tests/services/protocolArbitration.test.js`。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const arb = require('../../src/services/protocolArbitration');

const ENV_KEYS = ['KHY_PROTOCOL_ARBITRATION', 'KHY_FLAG_REGISTRY'];
let _savedEnv;

beforeEach(() => {
  _savedEnv = {};
  for (const k of ENV_KEYS) _savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (_savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = _savedEnv[k];
  }
});

describe('resolveArbitration — 互斥矩阵语义', () => {
  test('mathSolve + laziness 同时生效 → 抑制 laziness,保留 mathSolve', () => {
    const r = arb.resolveArbitration(['mathSolve', 'laziness']);
    assert.strictEqual(r.suppressed.has('laziness'), true);
    assert.strictEqual(r.suppressed.has('mathSolve'), false);
    assert.strictEqual(r.arbitrations.length, 1);
    const a = r.arbitrations[0];
    assert.strictEqual(a.winner, 'mathSolve');
    assert.strictEqual(a.loser, 'laziness');
    assert.match(a.axis, /详略|长度/);
    assert.match(a.reason, /分步|正确性/);
  });

  test('顺序无关:laziness 先于 mathSolve 也抑制 laziness', () => {
    const r = arb.resolveArbitration(['laziness', 'mathSolve']);
    assert.strictEqual(r.suppressed.has('laziness'), true);
    assert.strictEqual(r.arbitrations[0].loser, 'laziness');
  });

  test('只有 mathSolve 生效(无对手)→ 不抑制', () => {
    const r = arb.resolveArbitration(['mathSolve']);
    assert.strictEqual(r.suppressed.size, 0);
    assert.strictEqual(r.arbitrations.length, 0);
  });

  test('只有 laziness 生效(无对手)→ 不抑制', () => {
    const r = arb.resolveArbitration(['laziness']);
    assert.strictEqual(r.suppressed.size, 0);
  });

  test('无关协议组合 → 绝不臆造冲突', () => {
    const r = arb.resolveArbitration(['testWriting', 'errorEnumeration', 'goal', 'clarification']);
    assert.strictEqual(r.suppressed.size, 0);
    assert.strictEqual(r.arbitrations.length, 0);
  });

  test('带无关协议 + 冲突对 → 只抑制败者,无关的不动', () => {
    const r = arb.resolveArbitration(['goal', 'mathSolve', 'testWriting', 'laziness']);
    assert.deepStrictEqual([...r.suppressed], ['laziness']);
  });

  test('缺参 / 坏输入 → 安全默认,绝不抛', () => {
    assert.doesNotThrow(() => arb.resolveArbitration());
    assert.doesNotThrow(() => arb.resolveArbitration(null));
    assert.doesNotThrow(() => arb.resolveArbitration([null, undefined, '', 42]));
    assert.strictEqual(arb.resolveArbitration([]).suppressed.size, 0);
  });
});

describe('arbitrate — 门控', () => {
  test('门控开(默认)→ 施加仲裁', () => {
    const r = arb.arbitrate(['mathSolve', 'laziness'], {});
    assert.strictEqual(r.suppressed.has('laziness'), true);
  });

  test('门控关(off/false/0/no,含大写)→ 空抑制(no-op,逐字节回退)', () => {
    for (const v of ['off', 'false', '0', 'no', 'OFF', 'False']) {
      const r = arb.arbitrate(['mathSolve', 'laziness'], { KHY_PROTOCOL_ARBITRATION: v });
      assert.strictEqual(r.suppressed.size, 0, `KHY_PROTOCOL_ARBITRATION=${v} 应空抑制`);
      assert.strictEqual(r.arbitrations.length, 0);
    }
  });

  test('门控其它值(true/1/未设)→ 视为开', () => {
    for (const env of [{}, { KHY_PROTOCOL_ARBITRATION: 'true' }, { KHY_PROTOCOL_ARBITRATION: '1' }]) {
      const r = arb.arbitrate(['mathSolve', 'laziness'], env);
      assert.strictEqual(r.suppressed.has('laziness'), true, `env=${JSON.stringify(env)}`);
    }
  });

  test('绝不抛:坏 env / 坏 input → 空抑制', () => {
    assert.doesNotThrow(() => arb.arbitrate(null, null));
    assert.doesNotThrow(() => arb.arbitrate(undefined, undefined));
  });
});

describe('buildArbitrationNotice — 显式弃用声明', () => {
  test('空数组 → 空串', () => {
    assert.strictEqual(arb.buildArbitrationNotice([]), '');
    assert.strictEqual(arb.buildArbitrationNotice(), '');
  });

  test('有记录 → 含采用 / 弃用 / 理由,label 人话化', () => {
    const { arbitrations } = arb.resolveArbitration(['mathSolve', 'laziness']);
    const labels = { mathSolve: '数学解题协议', laziness: '最小代码方法论(懒人阶梯)' };
    const notice = arb.buildArbitrationNotice(arbitrations, labels);
    assert.match(notice, /协议冲突仲裁/);
    assert.match(notice, /采用「数学解题协议」/);
    assert.match(notice, /弃用「最小代码方法论/);
    assert.match(notice, /不生效/);
  });

  test('缺 label 映射 → 回退 key 本身,不抛', () => {
    const { arbitrations } = arb.resolveArbitration(['mathSolve', 'laziness']);
    const notice = arb.buildArbitrationNotice(arbitrations);
    assert.match(notice, /mathSolve/);
    assert.match(notice, /laziness/);
  });
});

describe('MUTEX_PAIRS — 矩阵完整性(守卫)', () => {
  test('每对 winner 必是 keys 之一,keys 恰两元,axis/reason 非空', () => {
    for (const p of arb.MUTEX_PAIRS) {
      assert.strictEqual(Array.isArray(p.keys), true);
      assert.strictEqual(p.keys.length, 2);
      assert.ok(p.keys.includes(p.winner), `winner ${p.winner} 必是 keys 之一`);
      assert.ok(String(p.axis || '').trim().length > 0);
      assert.ok(String(p.reason || '').trim().length > 0);
    }
  });
});
