'use strict';

/**
 * Tests for the s14 fix: cron scheduler unification + CC-aligned hardening.
 *
 * Two problems are addressed:
 *  (1) Fragmentation — ScheduleCronTool used to keep its OWN in-memory store and
 *      a broken next-run heuristic, so jobs it created were invisible to
 *      CronList / CronDelete (which read jobs/cronScheduler). They now share one
 *      canonical store. This file asserts the create → list → delete round-trip.
 *  (2) Missing CC semantics — DOM/DOW OR matching, full-field cron validation,
 *      MAX_JOBS cap, per-minute dedup marker, and skip-invalid on durable load.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Point durable persistence at a throwaway file BEFORE requiring the scheduler,
// so the suite never touches the real ~/.khy/scheduled_tasks.json.
const TMP_DURABLE = path.join(os.tmpdir(), `khy-cron-test-${process.pid}.json`);
process.env.KHY_CRON_DURABLE_FILE = TMP_DURABLE;

const cron = require('../src/jobs/cronScheduler');
const ScheduleCron = require('../src/tools/ScheduleCronTool');
const CronListTool = require('../src/tools/CronListTool');
const CronDeleteTool = require('../src/tools/CronDeleteTool');
const CronList = new CronListTool();
const CronDelete = new CronDeleteTool();

function cleanup() {
  cron._resetForTest();
  try { fs.unlinkSync(TMP_DURABLE); } catch { /* ignore */ }
}

describe('s14 — cron validation', () => {
  afterEach(cleanup);

  test('accepts all standard field forms', () => {
    assert.strictEqual(cron.validateCron('* * * * *'), null);
    assert.strictEqual(cron.validateCron('0 9 * * *'), null);
    assert.strictEqual(cron.validateCron('*/5 * * * *'), null);
    assert.strictEqual(cron.validateCron('0 9 * * 1-5'), null);
    assert.strictEqual(cron.validateCron('15,45 * * * *'), null);
    assert.strictEqual(cron.validateCron('0 0-12/2 * * *'), null);
    assert.strictEqual(cron.validateCron('0 9 1,15 * *'), null);
  });

  test('rejects wrong field count', () => {
    assert.ok(cron.validateCron('* * * *'));
    assert.ok(cron.validateCron('* * * * * *'));
    assert.ok(cron.validateCron(''));
  });

  test('rejects out-of-range values', () => {
    assert.ok(cron.validateCron('60 * * * *'), 'minute 60 invalid');
    assert.ok(cron.validateCron('* 24 * * *'), 'hour 24 invalid');
    assert.ok(cron.validateCron('* * 32 * *'), 'dom 32 invalid');
    assert.ok(cron.validateCron('* * * 13 *'), 'month 13 invalid');
    assert.ok(cron.validateCron('* * * * 8'), 'dow 8 invalid');
  });

  test('rejects malformed atoms', () => {
    assert.ok(cron.validateCron('*/0 * * * *'), 'zero step invalid');
    assert.ok(cron.validateCron('abc * * * *'), 'non-numeric invalid');
    assert.ok(cron.validateCron('5-2 * * * *'), 'reversed range invalid');
  });
});

describe('s14 — cronMatches DOM/DOW OR semantics', () => {
  afterEach(cleanup);

  // 2024-01-15 is a Monday (dow=1), day-of-month 15.
  const monday15 = new Date(2024, 0, 15, 9, 0, 0);

  test('both unconstrained ⇒ matches any day', () => {
    assert.ok(cron.cronMatches('0 9 * * *', monday15));
  });

  test('only DOM constrained ⇒ DOM applies', () => {
    assert.ok(cron.cronMatches('0 9 15 * *', monday15));
    assert.ok(!cron.cronMatches('0 9 16 * *', monday15));
  });

  test('only DOW constrained ⇒ DOW applies', () => {
    assert.ok(cron.cronMatches('0 9 * * 1', monday15)); // Monday
    assert.ok(!cron.cronMatches('0 9 * * 2', monday15)); // Tuesday
  });

  test('both constrained ⇒ OR (match on either is enough)', () => {
    // DOM matches (15) but DOW does not (says Friday=5): still fires (OR).
    assert.ok(cron.cronMatches('0 9 15 * 5', monday15));
    // DOW matches (Monday=1) but DOM does not (says 20): still fires (OR).
    assert.ok(cron.cronMatches('0 9 20 * 1', monday15));
    // Neither matches: does not fire.
    assert.ok(!cron.cronMatches('0 9 20 * 5', monday15));
  });

  test('minute/hour/month are always AND', () => {
    assert.ok(!cron.cronMatches('30 9 * * *', monday15)); // minute mismatch
    assert.ok(!cron.cronMatches('0 10 * * *', monday15)); // hour mismatch
    assert.ok(!cron.cronMatches('0 9 * 2 *', monday15)); // month mismatch
  });

  test('Sunday accepts both 0 and 7', () => {
    const sunday = new Date(2024, 0, 14, 9, 0, 0); // 2024-01-14 is Sunday
    assert.ok(cron.cronMatches('0 9 * * 0', sunday));
    assert.ok(cron.cronMatches('0 9 * * 7', sunday));
  });
});

describe('s14 — createJob guards', () => {
  afterEach(cleanup);

  test('rejects an invalid cron expression', () => {
    const res = cron.createJob({ cron: '99 * * * *', prompt: 'x' });
    assert.ok(res.error, 'expected an error descriptor');
    assert.ok(/Invalid cron/.test(res.error));
  });

  test('rejects an empty prompt', () => {
    const res = cron.createJob({ cron: '* * * * *', prompt: '   ' });
    assert.ok(res.error);
    assert.ok(/prompt/.test(res.error));
  });

  test('enforces MAX_JOBS', () => {
    for (let i = 0; i < cron.MAX_JOBS; i++) {
      const r = cron.createJob({ cron: '* * * * *', prompt: `job ${i}` });
      assert.ok(!r.error, `job ${i} should be created`);
    }
    const overflow = cron.createJob({ cron: '* * * * *', prompt: 'one too many' });
    assert.ok(overflow.error);
    assert.ok(/Too many/.test(overflow.error));
  });
});

describe('s14 — tick dedup + one-shot + expiry', () => {
  afterEach(cleanup);

  test('a job fires at most once per wall-clock minute', () => {
    const fired = [];
    cron.startScheduler((p) => fired.push(p));
    const job = cron.createJob({ cron: '* * * * *', prompt: 'every-minute' });
    assert.ok(!job.error);

    cron.tick();
    cron.tick(); // same minute — must be deduped
    assert.strictEqual(fired.length, 1, 'second tick in the same minute must not re-fire');
  });

  test('a one-shot job is removed after firing', () => {
    const fired = [];
    cron.startScheduler((p) => fired.push(p));
    cron.createJob({ cron: '* * * * *', prompt: 'once', recurring: false });
    cron.tick();
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(cron.listJobs().length, 0, 'one-shot must be gone after firing');
  });

  test('one bad job does not stop the others from firing', () => {
    const fired = [];
    cron.startScheduler((p) => {
      if (p === 'boom') throw new Error('delivery failed');
      fired.push(p);
    });
    cron.createJob({ cron: '* * * * *', prompt: 'boom' });
    cron.createJob({ cron: '* * * * *', prompt: 'survivor' });
    assert.doesNotThrow(() => cron.tick());
    assert.ok(fired.includes('survivor'), 'the good job must still fire');
  });
});

describe('s14 — durable persistence + skip-invalid on load', () => {
  afterEach(cleanup);

  test('durable jobs are written to disk', () => {
    cron.createJob({ cron: '0 9 * * *', prompt: 'durable one', durable: true });
    assert.ok(fs.existsSync(TMP_DURABLE), 'durable file should be written');
    const onDisk = JSON.parse(fs.readFileSync(TMP_DURABLE, 'utf-8'));
    assert.strictEqual(onDisk.length, 1);
    assert.strictEqual(onDisk[0].prompt, 'durable one');
  });

  test('loadDurableJobs (via startScheduler) skips malformed cron entries', () => {
    // Hand-write a file with one good and one corrupt job.
    fs.writeFileSync(TMP_DURABLE, JSON.stringify([
      { id: 'good', cron: '0 9 * * *', prompt: 'ok', recurring: true, durable: true },
      { id: 'bad', cron: '99 99 99 99 99', prompt: 'broken', recurring: true, durable: true },
    ]), 'utf-8');

    cron.startScheduler(() => {});
    const ids = cron.listJobs().map((j) => j.id);
    assert.ok(ids.includes('good'), 'valid job must load');
    assert.ok(!ids.includes('bad'), 'malformed job must be skipped');
  });
});

describe('s14 — ScheduleCron/CronList/CronDelete share ONE store', () => {
  afterEach(cleanup);

  test('a job created via ScheduleCron is visible to CronList', async () => {
    const res = await ScheduleCron.execute({ cron: '0 9 * * 1-5', prompt: 'standup' });
    assert.strictEqual(res.success, true);
    const list = await CronList.execute();
    assert.strictEqual(list.count, 1);
    assert.strictEqual(list.jobs[0].id, res.job.id);
    assert.strictEqual(list.jobs[0].prompt, 'standup');
  });

  test('a job created via ScheduleCron can be cancelled via CronDelete', async () => {
    const res = await ScheduleCron.execute({ cron: '*/5 * * * *', prompt: 'health' });
    const del = await CronDelete.execute({ id: res.job.id });
    assert.strictEqual(del.success, true);
    const list = await CronList.execute();
    assert.strictEqual(list.count, 0, 'job must be gone after delete');
  });

  test('ScheduleCron surfaces a validation error instead of creating a bad job', async () => {
    const res = await ScheduleCron.execute({ cron: '61 * * * *', prompt: 'bad' });
    assert.strictEqual(res.success, false);
    assert.ok(/Invalid cron/.test(res.error));
    const list = await CronList.execute();
    assert.strictEqual(list.count, 0);
  });

  test('durable flag round-trips through the tool', async () => {
    const res = await ScheduleCron.execute({
      cron: '0 9 * * *', prompt: 'daily', durable: true,
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.job.durable, true);
    assert.ok(fs.existsSync(TMP_DURABLE));
  });
});
