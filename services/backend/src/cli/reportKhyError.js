'use strict';

/**
 * reportKhyError.js — 错误结构化打印的单一真源。
 *
 * 设计目标：替代混乱点 #3（93 处 printError(\`xxx: ${err.message}\`)），
 * 让所有错误经过同一道闸门，按 severity 自动选渲染形态。
 *
 *   silent  → 仅审计，不打印
 *   info    → printInfo 单行  ℹ
 *   warn    → printWarn 单行  ⚠
 *   error   → printErrorPanel 红框面板（带 reason / suggestions）
 *   fatal   → printErrorPanel 红框 + fatal 横幅；非交互模式触发 exit
 *
 * ctx 形参 = { action, target, progress, interactive }：
 *   - 严格遵循 AGENTS.md Rule 2「动作 + 目标 + 进度」三件套。
 *   - interactive 由调用方传，缺省 = 当前 TTY 检测。
 *
 * 与既有入口的关系：
 *   - 替代 services/cli/cliErrorReporter.js 的散点调用 —— 后者只
 *     describeCliError → printErrorPanel 这条窄路径，category / severity
 *     都不感知。
 *   - 不替代 services/cli/formatters.printErrorPanel —— 那是底层渲染器，
 *     reportKhyError 是上游调度。
 *   - 自动走 redactSensitiveText 脱敏，混乱点 #5 一并解决。
 */

const { ensureKhyError } = require('../utils/classifyKhyError');
const { CATEGORIES, SEVERITIES, getCategorySpec, getSeveritySpec } = require('../utils/khyErrorCategory');
const { redactSensitiveText } = require('../services/errorClassifier');
const formatters = require('./formatters');
const crashRecovery = require('../services/crashRecovery');

// formatters.printErrorPanel 需要 chalkCompat 引导（chalk.red.bold 链式调用）。
// 在测试 / REPL 引导外被 require 时，bootstrap 必须先跑；这里 lazy-load 防
// 循环依赖 + 让调用方有控制权。
let _bootstrap = null;
function _loadBootstrap() {
  if (_bootstrap === null) {
    try { _bootstrap = require('../bootstrap/chalkCompat.js'); }
    catch (_) { _bootstrap = {}; }
  }
  return _bootstrap;
}

/**
 * 把七件套压成 printErrorPanel 期望的 {title,message,reason,suggestions,stack}。
 * 标题形如：「✗ 配置问题 · API_KEY_MISSING」——一眼看到分类与错误码。
 */
function _envelopeToPanel(env) {
  const catSpec = getCategorySpec(env.category);
  const title = `${catSpec.label} · ${env.code}`;
  const reason = env.message || env.code;
  const hint = env.hint ? `提示：${env.hint}` : '';
  const suggestions = [];
  if (hint) suggestions.push(hint);
  if (Array.isArray(env.suggestions)) {
    for (const s of env.suggestions) suggestions.push(s);
  }
  // 关键设计：面板上**不再附 stack**，把 stack 留在日志。CLI 用户在终端看
  // 不到完整 stack（除非开 `--verbose`），避免 200+ 行的 stack 把终端滚满。
  // 与既有 printErrorPanel 的 stack 字段约定保持兼容，留 null。
  return { title, message: reason, suggestions: suggestions.length ? suggestions : undefined, stack: null };
}

/**
 * 主入口：把任意错误按 severity 渲染到 stdout。
 *
 * @param {*} err - 任意 throw 值
 * @param {object} [ctx]
 * @param {string} [ctx.action]   - 正在做的动作（"刷新模型"）
 * @param {string} [ctx.target]   - 操作的目标（"Claude Adapter"）
 * @param {string} [ctx.progress] - 进度（"第 2/3 次重试"）
 * @param {boolean} [ctx.interactive] - 是否在交互式会话；缺省 = !!process.stdin.isTTY
 * @param {string} [ctx.fallbackCode] - 无法判定时使用的 code
 * @returns {Error & KhyErrorShape} 规整后的 env，方便调用方继续传
 */
function reportKhyError(err, ctx = {}) {
  _loadBootstrap();
  const interactive = ctx.interactive != null ? !!ctx.interactive : !!(process.stdin && process.stdin.isTTY);
  const env = ensureKhyError(err, { fallbackCode: ctx.fallbackCode });

  // silent：审计但不打。
  if (env.severity === 'silent') {
    return env;
  }

  // 脱敏：err.message / err.hint 可能含 Bearer / sk-xxx / 绝对路径。
  const safeMessage = redactSensitiveText(env.message || env.code);
  const safeHint = env.hint ? redactSensitiveText(env.hint) : '';
  env.message = safeMessage;
  env.hint = safeHint;

  // 按 severity 选渲染形态。
  const sevSpec = getSeveritySpec(env.severity);
  const catSpec = getCategorySpec(env.category);
  const ctxPrefix = _formatContext(ctx);
  const codeTag = `[${env.code}]`;

  if (env.severity === 'info') {
    formatters.printInfo(`${ctxPrefix}${codeTag} ${safeMessage}`, catSpec.label);
    return env;
  }
  if (env.severity === 'warn') {
    formatters.printWarn(`${ctxPrefix}${codeTag} ${safeMessage}`);
    if (safeHint) formatters.printInfo(safeHint, '提示');
    return env;
  }
  // error / fatal：面板
  const panelOpts = _envelopeToPanel(env);
  if (ctxPrefix) panelOpts.message = `${ctxPrefix}${panelOpts.message}`;
  formatters.printErrorPanel(panelOpts);

  if (env.severity === 'fatal') {
    if (!interactive) {
      // 非交互模式：fatal 直接走进程退出，避免后台 daemon 吞错。
      // 给一个短暂延时让 stdout 刷掉，与既有 _emitFatal 行为一致。
      setImmediate(() => process.exit(1));
    } else {
      // 交互模式：面板里打完后让 crashRecovery 决定是否升级到 fatal 横幅。
      // 不在这里再调 crashRecovery.handle —— 避免与 4 套 unhandledRejection
      // 处理器重复打。简化处理：打印一行 fatal 横幅。
      formatters.printError('致命错误：会话可能不稳定，建议重启');
    }
  }
  return env;
}

/**
 * 把 ctx 三件套渲染成「（动作 → 目标（进度））」前缀。
 * 任何字段缺失就降级，整体空字符串时返回空串（不破坏现有打印）。
 */
function _formatContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const parts = [];
  if (ctx.action) parts.push(String(ctx.action));
  if (ctx.target) parts.push(`→ ${ctx.target}`);
  if (ctx.progress) parts.push(`（${ctx.progress}）`);
  if (parts.length === 0) return '';
  return `${parts.join(' ')} `;
}

/**
 * 给一组错误做合并打印（窗口内同类只打一次，最后打面板）——
 * 供 AI 错误归并窗口 (KHY_ERROR_MERGE_WINDOW_MS) 的复用入口。
 *
 * @param {Error[]} errors - 窗口内累积的同类错误
 * @param {object} [ctx]
 */
function reportKhyErrorMerged(errors, ctx = {}) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  if (errors.length === 1) return reportKhyError(errors[0], ctx);
  // 同类合并：第一条做完整面板，剩下只打「...另有 N 条同因失败」摘要。
  const first = ensureKhyError(errors[0]);
  const restCount = errors.length - 1;
  const mergedHint = first.hint
    ? `${first.hint}\n另有 ${restCount} 条同类失败，输入 /err 查看完整列表`
    : `另有 ${restCount} 条同类失败，输入 /err 查看完整列表`;
  first.hint = mergedHint;
  return reportKhyError(first, ctx);
}

/**
 * 单行版本 —— 给 TUI / 紧凑日志用。
 * 形如：「[warn] [NETWORK_UNREACHABLE] 连接 Anthropic（提示：检查端点...）」
 *
 * @param {*} err
 * @param {object} [ctx]
 * @returns {string}
 */
function formatKhyErrorInline(err, ctx = {}) {
  const env = ensureKhyError(err, { fallbackCode: ctx.fallbackCode });
  const sev = env.severity;
  const codeTag = `[${env.code}]`;
  const safeMessage = redactSensitiveText(env.message || env.code);
  const ctxPrefix = _formatContext(ctx);
  const hint = env.hint ? `（提示：${redactSensitiveText(env.hint)}）` : '';
  return `${ctxPrefix}[${sev}] ${codeTag} ${safeMessage}${hint}`;
}

// 兜底：万一 redactSensitiveText 抛出（极端 env），不要让格式化崩；
// catch 后用原始字符串继续，保证调用方一定能拿到一行情感化的错误。
function _safeRedact(text) {
  try { return redactSensitiveText(text); } catch { return String(text || ''); }
}

module.exports = {
  reportKhyError,
  reportKhyErrorMerged,
  formatKhyErrorInline,
  _internals: { _envelopeToPanel, _formatContext },
};