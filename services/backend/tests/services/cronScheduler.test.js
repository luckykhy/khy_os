'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PREV_CRON_GROWTH_DIR = process.env.KHY_CRON_GROWTH_DIR;
const PREV_CRON_JOBS_FILE = process.env.KHY_CRON_JOBS_FILE;
const TEST_GROWTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cron-test-'));
process.env.KHY_CRON_GROWTH_DIR = TEST_GROWTH_DIR;
delete process.env.KHY_CRON_JOBS_FILE;

const cron = require('../../src/services/cronScheduler');

// ── Helpers ──

function cleanupJobs() {
  try { fs.unlinkSync(cron.JOBS_FILE); } catch { /* ok */ }
}

describe('cronScheduler', () => {
  beforeEach(() => {
    cron._resetForTest();
  });

  afterAll(() => {
    cron._resetForTest();
    try { fs.rmSync(TEST_GROWTH_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    if (PREV_CRON_GROWTH_DIR === undefined) delete process.env.KHY_CRON_GROWTH_DIR;
    else process.env.KHY_CRON_GROWTH_DIR = PREV_CRON_GROWTH_DIR;
    if (PREV_CRON_JOBS_FILE === undefined) delete process.env.KHY_CRON_JOBS_FILE;
    else process.env.KHY_CRON_JOBS_FILE = PREV_CRON_JOBS_FILE;
  });

  // ── Cron Expression Parsing ─────────────────────────────────────

  describe('matchesCron', () => {
    test('* * * * * matches any date', () => {
      const d = new Date(2026, 4, 17, 10, 30); // May 17, 2026, 10:30
      expect(cron.matchesCron('* * * * *', d)).toBe(true);
    });

    test('exact minute and hour match', () => {
      const d = new Date(2026, 4, 17, 9, 0); // 09:00
      expect(cron.matchesCron('0 9 * * *', d)).toBe(true);
      expect(cron.matchesCron('1 9 * * *', d)).toBe(false);
      expect(cron.matchesCron('0 10 * * *', d)).toBe(false);
    });

    test('step syntax */5 matches multiples', () => {
      const d0 = new Date(2026, 4, 17, 10, 0);
      const d5 = new Date(2026, 4, 17, 10, 5);
      const d3 = new Date(2026, 4, 17, 10, 3);
      expect(cron.matchesCron('*/5 * * * *', d0)).toBe(true);
      expect(cron.matchesCron('*/5 * * * *', d5)).toBe(true);
      expect(cron.matchesCron('*/5 * * * *', d3)).toBe(false);
    });

    test('range syntax 1-5 for day of week (Mon-Fri)', () => {
      // May 17, 2026 is a Sunday (dow=0)
      const sunday = new Date(2026, 4, 17, 9, 0);
      // May 18, 2026 is a Monday (dow=1)
      const monday = new Date(2026, 4, 18, 9, 0);
      expect(cron.matchesCron('0 9 * * 1-5', monday)).toBe(true);
      expect(cron.matchesCron('0 9 * * 1-5', sunday)).toBe(false);
    });

    test('comma-separated values', () => {
      const d = new Date(2026, 4, 17, 9, 15);
      expect(cron.matchesCron('0,15,30,45 * * * *', d)).toBe(true);
      expect(cron.matchesCron('0,10,20 * * * *', d)).toBe(false);
    });

    test('day of month matching', () => {
      const d1 = new Date(2026, 4, 1, 0, 0); // May 1
      const d15 = new Date(2026, 4, 15, 0, 0); // May 15
      expect(cron.matchesCron('0 0 1 * *', d1)).toBe(true);
      expect(cron.matchesCron('0 0 1 * *', d15)).toBe(false);
    });

    test('month matching', () => {
      const may = new Date(2026, 4, 17, 0, 0); // month index 4 = May
      const jan = new Date(2026, 0, 17, 0, 0); // month index 0 = Jan
      expect(cron.matchesCron('0 0 * 5 *', may)).toBe(true);
      expect(cron.matchesCron('0 0 * 5 *', jan)).toBe(false);
    });

    test('Sunday matches both 0 and 7', () => {
      const sunday = new Date(2026, 4, 17, 9, 0); // May 17, 2026 = Sunday
      expect(cron.matchesCron('0 9 * * 0', sunday)).toBe(true);
      expect(cron.matchesCron('0 9 * * 7', sunday)).toBe(true);
    });

    test('invalid cron expression returns false', () => {
      const d = new Date();
      expect(cron.matchesCron('invalid', d)).toBe(false);
      expect(cron.matchesCron('1 2 3', d)).toBe(false);
    });

    test('range with step: 0-30/10', () => {
      const d0 = new Date(2026, 4, 17, 10, 0);
      const d10 = new Date(2026, 4, 17, 10, 10);
      const d20 = new Date(2026, 4, 17, 10, 20);
      const d30 = new Date(2026, 4, 17, 10, 30);
      const d35 = new Date(2026, 4, 17, 10, 35);
      expect(cron.matchesCron('0-30/10 * * * *', d0)).toBe(true);
      expect(cron.matchesCron('0-30/10 * * * *', d10)).toBe(true);
      expect(cron.matchesCron('0-30/10 * * * *', d20)).toBe(true);
      expect(cron.matchesCron('0-30/10 * * * *', d30)).toBe(true);
      expect(cron.matchesCron('0-30/10 * * * *', d35)).toBe(false);
    });

    // ── Vixie-cron DOM/DOW OR rule ────────────────────────────────
    // When BOTH day-of-month and day-of-week are restricted, a match on
    // EITHER fires the job (OR). When at least one is `*`, they AND.
    describe('DOM/DOW combination (Vixie-cron OR rule)', () => {
      const wed13 = new Date(2026, 4, 13, 9, 0); // DOM=13, Wednesday
      const thu14 = new Date(2026, 4, 14, 9, 0); // DOM=14, Thursday
      const fri15 = new Date(2026, 4, 15, 9, 0); // DOM=15, Friday (dow=5)

      test('both restricted → OR: "0 9 13 * 5" fires on the 13th OR any Friday', () => {
        expect(cron.matchesCron('0 9 13 * 5', wed13)).toBe(true);  // DOM matches
        expect(cron.matchesCron('0 9 13 * 5', fri15)).toBe(true);  // DOW matches
        expect(cron.matchesCron('0 9 13 * 5', thu14)).toBe(false); // neither
      });

      test('DOW wildcard → AND on DOM only: "0 9 13 * *"', () => {
        expect(cron.matchesCron('0 9 13 * *', wed13)).toBe(true);
        expect(cron.matchesCron('0 9 13 * *', fri15)).toBe(false); // wrong DOM
      });

      test('DOM wildcard → AND on DOW only: "0 9 * * 5"', () => {
        expect(cron.matchesCron('0 9 * * 5', fri15)).toBe(true);
        expect(cron.matchesCron('0 9 * * 5', wed13)).toBe(false); // wrong DOW
      });

      test('both wildcard → fires every matching minute/hour', () => {
        expect(cron.matchesCron('0 9 * * *', wed13)).toBe(true);
        expect(cron.matchesCron('0 9 * * *', thu14)).toBe(true);
      });
    });
  });

  // ── Job CRUD ────────────────────────────────────────────────────

  describe('Job CRUD', () => {
    test('addJob creates a job with valid id and fields', () => {
      const { id, job } = cron.addJob({ cron: '0 9 * * *', prompt: 'test prompt' });
      expect(id).toMatch(/^cj-[0-9a-f]{6}$/);
      expect(job.cron).toBe('0 9 * * *');
      expect(job.prompt).toBe('test prompt');
      expect(job.enabled).toBe(true);
      expect(job.noAgent).toBe(false);
      expect(job.lastRunAt).toBeNull();
    });

    test('addJob throws on missing cron or prompt', () => {
      expect(() => cron.addJob({ prompt: 'no cron' })).toThrow();
      expect(() => cron.addJob({ cron: '* * * * *' })).toThrow();
      expect(() => cron.addJob(null)).toThrow();
    });

    test('addJob throws on invalid cron expression', () => {
      expect(() => cron.addJob({ cron: 'bad', prompt: 'test' })).toThrow(/5 fields/);
    });

    test('listJobs returns all added jobs', () => {
      cron.addJob({ cron: '0 9 * * *', prompt: 'job1' });
      cron.addJob({ cron: '0 18 * * *', prompt: 'job2' });
      const jobs = cron.listJobs();
      expect(jobs.length).toBe(2);
      expect(jobs.map((j) => j.prompt)).toEqual(expect.arrayContaining(['job1', 'job2']));
    });

    test('getJob returns a specific job', () => {
      const { id } = cron.addJob({ cron: '0 9 * * *', prompt: 'specific' });
      const job = cron.getJob(id);
      expect(job).not.toBeNull();
      expect(job.prompt).toBe('specific');
    });

    test('getJob returns null for nonexistent id', () => {
      expect(cron.getJob('cj-nonexistent')).toBeNull();
    });

    test('removeJob deletes a job', () => {
      const { id } = cron.addJob({ cron: '0 9 * * *', prompt: 'to remove' });
      expect(cron.removeJob(id)).toBe(true);
      expect(cron.getJob(id)).toBeNull();
      expect(cron.listJobs().length).toBe(0);
    });

    test('removeJob returns false for nonexistent id', () => {
      expect(cron.removeJob('cj-nope')).toBe(false);
    });

    test('enableJob / disableJob toggle enabled flag', () => {
      const { id } = cron.addJob({ cron: '0 9 * * *', prompt: 'toggle' });
      expect(cron.getJob(id).enabled).toBe(true);

      cron.disableJob(id);
      expect(cron.getJob(id).enabled).toBe(false);

      cron.enableJob(id);
      expect(cron.getJob(id).enabled).toBe(true);
    });

    test('enableJob/disableJob return false for nonexistent id', () => {
      expect(cron.enableJob('cj-nope')).toBe(false);
      expect(cron.disableJob('cj-nope')).toBe(false);
    });
  });

  // ── Tick scheduling ─────────────────────────────────────────────

  describe('_tick()', () => {
    test('triggers matching job at the right minute', async () => {
      const { id } = cron.addJob({ cron: '30 10 * * *', prompt: 'tick test' });
      const matchTime = new Date(2026, 4, 17, 10, 30);
      const triggered = await cron._tick(matchTime);
      expect(triggered).toContain(id);
    });

    test('does not trigger at non-matching minute', async () => {
      cron.addJob({ cron: '30 10 * * *', prompt: 'no match' });
      const noMatchTime = new Date(2026, 4, 17, 10, 31);
      const triggered = await cron._tick(noMatchTime);
      expect(triggered.length).toBe(0);
    });

    test('does not trigger disabled jobs', async () => {
      const { id } = cron.addJob({ cron: '* * * * *', prompt: 'disabled' });
      cron.disableJob(id);
      const triggered = await cron._tick(new Date());
      expect(triggered).not.toContain(id);
    });

    test('prevents double-run within same minute', async () => {
      const { id } = cron.addJob({ cron: '* * * * *', prompt: 'no double' });
      const now = new Date(2026, 4, 17, 10, 30);

      const first = await cron._tick(now);
      expect(first).toContain(id);

      // _executeJob is async and updates lastRunAt on disk;
      // wait long enough for the require() + writeFileSync to complete
      await new Promise((r) => setTimeout(r, 2000));

      const second = await cron._tick(now);
      expect(second).not.toContain(id);
    });
  });

  // ── Persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    test('jobs survive save/load cycle', () => {
      cron.addJob({ cron: '0 9 * * *', prompt: 'persisted' });
      const jobs1 = cron.listJobs();
      expect(jobs1.length).toBe(1);

      // The file should exist on disk
      expect(fs.existsSync(cron.JOBS_FILE)).toBe(true);

      // Read raw file to verify structure
      const raw = JSON.parse(fs.readFileSync(cron.JOBS_FILE, 'utf8'));
      expect(raw.version).toBe(1);
      expect(Object.keys(raw.jobs).length).toBe(1);
    });

    test('addJob with channel and noAgent persists correctly', () => {
      const { id, job } = cron.addJob({
        cron: '*/5 * * * *',
        prompt: 'df -h',
        channel: 'slack:ops',
        noAgent: true,
      });

      const loaded = cron.getJob(id);
      expect(loaded.channel).toBe('slack:ops');
      expect(loaded.noAgent).toBe(true);
    });
  });

  // ── Start/Stop ──────────────────────────────────────────────────

  describe('start/stop', () => {
    test('start and stop do not throw', () => {
      expect(() => cron.start()).not.toThrow();
      expect(() => cron.stop()).not.toThrow();
    });

    test('double start is idempotent', () => {
      cron.start();
      cron.start(); // should not throw or create duplicate timers
      cron.stop();
    });
  });
});
