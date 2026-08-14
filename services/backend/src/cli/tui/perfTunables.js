'use strict';

/**
 * perfTunables — pure leaf holding the TUI's timer cadence tunables.
 *
 * Zero dependencies, zero IO, deterministic, never throws. Single source of
 * truth for the render/timer cadence defaults so no consumer hard-codes them.
 *
 * Background: profiling showed the busy-state TUI stacks THREE periodic
 * timers — the 80ms Spinner braille rotation, the 1s elapsed heartbeat
 * (App.js nowTick) and the 180ms topicBar working-dot animation — each of
 * which forces an ink re-render. Relaxing the cadences cuts idle-busy CPU
 * with no functional change (the animations just tick slower):
 *   - spinnerFrameMs: 80 → 160 (12.5fps → ~6fps; braille rotation stays
 *     visibly smooth at 6fps while halving spinner-driven renders)
 *   - heartbeatMs: 1000 → 2000 (elapsed-seconds display granularity drops to
 *     2s, which is acceptable for a "how long has this run" readout)
 *   - topicBarAnimMs: 180 → 320 (working-dot pulse; still clearly animated)
 *
 * Env overrides (KHY_SPINNER_FRAME_MS / KHY_HEARTBEAT_MS /
 * KHY_TOPIC_BAR_ANIM_MS) accept any finite positive number; garbage
 * (NaN / 0 / negative / empty string) falls back to the default — the same
 * reject-garbage paradigm used across the repo's env parsing.
 *
 * Umbrella switch: KHY_TUI_LOW_POWER === '1' relaxes all three defaults
 * further (320 / 3000 / 640 — i.e. another 2x back-off) for battery /
 * remote-shell scenarios. A per-knob env var, when explicitly set to a valid
 * value, always wins over the umbrella.
 */

/**
 * Parse an env var as a finite positive number; anything else → fallback.
 * @param {*} raw - raw env value
 * @param {number} fallback
 * @returns {number}
 */
function _pos(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True when the KHY_TUI_LOW_POWER umbrella is on ('1' only, by design). */
function _lowPower(env) {
  return String((env && env.KHY_TUI_LOW_POWER) || '') === '1';
}

/**
 * Spinner braille frame interval. Default 160ms (was a hard-coded 80ms in
 * Spinner.js — 12.5fps; 160ms halves spinner-driven re-renders while keeping
 * the rotation visibly smooth). LOW_POWER umbrella → 320ms.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function spinnerFrameMs(env = process.env) {
  const def = _lowPower(env) ? 320 : 160;
  return _pos(env && env.KHY_SPINNER_FRAME_MS, def);
}

/**
 * Busy-state elapsed heartbeat interval. Default 2000ms (was a hard-coded
 * 1000ms setInterval in App.js driving nowTick; a 2s granularity is enough
 * for the elapsed-time readout and halves heartbeat renders). LOW_POWER
 * umbrella → 3000ms.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function heartbeatMs(env = process.env) {
  const def = _lowPower(env) ? 3000 : 2000;
  return _pos(env && env.KHY_HEARTBEAT_MS, def);
}

/**
 * topicBar working-dot animation interval. Default 320ms (was a hard-coded
 * 180ms _ANIM_MS in runtime/topicBar.js; the pulse remains clearly animated
 * at 320ms with ~44% fewer ticks). LOW_POWER umbrella → 640ms.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function topicBarAnimMs(env = process.env) {
  const def = _lowPower(env) ? 640 : 320;
  return _pos(env && env.KHY_TOPIC_BAR_ANIM_MS, def);
}

module.exports = { spinnerFrameMs, heartbeatMs, topicBarAnimMs };
