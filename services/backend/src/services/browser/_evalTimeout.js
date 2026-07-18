'use strict';

/**
 * _evalTimeout.js — 给 browser session 的 `evaluate()`(在页面上下文 eval 任意脚本)解析
 * **墙钟执行超时**,根治「模型写的脚本含死循环 → 渲染进程 JS 线程被顶死 → page.evaluate 永不
 * resolve → 工具调用卡死」这一类假死。
 *
 * 为什么要它:`page.evaluate` **没有** timeout 选项(Playwright 不支持 in-page 脚本超时)。当被求值的
 * `src` 里有 `while(true){}` / 忙等时,渲染线程被顶满,evaluate 的 promise 永不 settle;调度层那道
 * 120s `Promise.race` 软超时只会 reject 竞赛、**底层被顶死的标签页继续存在**(下一次 evaluate 照样卡)。
 *
 * 逃生机理(关键):被顶死的**渲染线程**无法从 Node 侧中断——`page.reload()` 也要排队进那条被占满的
 * 线程,同样挂。唯一可靠的解法是 `page.close()`:它经由**浏览器进程**(CDP 协议,独立于渲染线程)驱动,
 * 能强杀该标签页并释放资源。被丢弃的 evaluate promise 之后会以「Target closed」reject,调用方须
 * `.catch(()=>{})` 吞掉以免 unhandled rejection。本叶子只解析「是否启用 + 超时 ms」,close/丢页在调用方。
 *
 * 契约(纯叶子):除读 env 外零副作用、绝不抛、确定性。**门控关 ⇒ isEvalTimeoutEnabled 返回 false**,
 * 调用方走**独立的字节回退分支**(今日 `await page.evaluate(...)` 原样),与今日逐字节一致。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_BROWSER_EVAL_TIMEOUT       默认 on —— 总开关;关 → 调用方字节回退今日无超时。
 *   KHY_BROWSER_EVAL_TIMEOUT_MS    默认 15000 —— 墙钟超时毫秒(numeric,clamp[1000, 300000])。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 收敛到 utils/resolveEnv 单一真源(逐字节委托,调用点不变)
const _env = require('../../utils/resolveEnv');

/** 总开关:evaluate 墙钟超时是否启用。默认 on。 */
function isEvalTimeoutEnabled(env) {
  const e = _env(env);
  try {
    const flagRegistry = require('../flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_BROWSER_EVAL_TIMEOUT', e);
  } catch {
    const raw = e && e.KHY_BROWSER_EVAL_TIMEOUT;
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  }
}

/** 墙钟超时(毫秒)。默认 15000,clamp[1000, 300000]。非法 → 默认。 */
function resolveEvalTimeoutMs(env) {
  const e = _env(env);
  try {
    const flagRegistry = require('../flagRegistry');
    const v = flagRegistry.resolveNumeric('KHY_BROWSER_EVAL_TIMEOUT_MS', e);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* fall through */ }
  const raw = Number.parseInt((e && e.KHY_BROWSER_EVAL_TIMEOUT_MS) || '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(300000, Math.max(1000, raw));
  return 15000;
}

module.exports = {
  isEvalTimeoutEnabled,
  resolveEvalTimeoutMs,
};
