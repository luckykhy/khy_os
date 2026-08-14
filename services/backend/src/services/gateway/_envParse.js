'use strict';

/**
 * _envParse.js — 「env 数值解析」单一真源(纯函数原子层·Batch 2)。
 *
 * 收敛清单(逐字节相同的 2 处私有 helper body):
 *   - aiGateway.js:287 `function _parseMs(raw, fallback, min = 0)`
 *   - adapters/relayApiAdapter.js:151 `function _parseMs(raw, fallback, min = 0)`
 *   两处 body 完全一致:
 *     `parseInt(String(raw ?? fallback), 10)` → 非有限或 <=0 回退 fallback → `Math.max(min, parsed)`。
 *
 * 语义契约(与被收敛副本逐字节一致,勿"顺手修正"):
 *   - `raw ?? fallback`:仅 null/undefined 触发 fallback 参与解析;''、NaN 字符串等
 *     进入 parseInt 后因 !isFinite 回退 fallback。
 *   - `parsed <= 0` 也回退 fallback(0 与负数均视为非法毫秒值)。
 *   - 合法值经 `Math.max(min, parsed)` 抬底,**无上限钳制**。
 *   - 纯函数、确定性、不 mutate、不读 process.env(env 读取留在调用方)。
 *
 * 刻意不收敛(变体登记):
 *   - aiGateway.js `_parsePositiveInt(raw, fallback, min=1, max=16)` vs
 *     relayApiAdapter.js `_parsePositiveInt(raw, fallback, min=1, max=8)`:
 *     body 相同但默认 max 不同(16 vs 8),默认参数属于函数语义 → 非严格等价。
 *   - adapters/_adapterUtils.js `parsePositiveInt(..., max=Infinity)`:第三个默认值变体。
 *   - aiGateway.js `_parseNonNegativeInt`:全仓单实例,无重复,不收敛。
 *   - toolUseLoopCore.js:539 / routes/remoteSsh.js:42 的 `_parsePositiveInt`:
 *     body 不同(String(value||'').trim() / Number.parseInt + 越界返回 max),非同一语义。
 *   - 勘察线索称 claudeAdapter.js 亦有 _parseMs 类副本 — 核实为误报,该文件只有
 *     内联 parseInt 常量初始化,无同名函数定义。
 *
 * 各消费方保留同名本地绑定(`const _parseMs = require('./_envParse')._parseMs;`)
 * → 调用点逐字节不变。
 */

function _parseMs(raw, fallback, min = 0) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(min, parsed);
}

module.exports = { _parseMs };
