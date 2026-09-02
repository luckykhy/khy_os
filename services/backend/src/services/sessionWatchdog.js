'use strict';

/**
 * sessionWatchdog.js — Interactive-session hang watchdog (activity-aware, never kills).
 *
 * Responsibility split with the neighbours:
 *   - crashRecovery.js: crashes (uncaught exceptions / rejections) — classification tree.
 *   - resilience/deadLoopDetector.js: agent tool-call loops (same-signature repeats).
 *   - resourceGuard.startWatchdog: per-operation sliding watchdog — REUSED here as
 *     the idle-detection primitive.
 *   - THIS shell: installs ONE session-surface watchdog so a hung interactive
 *     session is OBSERVED (honest log + diagnostics + onHang hook) instead of
 *     silently sitting there. It never process.exit()s — governance Rule 3
 *     (timeouts must be activity-aware, no hard kill).
 *
 * Two hang classes:
 *   1) Async hang (an await never settles, a poll never exits): the event loop
 *      stays alive, so a sampler can observe idleness. Activity signal = any
 *      user-visible output (stdout/stderr writes). Stdin is deliberately NOT
 *      hooked — ink owns it in the TUI and a side-band 'data' listener changes
 *      stream modes (risk > benefit).
 *   2) Sync stall (long sync task / infinite loop): blocks the timer wheel, so
 *      nothing can fire DURING the block. Detected as beat drift AFTER the
 *      block ends. A truly infinite sync loop can never report — physical
 *      limit, documented here on purpose.
 *
 * False-positive boundary: a user reading output (no writes) for the whole
 * idle window hits one idle report; rate-limited to once per idle episode and
 * reset by the next write. Cost: one log line; gain: hangs become observable.
 *
 * Gates: KHY_SESSION_WATCHDOG (default on), idle window
 * KHY_SESSION_WATCHDOG_IDLE_MIN (default 15 minutes), stall threshold
 * KHY_SESSION_WATCHDOG_STALL_MS (default 5000). Idempotent per process
 * (Symbol lock) so TUI → classic-REPL fallback double-install is safe.
 */

const WATCHDOG_INSTALLED_KEY = Symbol.for('khy.sessionWatchdog.installed');

const DEFAULT_SAMPLE_MS = 30_000;
const DEFAULT_STALL_MS = 5_000;
const DEFAULT_IDLE_MIN = 15;

function _gateEnabled(env) {
  const raw = String((env && env.KHY_SESSION_WATCHDOG) || 'true').toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

function _resolvePositiveNumber(env, key, fallback) {
  try {
    const raw = env && env[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return fallback;
    }
    const n = Number(String(raw).trim());
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function _activeHandleSummary() {
  try {
    if (typeof process._getActiveHandles !== 'function') {
      return null;
    }
    const handles = process._getActiveHandles();
    const byType = {};
    for (const h of handles) {
      const t = (h && h.constructor && h.constructor.name) || typeof h;
      byType[t] = (byType[t] || 0) + 1;
    }
    return { count: handles.length, byType };
  } catch {
    return null;
  }
}

/**
 * Install the session watchdog. Idempotent; fail-soft; the returned handle
 * exposes touch() (explicit activity feed for hosts) and stop() (tests).
 *
 * @param {object} [opts]
 * @param {object} [opts.env] - Env source (tests inject {}).
 * @param {object} [opts.logger] - Logger with .warn() (unused on hot path).
 * @param {function} [opts.onHang] - Host hook ({kind:'idle', idleSeconds, handles}).
 * @param {number} [opts.sampleMs] - Sampler period (tests shrink this).
 * @param {number} [opts.stallMs] - Min event-loop block to report.
 * @param {number} [opts.idleLimitMs] - Idle window before the hang report.
 */
function installSessionWatchdog(opts = {}) {
  if (globalThis[WATCHDOG_INSTALLED_KEY]) {
    return { ok: true, reason: 'already-installed' };
  }
  const env = opts.env || process.env;
  if (!_gateEnabled(env)) {
    return { ok: true, reason: 'gate-off' };
  }
  globalThis[WATCHDOG_INSTALLED_KEY] = true;

  const onHang = typeof opts.onHang === 'function' ? opts.onHang : null;
  const sampleMs =
    opts.sampleMs ||
    _resolvePositiveNumber(env, 'KHY_SESSION_WATCHDOG_SAMPLE_MS', DEFAULT_SAMPLE_MS);
  const stallMs =
    opts.stallMs ||
    _resolvePositiveNumber(env, 'KHY_SESSION_WATCHDOG_STALL_MS', DEFAULT_STALL_MS);
  const idleLimitMs =
    opts.idleLimitMs ||
    _resolvePositiveNumber(env, 'KHY_SESSION_WATCHDOG_IDLE_MIN', DEFAULT_IDLE_MIN) * 60_000;

  const { startWatchdog } = require('./resourceGuard');

  let guard = null;
  let guardFired = false;
  let suppressTouch = false;

  function report(line) {
    // Our own diagnostic writes must not reset the idle clock they report on.
    suppressTouch = true;
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      /* sink broken — nothing to do */
    } finally {
      suppressTouch = false;
    }
  }

  function arm() {
    guardFired = false;
    guard = startWatchdog('session', idleLimitMs, (name, elapsed) => {
      guardFired = true;
      const handles = _activeHandleSummary();
      const handleText = handles ? `活动句柄 ${handles.count} 个` : '活动句柄未知';
      report(
        `[Watchdog] 会话已 ${elapsed}s 无任何输出（疑似异步卡死；${handleText}）。` +
          '若界面无响应请 Ctrl+C 后重进，会话可用 khy resume 恢复。'
      );
      if (onHang) {
        try {
          onHang({ kind: 'idle', idleSeconds: Number(elapsed) || 0, handles });
        } catch {
          /* host hook must never break the watchdog */
        }
      }
    });
  }

  function touch() {
    try {
      if (guardFired || !guard) {
        arm(); // re-arm for the next idle episode
      }
      if (guard) {
        guard.touch();
      }
    } catch {
      /* activity tracking must never break the write path */
    }
  }

  // Activity = any user-visible output on the session surfaces. Patching
  // .write (not touching stdin) keeps ink's raw-mode ownership intact.
  for (const stream of [process.stdout, process.stderr]) {
    try {
      if (!stream || typeof stream.write !== 'function') {
        continue;
      }
      const original = stream.write.bind(stream);
      stream.write = function watchdogPatchedWrite(chunk, encoding, cb) {
        if (!suppressTouch) {
          touch();
        }
        return original(chunk, encoding, cb);
      };
    } catch {
      /* odd stream — watchdog degrades, session unaffected */
    }
  }

  arm();

  // Sync-stall detector: a blocked loop delays this beat; the drift IS the
  // stall duration. Reports AFTER the block ends (during it nothing runs).
  let lastBeatAt = Date.now();
  const stallTimer = setInterval(() => {
    try {
      const now = Date.now();
      const drift = now - (lastBeatAt + sampleMs);
      lastBeatAt = now;
      if (drift >= stallMs) {
        report(
          `[Watchdog] 事件循环曾阻塞 ${(drift / 1000).toFixed(1)}s（同步长任务或死循环嫌疑），现已恢复调度。`
        );
      }
    } catch {
      /* watchdog must never throw into the event loop */
    }
  }, sampleMs);
  if (typeof stallTimer.unref === 'function') {
    stallTimer.unref();
  }

  return {
    ok: true,
    reason: 'installed',
    touch,
    stop() {
      clearInterval(stallTimer);
      try {
        if (guard) {
          guard.done();
        }
      } catch {
        /* ignore */
      }
      globalThis[WATCHDOG_INSTALLED_KEY] = false;
    },
  };
}

/** Test seam: forget the per-process install lock. */
function resetForTest() {
  globalThis[WATCHDOG_INSTALLED_KEY] = false;
}

module.exports = {
  installSessionWatchdog,
  resetForTest,
};
