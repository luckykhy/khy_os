'use strict';

/**
 * parseRetryAfterCooldown.js — 「Retry-After 值 → 钳制后的冷却毫秒」单一真源(纯)。
 *
 * 收敛 2 处 body 逐字节相同的 apiKeyPool.parseRetryAfter(value)——
 *   services/apiKeyPool(backend) · ai-backend/services/apiKeyPool(跨根)。
 *   两处均引用各自模块常量 BASE_COOLDOWN_MS(10000)/MAX_RETRY_AFTER_MS(600000)——值相同,
 *   但为保「跟随各模块自身常量」语义,消费方经 wrapper 显式传入自己的常量(见下),
 *   而非依赖本 util 默认值。
 *
 * ⚠️ 刻意不并入 retryWithBackoff.parseRetryAfter(err)——那是完全不同的函数(吃 err 读 header、
 *   无 BASE/MAX 钳制、命中返 undefined),属 C 組。
 *
 * 语义:falsy value→base;纯数字秒>0→clamp(base, max, seconds*1000);否则试 HTTP-date,
 *   有效→clamp(base, max, date-now);再否则→base。
 *
 * 契约:纯函数(除读运行时 Date.now())、确定性给定时钟、不 mutate 入参。
 *   各消费方保留同名本地 wrapper `const parseRetryAfter = (value) =>
 *     require('.../parseRetryAfterCooldown')(value, BASE_COOLDOWN_MS, MAX_RETRY_AFTER_MS)`
 *   → 调用点 `parseRetryAfter(retryAfter)` 逐字节不变。
 */

function parseRetryAfterCooldown(value, baseCooldownMs = 10000, maxRetryAfterMs = 600000) {
  if (!value) return baseCooldownMs;
  const asNumber = Number(value);
  if (!isNaN(asNumber) && asNumber > 0) {
    return Math.min(maxRetryAfterMs, Math.max(baseCooldownMs, asNumber * 1000));
  }
  const asDate = new Date(value).getTime();
  if (!isNaN(asDate)) {
    const delta = asDate - Date.now();
    return Math.min(maxRetryAfterMs, Math.max(baseCooldownMs, delta));
  }
  return baseCooldownMs;
}

module.exports = parseRetryAfterCooldown;
