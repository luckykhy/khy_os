'use strict';

/**
 * toolChallengeCadence.js — 「每 N 次请求放行一次原生挑战」的节流器。
 *
 * 解决的问题(BUG-014 的最后一环):
 * 一个模型被判 `text`(剥掉 tools + 教文本协议)之后,它的原生 tools 就不会再出现在任何
 * 请求里 —— 于是它**再也没有机会**产生原生 tool_calls 来翻案,只能等 7 天 TTL 到期重测。
 * P1 把 `text` 的门槛抬到了「正文里出现显式调用语法」,假阴性大幅减少,但**没有消除**:
 * 本仓库专门为「按 Claude Code 语料微调过的模型」写了 Format 2c 方言
 * (`ToolName\n{json}`),这类模型完全可能**既能原生调工具、又会把调用写成文本** ——
 * 它们在探测里会命中 `text` 的判据,被正确地判成「文本协议可用」,却也因此被误判为
 * 「不能原生调」。
 *
 * 因此每 N 次请求放行一次**隔离式挑战**:那一次照发 tools。若模型原生调了 → 被动学习
 * 立即晋升 `native`(aiGatewayGenerateMethod 的既有路径),错误结论当场被推翻,不必等 7 天。
 *
 * 为什么是「隔离式」而不是「每轮都发」或「canary 常驻」:
 * 全量发 tools 会让真不支持的工具型通道每次都付 400(退回到 P2 之前的状态);canary 常驻
 * 则要求「发 tools 的同时教文本回退语法」成为常态。隔离式把代价压到 1/N,且不需要改动
 * 提示词侧 —— 教学文案本身是加性的(`prompts.js:_toolCallingFallbackProfile` 标题即
 * `Tool calling (text-based fallback)`),那一轮模型有两条路可走:原生调用,或回退文本
 * 语法,后者照样会被 `resolveToolCalls` 解析执行。所以挑战轮不需要两侧协调,也就没有
 * 失同步风险。
 *
 * 计数粒度是**每 (通道 × 模型) 的请求数**,不是严格意义上的「轮」:一次工具循环里会有多次
 * 请求,本模块按请求采样。这是采样节奏,不是精确的回合语义 —— 取它的理由是简单且可验证。
 *
 * 纯逻辑(decideChallenge / everyRequests / isEnabled)与进程内计数分开:纯函数可单测,
 * 计数是模块级 Map(不落盘 —— 这是采样节奏,不是需要跨进程共享的状态)。
 * 门控 KHY_TOOL_CAP_CHALLENGE 默认开(仅 0/false/off/no 关)。
 */

const DEFAULT_EVERY = 10;
const MIN_EVERY = 2; // 每 1 次都挑战 = 等于不剥离,失去「节流」的意义

// 收敛到 utils/trimLowerNullish 单一真源(逐字节委托,调用点不变)
const _norm = require('../../utils/trimLowerNullish');

/** 进程内计数:key = 通道标识 → 已发生的请求次数。 */
const _counts = new Map();

/**
 * 门控(默认开;仅 0/false/off/no 关,大小写/空白不敏感)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const v = _norm(env && env.KHY_TOOL_CAP_CHALLENGE);
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 间隔(每 N 次请求挑战一次)。env KHY_TOOL_CAP_CHALLENGE_EVERY 可调。
 *
 * 解析语义与同族数值 env(toolCallingProbe.ttlMs / nativeTtlMs)一致:`parseInt`,小数点被
 * 截断('2.9' → 2)。刻意不为它另立一套严格解析 —— 一个模块内的同类开关行为不一致,比
 * 「2.9 被截成 2」更难排查。
 * 非法/小于 MIN_EVERY 回落默认 —— 配置错误不该退化成「每次都挑战」。
 * @param {object} [env]
 * @returns {number}
 */
function everyRequests(env = process.env) {
  const raw = parseInt((env && env.KHY_TOOL_CAP_CHALLENGE_EVERY) || '', 10);
  if (Number.isFinite(raw) && raw >= MIN_EVERY) {
    return raw;
  }
  return DEFAULT_EVERY;
}

/**
 * 纯判定:第 count 次请求是否该挑战。
 * @param {number} count 已含本次的请求序号(≥1)
 * @param {number} every 间隔
 * @param {{enabled?: boolean}} [opts]
 * @returns {boolean}
 */
function decideChallenge(count, every, opts = {}) {
  if (opts && opts.enabled === false) {
    return false;
  }
  const n = Number(count);
  const e = Number(every);
  if (!Number.isFinite(n) || !Number.isFinite(e) || n <= 0 || e < MIN_EVERY) {
    return false;
  }
  return n % e === 0;
}

/**
 * 记一次该通道的请求并判定本次是否挑战。
 * 空 key → 不计数、不挑战(身份不明就别动 wire;fail-safe)。
 * @param {string} key 通道标识(capabilityModelKey.routeKey 的产物)
 * @param {object} [env]
 * @returns {boolean}
 */
function shouldChallenge(key, env = process.env) {
  try {
    const k = _norm(key);
    if (!k || !isEnabled(env)) {
      return false;
    }
    const next = (_counts.get(k) || 0) + 1;
    _counts.set(k, next);
    return decideChallenge(next, everyRequests(env), { enabled: true });
  } catch {
    return false; // 任何异常都不该改变 wire —— 退回到「不挑战」(即按已判定的档位走)
  }
}

/** 测试用:清计数。 */
function _reset() {
  _counts.clear();
}

/** 测试用:读计数。 */
function _countOf(key) {
  return _counts.get(_norm(key)) || 0;
}

module.exports = {
  DEFAULT_EVERY,
  MIN_EVERY,
  isEnabled,
  everyRequests,
  decideChallenge,
  shouldChallenge,
  _reset,
  _countOf,
};
