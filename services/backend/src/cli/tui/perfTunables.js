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
 * A fourth knob, suspendSettleMs, is not a cadence but a **barrier**: how long
 * the shell waits after suspending the live UI before calling app.clear(). It
 * must EXCEED ink's own render throttle window, or the clear races a pending
 * trailing render (see the function docstring).
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

/**
 * ink 自身的渲染节流窗口(ms)。ink render 默认 `maxFps: 30` →
 * `Math.ceil(1000/30)` = 34ms 的 throttle(leading + trailing)。这是**上游常量的镜像**,
 * 不是可调参数:改它不会改变 ink 的行为,只会让下面的 settle 算错。
 */
const INK_THROTTLE_MS = 34;

/**
 * 「挂起 live UI → app.clear()」之间的沉降等待(ms)。默认 50ms。
 *
 * 背景(goal「/命令后出现输入框残影」):壳在跑交互子命令前会 setInputActive(false) 让 live 区
 * 变空,等一帧提交后再 app.clear(),使处理器从干净的瞬态区开始。此处历史上硬编码等 **16ms**,
 * 但 ink 的节流窗口是 **34ms**(maxFps 30,leading+trailing)—— 16 < 34,那帧「空 live 区」提交
 * 通常还挂在 trailing 队列里没落地。于是次序变成:
 *   clear() 擦掉并 log.sync(**clear 前**那帧的行数)→ 随后 trailing onRender 把刚被擦掉的
 *   输入框 chrome 又画了回来 → 残影。
 * 取 50ms(> 34ms 一个安全余量)让 trailing 帧先落地,clear() 才擦到真正的最新帧。
 *
 * 门控 KHY_TUI_SUSPEND_SETTLE_MS 接受任意有限正数;垃圾值回落默认。LOW_POWER 不放宽本值——
 * 它是正确性屏障而非动画节奏,放宽只会让命令启动更迟钝。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function suspendSettleMs(env = process.env) {
  return _pos(env && env.KHY_TUI_SUSPEND_SETTLE_MS, INK_THROTTLE_MS + 16);
}

module.exports = { spinnerFrameMs, heartbeatMs, topicBarAnimMs, suspendSettleMs, INK_THROTTLE_MS };
