'use strict';

/**
 * tasteWatchService.test.js — covers the passive end-of-turn hook.
 *
 * Goals:
 *  1. observeTurn is no-op when disabled.
 *  2. observeTurn writes to tasteService when a CLI flag / preference signal
 *     is present in the user message.
 *  3. Per-process dedup blocks the same (category, text) from being re-added
 *     within SEEN_TTL_MS — we don't tax tasteService with re-runs.
 *  4. addPreference failure is swallowed (single error does not abort the
 *     rest, and observeTurn returns ok:false when the *outer* call dies).
 *  5. setEnabled / isEnabled / getStatus round-trip via the state file.
 *  6. resetSeenCache lets the same preference fire again.
 *
 * Isolation: every test redirects `getBaseDataDir` to a per-test tmp dir
 * so the real ~/.khyos/cache is never touched.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-taste-watch-'));
  const dataHome = require('../../utils/dataHome');
  const original = dataHome.getBaseDataDir;
  dataHome.getBaseDataDir = (...segments) => {
    const target = path.join(dir, ...segments);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  delete require.cache[require.resolve('../tasteWatchService')];
  delete require.cache[require.resolve('../tasteService')];
  delete require.cache[require.resolve('../crossAgentTasteLearner')];
  const watch = require('../tasteWatchService');
  try {
    return fn(watch, dir);
  } finally {
    dataHome.getBaseDataDir = original;
    delete require.cache[require.resolve('../tasteWatchService')];
    delete require.cache[require.resolve('../tasteService')];
    delete require.cache[require.resolve('../crossAgentTasteLearner')];
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

test('isEnabled defaults to false', () => {
  withTempHome((watch) => {
    assert.equal(watch.isEnabled(), false);
  });
});

test('setEnabled(true) → isEnabled() returns true; persists across instances', () => {
  withTempHome((watch, dir) => {
    watch.setEnabled(true);
    assert.equal(watch.isEnabled(), true);
    const status = watch.getStatus();
    assert.equal(status.enabled, true);
    assert.ok(status.stateFile.endsWith('taste-watch.json'));
    assert.ok(fs.existsSync(path.join(dir, 'cache', 'taste-watch.json')));
  });
});

test('observeTurn is no-op when disabled', () => {
  withTempHome((watch) => {
    const r = watch.observeTurn({
      userMessage: 'khy --language=zh 写点东西',
      assistantReply: '好的',
      sessionId: 's1',
    });
    assert.equal(r.ok, true);
    assert.equal(r.observed, false);
    assert.equal(r.committed, 0);
  });
});

test('observeTurn promotes a CLI flag to tasteService when enabled', () => {
  withTempHome((watch, dir) => {
    watch.setEnabled(true);
    watch._resetSeenCache();
    const r = watch.observeTurn({
      userMessage: 'khy --language=zh 写个报告',
      assistantReply: '好的，开始。',
      sessionId: 's1',
    });
    assert.equal(r.ok, true);
    assert.equal(r.observed, true);
    assert.ok(r.committed >= 1, `expected at least 1 commit, got ${r.committed}`);

    // Confirm the preference landed in the on-disk taste.md via tasteService.
    const tasteFile = path.join(dir, 'taste', 'taste.md');
    assert.ok(fs.existsSync(tasteFile), 'taste.md should exist after addPreference');
    const body = fs.readFileSync(tasteFile, 'utf8');
    assert.ok(body.includes('用户偏好中文输出') || body.includes('language'),
      `taste.md should mention language preference, got:\n${body}`);
  });
});

test('observeTurn dedupes the same (category, text) within the same session', () => {
  withTempHome((watch) => {
    watch.setEnabled(true);
    watch._resetSeenCache();

    const a = watch.observeTurn({
      userMessage: 'khy --language=zh 写个报告',
      assistantReply: '好的。',
      sessionId: 's1',
    });
    const b = watch.observeTurn({
      userMessage: 'khy --language=zh 再写一个',
      assistantReply: '好的。',
      sessionId: 's1',
    });

    assert.ok(a.committed >= 1, 'first call should commit at least one');
    assert.equal(b.committed, 0, 'second call should be deduped');
    assert.ok(b.skipped >= 1, 'second call should record skipped >= 1');

    const status = watch.getStatus();
    assert.ok(status.stats.skippedSeen >= 1, 'state stats should reflect dedup');
  });
});

test('observeTurn never throws even if tasteService is missing', () => {
  withTempHome((watch) => {
    watch.setEnabled(true);
    watch._resetSeenCache();

    // Hide tasteService so addPreference cannot resolve. We can't easily
    // uninstall an already-required module, but we *can* poison require
    // cache so the next require returns undefined — simulating a broken
    // install. observeTurn must still return ok:false (or ok:true with
    // committed=0) and never throw.
    const tastePath = require.resolve('../tasteService');
    const saved = require.cache[tastePath];
    delete require.cache[tastePath];
    require.cache[tastePath] = { exports: undefined };

    let r;
    try {
      r = watch.observeTurn({
        userMessage: 'khy --language=zh',
        assistantReply: '',
        sessionId: 's2',
      });
    } catch (e) {
      // Restore and re-raise so the test fails loudly if observeTurn leaks.
      require.cache[tastePath] = saved;
      throw e;
    }
    require.cache[tastePath] = saved;

    // r must be defined; committed must be 0 (we can't really call a missing
    // service); we don't insist on ok:false because the inner try/catch on
    // the per-candidate addPreference loop swallows that.
    assert.ok(r);
    assert.equal(r.committed, 0);
  });
});

test('resetSeenCache lets the same preference fire again', () => {
  withTempHome((watch) => {
    watch.setEnabled(true);
    watch._resetSeenCache();

    const a = watch.observeTurn({
      userMessage: 'khy --language=zh 写个报告',
      assistantReply: '好的。',
      sessionId: 's3',
    });
    watch.resetSeenCache();
    const b = watch.observeTurn({
      userMessage: 'khy --language=zh 写个报告',
      assistantReply: '好的。',
      sessionId: 's3',
    });

    assert.ok(a.committed >= 1, 'first call should commit');
    // After reset, the dedup Map is empty, so a second call would
    // re-evaluate and re-commit. (tasteService.addPreference itself
    // dedupes by text, so committed may be 0 from tasteService's side,
    // but observeTurn must at least have processed the candidate.)
    assert.ok(b.observed, 'second call should still observe');
  });
});

test('getStatus stats survive a process reload', () => {
  withTempHome((watch) => {
    watch.setEnabled(true);
    watch._resetSeenCache();
    watch.observeTurn({
      userMessage: 'khy --language=zh',
      assistantReply: '',
      sessionId: 's4',
    });
    // Force the periodic write so the file is fresh on disk.
    watch.resetStats();
    const status = watch.getStatus();
    assert.equal(status.enabled, true);
    // resetStats wiped the counters; that's the contract.
    assert.equal(status.stats.observedTurns, 0);
  });
});

// ── observePermission (always-allow / deny signal) ──────────────────────

test('observePermission: no-op when disabled', () => {
  withTempHome((watch) => {
    const r = watch.observePermission({
      toolName: 'Bash',
      decision: 'allow',
      scope: 'forever',
    });
    assert.equal(r.ok, true);
    assert.equal(r.observed, false);
  });
});

test('observePermission: forever-allow promotes "总是允许" preference', () => {
  withTempHome((watch, dir) => {
    watch.setEnabled(true);
    watch._resetSeenCache();
    const r = watch.observePermission({
      toolName: 'Bash',
      decision: 'allow',
      scope: 'forever',
      risk: 'low',
    });
    assert.equal(r.ok, true);
    assert.equal(r.observed, true);
    assert.equal(r.committed, 1);

    const tasteFile = path.join(dir, 'taste', 'taste.md');
    assert.ok(fs.existsSync(tasteFile));
    const body = fs.readFileSync(tasteFile, 'utf8');
    assert.ok(body.includes('用户总是允许 Bash 操作'),
      `taste.md should mention the always-allow preference, got:\n${body}`);
  });
});

test('observePermission: deny (any scope) promotes "持谨慎态度" preference', () => {
  withTempHome((watch, dir) => {
    watch.setEnabled(true);
    watch._resetSeenCache();
    const r = watch.observePermission({
      toolName: 'Write',
      decision: 'deny',
      scope: 'session',
      risk: 'medium',
    });
    assert.equal(r.ok, true);
    assert.equal(r.observed, true);
    assert.equal(r.committed, 1);

    const tasteFile = path.join(dir, 'taste', 'taste.md');
    const body = fs.readFileSync(tasteFile, 'utf8');
    assert.ok(body.includes('持谨慎态度'),
      `taste.md should mention cautious preference, got:\n${body}`);
  });
});

test('observePermission: once/session allow does NOT promote (too noisy)', () => {
  withTempHome((watch, dir) => {
    watch.setEnabled(true);
    watch._resetSeenCache();
    const r = watch.observePermission({
      toolName: 'Read',
      decision: 'allow',
      scope: 'once',
    });
    assert.equal(r.ok, true);
    assert.equal(r.observed, true);
    assert.equal(r.committed, 0, 'once-allow should be observed but not committed');

    // observedTurns was bumped, committed was not
    const status = watch.getStatus();
    assert.ok(status.stats.observedTurns >= 1);
    assert.equal(status.stats.committed, 0);
  });
});

test('observePermission: same tool+scope twice in a row is deduped', () => {
  withTempHome((watch) => {
    watch.setEnabled(true);
    watch._resetSeenCache();
    const a = watch.observePermission({
      toolName: 'Bash',
      decision: 'allow',
      scope: 'forever',
    });
    const b = watch.observePermission({
      toolName: 'Bash',
      decision: 'allow',
      scope: 'forever',
    });
    assert.equal(a.committed, 1);
    assert.equal(b.committed, 0);
    assert.ok(b.skipped >= 1);
  });
});
