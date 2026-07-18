'use strict';

/**
 * cronTrioTier — the cron trio (create/list/delete) must sit at ONE load tier.
 *
 * Regression target (Claude Code alignment): CronList / CronDelete carry no
 * shouldDefer flag (always eager), but ScheduleCron (the *create* half) was the
 * only one deferred — so scheduling a job needed a SearchExtraTools round-trip the
 * other two never did. ScheduleCronTool.alwaysLoad now promotes create to eager to
 * match its siblings and CC (CronCreate/CronList/CronDelete top-level), gated
 * KHY_CRON_TRIO_EAGER (default on; off → create stays deferred, byte-identical old).
 *
 * node:test (jest via rtk reports "Exec format error" and is unusable here).
 */
const test = require('node:test');
const assert = require('node:assert');

const { ScheduleCronTool } = require('../src/tools/ScheduleCronTool');

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'KHY_CRON_TRIO_EAGER');
  const prev = process.env.KHY_CRON_TRIO_EAGER;
  if (value === undefined) delete process.env.KHY_CRON_TRIO_EAGER;
  else process.env.KHY_CRON_TRIO_EAGER = value;
  try { return fn(); }
  finally {
    if (had) process.env.KHY_CRON_TRIO_EAGER = prev;
    else delete process.env.KHY_CRON_TRIO_EAGER;
  }
}

test('alwaysLoad default (gate unset) → true (create is eager like list/delete)', () => {
  withEnv(undefined, () => {
    assert.strictEqual(ScheduleCronTool.alwaysLoad, true);
  });
});

test('alwaysLoad honors explicit truthy gate', () => {
  for (const on of ['1', 'true', 'on', 'yes', 'anything-else']) {
    withEnv(on, () => assert.strictEqual(ScheduleCronTool.alwaysLoad, true, on));
  }
});

test('alwaysLoad off-words → false (byte-fallback: create stays deferred)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled', 'OFF', ' False ']) {
    withEnv(off, () => assert.strictEqual(ScheduleCronTool.alwaysLoad, false, off));
  }
});

test('shouldDefer stays true so KHY_DEFER off still defers create', () => {
  // The tool remains defer-eligible; alwaysLoad only overrides the tier when the
  // deferral machinery is active. shouldDefer must not have been dropped.
  assert.strictEqual(ScheduleCronTool.shouldDefer, true);
});

test('cron_create alias preserved (discoverable by CC-aligned name)', () => {
  assert.ok(ScheduleCronTool.aliases.includes('cron_create'));
});
