'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子**：零 IO、确定性、绝不抛（坏输入返安全默认）、可单测。
//   判定/文案全在叶子里；重试执行（IO）由接线处（toolUseLoopCore 并行/串行执行路径）施加。
//   形状对齐 taskClosure.js / goalStopGate.js —— 单一职责叶子 + 接线处 fail-soft。

/**
 * toolFailureRecovery.js — 单次工具执行失败的**多分支恢复裁决器**（Branch ladder）。
 *
 * ── 根因（为什么工具失败只有一条路）──────────────────────────────────────
 * 盘点结论（2026-08）：循环层对「通道级/输出级」故障（transient/empty/截断/解析/doom）
 * 已织成密集的有界恢复网，但对「单次工具执行失败」这一层，行动分支只有 3 个硬编码特例
 * （shell→open_app、shell→web_search/search/toolSearch、write/edit 失败→read_file 回读），
 * 其余一律收敛为「failed 条目 + 错误文本回灌模型，等模型自己改」。工具超时结果被
 * toolCalling 层塑成 retryable，但循环层**没有任何自动重跑分支**——retryable 标记无人消费。
 *
 * ── 本叶子的分支梯子（确定性、有界、无需模型参与）────────────────────────
 *   Branch R（retry）  : 瞬态失败（retryable 标记 / TIMEOUT·NETWORK_ERROR 码 / 瞬态文本特征）
 *                        且工具在只读白名单（幂等，重跑无副作用风险）且预算未耗尽
 *                        → 原调用自动重跑一次；非只读工具绝不自动重跑（副作用不可重复）。
 *   Branch H（honest） : 其余失败原样放行（错误文本回灌模型 + 既有意图等价替换/平台提示钩子
 *                        已在其前），由模型决定换参/换工具/拆步——这是安全默认。
 *
 * 预算：KHY_TOOL_TRANSIENT_RETRY_MAX（默认 2，clamp [0,5]），由接线处以计数器落地；
 *       每次自动重跑计 1 次，耗尽即 Branch H，绝不无限重跑。
 */

const _str = require('../utils/toStr').toStr;

// ── 瞬态工具失败信号 ────────────────────────────────────────────────────
// toolError.js ERROR_CODES 中「同一调用重跑可能成功」的两类；其余五类是**确定性失败**
// （权限/参数/资源缺失/工具不存在/依赖缺失），重跑无意义——各自已有专门恢复流（deny
// fallback / 意图等价替换 / 依赖自愈）。确定性码**优先于** retryable 标记与文本特征：
// 上游误标 retryable 的 INVALID_ARGS 不得触发自动重跑（分支准确性红线）。
const TRANSIENT_TOOL_CODES = new Set(['TIMEOUT', 'NETWORK_ERROR']);
const NON_TRANSIENT_TOOL_CODES = new Set([
  'PERMISSION_DENIED',
  'INVALID_ARGS',
  'RESOURCE_NOT_FOUND',
  'TOOL_UNAVAILABLE',
  'MISSING_DEPENDENCY',
]);

// 结构化 error 缺失时的文本特征兜底（工具返回 {success:false, error:'<string>'} 形态）。
const TRANSIENT_TEXT_RE =
  /(timed?\s?out|timeout|etimedout|econnreset|econnrefused|econnaborted|ehostunreach|enetunreach|socket\s+hang\s+up|rate\s*limit|too\s+many\s+requests|\b429\b|\b529\b|overloaded|temporarily\s+unavailable|service\s+unavailable|\b503\b|network\s+(?:error|issue|failure)|connection\s+(?:reset|refused|closed|aborted))/i;

// **负向守卫**（优先于正向文本特征）：确定性失败签名一旦命中即判非瞬态——即使错误
// 文本里顺带出现 timeout/network 字样（如 "invalid argument: timeoutMs must be < 120000"
// 不得因 "timeout" 误判瞬态而空跑一次重试）。分支准确性靠它兜底。
const NOT_TRANSIENT_TEXT_RE =
  /(permission\s+denied|access\s+denied|\bdenied\b|not\s+found|\benoent\b|eperm|eacces|invalid\s+(?:argument|arguments|param|parameter|tool|json)|missing\s+(?:required\s+)?(?:param|parameter|argument|field|key)|no\s+such\s+(?:file|command|tool|process|column|table)|does\s+not\s+exist|unexpected\s+token|cannot\s+read\s+propert|is\s+not\s+a\s+function|syntaxerror|json\s+parse|schema\s+validation|required\s+(?:param|argument|field))/i;

/** 原始错误文本是否命中瞬态特征（chat() 意外抛出等无结构化 error 形态用）。纯函数、绝不抛。 */
function isTransientText(text) {
  const s = _str(text);
  if (NOT_TRANSIENT_TEXT_RE.test(s)) {
    return false;
  }
  return TRANSIENT_TEXT_RE.test(s);
}

/** 工具执行结果是否为「瞬态失败」（确定性码优先 → 负向/正向文本兜底）。纯函数、绝不抛。 */
function isTransientToolFailure(result) {
  if (!result || result.success !== false) {
    return false;
  }
  const err = result.error;
  if (err && typeof err === 'object') {
    const code = String(err.code || '').toUpperCase();
    // 确定性码优先：上游误标 retryable 也不自动重跑（分支准确性红线）。
    if (NON_TRANSIENT_TOOL_CODES.has(code)) {
      return false;
    }
    if (TRANSIENT_TOOL_CODES.has(code)) {
      return true;
    }
    if (err.retryable === true) {
      return true;
    }
  }
  const text = err && typeof err === 'object' ? _str(err.message) : _str(err);
  return isTransientText(text);
}

// ── 只读白名单（自动重跑安全性门槛）─────────────────────────────────────
// 与 toolUseLoopCore 的 DEDUP_READ_ONLY_TOOLS / IDLE_READ_ONLY_TOOLS 口径一致（读态、
// 幂等、重跑无副作用），另含 web_fetch（GET 语义）。**写类工具（write/edit/shell/
// install/交易…）绝不自动重跑**——副作用不可重复，失败一律交回模型裁决（Branch H）。
const READ_ONLY_RETRY_TOOLS = new Set([
  'read_file',
  'readfile',
  'readFile',
  'read',
  'grep',
  'rg',
  'search',
  'glob',
  'find',
  'ls',
  'LS',
  'list_dir',
  'listdir',
  'quote',
  'data_fetch',
  'web_search',
  'webSearch',
  'websearch',
  'web_fetch',
  'webFetch',
  'webfetch',
  'git_status',
  'git_diff',
  'git_log',
  'tool_search',
  'toolSearch',
  'toolsearch',
  'GetLocation',
  'getLocation',
]);

function isReadOnlyToolName(toolName) {
  return READ_ONLY_RETRY_TOOLS.has(_str(toolName).trim());
}

/**
 * 解析工具级瞬态重试预算：优先 env KHY_TOOL_TRANSIENT_RETRY_MAX，clamp [0,5]，默认 2。
 * 纯函数。
 * @param {object} [env]
 * @returns {number}
 */
function resolveMaxToolRetries(env) {
  const e = env || process.env || {};
  const n = Number.parseInt(_str(e.KHY_TOOL_TRANSIENT_RETRY_MAX).trim(), 10);
  if (Number.isFinite(n) && n >= 0) {
    return Math.min(n, 5);
  }
  return 2;
}

/**
 * 单次工具失败的多分支裁决（Branch ladder 首层）。纯函数、绝不抛。
 *
 * @param {object} args
 * @param {string} [args.toolName]   - 工具名
 * @param {object} [args.result]     - 本次执行结果（失败形态）
 * @param {number} [args.retriesUsed]- 本循环已用自动重跑次数
 * @param {object} [args.env]
 * @returns {{action:'retry'|'honest', reason:string}}
 *   - retry : 瞬态失败 + 只读工具 + 预算未耗尽 → 接线处原调用自动重跑一次
 *   - honest: 其余 → 原失败结果放行（错误文本回灌模型，交模型裁决换参/换工具/拆步）
 */
function decideToolRecovery({ toolName, result, retriesUsed, env } = {}) {
  if (!result || result.success !== false) {
    return { action: 'honest', reason: 'not-failed' };
  }
  if (result.denied === true) {
    return { action: 'honest', reason: 'permission-denied' };
  }
  if (!isTransientToolFailure(result)) {
    return { action: 'honest', reason: 'not-transient' };
  }
  if (!isReadOnlyToolName(toolName)) {
    // 非只读工具的瞬态失败（如 shell 超时）：自动重跑有副作用重复风险 → 交回模型。
    return { action: 'honest', reason: 'not-read-only' };
  }
  const used = Number(retriesUsed) || 0;
  if (used >= resolveMaxToolRetries(env)) {
    return { action: 'honest', reason: 'budget-exhausted' };
  }
  return { action: 'retry', reason: 'transient-read-only' };
}

module.exports = {
  isTransientToolFailure,
  isTransientText,
  isReadOnlyToolName,
  resolveMaxToolRetries,
  decideToolRecovery,
  TRANSIENT_TOOL_CODES,
  NON_TRANSIENT_TOOL_CODES,
  READ_ONLY_RETRY_TOOLS,
};
