'use strict';

/**
 * spinnerTokenLazy — gate helper deciding WHETHER the live spinner needs to
 * estimate streamed tokens on this render (goal「khy 动画/输入体验卡顿,无法做
 * 真正的软件项目」).
 *
 * 背景:`App._spinnerProgress` 在 App **渲染体内**(App.js:2239)被调用,即忙碌时
 * 每帧(streaming ~25fps + 1s nowTick 心跳)都跑一次,而它每次对**整条累积**
 * `streaming.text` 逐字符跑 `_estimateTok`(tokenizer / string-width 级)重估 token 数。
 * 但这个 token 数只在 spinner meta **被揭示**时才显示——`Spinner.buildSpinnerMeta`
 * 复用 `cli/spinnerMeta.shouldShowTimerAndTokens`:前 30s(SHOW_TOKENS_AFTER_MS)
 * meta 隐藏,`buildSpinnerMeta` 直接 `return ''` **根本不读 tokens**。所以短回合 /
 * 每个回合的前 30s 里,那一整条 buffer 的逐帧重估纯属浪费,且随回答变长 O(n)/帧 →
 * O(n²)/turn = 长回答打字/spinner 发卡的又一处来源。
 *
 * 本叶子把「是否需要估算」判据抽成纯函数,**逐字节镜像** buildSpinnerMeta 的揭示门:
 * 仅当揭示门**确定性地返回 false(meta 隐藏)**时才跳过估算(此时渲染层丢弃 tokens,
 * 字节安全)。任何不确定(门控关 / spinnerMeta 叶子不可用 / 抛错)→ 保守估算,逐字节
 * 回退今日行为。契约:零 IO、确定性、绝不抛。
 *
 * 门控 KHY_SPINNER_TOKEN_LAZY(默认开):关 → 恒返 true(每帧照常估算 = 逐字节回退)。
 */

const { isFlagEnabled } = require('../../../services/flagRegistry');

function isSpinnerTokenLazyEnabled(env = process.env) {
  try { return isFlagEnabled('KHY_SPINNER_TOKEN_LAZY', env); }
  catch { return true; }
}

/**
 * 本帧的 live spinner 是否需要估算流式 token 数。
 *
 * 保守铁律:只有在**确定** spinner meta 隐藏(揭示门返回 false)时才返回 false 跳过;
 * 门控关 / spinnerMeta 叶子缺失 / 任何异常 → 返回 true(照常估算 = 现状)。这样跳过
 * 永远与 buildSpinnerMeta「隐藏时不读 tokens」逐字节等价,绝不改变可见输出。
 *
 * @param {{elapsedSec?:number, env?:object}} [opts]
 * @returns {boolean} true=需要估算(现状);false=可安全跳过(meta 隐藏)
 */
function shouldEstimateSpinnerTokens(opts = {}) {
  const o = opts || {};
  const env = o.env || process.env;
  // 门控关 → 逐字节回退:恒估算。
  if (!isSpinnerTokenLazyEnabled(env)) return true;
  try {
    const sm = require('../../spinnerMeta');
    const elapsedMs = (Number(o.elapsedSec) || 0) * 1000;
    // 复用同一揭示判据(同一 SSOT),绝不另造阈值。仅在**确定隐藏**时跳过。
    const shown = sm.shouldShowTimerAndTokens({ elapsedMs, gateEnabled: sm.isEnabled(env) });
    return shown !== false ? true : false;
  } catch {
    // spinnerMeta 叶子不可用 → 与 buildSpinnerMeta 的 try/catch「跌穿到显示」对称:
    // 保守估算(现状),绝不因加载失败而静默吞掉 token 提示。
    return true;
  }
}

module.exports = { isSpinnerTokenLazyEnabled, shouldEstimateSpinnerTokens };
