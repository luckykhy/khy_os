/**
 * CLI Command Router — parses user input, resolves aliases & symbols,
 * dispatches to handlers or user plugins.
 *
 * All heavy modules are lazy-loaded for fast cold start.
 */
const path = require('path');
const { createRouterHandlers } = require('./routerHandlers');
const {
  getRouterCommandNames,
  getRouterSubCommands,
  getStaticSlashCommands,
} = require('../constants/commandSchema');

// ── Levenshtein 编辑距离（G1 拼写纠错） ──
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * 在已注册命令中查找与 input 编辑距离 ≤ maxDist 的最佳候选。
 * 同时搜索主命令和「主命令 子命令」组合。
 * @returns {Array<{label: string, dist: number}>} 最多 3 个，按距离升序
 */
function _findClosestCommands(input, maxDist = 2) {
  const lower = input.toLowerCase().replace(/^\//, '');
  const candidates = [];

  // 1) 主命令
  const allKeys = [...COMMANDS, ...aliases().getAllAliasKeys()];
  for (const key of new Set(allKeys)) {
    const k = key.toLowerCase().replace(/^\//, '');
    const d = _levenshtein(lower, k);
    if (d > 0 && d <= maxDist) candidates.push({ label: key, dist: d });
  }

  // 2) 「主命令 子命令」组合（仅在输入含空格或主命令无匹配时）
  const parts = lower.split(/\s+/);
  if (parts.length >= 2) {
    const cmdPart = parts[0];
    const subPart = parts.slice(1).join(' ');
    for (const [cmd, subs] of Object.entries(SUB_COMMANDS)) {
      const cmdDist = _levenshtein(cmdPart, cmd);
      if (cmdDist > maxDist) continue;
      for (const sub of subs) {
        const subDist = _levenshtein(subPart, sub);
        const total = cmdDist + subDist;
        if (total > 0 && total <= maxDist + 1) {
          candidates.push({ label: `${cmd} ${sub}`, dist: total });
        }
      }
    }
  }

  // 去重 + 排序 + 取前 3
  const seen = new Set();
  return candidates
    .sort((a, b) => a.dist - b.dist)
    .filter(c => { if (seen.has(c.label)) return false; seen.add(c.label); return true; })
    .slice(0, 3);
}

// ── Lazy module loaders ──
let _fmt, _chalk, _aliases, _symbolResolver, _plugins;
const fmt = () => (_fmt ??= require('./formatters'));
const chk = () => {
  if (_chalk) return _chalk;
  const chalkModule = require('chalk');
  _chalk = chalkModule.default || chalkModule;
  return _chalk;
};
const aliases = () => (_aliases ??= require('./aliases'));
const symResolver = () => (_symbolResolver ??= require('./symbolResolver'));
const plugins = () => (_plugins ??= require('./plugins'));

// getCompletions 的 allKeys 惰性构造门控(斜杠路径不用 allKeys,却每次按键/每次 Tab 白构造)。
let _completionKeysLazy;
const completionKeysLazy = () => (_completionKeysLazy ??= require('./completionKeysLazy'));

// CC 后端口径对齐:字节数 → 人类可读走 CC `formatFileSize` 单一真源(ccFormat SSOT,同
// handlers/workspace|health|storage 已采纳)。门控 KHY_CC_FORMAT(经 ccFormatEnabled)默认
// 开;关 / require 失败 / 非有限输入 → 返回调用方传入的 `legacy` 串(逐字节回退)。
function _ccFileSize(bytes, legacy) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('./ccFormat');
    if (ccFormatEnabled()) { const out = ccFormatFileSize(bytes); if (out) return out; }
  } catch { /* fall through to legacy */ }
  return legacy;
}

// CC 后端口径对齐:毫秒龄差 → 人类可读「多久以前」走 ccFormat SSOT(CC `formatRelativeTime`
// 的 **Math.trunc 截断** + 完整 year→second 区间表),复用 resumeAdvisor `_ageLabel` 这一既有
// 中文本地化单一真源(绝不另写一份 _AGE_UNIT_ZH)。门控 KHY_CC_FORMAT(经 ccFormatEnabled)默认
// 开;关 / require 失败 / 拿不到标签 → 返回调用方传入的 `legacy` 串(逐字节回退到旧的「Nm 前」)。
function _ccTaskAge(ageMs, legacy) {
  try {
    const { ccFormatEnabled } = require('./ccFormat');
    if (ccFormatEnabled()) {
      const lbl = require('../services/resumeAdvisor')._ageLabel(null, undefined, ageMs);
      if (lbl) return lbl;
    }
  } catch { /* fall through to legacy */ }
  return legacy;
}
const {
  handleAccountInfo,
  handleLogCommand,
  handlePositionInfo,
  resolveArg0,
} = createRouterHandlers({ fmt, chk, symResolver });

// Ops-cluster command dispatch extracted to a sibling module (routerDispatchOps.js); the verbatim
// case bodies live there and are re-entered via dispatchOpsCommand in route(). Wire the 3 host
// callbacks the moved bodies still reference (handleLogCommand assigned just above; the other two
// are hoisted function declarations).
const { dispatchOpsCommand, setRouterDispatchOpsDeps, ROUTER_NOT_HANDLED } = require('./routerDispatchOps');
setRouterDispatchOpsDeps({ handleLogCommand, _handleResumeFlow, _ccFileSize });

// Slash-shortcut command cluster extracted to a sibling module (routerDispatchSlash.js); the
// verbatim case bodies live there and are re-entered via dispatchSlashCommand in route(). The moved
// bodies call route() recursively, so inject the host route function (a hoisted declaration).
const { dispatchSlashCommand, setRouterDispatchSlashDeps, ROUTER_NOT_HANDLED: SLASH_NOT_HANDLED } = require('./routerDispatchSlash');
setRouterDispatchSlashDeps({ route });

// Tail command cluster (habit … bridge) extracted to a sibling module (routerDispatchTail.js); the
// verbatim case bodies live there and are re-entered via dispatchTailCommand in route(). Inject chk
// (the lazy chalk loader, already assigned at module top above).
const { dispatchTailCommand, setRouterDispatchTailDeps, ROUTER_NOT_HANDLED: TAIL_NOT_HANDLED } = require('./routerDispatchTail');
setRouterDispatchTailDeps({ chk });

// Canonical command list + sub-command map come from commandSchema (SSOT).
const COMMANDS = getRouterCommandNames();
const SUB_COMMANDS = getRouterSubCommands();

// In khyquant app-entry mode, system-level diagnostic/ops commands should be
// executed via `khy ...` instead of `khyquant ...`.
const KHY_ONLY_COMMANDS_IN_APP_MODE = new Set([
  'gateway', 'doctor', 'proxy', 'linux', 'shell', 'verify', 'security', 'monitor', 'services',
  'init', 'docs', 'profile', 'cloud', 'update', 'plugin', 'app', 'workspace',
  'publish', 'mobile', 'restore', 'companion', 'desktop',
  'model', 'models', 'khymodel', 'bridge', 'mcp',
  'config', 'context', 'diff', 'env', 'export', 'files', 'hooks',
  'session', 'share', 'stats', 'status', 'summary', 'tasks', 'theme', 'lang',
  'release-notes', 'releasenotes',
  'terminal-setup', 'terminalsetup',
  'keybindings', 'keys', 'shortcuts',
  'perf-issue', 'perfissue',
  'issue',
  'sandbox-toggle', 'sandboxtoggle',
  'init-verifiers', 'initverifiers',
  'fork',
  'topology', 'forest',
  'btw',
  'autonomy',
  'proactive',
  'onboarding',
  'debug-tool-call', 'debugtoolcall',
  'recap',
  'copy',
  'rename',
  'tag',
  'heapdump',
  'break-cache', 'breakcache',
  'color',
  'advisor',
  'autofix-pr', 'autofixpr',
  'claim-main', 'claimmain',
  'ide',
  'subscribe-pr', 'subscribepr',
  'pr-comments', 'prcomments',
  'web-tools', 'webtools',
  'upgrade', 'branch', 'debug', 'stickers', 'receipts', 'rewind', 'undo',
]);

// Commands that accept a Chinese positional argument (stock names, search
// keywords). Used by parseInput's no-space Chinese alias splitter to decide
// whether a Chinese remainder (e.g. "茅台" after "回测") is a valid arg or should
// fall through to the AI as natural language ("启动项目" must NOT split into
// "启动" + "项目"). Hoisted to module scope (Ch2「不要每轮重建可复用结构」): this
// literal Set was formerly rebuilt on every parseInput call (once per submitted
// command line, repl.js). It is consumed read-only via `.has` and never mutated
// or returned, so a single shared instance is byte-identical.
const ACCEPTS_ZH_ARG = new Set([
  'quote', 'backtest', 'data', 'search', 'analyze', 'watch', 'rank', 'order',
]);

function _isKhyquantAppOnlyMode(context = {}) {
  const enforce = String(process.env.KHYQUANT_APP_ONLY || 'true').toLowerCase() !== 'false';
  if (!enforce) return false;
  const mode = String(context.mode || process.env.KHY_RUNTIME_MODE || '').toLowerCase();
  const invokedAs = String(process.env.KHYQUANT_INVOKED_AS || '').toLowerCase();
  return mode === 'khyquant' || invokedAs === 'khyquant';
}

function _isNumericConversationIndex(raw = '') {
  // Accept an optional leading '#' so `resume #2` matches `resume 2`. The resume
  // flow's _looksLikeIndex gate (`/^#?\d+$/`) already treats `#N` as an index and
  // skips the session-resume branch for it; this resolver must agree, otherwise a
  // `#N` arg falls through to findConversationByRef and dead-ends at INVALID_ID.
  const token = String(raw || '').trim().replace(/^#/, '');
  return /^\d+$/.test(token);
}

function _resolveConversationTarget(aiModule, rawArg = '') {
  const convos = aiModule.listConversations();
  if (convos.length === 0) {
    return { convos, target: null, error: 'EMPTY' };
  }

  const token = String(rawArg || '').trim();
  if (!token) {
    return { convos, target: convos[0], error: null };
  }

  if (_isNumericConversationIndex(token)) {
    const idx = parseInt(token.replace(/^#/, ''), 10) - 1;
    const target = convos[idx] || null;
    return { convos, target, error: target ? null : 'INVALID_INDEX' };
  }

  if (typeof aiModule.findConversationByRef === 'function') {
    const target = aiModule.findConversationByRef(token);
    return { convos, target, error: target ? null : 'INVALID_ID' };
  }

  const fallback = convos.find(c => c.file === token || c.file === `${token}.json`) || null;
  return { convos, target: fallback, error: fallback ? null : 'INVALID_ID' };
}

/**
 * Try to handle `resume` as a boulder (agent task) resume rather than a
 * conversation resume. Returns true when handled (caller should stop).
 *   resume tasks | list  → list resumable checkpoints
 *   resume <taskId>       → re-arm that checkpoint for live auto-resume
 * Returns false when the argument is not a known task id, so the caller
 * falls back to conversation-history resume.
 * @param {string} arg0
 * @param {object} fmtApi - formatters ({ printInfo, printSuccess, printWarn })
 * @param {object} chalkApi
 * @returns {boolean}
 */
function _tryBoulderTaskResume(arg0, fmtApi, chalkApi) {
  const token = String(arg0 || '').trim();
  let boulder;
  try { boulder = require('../services/boulderState'); } catch { return false; }

  if (token === 'tasks' || token === 'list') {
    const tasks = boulder.listResumableTasks();
    if (tasks.length === 0) {
      fmtApi.printInfo('暂无可恢复的任务检查点');
    } else {
      fmtApi.printInfo('可恢复的任务检查点 (khy resume <taskId>):');
      for (const t of tasks) {
        const ageMs = Date.now() - t.updatedAt;
        const flag = t.status === 'interrupted' ? '⏸' : '▶';
        const ageLabel = _ccTaskAge(ageMs, `${Math.round(ageMs / 60000)}m 前`);
        console.log(`  ${flag} ${t.taskId}  [${t.status}, ${t.iterations} 轮, ${ageLabel}]`);
        console.log(`     ${chalkApi.dim(t.cwd || '')}  ${chalkApi.dim(t.userMessage || '')}`);
      }
    }
    return true;
  }

  if (!token) return false;
  const rearmed = boulder.rearmForResume(token);
  if (!rearmed) return false; // not a task id — let conversation resume handle it

  fmtApi.printSuccess(`已定位任务 ${rearmed.taskId} (${rearmed.iterations} 轮已完成)`);
  fmtApi.printInfo(`工作目录: ${rearmed.cwd}`);
  if (rearmed.userMessage) fmtApi.printInfo(`原始指令: ${rearmed.userMessage}`);
  const sameDir = path.resolve(rearmed.cwd) === path.resolve(process.cwd());
  if (sameDir) {
    fmtApi.printInfo('检查点已重新激活，重新发送上述指令即可从断点继续。');
  } else {
    fmtApi.printWarn(`请先切换到该目录再继续: cd ${rearmed.cwd}`);
  }
  return true;
}

/**
 * Unified resume flow — the single source of truth for `resume` / `history resume`.
 *
 * `resume` is aliased to `history resume` (see aliases.js), so a user typing
 * `khy resume <id>` lands in the `history` command's `resume` sub-branch, NOT the
 * top-level `case 'resume'`. Before this helper existed, only the top-level case
 * checked the full-fidelity JSONL transcript store (Store B); the `history resume`
 * branch checked only the legacy summary store. The shutdown banner prints a
 * `getLiveSessionId()` id (a Store B id), so `khy resume <that-id>` was rejected
 * with "无效会话 ID". Routing both entry points through this helper makes the
 * printed id resolvable regardless of which path the alias takes.
 *
 * Resolution order (most authoritative first):
 *   1. bare `resume`            → re-arm the interrupted build for this cwd
 *   2. `resume <taskId>`        → boulder (agent task) checkpoint
 *   3. `resume <session-id>`    → full-fidelity JSONL transcript (Store B)
 *   4. `resume <index|ref>`     → legacy summary store (compacted digest)
 *
 * @param {object} p
 * @param {object} p.ai - the `./ai` module
 * @param {string} p.arg0 - the resume argument (session id / index / ref)
 * @param {Function} p.printSuccess
 * @param {Function} p.printInfo
 * @param {Function} p.printError
 * @param {Function} p.printWarn
 * @param {object} p.chalkApi
 * @returns {true | { aiForward: string }} router-compatible return value
 */
function _handleResumeFlow({ ai, arg0, printSuccess, printInfo, printError, printWarn, chalkApi }) {
  const _arg0 = String(arg0 || '').trim();

  // 1. Bare resume → continue the interrupted build for this cwd (resumeAdvisor).
  //    The saved original instruction is auto-resubmitted via the aiForward
  //    contract so the user need not retype it. Best-effort; on miss we fall
  //    through to conversation/session resume below.
  if (!_arg0) {
    try {
      const resumeAdvisor = require('../services/resumeAdvisor');
      const armed = resumeAdvisor.armBareResume(process.cwd());
      if (armed && armed.userMessage) {
        printSuccess('正在从断点继续未完成的构建…');
        printInfo(`原始目标: ${armed.userMessage}`);
        return { aiForward: armed.userMessage };
      }
    } catch { /* re-arming is a bonus; fall back to history resume */ }
  }

  // 2. Boulder (agent task) resume takes priority over conversation resume.
  if (_tryBoulderTaskResume(_arg0, { printInfo, printSuccess, printWarn }, chalkApi)) {
    return true;
  }

  // 3. Full-fidelity resume (Store B / JSONL transcript). Prefer restoring the
  //    complete conversation over the legacy compacted digest. A numeric arg
  //    (`resume 2`) keeps its legacy meaning: a 1-based index into the summary
  //    `history list`, handled by the legacy block below.
  const _looksLikeIndex = /^#?\d+$/.test(_arg0);
  if (!_looksLikeIndex) {
    const _full = _arg0
      ? ai.resumePersistedSession(_arg0)
      : ai.resumeLastPersistedSession();
    if (_full && _full.success) {
      const _src = _full.source ? ` · ${_full.source}` : '';
      printSuccess(
        `已恢复完整会话「${_full.title || _full.sessionId}」(${_full.messageCount} 条消息${_src})`
      );
      printInfo('AI 已加载该会话的完整上下文，可直接继续对话；后续消息会追加到同一会话记录');
      return true;
    }
    // Not found in Store B — fall through so an explicit summary-store id /
    // legacy record still resolves.
  }

  // 4. Conversation history resume (legacy summary store).
  const _resolved = _resolveConversationTarget(ai, arg0);
  const _target = _resolved.target;
  if (!_target) {
    if (_resolved.error === 'EMPTY') {
      printInfo('暂无保存的对话记录');
    } else if (_resolved.error === 'INVALID_ID') {
      printError('无效会话 ID，请先运行 history list 查看');
    } else {
      printError('无效序号，请先运行 history list 查看');
    }
    return true;
  }

  const _result = ai.resumeConversation(_target.file);
  if (_result.success) {
    const compactNote = _result.compacted
      ? `，已压缩摘要 (${_result.originalCount} → ${_result.messageCount} 条)`
      : '';
    const sid = _target.sessionId ? ` · 会话ID ${_target.sessionId}` : '';
    printSuccess(`已恢复对话 (${new Date(_result.timestamp).toLocaleString('zh-CN')}${compactNote}${sid})`);
    printInfo('AI 已加载上次对话的关键上下文，可以继续提问');
  } else {
    printError('恢复失败');
  }
  return true;
}

/**
 * Parse raw input into { command, subCommand, args, options }.
 * Resolves aliases before returning.
 */
function _stringifyArgvForRawInput(parts = []) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => {
      const token = String(part ?? '');
      if (!token) return '""';
      return /\s|["'\\]/.test(token) ? JSON.stringify(token) : token;
    })
    .join(' ')
    .trim();
}

function parseInput(line) {
  const isArgvArray = Array.isArray(line);
  const rawInput = isArgvArray
    ? _stringifyArgvForRawInput(line)
    : String(line || '').trim();
  let parts = isArgvArray
    ? line.map(part => String(part ?? ''))
    : rawInput.split(/\s+/);
  if (/^khy(?:quant)?$/i.test(parts[0]) && parts.length > 1) {
    parts.shift();
  }
  if (parts.length === 0 || parts[0] === '') return null;

  const rawCommandToken = parts[0];
  // Flag carried by a `{ route: null, flag: '...' }` slash command (e.g.
  // /thinking → 'thinking', /vim → 'vim'). Surfaced on the parsed object so
  // callers (the ink TUI's runRouted) can dispatch state-toggle flags in-UI
  // instead of letting route() forward them to the AI.
  let slashFlag = null;
  if (parts[0].startsWith('/')) {
    const slashToken = parts[0].toLowerCase();
    let slashRoute = null;

    try {
      const cmdReg = require('./commandRegistry');
      const slashDef = cmdReg.toSlashCommands().find(sc => (
        sc && typeof sc.cmd === 'string' && sc.cmd.toLowerCase() === slashToken
      ));
      if (slashDef && slashDef.route) slashRoute = String(slashDef.route);
      if (slashDef && slashDef.flag) slashFlag = String(slashDef.flag);
    } catch {
      // Fallback to static slash table when dynamic registry is unavailable.
      const slashDef = (SLASH_COMMANDS || []).find(sc => (
        sc && typeof sc.cmd === 'string' && sc.cmd.toLowerCase() === slashToken
      ));
      if (slashDef && slashDef.route) slashRoute = String(slashDef.route);
      if (slashDef && slashDef.flag) slashFlag = String(slashDef.flag);
    }

    parts[0] = parts[0].slice(1);
    if (!parts[0]) return null;

    // Direct slash input should behave like selecting the same item from '/'.
    // Expand route-based slash commands (e.g. /model -> gateway model).
    if (slashRoute) {
      const routeParts = slashRoute.trim().split(/\s+/).filter(Boolean);
      if (routeParts.length > 0) {
        parts = [...routeParts, ...parts.slice(1)];
      }
    }
  }

  // Chinese input often omits spaces (e.g. "回测茅台", "行情sh600519").
  // Try splitting on known Chinese alias prefixes so they route correctly.
  // Only split for commands that actually accept Chinese positional arguments
  // (stock names, search keywords). Commands like "启动" (server start) or
  // "退出" (exit) don't take Chinese args, so "启动项目" should not be split
  // into "启动" + "项目" → server start.
  if (parts.length === 1 && !aliases().resolveAlias(parts[0])) {
    const token = parts[0];
    const { ALIAS_MAP } = aliases();
    const zhKeys = Object.keys(ALIAS_MAP).filter(k => /[\u4e00-\u9fff]/.test(k));
    // Sort longest first to match "回测" before single-char aliases
    zhKeys.sort((a, b) => b.length - a.length);
    for (const key of zhKeys) {
      if (token.startsWith(key) && token.length > key.length) {
        const remainder = token.slice(key.length);
        const aliasTarget = ALIAS_MAP[key];
        // English/pinyin/number remainder is always a valid arg (e.g. "回测sh600519")
        if (/^[a-zA-Z0-9]/.test(remainder)) {
          parts = [key, remainder];
          break;
        }
        // Chinese remainder is only valid for commands that accept Chinese args
        // (stock names like "茅台", search terms). Other commands ("启动项目",
        // "服务状态") should fall through to AI as natural language.
        if (aliasTarget && ACCEPTS_ZH_ARG.has(aliasTarget.command)
            && /^[\u4e00-\u9fff]+$/.test(remainder) && remainder.length <= 4) {
          parts = [key, remainder];
          break;
        }
      }
    }
  }

  let command = parts[0];
  const rest = parts.slice(1);

  // Parse options (--key value / --key=value) and positional args
  // `--key=value` 的等号内联形式经纯叶子 cli/inlineOptionParse 拆分(门控
  // KHY_INLINE_OPTION_PARSE 默认开;关 → 逐字节回退历史空格分隔逻辑,`--out=x`
  // 仍落 options['out=x']=true)。懒加载 + fail-soft。
  const args = [];
  const options = {};
  let _parseInlineOption;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') {
      args.push(...rest.slice(i + 1));
      break;
    }
    if (rest[i].startsWith('--')) {
      const rawKey = rest[i].slice(2);
      let inline = { inline: false, key: rawKey };
      try {
        if (_parseInlineOption === undefined) {
          _parseInlineOption = require('./inlineOptionParse').parseInlineOption;
        }
        if (typeof _parseInlineOption === 'function') {
          inline = _parseInlineOption(rawKey, process.env);
        }
      } catch {
        inline = { inline: false, key: rawKey };
      }
      if (inline.inline) {
        options[inline.key] = inline.value;
        continue; // 等号形式自带值,不消费下一个 token
      }
      const key = inline.key;
      const nextVal = rest[i + 1];
      if (nextVal && !nextVal.startsWith('--')) {
        options[key] = nextVal;
        i++;
      } else {
        options[key] = true;
      }
    } else {
      args.push(rest[i]);
    }
  }

  // Resolve alias → canonical command
  const alias = aliases().resolveAlias(command);
  if (alias) {
    command = alias.command;
    // If alias implies a sub-command, prepend it — UNLESS the user already typed
    // an explicit, valid sub-command for the resolved command. Bare-keyword
    // aliases (e.g. "runtime" → status) must not clobber "runtime verify".
    if (alias.subCommand) {
      const typedSub = args[0];
      const validSubs = SUB_COMMANDS[command];
      const userTypedRealSub = typedSub
        && Array.isArray(validSubs)
        && validSubs.includes(typedSub);
      if (!userTypedRealSub) {
        args.unshift(alias.subCommand);
      }
    }
    // Inject default positional arguments for shortcut aliases
    // (e.g. "nir" -> "pool import nirvana").
    if (Array.isArray(alias.defaultPositionals) && alias.defaultPositionals.length > 0) {
      const defaults = alias.defaultPositionals
        .map(v => String(v || '').trim())
        .filter(Boolean);
      if (defaults.length > 0) {
        if (alias.subCommand && args.length > 0) {
          args.splice(1, 0, ...defaults);
        } else {
          args.unshift(...defaults);
        }
      }
    }
    // Merge default args from alias (e.g. buy → order --side buy)
    if (alias.defaultArgs) {
      Object.assign(options, alias.defaultArgs);
    }
  } else {
    command = command.toLowerCase();
  }

  // Detect sub-command
  let subCommand = null;
  if (SUB_COMMANDS[command] && args.length > 0 && SUB_COMMANDS[command].includes(args[0])) {
    subCommand = args.shift();
  }

  return {
    command,
    subCommand,
    args,
    options,
    rawInput,
    rawCommandToken,
    flag: slashFlag,
  };
}

/**
 * Route parsed input to the appropriate handler.
 * Returns: true (handled), false (→ AI), 'exit', 'menu', 'ai-status', 'ai-config'
 */
/**
 * Honor a global `--verbose` / `--debug` flag by escalating runtime verbosity.
 * Sets LOG_LEVEL=debug (so the Winston logger emits debug lines) and KHY_DEBUG=1
 * (so the scattered KHY_*_DEBUG fast paths and stack-trace dumps turn on).
 *
 * Escalate-only: if the user already pinned a MORE verbose level (e.g.
 * LOG_LEVEL=silly), it is left untouched; we only raise quieter levels to debug.
 * Idempotent and side-effect-safe to call once per dispatch.
 */
function _applyVerbosityFlag(options = {}) {
  const on = options.verbose === true || options.verbose === 'true'
    || options.debug === true || options.debug === 'true';
  if (!on) return;
  // Levels more verbose than debug that we must not downgrade.
  const MORE_VERBOSE = new Set(['silly', 'trace']);
  const current = String(process.env.LOG_LEVEL || '').toLowerCase();
  if (!MORE_VERBOSE.has(current)) {
    process.env.LOG_LEVEL = 'debug';
  }
  if (!process.env.KHY_DEBUG) process.env.KHY_DEBUG = '1';
}

async function route(parsed, context = {}) {
  const { command, subCommand, args, options } = parsed;
  const rawCommandToken = String(parsed?.rawCommandToken || '').trim().toLowerCase();
  const { printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner } = fmt();
  const chalk = chk();

  // Global `--verbose` / `--debug`: a single, discoverable verbosity switch that
  // lights up Winston debug logging + the scattered KHY_*_DEBUG diagnostic paths.
  // Idempotent and escalate-only — it never silences an already-lower level a
  // user set explicitly via LOG_LEVEL. Applied here at the one dispatch chokepoint
  // so every command honors it uniformly.
  _applyVerbosityFlag(options);

  if (_isKhyquantAppOnlyMode(context) && KHY_ONLY_COMMANDS_IN_APP_MODE.has(command)) {
    const cmdTail = [command, subCommand, ...(args || [])].filter(Boolean).join(' ');
    printWarn('`khyquant` 仅用于启动量化应用。');
    printInfo(`请使用: khy ${cmdTail}`.trim());
    return true;
  }

  try {
      // Ops-cluster commands (log/cost/usage/history/update/compute/train/admin/growth/agent/prompt/
      // voice/knowledge/security/monitor/services/linux/shell) are dispatched by a sibling module;
      // verbatim case bodies moved there. Non-ops commands return the sentinel and fall through to
      // the main switch below, preserving byte-identical behavior.
      {
        const __ops = await dispatchOpsCommand(command, {
          subCommand, args, options, rawCommandToken, parsed, context,
          printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk,
        });
        if (__ops !== ROUTER_NOT_HANDLED) return __ops;
      }
      // Slash-shortcut cluster is dispatched from routerDispatchSlash.js (see extraction note above);
      // non-slash commands return the sentinel and fall through to the main switch below.
      {
        const __slash = await dispatchSlashCommand(command, {
          subCommand, args, options, rawCommandToken, parsed, context,
          printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk,
        });
        if (__slash !== SLASH_NOT_HANDLED) return __slash;
      }
      // Tail cluster (habit … bridge) is dispatched from routerDispatchTail.js (see extraction note
      // above); non-tail commands return the sentinel and fall through to the main switch below.
      {
        const __tail = await dispatchTailCommand(command, {
          subCommand, args, options, rawCommandToken, parsed, context,
          printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk,
        });
        if (__tail !== TAIL_NOT_HANDLED) return __tail;
      }
    switch (command) {
      // ── Meta ──
      case 'version':
        console.log(process.env.KHYQUANT_PKG_VERSION || require('../../package.json').version);
        return true;

      case 'resume': {
        // `resume` is aliased to `history resume` (aliases.js), so in practice
        // user input reaches the `history` case below. This direct case remains
        // for any non-aliased dispatch; both delegate to the same unified flow so
        // Store B (JSONL transcript) ids — including the one the shutdown banner
        // prints — resolve identically regardless of entry point.
        return _handleResumeFlow({
          ai: require('./ai'),
          arg0: args[0],
          printSuccess, printInfo, printError, printWarn,
          chalkApi: chalk,
        });
      }
      case 'help':
        if (args[0]) {
          const { printHelpTopic } = require('./formatters');
          printHelpTopic(args[0]);
        } else {
          printHelp();
        }
        return true;
      case 'clear':
        // REPL mode handles clear in a terminal-safe way (frame/hud reset).
        // Keep direct clear for non-REPL invocations.
        if (process.env.KHY_REPL_ACTIVE !== '1') {
          console.clear();
        }
        return true;
      case 'exit':
      case 'quit':
        return 'exit';
      case 'menu':
        return 'menu';

      // ── KHY OS bare-metal kernel (khy os …) ──
      case 'khyos':
      case 'os': {
        const { handleKhyos } = require('./handlers/khyos');
        return await handleKhyos(parsed);
      }

      // ── Project maintainability metadata (.ai/ seed docs) ──
      case 'metadata':
      case 'meta':
        return await require('./handlers/metadata').handleMetadata(parsed);

      // ── MarkText(muya)WYSIWYG Markdown 工作台 + 右键「打开方式」注册 ──
      // khy md <file> / open <file> → muya 打开 .md；register/unregister → 系统关联。
      case 'md':
        return await require('./handlers/md').handleMd(parsed);

      // ── Unified management plane (khy manage) ──
      case 'manage':
        return await require('./handlers/manage').handleManage(parsed);

      // ── Maintainer cockpit (khy maintain) ──
      // `maintain` 既是 metadata 的别名（gen/refresh/check/show/link/hook），
      // 也提供单人维护者驾驶舱（bare / status / health / doctor / audit）。按子命令分流。
      case 'maintain': {
        // Metadata sub-verbs come from commandSchema (SSOT); keep them defined there only.
        const METADATA_SUBS = new Set(SUB_COMMANDS.metadata);
        const sub = String(parsed.subCommand || (Array.isArray(args) && args[0]) || '').toLowerCase();
        if (METADATA_SUBS.has(sub)) {
          return await require('./handlers/metadata').handleMetadata(parsed);
        }
        return await require('./handlers/maintain').handleMaintain(parsed);
      }

      // ── Unified self-service health check (khy health) ──
      // 聚合 services health / maintain / network / 外部后端 / 磁盘 / 内存 等分散信号到
      // 一个顶层自助诊断入口；支持 --json，red 项非零退出可作健康门禁。
      case 'health':
        return await require('./handlers/health').handleHealth(parsed);

      // ── Capability-as-code registry (khy capability) ──
      // Surfaces learned capabilities (tools authored to the capability
      // convention: code + tests + auto-discovery) and their test coverage.
      case 'capability':
        return await require('./handlers/capability').handleCapability(parsed);

      // ── RTK 省 token 模式(khy rtk …) ──
      // 检测/状态/省量统计/开关。RTK 在 shell 与 grep(content)执行前压缩输出省 token。
      case 'rtk':
        return await require('./handlers/rtk').handleRtk(parsed);

      // ── 20 倍模式(khy 20x …) ──
      // CC 有 Max 20x 满负荷档;khy 对齐同一体感 = 可开关的满负荷模式(effort=max + 扩展思考
      // + 更高工具迭代/并行子代理上限)。状态/开关。opt-in 默认关,关 = 逐字节回退今日行为。
      case '20x':
        return await require('./handlers/twentyX').handleTwentyX(parsed);

      // ── 懒人方法论(khy lazy …) ──
      // 学自 ponytail:阶梯/债务台账/强度/开关。判定与数据全在纯叶子 codeLaziness。
      case 'lazy':
        return require('./handlers/lazy').handleLazy(subCommand, args, options);

      // ── 持久目标(khy goal …) ──
      // 对齐 Claude Code /goal:设定后每轮注入系统提示词提醒模型朝它推进,直到清除。
      // 判定/规范化/指令在纯叶子 goalCore;持久化在 goalStore(~/.khyos/goals)。
      // freeform `/goal <文本>` 直设并「设定即开跑」:handler 返回 { code, aiForward } 时,
      // 透传 aiForward 让 REPL/TUI 主循环立刻跑一轮 agentic(对齐 CC 截图的 Crystallizing)。
      case 'goal': {
        const goalRes = require('./handlers/goal').handleGoal(subCommand, args, options);
        if (goalRes && typeof goalRes === 'object' && goalRes.aiForward) {
          return { aiForward: goalRes.aiForward };
        }
        return goalRes;
      }

      // ── 会话洞见(khy insights …) ──
      // 对齐 Claude Code /insights:回顾会话(轮次/工具/话题/耗时)。
      // 统计/排版在纯叶子 sessionInsights;transcript 读盘在 sessionPersistence。
      case 'insights':
        return require('./handlers/insights').handleInsights(subCommand, args, options);

      // ── 密钥保险库(khy vault …) ──
      // 对齐 Claude Code 的密钥保险库:机密存本地(~/.khyos/vault,0600),模型用 {{vault:NAME}}
      // 占位符引用,真值由 VaultHttpFetch 服务端注入,绝不进入模型上下文。
      // 校验/脱敏在纯叶子 vaultCore;持久化在 vaultStore。
      case 'vault':
        return require('./handlers/vault').handleVault(subCommand, args, options);

      // ── Multi-instance mesh (khy mesh …) ──
      // 同机多个独立 khy 实例彼此发现/attach/detach/跨进程互发消息。
      // 校验/信封在纯叶子 meshCore;在册表 + 信箱 IO 在 meshStore。
      case 'mesh':
        return require('./handlers/mesh').handleMesh(subCommand, args, options);

      // ── Off-terminal push notifications (khy notify …) ── 报文在纯叶子 pushNotifyCore;配置落 push.json。
      case 'notify':
        return require('./handlers/notify').handleNotify(subCommand, args, options);

      // 多平台消息收发(khy msg …)钉钉/飞书/企业微信。报文/验签在纯叶子 msgChannelCore/msgInboundCore。
      case 'msg':
        return require('./handlers/msg').handleMsg(subCommand, args, options);

      // ── Document operations (khy doc …) ──
      // First capability instance: `doc title` restyles a Word title/heading.
      case 'doc':
        return await require('./handlers/doc').handleDoc(parsed);

      // ── File-format conversion (khy convert …) ──
      // Second capability instance: image→PDF / →TXT / PDF↔TXT / Word↔TXT, etc.
      case 'convert':
        return await require('./handlers/convert').handleConvert(parsed);

      // ── Role play (khy role …) ──
      // Third capability instance (first behavioral one): adopt a role/character
      // from a prompt; active for this conversation (--save persists to persona).
      case 'role':
        return await require('./handlers/role').handleRole(parsed);

      // ── Quote ──
      case 'quote': {
        if (!args[0]) { printError('用法: quote <代码|名称>  (如: hq 茅台, quote sh600519)'); return true; }
        const sym = await resolveArg0(args);
        const { handleQuote } = require('./handlers/data');
        await handleQuote(sym);
        return true;
      }

      // ── Data ──
      case 'data': {
        const { handleDataFetch, handleDataList } = require('./handlers/data');
        if (subCommand === 'fetch') {
          if (!args[0]) { printError('用法: data fetch <代码|名称>'); return true; }
          const sym = await resolveArg0(args);
          await handleDataFetch(sym, options);
        } else if (subCommand === 'list') {
          await handleDataList();
        } else {
          printError('用法: data fetch <代码> | data list  (别名: xz, sj)');
        }
        return true;
      }

      case 'cache': {
        const { handleCacheClear } = require('./handlers/data');
        if (subCommand === 'clear') {
          await handleCacheClear();
        } else {
          printError('用法: cache clear  (别名: hc)');
        }
        return true;
      }

      // ── Backtest ──
      case 'backtest': {
        if (subCommand === 'list') {
          const { handleBacktestList } = require('./handlers/backtest');
          await handleBacktestList(options);
        } else {
          const rawSym = args[0] || subCommand;
          if (!rawSym) { printError('用法: backtest <代码|名称> [--strategy <ma_cross|rsi|macd|ID|文件> --start --end --capital --verbose]'); return true; }
          args[0] = rawSym;
          const sym = await resolveArg0(args);
          const { handleBacktestRun } = require('./handlers/backtest');
          await handleBacktestRun(sym, options);
        }
        return true;
      }

      case 'strategy': {
        if (subCommand === 'list' || !subCommand) {
          const { handleStrategyList } = require('./handlers/backtest');
          await handleStrategyList();
        } else {
          printError('用法: strategy list  (别名: cl)');
        }
        return true;
      }

      // ── Search ──
      case 'search': {
        // Web search sub-command: search web <query>
        if (subCommand === 'web' || args[0] === 'web' || args[0] === '网页') {
          const webArgs = (subCommand === 'web') ? args : args.slice(1);
          const webQuery = webArgs.join(' ');
          if (!webQuery) { printError('用法: search web <关键词>'); return true; }
          const webSearch = require('../services/webSearchService');
          if (!webSearch.isAvailable()) printInfo('未检测到 Kiro 认证，自动使用回退搜索');
          printInfo(`正在搜索: ${webQuery}`);
          const result = await webSearch.search(webQuery);
          if (result.success) {
            console.log('');
            console.log(chalk.bold.cyan('  🔍 搜索结果'));
            console.log(chalk.dim('  ─'.repeat(30)));
            for (const r of (result.results || []).slice(0, 10)) {
              console.log('');
              console.log(chalk.bold.white(`  ${r.title}`));
              if (r.url) console.log(chalk.blue(`  ${r.url}`));
              if (r.snippet) console.log(chalk.gray(`  ${r.snippet}`));
              if (r.publishedDate) console.log(chalk.dim(`  📅 ${r.publishedDate}`));
            }
            console.log('');
          } else {
            printError(result.error || '搜索失败');
          }
          return true;
        }
        if (!args[0]) { printError('用法: search <关键词>  (别名: ss, sousuo)'); return true; }
        const results = await symResolver().searchInstruments(args[0]);
        if (results.length === 0) {
          printError(`未找到匹配 "${args[0]}" 的品种`);
        } else {
          printSuccess(`找到 ${results.length} 个匹配`);
          printTable(
            ['代码', '名称', '类型', '市场'],
            results.slice(0, 20).map(i => [i.symbol, i.name || '-', i.type || '-', i.market || '-'])
          );
        }
        return true;
      }

      // ── Web Search (via Kiro InvokeMCP) ──
      case 'web_search': {
        const webQuery = args.join(' ');
        if (!webQuery) { printError('用法: web_search <关键词>'); return true; }
        const webSearch = require('../services/webSearchService');
        if (!webSearch.isAvailable()) printInfo('未检测到 Kiro 认证，自动使用回退搜索');
        const wsResult = await webSearch.search(webQuery);
        if (wsResult.success && wsResult.formatted) {
          console.log(wsResult.formatted);
        } else {
          printError(wsResult.error || '搜索失败');
        }
        return true;
      }

      // ── Screenshot to Web (image -> runnable HTML) ──
      case 'image2web': {
        const imageToWebService = require('../services/imageToWebService');
        const inputArg = String(args[0] || '').trim();
        const fromClipboard = Boolean(
          options.clipboard
          || options.paste
          || imageToWebService.isClipboardImageArg(inputArg)
        );
        if (!fromClipboard && !inputArg) {
          printError('用法: image2web <图片路径|paste> [还原要求] [--out index.html] [--overwrite]');
          printInfo('示例: image2web ./landing.png 还原这个网页为可运行 HTML --out landing.html');
          printInfo('示例: image2web paste 还原成响应式网页 --out clipboard-page.html');
          return true;
        }

        let sourcePath = '';
        let userPrompt = '';
        if (fromClipboard) {
          userPrompt = imageToWebService.isClipboardImageArg(inputArg)
            ? args.slice(1).join(' ').trim()
            : args.join(' ').trim();
        } else {
          sourcePath = inputArg;
          userPrompt = args.slice(1).join(' ').trim();
        }

        const noSave = Boolean(options.print || options.stdout || options['no-save']);
        const outRaw = String(options.out || options.output || '').trim();
        let convertResult = null;
        await withSpinner('正在还原网页代码', async () => {
          convertResult = await imageToWebService.convertImageToWeb({
            imagePath: sourcePath,
            useClipboard: fromClipboard,
            prompt: userPrompt,
            outputPath: outRaw,
            overwrite: Boolean(options.overwrite || options.force),
            save: !noSave,
            cwd: process.env.KHYQUANT_CWD || process.cwd(),
          });
        }, { muteOutput: false });

        if (!convertResult || !convertResult.success) {
          printError((convertResult && convertResult.error) || '网页还原失败');
          if (convertResult && convertResult.rawReply) {
            printWarn('AI 原始返回中未找到可用 HTML 代码块，已输出原文：');
            console.log('');
            console.log(convertResult.rawReply);
            console.log('');
          }
          return true;
        }
        if (noSave) {
          console.log(convertResult.html);
          return true;
        }

        if (convertResult.autoRenamed && convertResult.outputPath) {
          printWarn(`目标文件已存在，自动写入新文件: ${path.basename(convertResult.outputPath)}`);
        }
        printSuccess(`网页已生成: ${convertResult.outputPath}`);
        if (convertResult.provider || convertResult.model) {
          printInfo(`AI 通道: ${convertResult.provider || 'unknown'}${convertResult.model ? ` · ${convertResult.model}` : ''}`);
        }
        return true;
      }

      // ── Account / Position / Order (production placeholders) ──
      case 'account': {
        const service = require('./handlers/service');
        // Delegate to server API if running, otherwise show DB info
        await handleAccountInfo();
        return true;
      }

      case 'position': {
        await handlePositionInfo();
        return true;
      }

      case 'order': {
        printInfo('下单功能需要连接交易接口，当前为预览模式');
        printInfo('用法: order <代码> --side buy|sell --qty 100 --price 50.00');
        return true;
      }

      // ── Watch(自选监控)──
      // 复用 userProfile 自选股 + marketDataService.getRealTimeQuote(详见 handlers/market.js)。
      // watch <代码> 加入自选并显示行情;watch 显示自选监控面板;watch rm <代码> 移出;watch clear 清空。
      case 'watch': {
        // 加入时把 arg0 解析成规范代码;list/remove/clear 直接透传 args。
        const { parseWatchArgs } = require('./handlers/market');
        let watchArgs = args;
        if (parseWatchArgs(args).action === 'add' && args[0]) {
          watchArgs = [await resolveArg0(args)];
        }
        return await require('./handlers/market').handleWatch(watchArgs);
      }

      // ── Rank(行情排行:涨幅榜/跌幅榜)──
      // 复用既有行情服务,对「自选 ∪ 常用」股票排序(诚实范围:非全市场)。详见 handlers/market.js。
      case 'rank': {
        return await require('./handlers/market').handleRank(args);
      }

      // ── Analyze (AI shortcut) ──
      case 'analyze': {
        if (!args[0]) { printError('用法: analyze <代码|名称>  (别名: fx, fenxi)'); return true; }
        const sym = await resolveArg0(args);
        // Forward to AI with a structured prompt
        return { aiForward: `分析一下 ${sym} 的走势和交易机会` };
      }

      // ── Server / DB / App ──
      case 'server': {
        const service = require('./handlers/service');
        if (subCommand === 'start') await service.handleServerStart(options);
        else if (subCommand === 'status') await service.handleServerStatus();
        else printError('用法: server start [--port N] | server status  (别名: fw)');
        return true;
      }

      case 'app': {
        const { handleApp } = require('./handlers/app');
        await handleApp(subCommand, args, options);
        return true;
      }

      case 'device': {
        const { handleDevice } = require('./handlers/device');
        await handleDevice(subCommand, args, options);
        return true;
      }

      // ── Test-key(厂商连通性自检:输入 key 测是否连通)──
      // pip 装后 `khy test-key <厂商> --key <k>` / `--all` / `list`;判定委托
      // providerConnectivitySpec 单一真源。厂商名是动态位置参数(不进 SUB_COMMANDS),
      // 故读 args[0] 而非 subCommand。key 只在运行时传入,绝不落盘。
      case 'test-key':
      case 'testkey':
      case 'test-keys': {
        const { handleTestKey } = require('./handlers/testKey');
        await handleTestKey(args, options);
        return true;
      }

      case 'db': {
        const service = require('./handlers/service');
        if (subCommand === 'init') await service.handleDbInit();
        else if (subCommand === 'seed') await service.handleDbSeed();
        else if (subCommand === 'status') await service.handleDbStatus();
        else printError('用法: db init | db seed | db status  (别名: sjk)');
        return true;
      }

      // ── AI ──
      case 'ai': {
        if (subCommand === 'status') return 'ai-status';
        if (subCommand === 'config') return 'ai-config';
        if (subCommand === 'on') return 'ai-on';
        if (subCommand === 'off') return 'ai-off';
        if (subCommand === 'tech') {
          const aiHandler = require('./ai');
          await aiHandler.handleAiTech(options, args);
          return true;
        }
        if (subCommand === 'owner') {
          const aiHandler = require('./ai');
          await aiHandler.handleAiOwner(args[0] || 'status', options);
          return true;
        }
        if (subCommand === 'unrestricted') {
          const aiHandler = require('./ai');
          await aiHandler.handleAiUnrestricted(options, args);
          return true;
        }
        if (subCommand === 'dangerous') {
          const toolCalling = require('../services/toolCalling');
          if (options.off) {
            toolCalling.disableDangerousMode();
            printSuccess('危险模式已关闭 — 工具调用将请求确认');
          } else {
            const acknowledged = toolCalling.enableDangerousMode();
            if (!acknowledged) {
              printError('⚠⚠⚠ 警告: 危险模式将跳过所有工具调用确认!');
              printInfo('AI 将可以不经确认地执行文件操作、命令执行等危险操作');
              printInfo('这可能导致数据丢失或系统损坏');
              printInfo('如果确认开启，请运行: ai dangerous --confirm');
            } else {
              printSuccess('危险模式已开启 — 工具调用将不再请求确认');
              printWarn('请注意安全，随时可用 ai dangerous --off 关闭');
            }
          }
          if (options.confirm) {
            toolCalling.acknowledgeDangerousMode();
            printSuccess('已确认 — 危险模式开启');
          }
          return true;
        }
        if (subCommand === 'tools') {
          const toolCalling = require('../services/toolCalling');
          const tools = toolCalling.listTools();
          console.log('');
          printInfo(`已注册 ${tools.length} 个工具 (legacy):`);
          tools.forEach(t => {
            const riskColors = { safe: 'green', low: 'cyan', medium: 'yellow', high: 'red', critical: 'redBright' };
            const color = riskColors[t.risk] || 'dim';
            console.log(`    ${chalk[color](`[${t.risk}]`)} ${t.name} — ${t.description}`);
          });
          // Show new registry tools
          try {
            const registry = require('../tools');
            const newCount = registry.count();
            const grouped = registry.getByCategory();
            console.log('');
            printInfo(`工具注册表: ${newCount} 个工具 (按类别):`);
            for (const [cat, catTools] of Object.entries(grouped)) {
              console.log(chalk.bold(`    [${cat}]`));
              for (const t of catTools) {
                const riskColors = { safe: 'green', low: 'cyan', medium: 'yellow', high: 'red', critical: 'redBright' };
                const color = riskColors[t.risk] || 'dim';
                console.log(`      ${chalk[color](`[${t.risk}]`)} ${t.name} — ${t.description}`);
              }
            }
          } catch { /* registry not available */ }
          console.log('');
          return true;
        }
        return 'ai-status';
      }

      // ── Gateway ──
      case 'gateway': {
        const gw = require('./handlers/gateway');
        const manageAliasForceDaemon = new Set([
          'guanli',
          'khyguanli',
          'aiguanli',
          'ai管理',
          '管理页',
        ]);
        const manageOptions = (
          subCommand === 'manage'
          && manageAliasForceDaemon.has(rawCommandToken)
          && typeof options.daemon === 'undefined'
        )
          ? { ...options, daemon: true }
          : options;
        if (subCommand === 'status') await gw.handleGatewayStatus(options);
        else if (subCommand === 'guide' || subCommand === 'help') await gw.handleGatewayGuide(options);
        else if (subCommand === 'debug-prompt') await gw.handleGatewayDebugPrompt(args, options);
        else if (subCommand === 'trace') await gw.handleGatewayTrace(args, options);
        else if (subCommand === 'sample') await gw.handleGatewaySample(args, options);
        else if (subCommand === 'config') await gw.handleGatewayConfig(options);
        else if (subCommand === 'relay') await gw.handleGatewayRelay();
        else if (subCommand === 'detect') await gw.handleGatewayDetect(options);
        else if (subCommand === 'model') await gw.handleGatewaySelectModel(args, options);
        else if (subCommand === 'models') await gw.handleGatewayModels(args, options);
        else if (subCommand === 'prefer-remote') await gw.handleGatewayPreferRemote(options);
        else if (subCommand === 'test') await gw.handleGatewayTest(args[0] || null, options);
        else if (subCommand === 'probe-tools') await gw.handleGatewayProbeTools(args, options);
        else if (subCommand === 'discover-models') await gw.handleGatewayDiscoverModels(options);
        else if (subCommand === 'tune-local') await gw.handleGatewayTuneLocal(args, options);
        else if (subCommand === 'server') await gw.handleAiServer(args[0] || 'start');
        else if (subCommand === 'manage') await gw.handleGatewayManage(args, manageOptions);
        else if (subCommand === 'protocols') gw.handleGatewayProtocols(options);
        else if (subCommand === 'vertex') gw.handleGatewayVertex(args, options);
        else if (subCommand === 'oauth') await gw.handleGatewayOAuth(args[0] || 'status', args[1] || null, options);
        else if (subCommand === 'key') await gw.handleGatewayKey(args[0] || '', args.slice(1), options);
        else if (subCommand === 'add') await gw.handleGatewayAdd(options);
        else if (subCommand === 'pool') await gw.handleGatewayPool(args, options);
        else {
          // Default to status when no sub-command
          await gw.handleGatewayStatus(options);
        }
        return true;
      }

      // ── Init / Doctor ──
      case 'init': {
        const { handleInit } = require('./handlers/init');
        await handleInit(options);
        return true;
      }

      case 'doctor': {
        const { handleDoctor } = require('./handlers/init');
        await handleDoctor(options, args);
        return true;
      }

      case 'verify': {
        const { handleVerify } = require('./handlers/verify');
        await handleVerify(subCommand, args, options);
        return true;
      }

      case 'runtime': {
        const { handleRuntime } = require('./handlers/runtime');
        await handleRuntime(subCommand, args, options);
        return true;
      }

      case 'trace': {
        const { handleTrace } = require('./handlers/trace');
        await handleTrace(subCommand, args, options);
        return true;
      }

      case 'replay': {
        const { handleReplay } = require('./handlers/replay');
        await handleReplay(subCommand, args, options);
        return true;
      }

      case 'guide': {
        const { handleGuide } = require('./handlers/guide');
        await handleGuide(subCommand, args, options);
        return true;
      }

      case 'channels': {
        const { handleChannels } = require('./handlers/channels');
        await handleChannels(subCommand, args, options);
        return true;
      }

      case 'workspace': {
        const { handleWorkspace } = require('./handlers/workspace');
        await handleWorkspace(subCommand ? [subCommand, ...args] : args, options);
        return true;
      }

      case 'receipts': {
        const { handleReceipts } = require('./handlers/receipts');
        await handleReceipts(subCommand, args, options);
        return true;
      }

      case 'rewind':
      case 'undo': {
        const { handleRollback } = require('./handlers/rollback');
        await handleRollback(command, subCommand, args, options);
        return true;
      }

      case 'publish': {
        const { handlePublish } = require('./handlers/publish');
        await handlePublish(subCommand, args, options);
        return true;
      }

      case 'restore':
      case 'restore-source': {
        // Decrypt + extract the full-source snapshot embedded in the pip/npm
        // package into a target dir (default ./Khy-OS), preserving the layout.
        const { handleRestore } = require('./handlers/publish');
        await handleRestore(subCommand ? [subCommand, ...args] : args, options);
        return true;
      }

      case 'companion': {
        // AgentFS: file-driven, git-versioned, layered per-agent storage.
        // companion has no registered SUB_COMMANDS, so peel the verb off args.
        const { handleCompanion } = require('./handlers/companion');
        const sub = subCommand || args[0] || null;
        const rest = subCommand ? args : args.slice(1);
        await handleCompanion(sub, rest, options);
        return true;
      }

      case 'mobile': {
        const { handleMobile } = require('./handlers/mobile');
        await handleMobile(subCommand, args, options);
        return true;
      }

      case 'desktop': {
        const { handleDesktop } = require('./handlers/desktop');
        await handleDesktop(subCommand, args, options);
        return true;
      }

      case 'extension':
      case 'ext': {
        // Extension marketplace (list/search/install/.../new). The handler was
        // fully implemented + backed by services/extensionMarketplace but had no
        // dispatch case, so `khy ext ...` was unreachable. handleExtension takes a
        // single input string (subcommand + args), so reassemble it here.
        const { handleExtension } = require('./handlers/extension');
        const input = [subCommand, ...(args || [])].filter(Boolean).join(' ');
        await handleExtension(input, { options });
        return true;
      }

      case 'repo': {
        // Beginner-safe version-management entry (status/save/history/branch/publish).
        // `repo` registers its verbs as SUB_COMMANDS, so subCommand is already peeled.
        const { handleRepo } = require('./handlers/repo');
        await handleRepo(subCommand, args, options);
        return true;
      }

      case 'deploy': {
        // Deploy an arbitrary project to a target location and (optionally) start it.
        const { handleDeploy } = require('./handlers/deploy');
        await handleDeploy(parsed);
        return true;
      }

      case 'docs': {
        const docs = require('./handlers/docs');
        if (subCommand === 'quickstart' || subCommand === 'start') await docs.handleDocsQuickstart();
        else if (subCommand === 'ai-fastlane' || subCommand === 'ai' || subCommand === 'fastlane') await docs.handleDocsAiFastlane(args, options);
        else if (subCommand === 'maintainer') await docs.handleDocsMaintainer();
        else if (subCommand === 'claude') await docs.handleDocsClaude();
        else if (subCommand === 'gateway') await docs.handleDocsGateway();
        else if (subCommand === 'strategy') await docs.handleDocsStrategy();
        else if (subCommand === 'faq') await docs.handleDocsFaq();
        else if (subCommand === 'subscribe' || subCommand === 'sub') await docs.handleDocsSubscription();
        else if (subCommand === 'check' || subCommand === 'freshness') await docs.handleDocsFreshness(args, options);
        else await docs.handleDocsQuickstart(); // default to quickstart
        return true;
      }

      case 'subscribe':
      case 'sub': {
        const docs = require('./handlers/docs');
        await docs.handleDocsSubscription();
        return true;
      }

      case 'profile': {
        const userProfile = require('../services/userProfile');
        if (subCommand === 'export') {
          const json = userProfile.exportProfile();
          const outPath = args[0] || 'khy-profile.json';
          require('fs').writeFileSync(outPath, json, 'utf-8');
          printSuccess(`画像已导出到: ${outPath}`);
        } else if (subCommand === 'import') {
          const filePath = args[0];
          if (!filePath) { printError('用法: profile import <file.json>'); return true; }
          try {
            const json = require('fs').readFileSync(filePath, 'utf-8');
            userProfile.importProfile(json);
            printSuccess('画像已导入并合并');
          } catch (e) { printError(`导入失败: ${e.message}`); }
        } else if (subCommand === 'reset') {
          userProfile.resetProfile();
          printSuccess('画像已重置');
        } else {
          // Default: show profile summary
          const summary = userProfile.getProfileSummary();
          console.log('');
          console.log(chalk.cyan.bold('  📊 用户画像'));
          console.log(chalk.dim('  ' + '─'.repeat(40)));
          console.log(`  会话次数: ${chalk.bold(summary.sessions)}`);
          console.log(`  命令总数: ${chalk.bold(summary.totalCommands)}`);
          console.log(`  熟练度:   ${chalk.bold(summary.skillLevel === 'beginner' ? '新手' : summary.skillLevel === 'intermediate' ? '进阶' : '高级')}`);
          if (summary.topSymbols.length > 0)
            console.log(`  常用品种: ${chalk.green(summary.topSymbols.join(', '))}`);
          if (summary.topCommands.length > 0)
            console.log(`  常用命令: ${chalk.green(summary.topCommands.join(', '))}`);
          if (summary.favoriteSymbols.length > 0)
            console.log(`  收藏品种: ${chalk.yellow(summary.favoriteSymbols.join(', '))}`);
          console.log(chalk.dim(`  设备ID:   ${summary.deviceId}`));
          console.log('');
          printInfo('profile export — 导出画像 (跨设备同步)');
          printInfo('profile import <file> — 导入画像');
          console.log('');
        }
        return true;
      }

      case 'cloud': {
        const cloud = require('../services/cloudSync');
        if (subCommand === 'login') {
          const inquirer = require('inquirer');
          const { username, password } = await inquirer.prompt([
            { type: 'input', name: 'username', message: '用户名:', validate: v => v.trim().length >= 3 || '至少3个字符' },
            { type: 'password', name: 'password', message: '密码:', mask: '*', validate: v => v.length >= 6 || '至少6个字符' },
          ]);
          printInfo('登录中...');
          try {
            const result = await cloud.login(username, password);
            if (result.success) printSuccess(`${result.message} — 欢迎回来, ${username}!`);
            else printError(result.message);
          } catch (e) { printError(`网络错误: ${e.message}`); }
        } else if (subCommand === 'register') {
          const inquirer = require('inquirer');
          const { username, password, confirm } = await inquirer.prompt([
            { type: 'input', name: 'username', message: '设置用户名:', validate: v => v.trim().length >= 3 || '至少3个字符' },
            { type: 'password', name: 'password', message: '设置密码:', mask: '*', validate: v => v.length >= 6 || '至少6个字符' },
            { type: 'password', name: 'confirm', message: '确认密码:', mask: '*' },
          ]);
          if (password !== confirm) { printError('两次密码不一致'); return true; }
          printInfo('注册中...');
          try {
            const result = await cloud.register(username, password);
            if (result.success) printSuccess(`${result.message} — 已自动登录`);
            else printError(result.message);
          } catch (e) { printError(`网络错误: ${e.message}`); }
        } else if (subCommand === 'logout') {
          cloud.logout();
          printSuccess('已退出登录');
        } else if (subCommand === 'on' || subCommand === 'enable') {
          if (!cloud.isLoggedIn()) {
            printError('请先登录: cloud login');
            return true;
          }
          cloud.enableCloud();
          printSuccess('云同步已开启');
        } else if (subCommand === 'off' || subCommand === 'disable') {
          cloud.disableCloud();
          printSuccess('云同步已关闭');
        } else if (subCommand === 'sync') {
          if (!cloud.isLoggedIn()) { printError('请先登录: cloud login'); return true; }
          printInfo('正在同步...');
          const up = await cloud.syncUpload();
          if (up.success) printSuccess('画像已上传到云端');
          else printError(`上传失败: ${up.reason}`);
        } else if (subCommand === 'pull') {
          if (!cloud.isLoggedIn()) { printError('请先登录: cloud login'); return true; }
          printInfo('正在拉取...');
          const down = await cloud.syncDownload();
          if (down.success) printSuccess('已从云端合并画像');
          else printError(`拉取失败: ${down.reason}`);
        } else if (subCommand === 'endpoint') {
          if (args[0]) {
            cloud.setEndpoint(args[0]);
            printSuccess(`云端地址已设为: ${args[0]}`);
          } else {
            console.log(`  当前地址: ${chalk.cyan(cloud.getEndpoint())}`);
            printInfo('用法: cloud endpoint https://new-domain.com');
          }
        } else {
          // Show status
          const config = cloud.loadCloudConfig();
          console.log('');
          console.log(chalk.cyan.bold('  ☁️  云同步状态'));
          console.log(chalk.dim('  ' + '─'.repeat(40)));
          if (config.username) {
            console.log(`  账号:     ${chalk.green(config.username)} ✓`);
          } else {
            console.log(`  账号:     ${chalk.yellow('未登录')}`);
          }
          console.log(`  状态:     ${config.enabled ? chalk.green('已开启') : chalk.yellow('未开启')}`);
          console.log(`  统计上报: ${config.telemetryEnabled ? chalk.green('✓') : chalk.dim('✗')}`);
          console.log(`  画像同步: ${config.syncEnabled ? chalk.green('✓') : chalk.dim('✗')}`);
          console.log(`  端点:     ${chalk.dim(config.endpoint || require('../constants/serviceDefaults').CLOUD_DEFAULT_ENDPOINT)}`);
          if (config.lastSync) console.log(`  上次同步: ${chalk.dim(config.lastSync)}`);
          console.log('');
          if (!config.username) {
            printInfo('cloud register — 注册新账号');
            printInfo('cloud login — 登录已有账号');
          } else {
            printInfo('cloud sync — 上传画像 · cloud pull — 拉取画像');
            printInfo('cloud logout — 退出登录');
          }
          printInfo('cloud endpoint <url> — 修改服务器地址');
          console.log('');
        }
        return true;
      }

      // ── Plugin management ──
      case 'plugin': {
        const { getPluginList, reloadPlugins, PLUGINS_DIR } = require('./plugins');
        if (subCommand === 'list') {
          // SDK plugins (with quality status)
          const { handlePlugin } = require('./handlers/plugin-dev');
          await handlePlugin(['list', ...args]);

          // Legacy custom command plugins
          const list = getPluginList();
          if (list.length > 0) {
            printInfo(`自定义命令插件 (${list.length})`);
            printTable(
              ['命令', '别名', '说明'],
              list.map(p => [p.name, (p.aliases || []).join(', '), p.description || ''])
            );
          } else {
            printInfo(`暂无自定义命令插件，可在 ${PLUGINS_DIR}/ 添加 .js 文件`);
          }
        } else if (subCommand === 'reload') {
          reloadPlugins();
          printSuccess('插件已重新加载');
        } else if (subCommand === 'gateway') {
          const gwPlugins = require('../services/gateway/pluginChain');
          const action = args[0];
          if (action === 'list' || !action) {
            const plugins = gwPlugins.list();
            if (plugins.length === 0) {
              printInfo(`网关插件目录: ${gwPlugins.getPluginsDir()}/`);
              printInfo('暂无网关插件 — 创建 .js 文件即��加载');
            } else {
              printSuccess(`已加载 ${plugins.length} 个网关插件`);
              fmt().printTable(
                ['名称', '优先级', '状态', 'Hooks'],
                plugins.map(p => [p.name, String(p.priority), p.enabled ? chk().green('✓') : chk().dim('禁用'), p.hooks.join(', ')])
              );
            }
          } else if (action === 'reload') {
            const count = gwPlugins.reload();
            printSuccess(`网关插件已重载 (${count} 个)`);
          } else if (action === 'enable' && args[1]) {
            gwPlugins.toggle(args[1], true);
            printSuccess(`已启用: ${args[1]}`);
          } else if (action === 'disable' && args[1]) {
            gwPlugins.toggle(args[1], false);
            printSuccess(`已禁用: ${args[1]}`);
          } else if ((action === 'add' || action === 'create') && args[1]) {
            // Create new plugin from template, optionally open in editor
            const name = args[1];
            try {
              const template = gwPlugins.getTemplate().replace(
                /name:\s*'[^']*'/,
                `name: '${name}'`
              );
              gwPlugins.savePlugin(name, template);
              printSuccess(`插件已创建: ${gwPlugins.getPluginsDir()}/${name}.js`);
              // Open in editor if available
              const editor = process.env.EDITOR || process.env.VISUAL;
              if (editor && !options.noEdit) {
                const { execSync } = require('child_process');
                const pluginPath = require('path').join(gwPlugins.getPluginsDir(), `${name}.js`);
                printInfo(`正在打开编辑器: ${editor}...`);
                try {
                  execSync(`${editor} "${pluginPath}"`, { stdio: 'inherit' });
                  gwPlugins.reload();
                  printSuccess('插件已重载');
                } catch { /* editor closed or unavailable */ }
              } else {
                printInfo('使用 plugin gateway edit ' + name + ' 编辑');
              }
            } catch (e) {
              printError(e.message);
            }
          } else if (action === 'delete' && args[1]) {
            const name = args[1];
            // Confirm deletion (native form under the Ink TUI, real inquirer otherwise)
            const { promptCompat } = require('./uiPrompt');
            const { confirm } = await promptCompat([{
              type: 'confirm',
              name: 'confirm',
              message: `确认删除插件 "${name}"?`,
              default: false,
            }]);
            if (confirm) {
              try {
                gwPlugins.deletePlugin(name);
                printSuccess(`插件 "${name}" 已删除`);
              } catch (e) {
                printError(e.message);
              }
            }
          } else if (action === 'edit' && args[1]) {
            const name = args[1];
            try {
              gwPlugins.getPluginCode(name); // verify it exists
              const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
              const pluginPath = require('path').join(gwPlugins.getPluginsDir(), `${name}.js`);
              printInfo(`打开 ${editor}...`);
              const { execSync } = require('child_process');
              execSync(`${editor} "${pluginPath}"`, { stdio: 'inherit' });
              gwPlugins.reload();
              printSuccess('插件已重载');
            } catch (e) {
              printError(e.message);
            }
          } else if (action === 'show' && args[1]) {
            const name = args[1];
            try {
              const code = gwPlugins.getPluginCode(name);
              console.log('');
              console.log(chk().cyan(`  ─── ${name}.js ───`));
              console.log('');
              // Simple syntax highlighting with chalk
              const lines = code.split('\n');
              for (const line of lines) {
                if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/**')) {
                  console.log(chk().dim(`  ${line}`));
                } else if (line.includes('module.exports') || line.includes('require(')) {
                  console.log(chk().yellow(`  ${line}`));
                } else {
                  console.log(`  ${line}`);
                }
              }
              console.log('');
            } catch (e) {
              printError(e.message);
            }
          } else if (action === 'import' && args[1]) {
            const fs = require('fs');
            const path = require('path');
            const filePath = path.resolve(args[1]);
            if (!fs.existsSync(filePath)) {
              printError(`文件不存在: ${filePath}`);
            } else {
              try {
                const code = fs.readFileSync(filePath, 'utf-8');
                const baseName = path.basename(filePath, '.js');
                gwPlugins.savePlugin(baseName, code);
                printSuccess(`已导入插件: ${baseName}`);
              } catch (e) {
                printError(e.message);
              }
            }
          } else if (action === 'add' || action === 'create') {
            printInfo('用法: plugin gateway add <name>');
          } else {
            printInfo('用法: plugin gateway list | reload | enable <name> | disable <name> | add <name> | delete <name> | edit <name> | show <name> | import <file>');
          }
        } else if (['init', 'create', 'new', 'dev', 'develop', 'doctor', 'check', 'validate', 'link', 'unlink'].includes(subCommand)) {
          // SDK plugin development tools
          const { handlePlugin } = require('./handlers/plugin-dev');
          const optionTokens = [];
          for (const [k, v] of Object.entries(options || {})) {
            if (v === true) {
              optionTokens.push(`--${k}`);
            } else if (v !== false && v !== null && v !== undefined && String(v).length > 0) {
              optionTokens.push(`--${k}`, String(v));
            }
          }
          await handlePlugin([subCommand, ...args, ...optionTokens]);
        } else if (!subCommand || subCommand === 'help') {
          // Show combined help
          const { handlePlugin } = require('./handlers/plugin-dev');
          await handlePlugin([]);
        } else {
          printInfo(`插件目录: ${PLUGINS_DIR}/`);
          printInfo('用法: plugin list | reload | gateway | init | dev | doctor | link | unlink');
        }
        return true;
      }

      // ── Agent-backend launchers (agentLauncherRegistry SSOT) ──
      // Legacy five + registry-added backends (opencode direct, warp/vscode/
      // windsurf model-select). handleIdeCommand branches on launcher kind.
      case 'kiro':
      case 'cursor':
      case 'claude':
      case 'codex':
      case 'trae':
      case 'opencode':
      case 'warp':
      case 'vscode':
      case 'windsurf': {
        // Credential-convenience verbs for the AI-agent launchers. The verb is
        // read from `subCommand || args[0]`: launcher commands are NOT registered
        // in SUB_COMMANDS, so parseInput leaves the verb in args[0]. When a verb
        // matches, we consume it (shift) so any remaining positional (e.g. a relay
        // name or export path) lines up. Non-credential input (bare `khy claude`,
        // model names, etc.) falls through untouched to the IDE launcher below.
        const _credVerb = String((subCommand || (args && args[0]) || '')).toLowerCase();
        const _peel = () => { if (!subCommand && args && args[0] && String(args[0]).toLowerCase() === _credVerb) args.shift(); };

        // `khy claude adopt-env` / `use-cc-env`: persist the current Claude Code
        // credentials (ANTHROPIC_* env) into ~/.khy/.env so khy reuses the same
        // relay + token after every pip upgrade. Intercept before the IDE handler.
        if (command === 'claude' && (_credVerb === 'adopt-env' || _credVerb === 'use-cc-env')) {
          _peel();
          const { handleClaudeAdoptEnv } = require('./handlers/claudeAdopt');
          await handleClaudeAdoptEnv(options);
          return true;
        }
        // `khy claude use-relay <name>` (alias `relay`/`relays` to list): activate a
        // shipped, opt-in relay preset — non-secret base URL comes from the package,
        // the token is still supplied by the user's shell env.
        if (command === 'claude' && (_credVerb === 'use-relay' || _credVerb === 'relay' || _credVerb === 'relays')) {
          _peel();
          const { handleClaudeUseRelay } = require('./handlers/claudeAdopt');
          await handleClaudeUseRelay((args && args[0]) || '', options);
          return true;
        }
        // `khy claude export-env [path]`: write a portable credential file (default
        // Desktop) so the user can carry it to a new machine. Local file on the
        // user's own machine — token is written to it, never to the package.
        if (command === 'claude' && (_credVerb === 'export-env' || _credVerb === 'export-cc-env')) {
          _peel();
          const { handleClaudeExportEnv } = require('./handlers/claudeAdopt');
          await handleClaudeExportEnv((args && args[0]) || '', options);
          return true;
        }
        // `khy codex adopt-env` / `use-codex-env`: codex-side parity with the claude
        // trio — persist the current codex credentials (CODEX_API_KEY / OPENAI_API_KEY
        // + optional relay base URL) into ~/.khy/.env so khy reuses them after every
        // pip upgrade. Same "configure once, works after every upgrade" as `khy claude`.
        if (command === 'codex' && (_credVerb === 'adopt-env' || _credVerb === 'use-codex-env')) {
          _peel();
          const { handleCodexAdoptEnv } = require('./handlers/codexAdopt');
          await handleCodexAdoptEnv(options);
          return true;
        }
        // `khy codex use-relay <name>` (alias `relay`/`relays` to list): activate a
        // shipped, opt-in OpenAI/Codex relay preset — non-secret base URL comes from
        // the package, the key is still supplied by the user's shell env.
        if (command === 'codex' && (_credVerb === 'use-relay' || _credVerb === 'relay' || _credVerb === 'relays')) {
          _peel();
          const { handleCodexUseRelay } = require('./handlers/codexAdopt');
          await handleCodexUseRelay((args && args[0]) || '', options);
          return true;
        }
        // `khy codex export-env [path]`: write a portable credential file (default
        // Desktop) so the user can carry it to a new machine. Local file on the
        // user's own machine — key is written to it, never to the package.
        if (command === 'codex' && (_credVerb === 'export-env' || _credVerb === 'export-codex-env')) {
          _peel();
          const { handleCodexExportEnv } = require('./handlers/codexAdopt');
          await handleCodexExportEnv((args && args[0]) || '', options);
          return true;
        }
        const { handleIdeCommand } = require('./handlers/ide');
        await handleIdeCommand(command, options, context);
        return true;
      }

      // ── Account Pool ──
      case 'pool': {
        const pool = require('./handlers/pool');
        if (subCommand === 'list') await pool.handlePoolList(args[0]);
        else if (subCommand === 'add') await pool.handlePoolAdd(args[0], args[1]);
        else if (subCommand === 'delete' || subCommand === 'remove') await pool.handlePoolDelete(args[0]);
        else if (subCommand === 'enable') await pool.handlePoolEnable(args[0]);
        else if (subCommand === 'disable') await pool.handlePoolDisable(args[0]);
        else if (subCommand === 'import') await pool.handlePoolImport(args[0], args[1]);
        else if (subCommand === 'use') await pool.handlePoolUse(args[0], args[1]);
        else if (subCommand === 'api') await pool.handlePoolApi(args[0]);
        else if (subCommand === 'status') await pool.handlePoolStatus();
        else if (subCommand === 'scheduling') await pool.handlePoolScheduling(args[0]);
        else if (subCommand === 'auto-import') await pool.handlePoolAutoImport(args[0], args[1], args[2]);
        else await pool.handlePoolStatus();
        return true;
      }

      // ── Proxy ──
      case 'proxy': {
        const proxy = require('./handlers/proxy');
        if (subCommand === 'start') await proxy.handleProxyStart(options);
        else if (subCommand === 'stop') await proxy.handleProxyStop();
        else if (subCommand === 'status') await proxy.handleProxyStatus();
        else if (subCommand === 'help') await proxy.handleProxyHelp();
        else if (subCommand === 'quickstart') await proxy.handleProxyQuickstart(args, options);
        else if (subCommand === 'cert') await proxy.handleProxyCert(args[0] || 'generate', args.slice(1), options);
        else if (subCommand === 'core') await proxy.handleProxyCore(args[0] || 'status', args.slice(1), options);
        else if (subCommand === 'client') await proxy.handleProxyClient(args[0] || 'list', args.slice(1), options);
        else if (subCommand === 'token') await proxy.handleProxyToken(args[0] || 'status', args.slice(1), options);
        else if (subCommand === 'subscription' || subCommand === 'sub') await proxy.handleProxySubscription(args[0] || 'list', args.slice(1), options);
        else if (subCommand === 'tls') await proxy.handleProxyTls(args[0] || 'status', args[1] || null);
        else if (subCommand === 'switch-center' || subCommand === 'switch') await proxy.handleProxySwitchCenter(args[0] || 'status', args.slice(1), options);
        else if (subCommand === 'trae-switch') await proxy.handleProxyTraeSwitch(args[0] || 'status', args.slice(1), options);
        else if (subCommand === 'windsurf-switch') await proxy.handleProxyWindsurfSwitch(args[0] || 'status', args.slice(1), options);
        else if (subCommand === 'cursor2api') await proxy.handleProxyCursor2Api(args[0] || 'status', args.slice(1), options);
        else await proxy.handleProxyHelp();
        return true;
      }

      // ── Cron Scheduler ──
      case 'cron': {
        const { handleCronCommand } = require('./handlers/cron');
        await handleCronCommand(subCommand, args, options);
        return true;
      }

      // ── Portable CLI Tools (claude/codex/opencode 便携版) ──
      case 'tools': {
        const { handleToolsCommand } = require('./handlers/tools');
        await handleToolsCommand(subCommand, args);
        return true;
      }

      // ── Skin / Theme ──
      case 'skin': {
        const tr = require('./themeRegistry');
        const chalk = require('chalk').default || require('chalk');
        if (subCommand === 'set' && args[0]) {
          const ok = tr.setTheme(args[0]);
          if (ok) console.log(chalk.green(`  Theme switched to: ${args[0]}`));
          else console.log(chalk.yellow(`  Unknown theme: ${args[0]}. Use "skin list" to see available themes.`));
        } else {
          const themes = tr.listThemes();
          console.log('');
          console.log(chalk.bold('  Available Themes'));
          console.log('');
          for (const t of themes) {
            const marker = t.active ? chalk.green(' (active)') : '';
            console.log(`  ${chalk.cyan(t.name.padEnd(16))} ${t.label}${marker}`);
            if (t.description) console.log(`  ${' '.repeat(16)} ${chalk.dim(t.description)}`);
          }
          console.log('');
          console.log(chalk.dim('  Usage: skin set <name>'));
          console.log('');
        }
        return true;
      }

      // ── Skills ──
      case 'skill': {
        const { handleSkillCommand } = require('./handlers/skill');
        await handleSkillCommand(subCommand, args, options);
        return true;
      }

      // ── Skill-Gap (capability gap tracking) ──
      case 'skill-gap':
      case 'skillgap': {
        const { handleSkillGapCommand } = require('./handlers/skillGap');
        handleSkillGapCommand(subCommand, args, options);
        return true;
      }

      // ── Persona (C1) ──
      case 'persona': {
        const { handlePersonaCommand } = require('./handlers/persona');
        await handlePersonaCommand(subCommand, args, options);
        return true;
      }

      // ── Session Search ──
      case 'session': {
        const { handleSessionCommand } = require('./handlers/session');
        await handleSessionCommand(subCommand, args, options);
        return true;
      }

      case 'storage': {
        // Storage placement: show where data lives + migrate the data home onto
        // a non-system drive (explicit, verified, reversible — never automatic).
        const { handleStorageCommand } = require('./handlers/storage');
        await handleStorageCommand(subCommand, args, options);
        return true;
      }

      // Full uninstall / historical-residual cleanup. Enumerates every data home
      // / runtime / pointer / visible-alias khy ever placed under $HOME (SSOT in
      // services/uninstall/uninstallPlan.js), previews by default, removes only
      // with --yes, and can optionally purge the npm-global / pip package too.
      case 'uninstall': {
        const { handleUninstall } = require('./handlers/uninstall');
        await handleUninstall(subCommand, args, options);
        return true;
      }

      // Feature index / command discovery. Prints every discoverable command
      // grouped by category, consuming the same SSOT
      // (services/commandCatalog/commandCatalog.buildCommandCatalog) as the
      // backend GET /api/commands endpoint and the frontend FeatureCatalog view,
      // so "有了功能却不知去哪用" never happens across surfaces.
      case 'features': {
        const { handleFeatures } = require('./handlers/features');
        await handleFeatures(subCommand, args, options);
        return true;
      }

      // Tool list / capability discovery. Prints every AI tool khy can call
      // (Read/Edit/Bash/… + MCP + custom), grouped by category, consuming the
      // tool registry SSOT via services/toolCatalog/toolCatalog.buildToolCatalog.
      // Sibling to /features (which lists slash commands, not model tools).
      case 'toollist': {
        const { handleToolList } = require('./handlers/toollist');
        await handleToolList(subCommand, args, options);
        return true;
      }

      // Tool contract check / precision audit. Sweeps the whole tool registry
      // and reports bad shapes / schemas / naming collisions (cross-risk or
      // cross-category = error), consuming services/toolCatalog/toolContract.
      // Sibling to /toollist; the same auditor backs scripts/check-tool-contract.js.
      case 'toolcheck': {
        const { handleToolCheck } = require('./handlers/toolcheck');
        await handleToolCheck(subCommand, args, options);
        return true;
      }

      // ── Source self-heal ──
      // 手动源码自愈:体检并修复缺失/损坏的运行时源码文件(默认 dry-run,--apply 真修复)。
      // 覆盖 goal 触发点⑦「其他」+ 人工控制;自动触发点由 bootstrap/TUI 的 runStartupHeal 覆盖。
      case 'heal': {
        const { handleHeal } = require('./handlers/heal');
        await handleHeal(subCommand, args, options);
        return true;
      }

      // ── Template jobs (CC `/job` alignment) ──
      // Instantiate a reusable markdown template into a durable job under
      // <dataHome>/jobs, then reply/inspect. Sibling to /cron (scheduled) and
      // /tasks (runtime tasks). Handler: cli/handlers/job.js.
      case 'job': {
        const { handleJob } = require('./handlers/job');
        await handleJob(subCommand, args, options);
        return true;
      }

      // ── Local models (Ollama) ──
      case 'models': {
        const mgr = require('../services/ollamaModelManager');
        const { _writeEnvPatch: writeEnvPatch } = require('./handlers/config');

        if (subCommand === 'list' || !subCommand) {
          const running = await mgr.isOllamaRunning();
          if (!running) {
            if (options.json) {
              console.log(JSON.stringify({
                ok: false,
                action: 'list',
                provider: 'ollama',
                error: 'ollama_not_running',
                message: 'Ollama 未运行。请先执行: ollama serve',
              }, null, 2));
            } else {
              printError('Ollama 未运行。请先执行: ollama serve');
            }
            return true;
          }
          const models = await mgr.listModels();
          if (options.json) {
            console.log(JSON.stringify({
              ok: true,
              action: 'list',
              provider: 'ollama',
              count: models.length,
              models,
            }, null, 2));
            return true;
          }
          if (!models.length) { printInfo('暂无已安装模型'); return true; }
          printTable(
            ['模型', '大小', '参数量', '量化'],
            models.map(m => [m.name, m.size, m.paramSize || '-', m.quantization || '-'])
          );
          return true;
        }

        if (subCommand === 'pull') {
          const modelId = args[0];
          if (!modelId) {
            if (options.json) {
              console.log(JSON.stringify({
                ok: false,
                action: 'pull',
                provider: 'ollama',
                error: 'missing_model_id',
                message: '用法: models pull <model-id>',
              }, null, 2));
            } else {
              printError('用法: models pull <model-id>');
            }
            return true;
          }
          const running = await mgr.isOllamaRunning();
          if (!running) {
            if (options.json) {
              console.log(JSON.stringify({
                ok: false,
                action: 'pull',
                provider: 'ollama',
                model: modelId,
                error: 'ollama_not_running',
                message: 'Ollama 未运行。请先执行: ollama serve',
              }, null, 2));
            } else {
              printError('Ollama 未运行。请先执行: ollama serve');
            }
            return true;
          }
          printInfo(`开始下载: ${modelId}`);
          await mgr.pullModel(modelId, (progress) => {
            if (progress.total > 0 && process.stdout.isTTY) {
              process.stdout.write(`\r  ⟳ ${progress.status} ${progress.percent}%`);
            }
          });
          console.log('');
          printSuccess(`下载完成: ${modelId}`);
          return true;
        }

        if (subCommand === 'import') {
          const sourcePath = args[0];
          const modelName = args[1] || options.name || '';
          if (!sourcePath) {
            printError('用法: models import <path> [model-name] [--base qwen2.5:7b]');
            printInfo('支持: .gguf 文件 / safetensors 模型目录 / .safetensors adapter');
            return true;
          }
          const running = await mgr.isOllamaRunning();
          if (!running) { printError('Ollama 未运行。请先执行: ollama serve'); return true; }
          const result = await mgr.importModel(sourcePath, modelName, {
            base: options.base,
            systemPrompt: options.system,
            temperature: options.temperature,
            topP: options.top_p || options.topP,
            numCtx: options.num_ctx || options.numCtx,
          });
          if (!result.success) {
            printError(`导入失败: ${result.error}`);
            if (result.sourceKind === 'adapter') {
              printInfo('adapter 导入需要 --base，例如: models import ./adapter.safetensors mymodel --base qwen2.5:7b');
            }
            return true;
          }
          printSuccess(`导入成功: ${result.model} (${result.sourceKind})`);
          if (options.use || options.select) {
            writeEnvPatch({
              GATEWAY_PREFERRED_ADAPTER: 'ollama',
              GATEWAY_PREFERRED_STRICT: 'true',
              OLLAMA_MODEL: result.model,
            });
            try {
              const gateway = require('../services/gateway/aiGateway');
              await gateway.refreshAdapters();
            } catch { /* best effort */ }
            printSuccess(`已切换为默认模型: ollama/${result.model}`);
          } else {
            printInfo(`可运行: models set ${result.model}`);
          }
          return true;
        }

        if (subCommand === 'set') {
          const modelId = args[0];
          if (!modelId) {
            if (options.json) {
              console.log(JSON.stringify({
                ok: false,
                action: 'set',
                provider: 'ollama',
                error: 'missing_model_id',
                message: '用法: models set <model-id>',
              }, null, 2));
            } else {
              printError('用法: models set <model-id>');
            }
            return true;
          }
          const envPath = writeEnvPatch({
            GATEWAY_PREFERRED_ADAPTER: 'ollama',
            GATEWAY_PREFERRED_STRICT: 'true',
            OLLAMA_MODEL: modelId,
          });
          try {
            const gateway = require('../services/gateway/aiGateway');
            await gateway.refreshAdapters();
          } catch { /* best effort */ }
          if (options.json) {
            console.log(JSON.stringify({
              ok: true,
              action: 'set',
              provider: 'ollama',
              model: modelId,
              envPath,
            }, null, 2));
          } else {
            printSuccess(`已设置默认模型: ollama/${modelId}`);
          }
          return true;
        }

        if (subCommand === 'delete') {
          const modelId = args[0];
          if (!modelId) {
            if (options.json) {
              console.log(JSON.stringify({
                ok: false,
                action: 'delete',
                provider: 'ollama',
                error: 'missing_model_id',
                message: '用法: models delete <model-id>',
              }, null, 2));
            } else {
              printError('用法: models delete <model-id>');
            }
            return true;
          }
          const running = await mgr.isOllamaRunning();
          if (!running) {
            if (options.json) {
              console.log(JSON.stringify({
                ok: false,
                action: 'delete',
                provider: 'ollama',
                model: modelId,
                error: 'ollama_not_running',
                message: 'Ollama 未运行。请先执行: ollama serve',
              }, null, 2));
            } else {
              printError('Ollama 未运行。请先执行: ollama serve');
            }
            return true;
          }
          const ok = await mgr.deleteModel(modelId);
          if (ok) printSuccess(`已删除模型: ${modelId}`);
          else printError(`删除失败: ${modelId}`);
          return true;
        }

        printError(`未知子命令: ${subCommand}`);
        printInfo('可用: models list|pull|import|delete|set');
        return true;
      }

      case 'khymodel': {
        const modelImport = require('../services/modelImportService');

        if (subCommand === 'list' || !subCommand) {
          printInfo('正在扫描所有模型...');
          const all = await modelImport.listAllModels();

          // KHY/Ollama imported models
          if (all.khyModels.length) {
            printSuccess(`KHY/Ollama 已导入模型 (${all.khyModels.length})`);
            printTable(
              ['模型', '大小', '架构', '量化', '来源'],
              all.khyModels.map(m => [m.name, m.size, m.family || '-', m.quantization || '-', m.source || 'ollama'])
            );
          } else {
            printInfo('KHY/Ollama 已导入模型: 无');
          }

          // Local model files
          if (all.localModels.length) {
            console.log('');
            printInfo(`本地模型文件 (${all.localModels.length})`);
            printTable(
              ['名称', '大小', '格式', '位置', '状态'],
              all.localModels.map(m => [
                m.name,
                m.sizeStr,
                m.format,
                m.location,
                m.imported ? '✓ 已导入' : '✗ 未导入',
              ])
            );
            const unimported = all.localModels.filter(m => !m.imported);
            if (unimported.length) {
              printInfo(`提示: ${unimported.length} 个模型未导入，可使用 khymodel import <序号> 或 models import <path> 导入`);
            }
          } else {
            printInfo('未发现本地模型文件');
          }

          // IDE models
          if (all.ideModels && all.ideModels.length) {
            console.log('');
            printInfo(`IDE 可用模型 (${all.ideModels.length})`);
            printTable(
              ['模型', '来源IDE', '路由地址'],
              all.ideModels.map(m => [m.name, m.source, m.route])
            );
            const { resolveLocalProxyOpenAiBaseUrl } = require('../utils/proxyBaseUrl');
            printInfo(`提示: 可通过 gateway proxy 将这些模型伪装为 OpenAI API (${resolveLocalProxyOpenAiBaseUrl()})`);
          }

          return true;
        }

        if (subCommand === 'import') {
          const sourcePath = args[0];
          if (!sourcePath) {
            printError('用法: khymodel import <path|url> [model-name]');
            printInfo('支持: .gguf / .safetensors / .zip / 模型目录 / 下载URL');
            return true;
          }
          printInfo(`正在导入: ${sourcePath}`);
          const result = await modelImport.importModel(sourcePath, { name: args[1] || '' });
          if (result.success) {
            printSuccess(`导入成功: ${result.model} (${result.sourceKind})`);
            if (result.steps) printInfo(`步骤: ${result.steps.join(' → ')}`);
          } else {
            printError(`导入失败: ${result.error}`);
            if (result.steps) printInfo(`步骤: ${result.steps.join(' → ')}`);
          }
          return true;
        }

        if (subCommand === 'export') {
          const modelName = args[0];
          if (!modelName) {
            printError('用法: khymodel export <ollama-model-name> [dest-dir]');
            printInfo('从 Ollama 导出模型到 KHY 本地模型目录');
            return true;
          }
          printInfo(`正在从 Ollama 导出: ${modelName}`);
          const result = await modelImport.exportFromOllama(modelName, args[1]);
          if (result.success) {
            printSuccess(`导出成功: ${result.path} (${result.sizeMB} MB)`);
          } else {
            printError(`导出失败: ${result.error}`);
          }
          return true;
        }

        if (subCommand === 'scan') {
          printInfo('正在扫描本地模型文件...');
          const localFiles = modelImport.discoverLocalModels();
          if (!localFiles.length) { printInfo('未发现模型文件'); return true; }
          printTable(
            ['名称', '大小', '格式', '位置', '路径'],
            localFiles.map(m => [
              m.name,
              _ccFileSize(m.sizeMB * 1024 * 1024, m.sizeMB > 1024 ? `${(m.sizeMB / 1024).toFixed(1)} GB` : `${m.sizeMB} MB`),
              m.format,
              m.location,
              m.path.length > 60 ? '...' + m.path.slice(-57) : m.path,
            ])
          );
          return true;
        }

        printError(`未知子命令: ${subCommand}`);
        printInfo('可用: khymodel list|import|export|scan');
        return true;
      }

      default: {
        // Handle /huifu shortcut for context resume
        if (command === '/huifu' || command === '/恢复' || command === '/resume') {
          const ai = require('./ai');
          const result = ai.resumeConversation();
          if (result.success) {
            printSuccess(`已恢复上次对话 (${result.messageCount} 条消息, ${new Date(result.timestamp).toLocaleString('zh-CN')})`);
            printInfo('AI 已具有之前的对话上下文，继续提问即可');
          } else {
            printInfo('暂无可恢复的对话记录');
          }
          return true;
        }

        // Handle /cost shortcut
        if (command === '/cost' || command === '/费用') {
          const tokenSvc = require('../services/tokenUsageService');
          console.log(tokenSvc.formatCostReport());
          return true;
        }

        // Handle /memory shortcut
        if (command === '/memory' || command === '/指令' || command === '/khy') {
          // Delegate to the 'memory' command
          return route({ command: 'memory', subCommand: null, args: [], options: {}, rawInput: command }, context);
        }

        // Check if input is a skill trigger (e.g., /analyze)
        const rawToken = (parsed.rawCommandToken || String(parsed.rawInput || '').split(/\s+/)[0] || '').trim();
        if (rawToken.startsWith('/')) {
          const skillRegistry = require('../services/skillRegistry');
          const skill = skillRegistry.findSkillByTrigger(rawToken);
          if (skill) {
            const result = await skillRegistry.executeSkill(skill.id, args, { options });
            if (result && result.type === 'ai-prompt') {
              return { aiForward: result.prompt };
            }
            return true;
          }
        }

        // Try SDK plugins (formal khy-* plugins registered via plugin-loader)
        const cmdRegistry = require('./commandRegistry');
        const sdkCmd = cmdRegistry.getAll().find(c =>
          c._pluginHandler && (c.cmd === `/${command}` || (c._aliases && c._aliases.includes(command)))
        );
        if (sdkCmd && sdkCmd._pluginHandler) {
          const parsedArgs = { raw: parsed.rawInput || '', positional: args, flags: options };
          const cmdContext = {
            print: (text) => console.log(text),
            printStyled: (text) => console.log(text),
            prompt: async (msg) => { const readline = require('readline'); const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); return new Promise(r => rl.question(msg, a => { rl.close(); r(a); })); },
            spinner: (msg) => { const ora = require('ora'); const s = ora(msg).start(); return { update: (m) => { s.text = m; }, succeed: (m) => s.succeed(m), fail: (m) => s.fail(m), stop: () => s.stop() }; },
            cwd: process.cwd(),
          };
          try {
            await sdkCmd._pluginHandler(parsedArgs, cmdContext);
          } catch (err) {
            fmt().printError(`Plugin command error: ${err.message}`);
          }
          return true;
        }

        // Try user plugins
        const pluginHandled = await plugins().tryPlugin(command, args, options);
        if (pluginHandled) return true;

        // ── G1/G2 拼写纠错 + 模糊命令建议 ──────────────────────
        // 仅对看起来像命令的输入触发（非中文自然语言、非长句子）
        // TUI 模式下跳过 inquirer 交互（alternate screen 与 readline 冲突），
        // 直接 fall through 到 AI。
        const isTui = process.stdout.isTTY;
        const rawForFuzzy = (parsed.rawInput || '').trim();
        // 记录交互式(inquirer)未知命令提示是否已出现,避免下方非交互提示重复数落同一输入。
        let _unknownInteractiveShown = false;
        const looksLikeCommand = rawForFuzzy.length <= 30
          && !/[\u4e00-\u9fff]{3,}/.test(rawForFuzzy)  // 排除中文长句
          && /^[a-zA-Z\/]/.test(rawForFuzzy);           // 以英文或 / 开头
        if (looksLikeCommand && !isTui) {
          const suggestions = _findClosestCommands(rawForFuzzy);
          if (suggestions.length > 0) {
            if (suggestions.length === 1 && suggestions[0].dist <= 1) {
              // 距离 ≤1，直接提示单个候选
              printWarn(`未知命令 "${rawForFuzzy}"，你是否想执行 "${suggestions[0].label}"？`);
              _unknownInteractiveShown = true;
              try {
                const inquirer = require('inquirer');
                const { confirm } = await inquirer.prompt([{
                  type: 'confirm', name: 'confirm',
                  message: `执行 "${suggestions[0].label}"？`, default: true,
                }]);
                if (confirm) {
                  const reParsed = parseInput(suggestions[0].label + ' ' + args.join(' '));
                  if (reParsed) return route(reParsed, context);
                }
              } catch { /* 用户取消或 stdin 异常，fall through to AI */ }
            } else {
              // 多个候选，列表选择
              printWarn(`未知命令 "${rawForFuzzy}"，你是否想执行以下命令？`);
              _unknownInteractiveShown = true;
              try {
                const inquirer = require('inquirer');
                const choices = suggestions.map(s => ({ name: s.label, value: s.label }));
                choices.push({ name: '不，发送给 AI', value: '__ai__' });
                const { picked } = await inquirer.prompt([{
                  type: 'list', name: 'picked',
                  message: '选择命令:', choices,
                }]);
                if (picked !== '__ai__') {
                  const reParsed = parseInput(picked + ' ' + args.join(' '));
                  if (reParsed) return route(reParsed, context);
                }
              } catch { /* fall through to AI */ }
            }
          }
        }

        // ── G10/G8 意图预分类 + 澄清 ──────────────────────────
        // 对自然语言短输入尝试匹配命令路由
        // TUI 模式下跳过需要 inquirer 的多义澄清
        try {
          const { matchIntentRoutes, clarifyIntent } = require('../services/inputPreprocessor');
          const intentMatches = matchIntentRoutes(rawForFuzzy);
          if (intentMatches.length === 1) {
            // 单一匹配 — 直接跳转（无需 inquirer，TUI 安全）
            printInfo(`检测到意图: ${intentMatches[0].label}，已跳转`);
            const reParsed = parseInput(intentMatches[0].route);
            if (reParsed) return route(reParsed, context);
          } else if (intentMatches.length >= 2 && !isTui) {
            // 多义匹配 — G8 澄清 + 超时降级（仅限非 TUI）
            // 触发 inkComponents 自注册交互菜单到 interactiveMenuPort（cli→cli，
            // 惰性，仅此分支），使 service 层 clarifyIntent 经端口取用而无需反向依赖 cli
            // （DESIGN-ARCH-057）。端口未注册时 clarifyIntent 自降级 inquirer/首候选。
            try { require('./ui/inkComponents'); } catch { /* 降级路径仍可用 */ }
            const chosen = await clarifyIntent(intentMatches, rawForFuzzy);
            if (chosen && chosen.route) {
              const reParsed = parseInput(chosen.route);
              if (reParsed) return route(reParsed, context);
            }
            // chosen === null → 用户选择发送给 AI，fall through
          }
        } catch { /* best effort, fall through to AI */ }

        // ── 未知斜杠命令提示(TUI 安全,非交互)──────────────────────
        // 用户显式敲了命令语法 `/x` 却无任何命令/技能/插件/意图匹配。上面的交互式模糊纠错
        // 在 TUI 下被 `&& !isTui` 跳过 → 此前用户毫无反馈。这里补一条非交互提示再照常交 AI。
        // 只对显式斜杠命令发声;裸词/自然语言问句返回 null,无声交 AI(未知问题≠未知命令)。
        if (!_unknownInteractiveShown) {
          try {
            const _uh = require('./unknownCommandHint');
            if (_uh.isEnabled(process.env)) {
              const _rawTok = String(parsed.rawCommandToken || rawForFuzzy || '').trim();
              const _hint = _uh.buildUnknownCommandHint({
                rawToken: _rawTok,
                suggestions: _uh.isExplicitSlashCommand(_rawTok) ? _findClosestCommands(_rawTok) : [],
              });
              if (_hint) printInfo(_hint);
            }
          } catch { /* 提示尽力而为,绝不阻断 AI 兜底 */ }
        }

        return false; // → AI
      }
    }
  } catch (err) {
    // 红线：绝不只显示退出码/「命令执行失败」——必须给出真实原因 + 解决方案。
    try {
      require('./cliErrorReporter').reportCliError(err);
    } catch {
      printError(err && err.message ? err.message : '命令执行失败（且未能解析具体原因，请以 KHY_VERBOSE=1 重跑）');
    }
    return true;
  }
}

/**
 * Get auto-complete suggestions for partial input.
 */
function getCompletions(partial) {
  const parts = partial.split(/\s+/);
  // allKeys 只喂下方非斜杠分支的 `unique`;斜杠路径(最常见,且是 TUI 每键前缀回退源)从不使用。
  // 门控开 → 惰性构造(下沉到斜杠 early-return 之后);关 → 顶部即时构造(逐字节回退今日行为)。
  const _lazyKeys = completionKeysLazy().isEnabled(process.env);
  const _computeAllKeys = () => [...COMMANDS, ...aliases().getAllAliasKeys()];
  const allKeys = _lazyKeys ? null : _computeAllKeys();

  // Slash command completion (delegate to commandRegistry if available)
  if (parts[0].startsWith('/')) {
    const slashPartial = parts[0].toLowerCase();
    try {
      const cmdReg = require('./commandRegistry');
      return cmdReg.getCompletions(slashPartial);
    } catch { /* fallback */ }
    return SLASH_COMMANDS
      .filter(sc => sc.cmd.startsWith(slashPartial))
      .map(sc => sc.cmd);
  }

  // 到这里才真正需要 allKeys:门控开时惰性构造(斜杠路径已 return,不会到达此处)。
  const _keys = _lazyKeys ? completionKeysLazy().buildKeys(_computeAllKeys) : allKeys;
  const unique = [...new Set(_keys)];

  if (parts.length <= 1) {
    return unique.filter(c => c.startsWith(parts[0].toLowerCase()));
  }

  const cmd = parts[0].toLowerCase();
  // Resolve alias to find sub-commands
  const alias = aliases().resolveAlias(cmd);
  const canonicalCmd = alias ? alias.command : cmd;
  const sub = parts[1] || '';

  if (SUB_COMMANDS[canonicalCmd]) {
    return SUB_COMMANDS[canonicalCmd]
      .filter(s => s.startsWith(sub.toLowerCase()))
      .map(s => `${parts[0]} ${s}`);
  }

  return [];
}

// ── Slash Command Registry (Claude Code style) ────────────────────────

const _STATIC_SLASH_COMMANDS = getStaticSlashCommands();

// Dynamic SLASH_COMMANDS: prefer commandRegistry, fallback to static
let SLASH_COMMANDS;
try {
  const cmdReg = require('./commandRegistry');
  // 把用户自建技能(~/.khy/skills)并入注册表,使 TUI SLASH_COMMANDS 与 REPL 面板同源可见。
  // 绝不抛(内部已兜底);门控 KHY_USER_SKILL_MENU 关时为无操作。
  try { cmdReg.registerUserSkills(); } catch { /* 技能发现失败不影响内置命令 */ }
  // 把 Claude Code 自定义斜杠命令(~/.claude/commands 等)并入注册表,复用第三方命令包。
  // 绝不抛(内部已兜底);门控 KHY_CC_COMMAND_BRIDGE 关时为无操作(逐字节回退)。
  try { cmdReg.registerCcCommands(); } catch { /* CC 命令发现失败不影响内置命令 */ }
  SLASH_COMMANDS = cmdReg.toSlashCommands();
} catch {
  SLASH_COMMANDS = _STATIC_SLASH_COMMANDS;
}

module.exports = { parseInput, route, getCompletions, COMMANDS, SLASH_COMMANDS, _applyVerbosityFlag, _ccFileSize, _ccTaskAge };

// Register this router as the command dispatcher on the neutral port so the
// services layer (toolCalling SlashCommand handler) can dispatch slash commands
// without a reverse `services → cli/router` require (DESIGN-ARCH-021, Batch 1).
// This is the legit `cli → services` direction; export signature is unchanged.
try {
  require('../services/commandDispatchPort').registerDispatcher({ parseInput, route });
} catch { /* port unavailable — handler degrades gracefully */ }
