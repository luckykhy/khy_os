'use strict';

/**
 * noticeInbox.js — 会话期「宿主想让用户看见、但不能自己写屏」的一行话收件箱。
 *
 * 为什么需要它（BUG-17，`AGENTS.md` §0.9.7 单写者原则）：ink 拥有终端期间，任何绕过
 * 注入流的写入（`process.stderr`、`console._stdout`）都不在 `lastOutputHeight` 账本里，
 * `eraseLines` 永远擦不到 ⇒ 状态栏下方一行永久残影。sessionWatchdog 的诊断行是**给用户看**
 * 的（Rule 3 要求卡死必须如实上报），不能像 winston 那样一静音了事，所以改走这里，
 * 由 TUI 把它落成系统消息区的 notice。
 *
 * 契约：
 *   - `push(line)` 返回 true 表示「已有人在屏幕上安置它」；false 表示无人认领，
 *     调用方**必须**回到自己的旧行为（watchdog → 直写 stderr）。绝不静默丢弃。
 *   - 零 IO、绝不抛；订阅者抛错视为未认领。
 *   - 门控 `KHY_WATCHDOG_NOTICE`（默认开）：显式 `0` → `push` 恒 false ⇒ 逐字节回到今日行为。
 */

const subscribers = new Set();

function _gateOn(env) {
  const raw = String((env || process.env).KHY_WATCHDOG_NOTICE || 'true').toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/**
 * @param {(line: string) => (boolean|void)} fn - 接收一行并把它渲染进消息区；返回 false 表示拒收
 * @returns {() => void} 退订函数
 */
function subscribe(fn) {
  if (typeof fn !== 'function') {
    return () => false;
  }
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** @returns {boolean} 是否已被认领 */
function push(line, env) {
  try {
    if (subscribers.size === 0 || !_gateOn(env)) {
      return false;
    }
    const text = String(line == null ? '' : line).trim();
    if (!text) {
      return false;
    }
    for (const fn of subscribers) {
      try {
        if (fn(text) !== false) {
          return true;
        }
      } catch {
        /* 单个订阅者失败不影响其它订阅者 */
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Test seam: forget all subscribers. */
function resetForTest() {
  subscribers.clear();
}

module.exports = { subscribe, push, resetForTest };
