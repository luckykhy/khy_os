'use strict';

/**
 * ctxWindowStats.js — 上下文窗口「占用率·余量·健康分级」计算的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;env 经入参注入(阈值/回退上限留给调用方)。
 *
 * 背后的逻辑(对齐 Claude Code CtxInspectTool 的上下文检视):把「已用 token / 上限」
 * 折算成 占用百分比 + 剩余 token + 健康分级(healthy/warning/critical),并诚实标注
 * 上限来源(adapter 真值 / env 回退 / 未知)。**绝不硬编码任何 model→上限表** —— 上限由
 * 调用方从 aiGateway 适配器真值传入;缺失时回退到注入的 env.KHY_CONTEXT_WINDOW(默认 128000)。
 * 阈值 env 可覆盖:KHY_CTX_WARN_PCT(默认 75)、KHY_CTX_CRIT_PCT(默认 90)。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器误判幽灵依赖。零依赖。
 */

const _DEFAULT_FALLBACK_LIMIT = 128000;
const _DEFAULT_WARN_PCT = 75;
const _DEFAULT_CRIT_PCT = 90;

/** 安全转非负整数;非有限/负 → 0。 */
function _nonNegInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 从注入 env 解析回退上限(KHY_CONTEXT_WINDOW),无效 → 默认 128000。 */
function _fallbackLimit(env) {
  const raw = env && env.KHY_CONTEXT_WINDOW;
  const n = _nonNegInt(raw);
  return n > 0 ? n : _DEFAULT_FALLBACK_LIMIT;
}

/** 从注入 env 解析百分比阈值;无效/越界 → 默认。 */
function _pct(env, key, dflt) {
  const raw = env && env[key];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return dflt;
  return Math.floor(n);
}

/**
 * 计算上下文窗口统计。纯函数。
 * @param {object} input
 * @param {number} input.used   已用(输入)token 估算
 * @param {number} input.limit  适配器真值上限(0/未知 → 走 env 回退)
 * @param {number} [input.sessionInput]  会话累计输入 token(透传展示)
 * @param {number} [input.sessionOutput] 会话累计输出 token(透传展示)
 * @param {number} [input.requestCount]  会话请求数(透传展示)
 * @param {string} [input.model]         模型名(透传展示)
 * @param {Record<string,string>} [env]  注入环境(默认空对象,绝不读 process.env)
 * @returns {{
 *   used:number, limit:number, limitSource:'adapter'|'env-fallback',
 *   remaining:number, percentUsed:number, status:'healthy'|'warning'|'critical',
 *   warnPct:number, critPct:number,
 *   sessionInput:number, sessionOutput:number, sessionTotal:number,
 *   requestCount:number, model:string
 * }}
 */
function computeContextStats(input = {}, env = {}) {
  const used = _nonNegInt(input.used);
  const adapterLimit = _nonNegInt(input.limit);
  const limit = adapterLimit > 0 ? adapterLimit : _fallbackLimit(env);
  const limitSource = adapterLimit > 0 ? 'adapter' : 'env-fallback';

  const warnPct = _pct(env, 'KHY_CTX_WARN_PCT', _DEFAULT_WARN_PCT);
  const critPct = Math.max(warnPct, _pct(env, 'KHY_CTX_CRIT_PCT', _DEFAULT_CRIT_PCT));

  const remaining = Math.max(0, limit - used);
  const percentUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  let status = 'healthy';
  if (percentUsed >= critPct) status = 'critical';
  else if (percentUsed >= warnPct) status = 'warning';

  const sessionInput = _nonNegInt(input.sessionInput);
  const sessionOutput = _nonNegInt(input.sessionOutput);

  return {
    used,
    limit,
    limitSource,
    remaining,
    percentUsed,
    status,
    warnPct,
    critPct,
    sessionInput,
    sessionOutput,
    sessionTotal: sessionInput + sessionOutput,
    requestCount: _nonNegInt(input.requestCount),
    model: input.model ? String(input.model) : '',
  };
}

module.exports = { computeContextStats };
