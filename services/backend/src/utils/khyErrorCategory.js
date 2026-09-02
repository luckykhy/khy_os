'use strict';

/**
 * khyErrorCategory.js — 错误分类与严重度的单一真源（纯叶子，零依赖）。
 *
 * 五问决策树：
 *   1. 用户错了？        → user      (warn)
 *   2. 配置错了？        → config    (warn)
 *   3. 没权/未登录？     → auth      (error)
 *   4. 网络/对端的事？   → network | upstream (error | warn)
 *   5. 本地 IO？         → io        (error)
 *   6. 系统资源？        → resource  (fatal)
 *   7. 我自己的 bug？    → internal  (fatal)
 *   8. 说不清？          → unknown   (error)
 *
 * severity 不是调用方传的，是从 category + 可恢复性自动派生 —— 调用方不应再
 * 决定「这是 warn 还是 error」，这正是混乱点 #3 的根因。
 */

const CATEGORIES = Object.freeze({
  USER:      { code: 'user',     label: '用户输入',     defaultSeverity: 'warn',   recoverable: true,  retryable: false },
  CONFIG:    { code: 'config',   label: '配置问题',     defaultSeverity: 'warn',   recoverable: true,  retryable: false },
  AUTH:      { code: 'auth',     label: '鉴权失败',     defaultSeverity: 'error',  recoverable: false, retryable: true  },
  NETWORK:   { code: 'network',  label: '网络层',       defaultSeverity: 'error',  recoverable: true,  retryable: true  },
  UPSTREAM:  { code: 'upstream', label: '上游服务',     defaultSeverity: 'warn',   recoverable: true,  retryable: true  },
  IO:        { code: 'io',       label: '本地IO',       defaultSeverity: 'error',  recoverable: false, retryable: true  },
  RESOURCE:  { code: 'resource', label: '系统资源',     defaultSeverity: 'fatal',  recoverable: false, retryable: false },
  INTERNAL:  { code: 'internal', label: '内部错误',     defaultSeverity: 'fatal',  recoverable: false, retryable: false },
  UNKNOWN:   { code: 'unknown',  label: '未分类',       defaultSeverity: 'error',  recoverable: false, retryable: false },
});

const SEVERITIES = Object.freeze({
  SILENT: { code: 'silent', rank: 0, label: 'silent',  icon: '',    color: 'dim'    },
  INFO:   { code: 'info',   rank: 1, label: 'info',    icon: 'ℹ',   color: 'blue'   },
  WARN:   { code: 'warn',   rank: 2, label: 'warn',    icon: '⚠',   color: 'yellow' },
  ERROR:  { code: 'error',  rank: 3, label: 'error',   icon: '✗',   color: 'red'    },
  FATAL:  { code: 'fatal',  rank: 4, label: 'fatal',   icon: '✗',   color: 'red.bold' },
});

// 已登记的 (category, code) 子分类映射，用于归类器推断时精确定位。
// 一条 khyError.code 进来后，先看有没有直接命中 SUB_CATEGORY，没命中再走
// err.code / status / 关键词的启发式，最后才落到 CATEGORIES[category] 的默认值。
const SUB_CATEGORIES = Object.freeze({
  // user —— 用户操作不当
  INVALID_ARGUMENT:     { category: 'user',     severity: 'warn'  },
  MISSING_REQUIRED:     { category: 'user',     severity: 'warn'  },
  COMMAND_NOT_FOUND:    { category: 'user',     severity: 'warn'  },
  // config —— 配置问题
  CONFIG_INVALID:       { category: 'config',   severity: 'warn'  },
  CONFIG_MISSING:       { category: 'config',   severity: 'warn'  },
  PORT_IN_USE:          { category: 'config',   severity: 'error' },
  // auth —— 鉴权/权限
  AUTH_REQUIRED:        { category: 'auth',     severity: 'error' },
  AUTH_INVALID:         { category: 'auth',     severity: 'error' },
  PERMISSION_DENIED:    { category: 'auth',     severity: 'error' },
  PAIRING_EXPIRED:      { category: 'auth',     severity: 'warn'  },
  // network —— 网络层
  NETWORK_UNREACHABLE:  { category: 'network',  severity: 'error' },
  DNS_FAILED:           { category: 'network',  severity: 'error' },
  TIMEOUT:              { category: 'network',  severity: 'warn'  },
  CORS_BLOCKED:         { category: 'network',  severity: 'error' },
  // upstream —— 第三方/AI 服务方
  RATE_LIMITED:         { category: 'upstream', severity: 'warn'  },
  MODEL_NOT_FOUND:      { category: 'upstream', severity: 'warn'  },
  CONTEXT_TOO_LONG:     { category: 'upstream', severity: 'warn'  },
  MODEL_OVERLOADED:     { category: 'upstream', severity: 'warn'  },
  MODEL_REFUSAL:        { category: 'upstream', severity: 'warn'  },
  BILLING_REQUIRED:     { category: 'upstream', severity: 'warn'  },
  UPSTREAM_5XX:         { category: 'upstream', severity: 'warn'  },
  // io —— 本地
  IO_FAILED:            { category: 'io',       severity: 'error' },
  // resource —— 系统资源
  OOM:                  { category: 'resource', severity: 'fatal' },
  // internal —— 我自己的 bug
  ASSERTION:            { category: 'internal', severity: 'fatal' },
  UNHANDLED:            { category: 'internal', severity: 'fatal' },
  // 兜底
  UNKNOWN:              { category: 'unknown',  severity: 'error' },
});

/** 从 category 名查 spec；非法输入落到 UNKNOWN。 */
function getCategorySpec(categoryCode) {
  if (typeof categoryCode !== 'string') return CATEGORIES.UNKNOWN;
  const norm = categoryCode.toUpperCase();
  return CATEGORIES[norm] || CATEGORIES.UNKNOWN;
}

/** 从 severity 名查 spec；非法输入落到 ERROR。 */
function getSeveritySpec(severityCode) {
  if (typeof severityCode !== 'string') return SEVERITIES.ERROR;
  const norm = severityCode.toUpperCase();
  return SEVERITIES[norm] || SEVERITIES.ERROR;
}

/** 给一条 (category, code)，查子分类。找不到就返回 null，由归类器兜底。 */
function getSubCategory(code) {
  if (typeof code !== 'string') return null;
  return SUB_CATEGORIES[code.toUpperCase()] || null;
}

/**
 * 列出所有已登记的 (category, code) 对，供各端做翻译表 / 文档 / 校验用。
 * 返回 [{ code, category, severity, ...spec }]
 */
function listSubCategories() {
  return Object.entries(SUB_CATEGORIES).map(([code, spec]) => ({
    code,
    category: spec.category,
    severity: spec.severity,
  }));
}

module.exports = {
  CATEGORIES,
  SEVERITIES,
  SUB_CATEGORIES,
  getCategorySpec,
  getSeveritySpec,
  getSubCategory,
  listSubCategories,
};