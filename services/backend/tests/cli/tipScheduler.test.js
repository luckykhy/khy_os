'use strict';

/**
 * tipScheduler.test.js — 启动轮换提示纯叶子的确定性单测 (node:test)。
 *
 * 覆盖：门控开关、getSessionsSinceLastShown（缺失→Infinity/存在→差）、
 * getRelevantTips（cooldownSessions 冷却过滤 + isRelevant 相关性过滤）、
 * selectTipWithLongestTimeSinceShown（0/1/N 排序、全 Infinity 稳定取首）、
 * selectStartupTip 集成、坏输入 → null、绝不抛、TIPS 注册表形状合法。
 * 所有事实由参数传入——叶子零 IO。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TIPS,
  tipsEnabled,
  getSessionsSinceLastShown,
  getRelevantTips,
  selectTipWithLongestTimeSinceShown,
  selectStartupTip,
} = require('../../src/services/tipScheduler');

describe('tipScheduler.tipsEnabled (gate)', () => {
  test('default on', () => {
    assert.equal(tipsEnabled({}), true);
    assert.equal(tipsEnabled(), true);
  });
  test('off values disable', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' Off ']) {
      assert.equal(tipsEnabled({ KHY_STARTUP_TIPS: v }), false);
    }
  });
  test('unknown value stays on', () => {
    assert.equal(tipsEnabled({ KHY_STARTUP_TIPS: 'yes' }), true);
    assert.equal(tipsEnabled({ KHY_STARTUP_TIPS: '1' }), true);
  });
});

describe('tipScheduler.getSessionsSinceLastShown', () => {
  test('never shown → Infinity', () => {
    assert.equal(getSessionsSinceLastShown('x', {}, 5), Infinity);
    assert.equal(getSessionsSinceLastShown('x', { y: 2 }, 5), Infinity);
    assert.equal(getSessionsSinceLastShown('x', null, 5), Infinity);
  });
  test('shown → numStartups - lastShown', () => {
    assert.equal(getSessionsSinceLastShown('x', { x: 2 }, 5), 3);
    assert.equal(getSessionsSinceLastShown('x', { x: 5 }, 5), 0);
    assert.equal(getSessionsSinceLastShown('x', { x: 7 }, 5), -2);
  });
  test('non-finite lastShown → Infinity', () => {
    assert.equal(getSessionsSinceLastShown('x', { x: 'bad' }, 5), Infinity);
    assert.equal(getSessionsSinceLastShown('x', { x: null }, 5), Infinity);
  });
});

describe('tipScheduler.getRelevantTips', () => {
  const tips = [
    { id: 'a', text: 'A', cooldownSessions: 3 },
    { id: 'b', text: 'B', cooldownSessions: 0 },
    { id: 'c', text: 'C', cooldownSessions: 5, isRelevant: (ctx) => ctx.numStartups < 10 },
  ];
  test('cooldown filters out recently-shown', () => {
    // a shown 1 session ago (< cooldown 3) → excluded; b cooldown 0 → always in;
    // c shown never → in (Infinity >= 5) and relevant (numStartups 4 < 10).
    const out = getRelevantTips(tips, { a: 3 }, 4, { numStartups: 4 });
    const ids = out.map((t) => t.id);
    assert.ok(!ids.includes('a'));
    assert.ok(ids.includes('b'));
    assert.ok(ids.includes('c'));
  });
  test('isRelevant false removes tip regardless of cooldown', () => {
    const out = getRelevantTips(tips, {}, 20, { numStartups: 20 });
    const ids = out.map((t) => t.id);
    assert.ok(!ids.includes('c')); // 20 < 10 false
    assert.ok(ids.includes('a'));
    assert.ok(ids.includes('b'));
  });
  test('skips malformed tip entries', () => {
    const out = getRelevantTips(
      [null, {}, { id: 'ok', text: 'OK', cooldownSessions: 0 }, { id: 'noText' }],
      {},
      1,
      {},
    );
    assert.deepEqual(out.map((t) => t.id), ['ok']);
  });
  test('isRelevant throwing → treated as not relevant (never throws)', () => {
    const out = getRelevantTips(
      [{ id: 'boom', text: 'X', cooldownSessions: 0, isRelevant: () => { throw new Error('x'); } }],
      {},
      1,
      {},
    );
    assert.deepEqual(out, []);
  });
});

describe('tipScheduler.selectTipWithLongestTimeSinceShown', () => {
  const tips = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ];
  test('empty → undefined', () => {
    assert.equal(selectTipWithLongestTimeSinceShown([], {}, 1), undefined);
  });
  test('single → that tip', () => {
    assert.equal(selectTipWithLongestTimeSinceShown([tips[1]], {}, 1).id, 'b');
  });
  test('picks least-recently-shown (largest sessionsSince)', () => {
    // a shown at 4 (since 1), b shown at 1 (since 4 — oldest), c never (Infinity).
    // c is Infinity → picked.
    const pick = selectTipWithLongestTimeSinceShown(tips, { a: 4, b: 1 }, 5);
    assert.equal(pick.id, 'c');
  });
  test('among all-shown, picks the oldest', () => {
    const pick = selectTipWithLongestTimeSinceShown(tips, { a: 4, b: 1, c: 3 }, 5);
    assert.equal(pick.id, 'b'); // since: a=1, b=4, c=2 → b
  });
  test('all never-shown (all Infinity) → stable first', () => {
    const pick = selectTipWithLongestTimeSinceShown(tips, {}, 5);
    assert.equal(pick.id, 'a');
  });
});

describe('tipScheduler.selectStartupTip (integration)', () => {
  test('gate off → null', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(selectStartupTip({}, { KHY_STARTUP_TIPS: v }), null);
    }
  });
  test('default registry, first run → returns a {id,text}', () => {
    const tip = selectStartupTip({ history: {}, numStartups: 1 }, {});
    assert.ok(tip && typeof tip.id === 'string' && typeof tip.text === 'string');
  });
  test('recently-shown tip is not re-selected next call (same session)', () => {
    const tip1 = selectStartupTip({ history: {}, numStartups: 3 }, {});
    assert.ok(tip1);
    // Mark tip1 as shown this session; next selection must differ (0-session cooldown).
    const history = { [tip1.id]: 3 };
    const tip2 = selectStartupTip({ history, numStartups: 3 }, {});
    assert.ok(tip2);
    assert.notEqual(tip2.id, tip1.id);
  });
  test('custom tips override registry', () => {
    const tip = selectStartupTip(
      { tips: [{ id: 'solo', text: 'ONLY', cooldownSessions: 0 }], history: {}, numStartups: 1 },
      {},
    );
    assert.equal(tip.id, 'solo');
    assert.equal(tip.text, 'ONLY');
  });
  test('bad input → null, never throws', () => {
    assert.equal(selectStartupTip(null, {}), null);
    assert.equal(selectStartupTip('nope', {}), null);
    assert.equal(selectStartupTip(42, {}), null);
    assert.doesNotThrow(() => selectStartupTip({ tips: 'bad', history: 'bad' }, {}));
  });
});

describe('tipScheduler.TIPS registry shape', () => {
  test('every entry has id, text, valid cooldownSessions; ids unique', () => {
    assert.ok(Array.isArray(TIPS) && TIPS.length > 0);
    const ids = new Set();
    for (const t of TIPS) {
      assert.equal(typeof t.id, 'string');
      assert.ok(t.id.length > 0);
      assert.equal(typeof t.text, 'string');
      assert.ok(t.text.length > 0);
      assert.ok(Number.isFinite(t.cooldownSessions) && t.cooldownSessions >= 0);
      if (t.isRelevant !== undefined) assert.equal(typeof t.isRelevant, 'function');
      assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
      ids.add(t.id);
    }
  });
  test('isRelevant predicates are pure and safe on empty ctx', () => {
    for (const t of TIPS) {
      if (typeof t.isRelevant === 'function') {
        assert.doesNotThrow(() => t.isRelevant({}));
        assert.doesNotThrow(() => t.isRelevant({ numStartups: 100 }));
      }
    }
  });
});
