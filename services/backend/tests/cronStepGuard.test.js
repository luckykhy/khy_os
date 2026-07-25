'use strict';

/**
 * cronStepGuard.test.js — 纯叶子契约 + cronScheduler._parseCronField 接线(零步长死循环)。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、fail-soft;叶子合法/非法/门关三态;
 * 接线活验:门开 → `星号/0`/`5/0` 不再挂死(有界返回);合法 `星号/15` 照常;门关不测死循环(会挂)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/cronStepGuard'));

test('cronStepGuardEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.cronStepGuardEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.cronStepGuardEnabled({ KHY_CRON_STEP_GUARD: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.cronStepGuardEnabled({ KHY_CRON_STEP_GUARD: 'yes' }), true);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.cronStepGuardEnabled(null));
  assert.doesNotThrow(() => leaf.cronStepUsable(0, null));
});

test('cronStepUsable: gate ON → true for positive int, false otherwise', () => {
  assert.strictEqual(leaf.cronStepUsable(1, {}), true);
  assert.strictEqual(leaf.cronStepUsable(15, {}), true);
  assert.strictEqual(leaf.cronStepUsable(0, {}), false);
  assert.strictEqual(leaf.cronStepUsable(-3, {}), false);
  assert.strictEqual(leaf.cronStepUsable(NaN, {}), false);
  assert.strictEqual(leaf.cronStepUsable(1.5, {}), false);
});

test('cronStepUsable: gate OFF → null (caller uses legacy loop)', () => {
  const off = { KHY_CRON_STEP_GUARD: '0' };
  assert.strictEqual(leaf.cronStepUsable(0, off), null);
  assert.strictEqual(leaf.cronStepUsable(15, off), null);
});

// ── cronScheduler._parseCronField 接线活验 ─────────────────────────────
function freshCron() {
  delete require.cache[require.resolve('../src/services/cronScheduler')];
  delete require.cache[require.resolve('../src/services/cronStepGuard')];
  return require('../src/services/cronScheduler');
}

function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('wiring ON: */0 no longer hangs matchesCron (returns bounded)', () => {
  withEnv({ KHY_CRON_STEP_GUARD: undefined }, () => {
    const m = freshCron();
    // Must terminate (no infinite loop). A malformed */0 field matches nothing.
    let result;
    assert.doesNotThrow(() => { result = m.matchesCron('*/0 * * * *', new Date(2026, 0, 1, 3, 30, 0)); });
    assert.strictEqual(result, false, '*/0 minute field matches no minute → no fire');
    // Explicit forms too
    assert.doesNotThrow(() => m.matchesCron('5/0 * * * *', new Date(2026, 0, 1, 3, 30, 0)));
    assert.doesNotThrow(() => m.matchesCron('10-20/0 * * * *', new Date(2026, 0, 1, 3, 30, 0)));
  });
});

test('wiring ON: valid step expressions still work', () => {
  withEnv({ KHY_CRON_STEP_GUARD: undefined }, () => {
    const m = freshCron();
    // every 15 minutes → matches minute 30
    assert.strictEqual(m.matchesCron('*/15 * * * *', new Date(2026, 0, 1, 3, 30, 0)), true);
    // minute 30 not divisible-by-7 start 0 → 0,7,14,21,28,35 → 30 excluded
    assert.strictEqual(m.matchesCron('*/7 * * * *', new Date(2026, 0, 1, 3, 30, 0)), false);
  });
});
