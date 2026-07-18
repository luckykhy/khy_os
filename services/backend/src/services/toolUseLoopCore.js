/**
 * Tool-Use Loop — iterative AI ↔ tool execution cycle.
 *
 * Inspired by Claude Code's agentic loop:
 *   1. Send user message + tool definitions → AI
 *   2. Parse AI response for tool calls
 *   3. Execute tools (with permission checks)
 *   4. Append results to conversation, loop back to step 1
 *   5. When AI responds without tool calls → return final answer
 *
 * Safety: hard max-iterations limit, per-tool timeout, audit logging.
 * Feature flag: KHY_TOOL_LOOP=false disables this, falling back to legacy.
 */
const chalk = require('chalk').default || require('chalk');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { diagnostics, generateTraceId: genDiagTraceId } = require('./diagnosticEvents');
const { runWithConcurrency } = require('./concurrencyLimiter');
const { analyzeCommand } = require('./shellSafetyValidator');
const { normalizeToolCall } = require('./claudeCompat');
const { applyIntentGate } = require('./intentGate');
const { assessIntentCoverage, buildIntentCoverageNudge } = require('./intentCoverage');
const { extractErrorSignals, assessErrorCoverage, buildErrorCoverageNudge } = require('./errorEnumerationGuard');
// 智能体纪律兜底(goal「修复智能体纪律」):零工具调用的动作轮次里,识别「虚构阻碍就放弃 / 空头承诺
// 却不执行」——把只观测的信号升级成一次性闭环回核,逼模型真的动一次手。
const { isFollowThroughGuardEnabled, assessFollowThrough, buildFollowThroughNudge } = require('./followThroughGuard');
// Honest failure reason (treat "出错原因要具体真实"): surface the real concrete
// cause instead of a fabricated "网络不好" excuse, behind KHY_HONEST_FAILURE.
const { resolveFriendlyFailureMessage, extractToolFailureReason, buildKeyConfigInvite, isHonestFailureEnabled } = require('./honestFailureReason');
// Reply guard (KHY_REPLY_GUARD, default on): single source of truth for "is this
// an empty reply that must be discarded and re-requested". Closes the leak where
// cli/ai.js substitutes a non-empty diagnostic placeholder + errorType:'empty_reply',
// which is non-transient and otherwise surfaces the placeholder as a stopped failure.
const replyGuard = require('./replyGuard');
// Capability matrix (DESIGN-ARCH-CAPMATRIX cut 1): the declarative registry the
// loop seams consult in place of their inline KHY_* flag checks. `isEnabledAt`
// is byte-identical to the old check wherever the descriptor's preconditions are
// a subset of the surrounding inline guards (see capabilityMatrix/descriptors).
const { getCapabilityMatrix } = require('./capabilityMatrix');
const { SEAMS: CAP_SEAMS } = require('./capabilityMatrix/seams');
const { serializeRoute: _serializeCapRoute, formatRouteHuman: _formatCapRoute } = require('./capabilityMatrix/route');

// Exec approval (multi-level permission, complements shellSafetyValidator)
let _execApproval;
try {
  const { execApproval } = require('./execApproval');
  _execApproval = execApproval;
} catch { _execApproval = null; }

// Synthetic tool layer for low-tier models (lazy-loaded)
let _syntheticLayer;
try { _syntheticLayer = require('./syntheticToolLayer'); } catch { _syntheticLayer = null; }

// 系统层 D2 — hard token-budget governor (pure leaf · fail-soft). Decides; this
// shell accumulates per-round spend at the onCost emit and hard-stops the loop
// (no extra model round) before the next chat() when assessBudget returns 'stop'.
// KHY_TOKEN_BUDGET (the ceiling) doubles as the gate: unset/0 ⇒ disabled ⇒
// byte-identical legacy behavior. See services/tokenBudget.js.
let _tokenBudget;
try { _tokenBudget = require('./tokenBudget'); } catch { _tokenBudget = null; }

// Single-source narration voice (shared with the REPL + ink-TUI render paths).
// Used here ONLY to build a non-invasive "context reference" hint the model may
// adopt / rewrite / ignore — never to render fixed text (see
// _buildOutcomeReflectionHint). Fail-soft: a missing module degrades to no hint.
let _toolPrefaceVoice;
try { _toolPrefaceVoice = require('../cli/toolPrefaceVoice'); } catch { _toolPrefaceVoice = null; }

// ── 关键节点主动汇报（key-findings reporter）─────────────────────────────────
// Milestone-level findings the loop surfaces DURING execution instead of going
// silent until the end: deterministic test results + model-emitted <finding>
// blocks (root_cause/breakthrough/blocked). Pure leaf, fail-soft: a missing
// module degrades to no reporting.
let _keyFindings;
try { _keyFindings = require('../cli/keyFindings'); } catch { _keyFindings = null; }

// degenerateShellEcho — drop no-op "echo of prose" shell dispatches before they
// run (a bare `echo "<sentence>"` with no operator only reprints the model's own
// text; re-dispatching it trips the identical-result guardrail). Pure leaf,
// fail-soft: a missing module degrades to keeping every call (byte revert).
let _degenerateShellEcho;
try { _degenerateShellEcho = require('./degenerateShellEcho'); } catch { _degenerateShellEcho = null; }

// ── 结果守卫（result guard）──────────────────────────────────────────────────
// 杜绝「执行了工具但只给了承诺式前言、未交付结论、也无收尾」就静默返回。纯叶子、
// fail-soft：模块缺失 → null → call-site 回退历史行为（>= 40 代理 / 无收尾）。
let _resultGuard;
try { _resultGuard = require('../cli/resultGuard'); } catch { _resultGuard = null; }

// ── 断线惯性完成 + 无感衔接（goal 2026-06-25）────────────────────────────────
// 流式层瞬断且已有进度时以 PARTIAL(interrupted:true + 已下达 toolUseBlocks)返回,
// 这些已下达的工具调用不需要模型即可完成——惯性把它们跑完,并在「重连」的下一次模型
// 调用里显式告知模型「曾断线、据惯性结果续跑勿重复」,实现无感衔接。坏块(截断、参数
// 残缺)在此挡掉。纯叶子、fail-soft:模块缺失则退化为原「盲目执行」行为。
let _inertia;
try { _inertia = require('./query/inertiaCompletion'); } catch { _inertia = null; }

// 无感续写默认预算地板(纯叶子)。fail-soft:缺失则 _resolveTransientRecoveryMax
// 逐字节回退现状默认值 small=0/normal=1/large=3。门控 KHY_SEAMLESS_RESUME 默认开。
let _seamlessResume;
try { _seamlessResume = require('./query/seamlessResume'); } catch { _seamlessResume = null; }

// Bug 哨兵(goal 2026-06-25):让 bug 越早暴露 + 从被动响应升级为主动监听发现 + 被动兜底。
// 循环里的 fail-soft catch 不再静默吞咽,而是经 tripwire 登记成可观测信号;snapshot 接进
// 返回契约,供 UI/health/doctor 主动呈现。纯叶子、fail-soft:模块缺失则退化为原静默行为。
let _bugSentinel;
try { _bugSentinel = require('./bugSentinel'); } catch { _bugSentinel = null; }
function _tripwire(err, code) {
  try { if (_bugSentinel) _bugSentinel.tripwire(err, { code }); } catch { /* 哨兵自身绝不反噬 */ }
}

// 开发过程在途纠偏(goal 2026-06-25):用户用 Khyos 开发时主动监听开发轨迹(测试回归 /
// 未验证 churn / 反复改同一文件 / 连续失败),在跑偏酿成大错前及早提示修正航向,避免任务
// 做完才发现方向错被迫大改。纯叶子、fail-soft:模块缺失则退化为「无监听」原行为。
let _courseMonitor;
try { _courseMonitor = require('./devCourseMonitor'); } catch { _courseMonitor = null; }

// 边做边想(goal 2026-06-26):执行中持续拿新过程/结果对照模型最初的设想,出现偏差(工具失败/
// 空结果)而模型未自发反思、或捕获到计划后连续多步推进却从不回看时,提示「停一下,原计划是否
// 仍成立?不成立就就地修订」。与 devCourseMonitor 正交(那个数客观工程信号、不读计划文本;
// 本模块读计划 vs 现实的偏差)。纯叶子、fail-soft:模块缺失则退化为「无监听」原行为。
let _adaptiveExec;
try { _adaptiveExec = require('./adaptiveExecution'); } catch { _adaptiveExec = null; }

// 重复请求轮次识别(goal 2026-06-25):用户重复发送基本相同的提示词时,识别这是第几轮,
// 让模型继续深入而非回答「已经做完了」。纯叶子、fail-soft:模块缺失则退化为「不识别轮次」。
let _promptRounds;
try { _promptRounds = require('./repeatedPromptRounds'); } catch { _promptRounds = null; }

// 防小模型 bug 误判改坏正确代码(goal 2026-06-25):弱模型有时幻想出不存在的 bug、"修复"它,
// 把本来正确的代码改坏。复现先行守卫在 bugfix 意图下监听是否有"红色复现",无复现即提示(强档)
// 或在 harness 收口硬拦(弱档)。纯叶子、fail-soft:模块缺失则退化为「无守卫」原行为。
let _fpfGuard;
try { _fpfGuard = require('./falsePositiveFixGuard'); } catch { _fpfGuard = null; }

// 自我动作认领 / 因果叙述连贯(goal 2026-06-26):khyos 亲自执行了删除/覆盖等变更动作后,
// 叙述结果时不得把刚做的事甩给模糊外因(如「可能之前已经被清理过」),否则因果自相矛盾。
// 纯叶子、粘性窗口(变更→只读探查→叙述);fail-soft:模块缺失则退化为「不引导」原行为。
let _actionAttribution;
try { _actionAttribution = require('./actionAttribution'); } catch { _actionAttribution = null; }

// ── 非侵入式结果反思提示（goal 2026-06-24）────────────────────────────────
// Turn the single-source outcome narration into a CONTEXT REFERENCE the model
// receives alongside the tool results, rather than forcing a fixed string into
// the UI. The model is free to adopt it verbatim, rewrite it in its own voice,
// or ignore it entirely — this avoids the mechanical "fixed ✓ 完成 stamp" feel
// while still giving silent/weak models something to react to.
//
// This is the PRIMARY path; the ink-TUI's flushPendingOutcome (Stage D) is the
// FALLBACK that only renders when the model stays silent even after this hint.
// They are non-conflicting by construction: once the model narrates (it now has
// this reference in context), the TUI's segment gate clears the pending synthetic
// outcome, so there is never a double. 批2: failure / non-zero-exit steps now also
// yield a recovery beat from toolOutcomeNarration by default (KHY_TOOL_OUTCOME_FAIL),
// so the reference can nudge the model to acknowledge a failure and state its next
// move rather than going silent; set KHY_TOOL_OUTCOME_FAIL=0 to keep failures silent.
//
// Returns '' (no hint) when: the voice module is unavailable, KHY_OUTCOME_HINT is
// disabled, there are no results, or nothing concrete can be said.
function _buildOutcomeReflectionHint(toolResults, env = process.env) {
  if (!_toolPrefaceVoice || typeof _toolPrefaceVoice.toolOutcomeNarration !== 'function') return '';
  const flag = env && env.KHY_OUTCOME_HINT;
  if (flag === '0' || flag === 'false' || flag === 'off') return '';
  if (!Array.isArray(toolResults) || toolResults.length === 0) return '';
  const lines = [];
  for (const tr of toolResults) {
    if (!tr) continue;
    let line = '';
    try {
      line = _toolPrefaceVoice.toolOutcomeNarration(tr.tool, tr.result || {}, tr.params || {}) || '';
    } catch { line = ''; }
    if (line) lines.push(line);
  }
  if (lines.length === 0) return '';
  // Framed as an explicit SUGGESTION so the model treats it as reference, not a
  // line to echo. Mirrors the existing [SYSTEM: …] continuation-signal channel.
  return '[SYSTEM: 以下为可选的参考旁白，你可以自然地采用、改写或忽略，用你自己的话'
    + '承接这一步的结果并点出下一步；不要逐字照搬，也不要提及本提示：'
    + lines.join(' ') + ']';
}

// ── Loop breadcrumb (opt-in via KHY_LOOP_DEBUG) ──────────────────────────
// Records WHY the tool-use loop ran an extra model turn after a no-tool reply
// (which nudge fired, or that the model itself attached a trailing tool_use to
// a substantive answer). Used to diagnose the "answer finished but spinner
// still 思考中" symptom. Disabled by default — writes nothing unless the flag is
// set. Appends to a FILE (never stdout/stderr) so it can't corrupt the TUI's
// live region. Inspect with: tail -f "$KHY_LOOP_DEBUG_FILE" (default
// <tmpdir>/khy-loop-debug.log).
let _loopDebugFile = null;
function _loopBreadcrumb(event, data) {
  if (!process.env.KHY_LOOP_DEBUG || process.env.KHY_LOOP_DEBUG === '0') return;
  try {
    if (_loopDebugFile === null) {
      _loopDebugFile = process.env.KHY_LOOP_DEBUG_FILE
        || path.join(require('os').tmpdir(), 'khy-loop-debug.log');
    }
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n';
    fs.appendFileSync(_loopDebugFile, line);
  } catch { /* breadcrumb is best-effort; never throw into the loop */ }
}

// Hook system (lazy-loaded, auto-initializes with built-in ToolGuards)
let _hookSystem = undefined; // undefined = not yet loaded, null = unavailable
function _getHookSystem() {
  if (_hookSystem !== undefined) return _hookSystem;

  try {
    const hs = require('./hooks/hookSystem');
    // Auto-initialize if not yet done (registers built-in guards)
    if (typeof hs.isInitialized === 'function' && !hs.isInitialized()) {
      hs.init(process.env.KHYQUANT_CWD || process.cwd());
    }
    // Return hookSystem if any hooks (including built-in guards) are registered
    _hookSystem = (hs.registry && hs.registry.count > 0) ? hs : null;
  } catch {
    _hookSystem = null;
  }
  return _hookSystem;
}

// ── Content-fingerprint guard (staleness detection for edits) ─────
function _fileContentHash(filePath) {
  try {
    const buf = Buffer.alloc(10240);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 10240, 0);
    fs.closeSync(fd);
    return crypto.createHash('md5').update(buf.slice(0, bytesRead)).digest('hex');
  } catch { return null; }
}

// ── Constants ──────────────────────────────────────────────────────

const MAX_ITERATIONS = 100;
const MAX_ELAPSED_MS_DEFAULT = 600000;
const TOOL_CALL_REGEX = /<tool_call>\s*(\w+)\s*\(([^)]*)\)\s*<\/tool_call>/g;

// Read-only tool-name / shell-bin membership sets, precomputed once at module
// load (Ch2「不要每轮重建可复用结构」). The agentic loop previously rebuilt each
// of these `new Set([...literals])` inside per-call / per-iteration / per-result
// hot paths of runToolUseLoop. They are literal-only, consumed read-only via
// `.has`, never mutated and never escape — safe to share. Kept as THREE distinct
// consts because their membership differs by purpose; do not merge them:
//   - DEDUP_READ_ONLY_TOOLS: same-call dedup exemption (read-after-write is legal)
//   - IDLE_READ_ONLY_TOOLS:  idle-iteration tracking (AI only reading, not acting)
//   - READ_ONLY_SHELL_CMDS:  shell binaries that count as read-only activity
const DEDUP_READ_ONLY_TOOLS = new Set([
  'read_file', 'readfile', 'readFile', 'read',
  'grep', 'rg', 'search', 'glob', 'find', 'ls', 'LS',
  'quote', 'data_fetch', 'web_search', 'webSearch', 'websearch',
  'git_status', 'git_diff', 'git_log',
]);
const IDLE_READ_ONLY_TOOLS = new Set([
  'read_file', 'readFile',
  'search', 'toolSearch',
  'git_status', 'gitStatus',
  'git_diff', 'gitDiff',
  'git_log',
  'strategy_list', 'strategyList',
  'quote', 'grep', 'glob', 'ls', 'webSearch', 'web_search', 'webFetch', 'notebookRead',
]);
const READ_ONLY_SHELL_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'file', 'stat', 'pwd', 'which', 'echo', 'tree', 'du', 'df']);

// Further literal-only membership sets hoisted out of per-call function bodies
// (Ch2「不要每轮重建可复用结构」). Each was formerly a `new Set([...literals])`
// rebuilt on every call; all are consumed read-only via `.has`, never mutated,
// never escape — safe to build once at module load.
const _AUTO_WEB_SEARCH_MODES = new Set(['auto', 'news', 'docs', 'academic', 'general']);
const _DELIVERY_NUDGE_STOPWORDS = new Set(['please','the','and','for','this','that','with','from','then','also','just','make','want','need','would','should','could','can','will','into','让','把','给','用','到','了','在','是','的','被','请','要','会','就','能']);
const _APP_TARGET_PROBE_BINS = new Set(['which', 'whereis', 'command', 'type', 'ps', 'pgrep', 'pidof', 'grep', 'bash', 'sh', 'zsh', 'env', 'nohup']);
const _SEARCH_TERM_STOPWORDS = new Set([
  '帮我', '请', '麻烦', '一下', '搜索', '搜一下', '查一下', '查查', '查找', '查询',
  '今天', '今日', '最新', '新闻', '热点', '热搜', '资料', '信息', '网页', '联网', '内网',
  'search', 'find', 'lookup', 'look', 'up', 'latest', 'today', 'news', 'trending', 'please', 'help', 'me',
]);

/**
 * Thread-safe iteration budget with grace call support.
 * When depleted, allows one final "grace" iteration for the model to summarize.
 */
class IterationBudget {
  constructor(max) {
    this._max = max;
    this._used = 0;
    this._graceUsed = false;
  }
  get remaining() { return Math.max(0, this._max - this._used); }
  get depleted() { return this._used >= this._max; }
  get graceAvailable() { return this.depleted && !this._graceUsed; }
  consume() { this._used++; }
  useGrace() { this._graceUsed = true; }
  get used() { return this._used; }
  get max() { return this._max; }
}
const JSON_TOOL_CALL_REGEX = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const NATURAL_ACTION_TO_TOOL = {
  // Search
  '搜索': 'web_search',
  'search': 'web_search',
  'websearch': 'web_search',
  'web_search': 'web_search',
  '查找': 'search',

  // Market quote
  '行情': 'quote',
  'quote': 'quote',
  '报价': 'quote',
  '价格': 'quote',

  // Backtest
  '回测': 'backtest',
  'backtest': 'backtest',

  // Build / Test / Lint / Verify
  '构建': 'build_project',
  'build': 'build_project',
  '编译': 'build_project',
  '测试': 'run_tests',
  'test': 'run_tests',
  'lint': 'lint_code',
  '检查': 'lint_code',
  '代码检查': 'lint_code',
  '验证': 'verify_artifact',
  'verify': 'verify_artifact',
  '交付验证': 'verify_artifact',

  // K-line / data fetch
  'k线': 'data_fetch',
  'K线': 'data_fetch',
  'kline': 'data_fetch',
  'k线查询': 'data_fetch',

  // Strategy list
  '策略列表': 'strategy_list',
  'strategylist': 'strategy_list',
  'strategy_list': 'strategy_list',

  // File operations
  '读取文件': 'read_file',
  '读文件': 'read_file',
  'readfile': 'read_file',
  'read_file': 'read_file',
  '写入文件': 'write_file',
  'writefile': 'write_file',
  'write_file': 'write_file',
  '创建项目': 'scaffoldFiles',
  '项目脚手架': 'scaffoldFiles',
  '脚手架': 'scaffoldFiles',
  '目录结构': 'scaffoldFiles',
  '批量创建': 'scaffoldFiles',
  '并行写入': 'scaffoldFiles',
  'scaffold': 'scaffoldFiles',
  'scaffold_files': 'scaffoldFiles',
  'project_scaffold': 'scaffoldFiles',

  // Shell
  '命令': 'shell_command',
  'shell': 'shell_command',
  'bash': 'shell_command',
  'shellcommand': 'shell_command',
  'shell_command': 'shell_command',

  // App launch
  '打开应用': 'open_app',
  '启动应用': 'open_app',
  '打开程序': 'open_app',
  'openapp': 'open_app',
  'open_app': 'open_app',
  '应用': 'open_app',
  '浏览器': 'open_app',

  // Git
  'git状态': 'git_status',
  'gitstatus': 'git_status',
  'git_status': 'git_status',
  'git差异': 'git_diff',
  'gitdiff': 'git_diff',
  'git_diff': 'git_diff',

  // Glob file search
  '文件搜索': 'glob',
  'glob': 'glob',
  'find': 'glob',
  'find_files': 'glob',

  // Grep content search
  '内容搜索': 'grep',
  'grep': 'grep',
  'rg': 'grep',
  'search_content': 'grep',

  // Edit file (precise replacement)
  '编辑': 'editFile',
  'edit': 'editFile',
  '修改文件': 'editFile',
  'edit_file': 'editFile',
  'replace': 'editFile',

  // Image -> Web restore
  '网页还原': 'image2web',
  '图转网页': 'image2web',
  '截图还原': 'image2web',
  '截图转网页': 'image2web',
  'image2web': 'image2web',
  'image_to_web': 'image2web',
  'screenshot_to_html': 'image2web',
};

// 收敛到 utils/normalizeAlnumKey 单一真源(逐字节委托,调用点不变)
const _normalizeToolKey = require('../utils/normalizeAlnumKey');

function _expandToolNameVariants(name = '') {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const variants = new Set();
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    variants.add(text);
    variants.add(text.toLowerCase());
    variants.add(_normalizeToolKey(text));
  };

  push(raw);
  push(raw.replace(/[\s-]+/g, '_'));
  push(raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
  push(raw.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));

  try {
    const normalized = normalizeToolCall(raw, {});
    if (normalized?.name) push(normalized.name);
  } catch { /* best effort */ }

  return [...variants].filter(Boolean);
}

// ── 已知工具名集合记忆(Ch2「不要每轮重建可复用结构」) ──────────────────────────────
// runToolUseLoop 每轮/每模型往返都为 ToolLoopDetector 重建一份「已知工具名」集合:对每个启用
// 工具名 + 别名 + NATURAL_ACTION_TO_TOOL 值 + 固定常见名列表逐个跑 _expandToolNameVariants
// (Set 构建 + 4 次 regex + normalizeToolCall,每名一次),是本轮最大的每轮派生。其产物**只**是
// 启用工具名集合 + 模块冻结常量的纯函数(_expandToolNameVariants/NATURAL_ACTION_TO_TOOL 均无
// env/Date/闭包)。启用集合可能因 isEnabled()(git 探测等)跨轮变,故按「去重排序后工具名连接串」
// 作键记忆已算出的 knownNames 数组(与顺序/重复无关,可证正确);消费方 registerTools 只把名字复制
// 进自有 _knownTools Set,从不改源数组 → 共享缓存安全。门关 → 每轮现建(逐字节回退)。缓存有界
// (超 KNOWN_NAME_CACHE_CAP 个不同键即整清,绝不无界增长)。
const _knownNameCache = new Map();
const _KNOWN_NAME_CACHE_CAP = 16;
function _isKnownNameMemoEnabled() {
  const v = String(process.env.KHY_TOOL_KNOWN_NAME_SET_MEMO || '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}
// Build the deduped known-name array from an enabled-tools Map/object. Pure:
// depends only on tool names + aliases + module-frozen constants.
function _computeKnownToolNames(allTools) {
  const knownNameSet = new Set();
  const registerName = (name) => {
    for (const v of _expandToolNameVariants(name)) knownNameSet.add(v);
  };
  const names = allTools instanceof Map ? [...allTools.keys()] : Object.keys(allTools);
  for (const name of names) registerName(name);
  for (const tool of (allTools instanceof Map ? allTools.values() : Object.values(allTools))) {
    if (tool.aliases && Array.isArray(tool.aliases)) {
      for (const alias of tool.aliases) registerName(alias);
    }
  }
  for (const mappedName of Object.values(NATURAL_ACTION_TO_TOOL)) registerName(mappedName);
  for (const common of ['shellCommand', 'shell_command', 'bash', 'writeFile', 'write_file', 'readFile', 'read_file', 'editFile', 'edit_file', 'open_app', 'openApp']) {
    registerName(common);
  }
  return [...knownNameSet];
}
// Order/dup-independent canonical key over the enabled tool NAMES (aliases are a
// deterministic property of each frozen tool, so names alone identify the result).
function _knownNameCacheKey(allTools) {
  const names = allTools instanceof Map ? [...allTools.keys()] : Object.keys(allTools);
  return [...new Set(names)].sort().join(' ');
}
function _resolveKnownToolNames(allTools) {
  if (!_isKnownNameMemoEnabled()) return _computeKnownToolNames(allTools);
  const key = _knownNameCacheKey(allTools);
  if (_knownNameCache.has(key)) return _knownNameCache.get(key);
  const built = _computeKnownToolNames(allTools);
  if (_knownNameCache.size >= _KNOWN_NAME_CACHE_CAP) _knownNameCache.clear();
  _knownNameCache.set(key, built);
  return built;
}

function _canonicalizeToolCall(call) {
  if (!call || call.legacy) return call;
  try {
    let rawName = String(call.name || '');
    let rawParams = call.params || {};
    const fnLike = rawName.match(/^([A-Za-z_][\w-]*)\s*\(([\s\S]*)\)$/);
    if (fnLike) {
      rawName = fnLike[1];
      const inlineArg = String(fnLike[2] || '').trim();
      if (inlineArg && Object.keys(rawParams).length === 0) {
        if (/^(shell_command|shellCommand|bash)$/i.test(rawName)) rawParams = { command: inlineArg };
        else if (/^(open_app|openApp)$/i.test(rawName)) rawParams = { name: inlineArg };
      }
    }
    const normalized = normalizeToolCall(rawName, rawParams);
    if (normalized && normalized.name) {
      return {
        ...call,
        name: normalized.name,
        params: normalized.params || {},
      };
    }
  } catch { /* keep original call */ }
  return call;
}

function _parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, n);
}

function _resolveMaxIterations(requestedMaxIterations) {
  const base = (requestedMaxIterations !== undefined && requestedMaxIterations !== null)
    ? _parsePositiveInt(requestedMaxIterations, MAX_ITERATIONS, 1, 100)
    : _parsePositiveInt(process.env.KHY_TOOL_LOOP_MAX_ITERATIONS, MAX_ITERATIONS, 1, 100);
  // 20 倍模式:开则把工具循环迭代上限顶到硬顶(不低于 base、封顶 100)。关 → 逐字节回退 base。
  try {
    const { scaleIterations } = require('./twentyXMode');
    return scaleIterations(base);
  } catch {
    return base;
  }
}

function _resolveMaxElapsedMs() {
  const base = _parsePositiveInt(
    process.env.KHY_TOOL_LOOP_MAX_MS,
    MAX_ELAPSED_MS_DEFAULT,
    5000,
    30 * 60 * 1000,
  );
  // Apply global timeout multiplier
  try {
    const { applyMultiplier } = require('./adaptiveOutput');
    return applyMultiplier(base);
  } catch {
    return base;
  }
}

/** @type {(msg: string, opts?: object) => 'small'|'normal'|'large'} */
function _resolveTaskScale(userMessage = '', options = {}) {
  const { resolveTaskScale } = require('./taskScale');
  return resolveTaskScale(userMessage, options);
}

function _isTransientLoopErrorType(errorType = '') {
  const t = String(errorType || '').trim().toLowerCase();
  return t === 'timeout'
    || t === 'cancelled'
    || t === 'network'
    || t === 'process'
    // 'empty': an empty HTTP-200 adapter reply (model produced no text). The
    // gateway no longer cools the channel for this, so a bounded in-loop retry
    // can immediately re-ask the same healthy channel; on exhaustion the
    // error-path salvage surfaces any already-fetched tool data instead of a
    // bare failure. Parity with 'unknown'.
    || t === 'empty'
    || t === 'unknown';
}

function _normalizeStopReason(reason = '') {
  const raw = String(reason || '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase();

  if (['length', 'max_tokens', 'max-tokens', 'max_tokens_exceeded', 'max_output_tokens', 'max_completion_tokens'].includes(normalized)) {
    return 'length';
  }
  if (['tool_use', 'tool_calls', 'tool_call', 'function_call', 'function_calls'].includes(normalized)) {
    return 'tool_use';
  }
  if (['stop', 'end_turn', 'end-turn', 'completed', 'complete'].includes(normalized)) {
    return 'stop';
  }
  return normalized;
}

/**
 * Whether the loop should trust the model's native stop_reason as a continuation
 * signal. Only NATIVE function-calling adapters carry a trustworthy finish/stop
 * reason; text-protocol (weak-local) models synthesize tool calls from raw text,
 * so their stop_reason is meaningless here and the toolUseBlocks/text parse stays
 * authoritative. Gated by KHY_TRUST_STOP_REASON (default on) for a clean rollback.
 *
 * Note: stop_reason is still only a SECONDARY hint — the presence of structured
 * toolUseBlocks remains the primary signal (see `hasStructuredToolUse`). This
 * helper guards one extra recovery: a native turn that says tool_use but lost its
 * blocks should not be silently finalized.
 */
function _shouldTrustStopReason(isTextProtocol) {
  if (isTextProtocol) return false;
  const flag = String(process.env.KHY_TRUST_STOP_REASON || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * Check if an AI result represents a cooldown/cached failure that should NOT
 * be retried.  Gateway returns these when an adapter's recent failure is still
 * within its cooldown window — retrying immediately will produce the exact
 * same cached error, wasting iterations.
 */
function _isCooldownFailure(aiResult) {
  if (!aiResult) return false;
  const content = String(aiResult.content || '');
  const error = String(aiResult.error || '');
  const combined = content + ' ' + error;
  return /\bcooldown\b/i.test(combined) || /recent.*failure.*cached/i.test(combined);
}

function _resolveTransientRecoveryMax(userMessage = '', options = {}) {
  const explicit = parseInt(String(options.maxTransientRecoveries ?? ''), 10);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(6, explicit));
  const scale = _resolveTaskScale(userMessage, options);
  // 未显式设置 env 时的默认预算交无感续写叶子(门控开 → 抬高 small/normal 地板,
  // 门控关 → 逐字节回退现状 0/1/3)。显式 env 覆盖仍最高优先、原样保留。
  const _dflt = (sc, legacy) => (_seamlessResume
    ? _seamlessResume.defaultTransientBudget(sc, process.env)
    : legacy);
  if (scale === 'small') {
    const raw = process.env.KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_SMALL;
    const n = parseInt(String(raw == null || raw === '' ? _dflt('small', 0) : raw), 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : _dflt('small', 0);
  }
  if (scale === 'large') {
    const raw = process.env.KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_LARGE;
    const n = parseInt(String(raw == null || raw === '' ? _dflt('large', 3) : raw), 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(6, n)) : _dflt('large', 3);
  }
  const raw = process.env.KHY_TOOL_LOOP_TRANSIENT_RECOVERIES;
  const n = parseInt(String(raw == null || raw === '' ? _dflt('normal', 1) : raw), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : _dflt('normal', 1);
}

/**
 * Bounded retry budget for an empty / no-text terminal reply. Defaults to 2
 * regardless of scale ("网络波动 → 重试几次"), env-tunable; clamped to [0,3].
 * Distinct from the transient budget so an empty reply gets its own retries
 * even when transient recoveries are disabled for small tasks.
 */
function _resolveEmptyRecoveryMax(userMessage = '', options = {}) {
  const explicit = parseInt(String(options.maxEmptyRecoveries ?? ''), 10);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(3, explicit));
  const n = parseInt(String(process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES || '2'), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 2;
}

function _recoveryDelayMs(attemptIndex = 0) {
  const base = Math.max(300, parseInt(String(process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS || '1200'), 10) || 1200);
  const exp = Math.min(4, Math.max(0, attemptIndex));
  const jitter = Math.random() * 300;
  return Math.round(base * Math.pow(1.65, exp) + jitter);
}

// First stall nudge must feel seamless — a near-zero delay so the continuation
// lands before the user perceives any hitch. Env-tunable; clamped to [0,300] so
// "无感顺滑" can never be turned into a long visible pause.
function _stallNudgeSilentDelayMs() {
  const v = parseInt(String(process.env.KHY_TOOL_LOOP_STALL_SILENT_DELAY_MS ?? '120'), 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(300, v)) : 120;
}

// ── Salvage gathered tool results when the model writes no closing text ──────
// "先救后报" (DESIGN-ARCH-029 精神): a turn can end with successful tool calls
// (e.g. `news` fetched 8 articles, shown to the user as ✓) but ZERO assistant
// text — common for weak OpenAI-compatible models after a tool result. Printing
// a bare "未能生成有效回复" while real data sits in toolCallLog is the reported
// "工具调用显示绿色但还是没输出" symptom. Render the gathered results directly so
// the user always gets the data that was already fetched. Returns null when
// there is nothing renderable (then the caller falls back to the canned message).
function _salvageToolResults(toolCallLog, userMessage) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return null;
  const parts = [];
  for (const entry of toolCallLog) {
    const r = entry && entry.result;
    if (!r || r.success !== true) continue;
    let text = '';
    if (typeof r.output === 'string' && r.output.trim()) {
      text = r.output.trim();
    } else if (Array.isArray(r.results) && r.results.length) {
      text = r.results.map((it, i) => {
        if (it == null) return '';
        if (typeof it === 'string') return `${i + 1}. ${it}`;
        const title = it.title || it.name || it.headline || '';
        const url = it.url || it.link || '';
        const snippet = it.snippet || it.summary || it.description || '';
        return `${i + 1}. ${title}${snippet ? ` — ${snippet}` : ''}${url ? `\n   ${url}` : ''}`.trim();
      }).filter(Boolean).join('\n');
    } else if (typeof r.content === 'string' && r.content.trim()) {
      text = r.content.trim();
    }
    if (text) {
      const label = entry && entry.tool ? `【${entry.tool}】\n` : '';
      parts.push(label + text);
    }
  }
  if (!parts.length) return null;
  let body = parts.join('\n\n');
  const CAP = 4000;
  if (body.length > CAP) body = `${body.slice(0, CAP)}\n…（内容较长，已截断）`;

  // 模型没产出总结时，khy 自己做一次确定性归纳（目录清单等）领头，原文随后附上。
  // 这样即便弱模型/无模型也"主动给结论"，不必用户再说一句"做个总结"。
  let summary = '';
  try {
    const tds = require('./toolDataSummary');
    // 把用户实际提问作为 focus 传给归纳器,让相关句子排最前(localNlp qFrac 主排序键)。
    // 纯叶子 buildSalvageSummaryOpts:门控关/空消息 → {} 逐字节回退今日无焦点归纳。
    if (tds.isEnabled()) {
      const _focusOpts = require('./salvageSummaryFocus')
        .buildSalvageSummaryOpts(userMessage, process.env);
      summary = tds.summarizeToolData(toolCallLog, _focusOpts);
    }
  } catch { /* fail-soft：归纳失败则退回原始呈现 */ }

  if (summary && summary.trim()) {
    return `${summary.trim()}\n\n——以下为工具返回的原始内容——\n\n${body}`;
  }
  return `以下是已检索到的结果（模型本轮未生成总结，已为你直接呈现工具返回的内容）：\n\n${body}`;
}

function _formatDurationMs(ms) {
  const totalSec = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

const _envFlagEnabled = require('../utils/envFlagEnabled');

// Bounded non-negative integer from an env var; falls back to defaultValue on
// empty/invalid/negative input. Used for hard upper-bounds on auto-continue loops.
function _envIntOr(rawValue, defaultValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return defaultValue;
  const n = Number.parseInt(String(rawValue).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return defaultValue;
  return n;
}

// ── Cross-turn tool-call repeat guard ───────────────────────────────────────
// The in-turn loop detector + executedCallKeys reset every turn, so a model that
// re-issues the SAME successful command on each new turn (each「继续」is a new
// turn) never trips them. This guard closes that gap: callers pass the recent
// successful tool-call signatures, and before dispatch we check whether the call
// byte-matches one already answered. If so we steer the model to ANSWER from the
// result already in context — or switch approach — instead of re-running it.
//
// Pure + fail-soft. Backward-compatible: dormant unless the caller supplies
// recentToolSignatures (older/embedded callers are unaffected).

// Normalize the caller-supplied signatures into { exact:Set, intents:Set }.
// Accepts an already-shaped object, an array of signature strings, or
// null/undefined (→ empty sets). Never throws.
function _normalizeRecentSignatures(input) {
  const exact = new Set();
  const intents = new Set();
  try {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      for (const s of (input.exact || [])) { if (s) exact.add(String(s)); }
      for (const s of (input.intents || [])) { if (s) intents.add(String(s)); }
    } else if (Array.isArray(input)) {
      for (const s of input) { if (s) exact.add(String(s)); }
    }
  } catch { /* fail-soft → empty sets */ }
  return { exact, intents };
}

// Build the (exact signature, intent key) pair for a call, mirroring the
// detector's normalization so callers and this guard agree. Returns
// { sig, intentKey } with '' for an unavailable component.
function _signatureForCall(name, params, detector) {
  let sig = '';
  let intentKey = '';
  try {
    const det = detector || require('./toolLoopDetector');
    try { sig = det.toolCallSignature(name, params || {}) || ''; } catch { sig = ''; }
    try {
      if (det._isShellTool && det._isShellTool(name)) {
        // Prefer _originalCommand: the loop rewrites the command for the host
        // platform (dir→ls, timeout injection) BETWEEN the pre-dispatch guard
        // (which sees the original) and onToolResult (which sees the rewritten
        // form + _originalCommand). Keying both off the ORIGINAL makes the
        // harvested signature and the guard's signature agree across turns.
        const cmd = String((params && (params._originalCommand || params.command || params.cmd || params.script)) || '').trim();
        if (cmd && det.extractShellIntent) {
          const intent = det.extractShellIntent(cmd);
          if (intent) intentKey = 'shell:' + intent;
        }
      } else if (det._isFsTool && det._isFsTool(name) && det.extractPathIntent) {
        const intent = det.extractPathIntent(name, params || {});
        if (intent) intentKey = 'path:' + intent;
      }
    } catch { intentKey = ''; }
  } catch { /* detector unavailable → both '' */ }
  return { sig, intentKey };
}

// Decide whether to steer (without executing) a call that repeats a recent
// successful one. state = { counts:Map, cap:number } bounds steers per turn so
// the steer itself cannot loop; once the cap is hit the call falls through and
// executes normally (never a hard block).
function crossTurnRepeatDecision(call, recentSigs, state, env) {
  const e = env || process.env;
  if (!_envFlagEnabled(e.KHY_CROSS_TURN_TOOL_DEDUP, true)) return { steer: false };
  if (!call || !recentSigs) return { steer: false };
  const exact = recentSigs.exact;
  const intents = recentSigs.intents;
  const hasExact = exact && typeof exact.has === 'function' && exact.size > 0;
  const hasIntents = intents && typeof intents.has === 'function' && intents.size > 0;
  if (!hasExact && !hasIntents) return { steer: false };

  const name = String(call.name || call.tool || '');
  const params = call.params || {};
  const { sig, intentKey } = _signatureForCall(name, params, null);
  const matched = (sig && hasExact && exact.has(sig))
    || (intentKey && hasIntents && intents.has(intentKey));
  if (!matched) return { steer: false };

  const key = sig || intentKey;
  const counts = state && state.counts instanceof Map ? state.counts : null;
  const cap = state && Number.isFinite(state.cap) ? state.cap : 1;
  if (counts) {
    const prev = counts.get(key) || 0;
    if (prev >= cap) return { steer: false }; // exhausted → let it execute
    counts.set(key, prev + 1);
  }

  const label = intentKey
    ? intentKey.replace(/^(shell|path):/, '')
    : String(params.command || params.cmd || params.path || params.file_path || name);
  const message = `[SYSTEM: 你在本次对话中已经成功运行过这条命令（${name}: ${String(label).slice(0, 120)}），`
    + '完整结果就在上方的工具结果里，不需要也不要再次运行同一条命令。请二选一：'
    + '① 直接基于上方已获取的结果，用中文写出用户要的最终回答（例如「可删除文件」表格），不要返回空白；'
    + '② 如果这条路拿不到所需信息（此路不通），换一个明显不同的方法或路径，而不是把同一条命令原样重试。]';
  // displayHint 是给用户看的「干净」一句话(绝不含 [SYSTEM:…] 内部控制串);message 仅喂模型。
  // 二者分离,避免内部转向指令泄漏到可见的工具结果行(见 ToolLines.errorText 优先用它)。
  const displayHint = `本轮已成功运行过这条命令，已跳过（结果在上方）。`;
  return { steer: true, message, displayHint, signature: sig, intentKey };
}

const DEFAULT_CAPABILITY_POLICY = Object.freeze({
  enabled: true,
  blockMode: 'strict',
  tasks: [
    {
      key: 'file_edit',
      patterns: [
        '修改', '编辑', '重构', '实现', '修复', '新增', '添加', '删除', '替换', '写入', '创建文件',
        'apply patch', 'edit file', 'write file', 'refactor', 'implement', 'fix', 'update', 'replace', 'remove', 'delete',
      ],
      requiredTools: ['editFile', 'writeFile', 'shellCommand', 'file_edit', 'file_write'],
      reason: '当前环境缺少文件编辑/写入能力（edit/write/shell 工具不可用）。',
    },
    {
      key: 'shell_exec',
      patterns: [
        '运行命令', '执行命令', '终端', 'shell', 'bash', 'cmd', '运行测试', '构建', '编译', '安装依赖',
        'npm', 'pnpm', 'yarn', 'pytest', 'cargo', 'go test', 'make', 'docker', 'kubectl',
      ],
      requiredTools: ['shellCommand', 'run_tests', 'build_project', 'lint_code', 'executeCode'],
      reason: '当前环境缺少命令执行能力（shell/build/test 工具不可用）。',
    },
    {
      key: 'web_search',
      patterns: ['联网', '上网', '互联网', 'web search', '网页搜索', '搜索网页', '查网页', 'fetch url', '访问网站', 'browser search'],
      requiredTools: ['webSearch', 'webFetch', 'search'],
      reason: '当前环境缺少联网检索能力（webSearch/webFetch 不可用）。',
    },
    {
      key: 'app_launch',
      patterns: ['打开应用', '启动应用', '打开程序', '打开浏览器', 'open app', 'launch app', 'start app', 'open browser'],
      requiredTools: ['open_app', 'shellCommand'],
      reason: '当前环境缺少应用启动能力（open_app/shell 工具不可用）。',
    },
  ],
  model: {
    enabled: true,
    ignoreIssuePatterns: ['上下文可能不够'],
    blockWhenHardIssueCountAtLeast: 2,
    blockWhenComplexAndHardIssueCountAtLeast: 1,
    complexMinChars: 160,
    maxRecommendations: 3,
  },
});

const _cloneCapabilityTasks = require('../utils/cloneCapabilityTasks');

function _mergeCapabilityPolicy(basePolicy = {}, overridePolicy = {}) {
  const baseModel = basePolicy && typeof basePolicy.model === 'object' ? basePolicy.model : {};
  const overrideModel = overridePolicy && typeof overridePolicy.model === 'object' ? overridePolicy.model : {};
  return {
    ...basePolicy,
    ...(overridePolicy || {}),
    tasks: Array.isArray(overridePolicy?.tasks)
      ? _cloneCapabilityTasks(overridePolicy.tasks)
      : _cloneCapabilityTasks(basePolicy.tasks || []),
    model: {
      ...baseModel,
      ...overrideModel,
    },
  };
}

function _defaultCapabilityPolicyPath() {
  const home = String(process.env.HOME || process.env.USERPROFILE || '').trim();
  if (!home) return '';
  return path.join(home, '.khyquant', 'capability-policy.json');
}

function _loadCapabilityPolicy(options = {}) {
  let policy = _mergeCapabilityPolicy(DEFAULT_CAPABILITY_POLICY, {});

  if (options && options.capabilityPolicy && typeof options.capabilityPolicy === 'object') {
    policy = _mergeCapabilityPolicy(policy, options.capabilityPolicy);
  }

  const envPolicyJson = String(process.env.KHY_CAPABILITY_POLICY_JSON || '').trim();
  if (envPolicyJson) {
    try {
      const parsed = JSON.parse(envPolicyJson);
      if (parsed && typeof parsed === 'object') {
        policy = _mergeCapabilityPolicy(policy, parsed);
      }
    } catch { /* ignore malformed JSON */ }
  }

  const policyPath = String(
    options.capabilityPolicyFile
      || process.env.KHY_CAPABILITY_POLICY_FILE
      || _defaultCapabilityPolicyPath()
  ).trim();
  if (policyPath && fs.existsSync(policyPath)) {
    try {
      const parsed = JSON.parse(String(fs.readFileSync(policyPath, 'utf-8') || '{}'));
      if (parsed && typeof parsed === 'object') {
        policy = _mergeCapabilityPolicy(policy, parsed);
      }
    } catch { /* ignore malformed file */ }
  }

  return policy;
}

// ── 启用工具名集合记忆(Ch2「不要每轮重建可复用结构」) ──────────────────────────────
// _assessExecutionCapability 每轮对话都调 _collectEnabledToolNameSet 为能力门重建一份「启用工具
// 名 + 别名」集合:对每个启用工具名逐个跑 _expandToolNameVariants(Set 构建 + 4 次 regex +
// normalizeToolCall)。其产物只是启用工具名集合的纯函数(_expandToolNameVariants 无 env/Date/
// 闭包)。启用集合可能因 isEnabled()(git 探测等)跨轮变,故按「去重排序后工具名连接串」作键记忆
// 已算出的 Set(与顺序/重复无关,可证正确)。唯一消费方 _hasAnyToolEnabled 只对该 Set 做 .has()
// 只读探测 → 共享缓存安全。门关 → 每轮现建(逐字节回退)。缓存有界(超 CAP 个不同键即整清)。
const _enabledNameSetCache = new Map();
const _ENABLED_NAME_SET_CACHE_CAP = 16;
function _isEnabledNameSetMemoEnabled() {
  const v = String(process.env.KHY_TOOL_ENABLED_NAME_SET_MEMO || '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}
// Build the enabled-tool name Set from an enabled-tools Map/object. Pure: depends
// only on tool names + aliases expanded through _expandToolNameVariants.
function _buildEnabledToolNameSet(enabled) {
  const out = new Set();
  const registerName = (name) => {
    for (const v of _expandToolNameVariants(name)) out.add(v);
  };
  if (!enabled) return out;

  const names = enabled instanceof Map ? [...enabled.keys()] : Object.keys(enabled);
  for (const name of names) registerName(name);

  const defs = enabled instanceof Map ? [...enabled.values()] : Object.values(enabled);
  for (const tool of defs) {
    if (Array.isArray(tool?.aliases)) {
      for (const alias of tool.aliases) registerName(alias);
    }
  }
  return out;
}
// Order/dup-independent canonical key over the enabled tool NAMES (aliases are a
// deterministic property of each frozen tool, so names alone identify the result).
function _enabledNameSetCacheKey(enabled) {
  const names = enabled instanceof Map ? [...enabled.keys()] : Object.keys(enabled);
  return [...new Set(names)].sort().join(' ');
}
function _collectEnabledToolNameSet() {
  let enabled;
  try {
    const toolRegistry = require('../tools');
    enabled = toolRegistry.getEnabled ? toolRegistry.getEnabled() : toolRegistry.getAll?.();
  } catch { /* best effort */ return new Set(); }

  if (!enabled) return new Set();
  if (!_isEnabledNameSetMemoEnabled()) return _buildEnabledToolNameSet(enabled);

  const key = _enabledNameSetCacheKey(enabled);
  if (_enabledNameSetCache.has(key)) return _enabledNameSetCache.get(key);
  const built = _buildEnabledToolNameSet(enabled);
  if (_enabledNameSetCache.size >= _ENABLED_NAME_SET_CACHE_CAP) _enabledNameSetCache.clear();
  _enabledNameSetCache.set(key, built);
  return built;
}

function _hasAnyToolEnabled(enabledToolSet, candidates = []) {
  if (!(enabledToolSet instanceof Set) || enabledToolSet.size === 0) return false;
  for (const name of candidates) {
    const variants = _expandToolNameVariants(name);
    for (const variant of variants) {
      if (enabledToolSet.has(variant)) return true;
    }
  }
  return false;
}

function _containsPattern(text, pattern) {
  const haystack = String(text || '');
  if (pattern instanceof RegExp) return pattern.test(haystack);
  const raw = String(pattern || '').trim();
  if (!raw) return false;
  if (raw.startsWith('re:')) {
    try {
      return new RegExp(raw.slice(3), 'i').test(haystack);
    } catch {
      return haystack.toLowerCase().includes(raw.slice(3).toLowerCase());
    }
  }
  return haystack.toLowerCase().includes(raw.toLowerCase());
}

function _detectCapabilityNeeds(message = '', policy = DEFAULT_CAPABILITY_POLICY) {
  const text = String(message || '');
  if (!text) return [];
  const tasks = Array.isArray(policy?.tasks) ? policy.tasks : [];
  const hits = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const patterns = Array.isArray(task.patterns) ? task.patterns : [];
    if (patterns.some(pattern => _containsPattern(text, pattern))) {
      hits.push(task);
    }
  }
  return hits;
}

const _dedupeText = require('../utils/dedupeText');

function _assessExecutionCapability(userMessage, options = {}) {
  const policy = _loadCapabilityPolicy(options);
  const gateEnabled = _envFlagEnabled(options.capabilityGate, _envFlagEnabled(process.env.KHY_TASK_CAPABILITY_GATE, true));
  const enabled = gateEnabled && _envFlagEnabled(policy.enabled, true);
  const mode = String(policy.blockMode || 'strict').trim().toLowerCase();
  const assessment = {
    enabled,
    mode: (mode === 'warn' || mode === 'warning' || mode === 'warn-only') ? 'warn' : 'strict',
    canProceed: true,
    reasons: [],
    warnings: [],
    recommendations: [],
  };
  if (!enabled) return assessment;

  const text = String(userMessage || '').trim();
  if (!text) return assessment;

  const needs = _detectCapabilityNeeds(text, policy);
  const enabledToolSet = _collectEnabledToolNameSet();
  for (const need of needs) {
    const requiredTools = Array.isArray(need?.requiredTools) ? need.requiredTools : [];
    if (requiredTools.length === 0) continue;
    const hasTool = _hasAnyToolEnabled(enabledToolSet, requiredTools);
    if (!hasTool) {
      assessment.reasons.push(
        String(need.reason || `当前环境缺少执行能力：${need.key || 'unknown-task'}`).trim(),
      );
    }
  }

  try {
    // Resolve the model-capability checker via the neutral port instead of a
    // reverse require to cli/ai (DESIGN-ARCH-021, Batch 3). Unregistered → null →
    // pre-check skipped, identical to the prior require-failure branch.
    const checkModelCapability = require('./modelCapabilityPort').getModelCapabilityChecker();
    if (typeof checkModelCapability === 'function') {
      const modelCheck = checkModelCapability(text);
      if (modelCheck && Array.isArray(modelCheck.issues) && modelCheck.issues.length > 0) {
        const modelCfg = (policy && typeof policy.model === 'object') ? policy.model : {};
        if (_envFlagEnabled(modelCfg.enabled, true)) {
          const ignoreList = Array.isArray(modelCfg.ignoreIssuePatterns) ? modelCfg.ignoreIssuePatterns : [];
          const hardIssues = modelCheck.issues.filter((issue) => {
            const textIssue = String(issue || '');
            return !ignoreList.some(p => _containsPattern(textIssue, p));
          });
        const complexOrAction = _isComplexTask(text).isComplex || _looksLikeActionRequest(text);
          const hardIssueMin = Math.max(1, parseInt(String(modelCfg.blockWhenHardIssueCountAtLeast ?? '2'), 10) || 2);
          const complexHardIssueMin = Math.max(1, parseInt(String(modelCfg.blockWhenComplexAndHardIssueCountAtLeast ?? '1'), 10) || 1);
          const complexMinChars = Math.max(20, parseInt(String(modelCfg.complexMinChars ?? '160'), 10) || 160);
          const shouldBlockByModel = hardIssues.length >= hardIssueMin
            || (hardIssues.length >= complexHardIssueMin && complexOrAction && text.length >= complexMinChars);

          if (shouldBlockByModel) {
            assessment.reasons.push(`模型能力预判不足：${hardIssues.join('；')}`);
          } else if (modelCheck.issues.length > 0) {
            assessment.warnings.push(`模型能力提醒：${modelCheck.issues.join('；')}`);
          }

          if (Array.isArray(modelCheck.recommendations) && modelCheck.recommendations.length > 0) {
            const labels = modelCheck.recommendations
              .map((item) => String(item?.label || item?.key || '').trim())
              .filter(Boolean);
            assessment.recommendations.push(...labels);
          }
        }
      }
    }
  } catch { /* best effort */ }

  const modelCfg = (policy && typeof policy.model === 'object') ? policy.model : {};
  const maxRecommendations = Math.max(1, parseInt(String(modelCfg.maxRecommendations ?? '3'), 10) || 3);
  assessment.reasons = _dedupeText(assessment.reasons);
  assessment.warnings = _dedupeText(assessment.warnings);
  assessment.recommendations = _dedupeText(assessment.recommendations).slice(0, maxRecommendations);

  if (assessment.mode === 'warn' && assessment.reasons.length > 0) {
    assessment.warnings.push(...assessment.reasons.map(reason => `预判阻断已降级为告警：${reason}`));
    assessment.reasons = [];
    assessment.warnings = _dedupeText(assessment.warnings);
  }

  assessment.canProceed = assessment.reasons.length === 0;
  return assessment;
}

function _formatCapabilityFailureResponse(assessment) {
  const reasons = Array.isArray(assessment?.reasons) ? assessment.reasons : [];
  const lines = [
    '抱歉，执行前能力预判未通过，当前无法可靠完成该任务。',
  ];
  for (let i = 0; i < reasons.length; i++) {
    lines.push(`${i + 1}. ${reasons[i]}`);
  }
  if (Array.isArray(assessment?.recommendations) && assessment.recommendations.length > 0) {
    lines.push(`建议切换模型后重试：${assessment.recommendations.join('、')}`);
  }
  lines.push('你可以把任务拆小、补充更具体上下文，或明确可用工具后再试。');
  return lines.join('\n');
}

function _extractDecisionPreview(reply = '') {
  const plain = _stripToolCalls(_stripExecutionPlan(String(reply || '')))
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';

  const sentence = plain
    .split(/[\n。！？.!?]/)
    .map(s => s.trim())
    .find(Boolean) || plain;

  return sentence.slice(0, 160);
}

function _normalizeToolNameForDisplay(name = '') {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (raw === '_legacy_cmd') return 'command';
  return raw
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function _buildPlannedToolList(toolCalls = [], maxItems = 6) {
  const names = [];
  const seen = new Set();
  for (const call of toolCalls) {
    const normalized = _normalizeToolNameForDisplay(call?.name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(normalized);
    if (names.length >= maxItems) break;
  }
  return names;
}

function _resolveAutoWebSearchMode(userMessage, requestedMode = 'auto') {
  const normalizedRequested = String(requestedMode || 'auto').trim().toLowerCase();
  const safeRequested = _AUTO_WEB_SEARCH_MODES.has(normalizedRequested) ? normalizedRequested : 'auto';
  if (safeRequested !== 'auto') return safeRequested;

  const raw = _sanitizeSearchSourceMessage(String(userMessage || ''));
  if (!raw) return 'general';

  if (/(论文|paper|arxiv|doi|research|study|benchmark|dataset|citation|methodology|survey)/i.test(raw)) {
    return 'academic';
  }
  if (/(文档|docs?|documentation|api|sdk|readme|manual|reference|接口|参数|安装|install|quickstart|error\s*code)/i.test(raw)) {
    return 'docs';
  }
  if (/(新闻|热点|热搜|头条|快讯|今日|今天|最新|时事|发布|trending|headline|breaking|latest\s+news)/i.test(raw)) {
    return 'news';
  }
  return 'general';
}

// ── Main Loop ──────────────────────────────────────────────────────

/**
 * Run an iterative tool-use loop: AI generates tool calls, system executes
 * them, feeds results back, and AI continues until it has a final answer.
 *
 * @param {string} userMessage - The user's original message
 * @param {object} options
 * @param {function} options.chat - AI chat function (message, opts) => { reply, ... }
 * @param {object} [options.chatOpts] - Options passed through to chat()
 * @param {number} [options.maxIterations] - Safety limit on loop iterations (fallback: KHY_TOOL_LOOP_MAX_ITERATIONS or 10)
 * @param {function} [options.onToolCall] - Callback before tool execution: (toolName, params, iteration)
 * @param {function} [options.onToolResult] - Callback after tool execution: (toolName, params, result, iteration, elapsedMs)
 * @param {function} [options.onIteration] - Callback at each iteration start: (iteration, totalCalls)
 * @param {function} [options.onPlanReady] - Callback when execution plan is parsed: (plan)
 * @param {function} [options.onPlanProgress] - Callback as plan steps progress: (stepIndex, status)
 * @param {function} [options.onParallelBatch] - Callback before a parallel batch runs: (calls, iteration)
 * @param {function} [options.onNoToolCall] - Callback when an iteration returns no tool calls: (iteration, reply, info)
 * @param {function} [options.onCapabilityCheck] - Callback when execution capability is assessed: (assessment)
 * @param {function} [options.onDecision] - Callback when each round decision is made: ({ iteration, mode, preview, toolCount, tools })
 * @param {function} [options.onIterationSummary] - Callback after each round tools finish: ({ iteration, total, succeeded, failed, denied, deduped, readOnlyOnly })
 * @returns {Promise<{ finalResponse: string, toolCallLog: Array, iterations: number, provider?: string }>}
 */
// P0.3 子代理上下文传递:仅对「生成子代理」类工具调用,把父对话最近若干条消息
// 作为快照透传给 toolCalling → AgentTool,由纯叶子 subagentContextSummary 蒸馏成有界摘要
// 注入子代理 prompt(缓解子代理完全看不见父对话的隔离问题)。非 agent-spawn 调用返回 {},
// 不给热路径增加任何负担;additive/optional,显式 parent_context_summary 仍优先。
const _AGENT_SPAWN_NAMES = new Set(['agent', 'task', 'spawn_worker', 'delegate', 'sub_agent']);
function _agentParentConversation(callName, conversationMessages) {
  if (!_AGENT_SPAWN_NAMES.has(String(callName || '').toLowerCase())) return {};
  if (!Array.isArray(conversationMessages) || conversationMessages.length === 0) return {};
  return { parentConversation: conversationMessages.slice(-12) };
}

async function runToolUseLoop(userMessage, options = {}) {
  const {
    chat,
    chatOpts = {},
    maxIterations: requestedMaxIterations,
    sessionId: requestedSessionId,
    onToolCall,
    onToolResult,
    onIteration,
    onSelfEditAdvisory, // ({humanLine,aiNote}) => void —— 自维护顾问人面投递(TUI notice / REPL console);缺省则仅 AI 面注入
    onPlanReady,
    onPlanProgress,
    onKeyFinding, // (finding) => void — 关键节点主动汇报：测试结果 / 根因 / 突破 / 受阻，由消费者渲染
    onParallelBatch,
    onNoToolCall,
    onCapabilityCheck,
    onDecision,
    onIterationSummary,
    onCheckpoint,
    getSteerMessages, // () => string[] — 拉取并清空 steer 消息（忙碌输入 steer 模式）
    consumeUrgentSteer, // () => boolean — /s! 紧急 steer 信号（pull-clear）：cancel 后置真则注入修正并原地重发，而非整体 bail
    onInterrupt,       // (interruptEvent) => void — Phase 2: interrupt notification
    interruptSignal,   // { interrupted, _event, _resumePromise } — Phase 2: mutable signal
    initialMessages,   // Array — prior conversation messages for continuation rounds
    onControlRequest,  // async ({requestId, request}) => controlResponse — host interactive channel (AskUserQuestion)
    onCost,            // (tokenUsage) => void — projects per-turn token usage (generator adapters emit `cost` events)
    onThinking,        // (text) => void — projects loop-progress thinking text (generator adapters emit `thinking` events)
    onExitPlanMode,    // (exitParams) => void — CC 对齐计划模式:模型调 ExitPlanMode 时把计划交回宿主(TUI 审阅框)
    planMode,          // boolean — 本轮是否计划模式(只读调研 + ExitPlanMode 收尾);由 bridge 据 KHY_PLAN_CC_RESEARCH+permissionMode 传入
  } = options;

  if (!chat || typeof chat !== 'function') {
    throw new Error('toolUseLoop: chat function is required');
  }

  const originalUserMessage = String(userMessage || '');
  const gatedInput = applyIntentGate(originalUserMessage, options.intentGate || {});
  const userToolConstraints = _extractUserToolConstraints(originalUserMessage);

  // ── 意图接住回核（[答得没接住意图]）──────────────────────────────────
  // 一次性抽出用户逐字点名的高精度诉求（引用字面 / 文件路径 / 代码标识符 / 尾随
  // 子请求），收尾时回核最终回复是否真接住了它们。开关 KHY_INTENT_COVERAGE
  // 默认开（∈{0,false,off,no} → 关，frame 留空 → 永不追问）。fail-soft：抽取出
  // 错绝不阻断主循环。
  const _intentCoverageEnabled = !['0', 'false', 'off', 'no']
    .includes(String(process.env.KHY_INTENT_COVERAGE || '').trim().toLowerCase());
  // 有界路径正则(防灾难性回溯 DoS)默认开;仅 0/false/off/no 关闭走字节回退。
  const _intentPathRedosGuard = !['0', 'false', 'off', 'no']
    .includes(String(process.env.KHY_INTENT_PATH_REDOS_GUARD || '').trim().toLowerCase());
  let _intentFrame = { detailAnchors: [], tailDetails: [] };
  if (_intentCoverageEnabled) {
    try {
      const { buildIntentAssuranceDirective } = require('./khyUpgradeRuntime');
      const _f = buildIntentAssuranceDirective(originalUserMessage, {});
      _intentFrame = {
        detailAnchors: Array.isArray(_f && _f.detailAnchors) ? _f.detailAnchors : [],
        tailDetails: Array.isArray(_f && _f.tailDetails) ? _f.tailDetails : [],
      };
    } catch { /* fail-soft：意图抽取失败 → 留空 frame，回核自然 no-op */ }
  }

  // ── 先枚举再修复:多错误诊断任务的收尾覆盖回核 ──────────────────────
  // 一次性从用户原始消息里确定性地抽出错误信号(强错误关键词/错误码/命名异常 +
  // 可区分锚点),收尾时回核最终回复是否把每条错误都接住了。开关 KHY_ERROR_ENUMERATION
  // 默认开(∈{0,false,off,no} → 关,信号留空 → 永不追问)。与 cli/ai.js 的「枚举模式」
  // 前置指令配套:那里强制先列清单,这里用代码兜底校验有没有漏修。fail-soft。
  const _errorEnumEnabled = !['0', 'false', 'off', 'no']
    .includes(String(process.env.KHY_ERROR_ENUMERATION || '').trim().toLowerCase());
  let _errorSignals = [];
  if (_errorEnumEnabled) {
    try { _errorSignals = extractErrorSignals(originalUserMessage); } catch { _errorSignals = []; }
  }

  // ── 智能体纪律兜底:「说了却没做就收场」跟进回核(goal「修复智能体纪律」)──────
  // 零工具调用的动作轮次里,若模型虚构阻碍(「指令被截断/无法继续」)或空头承诺(「我将编辑」)
  // 却没真动手,一次性逼它发起工具调用或用具体证据证明阻碍真实。门控 KHY_FOLLOW_THROUGH_GUARD
  // (default-on·parent=KHY_WEAK_MODEL_GUIDANCE);关 → 恒 no-op、逐字节回退。fail-soft。
  let _followThroughEnabled = false;
  try { _followThroughEnabled = isFollowThroughGuardEnabled(process.env); } catch { _followThroughEnabled = false; }

  // 结构化熔炉前置拦截（DESIGN-ARCH-036 §3.1）。默认开启、fail-soft、observe 模式零行为变更：
  // 默认即坍缩 NL 为封印信封并挂到 options 供下游消费/观测（KHY_STRUCTURED_FURNACE=0 关闭）；
  // 拒损在 enforce 子模式下才上抛，observe（默认）下仅记录。
  // observe 不改投喂模型的 message，保持既有交互流不回归（enforce 侵入式接管留后续 PR）。
  maybeForgeStructuredIntent(originalUserMessage, options, gatedInput);

  let traceAudit = null;
  try {
    traceAudit = require('./traceAuditService');
    traceAudit.ensureDiagnosticsBridge();
  } catch { /* optional */ }
  const diagTraceId = options?._diagTraceId || genDiagTraceId();
  // 开发者可观测层（规范 DESIGN-ARCH-016 §1）：幂等挂载 NDJSON 脱敏日志 sink 到
  // diagnostics 单例。standalone 未显式开启时静默不挂，保持交互式 CLI 既有行为；
  // 失败一律吞掉，绝不影响 Agent 运行（防呆）。
  try {
    require('./agentDevLog').enableKhyosAgentDevLog({ app: 'khyos', agent: options?.agentRole });
  } catch { /* optional: dev-log sink must never break the loop */ }
  const requestId = String(options?.requestId || diagTraceId).trim() || diagTraceId;
  const traceSessionId = requestedSessionId || traceAudit?.getContext?.()?.sessionId || null;
  if (options && typeof options === 'object') {
    options._diagTraceId = diagTraceId;
    options.requestId = requestId;
  }
  if (traceAudit && traceSessionId) {
    try {
      traceAudit.attachTrace(diagTraceId, traceSessionId);
      traceAudit.logEvent('agent.loop.start', {
        requestId,
        maxIterations: _resolveMaxIterations(requestedMaxIterations),
        messagePreview: originalUserMessage.slice(0, 600),
        activatedModes: gatedInput.activatedModes || [],
      }, {
        sessionId: traceSessionId,
        traceId: diagTraceId,
        requestId,
        source: 'tool-loop',
        visibility: 'summary',
      });
    } catch { /* non-critical */ }
  }

  const toolCallLog = [];
  let currentMessage = gatedInput.message;

  // [AI-弱模型·照抄] 用户提示词结构化(判定/拼装在 promptStructurer 纯叶子,这里只做赋值 IO)。
  //   /goal「我发给 ai 的提示词,都先做结构化处理后再发给模型,提示词=结构+内容」:在任何 [SYSTEM]
  //   前言注入**之前**、currentMessage 还是用户原文时,把它包裹成「结构 + 内容」——绝不改写/删减原文
  //   (冲突时以原文为准),之后 planning/procedure 等前言仍叠加其上。门控 KHY_PROMPT_STRUCTURING 关 →
  //   buildStructuredPrompt 返 null → 保持原文(逐字节回退)。整块 try/catch fail-soft,叶子绝不阻断主循环。
  try {
    const _structured = require('./promptStructurer').buildStructuredPrompt(currentMessage, process.env);
    if (_structured) {
      currentMessage = _structured;
      try { _loopBreadcrumb('prompt-structuring', { applied: true }); } catch { /* breadcrumb best-effort */ }
    }
  } catch { /* prompt structuring best-effort — never block delivery on its own errors */ }

  // ── Open a structured receipt for this turn (A3, learned from DesireCore) ──
  // One receipt aggregates every tool call made while answering this request.
  // It is finalized in _emitDeliveryFinalEvent (the single turn-completion
  // funnel). Best-effort: a receipt failure must never affect the turn.
  try {
    require('./receiptService').startReceipt({
      sessionId: traceSessionId,
      traceId: diagTraceId,
      requestId,
      goal: originalUserMessage,
    });
  } catch { /* receipt optional */ }
  let lastResult = null;
  let totalToolCalls = 0;
  let preflightApproved = null; // Set<string> of batch-approved tool names
  // 权限被拒后的「先尝试替代、最终诚实告知所需权限」状态(单一真源 permissionFallback)。
  // keys = 此前已被拒调用的稳定 key(用于识别重复/限尝试次数);denied = 用于最终诚实文案
  // 的(工具+被拒结果)清单。门控关时不参与决策,行为字节回退为既有「拒绝即停」。
  const _permFallbackState = { keys: [], denied: [] };
  // 在某个 deny 早退点统一决策:返回 {stop, message}。
  //   stop=false → 已把「换方法」引导注入 resultObj.hint, 调用方**不要 return**, 继续循环
  //                让模型用其它方式达成目标;
  //   stop=true  → 调用方 return 停止;message 非空时用作诚实告知文案(列出所需权限),
  //                门控关 / fail-soft 时 message=null, 调用方回退既有「拒绝即停」文案(字节一致)。
  const _handleDenyFallback = (tool, params, resultObj) => {
    try {
      const pf = require('./permissionFallback');
      if (!pf._enabled()) return { stop: true, message: null }; // 门控关 → 字节回退
      const key = pf.denyKey(tool, params);
      const decision = pf.evaluateDeny(_permFallbackState.keys, key);
      _permFallbackState.denied.push({ tool, denyResult: resultObj });
      if (decision.stop) {
        return { stop: true, message: pf.buildExhaustedMessage(_permFallbackState.denied) };
      }
      _permFallbackState.keys.push(key);
      const guidance = pf.buildDenyGuidance(tool, resultObj);
      if (guidance && resultObj && typeof resultObj === 'object') {
        resultObj.hint = (resultObj.hint ? `${resultObj.hint}\n` : '') + guidance;
      }
      return { stop: false, message: null };
    } catch {
      return { stop: true, message: null }; // fail-soft → 既有行为
    }
  };
  let executionPlan = null;     // Parsed execution plan { steps: [...] }
  let currentPlanStep = 0;
  let noToolNudgeUsed = false; // 精简后仅允许 1 次 nudge（对标 CC/DS 无 nudge 策略）
  let _codingVerifyNudgeUsed = false; // coding mode 验证提示只触发一次
  let _verificationNudgeUsed = false; // Phase R2-3B: 3+ writes without verify → one-shot nudge
  let _deliveryConclusionNudgeUsed = false; // 交付结论 nudge 只触发一次
  let _resultGuardNoticeUsed = false; // 结果守卫诚实收尾只追加一次/轮
  let _intentCoverageNudgeUsed = false; // [答得没接住意图] 意图接住回核 nudge 只触发一次
  let _errorCoverageNudgeUsed = false; // [先枚举再修复] 错误覆盖回核 nudge 只触发一次
  let _followThroughNudgeUsed = false; // [修复智能体纪律] 说了却没做就收场 → 跟进回核只触发一次
  let _failureRecoveryNudgeUsed = false; // 工具失败后模型短回复放弃 → 推一次换方法/解释
  let _unknownProbesUsed = 0; // 面对未知(未知工具/陌生概念/无法归类错误)→ 放弃前的有界主动探索次数
  let _pseudoRefusalNudgeUsed = false;   // 工具成功取回数据后却套话拒绝 → 推一次「用已有结果作答」
  // 无感衔接保底（Goal）：AI 卡壳（空回复终态）报错前，先轻推 1-2 次再报。即便上游把
  // 各重试预算配成 0（KHY_TOOL_LOOP_EMPTY_RECOVERIES=0 等），也保证至少一次「继续」轻推，
  // 不行才报错。计数器 + 上限确保至多 2 次，绝不死循环。
  let _stallNudgeUsed = 0;
  const _stallNudgeMax = (() => {
    const v = parseInt(String(process.env.KHY_TOOL_LOOP_STALL_NUDGES ?? '2'), 10);
    return Number.isFinite(v) ? Math.max(1, Math.min(2, v)) : 2;
  })();
  // 无工具数据时的纯套话拒绝（「你好，我无法给到相关内容」）是上游通道降级/网络波动的
  // 典型签名，而非真做不了。有界重试几次（带退避）再保底报错，绝不一次就放弃，也绝不死循环。
  let _bareRefusalRetries = 0;
  const _bareRefusalRetryMax = (() => {
    const v = parseInt(String(process.env.KHY_TOOL_LOOP_REFUSAL_RETRIES ?? '2'), 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 2;
  })();
  // 死循环 break：上一轮套话拒绝的归一签名。若 nudge 之后模型又**原样**吐回同一句
  // 拒绝（同签名），说明它在「同一个地方反复跌倒」——立即跳出重试，不再重复同一条
  // 错误路径（用户复盘指出的「缺少的 break」）。null = 本会话尚无拒绝。
  let _lastRefusalSig = null;
  // 重复退化（degeneration）矫正：弱模型把同一短片段（如「要,」）反复输出上千次，
  // 在流式通道淹没用户。检测到即「及时矫正而非断命」——掐住流式洪水、丢废稿、重发
  // 一次纠偏指令让模型干净重写；仅当重写仍退化才回落已抢救的干净前缀（绝不报错断连）。
  let _repetitionRetries = 0;
  const _repetitionRetryMax = (() => {
    const v = parseInt(String(process.env.KHY_TOOL_LOOP_REPETITION_RETRIES ?? '1'), 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 1;
  })();
  let _lastRepetitionSig = null;         // 上轮重复签名：纠偏后又同样退化 → 停止重试，回落抢救
  let _streamRepGuard = null;            // 每轮新建的流式重复检测实例（onChunk 包装器引用）
  let _streamRepetitionTripped = false;  // 本轮流式是否已判定退化（判定后吞掉后续洪水）
  let _uphSanitizeUsed = false;          // Unknown-Problem Handler: 偏离预警净化指令每轮只注入一次（防自旋）
  // ── Hard verification gate state (edit → verify → iterate) ─────────
  const _allModifiedFiles = new Set(); // session-level accumulator of successfully edited files
  // 自维护顾问「每文件每轮去重」集合(函数作用域=随每个顶层 turn 天然新鲜,无需显式 reset)。
  const _selfEditAdvised = new Set();
  // 弱模型改红线/敏感顾问「每文件每轮去重」集合(与上同作用域,同一 turn 内每文件只提示一次)。
  const _weakModelAdvised = new Set();
  let _verifyGateRounds = 0;            // bounded retries forced by the gate
  let _verifyGateExhausted = false;     // ceiling reached → conclude but annotate
  let _nonEditVerifyRounds = 0;         // [P6] bounded retries for non-edit evidence self-check
  let _stopReasonRecoveryUsed = false;  // 批1: native stop_reason=tool_use 但 blocks 丢失 → 一次性续跑恢复
  // ── 项目整体一致性门 + 自驱收尾保障 ([DESIGN-ARCH-050]) ────────────
  let _coherenceGateRounds = 0;         // 整体性门已用轮次（有界，绝不死循环）
  let _coherenceGateExhausted = false;  // 到顶仍不自洽 → 放行但标注
  let _closureGuardUsed = false;        // 自驱收尾保障一次性
  let _kickoffGuardCount = 0;           // 自驱启动/续作保障：有界计数（替代旧一次性，治「半截话反复手推」）
  let _lastKickoffSig = null;           // 上次自驱时的前言签名 —— 同句原样重复即停，防死循环燃 Token
  // ── 持久目标 Stop-gate（goal 2026-07-03「让 khy 学会使用 CC 的 goal 模式」）───────
  let _goalStopRedrives = 0;            // 本轮内 goal 感知再驱动次数（有界，跨轮由轮次预算兜底）
  let _lastGoalStopSig = null;          // 上次 goal 再驱动时的回复签名 —— 同句原样重复即停，防死循环
  // ── 完成时审计→修复闭环 state（阶段性/大任务收尾自动审计并修复）─────────
  let _auditFixDone = false;            // 本轮已跑过审计闭环（一次性，绝不重复 spawn）
  let _auditFixAnnotation = '';         // 透明标注（遗留问题）→ 追加到 finalText 末尾

  // ── 双层 AbortController 级联（借鉴 Claude Code parent→sibling→child） ──
  // parentAbort: 整个会话级取消（用户中断/超时），杀死所有子操作
  // siblingAbort: 单轮迭代级取消（工具执行超时），不影响整个会话
  const parentAbort = new AbortController();
  const externalSignal = options.abortSignal || options.signal || null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      parentAbort.abort(externalSignal.reason || 'external abort');
    } else {
      externalSignal.addEventListener('abort', () => {
        try { parentAbort.abort(externalSignal.reason || 'external abort'); } catch { /* ignore */ }
      }, { once: true });
    }
  }
  const _isAborted = () => parentAbort.signal.aborted;

  // D9: Cascade interruptSignal → parentAbort for chunk-level interrupt
  // This ensures that when an interrupt arrives mid-stream, the streaming
  // response from the AI provider is immediately aborted (not waiting for iteration end)
  // Self-cleaning: stops once interrupt fires or parentAbort is already aborted
  if (interruptSignal) {
    const _iw = setInterval(() => {
      if (parentAbort.signal.aborted) { clearInterval(_iw); return; }
      if (interruptSignal.interrupted) { clearInterval(_iw); parentAbort.abort('interrupt'); }
    }, 500);
    if (_iw.unref) _iw.unref();
  }

  // ESC / 用户中断 → 执行中的工具取消:parentAbort 只在真·中断(外部 abort / interruptSignal)
  // 时触发,把它的 signal 穿进工具执行(traceContext.abortSignal),让一次长搜索/抓取/DB 查询
  // 在按 ESC 时立即松手,而不是苦等工具的 120s 硬超时。门控 KHY_TOOL_ABORT_SIGNAL(默认开);
  // 关 → null → toolCalling 不与工具竞赛(byte-identical)。安全:parentAbort 无自发 abort。
  let _toolAbortEnabled = true;
  try { _toolAbortEnabled = require('./flagRegistry').isFlagEnabled('KHY_TOOL_ABORT_SIGNAL', process.env); }
  catch { _toolAbortEnabled = true; }
  const _toolAbortSig = _toolAbortEnabled ? parentAbort.signal : null;

  // 每轮迭代创建一个 siblingAbort（链接 parentAbort）
  function _createSiblingAbort() {
    const sibling = new AbortController();
    const onParentAbort = () => {
      try { sibling.abort(parentAbort.signal.reason || 'parent abort'); } catch { /* ignore */ }
    };
    if (parentAbort.signal.aborted) {
      sibling.abort(parentAbort.signal.reason || 'parent abort');
    } else {
      parentAbort.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    return {
      controller: sibling,
      signal: sibling.signal,
      abort: (reason) => { try { sibling.abort(reason); } catch { /* ignore */ } },
      cleanup: () => { parentAbort.signal.removeEventListener('abort', onParentAbort); },
    };
  }

  // Model-capability tier → harness profile. Resolved early (the model id is
  // available from options/chatOpts before effectiveChatOpts is built) so its
  // dials can shape the loop cap below and the scaffolding gates downstream.
  // Only T0 (frontier) relaxes; T1/T2/T3 keep current behavior. See modelTier.js.
  const _harnessProfile = _modelTier.harnessProfile(
    _modelTier.resolveTier(
      String((chatOpts && chatOpts.model) || options?.model
        || process.env.GATEWAY_PREFERRED_MODEL || '')
    )
  );
  _loopBreadcrumb('harness-profile', _harnessProfile);

  // Is the active model known to LACK reliable native tool calling? If so, the
  // text-parse fallback below (a turn with no structured toolUseBlocks) is the
  // EXPECTED, first-class path — the model is driven via <tool_call> text
  // interception, NOT an adapter defect — so we emit a calm breadcrumb instead of
  // the alarming "adapter should return structured blocks" warning. This is the
  // mechanism that lets pure-text models (no function calling) still call khy
  // tools. SSOT: modelToolingCapability (gate-aware; off → stays false → legacy
  // warning text, byte-identical).
  let _modelLacksNativeTools = false;
  try {
    const _toolCap = require('./gateway/modelToolingCapability');
    const _modelForCap = String((chatOpts && chatOpts.model) || options?.model || process.env.GATEWAY_PREFERRED_MODEL || '');
    // 名字只作辅助:实测裁决(toolCapabilityStore 的 live probe / 被动学习)胜过按名字的
    // SMALL_MODEL_HINTS 启发。与三处决策门(khyUpgradeRuntime 教学门 + relay/multiFree 剥离门)
    // 同源同参——此前本处漏传 measured,名字在此成了事实主判据(一个实测能原生调工具的
    // flash/lite 模型仍被误标为「文本协议·预期」)。best-effort:store 不可用 → measured=null →
    // 回落 provisional 名字启发(仍安全)。
    let _measuredCap = null;
    try { _measuredCap = require('./gateway/toolCapabilityStore').getVerdict(_modelForCap); } catch { /* best effort */ }
    _modelLacksNativeTools = _toolCap.isEnabled() && _toolCap.modelLacksReliableToolCalling(
      _modelForCap,
      { measured: _measuredCap }
    );
  } catch { /* fail-soft: keep the alarming default off */ }

  // Tool-call PROTOCOL seam. The unified loop serves both cloud (native tool_use)
  // and weak-local (text <tool_call>) models. The active protocol is dispatch-
  // driven: an explicit options.toolCallProtocol (set by the local-mode dispatch,
  // which KNOWS it is talking to a local adapter) is authoritative; otherwise fall
  // back to the harness profile (default 'native' for every tier). Only the TEXT
  // branch routes through the adapter — the native parse/format stays inline and
  // byte-identical, so the cloud path is untouched.
  const _toolProtocolAdapter = require('./toolProtocolAdapter');
  const _activeProtocol =
    (options && (options.toolCallProtocol === 'text' || options.toolCallProtocol === 'native'))
      ? options.toolCallProtocol
      : (_harnessProfile.toolCallProtocol || 'native');
  const _isTextProtocol = _activeProtocol === 'text';
  const _activeAdapter = _toolProtocolAdapter.resolveAdapter(_activeProtocol);
  if (_isTextProtocol) _loopBreadcrumb('tool-protocol', { protocol: _activeProtocol });

  const resolvedMaxIterations = _resolveMaxIterations(requestedMaxIterations);
  const transientRecoveryMax = _resolveTransientRecoveryMax(originalUserMessage, options);
  // Apply intentGate outerBoost: coding +18, ultrawork +12, analyze +6
  const { getLoopLimitBoost } = require('./intentGate');
  const _loopBoost = getLoopLimitBoost(gatedInput.activatedModes || []);
  const effectiveMaxIterations = Math.min(
    200,
    resolvedMaxIterations + _loopBoost.outerBoost + transientRecoveryMax
      + (_harnessProfile.maxIterationsBoost || 0),
  );
  const maxElapsedMs = _resolveMaxElapsedMs();
  let transientRecoveryUsed = 0;
  // /s! 紧急 steer 重发计数：用户抢占在飞模型回合并注入修正后原地重发，bounded 防滥用。
  // 与 transientRecoveryMax 分账——紧急 steer 是用户主动行为，不应被普通瞬态预算挤占或挤占之。
  let urgentSteerReissues = 0;
  const URGENT_STEER_MAX = parseInt(String(process.env.KHY_URGENT_STEER_MAX || '5'), 10) || 5;
  // Empty-reply auto-recovery (DESIGN-ARCH-046): an empty / no-text terminal
  // response is a degraded dead-end, not a real answer. Attempt a bounded retry
  // BEFORE surfacing the canned fallback, so the user never has to re-ask.
  // Default 1 ("auto-trigger one retry"). This budget is consumed ONLY on the
  // already-empty path — the normal non-empty path pays zero latency.
  const emptyRecoveryMax = _resolveEmptyRecoveryMax(originalUserMessage, options);
  let emptyRecoveryUsed = 0;
  // Forced-summarization turn (Fix #3): when a tool run succeeded but the model
  // wrote NO closing text, ask it ONE more time with tools disabled so it is
  // forced to write a real summary from the data it already gathered — "成品优先
  // （模型写的总结）、原料兜底（_salvageToolResults 的原始数据）". Bounded to 1 so a
  // stubborn model can never spin here; if it still returns empty we fall to the
  // raw-data salvage floor below. Disabling tools (via _forceNoTools → ai.chat)
  // is what stops weak models from re-calling the same tool instead of answering.
  let forcedSummaryUsed = 0;
  const forcedSummaryMax = 1;
  // 主动协助 + 被动兜底（goal 2026-06-25）三个一次性闸门(防死循环):
  //  A1 缺总结——无工具长回答缺结论时主动推一轮补总结(_summaryAssistUsed),补不出再
  //     由服务端合成一句兜底(_summaryFallbackUsed);A3 空闲超时无内容时先续接一次(_idleAssistUsed)。
  let _summaryAssistUsed = 0;
  let _summaryFallbackUsed = false;
  let _idleAssistUsed = 0;
  // 断线惯性（goal 2026-06-25）：检测到断线惯性回合时,置「重连提示」待下一次 chat()
  // 前注入(无感衔接 + 告知模型已断开);_inertiaEvents 累积每次惯性回合的执行/丢弃计数,
  // 用于返回对象的 inertia 摘要与重连失败时的用户软提示。
  let _pendingInertiaReconnectHint = '';
  const _inertiaEvents = [];
  // 开发过程在途纠偏：本次 loop 的开发轨迹状态(每任务一份)。子 agent 抑制(战术执行不纠偏)。
  // 读原始 chatOpts(effectiveChatOpts 尚未声明,避免 TDZ);两者 _isSubagent 同源。
  const _courseState = (_courseMonitor && !(chatOpts && chatOpts._isSubagent) && _courseMonitor.isEnabled())
    ? _courseMonitor.createState() : null;
  // 边做边想:本次 loop 的「计划 vs 现实」反思状态(每任务一份)。子 agent 抑制(战术执行不回核
  // 顶层计划)。读原始 chatOpts 避 TDZ,与 _courseState 同源。fail-soft:模块缺失则 null。
  const _reflectState = (_adaptiveExec && !(chatOpts && chatOpts._isSubagent) && _adaptiveExec.isEnabled())
    ? _adaptiveExec.createState() : null;
  // 自我动作认领:本次 loop 的粘性状态(每任务一份)。子 agent 不抑制——子 agent 同样会执行
  // 删除/写入并叙述结果,认领规则对它同样适用。fail-soft:模块缺失则 null。
  const _attributionState = _actionAttribution ? _actionAttribution.createAttributionState() : null;
  // 防 bug 误判:本次 loop 的复现先行守卫状态(每任务一份)。子 agent 抑制(战术执行不裁决交付)。
  // 读原始 chatOpts 避 TDZ,与 _courseState 同源;bugfixIntent 决定是否 engage。fail-soft。
  let _fpfState = null;
  try {
    if (_fpfGuard && !(chatOpts && chatOpts._isSubagent) && _fpfGuard.isEnabled()) {
      _fpfState = _fpfGuard.createState();
      _fpfState.bugfixIntent = _fpfGuard.looksLikeBugfixTask(userMessage);
    }
  } catch { _fpfState = null; }
  // 重复请求轮次:从历史 user 轮(initialMessages)数出当前提示词是第几轮重复。子 agent 抑制
  // (派生执行不是用户重复请求)。读原始 chatOpts 避 TDZ,与 _courseState 同源。fail-soft。
  let _promptRound = 1;
  try {
    if (_promptRounds && !(chatOpts && chatOpts._isSubagent) && _promptRounds.isEnabled()) {
      _promptRound = _promptRounds.countRound(userMessage, _promptRounds.priorUserTextsFrom(initialMessages));
    }
  } catch { _promptRound = 1; }
  // Set true to make the NEXT chat() turn suppress function-calling (consumed and
  // cleared at the call site). Drives the forced-summarization turn above.
  let _forceNoToolsNext = false;
  // Set true when the loop detector's CIRCUIT BREAKER (hard backstop) trips. A
  // weak model often ignores the inline [STOP] tool_result and keeps emitting
  // filler ("Let me use the right tools…") plus more doomed tool calls — the
  // very "绕圈子" pathology. Once broken, the next chat() turn is forced
  // tools-free (reusing _forceNoToolsNext) with a terminal instruction, so the
  // model can ONLY write a final text answer from what it already has. One trip
  // per loop is enough; a second trip means it never converged → bail out.
  let _circuitBroken = false;
  // Latched once the tools-free closing turn has been armed, so a second trip
  // (model still didn't converge) bails out instead of looping the nudge.
  let _circuitBrokenHandled = false;
  // "Empty text + tool block, repeatedly" pathology: a weak model that keeps
  // re-calling tools (e.g. re-fetching the same news) WITHOUT ever writing a
  // closing answer. The first such turn is legitimate (call a tool, no
  // preamble), but a streak is a silent dead-end — previously the empty-reply
  // recovery block (forced-summary → salvage → E01) was gated on `!hasToolBlocks`
  // so it could never fire while every empty turn carried a tool_use block, and
  // the loop spun until max-iterations and returned an empty finalResponse
  // ("✓ 网络搜索完成" with no output). Track the streak and, once it crosses the
  // threshold (default 2: one legitimate tool turn + one repeat), route the turn
  // into the SAME recovery instead of dispatching the tool again.
  let emptyTextWithToolsStreak = 0;
  const emptyTextWithToolsMax = (() => {
    const v = parseInt(String(process.env.KHY_EMPTY_TEXT_TOOL_LOOP_MAX ?? '2'), 10);
    return Number.isFinite(v) && v >= 1 ? v : 2;
  })();

  // Dedup: track ALL tool calls (both success and failure) to avoid re-executing
  // identical calls. Previously only tracked failures, which allowed the AI to
  // call the same successful command (e.g. `tree /f .`) 10 times in a loop.
  const executedCallKeys = new Map(); // key -> { result, count }
  const fileReadHashes = new Map();   // absolutePath -> md5(first 10KB) for staleness detection
  let consecutiveDedupIterations = 0; // track consecutive all-deduped rounds
  // 跨轮「答案回声」断路器状态:本轮内已 substantive 流式过的答案指纹。answerEchoGuard 据此在结论前
  // 判断本轮答案是否复现了此前流式过的某个答案(重复输出 Flavor A/B 的统一缺口:无跨轮答案文本比对)。
  const _streamedAnswerFps = [];
  // 短停自动续写(默认关)单次封顶:全轮至多触发一次续写,防「续写又早停→再续写」抖动。
  let _shortStopContinuationUsed = false;

  // Phase 2: 5-detector loop detection (replaces simple dedup for advanced checks)
  let loopDetector;
  try {
    const { ToolLoopDetector } = require('./toolLoopDetector');
    loopDetector = new ToolLoopDetector();
    // Register known tools for unknown-tool detection
    try {
      const toolRegistry = require('../tools');
      const allTools = toolRegistry.getEnabled ? toolRegistry.getEnabled() : toolRegistry.getAll();
      if (allTools) {
        // Known-tool-name derivation memoized by enabled-name set (Ch2). Off →
        // rebuilds every turn (byte-identical). registerTools copies names into
        // its own Set, so the shared cached array is never mutated.
        loopDetector.registerTools(_resolveKnownToolNames(allTools));
      }
    } catch { /* registry not available, skip unknown-tool detection */ }
  } catch { loopDetector = null; /* toolLoopDetector not available */ }

  // Cross-turn repeat guard state (dormant unless the caller supplies
  // recentToolSignatures). cap bounds steers per turn so the steer can't loop.
  const _recentToolSigs = _normalizeRecentSignatures(options.recentToolSignatures);
  const _crossTurnSteer = {
    counts: new Map(),
    cap: Math.max(1, Math.min(2, _envIntOr(process.env.KHY_CROSS_TURN_TOOL_DEDUP_STEERS, 1))),
  };

  const capabilityAssessment = _assessExecutionCapability(originalUserMessage, options);
  if (typeof onCapabilityCheck === 'function') {
    try { onCapabilityCheck(capabilityAssessment); } catch { /* non-critical */ }
  }
  if (!capabilityAssessment.canProceed) {
    // Relaxed tiers (capabilityGate !== 'hard') are not pre-blocked: fold the
    // block reasons into warnings so the model still sees them via the prompt
    // injection below, and proceed.
    if (_harnessProfile.capabilityGate === 'hard') {
      return {
        finalResponse: _formatCapabilityFailureResponse(capabilityAssessment),
        toolCallLog,
        iterations: 0,
        stopped: true,
        capabilityAssessment,
        errorType: 'capability',
      };
    }
    if (_harnessProfile.capabilityGate === 'warn' && Array.isArray(capabilityAssessment.reasons)) {
      capabilityAssessment.warnings = [
        ...(capabilityAssessment.warnings || []),
        ...capabilityAssessment.reasons,
      ];
    }
    capabilityAssessment.canProceed = true;
  }

  const transparencyEnabled = _envFlagEnabled(
    options.transparency,
    _envFlagEnabled(process.env.KHY_TOOL_LOOP_TRANSPARENCY, true),
  );
  const effectiveChatOpts = {
    ...((chatOpts && typeof chatOpts === 'object') ? chatOpts : {}),
    // Thread the CLEAN original user message to chat() for every turn of this
    // loop. The per-turn `currentMessage` gets planning / key-findings / intent
    // prompts injected (see _injectPlanningPrompt / _injectKeyFindingsPrompt),
    // which would defeat detectPreferenceSignal's short-remark gate — so the
    // "太懂我了" preference learning in ai.js reads _originalUserMessage instead,
    // and only on the first iteration (guarded there via _isFollowUp). Without
    // this, learning silently dies in the default Ink TUI and classic REPL,
    // which both drive their turns through runToolUseLoop.
    _originalUserMessage: originalUserMessage,
  };
  // 问题 #1: 非流式适配器（如 IDE-token 类 Kiro/Cursor）把整段回复一次性返回，
  // 从不触发 onChunk(type:'text')，于是模型在调用工具前写的「说明」从未被渲染——
  // TUI 只剩工具调用 + 结果，看起来「只有命令输出、没有命令说明」。这里包装调用方
  // 的 onChunk 以跟踪本轮是否真的流式过文本；若没有，下方在执行工具前会把剥离后的
  // preamble 作为 text chunk 补发一次，让所有消费端（TUI/mobile/nonInteractive）
  // 都能显示说明，与流式适配器表现一致。
  const _callerOnChunk = (typeof effectiveChatOpts.onChunk === 'function')
    ? effectiveChatOpts.onChunk
    : null;
  let _sawStreamedText = false;
  // 惯性接续：累积本轮真正流给用户的文本前缀。连接中断时这段「已产出」就是惯性，
  // 用于在恢复接缝处无缝续接而非从零重启。每轮在 chat() 前重置（见循环顶部）。
  let _inertialStreamed = '';
  // De-dup guard for the non-streaming preamble re-emit below: on IDE-token
  // adapters (kiro/cursor) no text ever streams, so `_sawStreamedText` is false
  // every round and the model's pre-tool planning sentence gets re-emitted on
  // each loop pass. When a flaky channel makes the model repeat the SAME
  // planning preamble across retries, that surfaced as "连着三条一句一模一样的话".
  // Remember the last emitted preamble (whitespace-normalized) and skip identical
  // repeats within this turn.
  let _lastEmittedPreamble = '';
  if (_callerOnChunk) {
    effectiveChatOpts.onChunk = (chunk) => {
      try {
        if (chunk && chunk.type === 'text' && chunk.text) {
          _sawStreamedText = true;
          // 流式重复退化守卫：一旦本轮文本开始 chanting，立即停止把洪水转发给用户，
          // 让其永远看不到「要要要…×1000」。这里不杀连接——本轮结束后的矫正块会
          // 丢弃废稿并重发纠偏指令让模型干净重写。
          if (_streamRepGuard) {
            if (_streamRepetitionTripped) return; // 已退化：吞掉后续重复块
            _streamRepGuard.push(chunk.text);
            if (_streamRepGuard.inspect().tripped) {
              _streamRepetitionTripped = true;
              return; // 连这第一块退化文本也吞掉，不外泄
            }
          }
          // 仅累积真正转发给用户的文本（退化 chanting 已在上面 return，不计入），
          // 使惯性前缀与用户屏幕所见一致。
          _inertialStreamed += chunk.text;
        }
      } catch { /* never block streaming */ }
      return _callerOnChunk(chunk);
    };
  }
  // 抗拼接：当本轮已流式输出的文本将被判废重试（套话拒绝触发 nudge 重试）时，
  // 发一帧 reset 让按缓冲重渲染的消费端丢弃废稿，避免「废稿 + 重试好内容」拼接。
  // 仅在确有文本流出时发；发后清掉本轮流式状态，使下一轮 preamble 重新补发。
  const _emitStreamReset = (reason) => {
    if (!_sawStreamedText || !_callerOnChunk) return;
    try { _callerOnChunk(_responseDebounce.buildResetChunk(reason)); } catch { /* never block streaming */ }
    _sawStreamedText = false;
    _lastEmittedPreamble = '';
  };
  if (traceSessionId) effectiveChatOpts.sessionId = traceSessionId;
  effectiveChatOpts.requestId = requestId;
  effectiveChatOpts._diagTraceId = diagTraceId;
  // In loop mode, intermediate replies may include narration text before a
  // <tool_call>. Render it as normal streaming text (flowing commentary)
  // rather than collapsing it into a single dim one-line preface. Routing it
  // to a one-liner was suppressing Claude-Code-style narration. Opt back in
  // via KHY_TOOL_LOOP_ROUTE_PREFACE=1 if the terse one-liner is preferred.
  if (effectiveChatOpts.suppressPrefixOnToolCall === undefined) {
    effectiveChatOpts.suppressPrefixOnToolCall = _envFlagEnabled(
      process.env.KHY_TOOL_LOOP_SUPPRESS_TOOL_PREFACE,
      false
    );
  }
  if (effectiveChatOpts.routeToolPrefaceToNarration === undefined) {
    effectiveChatOpts.routeToolPrefaceToNarration = _envFlagEnabled(
      process.env.KHY_TOOL_LOOP_ROUTE_PREFACE,
      false
    );
  }
  const intentForceOverride = _envFlagEnabled(
    options?.intentGate?.forceOverride,
    _envFlagEnabled(process.env.KHY_ULTRAWORK_FORCE_OVERRIDE, false),
  );
  const gatePatch = (gatedInput && typeof gatedInput.chatOptsPatch === 'object')
    ? gatedInput.chatOptsPatch
    : {};
  for (const [key, value] of Object.entries(gatePatch)) {
    if (value === undefined || value === null || value === '') continue;
    const existing = effectiveChatOpts[key];
    const canSet = intentForceOverride || existing === undefined || existing === null || existing === '';
    if (canSet) effectiveChatOpts[key] = value;
  }
  // Pass intentGate directive to chat layer for system prompt injection
  const userConstraintDirective = _buildUserToolConstraintDirective(userToolConstraints);
  const combinedIntentDirective = [
    gatedInput.systemDirective,
    userConstraintDirective,
  ].filter(Boolean).join('\n\n');
  if (combinedIntentDirective) {
    effectiveChatOpts._intentDirective = combinedIntentDirective;
  }

  // 低阶模型自动检测：代理路径由 proxyServer 显式置位；KHY 自有 agent 路径
  // 改走 modelTier 脊椎（tier 判定的唯一来源），取代原内联正则。仅 T3（弱模型）
  // 标记为低阶；T0/T1/T2 不标记。modelTier 的 WEAK_RE 带字母边界守卫，不会像旧
  // 内联正则那样把 gemini-pro 误判为低阶（"mini" 嵌在 "ge·mini" 中）。
  if (!effectiveChatOpts._isLowTierModel && _harnessProfile.tier === 'T3') {
    effectiveChatOpts._isLowTierModel = true;
  }

  // 工具面板分级：仅 T3 弱模型裁减工具定义到 coding profile (~20 工具)，避免工具
  // 过多干扰弱模型；T0/T1/T2 保留全量面板。外部 proxyServer 置位的低阶标记仍尊重。
  if (effectiveChatOpts._isLowTierModel && Array.isArray(effectiveChatOpts.tools) && effectiveChatOpts.tools.length > 25) {
    try {
      const { getProfileTools } = require('../tools/toolProfile');
      const allowed = getProfileTools('coding');
      if (allowed) {
        const allowedSet = new Set(allowed.map(n => n.toLowerCase()));
        // 包含 Claude 兼容别名
        try {
          const { TOOL_ALIASES } = require('./claudeCompat');
          if (TOOL_ALIASES) {
            for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
              if (allowedSet.has(canonical.toLowerCase())) allowedSet.add(alias.toLowerCase());
            }
          }
        } catch { /* claudeCompat not available */ }
        // 外部 agent 委派可达性:externalAgentDirective(parent=KHY_WEAK_MODEL_GUIDANCE)
        // 向 coding profile 注入「调 Agent 工具 subagent_type 委派外部 CLI agent」指令 +
        // 点名 nudge,但 coding profile 不含 Agent 工具 → 弱模型被裁掉 Agent 却仍被指令
        // 要求用它,指向不存在的工具(自相矛盾),故只能内联做而非真委派。directive 开
        // 时把 Agent 保留进弱模型面板使指令兑现;门关 → 不加 = 逐字节回退(Agent 照旧裁)。
        try {
          const _ead = require('./externalAgentDirective');
          if (_ead.isExternalAgentDirectiveEnabled(process.env)) allowedSet.add('agent');
        } catch { /* externalAgentDirective not available */ }
        effectiveChatOpts.tools = effectiveChatOpts.tools.filter(
          t => allowedSet.has(String(t.name || '').toLowerCase())
        );
      }
    } catch { /* toolProfile not available, keep all */ }
  }
  const emitDecision = (payload) => {
    if (!transparencyEnabled || typeof onDecision !== 'function') return;
    try { onDecision(payload); } catch { /* non-critical */ }
  };
  const emitIterationSummary = (payload) => {
    if (!transparencyEnabled || typeof onIterationSummary !== 'function') return;
    try { onIterationSummary(payload); } catch { /* non-critical */ }
  };

  // Inject planning prompt for complex tasks. 'lean' verbosity (T0) trusts the
  // model's native planning and skips the injected scaffolding entirely; the
  // decompose dial independently suppresses the forced-decomposition directive.
  const complexResult = _isComplexTask(originalUserMessage);
  const isComplex = complexResult.isComplex;
  if (_harnessProfile.promptVerbosity !== 'lean' && isComplex && process.env.KHY_TASK_PLAN !== 'false') {
    const autoDecompose = _harnessProfile.decompose
      && _shouldAutoDecompose(originalUserMessage, complexResult.score);
    currentMessage = _injectPlanningPrompt(currentMessage, { autoDecompose });
  }
  // 关键节点主动汇报：教模型在命中里程碑时用 <finding> 标记吐出（根因/突破/受阻），
  // 由 loop 解析剥离、消费者渲染。与 planning 同为 user-message 前言；lean 档与子
  // agent 抑制（子 agent 输出折进父级 tree，逐子汇报是噪音）。
  if (_harnessProfile.promptVerbosity !== 'lean' && !effectiveChatOpts._isSubagent) {
    currentMessage = _injectKeyFindingsPrompt(currentMessage, process.env);
  }
  // 重复请求轮次提示:第 ≥2 轮注入 [SYSTEM] 指令,让模型继续深入而非声称「已经做完了」。
  if (_promptRound >= 2 && _promptRounds && !effectiveChatOpts._isSubagent) {
    try {
      const _roundHint = _promptRounds.buildRoundHint(_promptRound, process.env);
      if (_roundHint) currentMessage = `${_roundHint}\n\n${currentMessage}`;
    } catch { /* fail-soft:轮次提示绝不反噬主流程 */ }
  }
  if (Array.isArray(capabilityAssessment.warnings) && capabilityAssessment.warnings.length > 0) {
    const warningText = capabilityAssessment.warnings.join('；').slice(0, 240);
    currentMessage += `\n\n[SYSTEM: Capability precheck note: ${warningText}. Continue execution only when feasible. If blocked, explain why clearly.]`;
  }
  if (_harnessProfile.promptVerbosity !== 'lean' && _looksLikeAppLaunchRequest(originalUserMessage)) {
    currentMessage += '\n\n[SYSTEM: For app launch tasks, use the open_app tool first. Avoid shell probing commands like which/ps/nohup/grep unless open_app has already failed and you explain that failure.]';
  }
  // CC 对齐计划模式:先调研再做计划。本轮为计划模式且门开时,首轮 currentMessage 追加只读调研指令——
  // 教模型先用只读工具(Read/Grep/Glob/LS)尽调、再调 ExitPlanMode(plan) 呈现计划(实时工具行即进度,
  // 不弹「正在生成执行计划」大方框)。纯叶子 planModeDirective 持门 KHY_PLAN_CC_RESEARCH,门关返空串
  // → 不注入(逐字节回退)。fail-soft:指令构造绝不反噬主流程。
  if (planMode) {
    try {
      const _pd = require('./planModeDirective').buildPlanDirective(process.env);
      if (_pd) currentMessage += `\n\n${_pd}`;
    } catch { /* fail-soft:计划指令绝不反噬主流程 */ }
  }

  // Guardrails: idle timeout (activity-aware), read-only cap, and consecutive failure cap
  // These thresholds adapt based on task complexity instead of being fixed
  const loopStartTime = Date.now();
  let lastActivityTime = Date.now(); // Reset on each productive iteration
  let lastCheckpointTime = Date.now(); // For onCheckpoint throttling
  const IDLE_TIMEOUT_MS = maxElapsedMs; // Reuse config value as idle timeout, not hard wall
  const MAX_READ_ONLY_ITERATIONS = isComplex ? 8 : 5;
  const MAX_CONSECUTIVE_FAILURES = isComplex ? 5 : 3;
  const MAX_WEB_LOOKUP_FAILURES = 2;
  let consecutiveReadOnlyIterations = 0;
  let consecutiveFailureIterations = 0;
  let consecutiveWebLookupFailureIterations = 0;
  // 搜索循环主动收敛(goal 2026-06-25):连续「纯搜索且成功却不收口」的轮数 +
  // 是否已强制过一次收敛(一次性)。判定由 ./query/searchConvergence 单源裁定,见下方接缝。
  let _searchOnlyRounds = 0;
  let _searchConvergenceForced = 0;

  // ── Crash recovery: inject prior canonical state if available ──────
  try {
    const _canonicalState = require('./canonicalState');
    const sessionId = requestedSessionId || 'default';
    const recovered = _canonicalState.load(sessionId);
    if (recovered && recovered.goal && (Date.now() - (recovered.timestamp || 0)) < 3600_000) {
      const recoveryPrompt = _canonicalState.formatAsPrompt(recovered);
      if (recoveryPrompt) {
        currentMessage = `[SYSTEM: Recovered context from prior session]\n${recoveryPrompt}\n\n---\n\n${currentMessage}`;
      }
    }
  } catch { /* canonical state recovery is best-effort */ }

  let _goalModeSavedState = null;
  try {

  // ── 自主执行模式: preflight check + activate ─────────────────────
  // goal/ultrawork/coding 三种模式均启用全权限自主执行，每个阶段作为小目标完成
  const _autonomousModes = ['goal', 'ultrawork', 'coding'];
  const _activatedModes = gatedInput.activatedModes || [];
  const _hasAutonomousMode = _activatedModes.some(m => _autonomousModes.includes(m));
  const _goalModeActive = _activatedModes.includes('goal');

  if (_hasAutonomousMode) {
    try {
      const goalModeService = require('./goalModeService');

      // goal 模式专属: 前置能力评估，能力不足直接返回
      if (_goalModeActive) {
        const goalText = gatedInput.detection?.goalText || '';

        let enabledToolNames = [];
        try {
          const toolRegistry = require('../tools');
          const allTools = toolRegistry.getEnabled ? toolRegistry.getEnabled() : toolRegistry.getAll();
          enabledToolNames = allTools instanceof Map ? [...allTools.keys()] : Object.keys(allTools || {});
        } catch { /* tools not available */ }

        const preflight = goalModeService.preflightCheck(goalText, {
          modelName: effectiveChatOpts.preferredModel || process.env.GATEWAY_PREFERRED_MODEL || '',
          enabledTools: enabledToolNames,
        });

        if (!preflight.canProceed) {
          return {
            finalResponse: goalModeService.formatPreflightFailure(preflight),
            toolCallLog: [],
            iterations: 0,
            stopped: true,
            errorType: 'goal_preflight',
          };
        }
      }

      // 所有自主模式: 提升权限，不中断用户
      _goalModeSavedState = goalModeService.activateIfNeeded();
    } catch { /* goalModeService not available — continue without autonomous mode */ }
  }

  // ── Conversation message tracker for capacity flow ─────────────────
  // The chat() function manages the actual conversation context internally.
  // This local array mirrors user→AI exchanges so that capacityFlow and
  // seamManager can estimate token usage and decide when to trim/archive.
  // Continuation rounds can inject prior conversation via initialMessages.
  let conversationMessages = [
    ...(Array.isArray(initialMessages) ? initialMessages : []),
    { role: 'user', content: currentMessage },
  ];

  // ── LSP diagnostics accumulator ────────────────────────────────────
  // Collected during tool execution, flushed into currentMessage for the
  // next AI round so the model can self-correct based on compiler errors.
  let _pendingLspDiagnostics = [];

  // B2: 绝对超时 — 活跃执行保护上限（可通过环境变量配置）
  const TOOL_LOOP_ABSOLUTE_TIMEOUT_MS = parseInt(
    process.env.KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS || '1200000', 10
  ); // 默认 20 分钟（对标 Claude Code 无硬上限，复杂编码任务需要充足时间）
  const _loopStartTime = Date.now();
  let _truncationContinuations = 0;
  let _truncationAccumulator = ''; // Accumulated text from truncated responses
  // s11: diminishing-returns guard for truncation recovery. Thresholds are
  // env-overridable (no hardcoding); the module supplies the fallback defaults.
  const _maxTokensRecovery = require('./query/maxTokensRecovery');
  // 续接策略单一真源：判定错误类型可否自动续接 + 提供「继续」提示文案。
  const _continuation = require('./query/continuation');
  // 惯性接续单一真源（goal 2026-06-25「多处链接不稳定的地方可以使用惯性接续」）：
  // 在连接不稳定的三处接缝（transient 重试 / empty-reply / stall-nudge），把「丢弃
  // 已流出前缀 + from-scratch」改为「捕获前缀 + 无缝续接」。无前缀时回落到逐字一致的
  // 旧 from-scratch 指令，纯增量、向后兼容。生命周期镜像上面的 _truncationAccumulator。
  const _inertialContinuation = require('./query/inertialContinuation');
  let _inertialCarryover = ''; // 跨 continue 持久保存的已产出前缀（惯性）
  // 主动协助 + 被动兜底（goal 2026-06-25）：缺总结/全失败/空闲超时三处裸露的被动接缝,
  // 由 activeAssist 单源裁定是否主动补救。一次性计数器在循环外声明,见下方。
  const _activeAssist = require('./query/activeAssist');
  // 搜索循环主动收敛单源:连续 N 轮纯搜索且未综合 → 主动强制一轮禁工具的综合作答,
  // 不放任「换词搜索」绕圈子到超时(详见模块头)。
  const _searchConvergence = require('./query/searchConvergence');
  // 响应防抖 / 抗抖动：剥离前缀残留套话拒绝 + 丢弃废稿的流式重置帧。
  const _responseDebounce = require('./query/responseDebounce');
  // 流式重复退化守卫：实时发现 token 级 chanting（同片段反复），供本轮矫正使用。
  const _streamRepetitionGuard = require('./query/streamRepetitionGuard');
  // 跨轮「答案回声」断路器 + 软交付门抑制:见 answerEchoGuard 模块头(修重复输出)。
  const _answerEchoGuard = require('./answerEchoGuard');
  // 单次 completion 内「整段答案逐字重复两遍(A+A)」折叠:见 replyDedup 模块头(修重复输出)。
  const _replyDedup = require('./replyDedup');
  // 弱模型自然早停的一次性自动续写缓解(默认关):见 shortStopContinuation 模块头(缓解截断)。
  const _shortStopContinuation = require('./query/shortStopContinuation');
  let _negligibleContinuations = 0;
  const _truncationMinChars = (() => {
    const n = parseInt(process.env.KHY_TRUNCATION_MIN_CHARS || '', 10);
    return Number.isFinite(n) && n > 0 ? n : _maxTokensRecovery.MIN_CONTINUATION_CHARS;
  })();
  const _maxNegligibleContinuations = (() => {
    const n = parseInt(process.env.KHY_TRUNCATION_MAX_NEGLIGIBLE || '', 10);
    return Number.isFinite(n) && n > 0 ? n : _maxTokensRecovery.MAX_NEGLIGIBLE_CONTINUATIONS;
  })();
  let _stopHookActive = false; // s04: Stop hook 已强制续跑一次后置位，防无限续跑
  let _hookStopRequested = false; // s04: PostToolUse 请求优雅停机
  let _hookStopReason = '';
  let _lastCapabilityRoute = null; // 最近一轮组合的能力路线（KHY_CAPABILITY_ROUTE_DEBUG 下填充，附到结果供观测）
  const budget = new IterationBudget(effectiveMaxIterations);

  // 系统层 D2 — token-budget governor state. ceiling 0 ⇒ disabled (byte-fallback:
  // no accumulation effect, assessBudget always 'ok', loop never stops on spend).
  const _tokenBudgetCfg = _tokenBudget ? _tokenBudget.resolveBudget(process.env) : { ceiling: 0, warnRatio: 0.8 };
  // CC in-prompt budget directive (utils/tokenBudget.ts): a "+500k" / "use 2M
  // tokens" typed in the user's OWN prompt sets THIS turn's ceiling, layered over
  // the KHY_TOKEN_BUDGET env default. Gate KHY_PROMPT_TOKEN_BUDGET (default on);
  // no directive / gate off ⇒ ceiling unchanged ⇒ byte-identical legacy behavior.
  // Transient (this turn only), user-explicit, never persisted. Applied before the
  // diagnostics revive below so an in-prompt ceiling lights up observability too.
  if (_tokenBudget && _tokenBudget.resolvePromptBudget) {
    try {
      const _promptCeiling = _tokenBudget.resolvePromptBudget(userMessage, process.env);
      if (_promptCeiling > 0) _tokenBudgetCfg.ceiling = _promptCeiling;
    } catch { /* fail-soft: keep the env ceiling */ }
  }
  let _tokensSpent = 0;
  // Revive the dormant diagnostics budget API once, only when enforcing, so
  // getSummary().tokenUsage and the warning/critical anomalies light up too.
  if (_tokenBudgetCfg.ceiling > 0) {
    try { require('./advancedDiagnostics').getInstance().setTokenBudget(_tokenBudgetCfg.ceiling); } catch { /* observability only */ }
  }

  // cognitiveSnapshot observe-mode 接线（DESIGN-ARCH-035）。默认关闭、fail-soft；
  // 启用后每轮在 Capacity Checkpoint 处用真实 token 估算驱动溢出前置闸门并记入
  // diagnostics（零磁盘副作用、不改 message、不阻断）。见 maybeAttachCognitiveObserver。
  const _cogObserver = maybeAttachCognitiveObserver(originalUserMessage, options);

  // ── MCP auto-connect (one-shot, gated, best-effort) ──────────────────
  // Close the runtime gap: the consumer-side MCP client was fully built but
  // nothing ever called connectAll(), so configured external servers' tools
  // were unreachable. Connect once per process here so the per-turn
  // refreshMcpToolPool() below actually finds connected servers. No-op when no
  // servers are configured; gated off (KHY_MCP_AUTOCONNECT=false) = legacy.
  try {
    await require('./mcp/autoConnect').ensureMcpConnected({
      projectDir: process.env.KHYQUANT_CWD || process.cwd(),
    });
  } catch { /* MCP auto-connect is best-effort and never blocks the loop */ }

  // 编辑后诊断基线是「本 turn 内」的 before/after 契约:每个顶层 turn 起点清空,防止上一 turn
  // 遗留的基线跨 turn 误判(门控 KHY_POST_EDIT_DIAGNOSTICS 关时服务 reset 亦 no-op)。子智能体
  // turn(_isSubagent)**不得**清父级共享基线(RISK 3),否则父循环的新增诊断会被子 turn 抹掉。
  if (!effectiveChatOpts._isSubagent) {
    try { require('./postEditDiagnostics').reset(); } catch { /* best-effort */ }
  }

  while (!budget.depleted || budget.graceAvailable) {
    budget.consume();
    const iteration = budget.used;
    _sawStreamedText = false; // 问题 #1: 每轮重置，用于检测非流式适配器并补发说明
    if (interruptSignal) interruptSignal._currentIteration = iteration;
    if (onIteration) onIteration(iteration, totalToolCalls);
    if (typeof onThinking === 'function') {
      try { onThinking(`Agent loop progressing: round ${iteration}/${effectiveMaxIterations}`); } catch { /* non-critical projection */ }
    }

    // ── s04: PostToolUse 优雅停机 ─────────────────────────────────────
    // 上一轮某个 PostToolUse hook 请求了 preventContinuation：在新一轮真正发起
    // chat() 之前干净收尾。区别于 break 走到 max-iter fallback（会误标触顶）。
    if (_hookStopRequested) {
      const stoppedText = _stripToolCalls(_stripExecutionPlan(lastResult?.reply || ''))
        || _buildToolResultMessage(toolResults).text;
      _loopBreadcrumb('posttool-hook-stop', { iteration, reason: _hookStopReason });
      _emitDeliveryFinalEvent(traceAudit, traceSessionId, diagTraceId, requestId, {
        requestId, success: true, totalToolCalls,
        finalReplyLength: String(stoppedText || '').trim().length,
        hasConclusion: _looksLikeDeliveryConclusion(stoppedText), hookStopped: true,
      });
      return {
        finalResponse: stoppedText, toolCallLog, iterations: iteration,
        provider: lastResult?.provider, conversationMessages,
        harnessProfile: _harnessProfile, hookStopped: true,
      };
    }

    // ── 系统层 D2: token-budget hard stop ────────────────────────────
    // Before issuing the next chat() round, halt cleanly if cumulative spend has
    // reached the ceiling — synthesizing a final reply from work already done,
    // with NO extra model call (mirrors the PostToolUse hook-stop above). Disabled
    // (ceiling 0) ⇒ assessBudget always 'ok' ⇒ this branch is never taken ⇒
    // byte-identical legacy behavior.
    if (_tokenBudget && _tokenBudgetCfg.ceiling > 0) {
      const _verdict = _tokenBudget.assessBudget({
        spent: _tokensSpent, ceiling: _tokenBudgetCfg.ceiling, warnRatio: _tokenBudgetCfg.warnRatio,
      });
      if (_verdict.state === 'stop') {
        const stoppedText = _stripToolCalls(_stripExecutionPlan(lastResult?.reply || ''))
          || _buildToolResultMessage(toolResults).text;
        const notice = _tokenBudget.buildBudgetStopNotice({
          spent: _tokensSpent, ceiling: _tokenBudgetCfg.ceiling, env: process.env,
        });
        const finalResponse = (stoppedText ? String(stoppedText).trimEnd() + '\n\n' : '') + notice;
        _loopBreadcrumb('token-budget-stop', { iteration, spent: _tokensSpent, ceiling: _tokenBudgetCfg.ceiling });
        _emitDeliveryFinalEvent(traceAudit, traceSessionId, diagTraceId, requestId, {
          requestId, success: true, totalToolCalls,
          finalReplyLength: String(finalResponse || '').trim().length,
          hasConclusion: _looksLikeDeliveryConclusion(stoppedText), budgetStopped: true,
        });
        return {
          finalResponse, toolCallLog, iterations: iteration,
          provider: lastResult?.provider, conversationMessages,
          harnessProfile: _harnessProfile, budgetStopped: true,
        };
      }
    }

    // ── Phase 2: Interrupt check ─────────────────────────────────────
    if (interruptSignal && interruptSignal.interrupted) {
      // Update iteration tracking on the signal
      interruptSignal._currentIteration = iteration;

      // 1. Save checkpoint
      if (typeof onCheckpoint === 'function') {
        try {
          onCheckpoint({
            iteration,
            totalToolCalls,
            toolCallLog: toolCallLog.slice(-20),
            messages: conversationMessages,
            currentMessage,
            fileReadHashes,
            _interrupted: true,
          });
        } catch { /* best-effort */ }
      }

      // 2. Emit onInterrupt callback
      const interruptEvt = interruptSignal._event || {
        type: 'pause', reason: 'user_request', iteration,
        timestamp: Date.now(), resumeRequired: true, metadata: null,
      };
      if (typeof onInterrupt === 'function') {
        try { onInterrupt(interruptEvt); } catch { /* non-critical */ }
      }

      // 3. If resumeRequired: await the resume promise
      if (interruptEvt.resumeRequired && interruptSignal._resumePromise) {
        try {
          const resumeData = await interruptSignal._resumePromise;
          // Reset interrupt state after resume
          interruptSignal.interrupted = false;
          interruptSignal._event = null;
          interruptSignal._resumePromise = null;
          // Inject resume context if provided
          if (resumeData && resumeData.additionalContext) {
            currentMessage += `\n\n[SYSTEM: User resumed execution. Additional context: ${String(resumeData.additionalContext).slice(0, 500)}]`;
          }
          lastActivityTime = Date.now();
          // Continue the loop normally from this iteration
        } catch (resumeErr) {
          // Resume rejected (cancelled) — exit the loop
          return {
            finalResponse: lastResult?.reply || 'Workflow cancelled during pause.',
            toolCallLog,
            iterations: iteration,
            stopped: true,
            cancelled: true,
          };
        }
      } else {
        // Not resumeRequired — permanent stop
        return {
          finalResponse: lastResult?.reply || 'Workflow interrupted.',
          toolCallLog,
          iterations: iteration,
          stopped: true,
          interrupted: true,
        };
      }
    }

    // B2: 绝对时间超时检查（防止 160 轮迭代耗时数十分钟无回复）
    const loopElapsed = Date.now() - _loopStartTime;
    if (loopElapsed > TOOL_LOOP_ABSOLUTE_TIMEOUT_MS) {
      const limitText = _formatDurationMs(loopElapsed);
      const collected = _stripToolCalls(_stripExecutionPlan(lastResult?.reply || ''));
      const hasContent = collected.length > 80;
      return {
        finalResponse: (hasContent ? collected : '处理时间过长，已返回当前进度。') +
          `\n\n${chalk.yellow(`⚠ 工具循环已运行 ${limitText}，已达到绝对时间上限。`)}`,
        toolCallLog,
        iterations: iteration - 1,
        provider: lastResult?.provider,
        timeLimitReached: true,
        maxIterationsReached: true, // 触发 Ralph Loop 自动续接
        maxElapsedMs: loopElapsed,
      };
    }

    // Idle guardrail: only timeout when no productive activity for IDLE_TIMEOUT_MS.
    // Active tool execution resets the timer, so long-running tasks don't get killed.
    const idleMs = Date.now() - lastActivityTime;
    if (idleMs > IDLE_TIMEOUT_MS) {
      const limitText = _formatDurationMs(IDLE_TIMEOUT_MS);
      const collected = _stripToolCalls(_stripExecutionPlan(lastResult?.reply || ''));
      const hasSubstantiveContent = collected.length > 80;
      // ── A3 主动协助：空闲超时但无实质内容 → 先续接一次再认输 [被动响应→主动协助+被动兜底] ──
      // 旧行为：一旦空闲超时且无内容，直接返回套话认输。改为先走一次 inertialContinuation
      // 续接（单一真源），给上游一轮恢复机会；仍无果再回落下方 timeWarning。一次性防死循环。
      let _idleAssist = false;
      try {
        _idleAssist = _activeAssist.shouldAttemptIdleContinuation({
          substantive: hasSubstantiveContent, used: _idleAssistUsed > 0,
        });
      } catch { /* fail-soft */ }
      if (_idleAssist) {
        _idleAssistUsed += 1;
        lastActivityTime = Date.now(); // 重置空闲计时，给续接一轮机会
        currentMessage += _inertialContinuation.buildContinuationDirective({
          reason: 'stall', carryover: _inertialCarryover,
        });
        _loopBreadcrumb('idle-continuation', { iteration, idleMs });
        continue;
      }
      const timeWarning = hasSubstantiveContent
        ? `\n\n${chalk.yellow(`⚠ AI 已 ${limitText} 无新进展，返回已收集到的信息。如需继续请重新发送请求。`)}`
        : `\n\n${chalk.yellow(`⚠ 抱歉，AI 在 ${limitText} 内未能取得进展。`)}` +
          `\n${chalk.dim('建议：1) 将问题拆分为更小的步骤  2) 提供更具体的上下文  3) 尝试换一种问法')}`;
      return {
        finalResponse: (hasSubstantiveContent ? collected : '很抱歉，处理过程中未能取得进展。') + timeWarning,
        toolCallLog,
        iterations: iteration - 1,
        provider: lastResult?.provider,
        timeLimitReached: true,
        maxElapsedMs: IDLE_TIMEOUT_MS,
      };
    }

    // Read-only guardrail: if AI keeps reading without acting, nudge it forward
    // Use a gentler, more context-aware prompt instead of demanding immediate stop
    if (consecutiveReadOnlyIterations >= MAX_READ_ONLY_ITERATIONS) {
      currentMessage += '\n\n[SYSTEM: You have read quite a few files now. You likely have enough context. Time to act — start making changes, running commands, or give your answer. If you genuinely need to read more, explain why in one sentence first.]';
      consecutiveReadOnlyIterations = 0;
    }

    // ── Capacity Checkpoint 1: Pre-Request ────────────────────────────
    // Evaluate context pressure before API call. If crowded, trim.
    // Also run seam manager to archive old context if thresholds are hit.
    try {
      const _capacityFlow = require('./capacityFlow');
      let _estimateTokensFn;
      try { _estimateTokensFn = require('./tokenUsageService').estimateTokens; } catch { /* fallback */ }
      if (typeof _estimateTokensFn !== 'function') _estimateTokensFn = (text) => Math.ceil((text || '').length / 4);
      // Per-message memo (messageTokenTally, gate KHY_MSG_TOKEN_MEMO default on): surviving
      // messages keep their token estimate; only new ones compute → O(N²)→O(N)/turn on the
      // blocking task path. Fail-soft to the original inline reduce (byte-identical) on any error.
      let _usedTokens;
      try {
        _usedTokens = require('./messageTokenTally').sumMessageTokens(conversationMessages, _estimateTokensFn, process.env);
      } catch {
        _usedTokens = conversationMessages.reduce(
          (sum, m) => sum + _estimateTokensFn(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')),
          0
        );
      }
      const _contextWindow = effectiveChatOpts?.contextWindowTokens || parseInt(process.env.KHY_CONTEXT_WINDOW, 10) || 128000;

      // cognitiveSnapshot observe-mode：用本轮真实 token 估算驱动溢出前置闸门（best-effort）。
      if (_cogObserver) {
        _cogObserver.observe({ iteration, usedTokens: _usedTokens, contextWindow: _contextWindow });
      }

      // Seam manager: append-only archiving at graduated thresholds
      try {
        const _seamMgr = require('./seamManager');
        const seamResult = await _seamMgr.checkAndApply(conversationMessages, _usedTokens);
        if (seamResult.applied) {
          conversationMessages = seamResult.messages;
        }
      } catch { /* seam is best-effort */ }

      const preCheck = _capacityFlow.preRequestCheckpoint({
        usedTokens: _usedTokens,
        contextWindow: _contextWindow,
        messages: conversationMessages,
      });
      if (preCheck.decision !== _capacityFlow.CapacityDecision.None) {
        conversationMessages = _capacityFlow.applyDecision(
          preCheck.decision,
          conversationMessages,
          { estimateTokens: _estimateTokensFn, contextWindow: _contextWindow }
        );
      }
      // Drive coherence state machine from checkpoint result
      try {
        const { getCoherenceState } = require('./coherenceState');
        const csm = getCoherenceState();
        csm.transition(preCheck);
        if (preCheck.decision !== _capacityFlow.CapacityDecision.None) {
          csm.completeOperation(); // refresh was applied inline
        }
      } catch { /* coherence tracking is optional */ }
    } catch { /* capacity flow is best-effort, never blocks the loop */ }

    // 1. Send to AI
    // Hook: PrePrompt — allow hooks to modify prompt or block
    const hookSys = _getHookSystem();
    if (hookSys) {
      try {
        const promptHr = await hookSys.trigger('PrePrompt', { prompt: currentMessage, iteration });
        if (promptHr.blocked) break;
        if (promptHr.context?.prompt) currentMessage = promptHr.context.prompt;
        // additionalContext: clean append semantics (CC HookResult parity).
        // Lets a hook inject context without re-reading and re-assembling the
        // whole prompt — the equivalent of CC's UserPromptSubmit context inject.
        if (promptHr.context?.additionalContext) {
          const extra = String(promptHr.context.additionalContext).trim();
          if (extra) currentMessage = `${currentMessage}\n\n${extra}`;
        }
      } catch { /* hook failure should not block AI pipeline */ }
    }

    // Auto-reasoning: resolve effort tier from user message keywords
    // Only on first iteration (the original user message); follow-ups keep same tier.
    if (iteration === 1 && effectiveChatOpts.reasoning_effort === 'auto') {
      try {
        const _autoReasoning = require('./autoReasoning');
        let tier = _autoReasoning.resolveEffort(currentMessage, {
          isSubagent: !!effectiveChatOpts._isSubagent,
        });
        // T0 thinking floor: never drop below the configured minimum effort.
        const _floor = _harnessProfile.thinkingFloor;
        if (_floor) {
          const _order = { low: 0, high: 1, max: 2 };
          if ((_order[tier] ?? 1) < (_order[_floor] ?? 1)) tier = _floor;
        }
        const provider = effectiveChatOpts.provider || effectiveChatOpts.adapter || 'anthropic';
        const reasoningParams = _autoReasoning.effortToParams(tier, provider);
        Object.assign(effectiveChatOpts, reasoningParams);
      } catch { /* auto-reasoning is best-effort */ }
    }

    // Phase 7: Create StreamingToolExecutor for pre-execution during streaming
    let _streamingExec = null;
    if (process.env.KHY_STREAMING_TOOL_EXEC === 'true') {
      try {
        const { StreamingToolExecutor } = require('./query/streamingToolExecutor');
        const toolCalling = require('./toolCalling');
        let toolRegistry;
        try { toolRegistry = require('../tools'); } catch { toolRegistry = null; }
        _streamingExec = new StreamingToolExecutor({
          executeTools: (name, params, ctx) => toolCalling.executeTool(name, params, {
            sessionId: traceSessionId, traceId: diagTraceId, requestId, ...ctx,
          }),
          isConcurrencySafe: (name) => {
            if (toolRegistry) {
              const rt = toolRegistry.get(name);
              if (rt && typeof rt.isConcurrencySafe === 'function') return rt.isConcurrencySafe({});
            }
            return /^(read_file|readFile|grep|glob|search|web_search|webSearch|ls|quote|data_fetch|git_status|git_diff|git_log)$/i.test(name);
          },
        });
      } catch { /* StreamingToolExecutor not available */ }
    }

    // ── s13: background-task completion notifications ─────────────────
    // Drain any background agents that finished since the last turn and inject
    // their <task_notification> blocks into this turn's message. Best-effort:
    // a failure here must never block the main loop. Uses a fresh task id — the
    // original spawn call already received its placeholder tool_result.
    try {
      // Drain every registered background source (sub-agents AND shell commands).
      // Each source exposes the same collectBackgroundResults() contract so the
      // loop stays agnostic to what kind of work finished.
      const _drained = [];
      for (const _modPath of ['../tools/AgentTool', '../tools/backgroundShellRegistry']) {
        try {
          const _mod = require(_modPath);
          if (_mod && typeof _mod.collectBackgroundResults === 'function') {
            const _part = _mod.collectBackgroundResults();
            if (Array.isArray(_part) && _part.length) _drained.push(..._part);
          }
        } catch { /* one bad source must not stop the others */ }
      }
      if (_drained.length) {
        const _notif = require('./query/taskNotification').buildTaskNotifications(_drained);
        if (_notif) {
          currentMessage = `${_notif}\n\n${currentMessage || ''}`;
          if (onToolResult) {
            onToolResult('_task_notification', {}, { success: true }, iteration, 0,
              `${_drained.length} background task(s) completed`);
          }
        }
      }
    } catch { /* notifications are best-effort and never block the loop */ }

    // ── s15: teammate lead-inbox injection ────────────────────────────
    // Drain any messages teammates sent to the lead since the last turn and
    // inject them as <teammate-message> blocks into this turn's message. This
    // is the keystone that makes teammates multi-turn collaborators rather than
    // fire-and-forget sub-agents. Best-effort: never block the main loop.
    try {
      const _teamText = require('../tools/teammateBus').collectTeammateMessagesAsText();
      if (_teamText) {
        currentMessage = `${_teamText}\n\n${currentMessage || ''}`;
        if (onToolResult) {
          onToolResult('_teammate_message', {}, { success: true }, iteration, 0,
            'teammate message(s) received');
        }
      }
    } catch { /* teammate injection is best-effort and never blocks the loop */ }

    // ── s20: refresh the MCP tool partition before assembling the pool ────
    // This is the per-turn slot the s19 bridge was missing: every iteration,
    // re-sync the registry's MCP partition to the currently-connected servers
    // so a `connect_mcp` from the previous turn makes its `mcp__server__tool`
    // tools callable this turn, and a disconnect drops them. Cheap no-op when
    // no servers are connected; never throws into the loop.
    try {
      require('./mcp/toolPool').refreshMcpToolPool();
    } catch { /* MCP pool refresh is best-effort and never blocks the loop */ }

    // 每轮重置流式重复守卫：退化只在单轮的流内成立。
    _streamRepetitionTripped = false;
    _streamRepGuard = _streamRepetitionGuard.isEnabled()
      ? _streamRepetitionGuard.create()
      : null;
    // 每轮重置惯性前缀缓冲：_inertialStreamed 仅承载「本轮」流出的文本；跨轮的
    // 已产出前缀由 _inertialCarryover 持久保存，不在此清空。
    _inertialStreamed = '';

    // 断线惯性 · Seam 0(无感衔接）：上一轮检测到断线惯性回合并完成了已下达的工具调用,
    // 这次模型调用就是「重连」——在循环顶部唯一 chokepoint 把重连提示前置注入 currentMessage,
    // 让重连后的模型显式知道「刚断过线、以上结果由惯性完成」从而据此续跑、勿重复。pull-clear。
    if (_pendingInertiaReconnectHint) {
      currentMessage = `${_pendingInertiaReconnectHint}\n\n${currentMessage || ''}`;
      _pendingInertiaReconnectHint = '';
    }

    // [AI-弱模型·照抄] 不信任弱模型:多套「照着做」的确定性流程注入(判定在 procedureCatalog 纯叶子,
    //   这里只做 IO)。首轮据用户消息匹配到某类高频任务 → 把整套编号流程前置注入 currentMessage,让弱
    //   模型「照着做」而非「开盲盒」。只在首轮注入一次(coding profile 已始终带流程**索引**,这里补**完整步骤**)。
    //   门控 KHY_PROCEDURE_CATALOG(parent KHY_WEAK_MODEL_GUIDANCE)关 → matchProcedure 返 null,逐字节
    //   回退(不注入)。整块 try/catch fail-soft,叶子出错绝不阻断主循环。
    if (iteration === 1) {
      try {
        const _pc = require('./procedureCatalog');
        const _proc = _pc.matchProcedure(sanitizedUser || userMessage || '', process.env);
        if (_proc) {
          const _block = _pc.buildProcedureBlock(_proc);
          if (_block) {
            currentMessage = `${_block}\n\n${currentMessage || ''}`;
            try { _loopBreadcrumb('procedure-catalog', { iteration, procedure: _proc.id }); } catch { /* breadcrumb best-effort */ }
          }
        }
      } catch { /* procedure catalog best-effort — never block delivery on its own errors */ }

      // 让 khyos 学会用自然语言驱动别的 agent:首轮据用户消息**确定性识别**是否点名某外部 agent
      // (「用 claude code…」「让 codex 跑测试」「叫 opencode 改这个」)。命中 → 前置注入一次性
      // 路由 nudge,逼弱模型真的用 Agent 工具委派(delegatable)或提示顶层 `khy <name>` 启动,而非
      // 内联硬啃或口头敷衍。coding profile 已始终带**能力指令**,这里补**点名时的确定性路由**。
      // 门控 KHY_EXTERNAL_AGENT_NUDGE(parent KHY_EXTERNAL_AGENT_DIRECTIVE)关 → detect 返 null,
      // 逐字节回退(不注入)。整块 try/catch fail-soft,叶子出错绝不阻断主循环。
      try {
        const _ead = require('./externalAgentDirective');
        // 用 originalUserMessage(1188 行声明的原始用户消息)——不能用 sanitizedUser,
        // 后者在本函数 4005 行才 const 声明,此处(2467)引用会触发 TDZ ReferenceError
        // 被下面 catch 静默吞掉,使 nudge 永不注入(实测:点名「用 claude code」也从不委派)。
        const _nudge = _ead.buildExternalAgentNudge(originalUserMessage || userMessage || '', process.env);
        if (_nudge) {
          currentMessage = `${_nudge}\n\n${currentMessage || ''}`;
          try { _loopBreadcrumb('external-agent-route', { iteration }); } catch { /* breadcrumb best-effort */ }
        }
      } catch { /* external agent nudge best-effort — never block delivery on its own errors */ }

      // 诊断锚定:用户在追问「为什么报这个错」且上一轮有已捕获的真实失败 → 前置注入一次性
      // [SYSTEM: 诊断锚定],pin 那条真因逼模型先诊断它,而非抓表层 token(如状态码数字)另起
      // 无关调查(实测:model_not_found 404 → 弱模型跑去查 nginx.conf)。门控 KHY_DIAGNOSTIC_GROUNDING
      // (parent KHY_WEAK_MODEL_GUIDANCE)关 → detect 返 false / build 返 null → 逐字节回退(不注入)。
      // 整块 try/catch fail-soft,叶子出错绝不阻断主循环。
      try {
        const _dg = require('./diagnosticGrounding');
        if (_dg.detectWhyFailureQuestion(originalUserMessage || userMessage || '', process.env)) {
          const _ground = _dg.buildGroundingDirective(undefined, process.env);
          if (_ground) {
            currentMessage = `${_ground}\n\n${currentMessage || ''}`;
            try { _loopBreadcrumb('diagnostic-grounding', { iteration }); } catch { /* breadcrumb best-effort */ }
          }
        }
      } catch { /* diagnostic grounding best-effort — never block delivery on its own errors */ }
    }

    let aiResult;
    try {
      aiResult = await chat(currentMessage, {
        ...effectiveChatOpts,
        // Force tool use only on the FIRST iteration so the model actually
        // starts acting. On later iterations relax to 'auto' so it can narrate
        // between tool calls and write a natural-language closing summary —
        // a forced ('required'/'any') tool_choice makes the API suppress all
        // assistant text, which is the root cause of "no narration".
        _intentToolChoice: iteration === 1 && !_forceNoToolsNext ? effectiveChatOpts._intentToolChoice : undefined,
        _isFollowUp: iteration > 1,
        // Forced-summarization turn (Fix #3): suppress function-calling for this one
        // turn so the model can only write the closing summary. One-shot — cleared
        // immediately after the call so the next turn behaves normally.
        _forceNoTools: _forceNoToolsNext,
        _streamingExecutor: _streamingExec,
      });
    } catch (chatErr) {
      // 防御纵深(门 KHY_TOOL_LOOP_CHAT_GUARD,默认开):网关契约是 generate() 返回
      // success:false 而非抛;但真正*意外*的异常(适配器 bug/解析崩溃/非预期 TypeError)
      // 会从这里穿透到调用方,杀掉整个多日无人值守 run。把它归一成「诚实的本轮结束」
      // 并 return——本轮优雅收尾、会话继续下一步,而不是让一次意外抛出中断连续几天的运行。
      // 门关 → 逐字节回退:重新抛出,恢复今日「异常穿透到调用方」的行为。
      const _chatGuard = require('./chatErrorGuard');
      if (!_chatGuard.isEnabled(process.env)) throw chatErr;
      try { _loopBreadcrumb('chat-unexpected-error', { iteration, message: _chatGuard._messageOf(chatErr) }); } catch { /* breadcrumb best-effort */ }
      const _honest = _chatGuard.buildUnexpectedChatErrorResult(chatErr, { iteration });
      return {
        finalResponse: _honest.finalResponse,
        toolCallLog,
        iterations: iteration,
        provider: 'none',
        tokenUsage: null,
        errorType: _honest.errorType,
        error_code: _honest.errorCode,
        resumable: true,
        continueHint: _honest.continueHint,
        unexpectedChatError: true,
      };
    }
    _forceNoToolsNext = false;

    // Phase 7: Await all streaming pre-executions before checking cache
    if (_streamingExec) {
      try { await _streamingExec.awaitAll(); } catch { /* non-critical — individual results still cached */ }
    }

    // Activity: AI responded (even if error, the channel is alive)
    lastActivityTime = Date.now();

    if (typeof onCost === 'function' && aiResult && aiResult.tokenUsage) {
      try { onCost(aiResult.tokenUsage); } catch { /* non-critical projection */ }
    }
    // 系统层 D2 — accumulate this round's spend for the budget governor. Disabled
    // (ceiling 0) ⇒ extractTokenCount still runs but the top-of-loop assessBudget
    // is always 'ok', so this is observability-only and byte-identical legacy.
    if (_tokenBudget && aiResult && aiResult.tokenUsage) {
      const _round = _tokenBudget.extractTokenCount(aiResult.tokenUsage);
      _tokensSpent += _round;
      if (_tokenBudgetCfg.ceiling > 0 && _round > 0) {
        try { require('./advancedDiagnostics').getInstance().recordTokenUsage(_round); } catch { /* observability only */ }
      }
    }

    // 断线惯性 · Seam 1（完成已下达的工具调用）：流式层在瞬断且已有进度时交回 PARTIAL
    // (interrupted:true + 已下达 toolUseBlocks,无 errorType)。这些调用不需要模型即可完成,
    // 让它们落入下方常规解析/执行路径(惯性完成);但先剔除被中断截断、参数残缺的坏块,避免
    // 执行垃圾调用。同时置「重连提示」,由 Seam 0 在下一次模型调用(重连)前注入,实现无感衔接。
    // 严格只认 interrupted partial：真正的 errorType 断线没有可执行 block,不在此处理。
    if (_inertia && _inertia.isInertiaTurn(aiResult)) {
      try {
        const { executable, dropped } = _inertia.filterExecutableBlocks(aiResult.toolUseBlocks);
        aiResult.toolUseBlocks = executable; // 仅放行可执行块 → 常规 hasStructuredToolUse 路径执行
        const _names = executable
          .map((b) => (b && (b.name || (b.function && b.function.name))) || '')
          .filter(Boolean);
        _pendingInertiaReconnectHint = _inertia.buildModelReconnectHint({
          executedTools: _names,
          droppedCount: dropped.length,
        });
        _inertiaEvents.push({ iteration, executed: executable.length, dropped: dropped.length });
      } catch { /* 惯性接缝 fail-soft：异常则退回原盲目执行,绝不阻断循环 */ }
    }

    if (aiResult && aiResult.errorType) {
      // /s! 紧急 steer 抢占：用户用 /s! 取消了在飞模型回合以即时矫正航向。此 cancel 不是
      // 故障，也不应整体 bail——注入用户修正后原地重发当前回合，保留全部循环上下文与进度。
      // 正确性：ai().chat 在 cancel 失败路径已 _uncommitOrphanTurn(DESIGN-ARCH-046)，把刚提交的
      // orphan user turn 从权威 _messages 弹出，故重发从干净历史再生，无悬挂 assistant/重复 user turn；
      // toolCallLog 与 conversationMessages 本轮尚未追加（仅在工具执行后 push），故先前进度完好。
      // 须先于 cooldown/transient 判断，避免被瞬态预算吃掉或附加"瞬态中断"提示噪音。
      // 真实网络 cancel / /i 中断都不置此信号 → consumeUrgentSteer 返回 false → 落入下方原逻辑，行为不变。
      if (aiResult.errorType === 'cancelled'
          && typeof consumeUrgentSteer === 'function'
          && consumeUrgentSteer()
          && urgentSteerReissues < URGENT_STEER_MAX) {
        urgentSteerReissues++;
        currentMessage = _injectSteerIfPresent(currentMessage, getSteerMessages);
        try {
          if (traceAudit) {
            traceAudit.logEvent('agent.loop.urgent_steer', {
              reissue: urgentSteerReissues,
              maxReissues: URGENT_STEER_MAX,
              iteration,
            }, {
              sessionId: traceSessionId,
              traceId: diagTraceId,
              requestId,
              source: 'tool-loop',
              visibility: 'summary',
            });
          }
        } catch { /* non-critical */ }
        continue; // 重入 while → 重发 chat(currentMessage + 方向修正块)，原地续跑
      }
      // ── App-launch 中断回退优先(门控 KHY_APP_LAUNCH_INTERRUPT_PRECEDENCE 默认开)──────────
      // AI 通道在 app-launch 任务中被硬中断(process/cancelled/timeout…)时,确定性的 open_app
      // 回退已完全满足「打开应用」意图,应优先它,而非先花数秒投机重试 AI 通道(seamlessResume
      // 给小任务的 transient 地板会引入这段无谓延迟)。_recoverOpenAppAfterAiInterruption 对
      // 非 app-launch / 无可回退线索恒返回 null → 落回下方 transient 原序(下方 2533 的同一调用
      // 此时也返 null,不会二次执行 open_app);门控关 → 整块短路,逐字节回退今日顺序。
      if (_appLaunchInterruptPrecedenceEnabled(process.env)) {
        // eslint-disable-next-line no-await-in-loop
        const _earlyAppLaunch = await _recoverOpenAppAfterAiInterruption(
          aiResult,
          userMessage,
          toolCallLog,
          { sessionId: traceSessionId, traceId: diagTraceId, requestId }
        );
        if (_earlyAppLaunch) {
          return {
            finalResponse: _earlyAppLaunch,
            toolCallLog,
            iterations: iteration,
            provider: aiResult.provider,
            tokenUsage: aiResult.tokenUsage,
            effort: aiResult.effort,
            errorType: aiResult.errorType,
            stopped: true,
            recoveredFromInterruptedChannel: true,
          };
        }
      }
      // Cooldown failures are deterministic — retrying immediately will hit
      // the same cached error.  Skip transient recovery and fail fast.
      const cooldown = _isCooldownFailure(aiResult);
      // 续接策略红线（单一真源）：内容安全 / 权限拦截等不可恢复类绝不自动续接，
      // 即便 _isTransientLoopErrorType 将来放宽也由此守住——防御纵深。
      const resumablePolicy = _continuation.isResumableError(aiResult.errorType);
      const transient = !cooldown && resumablePolicy
        && _isTransientLoopErrorType(aiResult.errorType);
      if (transient && transientRecoveryUsed < transientRecoveryMax) {
        const attemptIdx = transientRecoveryUsed;
        transientRecoveryUsed++;
        const delayMs = _recoveryDelayMs(attemptIdx);
        try {
          if (traceAudit) {
            traceAudit.logEvent('agent.loop.resume', {
              reason: aiResult.errorType,
              attempt: transientRecoveryUsed,
              maxAttempts: transientRecoveryMax,
              delayMs,
              iteration,
            }, {
              sessionId: traceSessionId,
              traceId: diagTraceId,
              requestId,
              source: 'tool-loop',
              visibility: 'summary',
            });
          }
        } catch { /* non-critical */ }
        // 惯性接续（显式规则）：classify 单源裁定「能接续/不能接续」。R2/R3 在上面的
        // transient 门已先行成立，这里把 cooldown/errorType 一并喂入做防御纵深，并由
        // R4 判退化前缀。resumable→carryover 持久化并续接；否则丢弃废前缀，
        // buildContinuationDirective 自动回落逐字一致的旧 transient 指令，行为不变。
        const _verdict = _inertialContinuation.classify({
          errorType: aiResult.errorType,
          cooldown,
          aborted: false,
          prior: _inertialCarryover,
          streamed: _inertialStreamed,
        });
        if (_verdict.resumable) _inertialCarryover = _verdict.carryover;
        currentMessage += _inertialContinuation.buildContinuationDirective({
          carryover: _verdict.resumable ? _inertialCarryover : '',
          reason: 'transient',
        });
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      // ── 空回复守卫:主动丢弃 + 要求重发（KHY_REPLY_GUARD,默认开)──────────────
      // cli/ai.js 对真正空的模型回合会塞入非空诊断占位串 + errorType:'empty_reply',它非
      // transient(_isTransientLoopErrorType 只认裸 'empty'),旧路径直接把占位串当 stopped:true
      // 失败抛出——既没丢弃也没要求重发。守卫在此把这类空回复主动丢弃(占位 aiResult 既不返回也
      // 不入历史:continue 重入 while → 干净重发),在有界预算内要求模型重发一条完整的新消息。
      // NON_RESUMABLE(内容安全/拒答/权限)由 shouldDiscardAndRerequest 内 isResumableError 挡住
      // 绝不重发;预算复用 emptyRecoveryUsed/Max(与真正空路径同一计数,杜绝双重消费),耗尽后本块
      // 不再触发,自然落回下方终端返回报真因。门控关 → should* 恒 false,本块 no-op,逐字节回退。
      const _rgAborted = !!(externalSignal && externalSignal.aborted);
      if (replyGuard.shouldDiscardAndRerequest({
        aiResult,
        attemptsUsed: emptyRecoveryUsed,
        maxAttempts: emptyRecoveryMax,
        aborted: _rgAborted,
      })) {
        const _rgAttemptIdx = emptyRecoveryUsed;
        emptyRecoveryUsed++;
        const _rgDelayMs = _recoveryDelayMs(_rgAttemptIdx);
        try {
          if (traceAudit) {
            traceAudit.logEvent('agent.loop.resume', {
              reason: 'reply_guard_empty',
              attempt: emptyRecoveryUsed,
              maxAttempts: emptyRecoveryMax,
              delayMs: _rgDelayMs,
              iteration,
            }, {
              sessionId: traceSessionId,
              traceId: diagTraceId,
              requestId,
              source: 'tool-loop',
              visibility: 'summary',
            });
          }
        } catch { /* non-critical */ }
        if (onToolResult) {
          try {
            onToolResult('_system_retry', {}, { success: true }, iteration, 0,
              replyGuard.buildRetryStatusLabel({ attempt: emptyRecoveryUsed, maxAttempts: emptyRecoveryMax }));
          } catch { /* non-critical projection */ }
        }
        // 丢弃占位串,沿用惯性续接真源做「从头重写」指令,再附明确的「已丢弃,请重发」指令。
        const _rgVerdict = _inertialContinuation.classify({
          aborted: _rgAborted,
          prior: _inertialCarryover,
          streamed: _inertialStreamed,
        });
        if (_rgVerdict.resumable) _inertialCarryover = _rgVerdict.carryover;
        currentMessage += _inertialContinuation.buildContinuationDirective({
          carryover: _rgVerdict.resumable ? _inertialCarryover : '',
          reason: 'empty_reply',
        }) + replyGuard.buildResendDirective({ attempt: emptyRecoveryUsed, maxAttempts: emptyRecoveryMax });
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, _rgDelayMs));
        continue; // 重入 while → 丢弃空占位、要求模型重发新消息
      }
      const appLaunchFallback = await _recoverOpenAppAfterAiInterruption(
        aiResult,
        userMessage,
        toolCallLog,
        { sessionId: traceSessionId, traceId: diagTraceId, requestId }
      );
      if (appLaunchFallback) {
        return {
          finalResponse: appLaunchFallback,
          toolCallLog,
          iterations: iteration,
          provider: aiResult.provider,
          tokenUsage: aiResult.tokenUsage,
          effort: aiResult.effort,
          errorType: aiResult.errorType,
          stopped: true,
          recoveredFromInterruptedChannel: true,
        };
      }
      const totalExecuted = toolCallLog.length;
      const succeededExecuted = toolCallLog.filter(item => item && item.result && item.result.success).length;
      const progressSummary = totalExecuted > 0
        ? `已完成 ${succeededExecuted}/${totalExecuted} 个工具步骤。`
        : '本轮尚未完成可确认的执行步骤。';
      const errorMessages = {
        timeout: `抱歉，AI 在执行过程中超时，当前任务未完成，已停止本次请求。${progressSummary}你可以稍后重试，或将任务拆分后继续。`,
        network: '抱歉，网络连接出现问题，无法完成请求。请检查网络连接后重试。',
        rate_limit: '当前请求过于频繁，AI 服务暂时限流。请稍等片刻后重试。',
        auth: 'AI 服务认证失败，请检查 API Key 配置。',
        cancelled: '请求已取消。',
        process: 'AI 服务进程异常中断，正在尝试恢复。如持续出现请重启服务。',
      };
      const _legacyFriendly = errorMessages[aiResult.errorType]
        || aiResult.reply
        || `抱歉，遇到了未预期的问题（${aiResult.errorType}），我暂时无法处理这个请求。`;
      // Honesty (用户要求「出错原因要具体真实，不要用网络不好之类的理由掩盖真相」):
      // when the gateway carried a real concrete cause (proxy refused / DNS /
      // HTTP 5xx / model_not_found), lead with it instead of the generic excuse.
      // Gate off or no real cause → byte-identical to the legacy friendly message.
      const friendlyMsg = resolveFriendlyFailureMessage({
        errorType: aiResult.errorType,
        cause: aiResult.failureDetails || aiResult.error,
        legacyFriendly: _legacyFriendly,
      });
      // 诊断锚定捕获侧:登记这次真实的 gateway 失败(errorType + 具体真因),供下一轮用户追问
      // 「为什么报这个错」时把它 pin 回上下文(见首轮注入点)。fail-soft,登记失败绝不影响本路径。
      try {
        require('./diagnosticGrounding').recordFailure({
          errorType: aiResult.errorType,
          cause: aiResult.failureDetails || aiResult.error,
        });
      } catch { /* diagnostic-grounding record best-effort */ }
      // Salvage on the error path: when the FINAL summarization turn errors out
      // (e.g. every model channel 404s / the retry budget is exhausted) but tools
      // ALREADY succeeded earlier in the loop, surfacing the gathered data beats
      // discarding it for a bare error string. This is the live "web_search ✓ ×3
      // then 404 → no output" failure: the results existed but were thrown away.
      // succeededExecuted === 0 (e.g. first-call total outage) → null → bare error,
      // preserving today's behavior.
      const _salvagedOnError = succeededExecuted > 0 ? _salvageToolResults(toolCallLog, originalUserMessage) : null;
      let finalOnError = _salvagedOnError
        ? `${_salvagedOnError}\n\n（注：模型在汇总阶段中断：${String(friendlyMsg)}）`
        : String(friendlyMsg);
      // 断线惯性 · 重连失败收口：此前曾用惯性完成已下达的步骤,但通道未能恢复 → 给用户
      // 一句明确交代「已用惯性完成 N 步,以上为已完成结果」,而非让这次断线悄无声息。
      const _inertiaSummaryErr = _inertia && _inertia.summarizeInertia(_inertiaEvents);
      if (_inertiaSummaryErr && _salvagedOnError) {
        const _notice = _inertia.buildUserInertiaNotice({
          executedCount: _inertiaSummaryErr.executed,
          droppedCount: _inertiaSummaryErr.dropped,
          reconnected: false,
        });
        if (_notice) finalOnError = `${_notice}\n\n${finalOnError}`;
      }
      // 续接收口：自动重试已耗尽。可恢复类（网络/超时等）明确告知用户可说「继续」
      // 从断点推进，而不是留下一句死板的失败文案。安全/权限类不提示。
      const _errResumable = _continuation.isResumableError(aiResult.errorType);
      if (_errResumable && !/继续/.test(finalOnError)) {
        finalOnError += `\n\n${_continuation.CONTINUE_HINT}`;
      }
      // 认证失败 / 无可用 key(auth·no_key)→ 主动邀请用户配置该模型的 API Key,而不是只甩
      // 底层 401 报错(用户诉求:识图/任何模型因缺密钥失败时应主动询问配 key,配好即可使用)。
      // 认出 provider 时点名(如智谱 GLM)。门控 KHY_FAILURE_KEY_INVITE(默认开)/ fail-soft:
      // 空邀请(门关 / 非 auth·no_key 类)→ finalOnError 逐字节不变。
      try {
        const _keyInvite = buildKeyConfigInvite({
          errorType: aiResult.errorType,
          cause: aiResult.failureDetails || aiResult.error,
        });
        if (_keyInvite && !finalOnError.includes(_keyInvite)) {
          finalOnError += `\n\n${_keyInvite}`;
        }
      } catch { /* fail-soft: 保持 finalOnError 原样 */ }
      return {
        finalResponse: finalOnError,
        toolCallLog,
        iterations: iteration,
        provider: aiResult.provider,
        tokenUsage: aiResult.tokenUsage,
        effort: aiResult.effort,
        errorType: aiResult.errorType,
        stopped: true,
        resumable: _errResumable,
        continueHint: _errResumable ? _continuation.CONTINUE_HINT : null,
        inertia: _inertiaSummaryErr || undefined,
        ...(_bugSentinel && _bugSentinel.hasSignal() ? { sentinel: _bugSentinel.snapshot() } : {}),
        ...(_courseMonitor && _courseMonitor.hasCorrections(_courseState) ? { courseCorrections: _courseMonitor.summarize(_courseState) } : {}),
        ...(_adaptiveExec && _adaptiveExec.hasNudges(_reflectState) ? { adaptiveReflection: _adaptiveExec.summarize(_reflectState) } : {}),
        ...(_fpfGuard && _fpfState && _fpfGuard.hasFindings(_fpfState) ? { falsePositiveFix: _fpfGuard.summarize(_fpfState) } : {}),
        ...(_fpfState ? { _fpfState } : {}),
        ...(_promptRound > 1 ? { promptRound: _promptRound } : {}),
      };
    }

    // A tool-use turn legitimately carries no assistant text (many non-Claude
    // models — e.g. minimax — return ONLY tool_use blocks with an empty reply).
    // Such a turn is NOT an empty/dead-end response: it must fall through to the
    // tool-dispatch path below (hasStructuredToolUse @ ~L1875). Guarding the
    // empty-reply block on `!hasToolBlocks` here is the single fix for the
    // intermittent "只显示工具调用后就截断 / 抱歉，AI 未能生成有效回复" symptom —
    // previously an empty-text tool-use turn skipped auto-retry AND fell through
    // to the terminal failure return, so the tool was never executed.
    const hasToolBlocks = Array.isArray(aiResult?.toolUseBlocks) && aiResult.toolUseBlocks.length > 0;
    // Track the "empty text + tool block, repeatedly" streak (see declaration of
    // emptyTextWithToolsStreak). A non-empty reply breaks the streak.
    const _replyEmpty = (!aiResult || !aiResult.reply);
    if (_replyEmpty && hasToolBlocks) emptyTextWithToolsStreak++;
    else emptyTextWithToolsStreak = 0;
    // Break the empty+tool loop once the streak crosses the threshold AND we have
    // already gathered usable tool data — route into the recovery block below
    // (forced-summary disables tools, else salvage surfaces the data) instead of
    // re-dispatching the same tool a third/fourth time into silence.
    const _emptyToolLoop = _replyEmpty
      && hasToolBlocks
      && emptyTextWithToolsStreak >= emptyTextWithToolsMax
      && Array.isArray(toolCallLog)
      && toolCallLog.some((t) => t && t.result && t.result.success === true);
    if (_replyEmpty && (!hasToolBlocks || _emptyToolLoop)) {
      // ── Empty-reply auto-recovery (DESIGN-ARCH-046) ───────────────────
      // A genuinely empty / no-text terminal response is a degraded dead-end.
      // Instead of pushing the canned "未能生成有效回复" fallback onto the user
      // (which forces a manual re-ask — the reported "僵化" symptom), attempt a
      // bounded auto-retry FIRST and surface a "正在重试" status so the user is
      // informed rather than left waiting.
      //
      // Honors the hard constraints:
      //   • zero latency on the normal path — this block only runs when the
      //     reply is already empty;
      //   • no repetition / logic confusion — an empty reply carries no content
      //     to repeat, and the empty turn is never committed to history
      //     (chatStateIsolation), so the retry regenerates from a clean state;
      //   • not retried when the request was aborted (tool-use turns are already
      //     excluded by the `!hasToolBlocks` guard on the outer condition).
      const aborted = !!(externalSignal && externalSignal.aborted);

      // ── Forced-summarization turn (Fix #3) — runs BEFORE generic recovery ──
      // The model finished its tool calls but wrote no closing text. Before any
      // generic retry (which leaves tools on offer and lets weak models just
      // re-call the same tool — the observed "✓ news again, no output" loop) or
      // the raw-data salvage floor, ask ONE more time with tools DISABLED and an
      // explicit instruction to write the final answer from the gathered data.
      // 成品优先：模型自己写的总结 > 原料兜底：_salvageToolResults 的工具原文。
      const _haveToolData = Array.isArray(toolCallLog)
        && toolCallLog.some((t) => t && t.result && t.result.success === true);
      if (!aborted && forcedSummaryUsed < forcedSummaryMax && _haveToolData) {
        forcedSummaryUsed++;
        _forceNoToolsNext = true;
        if (onToolResult) {
          try {
            onToolResult('_system_summarize', {}, { success: true }, iteration, 0,
              '工具已完成，正在生成总结…');
          } catch { /* non-critical projection */ }
        }
        currentMessage += '\n\n[SYSTEM: 你已经获取到所需数据（见上方工具结果）。'
          + '本轮禁止再调用任何工具，请直接用中文写出完整的最终回答 / 总结，'
          + '必须基于已检索到的内容作答，不要返回空白。]';
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, _recoveryDelayMs(0)));
        continue;
      }

      if (!aborted && emptyRecoveryUsed < emptyRecoveryMax) {
        const attemptIdx = emptyRecoveryUsed;
        emptyRecoveryUsed++;
        const delayMs = _recoveryDelayMs(attemptIdx);
        try {
          if (traceAudit) {
            traceAudit.logEvent('agent.loop.resume', {
              reason: 'empty_reply',
              attempt: emptyRecoveryUsed,
              maxAttempts: emptyRecoveryMax,
              delayMs,
              iteration,
            }, {
              sessionId: traceSessionId,
              traceId: diagTraceId,
              requestId,
              source: 'tool-loop',
              visibility: 'summary',
            });
          }
        } catch { /* non-critical */ }
        if (onToolResult) {
          try {
            onToolResult('_system_retry', {}, { success: true }, iteration, 0,
              `生成被中断或为空，正在重试（${emptyRecoveryUsed}/${emptyRecoveryMax}）…`);
          } catch { /* non-critical projection */ }
        }
        // 惯性接续（显式规则）：classify 单源裁定。R1 由本 seam 的 !aborted 门已成立，
        // 这里仍把 aborted 一并喂入做防御纵深；空响应无 errorType。resumable→续接，
        // 退化前缀→carryover 置空，buildContinuationDirective 回落逐字一致的旧 empty_reply 指令。
        const _verdict = _inertialContinuation.classify({
          aborted,
          prior: _inertialCarryover,
          streamed: _inertialStreamed,
        });
        if (_verdict.resumable) _inertialCarryover = _verdict.carryover;
        currentMessage += _inertialContinuation.buildContinuationDirective({
          carryover: _verdict.resumable ? _inertialCarryover : '',
          reason: 'empty_reply',
        });
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      // Salvage FIRST: if the model wrote no closing text but tool calls this
      // run succeeded, surface the gathered data instead of discarding it.
      // This is a real answer (data the user asked for), so it returns cleanly
      // and is KEPT in history — not flagged as an empty-reply failure.
      const _salvaged = !aiResult?.reply ? _salvageToolResults(toolCallLog, originalUserMessage) : null;
      if (_salvaged) {
        return {
          finalResponse: _salvaged,
          toolCallLog,
          iterations: iteration,
          provider: aiResult?.provider,
          tokenUsage: aiResult?.tokenUsage,
          salvaged: true,
        };
      }

      // ── 无感衔接保底轻推（Goal：无感顺滑）────────────────────────────────
      // 走到这里 = 空回复、无可兜底数据、即将报错。若本轮各重试预算都被配成 0
      // （KHY_TOOL_LOOP_EMPTY_RECOVERIES=0 等），forcedSummary / emptyRecovery 都没
      // 触发，就会「一次轻推都没有就报错」。目标要求卡壳前先轻推 1-2 次。
      //
      // 「无感顺滑」是首要体感目标：第一次轻推必须**静默 + 近乎零延迟**——在用户察觉到
      // 卡顿之前就已续接成功，不弹任何状态行。只有第一次轻推也失败（确实卡住了）才升级
      // 为**可见**状态告知用户正在重试，并加一点退避给通道喘息。计数器 + 上限确保至多
      // 2 次，绝不死循环——推满仍空即落入下方报错路径。
      if (!aborted
        && _stallNudgeUsed < _stallNudgeMax
        && emptyRecoveryUsed === 0
        && forcedSummaryUsed === 0) {
        const attemptIdx = _stallNudgeUsed;
        _stallNudgeUsed++;
        const silent = attemptIdx === 0; // 首次静默无感；后续才可见
        if (!silent && onToolResult) {
          try {
            const label = _stallNudgeMax > 1
              ? `生成似乎中断，正在续接（${_stallNudgeUsed}/${_stallNudgeMax}）…`
              : '生成似乎中断，正在续接…';
            onToolResult('_system_nudge', {}, { success: true }, iteration, 0, label);
          } catch { /* non-critical projection */ }
        }
        // 惯性接续（显式规则）：轻推同样经 classify 单源裁定，能续则续、退化则回落
        // 逐字一致的旧 stall 指令。R1 由本 seam 的 !aborted 门已成立。
        const _verdict = _inertialContinuation.classify({
          aborted,
          prior: _inertialCarryover,
          streamed: _inertialStreamed,
        });
        if (_verdict.resumable) _inertialCarryover = _verdict.carryover;
        currentMessage += _inertialContinuation.buildContinuationDirective({
          carryover: _verdict.resumable ? _inertialCarryover : '',
          reason: 'stall',
        });
        // 首次：近乎零延迟（无感）；后续：正常退避给通道喘息。
        const delayMs = silent ? _stallNudgeSilentDelayMs() : _recoveryDelayMs(attemptIdx);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      // 惯性接续兜底：自动续接预算耗尽时，若仍握有连接中断前已产出的前缀，就把它
      // 作为回答返回（前缀 + 任何本轮残文），而不是丢进死板的「未能生成有效回复」。
      // 已展示给用户的内容不该在最后一刻被一句套话覆盖。
      if (_inertialCarryover && !aiResult?.reply) {
        const _mergedInertial = _inertialContinuation.mergePrefix(_inertialCarryover, aiResult?.reply || '');
        _inertialCarryover = '';
        if (_mergedInertial.trim()) {
          return {
            finalResponse: _mergedInertial,
            toolCallLog,
            iterations: iteration,
            provider: aiResult?.provider,
            tokenUsage: aiResult?.tokenUsage,
            salvaged: true,
            inertialContinued: true,
          };
        }
      }

      let finalResponse = aiResult?.reply
        || '抱歉，AI 未能生成有效回复。这可能是模型暂时不可用，请稍后重试。';
      // Transparency: when we already burned the retry budget on this empty path,
      // tell the user it was auto-retried — "重试失败后再报真实错误". This makes the
      // dead-end explicit (network fluctuation / channel degraded) rather than
      // looking like a first-try giveup.
      if (!aiResult?.reply && emptyRecoveryUsed > 0) {
        // Don't speculate "疑似网络波动" when a concrete cause is about to be
        // appended below (用户要求不要用网络不好掩盖真相). State the retry count as
        // fact; only when we genuinely have no detail do we say so honestly —
        // rather than guessing the network. Gate off → byte-identical old line.
        if (isHonestFailureEnabled(process.env)) {
          finalResponse += aiResult?.failureDetails
            ? `（已自动重试 ${emptyRecoveryUsed} 次仍为空回复。具体原因见下。）`
            : `（已自动重试 ${emptyRecoveryUsed} 次仍为空回复，未能从模型通道获取具体错误信息。）`;
        } else {
          finalResponse += `（已自动重试 ${emptyRecoveryUsed} 次仍为空回复，疑似网络波动或模型通道暂时降级。）`;
        }
      }
      // Attach diagnostics: prefer adapter failure details, else infer from a
      // degraded tool subsystem that a tool call just hit this turn.
      if (aiResult?.failureDetails) {
        finalResponse += `\n\n${aiResult.failureDetails}`;
      } else if (Array.isArray(toolCallLog)) {
        const degraded = toolCallLog.some((t) => {
          if (!t || t.success !== false) return false;
          const err = String(t.error || t.content || '');
          return /cheerio|unavailable|未安装|未配置|NO_BACKEND/i.test(err);
        });
        if (degraded) {
          finalResponse += '\n\n提示：本轮某个工具因依赖缺失或未配置而失败'
            + '（如搜索需 cheerio、绘图需 KHY_IMAGE_GEN_* 后端）。请检查上方工具错误并补齐配置。';
        }
      }
      // Precise attribution (DESIGN-ARCH-028): an empty reply is never a silent
      // failure. Classify it to E01 so the SSE layer / frontend can render a
      // precise prompt instead of a vague "未返回有效回复". fail-soft: never let
      // attribution throw on this already-degraded path.
      let attribution;
      try {
        attribution = require('./failsafe').classify(
          { errorType: 'empty_reply', model: aiResult?.model, finish_reason: aiResult?.finishReason },
          { kind: 'llm', model: aiResult?.model, promptTokens: aiResult?.tokenUsage?.prompt_tokens },
        );
      } catch { attribution = null; }
      // 续接收口：空响应（E01）可恢复——附「继续」提示让用户一句话推进；若归因
      // 落到 E02（内容安全）则 continueHintFor 返回 null，不诱导无意义重试。
      const _emptyHint = _continuation.continueHintFor(attribution)
        || (attribution ? null : _continuation.CONTINUE_HINT);
      if (_emptyHint && !/继续/.test(finalResponse)) {
        finalResponse += `\n\n${_emptyHint}`;
      }
      return {
        finalResponse,
        toolCallLog,
        iterations: iteration,
        provider: aiResult?.provider,
        tokenUsage: aiResult?.tokenUsage,
        errorType: attribution?.error_code === 'E02' ? 'content_filter' : 'empty_reply',
        error_code: attribution?.error_code || 'E01',
        attribution: attribution || undefined,
        resumable: attribution ? !!attribution.resumable : true,
        continueHint: _emptyHint,
      };
    }

    lastResult = aiResult;

    const normalizedStopReason = _normalizeStopReason(aiResult.stopReason);
    if (normalizedStopReason) aiResult.stopReason = normalizedStopReason;

    // ── 重复退化矫正（及时矫正，绝不断命） ─────────────────────────────
    // 模型本轮陷入 chanting（同一短片段反复输出）：流式洪水已在上面被吞掉。这里把
    // 回复裁回干净前缀并重发一次纠偏指令让模型干净重写（优雅矫正）。仅当重写**仍**
    // 退化（或重试已用尽）才回落抢救的干净前缀 + 透明提示——绝不报错/断连。
    // 必须在截断恢复之前处理：退化回合通常以 stopReason=length 收尾，若放任会触发
    // 续写恢复反而帮模型把循环续下去。
    let _repetitionHandled = false;
    if (!aiResult.errorType && aiResult.reply && (_streamRepetitionTripped
        || _streamRepetitionGuard.findRepetition(aiResult.reply).tripped)) {
      const _det = _streamRepetitionGuard.findRepetition(aiResult.reply);
      const _cleanPrefix = _det.tripped
        ? aiResult.reply.slice(0, _det.cleanPrefixLength)
        : aiResult.reply;
      const _repSig = _streamRepetitionGuard.repetitionSignature(_det) || 'rep:stream';
      const _sameAgain = _lastRepetitionSig !== null && _repSig === _lastRepetitionSig;

      if (_repetitionRetries < _repetitionRetryMax && !_sameAgain) {
        _lastRepetitionSig = _repSig;
        _repetitionRetries++;
        // 丢弃这段已流出的退化废稿，纠偏后的干净回答将替换而非追加其后。
        _emitStreamReset('repetition-retry');
        _loopBreadcrumb('nudge-continue', {
          iteration, nudge: 'repetition',
          attempt: _repetitionRetries, max: _repetitionRetryMax,
          unit: _det.unit, repeats: _det.repeats,
        });
        if (onToolResult) {
          try {
            onToolResult('_system_retry', {}, { success: true }, iteration, 0,
              `检测到回复陷入重复，正在重新生成（${_repetitionRetries}/${_repetitionRetryMax}）…`);
          } catch { /* non-critical */ }
        }
        // 退化回合不贡献任何有效文本：清空截断累积，避免把废稿拼进最终回复。
        _truncationAccumulator = '';
        _truncationContinuations = 0;
        currentMessage = '[SYSTEM] 重复退化检测：你上一轮的回复陷入了无意义的重复'
          + '（同一词语/片段被反复输出很多次），这是错误的。请重新、简洁完整地回答'
          + '用户的原始问题，正常收尾，绝不重复任何词语或片段。\n\n用户原始请求: '
          + String(userMessage || '').slice(0, 300);
        lastActivityTime = Date.now();
        continue;
      }

      // 重试用尽 / 又同样退化 → 优雅抢救（不是错误）：保留干净前缀 + 透明提示。
      const _trimmed = String(_cleanPrefix || '').trimEnd();
      aiResult.reply = _trimmed
        ? `${_trimmed}\n\n[⚠️ 后续输出出现异常重复，已自动截断。可让我“继续”或换个说法重试。]`
        : '抱歉，刚才的回复出现了异常重复。请再说一次或换个说法，我重新作答。';
      lastResult = aiResult;
      _truncationAccumulator = '';
      _truncationContinuations = 0;
      _repetitionHandled = true; // 阻止下方截断恢复在抢救文本上续写
    }

    // ── Truncation Recovery (s11, single source: maxTokensRecovery) ───
    // If the model hit max_tokens (stopReason=length), the response is
    // incomplete. Accumulate the partial text, inject a continuation prompt,
    // and retry — up to MAX_OUTPUT_RECOVERY_ATTEMPTS times. Two safeguards
    // beyond a naive retry loop:
    //   • Phase 1 escalation: when an explicit small output cap is in effect
    //     (≤8K), widen it for the continuation rounds so each chunk is larger
    //     and fewer rounds are needed. We never invent a cap — escalation is a
    //     no-op when the caller did not set a numeric maxTokens.
    //   • Diminishing-returns guard: if consecutive continuations each add
    //     almost nothing, the model is stuck — stop early instead of burning
    //     every attempt. The decision is surfaced via onToolResult.
    if (normalizedStopReason === 'length' && !aiResult.errorType && !_repetitionHandled) {
      const recovery = _maxTokensRecovery.shouldRecover(
        normalizedStopReason, _truncationContinuations, effectiveChatOpts.maxTokens
      );
      if (recovery) {
        const chunk = aiResult.reply || '';
        // Only continuations (not the first truncation) count toward the guard.
        // A repetition-laden continuation is non-productive too — treat it as
        // negligible so recovery stops instead of helping the model loop on.
        if (_truncationContinuations > 0
            && (_maxTokensRecovery.isNegligibleContinuation(chunk, _truncationMinChars)
                || _maxTokensRecovery.isRepetitiveContinuation(chunk))) {
          _negligibleContinuations++;
        } else {
          _negligibleContinuations = 0;
        }

        if (_negligibleContinuations >= _maxNegligibleContinuations) {
          // Diminishing returns — give up continuing and finalize what we have.
          _truncationAccumulator += chunk;
          if (onToolResult) {
            onToolResult('_system_truncation', {}, { success: true }, iteration, 0,
              `Truncation recovery stopped: diminishing returns (${_negligibleContinuations} negligible continuations).`);
          }
          if (_truncationAccumulator) {
            // Surface the truncation explicitly — never finalize a silent
            // half-sentence (the reported "半截话" symptom).
            aiResult.reply = _truncationAccumulator + _maxTokensRecovery.buildTruncationNotice(_truncationContinuations);
            lastResult = aiResult;
          }
          // 输出层软 bug 监听(goal 2026-06-25):输出不全在权威信号(截断恢复收益递减)
          // 处落错误日志 —— loop 已贴可见截断提示(简单修复),此处补不可修复的可观测。
          try { require('./outputIntegrityMonitor').noteTruncation({ recovered: false, continuations: _truncationContinuations, chars: _truncationAccumulator.length, source: 'truncation-diminishing-returns' }); } catch { /* fail-soft */ }
          // Reset so the merge-on-normal block below does not double-append.
          _truncationAccumulator = '';
          _truncationContinuations = 0;
          _negligibleContinuations = 0;
          // fall through to normal finalization
        } else {
          _truncationAccumulator += chunk;
          _truncationContinuations++;
          // Phase 1: widen the per-round cap for the continuation rounds.
          // recovery.shouldEscalate is computed from `currentMax ||
          // CAPPED_DEFAULT_MAX_TOKENS`, so it already accounts for an unset
          // (undefined) cap. The previous guard required maxTokens to be an
          // explicit number, which made escalation a no-op in the common case
          // where the caller never passed maxTokens — the continuation then
          // re-ran under the adapter's small default (e.g. trae 2048 / local
          // 1024) and got truncated again immediately. Escalate whenever the
          // effective cap is at/below the capped default, treating undefined as
          // that capped default.
          if (recovery.shouldEscalate
              && (typeof effectiveChatOpts.maxTokens !== 'number'
                  || effectiveChatOpts.maxTokens <= _maxTokensRecovery.CAPPED_DEFAULT_MAX_TOKENS)) {
            effectiveChatOpts.maxTokens = recovery.nextMax;
          }
          if (onToolResult) {
            onToolResult('_system_truncation', {}, { success: true }, iteration, 0,
              `Truncated (${_truncationContinuations}/${_maxTokensRecovery.MAX_OUTPUT_RECOVERY_ATTEMPTS}), continuing...`);
          }
          currentMessage = _maxTokensRecovery.buildContinuationPrompt();
          // Unknown-Problem Handler (DESIGN-ARCH-050): if the truncated text was
          // mid-execution-step, instruct the continuation to lead with the
          // 生成中断预警 marker so the user sees an explicit active-retry of the
          // current step rather than a silent half-checkpoint. Flag-gated,
          // fail-open, additive to the existing continuation prompt.
          try {
            const _uph = require('./unknownProblemHandler');
            if (_uph.isEnabled() && _uph.isExecutionStep(_truncationAccumulator)) {
              currentMessage = `${currentMessage}\n\n[System] 续写时请以 “${_uph.MARKERS.TRUNCATION}” 开头，主动重试当前被截断的执行步骤，并补全其 ✅ 校验点。`;
            }
          } catch { /* fail-open */ }
          lastActivityTime = Date.now();
          continue;
        }
      } else if (_truncationAccumulator) {
        // Exhausted attempts — merge accumulated text, mark it as still
        // truncated, and fall through (output remains incomplete here).
        aiResult.reply = _truncationAccumulator + (aiResult.reply || '')
          + _maxTokensRecovery.buildTruncationNotice(_truncationContinuations);
        lastResult = aiResult;
        // 输出不全权威信号:续写恢复尝试耗尽仍未补全 → 落错误日志(可观测)。
        try { require('./outputIntegrityMonitor').noteTruncation({ recovered: false, continuations: _truncationContinuations, chars: _truncationAccumulator.length, source: 'truncation-attempts-exhausted' }); } catch { /* fail-soft */ }
        _truncationAccumulator = '';
        _truncationContinuations = 0;
      }
    }

    // If we had earlier truncation continuations but now got a normal response,
    // merge the accumulated text
    if (_truncationAccumulator && normalizedStopReason !== 'length') {
      aiResult.reply = _truncationAccumulator + (aiResult.reply || '');
      lastResult = aiResult;
      // 输出不全已被续写恢复完整收尾(简单修复成功)→ 仅记 snapshot,不刷错误日志。
      try { require('./outputIntegrityMonitor').noteTruncation({ recovered: true, continuations: _truncationContinuations, chars: aiResult.reply.length, source: 'truncation-recovered' }); } catch { /* fail-soft */ }
      _truncationAccumulator = '';
      _truncationContinuations = 0;
    }

    // 惯性接续合并：上一轮连接不稳定接缝（transient / empty / stall）捕获了已产出
    // 前缀，本轮若产出了可用回复，则把「前缀 + 续写」缝合（重叠去重），让最终回答
    // 包含中断前已写的部分而非从零重生。镜像上面的截断累积器合并。
    if (_inertialCarryover && aiResult && aiResult.reply && normalizedStopReason !== 'length') {
      aiResult.reply = _inertialContinuation.mergePrefix(_inertialCarryover, aiResult.reply);
      lastResult = aiResult;
      _inertialCarryover = '';
    }

    // Hook: PostResponse — notify hooks after AI response
    if (hookSys) {
      try {
        await hookSys.trigger('PostResponse', { reply: aiResult.reply, iteration });
      } catch { /* non-critical */ }
    }

    // Feed AI text to loop detector for chanting detection
    if (loopDetector && aiResult.reply) {
      loopDetector.feedContent(aiResult.reply);
    }

    // 2. Parse tool calls from AI response
    // s20: the primary continuation signal is the PRESENCE of structured
    // toolUseBlocks, NOT stop_reason. Claude Code does not trust
    // stop_reason === 'tool_use'; the actual tool_use blocks in the response
    // are authoritative (see `hasStructuredToolUse` gate below). stop_reason
    // is only consulted as a secondary hint for the degraded text-parse path.
    // Text-based <tool_call> parsing is a fallback for non-native adapters.
    let toolCalls;
    const hasStructuredToolUse = Array.isArray(aiResult.toolUseBlocks) && aiResult.toolUseBlocks.length > 0;
    const stopReasonIsToolUse = normalizedStopReason === 'tool_use';

    if (_isTextProtocol) {
      // Text protocol is FIRST-CLASS here (weak-local models): parse <tool_call>
      // JSON from raw model text via the adapter. Not a degraded fallback — no
      // warning. Still canonicalized so downstream execution matches the native
      // path exactly.
      toolCalls = _activeAdapter.parseToolCalls(aiResult).map(_canonicalizeToolCall);
    } else if (hasStructuredToolUse) {
      // Native structured tool_use from Claude/OpenAI API — authoritative path
      // Filter out server_tool_use blocks — these are handled server-side (e.g. tool_search)
      // and must not be dispatched to local tool execution.
      toolCalls = aiResult.toolUseBlocks
        .filter(block => block.type !== 'server_tool_use')
        .map(block => {
        const name = block.name || block.function?.name || '';
        let params = block.input || block.params || block.function?.arguments || {};
        if (typeof params === 'string') {
          try { params = JSON.parse(params); } catch { params = {}; }
        }
        const normalized = normalizeToolCall(name, params);
        return {
          name: normalized.name,
          params: normalized.params,
          _toolUseId: block.id || block.tool_use_id || null,
          _structured: true,
        };
      }).map(_canonicalizeToolCall);
    } else if (stopReasonIsToolUse) {
      // stop_reason says tool_use but no structured blocks — adapter 可能未正确传递。
      // 不静默放弃，回退到文本解析尝试恢复工具调用。
      console.warn('[toolUseLoop] WARN: stop_reason=%s but no toolUseBlocks — falling back to text parsing', aiResult.stopReason);
      toolCalls = _parseToolCalls(aiResult.reply).map(_canonicalizeToolCall);
      if (toolCalls.length > 0) {
        console.warn('[toolUseLoop] recovered %d tool call(s) via text fallback', toolCalls.length);
      }
    } else {
      // Text-based <tool_call> parsing. For models known to lack native tool
      // calling this is the EXPECTED text-interception path (calm breadcrumb);
      // for a model that SHOULD return structured blocks it signals an adapter
      // gap (warning). Either way the call is parsed + executed identically.
      toolCalls = _parseToolCalls(aiResult.reply).map(_canonicalizeToolCall);
      if (toolCalls.length > 0) {
        if (_modelLacksNativeTools) {
          console.info('[toolUseLoop] text-protocol fallback: recovered %d tool call(s) via <tool_call> text interception (expected for text-only model).', toolCalls.length);
        } else {
          console.warn('[toolUseLoop] WARN: falling back to text-based <tool_call> parsing (%d calls). Adapter should return structured toolUseBlocks.', toolCalls.length);
        }
      }
    }

    // 跨轮「答案回声」断路器(重复输出统一缺口:无跨轮答案文本比对)。在工具执行 + 门级联**之前**,
    // 判断本轮答案是否复现了此前已流式过的某个答案 → 结论前早返,阻止「下一次」重复流(封顶到已流式的
    // 那一份;append-only REPL 无法回收已打印文本,故只能阻止下一次并对缓冲端发 reset)。IO-only 接线,
    // 包一层 try/catch fail-soft;门关(KHY_ANSWER_ECHO_GUARD)→ 整段跳过,逐字节回退旧多轮行为。
    try {
      if (_answerEchoGuard.isEnabled(process.env) && aiResult && typeof aiResult.reply === 'string' && aiResult.reply) {
        const _echoFp = _answerEchoGuard.normalize(aiResult.reply);
        if (_answerEchoGuard.isSubstantive(aiResult.reply) && _answerEchoGuard.isEcho(_echoFp, _streamedAnswerFps)) {
          try { _emitStreamReset('answer-echo'); } catch { /* 缓冲端回收;REPL 无害 no-op */ }
          return {
            finalResponse: _stripToolCalls(_stripExecutionPlan(aiResult.reply)),
            terminalNotice: '',
            toolCallLog,
            iterations: iteration,
            provider: aiResult.provider,
            tokenUsage: aiResult.tokenUsage,
            effort: aiResult.effort,
            conversationMessages,
            harnessProfile: _harnessProfile,
          };
        }
        // 记录本轮 substantive 且已流式过的答案指纹,供后续轮次比对(仅在真流式过时入历史)。
        if (_sawStreamedText && _answerEchoGuard.isSubstantive(aiResult.reply)) {
          _streamedAnswerFps.push(_echoFp);
        }
      }
    } catch { /* fail-soft:回声断路器绝不反噬主循环 */ }

    // Capability-matrix runtime context for this iteration's seam checks. It is
    // a live-reading closure (not a snapshot) because `toolCalls` is reassigned
    // by the injection/filter seams below — each isEnabledAt() must see the
    // toolCalls length AS OF its own seam, exactly as the old inline guards did.
    const _capMatrix = getCapabilityMatrix();
    const _capCtx = () => ({
      iteration,
      toolCallsLen: toolCalls.length,
      isSubagent: !!effectiveChatOpts._isSubagent,
    });

    // Observability (default OFF, zero output change): when KHY_CAPABILITY_ROUTE_DEBUG
    // is set, compose and surface the inspectable capability route for this turn
    // so the user can SEE which capabilities composed and why others were skipped
    // — the whole point of cut 1. Composition is read-only and never gates any
    // seam; the seams still fire at their own isEnabledAt() checks above.
    if (_envFlagEnabled(process.env.KHY_CAPABILITY_ROUTE_DEBUG, false)) {
      try {
        const _route = _capMatrix.composeRoute({
          signals: { modes: _activatedModes },
          ctx: _capCtx(),
        });
        _lastCapabilityRoute = _route;
        if (onToolResult) {
          onToolResult('_capability_route', {}, { success: true }, iteration, 0, _formatCapRoute(_route));
        }
      } catch { /* route observability is best-effort and never blocks the loop */ }
    }

    // 2a. Parse execution plan from first response (task decomposition)
    if (iteration === 1 && isComplex && !executionPlan) {
      executionPlan = _parseExecutionPlan(aiResult.reply);
      if (executionPlan && onPlanReady) {
        onPlanReady(executionPlan);
      }
    }

    // 2a-bis. 关键节点主动汇报（语义半）：模型可在任意一轮吐出 <finding> 标记
    // （根因/突破/受阻）。不按 iteration 门控；子 agent 抑制。原始标记由
    // _stripExecutionPlan 在所有显示点剥离，这里只把结构化 finding 发给消费者。
    if (_keyFindings && typeof onKeyFinding === 'function' && !effectiveChatOpts._isSubagent) {
      try {
        for (const f of (_keyFindings.parseModelFindings(aiResult.reply, process.env) || [])) {
          onKeyFinding(f);
        }
      } catch { /* reporting is best-effort and never blocks the loop */ }
    }

    // Also include legacy [CMD:...] commands as pseudo-tool-calls
    if (aiResult.commands && aiResult.commands.length > 0) {
      for (const cmd of aiResult.commands) {
        toolCalls.push({ name: '_legacy_cmd', params: { command: cmd }, legacy: true });
      }
    }

    toolCalls = _rewriteShellCallsForAppLaunch(toolCalls, userMessage);

    // CC 对齐计划模式收尾:模型调 ExitPlanMode 表示计划已就绪。计划模式下拦在任何工具派发 / 只读闸
    // 之前——把计划参数交回宿主(TUI → PlanApproval 审阅框:planPhase='reviewing'),并按终端契约收口
    // 本轮循环。仅当 planMode(本轮计划模式)才拦,避免普通轮误调 ExitPlanMode 时被截停。cancel 动作
    // 不交计划(宿主回落普通模式)。fail-soft:回调抛错绝不阻断收口。
    if (planMode) {
      const _exitPlan = toolCalls.find((c) => c && (c.name === 'ExitPlanMode' || c.name === 'exit_plan_mode'));
      if (_exitPlan) {
        const _exitParams = _exitPlan.params || {};
        if (_exitParams.action !== 'cancel' && typeof onExitPlanMode === 'function') {
          try { onExitPlanMode(_exitParams); } catch { /* fail-soft:计划投递绝不阻断收口 */ }
        }
        const _planProse = _stripToolCalls(_stripExecutionPlan(aiResult.reply));
        return {
          finalResponse: _planProse,
          terminalNotice: '',
          toolCallLog,
          iterations: iteration,
          provider: aiResult.provider,
          tokenUsage: aiResult.tokenUsage,
          conversationMessages,
          harnessProfile: _harnessProfile,
          planExit: { action: _exitParams.action || 'approve' },
        };
      }
    }

    // Patch empty web_search queries — models sometimes decide to search
    // but fail to include the query parameter.  Derive from user message.
    _patchEmptySearchQuery(toolCalls, originalUserMessage);

    // Patch empty shell commands — small models output ▶ Bash() with no command.
    // Infer from user request context (e.g. "整理桌面" → list Desktop).
    _patchEmptyShellCommand(toolCalls, originalUserMessage);

    // Patch empty local search keyword — small models output Search() with no args.
    _patchEmptyLocalSearchKeyword(toolCalls, originalUserMessage);

    // Drop degenerate no-op prose echoes (e.g. `echo "好的，给你讲个笑话："` on a
    // text-only turn). Such a call has no side effect and reprints text the model
    // already wrote; re-dispatching it trips the identical-result guardrail. When
    // this leaves zero calls, the loop delivers the model's reply directly.
    if (_degenerateShellEcho && typeof _degenerateShellEcho.filterDegenerateEchoCalls === 'function') {
      try {
        const before = toolCalls.length;
        const res = _degenerateShellEcho.filterDegenerateEchoCalls(toolCalls, process.env);
        if (res && Array.isArray(res.toolCalls) && res.dropped > 0) {
          toolCalls = res.toolCalls;
          _loopBreadcrumb('degenerate-echo-dropped', { dropped: before - toolCalls.length, remaining: toolCalls.length, iteration });
        }
      } catch { /* fail-soft: keep every call on any error */ }
    }

    // Auto-web-search: when the first round likely needs external/current info
    // but AI gave no tool call, inject one or more web_search calls proactively.
    let autoWebSearchInjected = false;
    let autoScaffoldInjected = false;
    if (
      toolCalls.length === 0
      && iteration === 1
      && _envFlagEnabled(process.env.KHY_AUTO_WEBSEARCH_ON_INFO_TASK, true)
      && !userToolConstraints.disallowAllTools
      && !userToolConstraints.disallowSearch
      && _looksLikeInfoSearchRequest(originalUserMessage)
    ) {
      const maxAutoQueries = _parsePositiveInt(process.env.KHY_AUTO_WEBSEARCH_QUERY_CANDIDATES, 3, 1, 6);
      const configuredMode = options?.autoWebSearchMode || options?.autoWebSearch?.mode || process.env.KHY_AUTO_WEBSEARCH_MODE || 'auto';
      const resolvedMode = _resolveAutoWebSearchMode(originalUserMessage, configuredMode);
      const candidates = _buildSearchQueryCandidates(originalUserMessage, maxAutoQueries, resolvedMode);
      if (candidates.length > 0) {
        toolCalls = candidates.map((query) => ({
          name: 'web_search',
          params: { query },
        }));
        autoWebSearchInjected = true;
      }
    }

    // Auto-scaffold: when intent is project structure creation and no tool call
    // was returned, infer a scaffold spec from user text and execute directly.
    // Sanitize to strip [System Skill/Memory/Context] hints injected by the
    // agentic harness — their descriptions contain words like "scaffold" and
    // "initialize...project" that would otherwise false-positive every request.
    const sanitizedOriginal = _sanitizeSearchSourceMessage(originalUserMessage);
    const scaffoldOriginal = _sanitizeSearchSourceMessage(originalUserMessage, { collapseWhitespace: false });
    if (
      toolCalls.length === 0
      && iteration === 1
      && _envFlagEnabled(process.env.KHY_AUTO_SCAFFOLD_ON_INTENT, true)
      && !userToolConstraints.disallowAllTools
      && _looksLikeProjectScaffoldRequest(scaffoldOriginal)
    ) {
      const defaultConcurrency = _parsePositiveInt(process.env.KHY_SCAFFOLD_DEFAULT_CONCURRENCY, 4, 1, 16);
      const parsedScaffold = _extractScaffoldSpecFromMessage(scaffoldOriginal, { defaultConcurrency });
      if (parsedScaffold) {
        toolCalls = [{ name: 'scaffoldFiles', params: parsedScaffold }];
        autoScaffoldInjected = true;
      }
    }

    // ── Proactive collaboration (DESIGN-ARCH-031) ─────────────────────────
    // When the lead agent is handed a clearly decomposable, multi-deliverable
    // task but the model itself emitted no tool call, proactively DECOMPOSE the
    // task and DELEGATE the independent pieces to a bounded fan-out of
    // collaborating sub-agents (the orchestrated `agent` path), instead of
    // grinding the parts serially or waiting for the user to ask for sub-agents.
    // This is the seam that turns "passive serial response" into "proactive
    // collaboration". Guards: lead loop only (!_isSubagent — never recurse),
    // agent tool must be in the pool, env-gated, conservative detector, fail-soft.
    let autoCollaborationInjected = false;
    if (
      toolCalls.length === 0
      && iteration === 1
      && !autoWebSearchInjected
      && !autoScaffoldInjected
      && !effectiveChatOpts._isSubagent
      && !userToolConstraints.disallowAllTools
    ) {
      try {
        let _agentToolAvailable = false;
        try {
          const _tr = require('../tools');
          _agentToolAvailable = !!(_tr && typeof _tr.get === 'function'
            && (_tr.get('agent') || _tr.get('Task')));
        } catch { /* tool registry unavailable → treat agent tool as absent */ }

        const _collab = require('./proactiveCollaboration');
        const _proposal = _collab.proposeCollaboration(originalUserMessage, {
          // byte-identical to _envFlagEnabled(KHY_PROACTIVE_COLLAB, true): the
          // outer if already enforces iteration===1 && toolCalls.length===0 &&
          // !_isSubagent, a superset of the descriptor's firstTurnEmptyNoSub.
          enabled: _capMatrix.isEnabledAt(CAP_SEAMS.PRE_DISPATCH, 'proactiveCollab', _capCtx()),
          agentToolAvailable: _agentToolAvailable,
        });
        if (_proposal.inject && _proposal.toolCall) {
          toolCalls = [_proposal.toolCall];
          autoCollaborationInjected = true;
          if (onToolResult) {
            onToolResult('_proactive_collaboration', {}, { success: true }, iteration, 0, _proposal.reason);
          }
        }
      } catch { /* proactive collaboration is best-effort and never blocks the loop */ }
    }

    const intentFilter = _filterToolCallsByIntent(toolCalls, originalUserMessage, userToolConstraints);
    const removedConstraintCalls = Array.isArray(intentFilter.removedByConstraint) ? intentFilter.removedByConstraint : [];
    const removedIntentMismatchCalls = Array.isArray(intentFilter.removedByIntent) ? intentFilter.removedByIntent : [];
    toolCalls = Array.isArray(intentFilter.kept) ? intentFilter.kept : toolCalls;

    // ── Unknown-Problem Handler state machine (DESIGN-ARCH-050) ──────────
    // Flag-gated (KHY_UNKNOWN_PROBLEM_HANDLER, default off); fail-open — the
    // handler must never break the loop. Two structure-driven state locks:
    //   (a) Info-request gate: the model emitted a 🔍 未知点识别 / ❓ 确认信息
    //       structure, i.e. it is WAITING for the user. Clear any tool calls so
    //       the existing empty-toolCalls path returns the questions to the user
    //       instead of executing on unconfirmed assumptions. This is the code
    //       half of the "NEVER skip 信息请求 to directly 执行" double-constraint
    //       (the prompt half forbids emitting execution structure before a plan
    //       is chosen; the code half enforces it even if the model slips).
    //   (b) Deviation rollback: the model emitted a ⚠️ 偏离预警, i.e. a step
    //       failed. Inject the context-sanitization directive once so the next
    //       reasoning round drops the failed assumptions instead of looping on
    //       them. Bounded to a single injection per turn to avoid spin.
    let _uphInfoRequestActive = false;
    try {
      const _uph = require('./unknownProblemHandler');
      // module-kind flag: isEnabledAt delegates to unknownProblemHandler.isEnabled()
      // (precondition is PRE.always), so this is byte-identical to _uph.isEnabled().
      if (_capMatrix.isEnabledAt(CAP_SEAMS.EMPTY_TOOLCALLS, 'unknownProblem', _capCtx())) {
        if (_uph.isInfoRequest(aiResult.reply) && toolCalls.length > 0) {
          if (onToolResult) {
            onToolResult('_system_info_request', {}, { success: true }, iteration, 0,
              '检测到信息请求结构（🔍 未知点识别），暂停执行、交还用户确认');
          }
          toolCalls = [];
        }
        // Whether or not it carried a tool call, an info-request reply IS the
        // turn's conclusion: it must be handed to the user verbatim. Mark it so
        // the empty-toolCalls delivery nudges below do not mistake the questions
        // for an incomplete short answer and drive a speculative extra turn.
        _uphInfoRequestActive = _uph.isInfoRequest(aiResult.reply);
        if (
          _uph.isDeviationWarning(aiResult.reply)
          && toolCalls.length === 0
          && !_uphSanitizeUsed
        ) {
          _uphSanitizeUsed = true;
          currentMessage = `${_uph.buildSanitizationDirective()}\n\n${originalUserMessage || userMessage || ''}`;
          continue;
        }
      }
    } catch { /* fail-open: state machine must never break the tool loop */ }

    // Prime suspect for "answer done but still 思考中": the model attached a
    // trailing tool_use to an already-substantive reply, so the loop executes
    // it and runs another (visibly idle) model turn beneath the finished answer.
    if (toolCalls.length > 0) {
      const _replyTextLen = _stripToolCalls(_stripExecutionPlan(aiResult.reply)).replace(/\s/g, '').length;
      if (_replyTextLen >= 200) {
        _loopBreadcrumb('trailing-tool-use-after-text', {
          iteration,
          replyChars: _replyTextLen,
          toolCalls: toolCalls.map(c => c && c.name).filter(Boolean),
          autoWebSearchInjected,
          autoScaffoldInjected,
        });
      }
    }

    if (removedConstraintCalls.length > 0 && toolCalls.length === 0 && !noToolNudgeUsed) {
      noToolNudgeUsed = true;
      const strippedReply = _stripToolCalls(_stripExecutionPlan(aiResult.reply));
      if (onNoToolCall) {
        onNoToolCall(iteration, strippedReply, {
          placeholder: _looksLikeProgressOnlyReply(strippedReply),
          actionTask: _looksLikeActionRequest(userMessage),
          autoContinued: true,
          constraintBlocked: true,
          blockedTools: removedConstraintCalls.map(call => call?.name).filter(Boolean),
        });
      }
      currentMessage = _buildConstraintRespectNudge(
        userMessage,
        strippedReply,
        userToolConstraints,
        removedConstraintCalls,
      );
      continue;
    }

    if (_harnessProfile.nudges && removedIntentMismatchCalls.length > 0 && toolCalls.length === 0 && iteration === 1 && !noToolNudgeUsed) {
      noToolNudgeUsed = true;
      const strippedReply = _stripToolCalls(_stripExecutionPlan(aiResult.reply));
      if (onNoToolCall) {
        onNoToolCall(iteration, strippedReply, {
          placeholder: _looksLikeProgressOnlyReply(strippedReply),
          actionTask: _looksLikeActionRequest(userMessage),
          autoContinued: true,
          intentMismatch: true,
        });
      }
      currentMessage = _buildNoToolCallNudge(
        userMessage,
        `${strippedReply}\n\n[System notice] open_app was blocked because this request does not appear to be an app-launch command. Answer the user directly or use a relevant non-launch tool.`
      );
      continue;
    }

    const plannedTools = _buildPlannedToolList(toolCalls);
    emitDecision({
      iteration,
      mode: toolCalls.length > 0 ? 'tool' : 'final',
      preview: autoWebSearchInjected
        ? `Auto web search(${_resolveAutoWebSearchMode(originalUserMessage, options?.autoWebSearchMode || options?.autoWebSearch?.mode || process.env.KHY_AUTO_WEBSEARCH_MODE || 'auto')}) x${toolCalls.length}: ${String(toolCalls[0]?.params?.query || '').slice(0, 80)}`
        : autoScaffoldInjected
          ? `Auto scaffold: ${String(toolCalls[0]?.params?.root || '.')} (${Array.isArray(toolCalls[0]?.params?.directories) ? toolCalls[0].params.directories.length : 0} dirs / ${Array.isArray(toolCalls[0]?.params?.files) ? toolCalls[0].params.files.length : 0} files)`
        : autoCollaborationInjected
          ? `Proactive collaboration: delegating ${Array.isArray(toolCalls[0]?.params?.subtasks) ? toolCalls[0].params.subtasks.length : 0} sub-tasks to parallel agents`
          : _extractDecisionPreview(aiResult.reply),
      toolCount: toolCalls.length,
      tools: plannedTools,
    });

    // 问题 #1 (续): 适配器本轮未流式任何文本、但模型在工具调用前写了说明 → 现在把
    // 这段说明作为 text chunk 补发一次。否则非流式适配器只会显示工具调用 + 结果，
    // 没有任何「命令执行说明」。流式适配器已发过文本（_sawStreamedText=true）则跳过，
    // 避免重复渲染。
    if (toolCalls.length > 0 && !_sawStreamedText && _callerOnChunk) {
      const _preamble = _stripToolCalls(_stripExecutionPlan(aiResult.reply)).trim();
      if (_preamble && _preamble.replace(/\s/g, '').length >= 8) {
        // Skip if this exact preamble was already emitted this turn (a flaky
        // channel re-running the same planning sentence each retry must not
        // print it N times).
        const _norm = _preamble.replace(/\s+/g, ' ').trim();
        if (_norm !== _lastEmittedPreamble) {
          _lastEmittedPreamble = _norm;
          try { _callerOnChunk({ type: 'text', text: _preamble }); } catch { /* non-critical narration replay */ }
        }
      }
    }

    // 3. No tool calls → final response
    // 批1 — stop_reason 续跑保护: a NATIVE turn whose stop_reason says tool_use but
    // whose structured blocks were lost (and whose text fallback recovered nothing)
    // must not be silently finalized — the model meant to act. Re-prompt ONCE to let
    // it re-emit the call, instead of concluding on a half-finished turn. Bounded by a
    // one-shot flag; native-only + KHY_TRUST_STOP_REASON via _shouldTrustStopReason.
    if (
      toolCalls.length === 0
      && !_stopReasonRecoveryUsed
      && normalizedStopReason === 'tool_use'
      && _shouldTrustStopReason(_isTextProtocol)
    ) {
      _stopReasonRecoveryUsed = true;
      _loopBreadcrumb('stop-reason-recovery', { iteration, stopReason: aiResult.stopReason });
      currentMessage = '[SYSTEM: Your previous turn signaled a tool call (stop_reason=tool_use) '
        + 'but no tool call was received. Please re-issue the intended tool call now, '
        + 'or, if no tool is needed, give your final answer directly.]';
      continue;
    }

    // Phase R2-3B: Verification nudge — when 3+ file writes without any verify/test tool,
    // inject a one-shot reminder (learned from CC's TodoWrite verification nudge).
    if (toolCalls.length === 0 && !_verificationNudgeUsed) {
      const writeCount = toolCallLog.filter(t =>
        /^(write_file|editFile|FileEdit|FileWrite|file_write|writeFile|edit_file)$/i.test(t.tool)
      ).length;
      const hasVerify = toolCallLog.some(t =>
        /verify|test|check|lint|typecheck|runTests/i.test(t.tool)
      );
      if (writeCount >= 3 && !hasVerify && iteration > 1) {
        _verificationNudgeUsed = true;
        currentMessage = '[SYSTEM: You completed ' + writeCount + ' file modifications without running any verification. '
          + 'Before concluding, run relevant tests or verify your changes to ensure correctness.]';
        continue;
      }
    }

    // ── Hard verification gate (edit → verify → iterate) ─────────────
    // When the model tries to conclude AFTER making successful edits, force a
    // syntax + adversarial verification pass. Unlike the soft nudges above,
    // this is a GATE: a FAIL verdict injects the failures and forces another
    // iteration instead of letting the turn end. Bounded by KHY_VERIFY_MAX_ROUNDS
    // (default 2) so it can never deadlock — at the ceiling we conclude but
    // annotate that verification did not pass.
    if (
      toolCalls.length === 0
      && _allModifiedFiles.size > 0
      && _capMatrix.isEnabledAt(CAP_SEAMS.EMPTY_TOOLCALLS, 'verifyGate', _capCtx())
    ) {
      const maxRounds = _parsePositiveInt(process.env.KHY_VERIFY_MAX_ROUNDS, 2, 1, 5);
      if (_verifyGateRounds < maxRounds) {
        const filesToVerify = [..._allModifiedFiles];
        const gateCwd = effectiveChatOpts?.cwd || process.env.KHYQUANT_CWD || process.cwd();
        const { quickSyntaxCheck, adversarialVerifyEnsemble } = require('./verificationAgent');

        let gateFailed = false;
        let gateInjection = '';

        // 1) Cheap syntax gate first — a syntax error is an unambiguous FAIL.
        try {
          const syntax = quickSyntaxCheck(filesToVerify, gateCwd);
          if (!syntax.pass && Array.isArray(syntax.errors) && syntax.errors.length > 0) {
            gateFailed = true;
            gateInjection = '[VERIFICATION GATE — SYNTAX ERRORS in files you modified. Fix them with tool calls before concluding:]\n'
              + syntax.errors.map(e => `  - ${e}`).join('\n');
          }
        } catch { /* syntax check best-effort */ }

        // 2) Adversarial verification only when syntax passed.
        if (!gateFailed) {
          try {
            const verdictResult = await adversarialVerifyEnsemble({
              files: filesToVerify,
              cwd: gateCwd,
              taskDescription: originalUserMessage || userMessage,
              toolResults: toolCallLog,
              executeAI: async (probePrompt) => {
                const r = await chat(probePrompt, {
                  ...effectiveChatOpts,
                  _isFollowUp: true,
                  _verificationProbe: true,
                });
                return (r && (r.reply || r.content || r.text)) || '';
              },
            });
            if (verdictResult && verdictResult._source === 'ensemble') {
              _loopBreadcrumb('ensemble-verify', {
                line: 'code', verdict: verdictResult.verdict,
                ok: verdictResult.ok, fail: verdictResult.fail, votes: verdictResult.votes,
              });
            }
            if (verdictResult && verdictResult.verdict === 'FAIL') {
              gateFailed = true;
              const failedChecks = (verdictResult.checks || [])
                .filter(c => c.result === 'FAIL')
                .map(c => `  - ${c.command}: ${String(c.output || '').slice(0, 200)}`)
                .join('\n');
              gateInjection = '[VERIFICATION GATE — adversarial verification FAILED. Address these issues with tool calls, then conclude:]\n'
                + (failedChecks || verdictResult.summary || 'Verification did not pass.');
            }
          } catch { /* adversarial verify best-effort — never block delivery on its own errors */ }
        }

        if (gateFailed) {
          _verifyGateRounds++;
          if (onNoToolCall) {
            onNoToolCall(iteration, _stripToolCalls(_stripExecutionPlan(aiResult.reply)), {
              placeholder: false,
              actionTask: true,
              verificationGate: true,
              gateRound: _verifyGateRounds,
              autoContinued: true,
            });
          }
          _loopBreadcrumb('nudge-continue', { iteration, nudge: 'verificationGate', gateRound: _verifyGateRounds });
          currentMessage = gateInjection
            + `\n\n[Verification round ${_verifyGateRounds}/${maxRounds}. Fix the issues above with tool calls, then conclude.]`;
          continue;
        }
      } else {
        // Retry ceiling reached — let the turn conclude but flag it so the
        // delivery summary makes clear verification never passed.
        _verifyGateExhausted = true;
      }
    }

    // ── [P6] Non-edit evidence-sufficiency gate ──────────────────────
    // The hard gate above only fires when files were modified. CC keeps a
    // verification reflex for research/shell/API work too: a task that ran
    // substantive non-edit tools (commands, web/search, fetch) but produced no
    // file changes can still conclude on thin evidence. When the model tries to
    // wrap up after enough such calls, run ONE lightweight evidence self-check
    // (no syntax/test/build steps). A FAIL injects the gaps and forces one more
    // iteration. Bounded by KHY_VERIFY_NONEDIT_ROUNDS (default 1); disabled with
    // KHY_VERIFY_NONEDIT=off.
    if (
      toolCalls.length === 0
      && _allModifiedFiles.size === 0
      && _capMatrix.isEnabledAt(CAP_SEAMS.EMPTY_TOOLCALLS, 'verifyNonEdit', _capCtx())
    ) {
      const _normTool = (s) => String(s || '').toLowerCase().replace(/[\s_-]/g, '');
      const _substantiveRe = /^(bash|shell|shellcommand|runcommand|exec|execcommand|runshell|websearch|webfetch|web|fetch|fetchurl|httprequest|apicall|universalsearch|search)$/;
      const substantiveCalls = toolCallLog.filter(t =>
        _substantiveRe.test(_normTool(t.tool))
        && !(t.result && t.result.success === false)
      ).length;
      const threshold = _parsePositiveInt(process.env.KHY_VERIFY_NONEDIT_THRESHOLD, 2, 1, 20);
      const maxRounds = _parsePositiveInt(process.env.KHY_VERIFY_NONEDIT_ROUNDS, 1, 1, 3);

      if (substantiveCalls >= threshold && _nonEditVerifyRounds < maxRounds) {
        const draftConclusion = _stripToolCalls(_stripExecutionPlan(aiResult.reply));
        try {
          const { evidenceSufficiencyEnsemble } = require('./verificationAgent');
          const verdictResult = await evidenceSufficiencyEnsemble({
            taskDescription: originalUserMessage || userMessage,
            toolResults: toolCallLog,
            draftConclusion,
            executeAI: async (probePrompt) => {
              const r = await chat(probePrompt, {
                ...effectiveChatOpts,
                _isFollowUp: true,
                _verificationProbe: true,
              });
              return (r && (r.reply || r.content || r.text)) || '';
            },
          });
          if (verdictResult && verdictResult._source === 'ensemble') {
            _loopBreadcrumb('ensemble-verify', {
              line: 'evidence', verdict: verdictResult.verdict,
              ok: verdictResult.ok, fail: verdictResult.fail, votes: verdictResult.votes,
            });
          }
          if (verdictResult && verdictResult.verdict === 'FAIL') {
            _nonEditVerifyRounds++;
            const gapList = (verdictResult.gaps || []).map(g => `  - ${g}`).join('\n');
            if (onNoToolCall) {
              onNoToolCall(iteration, draftConclusion, {
                placeholder: false,
                actionTask: true,
                verificationGate: true,
                nonEditEvidence: true,
                gateRound: _nonEditVerifyRounds,
                autoContinued: true,
              });
            }
            _loopBreadcrumb('nudge-continue', { iteration, nudge: 'nonEditEvidenceGate', gateRound: _nonEditVerifyRounds });
            currentMessage = '[EVIDENCE GATE — your conclusion is not yet sufficiently supported by the evidence gathered. '
              + 'Close these gaps with further tool calls (search/read/run), then conclude:]\n'
              + (gapList || 'Gather or cite concrete evidence for your key claims before concluding.')
              + `\n\n[Evidence round ${_nonEditVerifyRounds}/${maxRounds}.]`;
            continue;
          }
        } catch { /* evidence self-check best-effort — never block delivery on its own errors */ }
      }
    }

    // ── 项目整体一致性门 ([DESIGN-ARCH-050]) ─────────────────────────
    // 用户痛点：单个文件没问题，聚成项目后导入断链 / 入口失配 / 清单指空，一跑就崩。
    // 当模型在写过多文件后想收尾时，对「本会话产物 + 磁盘」做整体静态体检；发现高置信度
    // 断裂就把它顶回去，逼模型先把项目装配成一个能跑的整体。确定性、零模型、与模型档无关，
    // 即便 nudges 关闭也生效。有界（KHY_PROJECT_COHERENCE_ROUNDS，默认 2），到顶放行并标注。
    if (
      toolCalls.length === 0
      && _allModifiedFiles.size >= 2
      && _capMatrix.isEnabledAt(CAP_SEAMS.EMPTY_TOOLCALLS, 'projectCoherence', _capCtx())
    ) {
      const _cohMaxRounds = _parsePositiveInt(process.env.KHY_PROJECT_COHERENCE_ROUNDS, 2, 1, 5);
      if (_coherenceGateRounds < _cohMaxRounds) {
        try {
          const projectCoherence = require('./projectCoherence');
          const gateCwd = effectiveChatOpts?.cwd || process.env.KHYQUANT_CWD || process.cwd();
          const decision = projectCoherence.evaluateCoherenceGate({
            files: [..._allModifiedFiles],
            cwd: gateCwd,
            rounds: _coherenceGateRounds,
            maxRounds: _cohMaxRounds,
            blockOnMedium: _envFlagEnabled(process.env.KHY_PROJECT_COHERENCE_MEDIUM, false),
          });
          if (decision.shouldGate) {
            _coherenceGateRounds++;
            if (onNoToolCall) {
              onNoToolCall(iteration, _stripToolCalls(_stripExecutionPlan(aiResult.reply)), {
                placeholder: false,
                actionTask: true,
                coherenceGate: true,
                gateRound: _coherenceGateRounds,
                gapCount: decision.blocking.length,
                autoContinued: true,
              });
            }
            _loopBreadcrumb('nudge-continue', {
              iteration, nudge: 'projectCoherenceGate', gateRound: _coherenceGateRounds, gaps: decision.blocking.length,
            });
            currentMessage = decision.message;
            continue;
          }
        } catch { /* coherence analysis best-effort — never block delivery on its own errors */ }
      } else {
        _coherenceGateExhausted = true;
      }
    }

    // ── 完成时审计→修复闭环（阶段性/大任务收尾，用户指令）─────────────────
    // 用户痛点：大任务收尾时没人对抗式复查，bug/安全/竞态悄悄进交付。
    // 设计：当模型在「改了文件 / 有执行计划 / Goal 模式」后想收尾时，自动派只读
    // 审计智能体挑刺；发现 CRITICAL/HIGH 即派编辑型修复智能体修复，再重审确认
    // （全自动 + 有界重审 KHY_AUDIT_FIX_MAX_ROUNDS 默认 2）。遗留问题透明标注到
    // 交付末尾。本闸放在所有验证门之后（先过语法/测试/一致性），一次性（_auditFixDone），
    // 且仅主循环触发（子 agent 不递归，triggerGate 内 isSubagent 守卫）。整段 fail-soft：
    // 审计闭环自身任何异常都绝不阻断交付。
    if (
      toolCalls.length === 0
      && !_auditFixDone
      && !effectiveChatOpts._isSubagent
    ) {
      try {
        const auditFixLoop = require('./auditFixLoop');
        const _gate = auditFixLoop.triggerGate.shouldAudit({
          modifiedFileCount: _allModifiedFiles.size,
          hasExecutionPlan: !!(executionPlan && Array.isArray(executionPlan.steps) && executionPlan.steps.length > 0),
          goalModeActive: (() => { try { return require('./goalModeService').isActive(); } catch { return false; } })(),
          isSubagent: !!effectiveChatOpts._isSubagent,
        });
        if (_gate.audit) {
          _auditFixDone = true; // mark before dispatch so a thrown error can't re-enter
          const _afFiles = [..._allModifiedFiles];
          const _afTimeoutMs = auditFixLoop.triggerGate.dispatchTimeoutSeconds() * 1000;
          // 自修复事务:fix 阶段改完文件后,自动在改动集上跑语法/守卫校验,全绿才保留、
          // 任一不绿就回滚到改前状态(快照→修复→校验→保留或回滚)。门控 KHY_SELF_REPAIR_TRANSACTION
          // 默认开;关闭即字节回退到「fix agent 直接改」。决策收纯叶子,IO 在 selfRepair/primitives。
          const selfRepairTransaction = require('./selfRepairTransaction');
          const _repairTxnNotes = [];
          // Inject the sub-agent dispatcher: reuse the singleton AgentTool so the
          // audit/fix agents run through the exact same loop, permission channel,
          // and depth guard as any other sub-agent (depth 1, leaf executors).
          const _runAgent = async ({ role, prompt }) => {
            try {
              const agentTool = require('../tools/AgentTool');
              const res = await agentTool.execute(
                { prompt, subagent_type: role, role, timeout: Math.round(_afTimeoutMs / 1000) },
                {
                  _agentContext: options._agentContext || null,
                  traceContext: { onControlRequest, onAgentProgress: null },
                },
              );
              return {
                text: (res && (res.output || res.error)) || '',
                filesModified: (res && res.filesModified) || [],
                success: !!(res && res.success !== false),
              };
            } catch (e) {
              return { text: '', filesModified: [], success: false, error: e && e.message };
            }
          };
          const _dispatchAgent = async ({ role, prompt }) => {
            // 仅 fix 阶段(会改文件)包裹事务;audit 只读不包裹。门控关 → 直接跑。
            if (role !== 'fix' || !selfRepairTransaction.isEnabled(process.env)) {
              return _runAgent({ role, prompt });
            }
            try {
              const { runRepairTransaction } = require('./selfRepair/transactionRunner');
              const prim = require('./selfRepair/primitives').create({});
              const r = await runRepairTransaction({
                runFix: () => _runAgent({ role, prompt }),
                snapshot: prim.snapshot,
                restore: prim.restore,
                validateFiles: prim.validateFiles,
                env: process.env,
              });
              const txn = r && r.transaction;
              if (txn && txn.annotation) _repairTxnNotes.push(txn.annotation);
              // 回滚后这些文件已还原 → 不计入会话改动(返回空 filesModified)。
              if (txn && txn.decision && txn.decision.keep === false) {
                return { text: r.text, filesModified: [], success: !!r.success };
              }
              return { text: r.text, filesModified: (r && r.filesModified) || [], success: !!(r && r.success) };
            } catch (e) {
              // 事务机器故障 → fail-soft 回退到未包裹的 fix(绝不比今天差)。
              return _runAgent({ role, prompt });
            }
          };
          _loopBreadcrumb('audit-fix-start', { iteration, reason: _gate.reason, files: _afFiles.length });
          const _afResult = await auditFixLoop.runAuditFixCycle({
            dispatchAgent: _dispatchAgent,
            taskDescription: originalUserMessage || userMessage,
            files: _afFiles,
            onEvent: (evt) => {
              try {
                if (onNoToolCall && (evt.type === 'audit_start' || evt.type === 'fix_start')) {
                  // surface progress through the same channel the verify gate uses
                  onNoToolCall(iteration, '', { auditFix: true, phase: evt.type, round: evt.round, autoContinued: false });
                }
              } catch { /* progress best-effort */ }
            },
          });
          _auditFixAnnotation = auditFixLoop.buildAnnotation(_afResult) || '';
          // 追加自修复事务注解(每轮 fix 的保留/回滚透明可见)。
          if (_repairTxnNotes.length) {
            _auditFixAnnotation += _repairTxnNotes.join('');
          }
          _loopBreadcrumb('audit-fix-done', {
            iteration,
            outcome: _afResult.outcome,
            remaining: _afResult.totalActionableRemaining,
            filesFixed: (_afResult.filesFixed || []).length,
          });
          // Fix agent may have edited files — fold them into the session accumulator
          // so downstream consumers (and any future re-runs) see them.
          for (const _f of (_afResult.filesFixed || [])) _allModifiedFiles.add(_f);
        }
      } catch { /* audit→fix loop is best-effort — never block delivery on its own errors */ }
    }

    // Nudge 精简 (对标 Claude Code/DeepSeek-TUI: 无 nudge，模型不调工具即视为完成)
    // 仅保留 2 种一次性 nudge: choiceResponse + earlyEndTurn
    if (toolCalls.length === 0) {
      // 弱模型退化:单次 completion 里把整段答案逐字生成两遍(reply = A + A)。在此结论分支的
      // 源头折叠为一份,让下游全链(交付门 / finalText / terminalNotice / 返回 finalResponse /
      // 历史 / CLI 缓冲渲染)都只见去重后的单份。必须在 strip 之后、terminalNotice 追加之前折叠——
      // 一旦服务端把 terminalNotice 拼到 finalText 尾部,A+A 的对称就被破坏、折叠将失效。
      // 门 KHY_REPLY_DEDUP(default-on);关/非匹配 → 逐字节原样。fail-soft:异常回退未折叠文本。
      let strippedReply = _stripToolCalls(_stripExecutionPlan(aiResult.reply));
      try { strippedReply = _replyDedup.collapseDuplicatedReply(strippedReply, process.env); } catch { /* fail-soft */ }
      const placeholder = _looksLikeProgressOnlyReply(strippedReply);
      const sanitizedUser = _sanitizeSearchSourceMessage(userMessage);
      const actionTask = _looksLikeActionRequest(sanitizedUser) && !userToolConstraints.disallowAllTools;

      // Substantive-reply short-circuit: a long, non-placeholder answer is a
      // complete delivery on its own. Skip the soft "are you really done?"
      // delivery nudges (choiceResponse / earlyEndTurn / deliveryConclusion /
      // completeness-coverage) so the loop concludes in one place instead of
      // spending extra model turns — which left the TUI spinner showing
      // "思考中…" beneath an already-finished answer. The hard verification gate
      // (file edits, above) and the coding build-verify nudge are correctness
      // gates and are intentionally NOT bypassed here. Threshold is generous
      // (>= 400 non-whitespace chars) so short test/edge replies are unaffected.
      const concludeNow = _uphInfoRequestActive
        || _circuitBrokenHandled // post-breaker tools-free turn: take its text as final, never re-nudge (绕圈子 guard)
        || (!placeholder
          && strippedReply.replace(/\s/g, '').length >= 400);
      if (concludeNow) {
        _loopBreadcrumb('conclude-now-shortcircuit', {
          iteration, replyChars: strippedReply.replace(/\s/g, '').length, totalToolCalls,
        });
      }

      // 软交付门抑制判决(重复输出 Flavor A):一个 substantive 答案已流式 + 本轮零工具调用时,7 个软
      // 「你真的做完了吗」交付门不该再驱动一次完整生成(那正是屏幕出现两遍答案的直接成因)。据此给
      // 那 7 个软门各加 `&& !_softRedriveSuppressed`。硬纠错门与 goalStopGate 不在此抑制(由回声断路器
      // 兜底)。门关(KHY_SUPPRESS_SOFT_REDRIVE)→ 恒 false → `&& true` → 逐字节回退。fail-soft。
      let _softRedriveSuppressed = false;
      try {
        _softRedriveSuppressed = _answerEchoGuard.shouldSuppressSoftRedrive(
          { streamed: _sawStreamedText, iterationToolCalls: toolCalls.length, reply: strippedReply, placeholder },
          process.env,
        );
      } catch { _softRedriveSuppressed = false; }

      // 短停自动续写(默认关·截断缓解):弱模型在自然 stop(非 length)处中途断句早停时,可选地追加
      // 一次「接着上文继续把话说完」。与 maxTokensRecovery(管 length 真截断)stopReason 互斥;续写产
      // 新文本、不触发回声断路。单次封顶(_shortStopContinuationUsed)。门关 → 整段跳过,忠实渲染早停。
      if (!concludeNow && !_shortStopContinuationUsed) {
        try {
          if (_shortStopContinuation.shouldContinue(
            { reply: strippedReply, stopReason: aiResult.stopReason, alreadyUsed: _shortStopContinuationUsed },
            process.env,
          )) {
            _shortStopContinuationUsed = true;
            currentMessage = _shortStopContinuation.buildContinuationMessage();
            continue;
          }
        } catch { /* fail-soft:续写缓解绝不反噬主循环 */ }
      }

      // ── 智能体纪律兜底:「说了却没做就收场」跟进回核 ([修复智能体纪律]) ──────
      // 本会话直接证据:khy 读对了文件、定位对了行号,却幻觉「你的指令被截断了」拒绝编辑,
      // 做一半编个理由收场。既有守卫(toolLoopDetector 机械重复 / roundAdvanceAssessor 逐轮观测 /
      // resultGuard 收尾静默截断)都照不到这类**零工具调用的中途放弃**。这里在收尾分支最顶端一次性
      // 回核:动作任务 + 本轮零工具调用 + 非实质交付时,若回复命中「虚构阻碍」或「空头承诺」,强制
      // 再推一轮要它真的发起工具调用(或用具体工具证据证明阻碍真实)。**刻意不看 _harnessProfile.nudges**
      // ——最弱档 nudges 恰为 false,而正是它最需要这条纪律(对标自驱收尾保障「本守卫不看模型档」)。
      // 一次性 + fail-soft + 门控 byte-revert。放在 errorCoverage 之前(最根本:先确保它真动了手)。
      if (_followThroughEnabled && !_followThroughNudgeUsed && actionTask) {
        let _ft = null;
        try {
          _ft = assessFollowThrough({
            reply: strippedReply,
            toolCallCount: toolCalls.length, // === 0 in this branch
            isActionTask: actionTask,
            substantiveDelivery: concludeNow,
          }, process.env);
        } catch { /* fail-soft:回核出错绝不阻断交付 */ }
        if (_ft && _ft.shouldNudge) {
          _followThroughNudgeUsed = true;
          _loopBreadcrumb('nudge-continue', { iteration, nudge: 'followThrough', pattern: _ft.pattern });
          const _ftMsg = buildFollowThroughNudge(_ft.pattern);
          if (_ftMsg) { currentMessage = _ftMsg; continue; }
        }
      }

      // ── 先枚举再修复:错误覆盖回核(确定性兜底)──────────────────────
      // 模型自认完工。用收尾前抽好的错误信号回核:日志里点名的每条错误,有没有哪条
      // 在最终回复(及已落地修改文件名 / 工具入参)里**完全没被提及**。有 → 一次性
      // 精确点名补全提示,让模型补漏修(对应「防遗漏」的代码兜底)。零假阳性:只对带
      // 锚点的强信号回核。一次性 + fail-soft。放在意图回核之前(二者正交、各自一次性)。
      if (_errorEnumEnabled && _harnessProfile.nudges && !_errorCoverageNudgeUsed && _errorSignals.length) {
        let _ecov = null;
        try {
          const _extraCovered = [
            [..._allModifiedFiles].join(' '),
            toolCallLog.map((t) => {
              try { return `${t.tool || t.name || ''} ${JSON.stringify(t.params || {})}`; }
              catch { return String(t.tool || t.name || ''); }
            }).join(' '),
          ].join(' ').slice(0, 4000);
          _ecov = assessErrorCoverage({
            reply: strippedReply,
            signals: _errorSignals,
            extraCoveredText: _extraCovered,
          });
        } catch { /* fail-soft：回核出错绝不阻断交付 */ }
        if (_ecov && _ecov.shouldNudge) {
          _errorCoverageNudgeUsed = true;
          _loopBreadcrumb('nudge-continue', { iteration, nudge: 'errorCoverage', missing: _ecov.missing.length, checked: _ecov.checked });
          const _ecMsg = buildErrorCoverageNudge(_ecov.missing);
          if (_ecMsg) { currentMessage = _ecMsg; continue; }
        }
      }

      // ── 意图接住回核（[答得没接住意图]）─────────────────────────────
      // 模型自认完工（本轮无新工具调用）。用收尾前抽好的高精度锚点回核：用户逐字
      // 点名的诉求里有没有哪个在最终回复（及已落地的修改文件名 / 工具入参）里
      // **完全没被提及**。有 → 一次性精确点名补全提示，让模型补缺口（而非笼统
      // 「再检查一遍」）。放在收尾分支顶端、不挂 concludeNow / totalToolCalls 门：
      // 长回答与纯文本回答恰是既有粗粒度覆盖守卫照不到的盲区。一次性 + 零假阳性
      // 锚点 → 不唠叨。fail-soft：回核出错绝不阻断交付。
      if (_intentCoverageEnabled && _harnessProfile.nudges && !_intentCoverageNudgeUsed && !_softRedriveSuppressed) {
        let _cov = null;
        try {
          const _extraCovered = [
            [..._allModifiedFiles].join(' '),
            toolCallLog.map((t) => {
              try { return `${t.tool || t.name || ''} ${JSON.stringify(t.params || {})}`; }
              catch { return String(t.tool || t.name || ''); }
            }).join(' '),
          ].join(' ').slice(0, 4000);
          _cov = assessIntentCoverage({
            reply: strippedReply,
            rawMessage: originalUserMessage,
            anchors: _intentFrame.detailAnchors,
            tailDetails: _intentFrame.tailDetails,
            extraCoveredText: _extraCovered,
            pathRedosGuard: _intentPathRedosGuard,
          });
        } catch { /* fail-soft：回核出错绝不阻断交付 */ }
        if (_cov && _cov.shouldNudge) {
          _intentCoverageNudgeUsed = true;
          _loopBreadcrumb('nudge-continue', { iteration, nudge: 'intentCoverage', missing: _cov.missing.length, checked: _cov.checked });
          const _icMsg = buildIntentCoverageNudge(_cov.missing);
          if (_icMsg) { currentMessage = _icMsg; continue; }
        }
      }

      // ── A1 主动协助：无工具长回答缺总结 → 主动补一轮 [被动响应→主动协助+被动兜底] ──
      // 痛点：concludeNow 对 >= 400 字的无工具回答短路了所有收尾 nudge，而既有 closure/
      // summary 守卫又全 gated 在 totalToolCalls>0，于是「长篇但没收尾结论」的纯文本回答
      // 被原样交付。这里在定稿前主动检测：缺结论就推一轮（禁用工具）让模型补一句总结。
      // 一次性（_summaryAssistUsed<=1）；补不出再由下方 finalText 处服务端兜底。
      if (totalToolCalls === 0 && _summaryAssistUsed < 1 && !_forceNoToolsNext && !_softRedriveSuppressed) {
        let _summaryVerdict = null;
        try {
          _summaryVerdict = _activeAssist.classifySummary({
            text: strippedReply,
            hadToolCalls: false,
            isInfoRequest: _uphInfoRequestActive,
            alreadyAssisted: _summaryAssistUsed > 0,
          });
        } catch { /* fail-soft：判定出错绝不阻断交付 */ }
        if (_summaryVerdict && _summaryVerdict.assist) {
          _summaryAssistUsed += 1;
          _forceNoToolsNext = true; // 复用 forced-summary 管线：下一轮禁用工具，只要收尾
          _loopBreadcrumb('nudge-continue', {
            iteration, nudge: 'summaryAssist', replyChars: strippedReply.replace(/\s/g, '').length,
          });
          if (onNoToolCall) {
            onNoToolCall(iteration, strippedReply, { summaryAssist: true, autoContinued: true });
          }
          currentMessage = _activeAssist.buildSummaryDirective();
          continue;
        }
      }

      // ── 自驱收尾保障 ([DESIGN-ARCH-050]，与模型档无关) ───────────────
      // 用户痛点：不用提示词推它，有时它就不出结果。根因——既有「你没真正交付」类 nudge 全挂在
      // _harnessProfile.nudges 后面，强模型档默认关闭；于是模型回一句进度前言就收尾，把过程当结果。
      // 本守卫不看模型档：确实干了活（totalToolCalls>0）却只回进度/空壳时，强制再推一轮要最终结果。
      // 一次性，且让位给 concludeNow（实质长回复不打扰）。
      // ── 工具原文回贴检测（「只有过程没有总结」根因之一）──────────────────
      // 模型把工具结果（如 dir 目录清单）原样回贴当「结果」，既没归纳也没结论 →
      // 对用户等同「没总结」。echo 是强信号，独立于 concludeNow 的「长回复即收尾」
      // 短路（一段原样回贴的清单可能超过 400 字符，但它不是实质总结），但仍尊重
      // info-request / 断路器收尾这两条 concludeNow 子条件。
      const _echoesToolOutput = totalToolCalls > 0
        && (_looksLikeToolOutputEcho(strippedReply, toolCallLog)
          || _replyIsUnsynthesizedListing(strippedReply));
      const _closureEligible = !_closureGuardUsed
        && totalToolCalls > 0
        && _capMatrix.isEnabledAt(CAP_SEAMS.EMPTY_TOOLCALLS, 'deliverableClosure', _capCtx())
        && !_uphInfoRequestActive
        && !_circuitBrokenHandled
        && !_softRedriveSuppressed
        && (!concludeNow || _echoesToolOutput);
      if (_closureEligible) {
        try {
          const projectCoherence = require('./projectCoherence');
          const closure = projectCoherence.evaluateClosure({
            reply: strippedReply,
            pendingToolCalls: 0,
            totalToolCalls,
            used: _closureGuardUsed,
            echoOfToolOutput: _echoesToolOutput,
            userMessage: sanitizedUser || userMessage,
          });
          if (closure.shouldForce) {
            _closureGuardUsed = true;
            // 数据已在手里、只是没归纳——下一轮必须直接写总结，禁止再跑工具回贴。
            _forceNoToolsNext = true;
            _loopBreadcrumb('nudge-continue', {
              iteration, nudge: _echoesToolOutput ? 'summaryEcho' : 'deliverableClosure', replyChars: strippedReply.length,
            });
            if (onNoToolCall) {
              onNoToolCall(iteration, strippedReply, { placeholder, actionTask, deliverableClosure: true, autoContinued: true });
            }
            currentMessage = closure.message;
            continue;
          }
        } catch { /* closure guard best-effort — never block delivery on its own errors */ }
      }

      // ── 自驱启动/续作保障 ([DESIGN-ARCH-050] 镜像，与模型档无关，有界+死循环 break) ──
      // 用户原话痛点：「也不要总是半截话我推了动一下否则直接不动」。模型回一句计划前言
      // （"我先看看桌面有什么…" / "…让我用图像识别查看内容"）却没调任何工具就收尾，用户被迫反复手敲「继续」。
      // 旧实现两处不足：① 一次性（_kickoffGuardUsed），触发一次后再卡壳就彻底沉默；
      // ② 仅在 totalToolCalls===0 触发——「干了一半又回前言」的续作缺口无人兜底（closure 守卫也一次性，用尽即失守）。
      // 现改为**有界计数**（KHY_SELF_KICKOFF_MAX，默认 3）+ **同前言签名死循环 break**：
      // 既能在「没开始」和「干了一半又卡」两处持续自驱，又绝不对同一句前言无限重推（防燃 Token）。
      const _kickoffMax = _envIntOr(process.env.KHY_SELF_KICKOFF_MAX, 3);
      if (
        !concludeNow
        && _kickoffGuardCount < _kickoffMax
        && placeholder
        && actionTask
        && !_uphInfoRequestActive
        && !_looksLikeChoiceResponse(strippedReply)
        && !_looksLikeCannedRefusal(strippedReply)
        && _capMatrix.isEnabledAt(CAP_SEAMS.EMPTY_TOOLCALLS, 'selfKickoff', _capCtx())
      ) {
        const _kickoffSig = _responseDebounce.refusalSignature(strippedReply);
        // 同一句前言原样重复 → 模型真卡死在这句话上，停止自推、交还用户，避免无意义死循环。
        const _sameAsLast = _lastKickoffSig !== null && _kickoffSig && _kickoffSig === _lastKickoffSig;
        if (!_sameAsLast) {
          try {
            const projectCoherence = require('./projectCoherence');
            const kickoff = projectCoherence.evaluateKickoff({
              reply: strippedReply,
              pendingToolCalls: 0,
              totalToolCalls,
              allowAfterWork: true, // 「干了一半又回前言」也续推（用户「不要半截话」诉求），closure 用尽后由此兜底
              userMessage: sanitizedUser || userMessage,
            });
            if (kickoff.shouldForce) {
              _kickoffGuardCount += 1;
              _lastKickoffSig = _kickoffSig || _lastKickoffSig;
              _loopBreadcrumb('nudge-continue', { iteration, nudge: 'selfKickoff', round: _kickoffGuardCount, replyChars: strippedReply.length });
              if (onNoToolCall) {
                onNoToolCall(iteration, strippedReply, { placeholder, actionTask, kickoff: true, autoContinued: true });
              }
              currentMessage = kickoff.message;
              continue;
            }
          } catch { /* kickoff guard best-effort — never block delivery on its own errors */ }
        }
      }

      // Nudge 1: 模型列选项而非执行 (一次性)
      if (_harnessProfile.nudges && !concludeNow && !noToolNudgeUsed && _looksLikeChoiceResponse(strippedReply) && actionTask && !_softRedriveSuppressed) {
        noToolNudgeUsed = true;
        _loopBreadcrumb('nudge-continue', { iteration, nudge: 'choiceResponse', replyChars: strippedReply.length });
        if (onNoToolCall) {
          onNoToolCall(iteration, strippedReply, { placeholder: false, actionTask, choiceResponse: true, autoContinued: true });
        }
        currentMessage = _buildChoiceResponseNudge(userMessage);
        continue;
      }

      // Nudge 2: 回复过短且无结论 + 用户请求需要行动 (一次性)
      // 仅在"未执行任何工具"时挑战过短回复——若工具已执行，交付完整性由下方
      // (!placeholder && totalToolCalls > 0) 块处理，简短的收尾确认应被接受。
      if (_harnessProfile.nudges && !concludeNow && !noToolNudgeUsed && actionTask && totalToolCalls === 0 && !_softRedriveSuppressed) {
        const replyClean = strippedReply.replace(/\s/g, '');
        const hasConclusion = /(完成|成功|已整理|已创建|已修改|无需|结果|总结|done|completed|summary|created|modified|finished|result)/i.test(strippedReply);
        if (replyClean.length < 200 && !hasConclusion) {
          noToolNudgeUsed = true;
          _loopBreadcrumb('nudge-continue', { iteration, nudge: 'earlyEndTurn', replyChars: replyClean.length });
          if (onNoToolCall) {
            onNoToolCall(iteration, strippedReply, { placeholder, actionTask, earlyEndTurnChallenge: true, autoContinued: true });
          }
          currentMessage = '[SYSTEM: Your reply is too short and may not have completed the task. Check the original request — if there are remaining steps, call tools now; if truly done, give a complete result summary.]\n\nOriginal request: ' + (sanitizedUser || userMessage);
          continue;
        }
      }

      // Nudge 3: 工具失败后模型短回复放弃，既不换方法也不解释失败 (一次性)
      // 问题 #4/#5: 一种方法失败后既不总结失败原因、也不尝试其他方法。
      // 触发条件——本轮有失败的工具调用、模型本轮未再调工具、回复又短且未承认失败。
      // 推一次系统消息，要求它要么换方法重试、要么明确告知用户失败原因+已尝试的方法。
      if (_harnessProfile.nudges && !concludeNow && !_failureRecoveryNudgeUsed) {
        const _failedCalls = toolCallLog.filter(t => t.success === false && t.denied !== true);
        if (_failedCalls.length > 0) {
          const _replyClean = strippedReply.replace(/\s/g, '');
          const _acknowledgesFailure = /(失败|无法|未能|错误|不存在|没找到|没有.*权限|not found|enoent|failed|error|cannot|unable|permission|denied)/i.test(strippedReply);
          if (_replyClean.length < 200 && !_acknowledgesFailure) {
            _failureRecoveryNudgeUsed = true;
            const _lastFail = _failedCalls[_failedCalls.length - 1];
            const _failTool = _lastFail.tool || _lastFail.name || 'unknown';
            const _failReason = String(_lastFail.error || _lastFail.output || '未知错误').slice(0, 200);
            _loopBreadcrumb('nudge-continue', { iteration, nudge: 'failureRecovery', failedCount: _failedCalls.length });
            if (onNoToolCall) {
              onNoToolCall(iteration, strippedReply, { placeholder, actionTask, failureRecovery: true, autoContinued: true });
            }
            currentMessage = `[SYSTEM] 上一步操作失败：\`${_failTool}\` — ${_failReason}\n`
              + `不要就此停止。请按顺序选择：\n`
              + `1. 先简要说明这次失败的原因（是什么导致的）；\n`
              + `2. 然后尝试用其他方法/工具达成同一目标（换命令、换路径、换检索方式、拆小步骤等）；\n`
              + `3. 只有在确实尝试过且无法完成时，才明确告诉用户失败原因和你已尝试过的方法，并给出可行建议。`;
            continue;
          }
        }
      }

      // Nudge 4: 伪成功拒绝 (一次性) — 问题 #3 根因。
      // 模型本轮已通过工具**成功取回**了实质内容（如 WebSearch/WebFetch 抓到新闻），
      // 却回了一句套话拒绝（「我无法给到相关内容」）。这是自相矛盾：数据已在手里。
      // 推一次系统消息，命令它基于已取回的真实结果直接作答，不得拒绝。
      // 仅当「有成功且带数据的工具调用」且「回复是套话拒绝」时触发，避免误伤诚实失败叙述。
      if (_harnessProfile.nudges && !_pseudoRefusalNudgeUsed && _looksLikeCannedRefusal(strippedReply)) {
        const _succeededWithData = toolCallLog.some((t) => {
          if (!t || t.success !== true) return false;
          const out = t.output != null ? t.output : (t.content != null ? t.content : t.result);
          const s = typeof out === 'string'
            ? out
            : (out != null ? (() => { try { return JSON.stringify(out); } catch { return String(out); } })() : '');
          return s && s.replace(/\s/g, '').length >= 20;
        });
        if (_succeededWithData) {
          _pseudoRefusalNudgeUsed = true;
          // 抗拼接：丢弃这句已流出的套话拒绝废稿，重试的真实回答将替换而非追加其后。
          _emitStreamReset('pseudo-refusal-retry');
          _loopBreadcrumb('nudge-continue', { iteration, nudge: 'pseudoRefusal', replyChars: strippedReply.length });
          if (onNoToolCall) {
            onNoToolCall(iteration, strippedReply, { placeholder, actionTask, pseudoRefusal: true, autoContinued: true });
          }
          currentMessage = '[SYSTEM] 自相矛盾检测：你本轮已经通过工具成功取回了实质内容（见上方工具结果），'
            + '但你的回复却是一句拒绝/免责套话。这是错误的——数据已经在你手里。\n'
            + '请立即基于上方工具已返回的真实结果，完整、直接地回答用户的原始问题，'
            + '不要再说"无法提供""我不能"之类的话。如果结果里确实没有用户要的信息，'
            + '就具体说明工具返回了什么、缺了什么，而不是给一句笼统的拒绝。\n\n'
            + '用户原始请求: ' + (sanitizedUser || userMessage || '').slice(0, 300);
          continue;
        }
      }

      // Nudge 5: 纯套话拒绝保底（问题根因，无工具数据场景）。
      // 模型回了一句模板化拒绝（「你好，我无法给到相关内容」「抱歉，我不能…」）
      // 但本轮**没有**任何成功取回数据的工具调用——上面的伪成功拒绝 nudge 不会
      // 触发，于是这句空拒绝会被原样交付给用户（正是「明明能做/已做却回无法给到」
      // 的可见症状）。这类回复不携带任何可执行信息，也未说明具体原因。
      // 推一次系统消息：要么真去做（调工具），要么给出**具体**原因（缺什么/什么失败了），
      // 严禁笼统拒绝。仅 nudges 开启、且伪成功拒绝路径未接管时触发，一次性。
      if (_harnessProfile.nudges
          && _bareRefusalRetries < _bareRefusalRetryMax
          && !_pseudoRefusalNudgeUsed
          && _looksLikeCannedRefusal(strippedReply)) {
        // ── 缺少的 break：同一句拒绝在 nudge 之后又原样重复 → 立即跳出 ──
        // 归一签名比对上一轮拒绝；相同即「在同一个地方反复跌倒」。再退避重试只会
        // 烧 token 走同一条错误路径，于是放弃重试，落到下方交付/零静默失败归因。
        const _refusalSig = _responseDebounce.refusalSignature(strippedReply);
        if (_lastRefusalSig !== null && _refusalSig && _refusalSig === _lastRefusalSig) {
          _loopBreadcrumb('refusal-repeat-break', {
            iteration, nudge: 'bareRefusal',
            attempt: _bareRefusalRetries, sig: _refusalSig.slice(0, 24),
          });
          // 不 continue：跳出重试，交给后续交付/归因（绝不再重复同一条路径）。
        } else {
          _lastRefusalSig = _refusalSig || _lastRefusalSig;
          const _attemptIdx = _bareRefusalRetries;
          _bareRefusalRetries += 1;
          // 抗拼接：丢弃这句已流出的套话拒绝废稿，重试的真实回答将替换而非追加其后。
          _emitStreamReset('bare-refusal-retry');

          // ── 缺少的检查：该请求是否真有问题？ ──
          // 用户原始请求若是「明显无害的闲聊/常识/创作」（讲笑话、打招呼、推荐…），
          // 且这句拒绝**未说明任何具体原因**（纯模板免责，非诚实的 policy/权限拒绝），
          // 那就是过度泛化的 safety guard 误触发：正路是**直接友好作答**，而不是
          // 「要么调工具、要么给原因」这个根本不覆盖"直接答"的伪二选一。
          const _benignDirect = _responseDebounce.looksLikeBenignConversational(sanitizedUser || userMessage || '')
            && !_refusalStatesConcreteReason(strippedReply);

          _loopBreadcrumb('nudge-continue', {
            iteration, nudge: 'bareRefusal',
            attempt: _bareRefusalRetries, max: _bareRefusalRetryMax,
            replyChars: strippedReply.length, benignDirect: _benignDirect,
          });
          if (onNoToolCall) {
            onNoToolCall(iteration, strippedReply, { placeholder, actionTask, bareRefusal: true, autoContinued: true });
          }
          // 让用户知道在重试（疑似网络波动 / 通道降级），而不是干等。
          if (onToolResult) {
            try {
              onToolResult('_system_retry', {}, { success: true }, iteration, 0,
                `回复为空或无理由拒绝，疑似网络波动，正在重试（${_bareRefusalRetries}/${_bareRefusalRetryMax}）…`);
            } catch { /* non-critical projection */ }
          }
          if (_benignDirect) {
            currentMessage = '[SYSTEM] 你对一个**完全无害**的请求（如讲笑话、打招呼、闲聊、'
              + '推荐、简单常识/创作）回了一句笼统的拒绝/免责套话。这是过度谨慎的误判——'
              + '这个请求没有任何问题，你完全可以、也应该直接回答。\n'
              + '请立刻用自然、友好的语气**直接完成**用户的请求：不要调用任何工具，'
              + '不要拒绝，不要背诵"作为 AI…""我无法提供…"之类的免责声明。\n\n'
              + '用户原始请求: ' + (sanitizedUser || userMessage || '').slice(0, 300);
          } else {
            currentMessage = '[SYSTEM] 你回了一句笼统的拒绝/免责套话（如"无法给到相关内容"），'
              + '但既没有调用任何工具，也没有说明具体原因。这是不允许的。\n'
              + '请按顺序选择其一：\n'
              + '1. 如果这件事其实可以做（打开应用、查询信息、读写文件等），现在就调用相应工具去做；\n'
              + '2. 如果这是无害的闲聊/常识/创作类请求，直接用自然语气回答即可，无需工具也无需拒绝；\n'
              + '3. 如果确实做不了，必须说明**具体原因**——是缺少权限、缺少依赖、找不到目标、'
              + '还是该请求超出能力范围；不要只说"无法提供/我不能"。\n\n'
              + '用户原始请求: ' + (sanitizedUser || userMessage || '').slice(0, 300);
          }
          // 退避后再试：网络波动/通道瞬时降级给上游一点恢复时间。
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, _recoveryDelayMs(_attemptIdx)));
          continue;
        }
      }

      // ── 持久目标 Stop-gate（goal 2026-07-03「让 khy 学会使用 CC 的 goal 模式」）──────────────
      // CC 的 /goal 用会话级 Stop hook 在助手「想停」这一刻按目标条件拦截：未达成 → 阻止停止、朝目标
      // 再驱动；达成 → 自动清除并宣布完成。khy 此前只在每轮**开头**注入提醒（goalCore/goalStore）+
      // 轮次预算（跨轮结构性兜底），缺这道「想停时」的门。本块补上它：作为**最后一道**收尾前的门
      // （置于所有通用 nudge 之后），若当前项目设有活动持久目标且**未确认达成**且单轮再驱动预算未耗尽，
      // 就注入目标专属再驱动指令并 continue（阻止停止，甚至覆盖 concludeNow）；若判**已达成**则自动
      // 清除（KHY_GOAL_AUTO_CLEAR）后放行收尾。判定/文案在纯叶子 goalStopGate；本处只做 IO 落地。
      // 门控 KHY_GOAL_STOP_GATE（嵌套父门控 KHY_GOAL）关 → 整块跳过，行为逐字节回退今日。
      // [AI-弱模型·照抄] 本块是**叶子接线的黄金范例**:判定在纯叶子(goalStopGate)、这里只做 IO
      //   (require 叶子 → isEnabled 门控 → 读活动目标 → 取裁决 → 落地),整块 try/catch fail-soft,
      //   叶子出错绝不阻断主循环。新接线照此形状:别把判定逻辑写进接线处、别漏 try/catch。
      try {
        const _goalStopGate = require('./goalStopGate');
        if (_goalStopGate.isEnabled(process.env)) {
          const _goalStore = require('./goalStore');
          // 与 ai.js 每轮注入同 cwd 口径（process.cwd()）→ 作用域键一致；读取实时反映本轮内可能已发生的 clear。
          const _activeGoal = _goalStore.getActiveGoal(process.cwd());
          if (_activeGoal && _activeGoal.text) {
            const _verdict = _goalStopGate.evaluateGoalStop({
              goal: _activeGoal,
              reply: strippedReply,
              redriveCount: _goalStopRedrives,
              env: process.env,
              userMessage: sanitizedUser || userMessage,
              toolCallLog, // 本轮工具执行记录 → verify-ran 门:声称验证却没真跑过命令则再驱动
            });
            if (_verdict.action === 'clear') {
              // 保守判定目标已达成 → 自动退役（reason=done），放行本轮收尾（模型回复即完成宣告）。
              try { _goalStore.clearGoal({ cwd: process.cwd(), reason: 'done' }); } catch { /* fail-soft */ }
              _loopBreadcrumb('goal-stop-gate', { iteration, action: 'clear' });
            } else if (_verdict.action === 'redrive') {
              // 同一句回复原样重复 → 模型卡死在这句上，停止再推、放行交还用户（防死循环燃 Token）。
              const _goalSig = _responseDebounce.refusalSignature(strippedReply);
              const _sameAsLast = _lastGoalStopSig !== null && _goalSig && _goalSig === _lastGoalStopSig;
              if (!_sameAsLast) {
                _goalStopRedrives += 1;
                _lastGoalStopSig = _goalSig || _lastGoalStopSig;
                _loopBreadcrumb('goal-stop-gate', { iteration, action: 'redrive', round: _goalStopRedrives, replyChars: strippedReply.length });
                if (onNoToolCall) {
                  onNoToolCall(iteration, strippedReply, { placeholder, actionTask, goalStopGate: true, autoContinued: true });
                }
                currentMessage = _verdict.message;
                continue;
              }
            }
          }
        }
      } catch { /* goal stop-gate best-effort — never block delivery on its own errors */ }

      if (onNoToolCall) {
        onNoToolCall(iteration, strippedReply, { placeholder, actionTask, autoContinued: false });
      }
      if (executionPlan && onPlanProgress) {
        for (let i = currentPlanStep; i < executionPlan.steps.length; i++) {
          if (executionPlan.steps[i].status !== 'completed') {
            onPlanProgress(i, 'completed');
          }
        }
      }
      // 如果回复只是进度前言（"让我查看..."），基于实际执行情况给出诊断和建议
      let finalText = strippedReply;
      if (!finalText.trim() && removedConstraintCalls.length > 0) {
        finalText = _buildConstraintFallbackReply(userToolConstraints, removedConstraintCalls);
      }
      // ── A1 被动兜底：模型补总结轮后仍无结论 → 服务端合成一句收尾（一次性）──
      // 反双渲染：buildSummaryFallback 内部已判 hasSynthesizedConclusion，模型自己补了就返回 ''。
      // 仅惠及 CLI / 非流式 / 历史留存；TUI 流式以「模型补一轮」为主机制（见 activeAssist 注释）。
      if (_summaryAssistUsed > 0 && !_summaryFallbackUsed && totalToolCalls === 0) {
        try {
          const _fb = _activeAssist.buildSummaryFallback(finalText);
          if (_fb) { finalText += _fb; _summaryFallbackUsed = true; }
        } catch { /* fail-soft */ }
      }
      if (placeholder && totalToolCalls > 0) {
        const succeeded = toolCallLog.filter(t => t.success === true);
        const failed = toolCallLog.filter(t => t.success === false);
        const denied = toolCallLog.filter(t => t.denied === true);
        const parts = [];

        // 执行摘要
        parts.push(`\n\n---\n**任务未完成** — 已执行 ${totalToolCalls} 次工具调用（${succeeded.length} 成功, ${failed.length} 失败${denied.length ? `, ${denied.length} 被拒绝` : ''}）`);

        // 具体失败原因 —— 真因多在 t.result.data.outputTail(如 build_project
        // exitCode:1 errors:[] 时 stderr 在此),旧逻辑只看 t.error/t.output 会塌缩成
        // 「未知错误」掩盖真相。经 extractToolFailureReason 逐层挖最具体真因。
        if (failed.length > 0) {
          const reasons = failed
            .slice(0, 3)
            .map(t => {
              const honest = extractToolFailureReason(t);
              const reason = honest || String(t.error || t.output || '未知错误');
              return `  - \`${t.tool || t.name || 'unknown'}\`: ${reason.slice(0, 160)}`;
            })
            .join('\n');
          parts.push(`\n**失败原因:**\n${reasons}`);
          // 诊断锚定捕获侧:登记这次工具失败的真因(取第一条 failed 的逐层真因),供下一轮
          // 「为什么报这个错」追问 pin 回上下文。fail-soft,登记失败绝不影响小结输出。
          try {
            const _first = failed[0];
            require('./diagnosticGrounding').recordFailure({
              errorType: (_first && (_first.tool || _first.name)) || 'tool',
              cause: extractToolFailureReason(_first) || String((_first && (_first.error || _first.output)) || ''),
            });
          } catch { /* diagnostic-grounding record best-effort */ }
        }

        // 建议
        const suggestions = [];
        // 错误 → 建议方案的单一真源(errorSolutionAdvisor)。用逐层挖出的真因(而非仅
        // t.error)匹配确定性错误签名,给出具体可执行建议;覆盖面远超既有 3 条内联判断
        // (连接被拒/端口占用/磁盘满/模块缺失/命令未找到/DNS/内存/文件已存在/认证/限流…)。
        // 门控 KHY_ERROR_SOLUTION_ADVISOR 关或无匹配 → 空数组 → 回退到下方既有 3 条内联
        // 建议,逐字节等价。fail-soft:叶子异常不影响小结输出。
        let _advisorSolutions = [];
        try {
          _advisorSolutions = require('./errorSolutionAdvisor').suggestSolutions(
            failed.map(t => extractToolFailureReason(t) || String(t.error || t.output || '')),
            { max: 4 },
          );
        } catch { _advisorSolutions = []; }
        if (_advisorSolutions.length > 0) {
          suggestions.push(..._advisorSolutions);
        } else {
          if (failed.some(t => /permission|denied|拒绝/i.test(String(t.error || '')))) {
            suggestions.push('检查工具权限设置（Shift+Tab 切换权限模式）');
          }
          if (failed.some(t => /not found|ENOENT|不存在/i.test(String(t.error || '')))) {
            suggestions.push('确认目标路径是否正确');
          }
          if (failed.some(t => /timeout|超时/i.test(String(t.error || '')))) {
            suggestions.push('网络或服务可能超时，稍后重试');
          }
        }
        if (succeeded.length > 0 && failed.length === 0) {
          suggestions.push('输入"继续"让 AI 基于已有结果继续执行');
          suggestions.push('更具体地描述下一步操作');
        }
        if (failed.length > 0) {
          suggestions.push('用 `/model` 切换到更强的模型重试');
          suggestions.push('将任务拆分为更小的步骤');
        }
        if (suggestions.length === 0) {
          suggestions.push('重新描述需求或输入"继续"');
        }
        parts.push(`\n**建议:**\n${suggestions.map(s => `  - ${s}`).join('\n')}`);
        finalText += parts.join('');
      } else if (!placeholder && totalToolCalls > 0) {
        // coding mode 验证引导：如果有文件被创建/修改且尚未运行构建/测试，提示验证
        if (!_codingVerifyNudgeUsed && _activatedModes.includes('coding')) {
          const hasFileWrites = toolCallLog.some(t =>
            /^(write|edit|writefile|editfile|create_file|scaffoldfiles)/i.test(String(t.tool || ''))
          );
          const hasRunBuild = toolCallLog.some(t =>
            /^(bash|shell|shellcommand)/i.test(String(t.tool || ''))
            && /\b(build|test|compile|lint|tsc|npm\s+run|yarn|pnpm|cargo\s+build|go\s+build|mvn|gradle)\b/i.test(String(t.params?.command || ''))
          );
          if (hasFileWrites && !hasRunBuild) {
            _codingVerifyNudgeUsed = true;
            _loopBreadcrumb('nudge-continue', { iteration, nudge: 'codingVerify' });
            currentMessage = '[System] 项目文件已创建/修改。请运行构建或测试命令验证代码正确性（如 `npm test`、`npm run build`、`tsc --noEmit` 等），然后总结结果。如果项目没有测试命令，可跳过直接总结。';
            continue;
          }
        }
        // 回复太短且缺少结论性内容 — 要求 AI 补充交付说明
        const replyClean = strippedReply.replace(/\s/g, '');
        const hasConclusion = /(完成|成功|已整理|已创建|已修改|已启动|已打开|已执行|已运行|已验证|已发送|已部署|已安装|无需|不需要|没有.*需要|已经.*整理|看起来.*整洁|桌面.*干净|结果|总结|summary|done|completed|launched|opened|executed|verified|started|no.*needed|already.*clean|organized)/i.test(strippedReply);
        // 结果守卫(A) 有界补一轮：长前言式承诺（>=80，躲过 <80 条件）也触发同一次性 nudge，
        // 复用 _deliveryConclusionNudgeUsed → 天然有界、绝不死循环。门控关 → _rgForwardPromise=false
        // → 条件退回纯 `< 80` 逐字节回退。
        const _rgForwardPromise = !!(
          _resultGuard
          && _resultGuard.resultGuardEnabled(process.env)
          && _resultGuard.looksLikeForwardPromise(strippedReply)
        );
        // 交付结论 nudge 的 tier 门:非 T0 档 `_harnessProfile.nudges` 本就为 true;唯独最弱 T0
        // 档 `nudges:false`,正是最该被推一把合成结论的弱模型却拿不到。子门控 KHY_T0_DELIVERY_NUDGE
        // (默认开)OR 进来,仅对 T0 起效(非 T0 已 true 短路),门控关 → 字节回退。仅作用于本处。
        const _deliveryNudgeOn = !!(
          _harnessProfile.nudges
          || (_resultGuard && _resultGuard.deliveryNudgeForcedForWeakTier(process.env))
        );
        if (_deliveryNudgeOn && !concludeNow && !_deliveryConclusionNudgeUsed && (replyClean.length < 80 || _rgForwardPromise) && !hasConclusion && !_softRedriveSuppressed) {
          _deliveryConclusionNudgeUsed = true;
          _loopBreadcrumb('nudge-continue', { iteration, nudge: _rgForwardPromise && replyClean.length >= 80 ? 'resultGuardDeliver' : 'deliveryConclusion', replyChars: replyClean.length });
          currentMessage = '[System] 请向用户完整说明任务结果：\n1. 你检查/发现了什么（当前状态）\n2. 你执行了什么操作（如果有）\n3. 如果无需操作，明确说明原因（例如：桌面已整洁、文件已分类等）\n4. 最终结论（成功/无需操作/部分完成）';
          continue;
        }
        // ── 交付完整性检查 ─────────────────────────────────────────
        // 模型回复了但可能遗漏了用户请求中的某些要求
        // 提取用户请求中的关键动词/名词，检查回复是否涵盖
        if (_harnessProfile.nudges && !concludeNow && !_deliveryConclusionNudgeUsed && !hasConclusion && totalToolCalls > 0 && actionTask && !_softRedriveSuppressed) {
          const _userWords = (sanitizedUser || userMessage || '')
            .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 2)
            .map(w => w.toLowerCase());
          // 检查用户请求中的实质性关键词是否在回复中被提及(_DELIVERY_NUDGE_STOPWORDS 见文件顶部)
          const _keyWords = _userWords.filter(w => !_DELIVERY_NUDGE_STOPWORDS.has(w) && w.length >= 2);
          if (_keyWords.length >= 3) {
            const _replyLower = strippedReply.toLowerCase();
            const _covered = _keyWords.filter(w => _replyLower.includes(w)).length;
            const _coverage = _covered / _keyWords.length;
            // 低于 30% 的关键词覆盖率 → 模型可能跑偏了
            if (_coverage < 0.3 && replyClean.length < 300) {
              _deliveryConclusionNudgeUsed = true;
              _loopBreadcrumb('nudge-continue', { iteration, nudge: 'completenessCoverage', coverage: Number(_coverage.toFixed(2)), replyChars: replyClean.length });
              currentMessage = `[SYSTEM: 你的回复可能未完全覆盖用户的请求。用户原始需求: "${(sanitizedUser || userMessage || '').slice(0, 200)}"。请检查是否有遗漏的步骤，如有请继续执行；如果确实已全部完成，请明确说明完成了哪些内容。]`;
              continue;
            }
          }
        }

        // 问题 #4 保底：模型结束了，但本轮存在失败的工具调用且回复完全没提及。
        // 上面的失败恢复 nudge (Nudge 3) 已用尽 / 未触发时，至少向用户透明地附上
        // 失败原因，避免"只有输出没有失败说明"。模型已自己解释失败时不重复追加。
        //
        // 注意：工具结果的成败权威字段是 entry.result.success（执行路径统一写在
        // result 里），早期实现误读 entry.success（恒为 undefined）导致此保底从不
        // 触发——正是「工具全失败却无任何反馈」的隐性根因。这里以 result 优先、
        // 顶层兜底的方式统一判定（与 cli/repl.js 的成败口径一致）。
        {
          const _entryFailed = (t) => {
            if (!t) return false;
            if (t.denied === true) return false;
            if (typeof t.result?.success === 'boolean') return t.result.success === false;
            if (typeof t.success === 'boolean') return t.success === false;
            return false;
          };
          const _entryErrText = (t) => String(
            t.result?.error || t.error || t.result?.output || t.output || '未知错误'
          ).slice(0, 120);
          const _failedSilent = toolCallLog.filter(_entryFailed);
          const _ackFail = /(失败|无法|未能|错误|不存在|没找到|not found|enoent|failed|error|cannot|unable)/i.test(strippedReply);
          if (_failedSilent.length > 0 && !_ackFail) {
            const _lines = _failedSilent
              .slice(0, 3)
              .map(t => `  - \`${t.tool || t.name || 'unknown'}\`: ${_entryErrText(t)}`)
              .join('\n');
            finalText += `\n\n---\n**⚠ 部分操作未成功**（${_failedSilent.length} 项失败）:\n${_lines}\n如需我换一种方法重试，请告诉我。`;
          }
        }
        // 交付摘要：优先使用模型自己写的结论散文。只有当模型没有给出有效结尾
        // （去空白后过短，说明它只回了进度前言或被强制工具压成空）时，才用
        // 模板化的统计摘要兜底，避免「### 完成摘要 / 统计 N 次调用」顶替真正的总结。
        if (toolCallLog.length > 0) {
          // 刀110：会话代码改动账本(对齐 CC /cost "Total code changes")。幂等——
          // 经 codeChangeStats.collectUncountedChurn 只计尚未打标的成功 Edit/Write 条目
          // 并回打 `_khyChurnCounted` 标记,故本块无论每轮跑几次(循环内/终止交付分支)都
          // 不重复计数。门控 KHY_CODE_CHANGES 关 → 短路不采集。fail-soft:绝不影响交付。
          try {
            const _ccs = require('./codeChangeStats');
            if (_ccs.codeChangesEnabled(process.env)) {
              const _churn = _ccs.collectUncountedChurn(toolCallLog);
              if (_churn && (_churn.added > 0 || _churn.removed > 0)) {
                require('./tokenUsageService').recordCodeChange(_churn.added, _churn.removed);
              }
              if (_churn && Array.isArray(_churn.counted)) {
                for (const _e of _churn.counted) {
                  try { _e._khyChurnCounted = true; } catch { /* frozen entry → skip */ }
                }
              }
            }
          } catch { /* fail-soft:代码改动账本绝不影响主流程 */ }
          // 交付摘要判据收敛到结果守卫：门控关 → 逐字节等价历史 `去空白 >= 40 → 视为已写结论`；
          // 门控开 → 用真结论判据（_looksLikeDeliveryConclusion 单一真源），不再被长前言式承诺骗过。
          const _hasDeliveredConclusion = _looksLikeDeliveryConclusion(finalText);
          const _appendSummary = _resultGuard
            ? _resultGuard.shouldAppendDeliverySummary(
                { finalText, hasDeliveredConclusion: _hasDeliveredConclusion },
                process.env,
              )
            : String(finalText || '').replace(/\s/g, '').length < 40;
          if (_appendSummary) {
            finalText += _buildDeliverySummary(toolCallLog);
          }
        }
      }
      // ── 结果守卫(C)：执行了工具但只给「承诺式前言」未交付结论 → 绝不静默，附诚实收尾（一次/轮）。
      // 放在 placeholder 与 !placeholder 两分支收尾汇合之后，一处覆盖二者。门控关 → assessClosure
      // 恒 unfinished:false + buildClosureNotice 恒 '' → 逐字节回退历史。fail-soft：守卫绝不阻断交付。
      if (_resultGuard && !_resultGuardNoticeUsed && totalToolCalls > 0) {
        try {
          const _closure = _resultGuard.assessClosure(
            {
              totalToolCalls,
              hasDeliveredConclusion: _looksLikeDeliveryConclusion(finalText),
              finalText,
            },
            process.env,
          );
          if (_closure.unfinished) {
            const _notice = _resultGuard.buildClosureNotice(
              { totalToolCalls, reason: _closure.reason },
              process.env,
            );
            if (_notice) {
              finalText += _notice;
              _resultGuardNoticeUsed = true;
              _loopBreadcrumb('result-guard', { iteration, reason: _closure.reason, totalToolCalls });
            }
          }
        } catch { /* fail-soft：守卫绝不阻断交付 */ }
      }
      // ── Verification gate ceiling annotation ──────────────────────
      // The gate ran out of retries while still FAILing — be honest about it
      // rather than presenting an unverified result as done.
      if (_verifyGateExhausted) {
        finalText += '\n\n> ⚠ 验证未通过，已达重试上限（KHY_VERIFY_MAX_ROUNDS）。以上结果可能仍有问题，请人工复核。';
      }
      if (_coherenceGateExhausted) {
        finalText += '\n\n> ⚠ 项目整体一致性未达标，已达重试上限（KHY_PROJECT_COHERENCE_ROUNDS）。文件聚合后可能仍有导入断链/入口失配，请人工复核装配。';
      }
      // ── Synthetic Tool Layer: intercept for low-tier models ───────
      if (_harnessProfile.syntheticTools
          && _syntheticLayer?.isEnabled()
          && _syntheticLayer.shouldActivate({
            isLowTierModel: effectiveChatOpts._isLowTierModel,
            adapter: effectiveChatOpts.adapter || options?.adapter,
          })
          && totalToolCalls === 0) {
        try {
          const synAction = _syntheticLayer.detectSyntheticAction(finalText, {
            userMessage: originalUserMessage,
            cwd: process.env.KHYQUANT_CWD || process.cwd(),
          });
          if (synAction && synAction.confidence >= 0.6) {
            const synResult = await _syntheticLayer.executeSyntheticAction(synAction, {
              sessionId: traceSessionId,
              traceId: diagTraceId,
              cwd: process.env.KHYQUANT_CWD || process.cwd(),
            });
            finalText = _syntheticLayer.formatWithSyntheticAction(finalText, synResult, synAction);
            toolCallLog.push({
              tool: synAction.toolName,
              params: synAction.toolParams,
              success: synResult.success,
              synthetic: true,
              iteration,
            });
          }
        } catch (synErr) {
          // Non-critical: synthetic layer failure should not block delivery
          try { diagnostics?.log?.('warn', 'synthetic-tool-layer-error', { error: synErr.message }); } catch { /* ignore */ }
        }
      }

      // ── 拒绝必带具体原因：零静默失败终保底（DESIGN-ARCH-028）────────────
      // 不变式：一句**笼统、无具体原因**的拒绝/免责套话（「你好，我无法给到相关
      // 内容。」「抱歉，我不能。」）绝不被原样静默交付——必须补上「为什么 + 下一步」。
      //
      // 关键修复（历史 bug）：此前该保底**挂在一次性 nudge 标志**（_pseudoRefusalNudgeUsed
      // / 旧的 _bareRefusalNudgeUsed，现为有界计数 _bareRefusalRetries）之后，而那些 nudge
      // 又只在 _harnessProfile.nudges 开启时才会触发。于是任何「nudge 档位关闭」或
      // 「单轮直接收尾、nudge 未触发」的路径，
      // 都会让空拒绝穿透，用户看到的就是反复一句「无法给到相关内容」却毫无原因。现在
      // 保底改为在收尾**唯一出口**无条件生效，与 nudge 档位/是否已触发完全解耦——这才是
      // 「零静默失败」该有的层级（nudge 是「尝试自纠」，保底是「绝不泄漏」，两层独立）。
      //
      // 两道护栏避免误伤：
      //   1) _looksLikeCannedRefusal —— 只抓模板化套话（长度 < 600，匹配免责句式）；
      //   2) !_refusalStatesConcreteReason —— 若拒绝已自带具体原因（权限/依赖/找不到/
      //      网络/超时，或有害/违法/隐私等安全原因，或「因为/由于」连接词），视为**诚实
      //      拒绝**，原样放行、不追加。
      // 再按「本轮是否已取回数据」分流归因（伪成功拒绝 vs 纯空拒绝）。fail-soft：归因绝不抛。
      // ── 前缀残留套话拒绝剥离（抗拼接，文本侧根因）─────────────────────
      // 弱模型通道有时把一句无理由套话拒绝**拼在真实回答前面**：
      //   "你好，我无法给到相关内容。哈哈，好的！讲个短笑话：……"
      // 当回复以一句（或数句）无具体原因的套话拒绝开头、但紧跟有实质内容时，
      // 剥掉这段前缀残留，把真实回答还给用户。只在确有后文时剥；整段就是一句拒绝
      // 时原样保留，交给下方零静默失败归因。复用 toolUseLoop 私有判别式作单一真源。
      try {
        const _debounced = _responseDebounce.stripLeadingRefusal(finalText, {
          isCanned: _looksLikeCannedRefusal,
          statesReason: _refusalStatesConcreteReason,
        });
        if (_debounced.stripped) {
          finalText = _debounced.text;
          _loopBreadcrumb('leading-refusal-stripped', {
            iteration, removedChars: _debounced.removed.length, keptChars: finalText.length,
          });
        }
      } catch { /* fail-soft：剥离绝不阻断交付 */ }

      let _pseudoRefusalAttribution;
      let _bareRefusalAttribution;
      if (_looksLikeCannedRefusal(finalText) && !_refusalStatesConcreteReason(finalText)) {
        const _okData = toolCallLog.filter((t) => {
          if (!t || t.success !== true) return false;
          const out = t.output != null ? t.output : (t.content != null ? t.content : t.result);
          const s = typeof out === 'string'
            ? out
            : (out != null ? (() => { try { return JSON.stringify(out); } catch { return String(out); } })() : '');
          return s && s.replace(/\s/g, '').length >= 20;
        });
        if (_okData.length > 0) {
          // 伪成功拒绝：数据已就绪却仍拒绝（自相矛盾）。
          try {
            _pseudoRefusalAttribution = require('./failsafe').classify(
              { errorType: 'pseudo_refusal', finish_reason: 'refusal', model: aiResult?.model },
              { kind: 'llm', model: aiResult?.model },
            );
          } catch { _pseudoRefusalAttribution = null; }
          const _okTools = _okData
            .slice(0, 3)
            .map(t => `\`${t.tool || t.name || 'unknown'}\``)
            .join('、');
          finalText += `\n\n---\n**⚠ 自相矛盾的拒绝（已记录为待改进项）**\n`
            + `本轮 ${_okData.length} 个工具调用已成功取回数据（${_okTools}），`
            + `但模型最终仍回复了拒绝/免责套话。这是一次「伪成功拒绝」缺陷：数据已就绪却未被用于作答。\n`
            + `请重试，或输入"继续"让我基于上方已取回的结果重新整理答案。`;
          _loopBreadcrumb('pseudo-refusal-attributed', {
            iteration, okToolCount: _okData.length,
            error_code: _pseudoRefusalAttribution?.error_code || 'E02',
          });
        } else {
          // 纯套话拒绝：无数据、无具体原因。
          try {
            _bareRefusalAttribution = require('./failsafe').classify(
              { errorType: 'bare_refusal', finish_reason: 'refusal', model: aiResult?.model },
              { kind: 'llm', model: aiResult?.model },
            );
          } catch { _bareRefusalAttribution = null; }
          finalText += `\n\n---\n**⚠ 这是一句没有具体原因的拒绝（已记录为待改进项）**\n`
            + `模型未调用任何工具、也未说明究竟缺什么（权限 / 依赖 / 目标不存在 / 超出能力范围），`
            + `只回了一句笼统的"无法给到"。这通常意味着上游模型通道降级或被无关上下文带偏，`
            + `而不是这件事真的做不了。\n`
            + `请重试，或把请求说得更具体一点；如果是打开应用 / 查询 / 读写文件这类操作，`
            + `直接再说一次"打开 XXX / 查 XXX"，我会调用相应工具去做。`;
          _loopBreadcrumb('bare-refusal-attributed', {
            iteration,
            error_code: _bareRefusalAttribution?.error_code || 'E02',
          });
        }
      }

      // 完成时审计→修复闭环的透明标注：把遗留的严重/高问题（或「已自动修复并通过
      // 重审」）追加到交付末尾。经下方 _terminalNotice 机制随流式路径补渲，确保必达
      // 用户。无遗留/首轮即干净时 buildAnnotation 返回空串，不产生噪音。
      if (_auditFixAnnotation && !finalText.includes(_auditFixAnnotation)) {
        finalText += _auditFixAnnotation;
      }

      _loopBreadcrumb('conclude', {
        iteration, totalToolCalls,
        finalChars: String(finalText || '').trim().length,
        placeholder,
      });
      _emitDeliveryFinalEvent(traceAudit, traceSessionId, diagTraceId, requestId, {
        requestId,
        success: true,
        totalToolCalls,
        finalReplyLength: String(finalText || '').trim().length,
        hasConclusion: _looksLikeDeliveryConclusion(finalText),
        placeholderOnly: placeholder,
      });
      // Hook: Stop — 让 hook 否决"自然停机"。Stop hook 每次都会触发（便于
      // 纯观测/遥测 hook 收到收尾事件），但 stopHookActive 一次性闸门确保其
      // "续跑"否决最多被采纳一次（CC 不变式），叠加 budget 上限，结构上不可能
      // 无限续跑。已置位后透传 stopHookActive 让 hook 自行知悉应放行。
      if (hookSys) {
        let stopHr;
        try {
          stopHr = await hookSys.trigger('Stop', {
            reply: finalText, iteration, totalToolCalls, stopHookActive: _stopHookActive,
          });
        } catch { /* non-critical */ }
        if (stopHr && stopHr.blocked && !_stopHookActive) {
          _stopHookActive = true;
          _loopBreadcrumb('stop-hook-continue', { iteration, reason: stopHr.reason });
          currentMessage = stopHr.reason
            ? `[Stop hook] ${stopHr.reason}`
            : '[Stop hook requested continuation — keep working until the task is complete.]';
          continue;
        }
      }
      // 不轻信模型自报（KHY_ANSWER_VERIFIER 默认开）：把模型实际写出的可证伪声称
      // ——算式真值(精确有理数复核) + 动作声称(与本次工具日志对账)——用确定性代码
      // 复核,被证伪处如实追加到交付末尾。对所有模型(含本地)都跑。APPEND(非 prepend)
      // 以便经下方 _terminalNotice 机制必达用户;以 VERIFY_MARKER 去重;fail-soft 绝不
      // 阻断交付。门控关 → 返回 null → finalText 逐字节不变。
      try {
        const _av = require('./answerVerifier');
        if (_av.isEnabled(process.env) && !String(finalText || '').includes(_av.VERIFY_MARKER)) {
          const _verdict = _av.verifyAnswer({
            answer: finalText, toolCallLog, actions: true, env: process.env,
          });
          if (_verdict && _verdict.note) finalText += _verdict.note;
        }
      } catch { /* fail-soft：复核是附加证据,出错绝不阻断交付 */ }
      // 零静默失败保底（DESIGN-ARCH-028）：finalText 中，模型散文之外被服务端
      // 合成追加的「终端通知」（失败摘要 / 交付摘要 / 验证封顶注记）不会经过
      // token 流。CLI 在发生流式渲染后只 flush 流缓冲、不再重渲 finalResponse，
      // 这些追加内容会被静默丢弃。单独回传该尾巴，供 CLI 在流式路径下补渲，
      // 确保「失败说明必达用户」。模型散文之外为空时尾巴即为空，不产生重复。
      let _terminalNotice = '';
      {
        const _prose = String(strippedReply || '');
        const _ft = String(finalText || '');
        if (_ft && _ft !== _prose) {
          if (_prose && _ft.startsWith(_prose)) _terminalNotice = _ft.slice(_prose.length);
          else if (!_prose) _terminalNotice = _ft;
        }
      }
      return {
        finalResponse: finalText,
        terminalNotice: _terminalNotice,
        toolCallLog,
        iterations: iteration,
        provider: aiResult.provider,
        tokenUsage: aiResult.tokenUsage,
        effort: aiResult.effort,
        toolSummary: aiResult.toolSummary || undefined,
        conversationMessages,
        harnessProfile: _harnessProfile,
        ...(_lastCapabilityRoute ? { capabilityRoute: _serializeCapRoute(_lastCapabilityRoute) } : {}),
        ...(_pseudoRefusalAttribution
          ? { error_code: _pseudoRefusalAttribution.error_code, attribution: _pseudoRefusalAttribution, pseudoRefusal: true }
          : {}),
        // 断线惯性 · 无感衔接成功收口：本轮(或之前)曾被瞬断、由惯性完成已下达步骤并自动
        // 续接到这次正常答案。数据契约,供 UI/程序消费;成功路径不污染模型散文。
        ...(_inertia && _inertiaEvents.length ? { inertia: _inertia.summarizeInertia(_inertiaEvents) } : {}),
        // Bug 哨兵主动呈现:本回合若累积了静默吞咽 / 不变量违反 / 滑窗越阈值预警,把快照
        // 挂到返回契约,使主动发现的 bug 浮到顶层而非埋在日志(被动兜底:无信号时不挂)。
        ...(_bugSentinel && _bugSentinel.hasSignal() ? { sentinel: _bugSentinel.snapshot() } : {}),
        // 开发过程在途纠偏:本任务若曾浮出过航向提示(回归/未验证churn/反复改/连续失败),
        // 把摘要挂到返回契约,供 UI/程序复盘(被动兜底:无纠偏时不挂、零噪音)。
        ...(_courseMonitor && _courseMonitor.hasCorrections(_courseState) ? { courseCorrections: _courseMonitor.summarize(_courseState) } : {}),
        ...(_adaptiveExec && _adaptiveExec.hasNudges(_reflectState) ? { adaptiveReflection: _adaptiveExec.summarize(_reflectState) } : {}),
        // 防 bug 误判:本任务若曾浮出过复现先行告诫(幻想 bug 无复现 / 改未覆盖源码 / 静默行为漂移),
        // 把摘要挂到返回契约;并把守卫状态 _fpfState 透传给 harness 收口做分档裁决(被动兜底:无信号不挂)。
        ...(_fpfGuard && _fpfState && _fpfGuard.hasFindings(_fpfState) ? { falsePositiveFix: _fpfGuard.summarize(_fpfState) } : {}),
        ...(_fpfState ? { _fpfState } : {}),
        // 重复请求轮次:本回合若识别出是同一请求的第 N(≥2)轮重复,把轮次挂到返回契约,
        // 供 UI/程序观测(被动兜底:首轮不挂、零噪音)。
        ...(_promptRound > 1 ? { promptRound: _promptRound } : {}),
      };
    }

    // 3a. Preflight permission batch check (first iteration, 2+ tools)
    if (iteration === 1 && toolCalls.length >= 2 && process.env.KHY_PREFLIGHT !== 'false' && !preflightApproved) {
      try {
        const { runPreflight } = require('./preflightPermission');
        // Pass the host channel: under the Ink TUI (onControlRequest present) the
        // classic raw-mode batch dialog is skipped and approval is handled per-tool
        // via the Ink PermissionsPrompt, avoiding cooked-mode terminal corruption.
        const pfResult = await runPreflight(toolCalls, { onControlRequest });
        preflightApproved = pfResult.approved;

        // Set preflight context in toolCalling so individual requestPermission() checks it
        try {
          const toolCalling = require('./toolCalling');
          toolCalling.setPreflightContext(preflightApproved);
        } catch { /* non-critical */ }

        // If all tools denied, stop early
        if (pfResult.denied.size > 0 && pfResult.approved.size === 0) {
          return {
            finalResponse: _stripToolCalls(aiResult.reply) + `\n\n${chalk.yellow('⚠ All tools denied in preflight check, stopping.')}`,
            toolCallLog,
            iterations: iteration,
            provider: aiResult.provider,
            stopped: true,
          };
        }
      } catch { /* preflight not available — continue with individual approval */ }
    }

    // 4. Execute tool calls — parallel for concurrency-safe, sequential for rest
    const toolResults = [];

    // ── Feature-gated ToolExecutionEngine (Phase 4B) ──
    // When KHY_USE_EXEC_ENGINE=true, delegate to the unified engine.
    // The engine handles: classification, dedup, hooks, loop detection,
    // shell safety, platform rewrite, recovery, diagnostics — all 13 stages.
    const { isEngineEnabled, ToolExecutionEngine } = require('./toolExecutionEngine');
    if (isEngineEnabled()) {
      const engine = new ToolExecutionEngine({
        hookSystem: hookSys,
        loopDetector,
        traceAudit,
        execApproval: _execApproval,
        executedCallKeys,
        fileReadHashes,
        traceSessionId,
        diagTraceId,
        requestId,
        userMessage: originalUserMessage,
        iteration,
        onToolCall,
        onToolResult,
        onControlRequest,
      });

      if (onParallelBatch) {
        // Notify if there are parallel-eligible calls
        const safeCalls = toolCalls.filter(c => !c.legacy);
        if (safeCalls.length >= 2) onParallelBatch(safeCalls, iteration);
      }

      const engineResults = await engine.executeBatch(toolCalls);
      totalToolCalls += engineResults.length;

      for (const er of engineResults) {
        toolResults.push(er);
        toolCallLog.push({ iteration, tool: er.tool, params: er.params, result: er.result, elapsed: er.elapsed || 0 });

        // Auto-verify: write_file failed → read file to check state
        if (er.result && !er.result.success && (er.tool === 'write_file' || er.tool === 'writeFile') && er.params?.path) {
          try {
            const toolCalling = require('./toolCalling');
            const verifyResult = await toolCalling.executeTool('read_file', { path: er.params.path });
            if (verifyResult && verifyResult.success) {
              toolResults.push({ tool: 'read_file', params: { path: er.params.path }, result: verifyResult, elapsed: 0, _autoVerify: true });
              toolCallLog.push({ iteration, tool: 'read_file', params: { path: er.params.path }, result: verifyResult, elapsed: 0, _autoVerify: true });
            }
          } catch { /* best-effort */ }
        }

        // Auto-recovery: editFile failed → inject hint + auto-read
        if (er.result && !er.result.success &&
            (er.tool === 'editFile' || er.tool === 'edit_file' || er.tool === 'edit')) {
          const errMsg = String(er.result.error?.message || er.result.error || '');
          const filePath = er.params?.file_path || er.params?.filePath || er.params?.path;
          let hint = '';
          if (errMsg.includes('not found in'))
            hint = `Edit failed: old_string was not found in the file. Use read_file to see the current content of ${filePath || 'the file'}, then retry with the exact text.`;
          else if (/appears.*times/.test(errMsg))
            hint = 'Edit failed: old_string matches multiple locations. Include more surrounding context lines in old_string to make it unique, or use replace_all: true.';
          else if (errMsg.includes('ENOENT') || errMsg.includes('File not found'))
            hint = `Edit failed: file ${filePath || ''} does not exist. Check the path with glob, then retry.`;
          if (hint) er.result.hint = hint;
          if (errMsg.includes('not found in') && filePath) {
            try {
              const toolCalling = require('./toolCalling');
              const vr = await toolCalling.executeTool('read_file', { path: filePath });
              if (vr && vr.success) {
                toolResults.push({ tool: 'read_file', params: { path: filePath }, result: vr, elapsed: 0, _autoVerify: true });
                toolCallLog.push({ iteration, tool: 'read_file', params: { path: filePath }, result: vr, elapsed: 0, _autoVerify: true });
              }
            } catch { /* best-effort */ }
          }
        }

        // Update content-fingerprint after successful edit/write
        if (er.result?.success && /^(editFile|edit_file|edit|write_file|writeFile)$/i.test(er.tool)) {
          const fp = er.params?.file_path || er.params?.filePath || er.params?.path;
          if (fp) {
            try {
              const abs = path.resolve(process.env.KHYQUANT_CWD || process.cwd(), fp);
              const hash = _fileContentHash(abs);
              if (hash) fileReadHashes.set(abs, { hash, mtime: null, size: null });
            } catch { /* best-effort */ }
          }
        }

        // If user denied the tool, try other methods first; only stop (with an
        // honest required-permission message) once alternatives are exhausted.
        if (er.result && er.result.denied) {
          const _df = _handleDenyFallback(er.tool, er.params, er.result);
          if (_df.stop) {
            return {
              finalResponse: _stripToolCalls(aiResult.reply) + `\n\n${_df.message != null ? _df.message : chalk.yellow('⚠ Tool execution denied by user, stopping.')}`,
              toolCallLog,
              iterations: iteration,
              provider: aiResult.provider,
              stopped: true,
            };
          }
          // _df.stop === false: 引导已注入 er.result.hint, 不 return, 继续循环让模型换方法。
        }

        // Execution plan progress tracking
        if (executionPlan && executionPlan.steps.length > 0 && onPlanProgress) {
          const stepIdx = _matchToolCallToStep(er.tool, er.params, executionPlan);
          if (stepIdx >= 0) {
            const status = er.result?.success ? 'completed' : 'failed';
            onPlanProgress(stepIdx, status);
            executionPlan.steps[stepIdx].status = status;
            if (status === 'completed' && stepIdx >= currentPlanStep) {
              currentPlanStep = stepIdx + 1;
              if (currentPlanStep < executionPlan.steps.length) {
                onPlanProgress(currentPlanStep, 'in_progress');
              }
            }
          }
        }
      }
      // s04: 引擎内 PostToolUse 若请求优雅停机，把标志冒泡回主循环，
      // 由 while 顶部的早退 return 干净收尾（与默认路径同形态）。
      if (engine._hookStopRequested) {
        _hookStopRequested = true;
        _hookStopReason = engine._hookStopReason || '';
      }
    } else {
    // ── Order-preserving batched execution (s02) ──
    // Replaces the old "all-parallel-then-all-sequential" split (which reordered
    // tool calls relative to how the model emitted them) with contiguous
    // concurrency-safe batching, mirroring CC's partitionToolCalls. Runs of
    // concurrency-safe calls become one parallel batch; each unsafe call is
    // isolated into its own serial batch. Batch order follows the original call
    // order, so a serial call (e.g. `rm`) always executes between the safe calls
    // that precede and follow it: [readA, readB, rm, readC] →
    // [parallel(A,B), serial(rm), parallel(C)].
    //
    // Concurrency-safety is resolved through the registry with name-variant
    // expansion (resolveConcurrencySafe), so shell/bash aliases recover their
    // content-aware verdict (bash "ls" → safe, bash "rm" → unsafe) that a bare
    // registry.get('shell_command') would miss.
    let toolRegistry;
    try { toolRegistry = require('../tools'); } catch { toolRegistry = null; }

    const { partitionIntoBatches } = require('./toolExecutionEngine');
    const _execBatches = partitionIntoBatches(toolCalls, toolRegistry, effectiveChatOpts?.cwd);

    // Halt flag: circuit-breaker / interrupt / session-abort stop all remaining batches.
    let _haltBatches = false;

    for (const _batch of _execBatches) {
      // Interrupt / session-abort between batches stops all remaining tool work.
      if (_haltBatches) break;
      if (interruptSignal && interruptSignal.interrupted) break;
      if (parentAbort && parentAbort.signal.aborted) break;

      // Reuse the existing parallel/sequential execution bodies unchanged by
      // feeding them this batch's calls. A single-element parallel batch falls
      // through to the sequential body (one safe call), which is correct.
      const parallelCalls = _batch.parallel ? _batch.calls.slice() : [];
      const sequentialCalls = _batch.parallel ? [] : _batch.calls.slice();

    // Execute parallel calls via toolCalling.executeTool (includes permission system)
    if (parallelCalls.length >= 2) {
      if (onParallelBatch) onParallelBatch(parallelCalls, iteration);
      const toolCalling = require('./toolCalling');
      const _executeOneParallel = async (call) => {
        totalToolCalls++;
        if (!call._toolUseId) call._toolUseId = `loop_${Math.random().toString(36).slice(2, 10)}`;
        if (onToolCall) {
          const _callCtx = onToolCall(call.name, call.params, iteration, call._toolUseId || null);
          if (_callCtx && typeof _callCtx === 'object') {
            call._traceContext = { ...(call._traceContext || {}), ..._callCtx };
          }
        }

        // Hook: PreToolUse — allow hooks to block or modify params
        if (hookSys) {
          try {
            const hr = await hookSys.trigger('PreToolUse', { toolName: call.name, params: call.params, iteration, _fileReadHashes: fileReadHashes });
            if (hr.blocked) {
              // Soft guards flag the block as approvable → offer a single user
              // approval instead of a hard failure. Approval stamps EXEC_APPROVED
              // so Stage 7 does not re-prompt; denial / no channel keeps the block.
              let _released = false;
              if (hr.approvable && typeof onControlRequest === 'function') {
                try {
                  const { requestGuardApproval } = require('./guardApproval');
                  const verdict = await requestGuardApproval({
                    toolName: call.name, params: call.params,
                    reason: hr.reason, source: hr.source, onControlRequest,
                  });
                  if (verdict.allowed) { call.params = verdict.params; _released = true; }
                } catch { /* fall through to block */ }
              }
              if (!_released) {
                const result = { success: false, error: `[Hook] ${hr.reason || 'Blocked by PreToolUse hook'}` };
                if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
                return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
              }
            }
            if (hr.context?.params) call.params = hr.context.params;
            // Idempotency stamp: PreToolUse already ran (and passed) here, so
            // executeTool's PreToolUse hard bottom skips re-running the same hooks
            // for this loop-driven call. Callers that bypass this loop carry no
            // stamp and therefore still get hooks run inside executeTool.
            try {
              const { HOOKS_EVALUATED } = require('./execApproval');
              // Stamp is intentionally ENUMERABLE: executeTool normalizes params
              // via a `{...params}` spread, which copies enumerable own symbols
              // but drops non-enumerable ones — so the idempotency marker must be
              // enumerable to survive into the funnel's alreadyHooked check.
              if (HOOKS_EVALUATED && call.params && typeof call.params === 'object') call.params[HOOKS_EVALUATED] = true;
            } catch { /* execApproval optional */ }
          } catch { /* hook failure should not block tool execution */ }
        }

        // Cross-turn repeat guard: BEFORE the in-turn detector. If this call
        // byte-matches one that already succeeded in recent conversation turns,
        // steer the model to answer from the existing result (or switch approach)
        // instead of silently re-running it and salvage-dumping again. Fail-soft.
        try {
          const _ctr = crossTurnRepeatDecision(call, _recentToolSigs, _crossTurnSteer, process.env);
          if (_ctr.steer) {
            const result = { success: false, _crossTurnSteer: true, _loopDetected: true, error: _ctr.message, _displayHint: _ctr.displayHint };
            if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
            return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
          }
        } catch { /* cross-turn guard is best-effort; never block execution */ }

        // Loop detection: check before executing
        if (loopDetector) {
          const detection = loopDetector.check(call.name, call.params);
          if (detection.stuck && (detection.level === 'circuit_breaker' || detection.level === 'critical')) {
            if (detection.level === 'circuit_breaker') _circuitBroken = true; // force a tools-free closing turn after this batch
            const result = { success: false, error: `[LoopDetector:${detection.detector}] ${detection.message}\n\n[STOP] 你已经多次尝试相同的操作且没有进展。不要再重试。请直接用已有信息回答用户问题，或坦诚告知无法完成。`, _loopDetected: true };
            if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
            return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
          }
          if (detection.level === 'warning' && detection.message) {
            // Attach warning to result so it appears in tool result message
            call._loopWarning = detection.message;
          }
        }

        // Dedup: skip tool calls already executed with identical params (success or failure)
        // ToolCallGuardrail（借鉴 Hermes Agent）: 区分 idempotent/mutating 分级响应
        //
        // Read-only tools exemption (对标 DeepSeek-TUI/Hermes):
        //   - read_file, grep, glob, ls, search, quote, data_fetch 等只读工具
        //     在文件内容发生变化后允许重新执行（read-after-write 合法场景）
        //   - 阈值: 只读工具允许 3 次相同调用 (vs mutating 工具 1 次)
        // DEDUP_READ_ONLY_TOOLS 为模块常量(见文件顶部 Constants 区),避免每调用重建。
        const isReadOnlyTool = DEDUP_READ_ONLY_TOOLS.has(call.name);
        const dedupKey = JSON.stringify({ t: call.name, p: call.params });
        const prevExec = executedCallKeys.get(dedupKey);
        if (prevExec) {
          // Read-only tools: check if file content changed since last execution
          if (isReadOnlyTool) {
            const filePath = call.params?.file_path || call.params?.path || call.params?.filePath;
            if (filePath) {
              const currentHash = _fileContentHash(filePath);
              const prevHash = fileReadHashes.get(filePath);
              if (currentHash && prevHash && currentHash !== prevHash) {
                // File content changed — allow re-execution (read-after-write)
                executedCallKeys.delete(dedupKey);
                // Fall through to execute
              }
            }
          }
        }
        // Re-check after possible exemption
        const prevExecFinal = executedCallKeys.get(dedupKey);
        if (prevExecFinal) {
          prevExecFinal.count++;

          // Read-only tools: allow up to 3 identical calls before dedup
          if (isReadOnlyTool && prevExecFinal.count <= 3) {
            // Allow re-execution — don't dedup yet
          } else {
            // Guardrail 分级判定
            let guardrailResult;
            try {
              const { toolCallGuardrail } = require('./toolGuards');
              guardrailResult = toolCallGuardrail(call.name, call.params, prevExecFinal.resultHash);
            } catch {
              guardrailResult = { level: 'allow' };
            }

            if (guardrailResult.level === 'critical') {
              // 变更工具重复执行且结果相同 → 阻止
              const result = { success: false,
                error: `[ToolCallGuardrail:critical] ${guardrailResult.reason}`,
                _loopDetected: true, _deduped: true };
              if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
              return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
            }

            const result = { ...prevExecFinal.result, _deduped: true,
              _dedupNote: `This exact call was already executed (attempt #${prevExecFinal.count}). Use the previous result.` };
            // Warning 级别：注入提示但不阻止
            if (guardrailResult.level === 'warning' && guardrailResult.injectedHint) {
              result._guardrailWarning = guardrailResult.injectedHint;
            }
            if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
            return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
          }
        }

        // Shell intent dedup: detect same-intent commands with different syntax
        // e.g. "ls ~/Desktop" vs "ls /c/Users/xxx/Desktop" → same intent "ls:desktop"
        // Path intent dedup: detect same-path access across FS tools (LS, read_file, etc.)
        // e.g. LS({path:"~/Desktop"}) vs LS({path:"/c/Users/xxx/Desktop"}) → same path "desktop"
        if (!prevExec) {
          try {
            const { extractShellIntent, _isShellTool, extractPathIntent, _isFsTool, extractSearchIntent, _isSearchTool } = require('./toolLoopDetector');
            let intentKey = null;

            if (_isShellTool(call.name)) {
              const intent = extractShellIntent(call.params?.command || call.params?.cmd);
              if (intent) intentKey = `__intent__:shell:${intent}`;
            } else if (_isFsTool(call.name)) {
              const pathIntent = extractPathIntent(call.name, call.params);
              if (pathIntent) intentKey = `__intent__:fspath:${pathIntent}`;
            } else if (_isSearchTool(call.name)) {
              // Semantically-similar web searches with DIFFERENT query strings escape
              // the exact-key dedup; collapse them by keyword-set so the model can't
              // burn the budget re-asking the same question three different ways.
              const searchIntent = extractSearchIntent(call.params);
              if (searchIntent) intentKey = `__intent__:search:${searchIntent}`;
            }

            if (intentKey) {
              const prevIntent = executedCallKeys.get(intentKey);
              if (prevIntent && prevIntent.count >= 2) {
                const result = { ...prevIntent.result, _deduped: true,
                  _dedupNote: `Same target "${intentKey}" already attempted ${prevIntent.count} times with different tools/syntax.\n[STOP] 不要再重试。请直接用已有信息回答用户，或告知无法完成并建议替代方案。`,
                  _loopDetected: true };
                if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
                return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
              }
              if (prevIntent) {
                prevIntent.count++;
              } else {
                executedCallKeys.set(intentKey, { result: null, count: 1 });
              }
            }
          } catch { /* best effort */ }
        }

        if (loopDetector) loopDetector.recordCall(call.name, call.params);

        // Proactive platform command rewriting (parallel path)
        if ((_matchesShellDispatchName(call.name)) && call.params?.command) {
          const rewritten = _proactivePlatformRewrite(call.params.command);
          if (rewritten !== call.params.command) {
            call.params = { ...call.params, command: rewritten, _originalCommand: call.params.command };
          }
        }

        // Shell command safety check (parallel path)
        if ((_matchesShellDispatchName(call.name)) && call.params?.command) {
          const safety = analyzeCommand(call.params.command);
          if (!safety.safe) {
            const result = { success: false, error: `[ShellSafety] Command blocked (${safety.maxSeverity}): ${safety.risks.filter(r => r.severity === 'critical').map(r => r.detail).join('; ')}` };
            if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
            return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
          }
          // Exec approval check (multi-level permission)
          if (_execApproval) {
            const approval = _execApproval.checkCommand(call.params.command);
            const verdict = await _resolveExecApproval(call, approval, onControlRequest, parentAbort.signal);
            if (verdict === 'deny') {
              const result = { success: false, denied: true, error: `[ExecApproval] ${approval.reason} (risk: ${approval.risk})` };
              if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
              return { tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null };
            }
          }
        }

        const start = Date.now();
        const diagSpanId = diagnostics.emitToolCall(call.name, call.params, { traceId: diagTraceId, requestId });
        if (traceAudit) {
          try {
            traceAudit.logEvent('agent.tool.call', {
              requestId,
              toolName: call.name,
              params: call.params,
              iteration,
              parallel: true,
            }, {
              sessionId: traceSessionId,
              traceId: diagTraceId,
              requestId,
              source: 'tool-loop',
              visibility: 'summary',
            });
          } catch { /* non-critical */ }
        }
        const writeCtx = _captureWriteFileDiffContext(call);
        let result;

        // Phase 7: Check streaming executor cache before executing
        const _seExec = aiResult?._streamingExecutor;
        if (_seExec) {
          const cached = _seExec.getResultByHash(call.name, call.params);
          if (cached) {
            result = cached.output || cached;
            result._preExecuted = true;
          }
        }

        if (!result) {
        try {
          result = await toolCalling.executeTool(call.name, call.params, {
            sessionId: traceSessionId,
            traceId: diagTraceId,
            requestId,
            onControlRequest,
            // ESC / 用户中断 → 取消在途工具(门控 KHY_TOOL_ABORT_SIGNAL,关 → null,byte-identical)。
            abortSignal: _toolAbortSig,
            // Original human NL intent for the deterministic intent arbiter
            // ([DESIGN-ARCH-041]). Model-free / network-free 防误触 pre-route; only
            // consulted when KHY_INTENT_ARBITER=on (default off → unused field,
            // byte-identical). Always the ORIGINAL user message, never system nudges.
            intentText: originalUserMessage,
            // Thread the executing model so the metaConstraint capability floor
            // ([DESIGN-ARCH-034]) can allocate locks against THIS model's tier.
            model: effectiveChatOpts?.model || options?.model || process.env.GATEWAY_PREFERRED_MODEL || '',
            // Authenticated user (when the loop carries identity) so tools like
            // image_generate can honor per-user preferences; undefined = global.
            userId: options?.userId,
            // P0.3: pass a capped parent-conversation snapshot only for agent-spawn calls.
            ..._agentParentConversation(call.name, conversationMessages),
            ...(call._traceContext || {}),
          });
        } catch (err) {
          const { ToolError } = require('./toolError');
          const te = ToolError.isToolError(err) ? err : ToolError.fromGenericError(err);
          result = { ...te.toStructuredResult(), _aiContext: te.toAIContext() };
        }
        }
        result = await _recoverOpenAppAfterShellFailure(
          call,
          result,
          userMessage,
          toolCalling,
          { sessionId: traceSessionId, traceId: diagTraceId, requestId }
        );
        result = await _recoverWebSearchAfterShellFailure(
          call,
          result,
          userMessage,
          toolCalling,
          { sessionId: traceSessionId, traceId: diagTraceId, requestId }
        );
        // Platform hint: inject corrective hint when commands fail due to wrong-OS syntax
        if (result && !result.success
            && /^(shell_command|shellcommand|shellCommand|bash|execute_command)$/i.test(call.name)) {
          const _cmdStr = String(call.params?.command || call.params?.cmd || '');
          if (process.platform === 'win32') {
            const _winHint = _getWindowsCommandHint(_cmdStr);
            if (_winHint) result.error = (result.error || '') + '\n[Windows Hint] ' + _winHint;
          } else {
            const _linuxHint = _getLinuxCommandHint(_cmdStr);
            if (_linuxHint) result.error = (result.error || '') + '\n[Linux Hint] ' + _linuxHint;
          }
        }
        diagnostics.emitToolResult(diagSpanId, result, result?.error ? result.error : null, { traceId: diagTraceId, requestId });
        if (traceAudit) {
          try {
            traceAudit.logEvent('agent.tool.result', {
              requestId,
              toolName: call.name,
              success: !!result?.success,
              denied: !!result?.denied,
              error: result?.error || null,
              iteration,
              parallel: true,
            }, {
              sessionId: traceSessionId,
              traceId: diagTraceId,
              requestId,
              source: 'tool-loop',
              visibility: 'summary',
            });
          } catch { /* non-critical */ }
        }
        // Track ALL executed calls for dedup (not just failures)
        const _resultStr = typeof result === 'string' ? result : JSON.stringify(result || '');
        let _rHash = 0; const _rS = _resultStr.slice(0, 4096);
        for (let _ri = 0; _ri < _rS.length; _ri++) _rHash = ((_rHash << 5) - _rHash + _rS.charCodeAt(_ri)) | 0;
        executedCallKeys.set(dedupKey, { result, count: 1, resultHash: _rHash.toString(36) });
        // Update shell/path intent key with execution result
        try {
          const { extractShellIntent, _isShellTool, extractPathIntent, _isFsTool, extractSearchIntent, _isSearchTool } = require('./toolLoopDetector');
          let _intentKey = null;
          if (_isShellTool(call.name)) {
            const _si = extractShellIntent(call.params?.command || call.params?.cmd);
            if (_si) _intentKey = `__intent__:shell:${_si}`;
          } else if (_isFsTool(call.name)) {
            const _pi = extractPathIntent(call.name, call.params);
            if (_pi) _intentKey = `__intent__:fspath:${_pi}`;
          } else if (_isSearchTool(call.name)) {
            const _se = extractSearchIntent(call.params);
            if (_se) _intentKey = `__intent__:search:${_se}`;
          }
          if (_intentKey) {
            const _prev = executedCallKeys.get(_intentKey);
            if (_prev) { _prev.result = result; } else { executedCallKeys.set(_intentKey, { result, count: 1 }); }
          }
        } catch { /* best effort */ }
        // ToolCallGuardrail: 记录执行结果（供后续 critical 判定）
        try {
          const { toolCallGuardrailRecordResult } = require('./toolGuards');
          toolCallGuardrailRecordResult(call.name, call.params, _resultStr.slice(0, 4096));
        } catch { /* ignore */ }

        // Content-fingerprint: cache hash after successful read_file
        if (/^(read_file|readFile)$/i.test(call.name) && result?.success) {
          const fp = call.params?.path || call.params?.file_path;
          if (fp) {
            try {
              const abs = path.resolve(process.env.KHYQUANT_CWD || process.cwd(), fp);
              const hash = _fileContentHash(abs);
              if (hash) {
                try {
                  const st = fs.statSync(abs);
                  fileReadHashes.set(abs, { hash, mtime: st.mtimeMs, size: st.size });
                } catch {
                  fileReadHashes.set(abs, { hash, mtime: null, size: null });
                }
              }
            } catch { /* best-effort */ }
          }
        }

        if (loopDetector) loopDetector.recordOutcome(call.name, call.params, result);

        if (writeCtx && result && typeof result === 'object') {
          // Read AFTER content back from disk (tool-agnostic; covers multiedit /
          // notebook / deletion). 防呆: failure → null, write already succeeded.
          result._khyWriteDiff = _finalizeWriteDiff(writeCtx);
        }
        // DESIGN-ARCH-048: record this tool turn into the full-fidelity replay
        // ledger (recording-side SSOT for deterministic replay). 防呆①: best-effort
        // after result exists; never mutates result/model-visible content nor throws.
        try {
          require('./trajectoryReplay/replayLedger').recordToolTurn({
            sessionId: traceSessionId,
            name: call.name,
            params: call.params,
            result,
            writeDiff: result && typeof result === 'object' ? result._khyWriteDiff : null,
          });
        } catch { /* ledger is best-effort evidence; never break the hot path */ }
        const elapsed = Date.now() - start;

        // Hook: PostToolUse — allow hooks to transform result
        if (hookSys) {
          try {
            const postHr = await hookSys.trigger('PostToolUse', { toolName: call.name, params: call.params, result, elapsed, _fileReadHashes: fileReadHashes });
            if (postHr.context?.result) result = postHr.context.result;
            if (postHr.context?.preventContinuation) {
              _hookStopRequested = true;
              _hookStopReason = postHr.context.stopReason || postHr.reason || '';
            }
          } catch { /* non-critical */ }
        }

        if (onToolResult) onToolResult(call.name, call.params, result, iteration, elapsed, call._toolUseId || null);
        return { tool: call.name, params: call.params, result, elapsed, _loopWarning: call._loopWarning, _toolUseId: call._toolUseId || null };
      };

      // GAP 3: Bounded parallelism — cap concurrent tool executions at 8
      const MAX_PARALLEL_TOOLS = 8;
      let settled;
      try {
        const { runWithConcurrency } = require('./concurrencyLimiter');
        const concurrencyResult = await runWithConcurrency({
          tasks: parallelCalls.map(call => () => _executeOneParallel(call)),
          limit: MAX_PARALLEL_TOOLS,
          errorMode: 'continue',
        });
        settled = concurrencyResult.results.map(r => ({ status: 'fulfilled', value: r }));
      } catch {
        // Fallback: unbounded if concurrencyLimiter unavailable
        settled = await Promise.allSettled(parallelCalls.map(call => _executeOneParallel(call)));
      }
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          toolResults.push(s.value);
          toolCallLog.push({ iteration, ...s.value });
          // G1: Inject LSP diagnostics from parallel tool results
          if (s.value.result?._lspDiagnostics) {
            _pendingLspDiagnostics.push(s.value.result._lspDiagnostics);
          }
          // Plan progress for parallel calls
          if (executionPlan && onPlanProgress) {
            const stepIdx = _matchToolCallToStep(s.value.tool, s.value.params, executionPlan, currentPlanStep);
            if (stepIdx >= 0) {
              const status = (s.value.result && s.value.result.success) ? 'completed' : 'error';
              onPlanProgress(stepIdx, status);
              executionPlan.steps[stepIdx].status = status;
              if (status === 'completed' && stepIdx >= currentPlanStep) currentPlanStep = stepIdx + 1;
            }
          }
          if (s.value.result && s.value.result.denied) {
            const _df = _handleDenyFallback(s.value.tool, s.value.params, s.value.result);
            if (_df.stop) {
              return {
                finalResponse: _stripToolCalls(aiResult.reply) + `\n\n${_df.message != null ? _df.message : chalk.yellow('⚠ Tool execution denied by user, stopping.')}`,
                toolCallLog, iterations: iteration, provider: aiResult.provider, stopped: true,
              };
            }
            // _df.stop === false: 引导已注入 hint, 不 return, 继续循环让模型换方法。
          }
        } else {
          const entry = { tool: 'unknown', params: {}, result: { success: false, error: s.reason?.message || 'Promise rejected' }, elapsed: 0 };
          toolResults.push(entry);
          toolCallLog.push({ iteration, ...entry });
        }
      }
    } else if (parallelCalls.length === 1) {
      // A single concurrency-safe call in a parallel batch: run it through the
      // sequential body (no benefit to the parallel scheduler for one call).
      sequentialCalls.unshift(...parallelCalls);
    }

    // Execute sequential calls (this batch's serial calls, in order)
    for (const call of sequentialCalls) {
      // D9: Chunk-level interrupt — check between sequential tool calls
      // This allows interrupting a long chain of tool executions without
      // waiting for the entire iteration to complete
      if (interruptSignal && interruptSignal.interrupted) {
        break; // Exit tool execution early; interrupt is handled at iteration top
      }
      if (parentAbort && parentAbort.signal.aborted) {
        break; // Session-level cancellation
      }

      totalToolCalls++;

      // Skip legacy commands — they are handled by the existing REPL pipeline
      if (call.legacy) {
        toolResults.push({
          tool: '_legacy_cmd',
          params: call.params,
          result: { success: true, note: 'Executed via legacy command pipeline' },
        });
        toolCallLog.push({
          iteration,
          tool: '_legacy_cmd',
          params: call.params,
          result: { success: true },
          elapsed: 0,
        });
        continue;
      }

      if (!call._toolUseId) call._toolUseId = `loop_${Math.random().toString(36).slice(2, 10)}`;
      if (onToolCall) {
        const _callCtx = onToolCall(call.name, call.params, iteration, call._toolUseId || null);
        if (_callCtx && typeof _callCtx === 'object') {
          call._traceContext = { ...(call._traceContext || {}), ..._callCtx };
        }
      }

      // Content-fingerprint staleness check before edit
      if (/^(editFile|edit_file|edit)$/i.test(call.name)) {
        const fp = call.params?.file_path || call.params?.filePath || call.params?.path;
        if (fp) {
          try {
            const abs = path.resolve(process.env.KHYQUANT_CWD || process.cwd(), fp);
            const cachedEntry = fileReadHashes.get(abs);
            if (cachedEntry) {
              const currentHash = _fileContentHash(abs);
              if (currentHash && currentHash !== cachedEntry.hash) {
                if (!call.params) call.params = {};
                call.params._staleWarning = 'File changed since last read. Content may not match — consider re-reading first.';
                fileReadHashes.delete(abs);
              }
            }
          } catch { /* best-effort */ }
        }
      }

      // Hook: PreToolUse — allow hooks to block or modify params (sequential path)
      if (hookSys) {
        try {
          const hr = await hookSys.trigger('PreToolUse', { toolName: call.name, params: call.params, iteration, _fileReadHashes: fileReadHashes });
          if (hr.blocked) {
            // Soft guards flag the block as approvable → offer a single user
            // approval instead of a hard failure. Approval stamps EXEC_APPROVED
            // so Stage 7 does not re-prompt; denial / no channel keeps the block.
            let _released = false;
            if (hr.approvable && typeof onControlRequest === 'function') {
              try {
                const { requestGuardApproval } = require('./guardApproval');
                const verdict = await requestGuardApproval({
                  toolName: call.name, params: call.params,
                  reason: hr.reason, source: hr.source, onControlRequest,
                });
                if (verdict.allowed) { call.params = verdict.params; _released = true; }
              } catch { /* fall through to block */ }
            }
            if (!_released) {
              const result = { success: false, error: `[Hook] ${hr.reason || 'Blocked by PreToolUse hook'}` };
              if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
              toolResults.push({ tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null });
              toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed: 0 });
              continue;
            }
          }
          if (hr.context?.params) call.params = hr.context.params;
          // Idempotency stamp (sequential path) — see parallel path above.
          try {
            const { HOOKS_EVALUATED } = require('./execApproval');
            // Stamp is intentionally ENUMERABLE so it survives executeTool's
            // `{...params}` normalization spread into the alreadyHooked check.
            if (HOOKS_EVALUATED && call.params && typeof call.params === 'object') call.params[HOOKS_EVALUATED] = true;
          } catch { /* execApproval optional */ }
        } catch { /* hook failure should not block tool execution */ }
      }

      // Cross-turn repeat guard (sequential path) — see parallel path above for
      // the rationale. Steer the model to answer-from-context / switch approach
      // rather than silently re-running a call that already succeeded earlier.
      try {
        const _ctr = crossTurnRepeatDecision(call, _recentToolSigs, _crossTurnSteer, process.env);
        if (_ctr.steer) {
          const result = { success: false, _crossTurnSteer: true, _loopDetected: true, error: _ctr.message, _displayHint: _ctr.displayHint };
          if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
          toolResults.push({ tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null });
          toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed: 0 });
          continue;
        }
      } catch { /* cross-turn guard is best-effort; never block execution */ }

      // Loop detection: check before executing
      if (loopDetector) {
        const detection = loopDetector.check(call.name, call.params);
        if (detection.stuck && (detection.level === 'circuit_breaker' || detection.level === 'critical')) {
          const result = { success: false, error: `[LoopDetector:${detection.detector}] ${detection.message}\n\n[STOP] 你已经多次尝试相同的操作且没有进展。不要再重试。请直接用已有信息回答用户问题，或坦诚告知无法完成。`, _loopDetected: true };
          if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
          toolResults.push({ tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null });
          toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed: 0 });
          if (detection.level === 'circuit_breaker') { _haltBatches = true; _circuitBroken = true; break; } // stop all remaining batches; force a tools-free closing turn
          continue;
        }
        // Warning: inject hint and tag the call for result message
        if (detection.level === 'warning' && detection.message) {
          currentMessage += `\n[LoopDetector warning: ${detection.message}]`;
          call._loopWarning = detection.message;
        }
      }

      // Dedup: skip tool calls already executed with identical params (success or failure)
      // ToolCallGuardrail（借鉴 Hermes Agent）: 区分 idempotent/mutating 分级响应
      const dedupKey = JSON.stringify({ t: call.name, p: call.params });
      const prevExec = executedCallKeys.get(dedupKey);
      if (prevExec) {
        prevExec.count++;
        // Guardrail 分级判定
        let guardrailResult;
        try {
          const { toolCallGuardrail } = require('./toolGuards');
          guardrailResult = toolCallGuardrail(call.name, call.params, prevExec.resultHash);
        } catch {
          guardrailResult = { level: 'allow' };
        }

        if (guardrailResult.level === 'critical') {
          const result = { success: false,
            error: `[ToolCallGuardrail:critical] ${guardrailResult.reason}`,
            _loopDetected: true, _deduped: true };
          const elapsed = 0;
          if (onToolResult) onToolResult(call.name, call.params, result, iteration, elapsed, call._toolUseId || null);
          toolResults.push({ tool: call.name, params: call.params, result, elapsed, _toolUseId: call._toolUseId || null });
          toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed });
          continue;
        }

        const result = { ...prevExec.result, _deduped: true,
          _dedupNote: `This exact call was already executed (attempt #${prevExec.count}). Use the previous result.` };
        if (guardrailResult.level === 'warning' && guardrailResult.injectedHint) {
          result._guardrailWarning = guardrailResult.injectedHint;
        }
        const elapsed = 0;
        if (onToolResult) onToolResult(call.name, call.params, result, iteration, elapsed, call._toolUseId || null);
        toolResults.push({ tool: call.name, params: call.params, result, elapsed, _toolUseId: call._toolUseId || null });
        toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed });
        continue;
      }

      // Path/shell intent dedup (sequential path) — same logic as parallel path
      if (!prevExec) {
        try {
          const { extractShellIntent, _isShellTool, extractPathIntent, _isFsTool, extractSearchIntent, _isSearchTool } = require('./toolLoopDetector');
          let _seqIntentKey = null;
          if (_isShellTool(call.name)) {
            const _si = extractShellIntent(call.params?.command || call.params?.cmd);
            if (_si) _seqIntentKey = `__intent__:shell:${_si}`;
          } else if (_isFsTool(call.name)) {
            const _pi = extractPathIntent(call.name, call.params);
            if (_pi) _seqIntentKey = `__intent__:fspath:${_pi}`;
          } else if (_isSearchTool(call.name)) {
            const _se = extractSearchIntent(call.params);
            if (_se) _seqIntentKey = `__intent__:search:${_se}`;
          }
          if (_seqIntentKey) {
            const _prevI = executedCallKeys.get(_seqIntentKey);
            if (_prevI && _prevI.count >= 2) {
              const result = { ..._prevI.result, _deduped: true,
                _dedupNote: `Same target "${_seqIntentKey}" already attempted ${_prevI.count} times.\n[STOP] 不要再重试。请直接用已有信息回答用户，或告知无法完成并建议替代方案。`,
                _loopDetected: true };
              const elapsed = 0;
              if (onToolResult) onToolResult(call.name, call.params, result, iteration, elapsed, call._toolUseId || null);
              toolResults.push({ tool: call.name, params: call.params, result, elapsed, _toolUseId: call._toolUseId || null });
              toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed });
              continue;
            }
            if (_prevI) { _prevI.count++; }
            else { executedCallKeys.set(_seqIntentKey, { result: null, count: 1 }); }
          }
        } catch { /* best effort */ }
      }

      if (loopDetector) loopDetector.recordCall(call.name, call.params);

      // Proactive platform command rewriting (sequential path)
      if ((_matchesShellDispatchName(call.name)) && call.params?.command) {
        const rewritten = _proactivePlatformRewrite(call.params.command);
        if (rewritten !== call.params.command) {
          call.params = { ...call.params, command: rewritten, _originalCommand: call.params.command };
        }
      }

      // Shell command safety check (sequential path)
      if ((_matchesShellDispatchName(call.name)) && call.params?.command) {
        const safety = analyzeCommand(call.params.command);
        if (!safety.safe) {
          const result = { success: false, error: `[ShellSafety] Command blocked (${safety.maxSeverity}): ${safety.risks.filter(r => r.severity === 'critical').map(r => r.detail).join('; ')}` };
          if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
          toolResults.push({ tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null });
          toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed: 0 });
          continue;
        }
        // Exec approval check (multi-level permission)
        if (_execApproval) {
          const approval = _execApproval.checkCommand(call.params.command);
          const verdict = await _resolveExecApproval(call, approval, onControlRequest, parentAbort.signal);
          if (verdict === 'deny') {
            const result = { success: false, denied: true, error: `[ExecApproval] ${approval.reason} (risk: ${approval.risk})` };
            if (onToolResult) onToolResult(call.name, call.params, result, iteration, 0, call._toolUseId || null);
            toolResults.push({ tool: call.name, params: call.params, result, elapsed: 0, _toolUseId: call._toolUseId || null });
            toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed: 0 });
            continue;
          }
        }
      }

      const start = Date.now();
      const seqDiagSpanId = diagnostics.emitToolCall(call.name, call.params, { traceId: diagTraceId, requestId });
      if (traceAudit) {
        try {
          traceAudit.logEvent('agent.tool.call', {
            requestId,
            toolName: call.name,
            params: call.params,
            iteration,
            parallel: false,
          }, {
            sessionId: traceSessionId,
            traceId: diagTraceId,
            requestId,
            source: 'tool-loop',
            visibility: 'summary',
          });
        } catch { /* non-critical */ }
      }
      const writeCtx = _captureWriteFileDiffContext(call);
      let result;
      let toolCalling = null;

      // Phase 7: Check streaming executor cache before executing (sequential path)
      const _seExecSeq = aiResult?._streamingExecutor;
      if (_seExecSeq) {
        const cached = _seExecSeq.getResultByHash(call.name, call.params);
        if (cached) {
          result = cached.output || cached;
          result._preExecuted = true;
        }
      }

      if (!result) {
      try {
        // Use toolCalling.executeTool which includes permission system
        toolCalling = require('./toolCalling');
        result = await toolCalling.executeTool(call.name, call.params, {
          sessionId: traceSessionId,
          traceId: diagTraceId,
          requestId,
          onControlRequest,
          // ESC / 用户中断 → 取消在途工具(门控 KHY_TOOL_ABORT_SIGNAL,关 → null,byte-identical)。
          abortSignal: _toolAbortSig,
          // Original human NL intent for the deterministic intent arbiter
          // ([DESIGN-ARCH-041]). Model-free / network-free 防误触 pre-route; only
          // consulted when KHY_INTENT_ARBITER=on (default off → unused field,
          // byte-identical). Always the ORIGINAL user message, never system nudges.
          intentText: originalUserMessage,
          // Per-user identity (when present) for preference-aware tools.
          userId: options?.userId,
          // P0.3: pass a capped parent-conversation snapshot only for agent-spawn calls.
          ..._agentParentConversation(call.name, conversationMessages),
          ...(call._traceContext || {}),
        });
      } catch (err) {
        // Fallback: try tool registry directly
        try {
          const toolRegistry = require('../tools');
          result = await toolRegistry.execute(call.name, call.params);
        } catch (err2) {
          const { ToolError: TE } = require('./toolError');
          const te2 = TE.isToolError(err2) ? err2 : TE.fromGenericError(err2);
          result = { ...te2.toStructuredResult(), _aiContext: te2.toAIContext() };
        }
      }
      }
      if (!toolCalling) {
        try { toolCalling = require('./toolCalling'); } catch { toolCalling = null; }
      }
      if (toolCalling) {
        result = await _recoverOpenAppAfterShellFailure(
          call,
          result,
          userMessage,
          toolCalling,
          { sessionId: traceSessionId, traceId: diagTraceId, requestId }
        );
        result = await _recoverWebSearchAfterShellFailure(
          call,
          result,
          userMessage,
          toolCalling,
          { sessionId: traceSessionId, traceId: diagTraceId, requestId }
        );
      }
      // Platform hint: inject corrective hint when commands fail due to wrong-OS syntax (sequential path)
      if (result && !result.success
          && /^(shell_command|shellcommand|shellCommand|bash|execute_command)$/i.test(call.name)) {
        const _cmdStr = String(call.params?.command || call.params?.cmd || '');
        if (process.platform === 'win32') {
          const _winHint = _getWindowsCommandHint(_cmdStr);
          if (_winHint) result.error = (result.error || '') + '\n[Windows Hint] ' + _winHint;
        } else {
          const _linuxHint = _getLinuxCommandHint(_cmdStr);
          if (_linuxHint) result.error = (result.error || '') + '\n[Linux Hint] ' + _linuxHint;
        }
      }
      diagnostics.emitToolResult(seqDiagSpanId, result, result?.error ? result.error : null, { traceId: diagTraceId, requestId });
      if (traceAudit) {
        try {
          traceAudit.logEvent('agent.tool.result', {
            requestId,
            toolName: call.name,
            success: !!result?.success,
            denied: !!result?.denied,
            error: result?.error || null,
            iteration,
            parallel: false,
          }, {
            sessionId: traceSessionId,
            traceId: diagTraceId,
            requestId,
            source: 'tool-loop',
            visibility: 'summary',
          });
        } catch { /* non-critical */ }
      }

      // Track ALL executed calls for dedup (not just failures)
      const _resultStr2 = typeof result === 'string' ? result : JSON.stringify(result || '');
      let _rHash2 = 0; const _rS2 = _resultStr2.slice(0, 4096);
      for (let _ri2 = 0; _ri2 < _rS2.length; _ri2++) _rHash2 = ((_rHash2 << 5) - _rHash2 + _rS2.charCodeAt(_ri2)) | 0;
      executedCallKeys.set(dedupKey, { result, count: 1, resultHash: _rHash2.toString(36) });
      // Update shell/path intent key with execution result
      try {
        const { extractShellIntent, _isShellTool, extractPathIntent, _isFsTool, extractSearchIntent, _isSearchTool } = require('./toolLoopDetector');
        let _intentKey2 = null;
        if (_isShellTool(call.name)) {
          const _si2 = extractShellIntent(call.params?.command || call.params?.cmd);
          if (_si2) _intentKey2 = `__intent__:shell:${_si2}`;
        } else if (_isFsTool(call.name)) {
          const _pi2 = extractPathIntent(call.name, call.params);
          if (_pi2) _intentKey2 = `__intent__:fspath:${_pi2}`;
        } else if (_isSearchTool(call.name)) {
          const _se2 = extractSearchIntent(call.params);
          if (_se2) _intentKey2 = `__intent__:search:${_se2}`;
        }
        if (_intentKey2) {
          const _prev2 = executedCallKeys.get(_intentKey2);
          if (_prev2) { _prev2.result = result; } else { executedCallKeys.set(_intentKey2, { result, count: 1 }); }
        }
      } catch { /* best effort */ }
      // ToolCallGuardrail: 记录执行结果（供后续 critical 判定）
      try {
        const { toolCallGuardrailRecordResult } = require('./toolGuards');
        toolCallGuardrailRecordResult(call.name, call.params, _resultStr2.slice(0, 4096));
      } catch { /* ignore */ }

      // Content-fingerprint: cache hash after successful read_file
      if (/^(read_file|readFile)$/i.test(call.name) && result?.success) {
        const fp = call.params?.path || call.params?.file_path;
        if (fp) {
          try {
            const abs = path.resolve(process.env.KHYQUANT_CWD || process.cwd(), fp);
            const hash = _fileContentHash(abs);
            if (hash) fileReadHashes.set(abs, { hash, mtime: null, size: null });
          } catch { /* best-effort */ }
        }
      }

      if (loopDetector) loopDetector.recordOutcome(call.name, call.params, result);

      const elapsed = Date.now() - start;
      if (writeCtx && result && typeof result === 'object') {
        // Read AFTER content back from disk (tool-agnostic; covers multiedit /
        // notebook / deletion). 防呆: failure → null, write already succeeded.
        result._khyWriteDiff = _finalizeWriteDiff(writeCtx);
      }
      // DESIGN-ARCH-048: record this tool turn into the full-fidelity replay
      // ledger (recording-side SSOT for deterministic replay). 防呆①: best-effort
      // after result exists; never mutates result/model-visible content nor throws.
      try {
        require('./trajectoryReplay/replayLedger').recordToolTurn({
          sessionId: traceSessionId,
          name: call.name,
          params: call.params,
          result,
          writeDiff: result && typeof result === 'object' ? result._khyWriteDiff : null,
        });
      } catch { /* ledger is best-effort evidence; never break the hot path */ }

      // Audit logging (non-critical)
      try {
        const { logToolExecution } = require('./auditLog');
        logToolExecution({
          tool: call.name,
          params: call.params,
          result,
          elapsed,
        });
      } catch { /* audit failure is non-critical */ }

      // Hook: PostToolUse — allow hooks to transform result (sequential path)
      if (hookSys) {
        try {
          const postHr = await hookSys.trigger('PostToolUse', { toolName: call.name, params: call.params, result, elapsed, _fileReadHashes: fileReadHashes });
          if (postHr.context?.result) result = postHr.context.result;
          if (postHr.context?.preventContinuation) {
            _hookStopRequested = true;
            _hookStopReason = postHr.context.stopReason || postHr.reason || '';
          }
        } catch { /* non-critical */ }
      }

      // G1: Inject LSP diagnostics as synthetic message for AI self-correction
      if (result?._lspDiagnostics) {
        _pendingLspDiagnostics.push(result._lspDiagnostics);
      }

      if (onToolResult) onToolResult(call.name, call.params, result, iteration, elapsed, call._toolUseId || null);

      // Update plan progress if we have an execution plan
      if (executionPlan && onPlanProgress) {
        const stepIdx = _matchToolCallToStep(call.name, call.params, executionPlan, currentPlanStep);
        if (stepIdx >= 0) {
          const status = (result && result.success) ? 'completed' : 'error';
          onPlanProgress(stepIdx, status);
          executionPlan.steps[stepIdx].status = status;
          if (status === 'completed' && stepIdx >= currentPlanStep) {
            currentPlanStep = stepIdx + 1;
            // Mark next step as in_progress
            if (currentPlanStep < executionPlan.steps.length) {
              onPlanProgress(currentPlanStep, 'in_progress');
            }
          }
        }
      }

      toolResults.push({ tool: call.name, params: call.params, result, _loopWarning: call._loopWarning, _toolUseId: call._toolUseId || null });
      toolCallLog.push({ iteration, tool: call.name, params: call.params, result, elapsed });

      // Update content-fingerprint after successful edit/write
      if (result?.success && /^(editFile|edit_file|edit|write_file|writeFile)$/i.test(call.name)) {
        const fp = call.params?.file_path || call.params?.filePath || call.params?.path;
        if (fp) {
          try {
            const abs = path.resolve(process.env.KHYQUANT_CWD || process.cwd(), fp);
            const hash = _fileContentHash(abs);
            if (hash) fileReadHashes.set(abs, { hash, mtime: null, size: null });
          } catch { /* best-effort */ }
        }
      }

      // Auto-verify: if write_file failed, automatically read the file to check state
      if (result && !result.success && (call.name === 'write_file' || call.name === 'writeFile') && call.params?.path) {
        try {
          const toolCalling = require('./toolCalling');
          const verifyResult = await toolCalling.executeTool('read_file', { path: call.params.path });
          if (verifyResult && verifyResult.success) {
            toolResults.push({ tool: 'read_file', params: { path: call.params.path }, result: verifyResult, elapsed: 0, _autoVerify: true });
            toolCallLog.push({ iteration, tool: 'read_file', params: { path: call.params.path }, result: verifyResult, elapsed: 0, _autoVerify: true });
          }
        } catch { /* verification is best-effort */ }
      }

      // Auto-recovery: if editFile failed, inject guidance hint + auto-read file
      if (result && !result.success &&
          (call.name === 'editFile' || call.name === 'edit_file' || call.name === 'edit')) {
        const errMsg = String(result.error?.message || result.error || '');
        const filePath = call.params?.file_path || call.params?.filePath || call.params?.path;
        let hint = '';
        if (errMsg.includes('not found in'))
          hint = `Edit failed: old_string was not found in the file. The text may have changed or whitespace/indentation does not match. Use read_file to see the current content of ${filePath || 'the file'}, then retry with the exact text.`;
        else if (/appears.*times/.test(errMsg))
          hint = 'Edit failed: old_string matches multiple locations. Include more surrounding context lines in old_string to make it unique, or use replace_all: true.';
        else if (errMsg.includes('ENOENT') || errMsg.includes('File not found'))
          hint = `Edit failed: file ${filePath || ''} does not exist. Check the path with glob, then retry.`;
        if (hint) result.hint = hint;
        // Auto-read on "not found" to give AI fresh file content
        if (errMsg.includes('not found in') && filePath) {
          try {
            const toolCalling = require('./toolCalling');
            const vr = await toolCalling.executeTool('read_file', { path: filePath });
            if (vr && vr.success) {
              toolResults.push({ tool: 'read_file', params: { path: filePath }, result: vr, elapsed: 0, _autoVerify: true });
              toolCallLog.push({ iteration, tool: 'read_file', params: { path: filePath }, result: vr, elapsed: 0, _autoVerify: true });
            }
          } catch { /* best-effort */ }
        }
      }

      // If user denied the tool, try other methods first; only stop (with an
      // honest required-permission message) once alternatives are exhausted.
      if (result && result.denied) {
        const _df = _handleDenyFallback(call.name, call.params, result);
        if (_df.stop) {
          return {
            finalResponse: _stripToolCalls(aiResult.reply) + `\n\n${_df.message != null ? _df.message : chalk.yellow('⚠ Tool execution denied by user, stopping.')}`,
            toolCallLog,
            iterations: iteration,
            provider: aiResult.provider,
            stopped: true,
          };
        }
        // _df.stop === false: 引导已注入 result.hint, 不 return, 继续循环让模型换方法。
      }
    }
    } // end for (_batch of _execBatches) — order-preserving batched execution
    } // end else (original inline execution)

    // 4b. AskUserQuestion interactive resolution.
    // AskUserQuestionTool returns a structured { type:'question', questions }
    // result instead of doing its own I/O. If the host provided an
    // onControlRequest channel (classic REPL → handleControlRequest, or a TUI
    // that drives this loop), surface the question(s) and splice the user's
    // answers into result.output (Priority-1 in _extractToolOutput, which beats
    // the leftover `message`) so the model sees the real answers. Without a
    // channel (e.g. a subagent loop), the result falls through unchanged and the
    // extractor surfaces its `message` — preserving the queued-text fallback.
    //
    // 无人值守自动作答(优先级最高,门控 KHY_UNATTENDED_AUTOANSWER 默认关):
    // 连续几天不中断的关键缺口——即便前台跑 /goal 有 onControlRequest 通道,
    // AskUserQuestion 也会阻塞等人,一个问题停住整个 run。opt-in 后由 unattendedAutoAnswer
    // 确定性地用 questionQuality 排好序的**推荐选项**(index 0)作答,绕过阻塞、无感续跑。
    // 门控关 → 本 if 恒 false,逐字节回退到下面既有的「有通道/无通道」两分支。
    if (require('./unattendedAutoAnswer').isEnabled(process.env)) {
      for (const tr of toolResults) {
        const r = tr && tr.result;
        const isQuestion = r && r.type === 'question'
          && (Array.isArray(r.questions) || _normToolName(tr.tool) === 'askuserquestion');
        if (!isQuestion) continue;
        const questions = Array.isArray(r.questions) && r.questions.length
          ? r.questions
          : [{ question: r.question, options: r.options || [], multiSelect: !!r.multiSelect }];
        // 不偏离用户本意:把「持久目标文本 + 原始诉求锚点 + 原始消息」作为本意上下文喂给自动作答,
        // 让 autoAnswerIntentGuard(默认开)在盲选 index 0 前把选择校准回本意。全 fail-soft:
        // 取不到任何锚点材料 → intentContext 仍传但引导层无信号 → 逐字节回退到基线 index 0。
        let _intentCtx = null;
        try {
          let _goalText = '';
          try { _goalText = (require('./goalStore').getActiveGoal(process.cwd()) || {}).text || ''; }
          catch { _goalText = ''; }
          _intentCtx = {
            goalText: _goalText,
            intentAnchors: (_intentFrame && Array.isArray(_intentFrame.detailAnchors)) ? _intentFrame.detailAnchors : [],
            originalMessage: originalUserMessage || '',
          };
        } catch { _intentCtx = null; }
        let auto = null;
        try { auto = require('./unattendedAutoAnswer').selectAutoAnswers(questions, process.env, _intentCtx); }
        catch { auto = null; }
        if (auto && auto.answers && Object.keys(auto.answers).length > 0) {
          let output;
          try {
            output = require('./answerDirectionSynthesis')
              .buildAnswerFeedback({ answers: auto.answers, env: process.env });
          } catch {
            output = Object.entries(auto.answers)
              .map(([qText, ans]) => `Q: ${qText}\nA: ${ans}`)
              .join('\n\n');
          }
          let note = '';
          try { note = require('./unattendedAutoAnswer').buildAutoAnswerNote(auto.picks); }
          catch { note = ''; }
          tr.result = {
            success: true,
            output: note ? `${note}\n${output}` : output,
            answers: auto.answers,
            _questionResolved: true,
            _autoAnswered: true,
          };
        } else {
          // 无可选推荐项(如空 options)→ 不假造答案,退回保守自决指令(与无通道分支同姿态)。
          tr.result = {
            success: true,
            _questionResolved: true,
            output:
              'Unattended auto-answer is enabled but this question had no selectable '
              + 'recommended option. Do NOT stall: choose the most reasonable default '
              + 'from what you already know, state the assumption explicitly, and proceed.',
          };
        }
      }
    } else if (typeof onControlRequest === 'function') {
      for (const tr of toolResults) {
        const r = tr && tr.result;
        const isQuestion = r && r.type === 'question'
          && (Array.isArray(r.questions) || _normToolName(tr.tool) === 'askuserquestion');
        if (!isQuestion) continue;
        const questions = Array.isArray(r.questions) && r.questions.length
          ? r.questions
          : [{ question: r.question, options: r.options || [], multiSelect: !!r.multiSelect }];
        let ctrlResp = null;
        try {
          // Race the control-request against parentAbort so an ESC/interrupt/
          // orphaned-overlay can never park the loop forever (spinner-hang).
          // Gated KHY_CONTROL_REQUEST_GUARD (default on); off → awaits the raw
          // promise unchanged. On abort/timeout settles to null → treated as
          // "no answers" and the loop's next abort check unwinds cleanly.
          ctrlResp = await require('./controlRequestGuard').guardControlRequest(
            onControlRequest({
              requestId: `auq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              request: {
                subtype: 'can_use_tool',
                tool_name: 'AskUserQuestion',
                input: { ...(r.input || {}), questions },
              },
            }),
            { signal: parentAbort.signal, env: process.env },
          );
        } catch { ctrlResp = null; }
        const parsed = _readControlAnswers(ctrlResp);
        if (parsed.denied) {
          tr.result = { success: true, output: 'User declined to answer the question(s).', _questionResolved: true };
          continue;
        }
        if (parsed.answers && Object.keys(parsed.answers).length > 0) {
          // Enrich the answer-splice so the model treats the answers as ONE
          // combined decision and recalibrates direction before proceeding —
          // instead of receiving bare Q:/A: lines with no guidance. Gated
          // KHY_ANSWER_DIRECTION_SYNTHESIS (default on); off → byte-identical
          // to the historical `Q:…\nA:…` join. Never throws (fail-soft to base).
          let output;
          try {
            output = require('./answerDirectionSynthesis')
              .buildAnswerFeedback({ answers: parsed.answers, env: process.env });
          } catch {
            output = Object.entries(parsed.answers)
              .map(([qText, ans]) => `Q: ${qText}\nA: ${ans}`)
              .join('\n\n');
          }
          tr.result = { success: true, output, answers: parsed.answers, _questionResolved: true };
        }
      }
    } else if (_envFlagEnabled(process.env.KHY_ASK_NOCHANNEL_STRICT, true)) {
      // No host channel (subagent / CI / background loop) to pause on. Rather
      // than fire-and-continue with the silent "Question queued for user"
      // message — which lets the model barrel ahead as if it had asked — re-inject
      // a conservative instruction (aligned with Claude Code's headless degrade):
      // pick the most reasonable default from available information, state the
      // assumption explicitly, and flag what genuinely needs user confirmation.
      // Disable with KHY_ASK_NOCHANNEL_STRICT=0 to restore the old behavior.
      for (const tr of toolResults) {
        const r = tr && tr.result;
        const isQuestion = r && r.type === 'question'
          && (Array.isArray(r.questions) || _normToolName(tr.tool) === 'askuserquestion');
        if (!isQuestion) continue;
        const questions = Array.isArray(r.questions) && r.questions.length
          ? r.questions
          : [{ question: r.question, options: r.options || [], multiSelect: !!r.multiSelect }];
        const qSummary = questions.map((q, i) => {
          const opts = Array.isArray(q.options)
            ? q.options.map(o => (typeof o === 'string' ? o : o.label)).filter(Boolean).join(' | ')
            : '';
          return `  ${i + 1}. ${q.question || ''}${opts ? `\n     options: ${opts}` : ''}`;
        }).join('\n');
        tr.result = {
          success: true,
          _questionResolved: true,
          output:
            'No interactive user channel is available in this context, so your '
            + 'question(s) cannot be answered live:\n'
            + `${qSummary}\n\n`
            + 'Do NOT stall waiting for an answer. Choose the most reasonable '
            + 'default from the information you already have, state the assumption '
            + 'you are making explicitly, and proceed. If a decision genuinely '
            + 'cannot be made safely without the user, clearly flag it as an open '
            + 'item requiring user confirmation in your final summary rather than '
            + 'guessing on an irreversible action.',
        };
      }
    }

    // 5. Build follow-up message with tool results.
    // Text protocol (weak-local): feed results back as a PLAIN-TEXT turn the
    // model can read; no structured Anthropic blocks (the local adapter does not
    // consume them), so the synthetic tool_use pairing below is naturally
    // skipped. Native protocol: the existing structured builder, unchanged.
    const toolResultMsg = _isTextProtocol
      ? _activeAdapter.formatToolResults(toolResults, { maxLen: 2000 })
      : _buildToolResultMessage(toolResults);
    currentMessage = toolResultMsg.text;
    // 自我动作认领:若本批(或粘性窗口内的近批)含 khyos 亲自执行的删除/覆盖/写入动作,
    // 在结果回灌下一轮**之前**附加一段 [SYSTEM:] 指令,要求模型认领自己刚做的动作、不要把
    // 结果甩给「可能之前已经被清理过」这类模糊外因(因果自相矛盾)。display 路径会剥掉
    // [SYSTEM:](见 systemPromptLeak)故对用户不可见。fail-soft、零假阳性(纯只读批次无指令)。
    if (_actionAttribution && _attributionState) {
      try {
        const _attr = _actionAttribution.recordToolBatch(
          _attributionState, toolResults, { options: effectiveChatOpts });
        if (_attr && _attr.directive) currentMessage += '\n\n' + _attr.directive;
      } catch { /* fail-soft:认领引导异常不影响主回灌 */ }
    }
    // Pass structured tool_result data for native API adapters (Claude/OpenAI)
    effectiveChatOpts._pendingToolResults = toolResultMsg.structuredToolResults || null;
    // Anthropic content blocks (tool_result) for ai.js _messages storage
    effectiveChatOpts._structuredToolResultBlocks = toolResultMsg.structuredBlocks || null;
    // Pass assistant's tool_use blocks so ai.js can build proper structured assistant message.
    // When tools were auto-injected (no native tool_use from model), synthesize matching
    // tool_use blocks so the API sees proper assistant(tool_use) → user(tool_result) pairing.
    // Echo back the model's signed thinking blocks so extended thinking stays
    // continuous across tool rounds (Anthropic requires them in the assistant turn).
    // Empty/absent for non-thinking models → no change downstream.
    if (Array.isArray(aiResult.thinkingBlocks) && aiResult.thinkingBlocks.length > 0) {
      effectiveChatOpts._assistantThinkingBlocks = aiResult.thinkingBlocks;
    }
    if (Array.isArray(aiResult.toolUseBlocks) && aiResult.toolUseBlocks.length > 0) {
      effectiveChatOpts._assistantToolUseBlocks = aiResult.toolUseBlocks;
    } else if (toolResultMsg.structuredToolResults && toolResultMsg.structuredToolResults.length > 0) {
      // Auto-injected tools (web_search, scaffold, etc.) — no native tool_use blocks from model.
      // Synthesize tool_use blocks to satisfy API pairing requirements.
      effectiveChatOpts._assistantToolUseBlocks = toolResultMsg.structuredToolResults.map(tr => ({
        type: 'tool_use',
        id: tr.tool_use_id,
        name: tr.tool,
        input: {},
      }));
    }

    // ── Circuit breaker tripped: force a tools-free closing turn ──────────
    // The hard backstop fired. Instead of re-inviting the model with tools on
    // offer (a weak model just emits filler + more doomed calls — "绕圈子"),
    // arm a one-shot tools-free turn and replace the "call the next tool"
    // continuation with a terminal instruction. If it already fired once this
    // loop and tripped again, the model never converges → bail with salvage.
    if (_circuitBroken) {
      if (_circuitBrokenHandled) {
        const collected = _stripToolCalls(_stripExecutionPlan(lastResult?.reply || ''));
        const hasContent = collected.replace(/\s/g, '').length >= 40;
        return {
          finalResponse: (hasContent ? collected : '抱歉，我反复尝试但没有取得进展，无法完成这个请求。')
            + `\n\n${chalk.yellow('⚠ 已多次触发循环保护，停止重试。建议把问题拆小或换一种问法。')}`,
          toolCallLog,
          iterations: iteration,
          provider: lastResult?.provider,
          stopped: true,
          loopDetected: true,
        };
      }
      _circuitBrokenHandled = true;
      _circuitBroken = false;
      _forceNoToolsNext = true; // next chat() turn suppresses function-calling
      currentMessage += '\n\n[SYSTEM: 循环保护已触发——你已多次调用工具但没有进展。'
        + '本轮禁止再调用任何工具。请只根据上方已经获取到的信息，直接用自然语言'
        + '给出最终答案；如果信息确实不足以完成，就如实、简洁地说明无法完成及原因。'
        + '不要复述计划、不要说“让我使用工具”之类的话。]';
      currentMessage = _injectSteerIfPresent(currentMessage, getSteerMessages);
      if (aiResult.reply) {
        conversationMessages.push({ role: 'assistant', content: aiResult.reply });
      }
      conversationMessages.push({ role: 'user', content: currentMessage });
      continue;
    }

    // ── 关键节点主动汇报（确定性半）：测试结果 ─────────────────────────
    // 工具结果里若包含测试运行器输出（jest/vitest/pytest/go/cargo/mocha/
    // node:test），解析出通过/失败数与失败用例并发给消费者渲染。独立于续接信号，
    // 故放在 KHY_LOOP_CONTINUATION 块之外；子 agent 抑制。
    // 测试发现解析一次,既喂关键节点汇报(onKeyFinding),又喂开发过程在途纠偏的回归基线。
    let _testFindings = [];
    let _pendingCourseHint = null;
    let _pendingFpfHint = null;
    let _pendingReflectHint = null;
    if (_keyFindings && !effectiveChatOpts._isSubagent) {
      try {
        for (const tr of toolResults) {
          const finding = _keyFindings.detectTestOutcome(tr.tool, tr.params, tr.result, process.env);
          if (finding) {
            _testFindings.push(finding);
            if (typeof onKeyFinding === 'function') onKeyFinding(finding);
          }
        }
      } catch (e) { _tripwire(e, 'loop.keyFindings.detectTest'); /* best-effort, never blocks */ }
    }

    // ── 开发过程在途纠偏：主动监听开发轨迹,跑偏酿成大错前及早提示修正航向 ──────────
    // 把本轮工具结果与测试发现折叠进轨迹状态,评估是否跑偏;命中则在工具边界注入一段
    // 「航向提示」上下文参考(可采用/改写/忽略),避免任务收尾才发现方向错被迫大改。
    if (_courseState && _courseMonitor) {
      try {
        _courseMonitor.recordIteration(_courseState, { toolResults, testFindings: _testFindings }, process.env);
        const _course = _courseMonitor.assess(_courseState, process.env);
        if (_course.drift && _course.directive) {
          if (typeof onKeyFinding === 'function') {
            onKeyFinding({ kind: 'course_correction', signals: _course.signals, message: _course.directive });
          }
          // 注入待下方续接块统一发出(仅原生协议;文本协议弱模型不依赖主动取用)。
          if (!_isTextProtocol) _pendingCourseHint = _course.directive;
        }
      } catch (e) { _tripwire(e, 'loop.courseMonitor'); /* 纠偏 fail-soft,绝不阻断循环 */ }
    }

    // ── 边做边想:执行中拿新过程/结果对照最初设想,偏离则提示就地修订(而非按原计划硬推)──
    // 把本轮模型文本(捕计划/判反思)与工具结果折叠进反思状态;命中则在工具边界注入一段
    // 「边做边想」上下文参考(可采用/改写/忽略),与开发纠偏同一非侵入哲学。
    if (_reflectState && _adaptiveExec) {
      try {
        _adaptiveExec.recordStep(_reflectState, { assistantText: aiResult && aiResult.reply, toolResults }, process.env);
        const _reflect = _adaptiveExec.assess(_reflectState, process.env);
        if (_reflect.adjust && _reflect.directive) {
          if (typeof onKeyFinding === 'function') {
            onKeyFinding({ kind: 'adaptive_reflection', signals: _reflect.signals, message: _reflect.directive });
          }
          if (!_isTextProtocol) _pendingReflectHint = _reflect.directive;
        }
      } catch (e) { _tripwire(e, 'loop.adaptiveExec'); /* 反思 fail-soft,绝不阻断循环 */ }
    }

    // ── 防 bug 误判:复现先行守卫(强档非绑定提示;弱档硬拦在 harness 收口)──────────
    // bugfix 意图下监听是否有"红色复现":改了源码"修 bug"却从无任何失败(红)测试,很可能
    // 在修一个并不存在的 bug、把正确代码改坏。命中则注入一段「复现先行提示」上下文参考。
    if (_fpfState && _fpfGuard) {
      try {
        _fpfGuard.recordIteration(_fpfState, { toolResults, testFindings: _testFindings }, process.env);
        const _fpf = _fpfGuard.assess(_fpfState, process.env);
        if (_fpf.caution && _fpf.directive) {
          if (typeof onKeyFinding === 'function') {
            onKeyFinding({ kind: 'false_positive_fix_caution', signals: _fpf.signals, message: _fpf.directive });
          }
          // 仅原生协议注入(文本协议弱模型不依赖主动取用);弱档真正的硬拦在 harness finalize。
          if (!_isTextProtocol) _pendingFpfHint = _fpf.directive;
        }
      } catch (e) { _tripwire(e, 'loop.fpfGuard'); /* 守卫 fail-soft,绝不阻断循环 */ }
    }

    // ── 续接信号：驱动模型继续执行而非停下 ──────────────────────────
    // 对标 CC: 工具结果后附加明确的续接指令，防止模型误认为任务已完成。
    // 开关 KHY_LOOP_CONTINUATION（默认开）：置 0/false/off 可关闭该注入，
    // 避免在用户看来像“凭空冒出的系统继续指令”。
    if (!budget.depleted && _envFlagEnabled(process.env.KHY_LOOP_CONTINUATION, true)) {
      const remaining = budget.max - budget.used;
      // Inject platform reminder if any shell command failed (model may have used wrong-OS commands)
      const _hadShellFailure = toolResults.some(tr =>
        /^(shell_command|shellcommand|shellCommand|bash)$/i.test(tr.tool)
        && tr.result && !tr.result.success
      );
      const _platformReminder = _hadShellFailure
        ? (process.platform === 'win32'
          ? ' 注意：当前系统是 Windows (cmd.exe)，请使用 Windows 命令语法（dir/type/copy/move/del/findstr/where），不要使用 bash 语法。'
          : ' 注意：当前系统是 Linux/macOS (bash)，请使用 Unix 命令语法（ls/cat/cp/mv/rm/grep/which），不要使用 Windows 语法。')
        : '';
      const continuationSignal = `[SYSTEM: Tool results above. Continue the task: if done, give final summary; if not, call the next tool. Remaining iterations: ${remaining}${_platformReminder}]`;
      currentMessage += '\n\n' + continuationSignal;
      // Also inject continuation signal into structured blocks so both paths see it
      if (Array.isArray(effectiveChatOpts._structuredToolResultBlocks)) {
        effectiveChatOpts._structuredToolResultBlocks.push({ type: 'text', text: continuationSignal });
      }

      // 非侵入式结果反思：把单源旁白作为“上下文参考”交给模型自行取用（采用/改写/
      // 忽略），而非强制渲染固定文本。仅原生协议路径注入——弱本地模型走文本协议时
      // 不依赖模型主动取用，由 ink-TUI 的 flushPendingOutcome 合成兜底，更可靠。
      if (!_isTextProtocol) {
        const _outcomeHint = _buildOutcomeReflectionHint(toolResults, process.env);
        if (_outcomeHint) {
          currentMessage += '\n\n' + _outcomeHint;
          if (Array.isArray(effectiveChatOpts._structuredToolResultBlocks)) {
            effectiveChatOpts._structuredToolResultBlocks.push({ type: 'text', text: _outcomeHint });
          }
        }
        // 开发过程在途纠偏提示:与结果反思同样作为上下文参考注入,让模型及早修正航向。
        if (_pendingCourseHint) {
          currentMessage += '\n\n' + _pendingCourseHint;
          if (Array.isArray(effectiveChatOpts._structuredToolResultBlocks)) {
            effectiveChatOpts._structuredToolResultBlocks.push({ type: 'text', text: _pendingCourseHint });
          }
        }
        // 复现先行提示:同样作为上下文参考注入,提醒模型先复现再修、别改坏正确代码。
        if (_pendingFpfHint) {
          currentMessage += '\n\n' + _pendingFpfHint;
          if (Array.isArray(effectiveChatOpts._structuredToolResultBlocks)) {
            effectiveChatOpts._structuredToolResultBlocks.push({ type: 'text', text: _pendingFpfHint });
          }
        }
        // 边做边想提示:同样作为上下文参考注入,促模型对照最初设想、必要时就地修订计划。
        if (_pendingReflectHint) {
          currentMessage += '\n\n' + _pendingReflectHint;
          if (Array.isArray(effectiveChatOpts._structuredToolResultBlocks)) {
            effectiveChatOpts._structuredToolResultBlocks.push({ type: 'text', text: _pendingReflectHint });
          }
        }
      }
    }

    currentMessage = _injectSteerIfPresent(currentMessage, getSteerMessages);

    // Flush pending LSP diagnostics into the follow-up message
    if (_pendingLspDiagnostics.length > 0) {
      currentMessage += '\n\n[LSP Diagnostics — compiler/linter errors detected after your edits:]\n' +
        _pendingLspDiagnostics.join('\n');
      _pendingLspDiagnostics = [];
    }

    // ── Post-edit syntax verification ─────────────────────────────────
    // After each iteration where files were modified, run quickSyntaxCheck
    // and inject any errors so the AI can self-correct immediately.
    try {
      const editToolPattern = /^(editFile|edit_file|edit|MultiEdit|multiEdit|multi_edit|write_file|writeFile|scaffoldFiles|apply_patch)$/i;
      const modifiedFiles = toolResults
        .filter(tr => editToolPattern.test(tr.tool) && tr.result?.success)
        .map(tr => tr.params?.file_path || tr.params?.path || tr.params?.filePath)
        .filter(Boolean);
      // Accumulate into the session-level set so the conclude-time
      // verification gate can see every file edited across all iterations.
      for (const f of modifiedFiles) _allModifiedFiles.add(f);
      if (modifiedFiles.length > 0) {
        const { quickSyntaxCheck } = require('./verificationAgent');
        const syntaxResult = quickSyntaxCheck(modifiedFiles, effectiveChatOpts?.cwd || process.cwd());
        if (!syntaxResult.pass && syntaxResult.errors.length > 0) {
          currentMessage += '\n\n[SYNTAX ERRORS — files you just modified have compilation errors. Fix them before proceeding:]\n' +
            syntaxResult.errors.map(e => `  - ${e}`).join('\n');
        }
      }

      // ── CC-parity 用户可见「新增诊断」摘要(加法式,门控 KHY_POST_EDIT_DIAGNOSTICS)──
      // 上面的 [SYNTAX ERRORS] 块是**模型面**自纠(报全部当前错误),原样不动;这里额外产出
      // 一行**用户面**摘要,只报编辑「后有前无」的**新增**诊断(before/after diff,基线由三编辑
      // 工具在写盘前 captureBaseline 打好),对齐 CC DiagnosticsDisplay「Found N new … in M files」。
      // 门控关 → 服务 no-op、这里短路,不发通知(逐字节回退今日行为)。
      try {
        const _ped = require('./postEditDiagnosticsSummary');
        if (modifiedFiles.length > 0 && onToolResult && _ped.postEditDiagnosticsEnabled(process.env)) {
          const _diag = require('./postEditDiagnostics')
            .collectNewDiagnostics(modifiedFiles, effectiveChatOpts?.cwd || process.cwd());
          if (_diag && _diag.issueCount > 0) {
            const _line = _ped.buildPostEditDiagnosticsSummary(
              { issueCount: _diag.issueCount, fileCount: _diag.fileCount }, process.env,
            );
            if (_line) onToolResult('_post_edit_diagnostics', {}, { success: true }, iteration, 0, _line);
          }
        }
      } catch { /* new-diagnostics summary is best-effort; never blocks the loop */ }

      // ── 自维护顾问(AI 正改动 khy 自身源码时,主动双面反馈)──────────────
      // 用户诉求:「khy 在被修改时主动向修改它的 ai 与人反馈,辅助修改而非静默干等」。
      // 只在改动落在 khy monorepo 镜像源根下时出现(emitForPath 严格标记探根,非 khy 工程
      // 静默零反馈)。AI 面 = aiNote 前置进 currentMessage(同 [SYNTAX ERRORS] 手法,随本轮
      // 注入);人面 = onSelfEditAdvisory 回调(消费者投递到 TUI notice / REPL console —— 与
      // 外部监视器路径 §3 共用同一 onAdvisory 汇聚点,单一投递路径)。每文件每轮去重。
      // recordToolEdit 供外部监视器路径(§4)跳过 khy 工具刚写过的文件,避免双重提示。
      // 门控关 KHY_SELF_EDIT_ADVISORY → emitForPath 返 null,整块 no-op 逐字节回退。
      try {
        if (modifiedFiles.length > 0) {
          const _sea = require('./selfEditAdvisoryService');
          const _cwd = effectiveChatOpts?.cwd || process.cwd();
          for (const _f of modifiedFiles) {
            const _abs = require('path').resolve(_cwd, _f);
            _sea.recordToolEdit(_abs); // §4 去重:标记本文件由工具写过
            if (_selfEditAdvised.has(_abs)) continue; // 每文件每轮只提示一次
            const _adv = _sea.emitForPath(_abs, { cwd: _cwd });
            if (!_adv) continue;
            _selfEditAdvised.add(_abs);
            // AI 面:随本轮注入(收尾前照做镜像 + 守卫)
            currentMessage += '\n\n' + _adv.aiNote;
            // 人面:交消费者投递(TUI notice / REPL 清行 console.log)
            if (typeof onSelfEditAdvisory === 'function') onSelfEditAdvisory(_adv);
          }
        }
      } catch { /* self-edit advisory is best-effort; never blocks the loop */ }

      // ── 弱模型改红线/敏感文件顾问(加法式,门控 KHY_WEAK_MODEL_EDIT_GUARD)──────
      // 用户诉求:「避免小模型乱改把 khy 改坏」。上面的 selfEditAdvisory 只在改动落在 khy
      // 自身镜像源根下才出现;这里正交——只看**谁在改**(能力档)与**改了什么**(红线/敏感)。
      // 复用同一双面投递(aiNote 前置进 currentMessage · humanLine 交 onSelfEditAdvisory)。
      // buildWeakModelAdvisory 只在「弱档(T2/T3)碰红线/敏感」时返非 null——khy 常态跑 T0/T1
      // 或改普通文件 → 返 null → 整块静默、零增量(逐字节回退)。事后顾问不硬拦(编辑已发生),
      // 与 selfEditAdvisory 一致的 best-effort 姿态。门控关 → assess 返 null → build 返 null → no-op。
      try {
        if (modifiedFiles.length > 0) {
          const _wmg = require('./weakModelChangeGuard');
          const _wmModel = String((chatOpts && chatOpts.model) || options?.model
            || process.env.GATEWAY_PREFERRED_MODEL || '');
          const _wmTier = _harnessProfile && _harnessProfile.tier;
          const _wmCwd = effectiveChatOpts?.cwd || process.cwd();
          for (const _f of modifiedFiles) {
            const _wmAbs = require('path').resolve(_wmCwd, _f);
            if (_weakModelAdvised.has(_wmAbs)) continue; // 每文件每轮只提示一次
            const _wmAdv = _wmg.buildWeakModelAdvisory(
              { modelId: _wmModel, tier: _wmTier, filePath: _f, changeKind: 'edit', env: process.env });
            if (!_wmAdv) continue; // 强档/普通文件/门关 → 静默
            _weakModelAdvised.add(_wmAbs);
            currentMessage += '\n\n' + _wmAdv.aiNote; // AI 面
            if (typeof onSelfEditAdvisory === 'function') onSelfEditAdvisory(_wmAdv); // 人面(同汇聚点)
          }
        }
      } catch { /* weak-model edit guard is best-effort; never blocks the loop */ }
    } catch { /* syntax check is best-effort */ }

    // Track conversation for capacity flow token estimation
    // Use structured assistant content (text + tool_use blocks) when available
    if (aiResult.reply) {
      let assistantContent = aiResult.reply;
      const _hasToolUse = Array.isArray(aiResult.toolUseBlocks) && aiResult.toolUseBlocks.length > 0;
      const _hasThinking = Array.isArray(aiResult.thinkingBlocks) && aiResult.thinkingBlocks.length > 0;
      if (_hasToolUse || _hasThinking) {
        try {
          const { buildAssistantContent } = require('./contentBlockUtils');
          assistantContent = buildAssistantContent(aiResult.reply, aiResult.toolUseBlocks, aiResult.thinkingBlocks);
        } catch { /* fallback to plain text */ }
      }
      conversationMessages.push({ role: 'assistant', content: assistantContent });
    }
    conversationMessages.push({ role: 'user', content: currentMessage });

    // 工具执行成功后重置 nudge 标志，让下一轮有机会继续
    noToolNudgeUsed = false;

    // ── Capacity Checkpoint 2: Post-Tool ─────────────────────────────
    // After tool execution, check if context expanded dangerously.
    try {
      const _capacityFlow2 = require('./capacityFlow');
      let _estimateTokensFn2;
      try { _estimateTokensFn2 = require('./tokenUsageService').estimateTokens; } catch { /* fallback */ }
      if (typeof _estimateTokensFn2 !== 'function') _estimateTokensFn2 = (text) => Math.ceil((text || '').length / 4);
      // Per-message memo (see site above); + currentMessage (not yet in the array) estimated separately.
      let _usedTokens2;
      try {
        _usedTokens2 = require('./messageTokenTally').sumMessageTokens(conversationMessages, _estimateTokensFn2, process.env)
          + _estimateTokensFn2(currentMessage);
      } catch {
        _usedTokens2 = conversationMessages.reduce(
          (sum, m) => sum + _estimateTokensFn2(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')),
          0
        ) + _estimateTokensFn2(currentMessage);
      }
      const _contextWindow2 = effectiveChatOpts?.contextWindowTokens || parseInt(process.env.KHY_CONTEXT_WINDOW, 10) || 128000;
      const _failedCount = toolResults.filter(tr => tr.result && !tr.result.success).length;
      const postCheck = _capacityFlow2.postToolCheckpoint({
        toolResults,
        usedTokens: _usedTokens2,
        contextWindow: _contextWindow2,
        iterationErrors: _failedCount,
        totalIterations: iteration,
      });
      if (postCheck.decision !== _capacityFlow2.CapacityDecision.None) {
        conversationMessages = _capacityFlow2.applyDecision(
          postCheck.decision,
          conversationMessages,
          { estimateTokens: _estimateTokensFn2, contextWindow: _contextWindow2 }
        );
      }
      // Drive coherence state from post-tool checkpoint
      try {
        const { getCoherenceState } = require('./coherenceState');
        const csm2 = getCoherenceState();
        csm2.transition(postCheck);
        if (postCheck.decision !== _capacityFlow2.CapacityDecision.None) {
          csm2.completeOperation();
        }
      } catch { /* coherence tracking is optional */ }
    } catch { /* best-effort */ }

    // Activity: tools executed successfully, reset idle timer
    if (toolResults.length > 0) {
      lastActivityTime = Date.now();
    }

    // 6. Track read-only iterations (AI only reading without acting)
    // IDLE_READ_ONLY_TOOLS / READ_ONLY_SHELL_CMDS 为模块常量(见文件顶部),避免每迭代重建。
    const allReadOnly = toolResults.length > 0 && toolResults.every(tr => {
      // For shell commands, check if the command is read-only (ls, cat, grep, find, etc.)
      if (tr.tool === 'shell_command' || tr.tool === 'shellCommand') {
        const cmd = (tr.params?.command || '').trim().split(/\s+/)[0];
        return READ_ONLY_SHELL_CMDS.has(cmd);
      }
      return IDLE_READ_ONLY_TOOLS.has(tr.tool);
    });
    if (allReadOnly) {
      consecutiveReadOnlyIterations++;
    } else {
      consecutiveReadOnlyIterations = 0;
    }

    // ── 搜索循环主动收敛(goal 2026-06-25)──────────────────────────────────
    // 「换词搜索、成功却不收口」是现有所有防线都漏接的循环(circuitBreaker 阈值 50 太高、
    // genericRepeat 含 query 永不计数、forced-summary 要模型回空但它一直吐旁白)。这里把
    // 「连续 N 轮纯外部搜索且未综合」纳入主动协助:成功纯搜索轮累加,达 KHY_SEARCH_ROUND_CAP
    // 即强制下一轮禁用工具、基于已检索结果综合作答,而非放任绕圈子到超时。与下方 :5662 的
    // allWebLookupFailed(失败侧重试上限)互斥;复用同一 _forceNoToolsNext 管线。一次性,
    // fail-soft:任何异常即跳过,回落今天行为。currentMessage 此时已是上方 :5324 的 toolResultMsg.text。
    try {
      const _allSearchSucceeded = toolResults.length > 0
        && toolResults.every((tr) => _isWebLookupToolName(tr?.tool) && tr?.result?.success);
      if (_allSearchSucceeded) _searchOnlyRounds++;
      else if (toolResults.length > 0) _searchOnlyRounds = 0;
      if (_allSearchSucceeded) {
        const _gathered = toolCallLog.filter(
          (t) => _isWebLookupToolName(t?.tool) && t?.result?.success
        ).length;
        const _verdict = _searchConvergence.classifySearchLoop({
          searchRounds: _searchOnlyRounds,
          resultsGathered: _gathered,
          alreadyForced: _searchConvergenceForced > 0,
        });
        if (_verdict.converge) {
          _searchConvergenceForced++;
          _searchOnlyRounds = 0;
          _forceNoToolsNext = true;
          currentMessage += _searchConvergence.buildConvergenceDirective({
            searchRounds: _verdict.detail, resultsGathered: _gathered,
          });
          _loopBreadcrumb('search-convergence', { iteration, gathered: _gathered });
        }
      }
    } catch (e) { _tripwire(e, 'loop.searchConvergence'); }

    if (toolResults.length > 0) {
      // Prune old tool outputs to keep memory lean
      _pruneOldToolOutputs(toolCallLog, iteration);

      const succeeded = toolResults.filter(tr => !!tr?.result?.success).length;
      const denied = toolResults.filter(tr => !!tr?.result?.denied).length;
      const deduped = toolResults.filter(tr => !!tr?.result?._deduped).length;
      const failed = Math.max(0, toolResults.length - succeeded - denied);
      // ── Build per-iteration breakdown for rich UI ──
      const _norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]/g, '');
      const _iterBreakdown = {
        reads: toolResults.filter(tr => /^(read|readfile|fileread)$/.test(_norm(tr.tool))).length,
        searches: toolResults.filter(tr => /^(grep|glob|search|find|websearch|webfetch|web_search|explore)$/.test(_norm(tr.tool))).length,
        writes: toolResults.filter(tr => /^(write|writefile|edit|editfile|createfile)$/.test(_norm(tr.tool))).length,
        commands: toolResults.filter(tr => /^(bash|shell|shellcommand)$/.test(_norm(tr.tool))).length,
        agents: toolResults.filter(tr => /^(agent|spawnworker|subagent)$/.test(_norm(tr.tool))).length,
      };
      const _iterElapsed = toolResults.reduce((sum, tr) => sum + (Number(tr.elapsed) || 0), 0);
      const _iterModified = [...new Set(
        toolResults
          .filter(tr => /^(write|writefile|edit|editfile|createfile)$/.test(_norm(tr.tool)))
          .map(tr => tr.params?.file_path || tr.params?.filePath || tr.params?.path || '')
          .filter(Boolean)
      )];
      const _iterSummary = {
        iteration,
        total: toolResults.length,
        succeeded,
        failed,
        denied,
        deduped,
        readOnlyOnly: allReadOnly,
        breakdown: _iterBreakdown,
        elapsedMs: _iterElapsed,
        modifiedFiles: _iterModified,
      };
      // [AI-弱模型·照抄] 每轮推进判决(判定在 roundAdvanceAssessor 纯叶子,这里只做赋值/记录 IO)。
      //   /goal「khy 以每轮对话后任务是否向前推动了一步,来衡量该轮对话的必要性与价值」:吃上面刚算好
      //   的分项,确定性判「推进/停滞/空转」+ 价值档位,附到小结 payload(消费者渲染标签)+ breadcrumb。
      //   门关返 null → 不附字段(逐字节回退到无判决的旧小结);纯观测,不改循环控制流。
      try {
        const _advance = require('./roundAdvanceAssessor').assessRoundAdvance(_iterSummary, process.env);
        if (_advance) {
          _iterSummary.advance = _advance;
          _loopBreadcrumb('round-advance', { iteration, verdict: _advance.verdict, value: _advance.value });
        }
      } catch { /* fail-soft:推进判决绝不反噬主循环 */ }
      emitIterationSummary(_iterSummary);

      // ── onCheckpoint: emit every 3 iterations or 45s ──
      if (typeof onCheckpoint === 'function' &&
          (iteration % 3 === 0 || Date.now() - lastCheckpointTime > 45000)) {
        try {
          onCheckpoint({ iteration, totalToolCalls, toolCallLog: toolCallLog.slice(-20), fileReadHashes });
        } catch { /* best-effort */ }
        lastCheckpointTime = Date.now();
      }

      // All calls deduped → model is stuck repeating the same tool calls.
      // Exit gracefully instead of burning remaining iterations.
      if (deduped > 0 && deduped === toolResults.length) {
        consecutiveDedupIterations++;
        if (consecutiveDedupIterations >= 2) {
          // Find the best result from previous executions to return
          const prevResult = [...executedCallKeys.values()].find(e => e.result?.success);
          const exitMsg = prevResult
            ? (prevResult.result.output || prevResult.result.content || prevResult.result.text || 'Task completed successfully.')
            : 'All tool calls were duplicates of previous successful calls. Task is complete.';
          return {
            finalResponse: typeof exitMsg === 'string' ? exitMsg : JSON.stringify(exitMsg),
            toolCallLog,
            iterations: iteration,
            provider: aiResult?.provider,
            tokenUsage: aiResult?.tokenUsage,
          };
        }
      } else {
        consecutiveDedupIterations = 0;
      }
    }

    // Consecutive failure guardrail — adaptive error handling
    // Instead of a blanket "stop retrying", analyze failure patterns:
    //   - Permission denied → tell AI to skip that tool or ask user
    //   - Unknown tool → tell AI to use a different tool name
    //   - Network error → tell AI the network may be restricted
    //   - Other → only bail out after threshold
    const allFailed = toolResults.length > 0 && toolResults.every(tr =>
      tr.result && !tr.result.success
    );
    if (allFailed) {
      const allWebLookupFailed = toolResults.every((tr) => _isWebLookupToolName(tr?.tool));
      if (allWebLookupFailed) {
        consecutiveWebLookupFailureIterations++;
        consecutiveFailureIterations = 0;
        const keepSearching = consecutiveWebLookupFailureIterations < MAX_WEB_LOOKUP_FAILURES;
        const guidance = keepSearching
          ? 'Web lookup failed in this round. Try one alternative query formulation (more specific keywords) and avoid repeating the same query.'
          : 'Web lookup keeps failing. Stop calling web tools and continue with a best-effort answer from local/context knowledge. Explicitly mark uncertainty for time-sensitive claims.';
        currentMessage = _buildToolResultMessage(toolResults).text
          + '\n\n[SYSTEM: ' + guidance + ']';
        currentMessage = _injectSteerIfPresent(currentMessage, getSteerMessages);
        continue;
      }

      consecutiveFailureIterations++;
      consecutiveWebLookupFailureIterations = 0;

      // ── Capacity Checkpoint 3: Error Escalation ──────────────────
      // On repeated failures, consider resetting context or replanning.
      try {
        const _capacityFlow3 = require('./capacityFlow');
        let _estimateTokensFn3;
        try { _estimateTokensFn3 = require('./tokenUsageService').estimateTokens; } catch { /* fallback */ }
        if (typeof _estimateTokensFn3 !== 'function') _estimateTokensFn3 = (text) => Math.ceil((text || '').length / 4);
        // Per-message memo (see sites above); fail-soft to the original inline reduce.
        let _usedTokens3;
        try {
          _usedTokens3 = require('./messageTokenTally').sumMessageTokens(conversationMessages, _estimateTokensFn3, process.env);
        } catch {
          _usedTokens3 = conversationMessages.reduce(
            (sum, m) => sum + _estimateTokensFn3(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')),
            0
          );
        }
        const _contextWindow3 = effectiveChatOpts?.contextWindowTokens || parseInt(process.env.KHY_CONTEXT_WINDOW, 10) || 128000;
        const _recentErrors = toolResults.map(tr => tr?.result?.error).filter(Boolean);
        const errCheck = _capacityFlow3.errorEscalationCheckpoint({
          consecutiveErrors: consecutiveFailureIterations,
          recentErrors: _recentErrors,
          usedTokens: _usedTokens3,
          contextWindow: _contextWindow3,
        });
        if (errCheck.decision === _capacityFlow3.CapacityDecision.VerifyReplan) {
          // Save canonical state snapshot before resetting context for replan
          try {
            const _canonicalState = require('./canonicalState');
            const snapshot = _canonicalState.buildSnapshot({
              messages: conversationMessages,
              toolCallLog,
              model: effectiveChatOpts?.model,
              workspace: effectiveChatOpts?.cwd || process.cwd(),
            });
            _canonicalState.save(snapshot);
            // Inject snapshot as replan context so the model knows prior state
            const replanPrompt = _canonicalState.formatAsPrompt(snapshot);
            currentMessage += `\n\n${replanPrompt}`;
          } catch { /* canonical state is best-effort */ }
          conversationMessages = _capacityFlow3.applyDecision(
            errCheck.decision,
            conversationMessages,
            { estimateTokens: _estimateTokensFn3, contextWindow: _contextWindow3 }
          );
        }
        // Drive coherence state from error escalation checkpoint
        try {
          const { getCoherenceState } = require('./coherenceState');
          const csm3 = getCoherenceState();
          csm3.transition(errCheck);
          if (errCheck.decision !== _capacityFlow3.CapacityDecision.None) {
            csm3.completeOperation();
          }
        } catch { /* coherence tracking is optional */ }
      } catch { /* best-effort */ }

      // Classify failures for targeted guidance
      const errors = toolResults.map((tr) => {
        const err = tr?.result?.error;
        if (!err) return '';
        if (typeof err === 'string') return err.toLowerCase();
        if (typeof err === 'object') {
          const text = [err.code, err.message, err.hint].filter(Boolean).join(' ');
          return text.toLowerCase();
        }
        return String(err).toLowerCase();
      });
      const hasPermDenied = errors.some(e => e.includes('denied') || e.includes('permission'));
      const hasUnknownTool = errors.some(e => e.includes('unknown tool'));
      const hasNetwork = errors.some(e => e.includes('network') || e.includes('timeout') || e.includes('404') || e.includes('econnrefused'));
      const hasLoopDetected = errors.some(e => e.includes('loopdetector') || e.includes('loop detected'));

      if (consecutiveFailureIterations >= MAX_CONSECUTIVE_FAILURES) {
        // ── 面对未知:放弃前先主动探索一次(提升对未知的鲁棒性)────────────
        // 在「诚实放弃」之前,先判断这串失败是不是撞上了知识盲区(未知工具/陌生
        // 概念/无法归类的错误)。若是,且探索预算未耗尽,就注入一条「先去查清事实」
        // 的指令(列真实工具 / web 检索 / 探查环境),让下一轮带着事实重试,而不是
        // 直接把球踢给用户。有界(_unknownProbesUsed 上限),探索仍失败才回到下面的
        // 放弃链 —— 主动想办法一次,绝不无谓纠缠。
        if (_envFlagEnabled(process.env.KHY_UNKNOWN_EXPLORATION, true)) {
          try {
            const _ue = require('./unknownExploration');
            const _gap = _ue.detectKnowledgeGap({
              errors, hasUnknownTool, hasNetwork,
              consecutiveFailures: consecutiveFailureIterations,
            });
            let _availableTools = [];
            try {
              const _toolsRegistry = require('../tools');
              _availableTools = Array.from(_toolsRegistry.getAll().values())
                .map((t) => ({ name: t && t.name, description: t && t.description }));
            } catch (e) { _tripwire(e, 'loop.unknownProbe.toolList'); /* 降级为无清单,planProbe 仍可走 web/env */ }
            const _probe = _ue.planProbe(_gap, {
              availableTools: _availableTools,
              probesUsed: _unknownProbesUsed,
            });
            if (_probe) {
              _unknownProbesUsed += 1;
              _loopBreadcrumb('nudge-continue', {
                iteration, nudge: 'unknownExploration',
                action: _probe.action, gapType: _gap.gapType,
              });
              consecutiveFailureIterations = 0; // 给这次主动探索一个干净的重试窗口
              currentMessage = _buildToolResultMessage(toolResults).text + '\n\n' + _probe.directive;
              currentMessage = _injectSteerIfPresent(currentMessage, getSteerMessages);
              continue;
            }
          } catch (e) { _tripwire(e, 'loop.unknownExploration'); /* 探索尽力而为;失败则继续走原放弃链 */ }
        }

        // Build context-aware guidance instead of blanket "STOP"
        const hints = [];
        if (hasPermDenied) hints.push('Some tools were denied by the user — skip those tools or ask the user to approve.');
        if (hasUnknownTool) hints.push('Some tool names were not recognized — check available tools and use correct names.');
        if (hasNetwork) hints.push('Network requests are failing — the environment may be offline or restricted. Use local knowledge instead.');
        if (hasLoopDetected) hints.push('Loop detection triggered — change your approach completely.');
        const guidance = hints.length > 0 ? hints.join(' ') : 'Multiple approaches have failed.';

        currentMessage = _buildToolResultMessage(toolResults).text
          + '\n\n[SYSTEM: Tool calls have failed for ' + consecutiveFailureIterations
          + ' consecutive iterations. ' + guidance
          + ' 请坦诚告知用户你目前的能力限制，说明已完成的部分和无法完成的部分，并给出可行的替代建议。不要假装能做到实际做不到的事。]';
        currentMessage = _injectSteerIfPresent(currentMessage, getSteerMessages);
        const summaryResult = await chat(currentMessage, { ...effectiveChatOpts, _isFollowUp: true });
        const summaryText = summaryResult?.reply || 'Tool calls failed repeatedly.';
        return {
          finalResponse: _stripToolCalls(_stripExecutionPlan(summaryText)),
          toolCallLog,
          iterations: iteration,
          provider: summaryResult?.provider || lastResult?.provider,
          tokenUsage: summaryResult?.tokenUsage,
          consecutiveFailureBailout: true,
        };
      }
    } else {
      consecutiveFailureIterations = 0;
      consecutiveWebLookupFailureIterations = 0;
    }

    // ── Grace Call: budget depleted → allow one final summarization turn ──
    if (budget.depleted && budget.graceAvailable) {
      budget.useGrace();
      currentMessage = _buildToolResultMessage(toolResults).text
        + '\n\n[SYSTEM: 迭代预算已用完（' + budget.max + ' 轮）。这是你的最后一轮。'
        + '请总结目前为止完成了什么、还有什么未完成、给出最终回复。不要再调用工具。]';
      currentMessage = _injectSteerIfPresent(currentMessage, getSteerMessages);
      continue;
    }
  }

  // Exceeded max iterations
  const warning = `\n\n${chalk.yellow(`⚠ 已达到最大执行步骤数（${effectiveMaxIterations}）。`)}` +
    `\n${chalk.dim('任务可能尚未完全完成，可以继续发送请求让我接着处理剩余部分。')}`;
  const finalWarningText = _stripToolCalls(_stripExecutionPlan(lastResult?.reply || '')) + warning;
  _emitDeliveryFinalEvent(traceAudit, traceSessionId, diagTraceId, requestId, {
    requestId,
    success: false,
    totalToolCalls,
    finalReplyLength: String(finalWarningText || '').trim().length,
    hasConclusion: _looksLikeDeliveryConclusion(finalWarningText),
    stoppedByLimit: true,
  });
  return {
    finalResponse: finalWarningText,
    toolCallLog,
    iterations: effectiveMaxIterations,
    provider: lastResult?.provider,
    maxIterationsReached: true,
    maxIterations: effectiveMaxIterations,
    transientRecoveries: transientRecoveryUsed,
    conversationMessages,
    harnessProfile: _harnessProfile,
  };

  } finally {
    // 自主执行模式: always restore permissions
    if (_goalModeSavedState) {
      try {
        const goalModeService = require('./goalModeService');
        goalModeService.deactivateIfNeeded(_goalModeSavedState);
      } catch { /* best effort */ }
    }
    // Always cleanup preflight context, even on error
    try {
      const toolCalling = require('./toolCalling');
      toolCalling.clearPreflightContext();
    } catch { /* non-critical */ }
  }
}

// ── Parsing ────────────────────────────────────────────────────────

/**
 * Parse tool calls from AI response text.
 * Supports two formats:
 *   1. <tool_call>tool_name(param1, param2)</tool_call>
 *   2. <tool_call>{"name": "tool", "params": {...}}</tool_call>
 *
 * @param {string} text - AI response text
 * @returns {Array<{name: string, params: object}>}
 */
function _parseToolCalls(text) {
  if (!text) return [];

  const calls = [];

  // ── Fake Tool Wrapper 检测（借鉴 DeepSeek-TUI TOOL_CALL_START_MARKERS） ──
  // 过滤代码块内、解释性短语后的伪造 tool_call 标记
  const _isFakeToolCall = (matchIndex) => {
    const before = text.slice(Math.max(0, matchIndex - 600), matchIndex);
    // 在代码块 (```) 内 → 伪造
    const backtickCount = (before.match(/```/g) || []).length;
    if (backtickCount % 2 === 1) return true; // 奇数个 ``` = 在代码块内
    // 在行内代码 (`) 内 → 伪造
    const linePrefix = before.split('\n').pop() || '';
    const inlineBackticks = (linePrefix.match(/`/g) || []).length;
    if (inlineBackticks % 2 === 1) return true;
    // 前导是解释性短语（如 "例如"、"比如"、"the format is"） → 可疑
    if (/(?:例如|比如|for example|like|the format|such as|示例|样例)\s*[:：]?\s*$/i.test(linePrefix)) {
      return true;
    }
    return false;
  };

  // Format 1: JSON-style tool calls
  const jsonMatches = [...text.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)];
  for (const match of jsonMatches) {
    // Fake tool wrapper 检测
    if (_isFakeToolCall(match.index)) continue;
    try {
      const { safeJsonParse } = require('./gateway/safeJsonParse');
      const parsed = safeJsonParse(match[1], null);
      if (parsed && parsed.name) {
        const normalized = normalizeToolCall(parsed.name, parsed.params || parsed.arguments || {});
        // Avoid only true duplicates (same tool + same params) — 与 Format 2/2b 对称。
        // 弱模型(如 agnes-2.0-flash)会在单次 completion 里把整段输出重复两遍(A+A),
        // 若含 <tool_call>{JSON}</tool_call> 工具调用则产生两个逐字相同的调用;二者落入同一
        // 并行批次、在 executedCallKeys 记录首个之前都读到空 Map → 双双执行(如 local_knowledge
        // 同 query 失败两遍)→ 用户看到「搜索过程重复两次」。Format 2/2b 早有此去重,Format 1
        // 缺失属不对称遗漏;此处补齐(仅折叠精确相同调用,非精确/合法不同参数逐字保留)。
        const sameCallExists = calls.some((c) => (
          c.name === normalized.name
          && JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
        ));
        if (!sameCallExists) {
          calls.push({ name: normalized.name, params: normalized.params });
        }
      }
    } catch { /* skip malformed JSON */ }
  }

  // Format 2: function-call-style tool calls
  // e.g. <tool_call>git_status()</tool_call> or <tool_call>shellCommand(command: "dir")</tool_call>
  const funcMatches = [...text.matchAll(/<tool_call>\s*([\w_]+)\s*\(([\s\S]*?)\)\s*<\/tool_call>/g)];
  for (const match of funcMatches) {
    // Fake tool wrapper 检测
    if (_isFakeToolCall(match.index)) continue;
    const rawName = match[1];
    const argsStr = match[2].trim();

    const params = _parseFunctionArgs(rawName, argsStr);
    const normalized = normalizeToolCall(rawName, params);
    // Avoid only true duplicates (same tool + same params)
    const sameCallExists = calls.some((c) => (
      c.name === normalized.name
      && JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
    ));
    if (sameCallExists) continue;
    calls.push({ name: normalized.name, params: normalized.params });
  }

  // Format 2b: <function=NAME>BODY</function> dialect (open-model / harmony text channel).
  // Primary format — always scanned. Shares the SSOT leaf with toolCallParser.js; arg parsing,
  // normalization and fake-call fence guard reuse this loop's existing helpers.
  try {
    const _fnTag = require('./functionTagToolCall');
    for (const tag of _fnTag.extractFunctionTags(text, process.env)) {
      if (_isFakeToolCall(tag.index)) continue;
      // Nested `<parameter=NAME>VALUE</parameter>` dialect first (harmony / open-model
      // text channel). Without this the args fall through to _parseFunctionArgs's
      // key=value branch, which mis-splits `<parameter=pattern>` into a bogus key and
      // leaks the literal tag into the value → `Invalid tool parameters`
      // (goal 2026-07-11 transcript). Falls back to _parseFunctionArgs for the JSON /
      // key:value / bare-string BODY shapes that dialect doesn't cover.
      const paramTags = _fnTag.parseParameterTags(tag.argsText);
      const params = paramTags || _parseFunctionArgs(tag.name, tag.argsText);
      const normalized = normalizeToolCall(tag.name, params);
      const dup = calls.some((c) => (
        c.name === normalized.name
        && JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
      ));
      if (!dup) calls.push({ name: normalized.name, params: normalized.params });
    }
  } catch { /* leaf missing or gate off → byte-revert (dialect simply unparsed) */ }

  // Format 3: natural-language tool calls from local models
  // e.g. 【调用策略列表：all】 / 【调用回测：symbol=000300 strategy=ma_cross】
  if (calls.length === 0) {
    const naturalSource = _stripExecutionPlan(String(text || ''));
    const naturalCalls = _parseNaturalToolCalls(naturalSource);
    if (naturalCalls.length > 0) {
      return naturalCalls.map((call) => {
        const normalized = normalizeToolCall(call.name, call.params || {});
        return { ...call, name: normalized.name, params: normalized.params };
      });
    }
  }

  // Format 4: 截断 tool_call 修复 — 响应以未闭合的 <tool_call> 结尾
  if (calls.length === 0) {
    const truncM = text.match(/<tool_call>\s*(\{[\s\S]*)$/);
    if (truncM && !_isFakeToolCall(truncM.index)) {
      const fragment = truncM[1].trim();
      if (fragment.length > 15 && /"name"\s*:\s*"/.test(fragment)) {
        try {
          const { safeJsonParse } = require('./gateway/safeJsonParse');
          const repaired = safeJsonParse(fragment, null);
          if (repaired && repaired.name) {
            const norm = normalizeToolCall(repaired.name, repaired.params || repaired.arguments || {});
            calls.push({ name: norm.name, params: norm.params, _repaired: true });
            console.warn('[toolUseLoop] Recovered truncated tool call: %s', norm.name);
          }
        } catch { /* 修复失败 */ }
      }
    }
  }

  // Format 5: UI-prefixed ToolName(args) — 小模型常用格式（训练数据中常见）
  // e.g. ▶ Bash(ls ~/Desktop) / ⌕ Search() / ◆ Write(path="...")
  // Support multiple visual prefixes used by terminal renderers.
  if (calls.length === 0) {
    const prefixedMatches = [...text.matchAll(/[▶⌕◆⏺⎿]\s*([\w_]+)\s*\(([^)]*)\)/g)];
    for (const m of prefixedMatches) {
      if (_isFakeToolCall(m.index)) continue;
      const rawName = m[1];
      const argsStr = m[2].trim();
      const params = argsStr ? _parseFunctionArgs(rawName, argsStr) : {};
      const normalized = normalizeToolCall(rawName, params);
      const dup = calls.some(c => c.name === normalized.name
        && JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {}));
      if (!dup) {
        calls.push({ name: normalized.name, params: normalized.params });
      }
    }
  }

  // Format 6: 裸 ToolName(args) — 独占一行，无 <tool_call> / ▶ 前缀
  // 小模型（如 SenseNova Flash-Lite）直接输出 "Bash()" 或 "Read(/tmp/x)"
  // 渲染器 aiRenderer 已能识别此格式（加 ▶ 显示），但解析侧缺少匹配
  // 安全措施：必须工具名在已知别名中，且行首匹配，避免误捕普通函数调用
  if (calls.length === 0) {
    const _KNOWN_BARE_TOOLS = /^(bash|shell|sh|command|read|readfile|write|writefile|edit|editfile|grep|rg|glob|find|ls|websearch|webfetch|search|agent|task)$/i;
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const stripped = lines[li].replace(/^\s*[>│┃├└╰❯▸›•*-]+\s*/u, '').trim();
      if (!stripped) continue;
      const bm = stripped.match(/^([A-Za-z][A-Za-z0-9_]{0,24})\s*\(([\s\S]*)\)\s*$/);
      if (!bm) continue;
      const rawName = bm[1];
      const rawArgs = bm[2].trim();
      // 只接受已知工具名
      if (!_KNOWN_BARE_TOOLS.test(rawName)) continue;
      // 代码块内跳过
      const textBefore = lines.slice(0, li).join('\n');
      if ((textBefore.match(/```/g) || []).length % 2 === 1) continue;
      const params = rawArgs ? _parseFunctionArgs(rawName, rawArgs) : {};
      const normalized = normalizeToolCall(rawName, params);
      const dup = calls.some(c => c.name === normalized.name
        && JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {}));
      if (!dup) {
        calls.push({ name: normalized.name, params: normalized.params });
      }
    }
  }

  // Format 7: JSON in markdown code block — weak models (minimax, qwen-small) wrap
  // tool calls in ```json or ```tool_call fences:
  //   ```json\n{"name":"Bash","arguments":{"command":"ls"}}\n```
  //   ```\n{"name":"Read","parameters":{"file_path":"/tmp"}}\n```
  if (calls.length === 0) {
    const codeBlockMatches = [...text.matchAll(/```(?:json|tool_call|tool|function)?\s*\n(\{[\s\S]*?\})\s*\n```/g)];
    for (const m of codeBlockMatches) {
      if (_isFakeToolCall(m.index)) continue;
      try {
        const { safeJsonParse } = require('./gateway/safeJsonParse');
        const parsed = safeJsonParse(m[1], null);
        if (parsed && parsed.name && typeof parsed.name === 'string') {
          const params = parsed.arguments || parsed.parameters || parsed.params || parsed.input || {};
          const normalized = normalizeToolCall(parsed.name, params);
          const dup = calls.some(c => c.name === normalized.name
            && JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {}));
          if (!dup) calls.push({ name: normalized.name, params: normalized.params });
        }
      } catch { /* skip malformed */ }
    }
  }

  // Format 8: 截断裸工具调用 — 模型输出 "Bash(" 或 "Read(/tmp" 但括号未闭合
  // (was Format 7, renumbered after JSON code block format insertion)
  // 这是 max_tokens 截断的常见表现，尤其在低阶模型 + 4096 token 限制下
  if (calls.length === 0) {
    const _KNOWN_TRUNC = /^(bash|shell|read|readfile|write|writefile|edit|editfile|grep|glob|find|ls|websearch|webfetch|search)$/i;
    const lastLines = text.split('\n').slice(-5);
    for (const line of lastLines) {
      const stripped = line.replace(/^\s*[>│┃├└╰❯▸›•*-]+\s*/u, '').trim();
      const tm = stripped.match(/^([A-Za-z][A-Za-z0-9_]{0,24})\s*\(([^)]*?)$/);
      if (!tm) continue;
      const rawName = tm[1];
      if (!_KNOWN_TRUNC.test(rawName)) continue;
      // 代码块内跳过
      const textBefore = text.slice(0, text.lastIndexOf(line));
      if ((textBefore.match(/```/g) || []).length % 2 === 1) continue;
      const argsStr = tm[2].trim();
      const params = argsStr ? _parseFunctionArgs(rawName, argsStr) : {};
      const normalized = normalizeToolCall(rawName, params);
      calls.push({ name: normalized.name, params: normalized.params, _repaired: true });
      console.warn('[toolUseLoop] Recovered truncated bare tool call: %s', normalized.name);
      break; // 只修复最后一个截断调用
    }
  }

  return calls;
}

function _parseNaturalToolCalls(text) {
  if (!text) return [];
  const out = [];
  const src = String(text);

  const matches = [...src.matchAll(/【\s*调用\s*([^：:\]】\n]{1,32})\s*(?:[：:]\s*([^】]*?))?\s*】/g)];
  for (const m of matches) {
    // Lenient line-prefix check: allow 【调用】 anywhere in the line.
    // Only skip if the prefix looks like a plan description header
    // (e.g. inside a markdown code block or deeply nested structure).
    const linePrefix = src.slice(0, m.index || 0).split('\n').pop() || '';
    const inCodeBlock = /```/.test(src.slice(Math.max(0, (m.index || 0) - 500), m.index));
    if (inCodeBlock) continue;

    const rawAction = String(m[1] || '').trim();
    const rawArg = String(m[2] || '').trim();
    const toolName = _mapNaturalActionToTool(rawAction);
    if (!toolName) continue;

    // Relaxed tail check: allow most trailing text.
    // Only skip if it looks like a plan-description line with significant
    // natural-language explanation after the tag AND the tool is not an action tool.
    const endIdx = (m.index || 0) + m[0].length;
    const tail = src.slice(endIdx).split('\n')[0].trim();
    const allowTailForActionTool = (toolName === 'open_app' || toolName === 'shell_command'
      || toolName === 'write_file' || toolName === 'read_file' || toolName === 'editFile');
    // Only skip if tail is a long CJK explanation (>15 chars), suggesting a plan description
    if (!allowTailForActionTool && tail.length > 15 && !/^[，,。.!！?？:：;；\s]*$/.test(tail)) continue;

    const params = _buildNaturalToolParams(toolName, rawArg);
    out.push({ name: toolName, params, natural: true, rawAction, rawArg });
  }

  return out;
}

function _mapNaturalActionToTool(action) {
  const raw = String(action || '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/\s+/g, '');
  if (NATURAL_ACTION_TO_TOOL[key]) return NATURAL_ACTION_TO_TOOL[key];
  if (NATURAL_ACTION_TO_TOOL[raw]) return NATURAL_ACTION_TO_TOOL[raw];

  // Fuzzy fallback for slight phrasing differences
  if (/(回测|backtest)/i.test(raw)) return 'backtest';
  if (/(k线|kline|日线|周线|月线|分钟线)/i.test(raw)) return 'data_fetch';
  if (/(策略|strategy)/i.test(raw)) return 'strategy_list';
  if (/(行情|报价|价格|quote|price)/i.test(raw)) return 'quote';
  if (/(搜索|search|web)/i.test(raw)) return 'web_search';
  if (/(读取|read)/i.test(raw)) return 'read_file';
  if (/(写入|write)/i.test(raw)) return 'write_file';
  if (/(脚手架|scaffold|创建项目|项目结构|目录结构|批量创建|并行写入)/i.test(raw)) return 'scaffoldFiles';
  if (/(命令|shell|bash|terminal|cmd)/i.test(raw)) return 'shell_command';
  if (/(打开|启动|运行|应用|程序|浏览器|open|launch|run)/i.test(raw)) return 'open_app';
  if (/(git状态|gitstatus)/i.test(raw)) return 'git_status';
  if (/(git差异|gitdiff)/i.test(raw)) return 'git_diff';
  return null;
}

function _parseLooseKv(argText = '') {
  const out = {};
  const s = String(argText || '').trim();
  if (!s) return out;
  const parts = s.split(/[\s,，]+/).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z_]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function _cleanParams(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
}

function _buildNaturalToolParams(toolName, argText) {
  const raw = String(argText || '').trim();
  const kv = _parseLooseKv(raw);

  if (toolName === 'strategy_list' || toolName === 'git_status') return {};

  if (toolName === 'quote') {
    return _cleanParams({ symbol: kv.symbol || kv.code || raw });
  }

  if (toolName === 'backtest') {
    const firstToken = raw.split(/\s+/).filter(Boolean)[0];
    return _cleanParams({
      symbol: kv.symbol || kv.code || firstToken || '000300',
      strategy: kv.strategy,
      start: kv.start,
      end: kv.end,
      capital: kv.capital !== undefined ? _coerceValue(String(kv.capital)) : undefined,
    });
  }

  if (toolName === 'data_fetch') {
    const parts = raw.split(/\s+/).filter(Boolean);
    return _cleanParams({
      symbol: kv.symbol || kv.code || parts[0] || '000001',
      period: kv.period || parts[1],
    });
  }

  if (toolName === 'search') {
    return _cleanParams({ keyword: kv.keyword || raw });
  }

  if (toolName === 'web_search') {
    return _cleanParams({ query: kv.query || kv.keyword || raw || '最新市场信息' });
  }

  if (toolName === 'read_file') {
    return _cleanParams({ path: raw.replace(/^\/+/, '') });
  }

  if (toolName === 'write_file') {
    const [filePath, ...rest] = raw.split('|');
    return _cleanParams({
      path: (filePath || '').trim(),
      content: rest.join('|').trim(),
    });
  }

  if (toolName === 'shell_command') {
    return _cleanParams({ command: raw });
  }

  if (toolName === 'open_app') {
    return _cleanParams({ name: raw || kv.name || kv.app || kv.application });
  }

  if (toolName === 'git_diff') {
    return raw ? _cleanParams({ file: raw }) : {};
  }

  return {};
}

/**
 * Parse function-call-style arguments into an object.
 * Maps positional args to parameter names based on tool schema.
 *
 * @param {string} toolName
 * @param {string} argsStr - Raw argument string
 * @returns {object}
 */
function _parseFunctionArgs(toolName, argsStr) {
  if (!argsStr) return {};

  // Try JSON parse first (e.g. {"symbol": "sh600519"} or {"command": "dir"})
  try {
    if (argsStr.startsWith('{')) {
      return JSON.parse(argsStr);
    }
  } catch { /* fall through */ }

  // Try key: "value" pairs (AI often uses this format, e.g. command: "dir /b", cwd: "D:\\")
  const kvColonRe = /(\w+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^,)]+))/g;
  let kvMatch;
  const colonParams = {};
  let hasColonPairs = false;
  while ((kvMatch = kvColonRe.exec(argsStr)) !== null) {
    hasColonPairs = true;
    // Quoted values (groups 2/3) stay as strings; unquoted (group 4) get type coercion
    if (kvMatch[2] !== undefined) {
      colonParams[kvMatch[1]] = kvMatch[2];
    } else if (kvMatch[3] !== undefined) {
      colonParams[kvMatch[1]] = kvMatch[3];
    } else {
      colonParams[kvMatch[1]] = _coerceValue((kvMatch[4] ?? '').trim());
    }
  }
  if (hasColonPairs) return colonParams;

  // Try key=value pairs (e.g. symbol=sh600519, staged=true)
  if (argsStr.includes('=')) {
    const params = {};
    const pairs = argsStr.split(',').map(s => s.trim());
    for (const pair of pairs) {
      const [key, ...rest] = pair.split('=');
      const value = rest.join('=').trim().replace(/^["']|["']$/g, '');
      params[key.trim()] = _coerceValue(value);
    }
    return params;
  }

  // Positional argument: map to the first required parameter
  try {
    const toolRegistry = require('../tools');
    const normalized = normalizeToolCall(toolName, {}).name || toolName;
    const tool = toolRegistry.get(normalized);
    if (tool && tool.inputSchema) {
      const firstRequired = Object.entries(tool.inputSchema)
        .find(([, rule]) => rule.required);
      if (firstRequired) {
        return { [firstRequired[0]]: argsStr.replace(/^["']|["']$/g, '') };
      }
    }
  } catch { /* registry not available */ }

  // Fallback: use 'command' as the default param (most common tool)
  return { command: argsStr.replace(/^["']|["']$/g, '') };
}

/**
 * Coerce string values to appropriate JS types.
 */
function _coerceValue(str) {
  if (str === 'true') return true;
  if (str === 'false') return false;
  if (str === 'null') return null;
  const num = Number(str);
  if (!isNaN(num) && str !== '') return num;
  return str;
}

// ── Formatting ─────────────────────────────────────────────────────

/**
 * Steer 注入辅助函数 — 将用户方向修正消息追加到 currentMessage。
 * 从 getSteerMessages 回调拉取并清空 steer 队列。
 * @param {string} currentMessage
 * @param {function|undefined} getSteerMessages - () => string[]
 * @returns {string} 可能追加了 steer 块的 currentMessage
 */
function _injectSteerIfPresent(currentMessage, getSteerMessages) {
  if (typeof getSteerMessages !== 'function') return currentMessage;
  try {
    const steerMsgs = getSteerMessages();
    if (!Array.isArray(steerMsgs) || steerMsgs.length === 0) return currentMessage;
    const block = steerMsgs.map(m => String(m || '').trim()).filter(Boolean).join('\n');
    if (!block) return currentMessage;
    return currentMessage + `\n\n[用户方向修正 — 请仔细阅读并调整后续方案]\n${block}\n[方向修正结束]`;
  } catch { return currentMessage; }
}

/** Normalize a tool name for matching ("ask_user" / "Ask User" → "askuser"). */
function _normToolName(n) {
  return String(n || '').toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Read an allow/deny decision out of an onControlRequest response. Delegates to
 * the canonical toolCalling._decisionFromControl so the execApproval path honors
 * the SAME resolution payloads every host emits — primitives (`true`, `'always'`)
 * AND the {behavior} object shape. The Ink PermissionsPrompt resolves "允许本次"
 * as the boolean `true` and "免审/始终允许" as the string `'always'`; a parser
 * that only accepted objects (the previous local implementation) mis-read those
 * as deny, so a TUI approval still produced "[ExecApproval] Approval required".
 * Returns 'allow' or 'deny'. Defaults to 'deny' (fail-closed) when the response
 * is missing or unreadable — an absent channel must never silently permit.
 */
function _readControlDecision(resp) {
  try {
    const decision = require('./toolCalling')._decisionFromControl(resp);
    return (decision === 'allow' || decision === 'allow-always') ? 'allow' : 'deny';
  } catch {
    // Fallback: toolCalling unavailable — tolerate primitives + object shape inline.
    if (resp === true) return 'allow';
    if (!resp || typeof resp !== 'object') return 'deny';
    let node = resp;
    if (node.type === 'control_response' && node.response) node = node.response;
    const inner = (node.response && typeof node.response === 'object') ? node.response : node;
    const behavior = inner.behavior || node.behavior;
    return behavior === 'allow' ? 'allow' : 'deny';
  }
}

/**
 * Resolve an execApproval verdict for a shell command, connecting the ask-state
 * to the host approval channel (onControlRequest). Returns 'allow' | 'deny'.
 *
 * Contract (s03 permission pipeline, defect ①):
 *   - allowed:true                      → 'allow' (hard allow, unchanged)
 *   - no requestId                      → 'deny'  (hard deny, unchanged)
 *   - ask-state (requestId present):
 *       · escape valve open             → decide('approved') + stamp token + 'allow'
 *         (KHY_EXEC_APPROVAL=off | dangerousMode | yolo profile)
 *       · no onControlRequest channel   → fail-closed: decide('denied') + 'deny'
 *       · channel says allow            → decide('approved') + stamp token + 'allow'
 *       · channel says deny / unreadable→ decide('denied') + 'deny'
 *
 * The EXEC_APPROVED Symbol token stamped onto call.params short-circuits the
 * downstream canonical gate (toolCalling.requestPermission) so an already
 * approved command is not prompted twice. A Symbol key cannot be forged by the
 * model through JSON params.
 */
async function _resolveExecApproval(call, approval, onControlRequest, signal) {
  if (approval.allowed === true) return 'allow';
  if (!approval.requestId) return 'deny';

  const requestId = approval.requestId;
  let execApprovalMod = null;
  try { execApprovalMod = require('./execApproval'); } catch { execApprovalMod = null; }
  const mgr = execApprovalMod && execApprovalMod.execApproval;
  const EXEC_APPROVED = execApprovalMod && execApprovalMod.EXEC_APPROVED;

  const _stampAllow = () => {
    if (mgr) { try { mgr.decide(requestId, 'approved', { decidedBy: 'escape_valve' }); } catch { /* best-effort */ } }
    if (EXEC_APPROVED && call.params && typeof call.params === 'object') call.params[EXEC_APPROVED] = true;
    return 'allow';
  };
  const _stampDeny = (by) => {
    if (mgr) { try { mgr.decide(requestId, 'denied', { decidedBy: by || 'fail_closed' }); } catch { /* best-effort */ } }
    return 'deny';
  };

  // Escape valves — keep non-interactive environments (CI / WS fire-and-forget
  // / subagent) usable. permissionLevel defaults to ask, so without these the
  // fail-closed branch would reject every risk command.
  let yolo = false;
  try { yolo = require('./permissionStore').getProfile() === 'yolo'; } catch { /* optional */ }
  let dangerous = false;
  try { dangerous = require('./toolCalling').isDangerousMode(); } catch { /* optional */ }
  if (process.env.KHY_EXEC_APPROVAL === 'off' || dangerous || yolo) {
    return _stampAllow();
  }

  // No approval channel → fail-closed. Content-related ask is un-bypassable.
  if (typeof onControlRequest !== 'function') return _stampDeny('no_channel');

  let ctrlResp = null;
  try {
    // Race against abort so a never-settling approval prompt (orphaned overlay,
    // ESC, interrupt) can't park the loop forever. Gated KHY_CONTROL_REQUEST_GUARD
    // (default on); off → raw promise. On abort/timeout → null → fail-closed deny.
    ctrlResp = await require('./controlRequestGuard').guardControlRequest(
      onControlRequest({
        requestId: `exec_${requestId}`,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'shell_command',
          input: { command: call.params?.command, risk: approval.risk, reason: approval.reason },
        },
      }),
      { signal: signal || null, env: process.env },
    );
  } catch { ctrlResp = null; }

  if (_readControlDecision(ctrlResp) === 'allow') return _stampAllow();
  return _stampDeny('user_denied');
}

/**
 * Read AskUserQuestion answers out of an onControlRequest response. Tolerant of
 * the several shapes a host handler may return:
 *   - REPL handleControlRequest: { subtype:'success', response:{ behavior, updatedInput:{ answers } } }
 *   - bare SDK payload:          { behavior, updatedInput:{ answers } }
 *   - full envelope:             { type:'control_response', response:{ response:{ behavior, updatedInput } } }
 * Returns { answers } on allow, { denied:true } on deny, or {} when unreadable.
 */
function _readControlAnswers(resp) {
  if (!resp || typeof resp !== 'object') return {};
  let node = resp;
  if (node.type === 'control_response' && node.response) node = node.response;
  const inner = (node.response && typeof node.response === 'object') ? node.response : node;
  const behavior = inner.behavior || node.behavior;
  if (behavior === 'deny') return { denied: true };
  const ui = inner.updatedInput
    || node.updatedInput
    || (inner.response && inner.response.updatedInput);
  if (ui && ui.answers && typeof ui.answers === 'object') return { answers: ui.answers };
  return {};
}

/**
 * Extract meaningful output from a tool result object.
 * Tools return results in many different field names — this function
 * checks known fields first, then falls back to JSON.stringify of all
 * non-meta fields so nothing is silently lost.
 */
function _extractToolOutput(result) {
  if (!result || typeof result !== 'object') return result;

  // Safety net: if content is an MCP-style array [{type:"text", text:...}] that
  // somehow bypassed normalization, extract text instead of returning the raw array.
  if (Array.isArray(result.content) && result.content.length > 0) {
    const first = result.content[0];
    if (first && typeof first === 'object' && (first.type === 'text' || first.type === 'image' || first.type === 'resource')) {
      const texts = result.content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text);
      if (texts.length > 0) return texts.join('\n');
      // Images/resources only — return placeholder
      return result.content.map(b => `[${b.type}]`).join(', ');
    }
  }

  // Priority 1: well-known text output fields
  const direct = result.output || result.content || result.result;
  if (direct != null && direct !== '') return direct;

  // Priority 2: common structured data fields
  const structured = result.message || result.answer || result.data
    || result.matches || result.files || result.results
    || result.locations || result.diagnostics || result.resources
    || result.skills || result.task || result.hover || result.symbols
    || result.items || result.edits || result.actions || result.signatures
    || result.counts || result.entries || result.selected;
  if (structured != null && structured !== '') return structured;

  // Priority 3: fall back to JSON of all non-meta fields
  // (strip success, _internal fields, and error to avoid noise)
  const payload = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'success' || k === 'error' || k.startsWith('_')) continue;
    if (v != null && v !== '' && v !== false) payload[k] = v;
  }
  if (Object.keys(payload).length > 0) return JSON.stringify(payload);

  return null;
}

/**
 * Try to get the active model's context window size from the gateway.
 * Returns 0 if unavailable.
 */
function _getActiveModelContextWindow() {
  try {
    const { serviceRegistry } = require('./serviceRegistry');
    const gateway = serviceRegistry?.get?.('gateway');
    if (!gateway) return 0;
    const info = gateway.getActiveAdapterInfo?.() || gateway.getModelInfo?.() || {};
    return Number(info.contextWindow || info.context_window || info.maxContext || 0);
  } catch { return 0; }
}


// ── Tail helpers isolated in a sibling module (god-file split) ──
// Import the helper surface this core calls, then inject the core-defined bindings the helpers read.
// Both run at core load, before runToolUseLoop is ever invoked, so the relocated bodies stay byte-identical.
const {
  _appLaunchInterruptPrecedenceEnabled, _appLaunchRecovery, _buildAppLaunchToolNudge, _buildChoiceResponseNudge,
  _buildConstraintFallbackReply, _buildConstraintRespectNudge, _buildDeliverySummary, _buildNoToolCallNudge,
  _buildScaffoldToolNudge, _buildSearchQueryCandidates, _buildToolResultMessage, _buildUserToolConstraintDirective,
  _buildWebSearchToolNudge, _capabilityAssess, _captureWriteFileDiffContext, _deliveryFormatter,
  _emitDeliveryFinalEvent, _extractAppTargetFromUserMessage, _extractScaffoldSpecFromMessage, _extractUserToolConstraints,
  _filterToolCallsByIntent, _finalizeWriteDiff, _getLinuxCommandHint, _getWindowsCommandHint,
  _injectKeyFindingsPrompt, _injectPlanningPrompt, _intentHeuristics, _isComplexTask,
  _isShellToolName, _isWebLookupToolName, _looksLikeActionRequest, _looksLikeAppLaunchRequest,
  _looksLikeCannedRefusal, _looksLikeChoiceResponse, _looksLikeDeliveryConclusion, _looksLikeInfoSearchRequest,
  _looksLikeProgressOnlyReply, _looksLikeProjectScaffoldRequest, _looksLikeToolOutputEcho, _matchBlockedToolConstraint,
  _matchToolCallToStep, _matchesShellDispatchName, _modelTier, _parseExecutionPlan,
  _patchEmptyLocalSearchKeyword, _patchEmptySearchQuery, _patchEmptyShellCommand, _platformRewrite,
  _proactivePlatformRewrite, _pruneOldToolOutputs, _recoverOpenAppAfterAiInterruption, _recoverOpenAppAfterShellFailure,
  _recoverWebSearchAfterShellFailure, _refusalStatesConcreteReason, _replyIsUnsynthesizedListing, _rewriteShellCallsForAppLaunch,
  _safeReadForDiff, _sanitizeSearchSourceMessage, _scaffoldExtractor, _shouldAutoDecompose,
  _stripExecutionPlan, _stripToolCalls, _taskComplexity, _toolCallNudges,
  _toolCallParser, isEnabled, maybeAttachCognitiveObserver, maybeForgeStructuredIntent,
} = require('./toolUseLoopHelpers');
require('./toolUseLoopHelpers').setToolUseLoopHelpersDeps({
  _APP_TARGET_PROBE_BINS, _SEARCH_TERM_STOPWORDS, _parsePositiveInt,
  _resolveAutoWebSearchMode, _extractToolOutput, _getActiveModelContextWindow,
});

module.exports = {
  // Core loop (remains in this file)
  runToolUseLoop,
  isEnabled,

  // 用户约束闸门:被禁工具名匹配(纯查询),导出供单测。
  _matchBlockedToolConstraint,

  // cognitiveSnapshot observe-mode 接线（DESIGN-ARCH-035）— 导出供接线测试
  maybeAttachCognitiveObserver,
  MAX_ITERATIONS,
  MAX_ELAPSED_MS_DEFAULT,
  _resolveMaxIterations,
  _resolveMaxElapsedMs,
  _formatDurationMs,

  // Pseudo-refusal detection (problem #3: 工具取回数据后却套话拒绝)
  _looksLikeCannedRefusal,
  _refusalStatesConcreteReason,

  // 批1 — stop_reason 信任: normalization + native-only trust gate, exported for unit testing.
  _normalizeStopReason,
  _shouldTrustStopReason,

  // 无感续写 — 瞬时续写预算解析(门控 KHY_SEAMLESS_RESUME 抬升短任务地板),导出供单测。
  _resolveTransientRecoveryMax,

  // Raw-data salvage (render-boundary SafeResponse reuses this single source so
  // an empty finalResponse degrades to the gathered tool content, never silence)
  _salvageToolResults,

  // Non-invasive outcome reflection: single-source narration as a model-facing
  // context reference (goal 2026-06-24), exported for unit testing.
  _buildOutcomeReflectionHint,

  // 关键节点主动汇报：findings 提示词注入器 + 共享的标签剥离接缝，导出供单测。
  _injectKeyFindingsPrompt,
  _stripExecutionPlan,

  // Cross-turn repeat guard (「此路不通不换一条」fix): pure decision + signature
  // normalization, exported for unit testing. The guard steers a model that
  // re-issues a call already succeeded in recent turns to answer-from-context
  // or switch approach instead of silently re-running it.
  crossTurnRepeatDecision,
  _normalizeRecentSignatures,
  _signatureForCall,

  // Write-diff capture (red/green ± diff rendering; pre-write snapshot + post-write read)
  _captureWriteFileDiffContext,
  _finalizeWriteDiff,
  _safeReadForDiff,

  // Re-exports: toolCallParser (Phase 1G)
  _parseToolCalls: _toolCallParser.parseToolCalls,

  // Re-exports: deliveryFormatter (Phase 1F)
  _stripToolCalls: _deliveryFormatter.stripToolCalls,
  _buildToolResultMessage: _deliveryFormatter.buildToolResultMessage,
  _injectSteerIfPresent: _deliveryFormatter.injectSteerIfPresent,

  // Re-exports: taskComplexity (Phase 1D)
  _isComplexTask: _taskComplexity.isComplexTask,
  _shouldAutoDecompose: _taskComplexity.shouldAutoDecompose,
  _parseExecutionPlan: _taskComplexity.parseExecutionPlan,
  _matchToolCallToStep: _taskComplexity.matchToolCallToStep,

  // Re-exports: capabilityAssessment (Phase 1H)
  _loadCapabilityPolicy: _capabilityAssess.loadCapabilityPolicy,
  _assessExecutionCapability: _capabilityAssess.assessExecutionCapability,

  // Re-exports: intentHeuristics (Phase 1E)
  _looksLikeInfoSearchRequest: _intentHeuristics.looksLikeInfoSearchRequest,
  _extractUserToolConstraints: _intentHeuristics.extractUserToolConstraints,
  _looksLikeProjectScaffoldRequest: _intentHeuristics.looksLikeProjectScaffoldRequest,
  _sanitizeSearchSourceMessage: _intentHeuristics.sanitizeSearchSourceMessage,
  _resolveAutoWebSearchMode: _intentHeuristics.resolveAutoWebSearchMode,
  _buildSearchQueryCandidates: _intentHeuristics.buildSearchQueryCandidates,
  _looksLikeAppLaunchRequest: _intentHeuristics.looksLikeAppLaunchRequest,
  _extractAppTargetFromUserMessage: _intentHeuristics.extractAppTargetFromUserMessage,

  // Re-exports: scaffoldExtractor (Phase 1C)
  _extractScaffoldSpecFromMessage: _scaffoldExtractor.extractScaffoldSpecFromMessage,

  // Re-exports: appLaunchRecovery (Phase 1I)
  _recoverWebSearchAfterShellFailure: _appLaunchRecovery.recoverWebSearchAfterShellFailure,
  _filterToolCallsByIntent: _appLaunchRecovery.filterToolCallsByIntent,
  _buildConstraintRespectNudge: _appLaunchRecovery.buildConstraintRespectNudge,
  _rewriteShellCallsForAppLaunch: _appLaunchRecovery.rewriteShellCallsForAppLaunch,

  // Re-exports: platformRewrite (Phase 1A)
  _proactivePlatformRewrite: _platformRewrite.proactivePlatformRewrite,

  // Empty-param patch name matching (R4: KHY_PATCH_TOOLNAME_NORMALIZE), exported for unit testing.
  _patchEmptyShellCommand,
  _patchEmptySearchQuery,
  _isShellToolName,
  _matchesShellDispatchName,

  // Re-exports: toolCallNudges (Phase 1B)
  _buildAppLaunchToolNudge: _toolCallNudges.buildAppLaunchToolNudge,
  _buildChoiceResponseNudge: _toolCallNudges.buildChoiceResponseNudge,
  _buildNoToolCallNudge: _toolCallNudges.buildNoToolCallNudge,
  _buildWebSearchToolNudge: _toolCallNudges.buildWebSearchToolNudge,
  _buildScaffoldToolNudge: _toolCallNudges.buildScaffoldToolNudge,

  // Known-tool-name memo (Ch2) — exported for unit testing. Not used in production paths.
  _computeKnownToolNames,
  _resolveKnownToolNames,
  _knownNameCacheKey,
  _knownNameMemoSize: () => _knownNameCache.size,
  _resetKnownNameMemo: () => _knownNameCache.clear(),

  // Enabled-tool-name-set memo (Ch2) — exported for unit testing. Not used in production paths.
  _buildEnabledToolNameSet,
  _collectEnabledToolNameSet,
  _enabledNameSetCacheKey,
  _enabledNameSetMemoSize: () => _enabledNameSetCache.size,
  _resetEnabledNameSetMemo: () => _enabledNameSetCache.clear(),

  // Read-only membership sets hoisted to module scope (Ch2) — exported for unit
  // testing. Byte-identical to the former per-call literals; consumed read-only.
  _DEDUP_READ_ONLY_TOOLS: DEDUP_READ_ONLY_TOOLS,
  _IDLE_READ_ONLY_TOOLS: IDLE_READ_ONLY_TOOLS,
  _READ_ONLY_SHELL_CMDS: READ_ONLY_SHELL_CMDS,
  _AUTO_WEB_SEARCH_MODES: _AUTO_WEB_SEARCH_MODES,
  _DELIVERY_NUDGE_STOPWORDS: _DELIVERY_NUDGE_STOPWORDS,
  _APP_TARGET_PROBE_BINS: _APP_TARGET_PROBE_BINS,
  _SEARCH_TERM_STOPWORDS: _SEARCH_TERM_STOPWORDS,
};
