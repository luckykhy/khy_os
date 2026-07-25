'use strict';

/**
 * busyInterruptEscalation.js — 纯叶子:决定「忙碌态下重复中断(Ctrl+C / Esc)」何时应从
 * 优雅取消升级为强制终止(hard exit)。零 IO、确定性、绝不抛。
 *
 * 背景(goal 2026-07-11「khy 执行到一半卡住,转圈还在转,Ctrl+C 无法终止,Esc 无法打断」;
 * 后续细化「3 次 Ctrl+C 结束会话」):replSession 的 SIGINT / Esc 处理在 `_busy` 时永远走
 * 「优雅取消 → return」这一条路,从不升级(`_ctrlCCount = 0` 后 return)。于是当优雅取消
 * **没有落地**(适配器忽略 abortSignal、或本轮卡在一个仍让事件循环存活的状态——转圈 spinner 的
 * setInterval 仍在跑就是证据),用户无论按多少次 Ctrl+C / Esc 都无法强制终止。这个叶子提供确定性的
 * 「同窗口内累计按 N 次(默认 3)即强杀」逃生阀策略:前几次先尝试优雅打断,第 3 次仍忙 = 逃生阀触发。
 *
 * 契约:纯函数,不读 env(env 由调用方解析并作为参数传入,便于单测);任何坏输入 → 安全默认。
 * 门控 `KHY_BUSY_FORCE_EXIT`(默认开)由 `busyForceExitEnabled` 读取;关 → 调用方逐字节回退到
 * 原有「只优雅取消、永不升级」的行为(shouldForceExit 恒为 false 由调用方保证)。
 *
 * @module cli/repl/busyInterruptEscalation
 */

const _FALSY = ['0', 'false', 'off', 'no'];

const DEFAULT_PRESSES = 3;      // 「3 次 Ctrl+C 结束会话」= 用户原话;前 2 次先尝试优雅打断
const DEFAULT_WINDOW_MS = 3000; // 连按须落在同一窗口内,避免误伤(慢速偶发单按)
const MIN_PRESSES = 2;          // 至少 2 次:第 1 次永远先尝试优雅取消
const MAX_PRESSES = 10;         // 上限防呆(配置写离谱值时收敛)
const MIN_WINDOW_MS = 500;
const MAX_WINDOW_MS = 30000;

/**
 * 门控:忙碌态强制退出是否启用。默认开;仅显式 0/false/off/no 关。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function busyForceExitEnabled(env = process.env) {
  try {
    const v = env && env.KHY_BUSY_FORCE_EXIT;
    if (v === undefined || v === null) return true;
    return !_FALSY.includes(String(v).trim().toLowerCase());
  } catch { return true; }
}

/**
 * 解析升级阈值(累计按几次即强杀)。默认 3,收敛到 [MIN_PRESSES, MAX_PRESSES]。坏输入 → 默认。
 * @param {object} [env=process.env]
 * @returns {number}
 */
function resolveThreshold(env = process.env) {
  try {
    const raw = env && env.KHY_BUSY_FORCE_EXIT_PRESSES;
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PRESSES;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return DEFAULT_PRESSES;
    return Math.min(MAX_PRESSES, Math.max(MIN_PRESSES, n));
  } catch { return DEFAULT_PRESSES; }
}

/**
 * 解析升级时间窗口(ms)。默认 3000,收敛到 [MIN_WINDOW_MS, MAX_WINDOW_MS]。坏输入 → 默认。
 * @param {object} [env=process.env]
 * @returns {number}
 */
function resolveWindowMs(env = process.env) {
  try {
    const raw = env && env.KHY_BUSY_FORCE_EXIT_WINDOW_MS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_WINDOW_MS;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return DEFAULT_WINDOW_MS;
    return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, n));
  } catch { return DEFAULT_WINDOW_MS; }
}

/**
 * 纯状态机:给定上一次忙碌中断状态与当前时刻,算出新状态及是否应强制退出。
 *
 * 语义:
 *   - 若当前按键距上次按键超过 windowMs(或无历史),视为新序列,count 归 1(本次仍是第 1 次,
 *     先走优雅取消)。
 *   - 否则同一窗口内连按,count 递增。
 *   - count >= threshold → shouldForceExit=true(默认第 3 次仍忙 = 逃生阀触发)。
 *
 * 绝不抛:任何坏 prev/now/opts → 保守当作「第 1 次、不强杀」。
 *
 * @param {{count?:number,lastTs?:number}|null} prev 上一次状态(count/lastTs)
 * @param {number} now 当前时间戳(ms,通常 Date.now())
 * @param {{threshold?:number,windowMs?:number}} [opts]
 * @returns {{count:number,lastTs:number,shouldForceExit:boolean}}
 */
function nextBusyInterruptState(prev, now, opts = {}) {
  try {
    const t = Number.isFinite(now) ? now : 0;
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_PRESSES;
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
    const prevCount = (prev && Number.isFinite(prev.count)) ? prev.count : 0;
    const prevTs = (prev && Number.isFinite(prev.lastTs)) ? prev.lastTs : 0;

    let count;
    if (prevCount <= 0 || prevTs <= 0 || (t - prevTs) > windowMs) {
      count = 1; // 新序列:本次是第 1 次
    } else {
      count = prevCount + 1; // 同窗口连按(累计)
    }
    return { count, lastTs: t, shouldForceExit: count >= threshold };
  } catch {
    return { count: 1, lastTs: 0, shouldForceExit: false };
  }
}

module.exports = {
  DEFAULT_PRESSES,
  DEFAULT_WINDOW_MS,
  MIN_PRESSES,
  MAX_PRESSES,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  busyForceExitEnabled,
  resolveThreshold,
  resolveWindowMs,
  nextBusyInterruptState,
};
