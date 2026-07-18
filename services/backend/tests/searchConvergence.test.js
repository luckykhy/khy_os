'use strict';

/**
 * Tests for searchConvergence.js — single source for 「搜索循环 → 主动收敛 + 被动兜底」.
 * Goal 2026-06-25. Covers env gating, the configurable round cap, classifySearchLoop
 * per reason, and the convergence directive wording.
 */

const assert = require('assert');

const MASTER = 'KHY_SEARCH_CONVERGENCE';
const CAP = 'KHY_SEARCH_ROUND_CAP';
const ALL_FLAGS = [MASTER, CAP];
const MODULE_PATH = '../src/services/query/searchConvergence';

function load(env = {}) {
  for (const f of ALL_FLAGS) delete process.env[f];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

describe('searchConvergence — enablement & round cap', () => {
  afterEach(() => { for (const f of ALL_FLAGS) delete process.env[f]; });

  test('enabled by default', () => {
    assert.strictEqual(load().isEnabled(), true);
  });

  test('master gate off via 0/false/off/no', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.strictEqual(load({ [MASTER]: v }).isEnabled(), false, `${v}`);
    }
  });

  test('round cap defaults to 3, overridable, ignores garbage', () => {
    assert.strictEqual(load().roundCap(), 3);
    assert.strictEqual(load({ [CAP]: '2' }).roundCap(), 2);
    assert.strictEqual(load({ [CAP]: '0' }).roundCap(), 3);   // non-positive → default
    assert.strictEqual(load({ [CAP]: 'abc' }).roundCap(), 3); // NaN → default
  });
});

describe('searchConvergence — classifySearchLoop', () => {
  afterEach(() => { for (const f of ALL_FLAGS) delete process.env[f]; });

  test('converge_now: rounds >= cap with results gathered', () => {
    const v = load().classifySearchLoop({ searchRounds: 3, resultsGathered: 8, alreadyForced: false });
    assert.strictEqual(v.converge, true);
    assert.strictEqual(v.reason, 'converge_now');
    assert.strictEqual(v.detail, 3);
  });

  test('below_cap: not enough consecutive search rounds yet', () => {
    const v = load().classifySearchLoop({ searchRounds: 2, resultsGathered: 8 });
    assert.strictEqual(v.converge, false);
    assert.strictEqual(v.reason, 'below_cap');
  });

  test('no_results: nothing gathered → do not force a hollow synthesis', () => {
    const v = load().classifySearchLoop({ searchRounds: 5, resultsGathered: 0 });
    assert.strictEqual(v.converge, false);
    assert.strictEqual(v.reason, 'no_results');
  });

  test('already_forced: one-shot per turn', () => {
    const v = load().classifySearchLoop({ searchRounds: 9, resultsGathered: 8, alreadyForced: true });
    assert.strictEqual(v.converge, false);
    assert.strictEqual(v.reason, 'already_forced');
  });

  test('disabled: master gate off → never converge', () => {
    const v = load({ [MASTER]: '0' }).classifySearchLoop({ searchRounds: 9, resultsGathered: 8 });
    assert.strictEqual(v.converge, false);
    assert.strictEqual(v.reason, 'disabled');
  });

  test('custom cap of 2 fires on the 2nd round', () => {
    const m = load({ [CAP]: '2' });
    assert.strictEqual(m.classifySearchLoop({ searchRounds: 1, resultsGathered: 4 }).converge, false);
    assert.strictEqual(m.classifySearchLoop({ searchRounds: 2, resultsGathered: 4 }).converge, true);
  });
});

describe('searchConvergence — buildConvergenceDirective', () => {
  const m = load();

  test('forbids tools / further search, in Chinese, mentions tallies', () => {
    const d = m.buildConvergenceDirective({ searchRounds: 4, resultsGathered: 12 });
    assert.ok(/禁止再调用任何工具/.test(d), 'must forbid tools');
    assert.ok(/不要再|不要为此再发起搜索/.test(d), 'must forbid further search');
    assert.ok(/中文/.test(d), 'must request Chinese');
    assert.ok(/未能确证/.test(d), 'must allow marking gaps');
    assert.ok(d.includes('4') && d.includes('12'), 'should surface the tallies');
  });

  test('degrades gracefully with no stats', () => {
    const d = m.buildConvergenceDirective();
    assert.ok(/禁止再调用任何工具/.test(d));
    assert.ok(/多轮外部搜索/.test(d));
  });
});
