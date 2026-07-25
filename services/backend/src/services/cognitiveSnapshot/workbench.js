'use strict';

/**
 * workbench.js — 工作台与冷热分层（§3.1，CPU 寄存器模式）。
 *
 * 把模型可用的上下文窗口当作一组极窄的「寄存器」，强制切成三块硬性区域。比例写死、
 * 绝不可越界——任何一区超预算都被判为越界（violation），由上层熔断/压缩处置：
 *
 *   [执行区 EXEC]   40% — 当前步骤的指令、输入输出及最近 1 步结果。
 *   [记忆区 MEMORY] 20% — 核心状态机 + 高频实体词典；**绝不允许存原始长文本**。
 *   [缓冲区 BUFFER] 40% — 预留给模型推理中间态与 API 返回。
 *
 * 本模块是纯预算计算器：不持有对话、不做 I/O。Token 估算复用唯一真源
 * `contextWasm.estimateTokens`（可注入以便测试）。
 */

const ZONES = Object.freeze({ EXEC: 'exec', MEMORY: 'memory', BUFFER: 'buffer' });

// 比例写死（§3.1「绝不可越界」）。三者之和必须恒为 1。
const ZONE_RATIO = Object.freeze({ exec: 0.40, memory: 0.20, buffer: 0.40 });

// 记忆区铁律：单条记忆原始文本上限（字符）。超过即视为「把长文本塞进寄存器」，
// 必须先折叠/卸载（防呆①的记忆区侧防线）。
const MEMORY_RAW_CHAR_CAP = 600;

function _estimator(fn) {
  if (typeof fn === 'function') return fn;
  try { return require('../contextWasm').estimateTokens; }
  catch { return (t) => Math.ceil(String(t || '').length / 4); }
}

/**
 * 按窗口大小切出三区的 token 预算。
 * @param {number} contextWindowTokens 模型可用上下文总 token
 * @returns {{window:number, exec:number, memory:number, buffer:number, ratio:object}}
 */
function partition(contextWindowTokens) {
  const w = Math.max(0, Math.floor(Number(contextWindowTokens) || 0));
  return {
    window: w,
    exec: Math.floor(w * ZONE_RATIO.exec),
    memory: Math.floor(w * ZONE_RATIO.memory),
    buffer: Math.floor(w * ZONE_RATIO.buffer),
    ratio: { ...ZONE_RATIO },
  };
}

/**
 * 测量三区实际占用，给出越界报告。
 * @param {object} zonesText { execText, memoryText, bufferText } 每区当前内容（字符串或可估对象）
 * @param {number} contextWindowTokens
 * @param {object} [opts] { estimateTokensFn }
 * @returns {{
 *   window:number,
 *   budget:{exec:number,memory:number,buffer:number},
 *   used:{exec:number,memory:number,buffer:number,total:number},
 *   ratioUsed:{exec:number,memory:number,buffer:number,total:number},
 *   violations:Array<{zone:string, used:number, budget:number, overBy:number}>,
 *   withinBounds:boolean
 * }}
 */
function measure(zonesText = {}, contextWindowTokens, opts = {}) {
  const est = _estimator(opts.estimateTokensFn);
  const budget = partition(contextWindowTokens);
  const usedExec = est(zonesText.execText || '');
  const usedMem = est(zonesText.memoryText || '');
  const usedBuf = est(zonesText.bufferText || '');
  const total = usedExec + usedMem + usedBuf;

  const violations = [];
  const check = (zone, used, b) => {
    if (b > 0 && used > b) violations.push({ zone, used, budget: b, overBy: used - b });
  };
  check(ZONES.EXEC, usedExec, budget.exec);
  check(ZONES.MEMORY, usedMem, budget.memory);
  check(ZONES.BUFFER, usedBuf, budget.buffer);

  const safe = (n, d) => (d > 0 ? n / d : 0);
  return {
    window: budget.window,
    budget: { exec: budget.exec, memory: budget.memory, buffer: budget.buffer },
    used: { exec: usedExec, memory: usedMem, buffer: usedBuf, total },
    ratioUsed: {
      exec: safe(usedExec, budget.exec),
      memory: safe(usedMem, budget.memory),
      buffer: safe(usedBuf, budget.buffer),
      total: safe(total, budget.window),
    },
    violations,
    withinBounds: violations.length === 0,
  };
}

/**
 * 记忆区不得存原始长文本（§3.1）。返回每条超长记忆的违规项。
 * @param {Array<string>} memoryItems
 * @param {number} [cap=MEMORY_RAW_CHAR_CAP]
 * @returns {Array<{index:number, chars:number, cap:number}>}
 */
function assertNoRawLongText(memoryItems = [], cap = MEMORY_RAW_CHAR_CAP) {
  const out = [];
  memoryItems.forEach((item, i) => {
    const chars = String(item || '').length;
    if (chars > cap) out.push({ index: i, chars, cap });
  });
  return out;
}

module.exports = {
  ZONES,
  ZONE_RATIO,
  MEMORY_RAW_CHAR_CAP,
  partition,
  measure,
  assertNoRawLongText,
};
