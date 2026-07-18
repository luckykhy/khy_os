'use strict';

/**
 * query/continuation.js — 续接策略**单一真源**。
 *
 * 当 khy 的回复因可恢复异常（空响应 / 网络熔断 / 截断）提前结束时，本模块统一回答
 * 三个问题：
 *   1. 用户这句是不是「继续」指令？            → isContinuationCommand
 *   2. 这类错误能不能续接（说「继续」推进）？   → isResumableError / NON_RESUMABLE
 *   3. 系统该自动无感续写几轮？                  → maxAutoResume()
 *
 * 设计原则（"激进无感"）：所有**可恢复**错误先自动续写 maxAutoResume() 轮，耗尽后才把
 * 精准原因 + 续接提示交还用户。安全中断 / 权限拦截**绝不**自动续接。
 *
 * 与 failsafe/errorCodes.js 的关系：errorCodes 是"错误码 → resumable"的真源；本模块是
 * "errorType 字符串（适配器/循环层用的口语化类型）→ resumable"的真源。二者互补：
 * 凡是落到 errorCodes 的走那边的 resumable 字段，凡是循环内裸的 errorType 走这里。
 */

/**
 * 不可自动续接 / 不可「继续」的错误类型（口语化 errorType，来自适配器与循环层）。
 * 与 errorCodes 的 E02(安全)/E07(权限) 对齐：内容安全、权限/审批拒绝绝不重试或续写。
 */
const NON_RESUMABLE_ERROR_TYPES = new Set([
  'content_filter',   // E02 内容安全策略中断
  'safety',           // 安全停机的别名
  'refusal',          // 模型显式拒答（语义拒绝，重试无意义且可能违规）
  'permission',       // E07 权限拦截
  'permission_denied',
  'approval_denied',  // 审批网关拒绝
  'blocked',          // 通用阻断
  'context_overflow', // E03 上下文溢出，须先压缩
  'context_length_exceeded',
]);

/** 默认自动续写轮数；可由 KHY_AUTO_RESUME_ATTEMPTS 覆盖（0=关闭无感续接）。 */
const DEFAULT_AUTO_RESUME_ATTEMPTS = 2;

/** 通用续接提示（错误码无 continueHint 时的兜底文案）。 */
const CONTINUE_HINT = '输入「继续」即可从断点续写未完成的内容。';

/**
 * 读取自动续写轮数上限。
 * - 未设置 → DEFAULT_AUTO_RESUME_ATTEMPTS
 * - 非法 / 负数 → DEFAULT
 * - 0 → 关闭无感续接（仍可手动说「继续」）
 * 上限钳到 5，防止无界续写烧 token。
 */
function maxAutoResume() {
  const raw = process.env.KHY_AUTO_RESUME_ATTEMPTS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_AUTO_RESUME_ATTEMPTS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTO_RESUME_ATTEMPTS;
  return Math.min(Math.floor(n), 5);
}

/**
 * 这类错误是否可自动续接 / 可说「继续」推进。
 * 默认**乐观**（未知类型按可续接处理，配合有界重试不会失控）；只有明确落在
 * NON_RESUMABLE_ERROR_TYPES 的安全/权限/溢出类返回 false。
 */
function isResumableError(errorType) {
  if (!errorType) return true; // 无类型（纯截断/空响应）默认可续
  return !NON_RESUMABLE_ERROR_TYPES.has(String(errorType).trim().toLowerCase());
}

/**
 * 检测用户输入是否为简短「继续」指令："继续 / 接着 / go on / continue" 等。
 * 单一真源——cli/ai.js、repl.js、toolUseLoop 等处统一引用本函数，避免正则各处分叉。
 * 超过 30 字视为新指令（含"继续"二字的正常句子不应误判为续接）。
 */
function isContinuationCommand(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 30) return false;
  return /^(继续|接着|go\s*on|keep\s*going|continue|接着做|继续执行|接着来|往下)[\s。.!！？?]*$/i.test(t);
}

/**
 * 从一次 failsafe 归因对象取"如何继续"的提示文案；resumable=false 返回 null。
 * 优先用归因自带的 continueHint，缺失时回落通用 CONTINUE_HINT。
 */
function continueHintFor(attribution) {
  if (!attribution || attribution.resumable === false) return null;
  if (attribution.resumable === true) {
    return attribution.continueHint || CONTINUE_HINT;
  }
  return null;
}

module.exports = {
  NON_RESUMABLE_ERROR_TYPES,
  DEFAULT_AUTO_RESUME_ATTEMPTS,
  CONTINUE_HINT,
  maxAutoResume,
  isResumableError,
  isContinuationCommand,
  continueHintFor,
};
