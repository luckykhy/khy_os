/**
 * Interactive REPL — public entry.
 *
 * The interactive session loop (startRepl) is an irreducible ~9.4k-line routine; it is isolated
 * verbatim into the same-directory sibling replSession.js (byte-identical body). This file keeps the
 * small, independently unit-tested display/format utilities (_formatImageSize / _tk* /
 * formatShellEscapeContext / _resetGatewayBreakerOnSessionClear) and the READ_SEARCH_TOOLS set, wires
 * them into the session module, and re-exports the stable public surface. All heavy modules stay
 * lazy-loaded inside replSession.js for fast cold start.
 */

// Claude Code-style read/search collapse tracking. Hoisted to a module
// constant so the per-round-trip tool loop reuses one Set (servicing per-tool
// `.has` lookups) instead of allocating an 18-element Set each round-trip.
// Consumed read-only (`.has`); never mutated, never escapes.
const READ_SEARCH_TOOLS = new Set([
  'read_file', 'readFile', 'grep', 'glob', 'search',
  'find_files', 'findFiles', 'search_content', 'searchContent',
  'git_status', 'gitStatus', 'git_diff', 'gitDiff', 'git_log',
  'explore', 'search_codebase', 'find_code', 'codebase_search',
]);

/**
 * 会话清空时顺带清熔断器(系统调用网关的会话级一击熔断)。
 *
 * 背景:误判旁路标记(如已修复的裸 -f)一旦触发,熔断态是会话粘滞的——`/new`/`/reset`/`/clear`
 * 只清对话历史却**不清熔断**,用户只能重启进程才能恢复。此处在既有的「清历史」接缝顺带调用
 * gateway.resetAllSessions() 清空进程内全部网关会话(单用户场景 sessionId 可能非 __default__,
 * 清整表最稳妥)让误锁可经 /new 自愈。
 *
 * 门控 KHY_BREAKER_RESET_ON_NEW(默认开;仅显式 0/false/off/no/disable/disabled 关闭)。绝不抛。
 * @returns {boolean} 是否执行了重置(用于提示/测试)
 */
function _resetGatewayBreakerOnSessionClear() {
  // 委托共享叶子 SSOT(src/cli/sessionClear.js);与 Ink TUI /clear 共用同一份逻辑,
  // 避免两套 UI 分叉。门控 KHY_BREAKER_RESET_ON_NEW 与绝不抛语义原样保留。
  return require('./sessionClear').resetGatewayBreakerOnSessionClear(process.env);
}

// CC 后端口径对齐:剪贴板图片大小标注走 CC `formatFileSize` 单一真源(ccFormat
// SSOT),而非本地 `(b/1024).toFixed(0)KB`——后者永远显 KB(无 bytes/MB/GB 进位),
// 5MB 图误显 "5120KB"、1.5MB 图误显 "1536KB"。与 atMentionInject._formatMentionSize
// 同一收敛(@file 大小)。门控 KHY_CC_FORMAT(经 ccFormatEnabled)默认开;
// 关 / require 失败 → 逐字节回退本 call-site 历史 `toFixed(0)KB` 口径。
function _formatImageSize(bytes, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('./ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(bytes);
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  return `${(bytes / 1024).toFixed(0)}KB`;
}

// CC 后端口径对齐:面板里的裸 token 数字走 ccFormatTokensOr SSOT(对齐 CC
// formatTokens:紧凑记数、>10k 不钉 ".0"、百万级进 "m";旧 `(n/1000).toFixed(1)k`
// 会显 "45.0k"、且无 mega 单位停 "1500.0k")。`_tk1`=used/remaining/session 的
// `.toFixed(1)k` legacy;`_tk0`=limit 的 `.toFixed(0)k` legacy;`_tkSpin`=turn
// byline 的 `n>=1000?toFixed(1)k:String(n)` legacy。门控 KHY_CC_FORMAT(经
// ccFormatTokensOr 内部判)关 → 各自历史规则逐字节回退。仅 token(k 后缀),不碰时长。
function _tk1(n, env = process.env) {
  return require('./ccFormat').ccFormatTokensOr(n, `${(n / 1000).toFixed(1)}k`, env);
}
function _tk0(n, env = process.env) {
  return require('./ccFormat').ccFormatTokensOr(n, `${(n / 1000).toFixed(0)}k`, env);
}
function _tkSpin(n, env = process.env) {
  return require('./ccFormat').ccFormatTokensOr(n, n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n), env);
}

/**
 * Format queued `!` shell-escape records into a single tagged context block for
 * injection into an AI turn. Pure (no closure/IO) so it is unit-testable.
 *
 * @param {Array<{command:string, body?:string, code?:number}>} records
 * @param {number} [maxLen=8000] total char cap (chatty commands can't blow context)
 * @returns {string} `<shell-escape-output>…</shell-escape-output>` or '' when empty
 */
function formatShellEscapeContext(records, maxLen = 8000) {
  // 最近优先预算(对齐 CC ExpandShellOutputContext:自动展开最近一条 `!` 输出)。
  // 门控 KHY_SHELL_ESCAPE_EXPAND_RECENT 默认开;关 → undefined,落到下方既有 slice 行为。
  try {
    const { formatShellEscapeContextExpanded } = require('./shellEscapeContext');
    const expanded = formatShellEscapeContextExpanded(records, maxLen, process.env);
    if (expanded !== undefined) return expanded;
  } catch { /* 叶子不可用则用既有逻辑 */ }

  if (!Array.isArray(records) || records.length === 0) return '';
  const blocks = records
    .filter((r) => r && r.command)
    .map((r) => `$ ${r.command}\n${r.body != null ? r.body : '(无输出)'}\n(exit ${Number.isFinite(r.code) ? r.code : 0})`);
  if (!blocks.length) return '';
  let joined = blocks.join('\n\n');
  if (joined.length > maxLen) joined = joined.slice(0, maxLen) + '\n…(shell 输出已截断)';
  return `<shell-escape-output>\n${joined}\n</shell-escape-output>`;
}

// Isolate the interactive session loop in a sibling (god-file split) and inject the utilities above.
const _replSession = require('./replSession');
_replSession.setReplSessionDeps({
  _formatImageSize, _tk1, _tk0, _tkSpin,
  formatShellEscapeContext, _resetGatewayBreakerOnSessionClear, READ_SEARCH_TOOLS,
});
const startRepl = _replSession.startRepl;

module.exports = { startRepl, formatShellEscapeContext, _formatImageSize, READ_SEARCH_TOOLS };
