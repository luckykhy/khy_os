/**
 * Interactive REPL — the heart of the CLI.
 * Combines command mode, menu mode, and AI conversation mode.
 *
 * All heavy modules are lazy-loaded for fast cold start.
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
// Load the permission dialog at cli startup so it self-registers its interactive
// prompter into the service-layer permissionPromptPort (DESIGN-ARCH-057). The
// service layer no longer requires cli/ui/permissionDialog directly; this is the
// single legit load point that wires the cli → services injection.
require('./ui/permissionDialog');
const { foldOutput } = require('./toolDisplayPolicy');
const { createTaskMindMap, createIdleTaskMindMap, extractPlanStepsFromText } = require('./taskMindMap');
const { FeatureCapabilityMap } = require('./featureCapabilityMap');
const { LineBuffer, AdaptiveChunker } = require('./lineBuffer');
const { MarkdownStreamState } = require('./streamingMarkdown');
const {
  toolResultReflection: _toolResultReflection,
} = require('./toolResultVoice');



// ── Lazy module loaders (Claude-style: zero top-level heavy requires) ──
let _chalk, _inquirer, _formatters, _router, _ai, _menu, _userProfile;
const chalk = () => {
  if (_chalk) return _chalk;
  const chalkModule = require('chalk');
  _chalk = chalkModule.default || chalkModule;
  return _chalk;
};
const inquirer = () => (_inquirer ??= require('inquirer'));
const fmt = () => (_formatters ??= require('./formatters'));
const router = () => (_router ??= require('./router'));
const ai = () => (_ai ??= require('./ai'));
const menu = () => (_menu ??= require('./menu'));
const userProfile = () => (_userProfile ??= require('../services/userProfile'));

const os = require('os');
let _vimInput, _vimSettings;
const vimInput = () => (_vimInput ??= require('../vim/vimInput'));
const vimSettings = () => (_vimSettings ??= require('../vim/settings'));
const INTENT_ASSURANCE_DEBUG_SETTING_KEY = 'intentAssuranceDebug';




// ── Extracted helper modules (behavior-preserving god-file split) ──
// repl/history.js owns HISTORY_FILE/MAX_HISTORY and runs the 0600 chmod init on require.
const { HISTORY_FILE, MAX_HISTORY, loadHistory, saveHistory } = require('./repl/history');
const {
  KHY_SETTINGS_FILE,
  _readKhySettings,
  _writeKhySettings,
  _loadBooleanKhySetting,
  _persistBooleanKhySetting,
} = require('./repl/khySettings');
const {
  hasToolCallTag,
  stripToolCallTags,
  shouldBypassPlanMode,
  looksLikeUiEchoInput,
  isArrowEscapeLine,
  isEscOnlyInput: _isEscOnlyInput,
} = require('./repl/inputClassifiers');
// Pure prompt/tool display formatters (behavior-preserving god-file split).
const {
  formatShortCwd,
  shortenPromptPath,
  formatToolSummary,
  toolProgressStart: _toolProgressStart,
  toolProgressDone: _toolProgressDone,
  formatToolResult: _formatToolResult,
  toolProgressReason: _toolProgressReason,
  buildStreamingToolPreface: _buildStreamingToolPreface,
  stripInternalControlText: _stripInternalControlText,
} = require('./repl/displayFormatters');
// turn 级即时确认「先回应用户,再干活」(2026-07-05 用户反馈)。单一真源 cli/turnAckVoice.js;
// 门控 KHY_TURN_ACK。fail-soft:叶子缺失/异常 → 无 ack,逐字节回退历史。
let _turnAckVoice;
try { _turnAckVoice = require('./turnAckVoice'); } catch { _turnAckVoice = null; }
// 首响应静默窗口守护(firstResponseAckVoice;门 KHY_FIRST_RESPONSE_ACK)。提交 → 首 token 静默窗口内
// 无任何 chunk 到达时,及时甩一句「还在等模型响应」。fail-soft:叶子缺失/异常 → 不接线,逐字节回退历史。
let _firstResponseAckVoice;
try { _firstResponseAckVoice = require('./firstResponseAckVoice'); } catch { _firstResponseAckVoice = null; }
// 跨回合递增的轮换序号,让 turn-ack 短句每轮不同(治单调)。
let _replTurnAckSeq = 0;
// Pure intent-assurance debug snapshot builder (behavior-preserving god-file split).
const {
  buildIntentAssuranceDebugSnapshot: _buildIntentAssuranceDebugSnapshot,
} = require('./repl/intentDebugSnapshot');
// Pure busy-input & paste text classifiers (behavior-preserving god-file split).
const {
  PASTED_CONTENT_BLOCK_RE,
  summarizeQueuedInputForDisplay: _summarizeQueuedInputForDisplay,
  classifyBusyInput: _classifyBusyInput,
  findFirstMarker: _findFirstMarker,
  stripBracketArtifacts: _stripBracketArtifacts,
} = require('./repl/busyInputClassifiers');
// 忙碌插话的「转向新话题」判定（纯叶子）：steer 命中方向词但其实换了话题 → 降级为 queue。
const _busyTopicShift = require('./repl/busyTopicShift');
// 忙碌态中断升级(纯叶子):优雅取消没落地时,Ctrl+C / Esc 按 N 次即强制退出的逃生阀策略。
const _busyInterruptEscalation = require('./repl/busyInterruptEscalation');
// Pure streaming status-label & classification helpers (behavior-preserving god-file split).
const {
  phaseActionLabel: _phaseActionLabel,
  phaseStageLabel: _phaseStageLabel,
  normalizeProgressKey: _normalizeProgressKey,
  normalizeStatusDedupKey: _normalizeStatusDedupKey,
  isFailureMetricOnlyStatus: _isFailureMetricOnlyStatus,
  isLowValueGatewayStatus: _isLowValueGatewayStatus,
  isFailureSignalStatus: _isFailureSignalStatus,
  shouldBypassStartSilent: _shouldBypassStartSilent,
  isDynamicProgressStatus: _isDynamicProgressStatus,
  deriveLiveActivity: _deriveLiveActivity,
} = require('./repl/statusLabels');
const {
  extractInlineImageIntent,
  buildImageSceneHint,
  isWebRebuildIntent,
  buildWebRebuildPrompt,
  buildContextualImagePrompt,
} = require('./repl/imageIntent');
const { resolveImageRecognitionAssist } = require('./repl/imageRecognitionIntent');
const VERSION = require('../../package.json').version;

// ── Terminal title (ANSI escape) — extracted; owns its own topic/spinner state ──
const { setTerminalTitle, updateTitleFromConversation, updateTitlePhase } = require('./repl/terminalTitle');
// repl/tasksCommand.js owns the /tasks subsystem (status tables + list/detail render + dispatcher).
const { _handleTasksCommand } = require('./repl/tasksCommand');
// repl/errorReporting.js owns AI-error compaction + folded-status records (module-private state).
const {
  _recordFoldedStatus, _printFoldedStatusDetails, _handleExpandShortcut,
  _flushMergedErrorHintLine, _printLastAiError, _renderAiErrorCompact,
} = require('./repl/errorReporting');

// ── Extracted render helpers (behavior-preserving god-file split) ──
const {
  mapToolToPhaseLabel, getDisplayWidthChar, streamThinkingChunk, closeThinkingStream,
  bufferTextChunk, flushTextBuffer, _renderTextBlock, _createStreamingMdState, closeTextStream,
} = require('./repl/streamRender');
const {
  normalizePathLike, maybeRenderWriteDiff, maybeRenderInlineDiffFromToolOutput, _buildDirTree,
} = require('./repl/toolOutputRender');

// repl/startup.js owns startup model selection + interactive-menu dispatch.
const { offerModelSelection, executeMenuResult } = require('./repl/startup');
const { rankSlashCommands } = require('./repl/slashCommandFilter');
const {
  listAtEntries: _listAtEntriesPure,
  buildAtProjection: _buildAtProjection,
  applyAtFilter: _applyAtFilter,
  _defaultReaddir: _atDefaultReaddir,
} = require('./repl/atPicker');
const { composePermissionFooter: _composePermissionFooter } = require('./repl/footerLayout');

// 渲染去重纯叶子(门控 KHY_RENDER_DEDUP 默认开):判最终文本是否已在本回合流式展示过。
// 惰性 require + null 回退:即便文件缺失也不阻断 REPL。
let _renderDedup;
try { _renderDedup = require('./renderDedup'); } catch { _renderDedup = null; }

// 刀114:缓存命中率警告的跨回合趋势基线(对齐 CC cacheWarning.ts 的 last-hit-rate
// 记忆、及 TUI useQueryBridge 的 _lastCacheHitRateRef)。经典 REPL 此前从不做此判定,
// 仅 TUI 孪生有 —— 补齐同一「背后逻辑」到经典面(display-only,绝不回灌模型)。
// 会话进程作用域(一进程=一会话),与 TUI per-hook ref 生命周期同口径。null=尚无观测。
let _lastCacheHitRate = null;

// 缓存前缀击穿归因的跨回合基线(承 constants/promptPrefixShape 叶子)。命中率跌破阈值时,
// 把「为什么没命中」从数字变成可定位(系统提示/工具集/工具顺序变了)。存上一轮 result.prefixShape,
// 与本轮对比。进程作用域=一会话(同 _lastCacheHitRate)。null=尚无观测;无 shape → 不动。
let _lastPrefixShape = null;

// 会话累计命中率的计数器(承 KHY_CACHE_SESSION_AGGREGATE)。单轮命中率天然抖动;
// 累计整会话 hit/miss 给出更稳、更诚实的数字。进程作用域=一会话(同 _lastCacheHitRate)。
// null=尚无累计;由 cacheWarn.sessionAggregateFor 每轮读入/写回。
let _sessionCache = null;

// 会话花费阈值一次性警告的「已警告」记忆(对齐 CC CostThresholdDialog 的
// hasShownCostDialog:累计会话 API 花费首次越过阈值时提醒一次,不再重复)。
// 进程作用域=一进程一会话(与 _lastCacheHitRate / TUI ref 同口径)。false=尚未提醒。
let _costThresholdWarned = false;



// ── Host-injected REPL utilities (DESIGN: god-file isolation) ──
// The interactive session loop startRepl() is isolated in this sibling; the small
// display/format utilities it calls (_formatImageSize / _tk* / formatShellEscapeContext /
// _resetGatewayBreakerOnSessionClear) and the READ_SEARCH_TOOLS collapse set stay in the
// public entry cli/repl.js (they are independently exported + unit-tested there). They are
// injected once at host load via setReplSessionDeps BEFORE startRepl is ever invoked (startRepl
// runs only after the CLI is up), so the relocated body stays byte-identical (same identifiers).
let _formatImageSize = null;
let _tk1 = null;
let _tk0 = null;
let _tkSpin = null;
let formatShellEscapeContext = null;
let _resetGatewayBreakerOnSessionClear = null;
let READ_SEARCH_TOOLS = null;
function setReplSessionDeps(deps = {}) {
  if (typeof deps._formatImageSize === 'function') _formatImageSize = deps._formatImageSize;
  if (typeof deps._tk1 === 'function') _tk1 = deps._tk1;
  if (typeof deps._tk0 === 'function') _tk0 = deps._tk0;
  if (typeof deps._tkSpin === 'function') _tkSpin = deps._tkSpin;
  if (typeof deps.formatShellEscapeContext === 'function') formatShellEscapeContext = deps.formatShellEscapeContext;
  if (typeof deps._resetGatewayBreakerOnSessionClear === 'function') _resetGatewayBreakerOnSessionClear = deps._resetGatewayBreakerOnSessionClear;
  if (deps.READ_SEARCH_TOOLS !== undefined) READ_SEARCH_TOOLS = deps.READ_SEARCH_TOOLS;
}
/**
 * Start the interactive REPL loop.
 */
async function startRepl(options = {}) {
  // ── Pre-warm the per-submit critical path (interactive sessions only) ──
  // Pressing Enter on the first prompt would otherwise pay for synchronous,
  // event-loop-blocking work that freezes the Ink spinner for a beat: the CLI
  // availability probes (`claude`/`codex`/`aider --version`, re-run several times
  // by the gateway preflight + getStatus + re-detect passes) and the git context
  // collection. Both are cached after their first run, so we prime those caches
  // here — off the hot path, asynchronously — during the seconds the user spends
  // typing. By submit time the first request is a cache hit with zero blocking
  // spawnSync. Best-effort and TTY-only; never blocks or fails the session.
  if (process.stdout.isTTY && !options.oneShot) {
    try {
      require('../services/gateway/adapters/_commandAvailability')
        .prewarm(['claude', 'codex', 'aider'])
        .catch(() => {});
    } catch { /* availability cache is optional */ }
    // git context is collected synchronously (execSync); defer it off the mount
    // path so it warms its own 60s cache without blocking startup.
    setImmediate(() => {
      try { require('../services/gitContextService').collectGitContext(process.cwd()); }
      catch { /* git context is optional */ }
    });
    // The first submit lazily `require()`s the 8,786-line toolUseLoop (plus its
    // large transitive graph) in useQueryBridge — that cold load runs AFTER the
    // user message is pushed but BEFORE the first await, so it freezes the first
    // paint. Warm it off the hot path while the user is still typing so the first
    // Enter never pays the cold-require cost. Best-effort; never blocks startup.
    setImmediate(() => {
      try { require('../services/toolUseLoop'); }
      catch { /* loop module warm-up is optional */ }
    });
  }

  // ── LAN collaboration bridge: auto-start for interactive sessions (default on) ──
  // Surfaces the LAN URL + 6-digit PIN so other devices on the same network can
  // pair (see src/bridge/bridgeServer.js). Opt out with KHY_BRIDGE_AUTOSTART=0
  // (also false/no/off). Restricted to interactive TTY sessions and never the
  // one-shot prompt path, so `khy <cmd>` one-shot invocations never open a LAN
  // port. Best-effort: never blocks the REPL.
  //
  // The one-shot top banner (printStatus) is redundant with the persistent footer
  // bar (App.js FooterBar, KHY_BRIDGE_FOOTER default on) that already shows the
  // same URL / PIN / token under the input box — so we skip it by default. It is
  // still printed as a fallback when the footer is explicitly disabled, so the
  // pairing info never vanishes entirely; `khy bridge status` also prints it on demand.
  try {
    const bridgeOptOut = ['0', 'false', 'no', 'off'].includes(
      String(process.env.KHY_BRIDGE_AUTOSTART ?? '').trim().toLowerCase()
    );
    if (!bridgeOptOut && process.stdout.isTTY && !options.oneShot) {
      const bridge = require('../bridge/bridgeServer');
      const info = await bridge.startBridgeServer();
      const footerOff = String(process.env.KHY_BRIDGE_FOOTER ?? '').trim().toLowerCase() === '0';
      if (info && info.port > 0 && footerOff) bridge.printStatus();
    }
  } catch { /* bridge is optional; a failure here must not block the session */ }

  // ── Workspace trust: quick safety check on first launch in an untrusted folder ──
  // Aligns with Claude Code's workspace trust: BEFORE khy reads/edits/executes in a
  // brand-new directory, ask "is this a project you trust?" and only proceed once the
  // user accepts. Accepted non-home folders are persisted (with parent-dir inheritance
  // so sub-folders auto-trust); the home dir is only session-trusted (never persisted
  // whole). Runs PRE-MOUNT (covers both Ink TUI and classic REPL). TTY-only, non-one-
  // shot, gated by KHY_WORKSPACE_TRUST (default on). Decision/text live in the pure
  // leaf services/workspaceTrust.js; this shell only does the IO + exit intent. If the
  // user declines, khy exits before touching the folder. Fail-open: any internal error
  // treats the folder as trusted so the gate never wrongly blocks a legitimate session.
  if (process.stdout.isTTY && !options.oneShot) {
    try {
      const trustGate = require('./trustGate');
      const decision = await trustGate.ensureWorkspaceTrust({ inquirer: inquirer(), c: chalk() });
      if (decision && decision.action === 'exit') {
        process.exit(typeof decision.code === 'number' ? decision.code : 0);
      }
    } catch { /* trust gate is optional; an internal error must never block the session */ }
  }

  // ── Workspace as Git repo: treat every launch directory as version-controlled ──
  // Goal: each khy working directory should be a git repo so commit / rollback /
  // management "just work". If the launch cwd is not already inside a repo, run a
  // one-time `git init` here. Heavily guarded by the pure-leaf policy
  // (workspaceGitInitPolicy) that REFUSES to init the user's HOME, the filesystem
  // root, or known system directories — a naive auto-init's worst footgun.
  //
  // Runs in ALL launch modes — interactive TTY, one-shot (`khy -p`), and non-TTY
  // pipes alike — so git-dependent operations (worktree / metadata hooks / checkpoint)
  // never hit "not a git repo" just because the session was headless. The session cwd
  // is fixed at launch (a plain `cd` by the model is ephemeral), so a single init here
  // covers the whole session in this dir and its subdirectories. Placed before the
  // one-shot chat and the interactive REPL loop, so the repo exists before any tool
  // runs. Gated by KHY_AUTO_GIT_INIT (default on; off via 0/false/no/off) plus the
  // safety policy. Best-effort: never blocks or fails the session; the notice line is
  // informational and harmless in non-TTY output.
  try {
    require('../services/workspaceGitInit').ensureWorkspaceRepo({
      log: (line) => { try { console.log(line); } catch { /* ignore */ } },
    });
  } catch { /* workspace git-init is optional; never blocks the session */ }

  // ── Startup cleanup: prune stale persisted tasks so the task list stops growing ──
  // AI-created tasks live in the persistent large-task store; the startup task panel
  // pull-reads them all, so a batch built long ago but never finished reappears on
  // every restart. This sweep removes tasks not updated within the retention window
  // (default 7 days; KHY_TASK_CLEANUP_DAYS overrides). The "which ids" decision lives
  // in the pure leaf taskCleanupPolicy; this shell only does the IO. TTY-only,
  // non-one-shot, gated by KHY_TASK_CLEANUP (default on; off via 0/false/no/off).
  // Best-effort: never blocks or fails the session.
  if (process.stdout.isTTY && !options.oneShot) {
    try {
      require('../services/taskCleanupService').cleanupStaleTasks({
        log: (line) => { try { console.log(line); } catch { /* ignore */ } },
      });
    } catch { /* task cleanup is optional; never blocks the session */ }
  }

  // ── Startup cleanup: reset the per-session TodoWrite checklist on a fresh session ──
  // The "task list" panel actually conflates three lifecycles: V1 TodoWrite
  // (os.tmpdir()/khy-todos.json) and the compat todoWrite (.khyquant/todo_state.json)
  // are session CHECKLISTS by intent, but persist as global/process files with no
  // session binding; the persistent large-task store above is correctly long-lived.
  // The age-based sweep only touches the persistent store, so those two legacy
  // checklists "survive every restart" — the architectural leak behind the "still
  // there after restart" symptom. On a FRESH session (the SAME boundary as the
  // ai().clearHistory() below: not a `khy resume`), clear them so TodoWrite starts
  // blank — checklist lifecycle == history lifecycle. The "which files" decision lives
  // in the pure leaf sessionChecklistResetPolicy; this shell only does the IO. TTY-only,
  // non-one-shot, non-resumed, gated by KHY_SESSION_TODO_RESET (default on; off via
  // 0/false/no/off). Best-effort: never blocks or fails the session.
  if (process.stdout.isTTY && !options.oneShot && !options.resumed) {
    try {
      require('../services/sessionChecklistResetService').resetSessionChecklist({
        resumed: !!options.resumed,
        log: (line) => { try { console.log(line); } catch { /* ignore */ } },
      });
    } catch { /* session checklist reset is optional; never blocks the session */ }
  }

  // ── Self-heal: restore missing/corrupted runtime source files on chat/TUI startup ──
  // Goal trigger point ② "khy chat page startup". The bootstrap path already heals for
  // one-shot `khy <cmd>` invocations; this covers the interactive chat/TUI surface,
  // which mounts here (PRE-MOUNT covers both Ink TUI and classic REPL). Per-file heal
  // from the bundled encrypted pristine snapshot by SHA-256 manifest: individual lost
  // files backfilled, spot-corrupted sources (e.g. a dropped letter in a function name)
  // overwritten — NOT a whole-tree restore. Throttled by snapshot fingerprint + time
  // window so the healthy steady state is ~1ms; a fingerprint change (pip/npm update)
  // forces a re-check. Version-match + too-many-changes rails prevent mass-reverts.
  // The heal/plan/rails decisions live in services/sourceHealService (+ pure-leaf
  // sourceHealPolicy); this shell only fires it. TTY-only, non-one-shot, gated by
  // KHY_SOURCE_HEAL (default on). Best-effort: never blocks or fails the session.
  if (process.stdout.isTTY && !options.oneShot) {
    try {
      require('../services/sourceHealService').runStartupHeal({
        reason: 'tui-startup',
        log: (line) => { try { console.log(line); } catch { /* ignore */ } },
      });
    } catch { /* self-heal is optional; never blocks the session */ }
  }

  // ── First-run onboarding: guide novices through connecting a model ──
  // Runs PRE-MOUNT so it covers BOTH the default Ink TUI and the classic readline
  // REPL (KHY_FULL_TUI=0). Self-gates: TTY + non-one-shot here, then the wizard
  // itself skips disabled (KHY_ONBOARDING=off), already-completed, and already-
  // configured users — so existing installs are never nagged on upgrade. The Key
  // is persisted through the same builtin-provider path as `khy gateway config`.
  // Best-effort: any failure must not block the session.
  if (process.stdout.isTTY && !options.oneShot) {
    try {
      const onboarding = require('./onboarding');
      if (onboarding.isWizardEnabled() && onboarding.needsOnboarding()) {
        await onboarding.runOnboarding({ inquirer: inquirer(), c: chalk() });
      }
    } catch { /* onboarding is optional; never blocks the session */ }
  }

  // ── TUI mode: default-on (opt out via KHY_FULL_TUI=0) ──
  // The Ink TUI is now the default interactive surface. The inquirer-driven
  // handlers that previously forced Ink to exit (the "/model quits KHY" bug)
  // are either ported to native overlays (/model, /login, /register, /passwd)
  // or intercepted in App.runRouted with a "use classic mode" notice, so the
  // crash class no longer reaches the user. The legacy readline REPL remains
  // available via KHY_FULL_TUI=0 for the not-yet-ported interactive handlers
  // (e.g. /apikey, /init, /forgot, /pool import).
  const tuiOptOut = process.env.KHY_FULL_TUI === '0' || options.fullTui === false;
  const tuiRequested = !tuiOptOut && (options.fullTui || process.stdout.isTTY);
  if (tuiRequested && process.stdout.isTTY) {
    try {
      const inkRuntime = require('./tui/inkRuntime');
      inkRuntime.registerJsx();
      await inkRuntime.loadInk();
      // Auto-start the Windows clipboard image bridge for the TUI too. The
      // classic-mode copy lives further down startRepl (after the early return
      // below), so the TUI path never reached it — pasted screenshots stopped
      // becoming PNG file paths. The service is win32-only and idempotent
      // (no-op on other platforms / when already running). Started before mount
      // so any stderr notice lands in scrollback above the UI.
      try {
        const clipboardBridge = require('../services/windowsClipboardImg2FileService');
        const shouldAutoStart = String(process.env.KHY_CLIPBOARD_IMG2FILE_AUTO_START || 'true').toLowerCase() !== 'false';
        if (shouldAutoStart) clipboardBridge.startClipboardImg2FileBridge();
      } catch { /* non-critical on unsupported environments */ }
      const { startInkApp } = require('./tui/app.jsx');
      await startInkApp(options);
      return;
    } catch (err) {
      process.stderr.write(`Ink TUI init failed: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    }
  }

  // Non-TTY (piped) mode: minimal non-interactive handler
  process.env.KHY_REPL_ACTIVE = '1';
  const runtimeMode = String(options.mode || process.env.KHY_RUNTIME_MODE || 'khyquant').toLowerCase();
  const enablePluginAutoload = (
    options.enablePluginAutoload !== undefined
      ? !!options.enablePluginAutoload
      : String(process.env.KHY_PLUGIN_AUTOLOAD || 'true').toLowerCase() !== 'false'
  );
  const claudeUiEnabled = (
    options.claudeUi !== undefined
      ? !!options.claudeUi
      : String(process.env.KHY_CLAUDE_UI || 'true').toLowerCase() !== 'false'
  );
  const showGettingStarted = (
    options.showGettingStarted !== undefined
      ? !!options.showGettingStarted
      : String(
        process.env.KHY_SHOW_GETTING_STARTED
        || (claudeUiEnabled ? 'false' : 'true')
      ).toLowerCase() !== 'false'
  );
  const startupModelPickerEnabled = (
    options.startupModelPicker !== undefined
      ? !!options.startupModelPicker
      : String(process.env.KHY_STARTUP_MODEL_PICKER || 'false').toLowerCase() === 'true'
  );

  // Load formatters + chalk now (needed for REPL UI)
  const { printBanner, printError, printErrorPanel, printSuccess, printInfo, printWarn, ICON_PROMPT, ICON_BOT, MASCOT_MINI, getRandomFarewell, getClassicMonsterPetLines } = fmt();
  const c = chalk();
  const { parseInput, route, getCompletions } = router();
  const { compactAiErrorReply, compactGatewayStatusText } = require('./errorSummary');

  // Load renderer constants for inline use
  const { DOT_PENDING, DOT_INDICATOR, DOT_SUCCESS, DOT_ERROR } = require('./aiRenderer');
  const TREE_LAST = '└';

  // ── One-shot mode: formatted single query then return ──
  if (options.oneShot && options.prompt) {
    const renderer = require('./aiRenderer');
    const aiProvider = ai().getActiveProvider() || 'AI';
    console.log('');
    renderer.printStepLine('active', '请求 AI', aiProvider);

    let thinkingStarted = false;
    const oneShotThinkingState = { thinkingLineOpen: false, thinkingCol: 0 };
    const result = await ai().chat(options.prompt, {
      onChunk: (chunk) => {
        if (chunk.type === 'thinking' && !thinkingStarted) {
          thinkingStarted = true;
          if (process.stdout.isTTY) process.stdout.write('\x1b[1A\r\x1b[K');
          renderer.printStepLine('success', '请求 AI', aiProvider);
          console.log('');
          console.log(c.yellow(`  ${ICON_BOT} 思考过程:`));
        }
        if (chunk.type === 'thinking') {
          streamThinkingChunk(chunk.text, oneShotThinkingState, c);
        } else if (chunk.type === 'assistant_message') {
          // 用户可见的中间消息(如视觉路由说明)——one-shot 下即时打印为一条助手消息行。
          const msgText = String(chunk.content || chunk.text || '').trim();
          if (msgText) {
            if (thinkingStarted && oneShotThinkingState.thinkingLineOpen) {
              closeThinkingStream(oneShotThinkingState);
            }
            console.log('');
            console.log(`  ${ICON_BOT} ${c.cyan(msgText)}`);
          }
        }
      },
    });

    if (thinkingStarted) {
      closeThinkingStream(oneShotThinkingState);
      console.log('');
    } else {
      if (process.stdout.isTTY) process.stdout.write('\x1b[1A\r\x1b[K');
    }

    if (result.reply) {
      const meta = [
        result.elapsed ? require('./ccFormat').ccFormatDurationOr(result.elapsed, `${(result.elapsed / 1000).toFixed(1)}s`, process.env) : '',
        result.tokenUsage ? `${result.tokenUsage.totalTokens} 令牌` : '',
      ].filter(Boolean).join(' · ');
      renderer.printStepLine('success', 'AI 回复', result.provider || 'local', meta);
      console.log('');
      renderer.renderAiResponse(result.reply).split('\n').forEach(l => console.log(`  ${l}`));
    } else {
      printError('AI 未返回有效回复');
    }
    console.log('');
    return;
  }

  // Set terminal window title
  setTerminalTitle('khy OS');

  function tryPrintMascotImagePreview() {
    if (!process.stdout.isTTY) return false;
    const term = String(process.env.TERM_PROGRAM || '');
    const supportsInlineImage = term === 'iTerm.app' || term === 'WezTerm' || !!process.env.KITTY_WINDOW_ID;

    const configured = String(process.env.KHY_MASCOT_IMAGE || '').trim();
    const candidates = [];
    if (configured) candidates.push(path.resolve(configured));
    candidates.push(path.resolve(__dirname, '../../assets/mascot/xuanniao-original.jpg'));

    for (const imgPath of candidates) {
      if (!fs.existsSync(imgPath)) continue;
      if (supportsInlineImage) {
        try {
          const imageService = require('../services/imageService');
          const image = imageService.readImageFromFile(imgPath);
          imageService.printImagePreview(image);
          return true;
        } catch {
          // Try terminal text fallback (chafa) below.
        }
      }
      try {
        const { spawnSync } = require('child_process');
        const cols = process.stdout.columns || 80;
        const width = Math.max(36, Math.min(72, cols - 8));
        const height = Math.max(12, Math.min(24, Math.floor(width * 0.45)));
        const result = spawnSync('chafa', [`--size=${width}x${height}`, imgPath], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result && result.status === 0 && String(result.stdout || '').trim()) {
          console.log('');
          console.log(String(result.stdout).trimEnd());
          return true;
        }
      } catch {
        // Try the next candidate path.
      }
    }
    return false;
  }

  function printResumeRecoveryHints(savedMeta) {
    // Prefer the FULL transcript (Store B / JSONL, auto-saved every turn) over
    // the legacy summary snapshot: after Ctrl-C the user should be able to
    // restore the complete conversation, not a compacted digest. Bare `/resume`
    // now reloads the most-recent persisted session for this cwd, and
    // `khy resume <id>` resolves the full store first.
    try {
      const liveId = ai().getLiveSessionId && ai().getLiveSessionId();
      if (liveId) {
        // 文案/着色由 resumeHint 叶子供给,与 Ink TUI(printInkResumeHint)共用同一份 SSOT。
        // 收敛后命令 token(/resume、khy resume <id>)统一 cyan(此前本行整行 dim,与 TUI 分叉)。
        const { buildResumeHintLines, renderResumeHintLines } = require('./resumeHint');
        for (const line of renderResumeHintLines(buildResumeHintLines({ liveId }), { dim: c.dim, cyan: c.cyan })) {
          console.log(line);
        }
        return;
      }
    } catch { /* fall back to summary-store hints below */ }

    const sessionId = String(savedMeta?.sessionId || '').trim();
    if (!sessionId) {
      let fallbackId = '';
      try {
        const latest = ai().listConversations()[0];
        fallbackId = String(latest?.sessionId || '').trim();
      } catch { /* ignore */ }
      if (fallbackId) {
        if (savedMeta && savedMeta.success === false) {
          console.log(c.dim('  未写入新的会话快照，已回退到最近可恢复会话'));
        }
        console.log(c.dim(`  恢复命令: khy resume ${fallbackId}`));
      } else {
        console.log(c.dim('  对话摘要已保存，下次输入 /resume 恢复上下文'));
      }
      return;
    }
    console.log(c.dim(`  会话已保存，恢复命令: khy resume ${sessionId}`));
  }

  // On Ctrl+C while an agent task is running, flip its boulder checkpoint to
  // 'interrupted' (so it survives the auto-resume gate and stays addressable)
  // and surface the resumable task id. Best-effort — never throws into SIGINT.
  function printInterruptedTaskHint() {
    try {
      const { markBoulderInterrupted } = require('../services/boulderState');
      const taskId = markBoulderInterrupted(process.cwd(), { interruptReason: 'Ctrl+C' });
      if (taskId) {
        console.log(c.dim(`  任务进度已保存，恢复命令: khy resume ${taskId}`));
      }
    } catch { /* best-effort */ }
  }

  let _startupHeaderRendered = false;
  function renderStartupHeader(force = false) {
    if (_startupHeaderRendered && !force) return;
    _startupHeaderRendered = true;
    const aiProvider = ai().getActiveProvider();
    if (!claudeUiEnabled) {
      printBanner(VERSION, aiProvider);
      if (showGettingStarted) {
        try {
          const gettingStarted = require('../services/gettingStartedService');
          gettingStarted.displayGettingStarted();
        } catch { /* non-critical */ }
      }
      return;
    }

    let modelName = '';
    let effortLabel = '高强度';
    let billingType = '按量计费';
    let adapterName = '';
    try {
      const gateway = require('../services/gateway/aiGateway');
      const active = gateway.getActiveAdapter();
      modelName = active?.activeModel || '';
      adapterName = active?.name || active?.type || '';
    } catch { /* best effort */ }

    if (!modelName) modelName = process.env.GATEWAY_PREFERRED_MODEL || 'auto';
    if (!adapterName) adapterName = process.env.GATEWAY_PREFERRED_ADAPTER || aiProvider || 'auto';

    // Determine billing type
    if (/ollama|local|llama/i.test(adapterName)) billingType = '本地模型';
    else if (/relay|web|clipboard/i.test(adapterName)) billingType = '中继通道';

    // Effort level
    try {
      const effort = ai().getEffort ? ai().getEffort() : 'high';
      const labels = { max: '最大强度', high: '高强度', medium: '中强度', low: '低强度' };
      effortLabel = labels[effort] || '高强度';
    } catch { /* best effort */ }

    const cols = process.stdout.columns || 80;

    // Try original mascot image first (inline image or chafa fallback),
    // then keep the text UI below as stable fallback.
    const imagePreviewShown = tryPrintMascotImagePreview();

    // ── Claude Code style bordered box ──
    // Layout:
    // ╭─── khy OS vX.Y.Z ───────────────────────────╮
    // │                                               │
    // │   Welcome back!        Tips for getting started│
    // │                        Run /init to create...  │
    // │   [mascot sprite]                              │
    // │                        Recent activity         │
    // │                        No recent activity      │
    // │                                               │
    // │   Model with effort · Billing                 │
    // │       /working/directory                      │
    // ╰───────────────────────────────────────────────╯

    const boxWidth = Math.min(cols - 4, 76);
    // Inner content width: box is "  ╭...╮" where visible = 2 indent + boxWidth chars.
    // Content lines: "  │ " (4 visible) + content + " │" (2 visible) = boxWidth,
    // so content area = boxWidth - 6. But use boxWidth - 2 for border chars total.
    const contentWidth = boxWidth - 2; // between │ and │ (including padding spaces)
    const innerWidth = contentWidth - 2; // minus " " padding on each side: "│ {inner} │"
    const dim = c.dim;
    const orange = c.hex('#D77757');

    // Measure visible display width, stripping ANSI codes and accounting for CJK/emoji
    const visLen = (s) => {
      const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
      let w = 0;
      for (const ch of stripped) w += getDisplayWidthChar(ch);
      return w;
    };

    // Pad/truncate content to exact visible width
    const padLine = (content, width) => {
      const gap = Math.max(0, width - visLen(content));
      return content + ' '.repeat(gap);
    };

    // Helper: build a full box row "  │ {content padded to innerWidth} │"
    const boxRow = (content) => {
      return dim('  │ ') + padLine(content, innerWidth) + dim(' │');
    };

    // Title line
    const titleText = ` khy OS v${VERSION} `;
    const topDashes = contentWidth - titleText.length; // dashes between ╭ and ╮
    const topLeft = Math.floor(topDashes / 2);
    const topRight = topDashes - topLeft;
    console.log('');
    console.log(dim(`  ╭${'─'.repeat(Math.max(1, topLeft))}`) + dim(titleText) + dim(`${'─'.repeat(Math.max(1, topRight))}╮`));

    // Pet sprite + right-side info
    const petBronze = c.hex('#D77757');
    const petLinesFallback = typeof getClassicMonsterPetLines === 'function'
      ? getClassicMonsterPetLines(petBronze)
      : (() => {
        // Inline fallback: Chinese phoenix (Xuan Niao) single-color
        const z = petBronze;
        const d = c.dim;
        return [
          `       ${z('▄█▄')}`,
          `     ${z('▄█▀█▀█▄')}`,
          `     ${z('█▌░▀░▐█')}`,
          `      ${z('▜███▛')}`,
          `  ${z('▗▟████████▙▖')}`,
          `   ${z('▝▀▀▄██▄▀▀▘')}`,
          `       ${d('▐▌')}`,
        ];
      })();
    const petLines = imagePreviewShown
      ? Array(7).fill('')
      : petLinesFallback;

    // Left column width (pet + "Welcome back!")
    const leftColW = Math.floor(innerWidth * 0.45);
    const rightColW = innerWidth - leftColW;

    // Tips / activity section — 动态信息
    const green = c.hex('#4EBA65');

    // Auth method detection
    let authMethod = 'API 密钥';
    try {
      if (/relay|clipboard/i.test(adapterName)) authMethod = '中继';
      else if (/oauth/i.test(adapterName)) authMethod = 'OAuth';
      else if (/ollama|local/i.test(adapterName)) authMethod = '本地';
      else if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) authMethod = 'API 密钥';
    } catch {}

    // Context window
    let ctxWindow = '';
    try {
      const contextLimit = ai().getContextLimit ? ai().getContextLimit() : 0;
      if (contextLimit > 0) ctxWindow = `${Math.round(contextLimit / 1000)}k 令牌`;
    } catch {}

    // Gateway status
    let gatewayStatus = '';
    try {
      const gw = require('../services/gateway/aiGateway');
      const statuses = typeof gw.getStatus === 'function' ? gw.getStatus() : [];
      const available = statuses.filter(s => s.available);
      if (available.length > 0) {
        gatewayStatus = `${available.length} 个适配器就绪`;
      } else if (statuses.length > 0) {
        gatewayStatus = '已配置，检测中';
      } else {
        gatewayStatus = '就绪';
      }
    } catch { gatewayStatus = '就绪'; }

    // Git branch —— 启动横幅的分支读取。这是**启动阻塞路径**上的一次同步 git
    // 派生;与 gitContextService._git / workspaceGitInit 对齐,默认走「无 shell 派生」
    // (spawnSync 直接派生 git,去掉 Windows execSync 的 cmd.exe 中介,cmd.exe → git
    // 两个进程降为单个 git.exe)。Git Bash 优先解析是 win32 专属关切,故仅在 win32 上
    // 调检测器(Unix 保持 'git' 字面量,零 `git --version` 探针,与历史逐字节一致)。
    // 门控 KHY_GIT_SHELL_FREE(default-on CANON);门关 / 无法安全分词 / 任何异常
    // → 逐字节回退历史 execSync 字符串路径。全程 fail-soft:任何失败 → 分支留空。
    let gitBranch = '';
    try {
      const { execSync, spawnSync } = require('child_process');

      let gitPath = 'git';
      if (process.platform === 'win32') {
        try {
          const detected = require('../services/gitExecutableDetector').detectGitExecutable();
          if (detected) gitPath = detected;
        } catch { /* 检测失败 → 保持 'git'（历史行为） */ }
      }

      let readViaSpawn = false;
      try {
        const plan = require('../services/gitSpawnPlan');
        if (plan.isShellFreeGitEnabled(process.env)) {
          const argv = plan.toGitArgv('rev-parse --abbrev-ref HEAD');
          if (argv) {
            readViaSpawn = true;
            const res = spawnSync(gitPath, argv, {
              encoding: 'utf8',
              timeout: 3000,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });
            if (res && !res.error && res.status === 0) {
              gitBranch = String(res.stdout == null ? '' : res.stdout).trim();
            }
          }
        }
      } catch { readViaSpawn = false; }

      if (!readViaSpawn) {
        // 逐字节回退:门关 / 无法分词 / 判定异常 → 历史 execSync 字符串路径。
        const quotedGit = gitPath === 'git' ? 'git' : `"${gitPath}"`;
        gitBranch = execSync(`${quotedGit} rev-parse --abbrev-ref HEAD`, {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      }
    } catch {}

    const tipsHeader = green('系统');
    const tipsBody = dim(`认证: ${authMethod}${ctxWindow ? ` · 上下文: ${ctxWindow}` : ''}`);
    const actHeader = green('状态');
    const actBody = dim(`网关: ${gatewayStatus}${gitBranch ? ` · 分支: ${gitBranch}` : ''}`);

    // Row 1: empty
    console.log(boxRow(''));

    // Row 2: "Welcome back!" + tips header
    const welcomeText = c.bold('欢迎回来');
    console.log(boxRow(padLine(`  ${welcomeText}`, leftColW) + padLine(tipsHeader, rightColW)));

    // Rows 3..N: phoenix lines + right-side intro/status
    // Spread right-side content across the 7-line sprite height
    const rightLines = ['', tipsBody, '', actHeader, actBody, '', ''];
    for (let i = 0; i < petLines.length; i++) {
      const right = rightLines[i] || '';
      console.log(boxRow(padLine(`  ${petLines[i]}`, leftColW) + padLine(right, rightColW)));
    }

    // Row 6: empty
    console.log(boxRow(''));

    // Row 7: model info
    const modelInfo = `${modelName} · ${effortLabel} · ${billingType}`;
    console.log(boxRow(`  ${dim(modelInfo)}`));

    // Row 8: working directory
    console.log(boxRow(`  ${dim(formatShortCwd())}`));

    // Bottom border
    console.log(dim(`  ╰${'─'.repeat(contentWidth)}╯`));
    console.log('');

    // ── 模型退役启动提示（对齐 CC 启动期 model-deprecation-warning）──
    // 门控 KHY_MODEL_DEPRECATION_NOTICE（默认开）。若当前钉选模型已排定退役日期，
    // 启动时给一行 CC 风格提示（时态感知：已于/将于）。当前 khy 型号(opus-4-x 等)不在
    // 退役表 → 无提示；仅当有人钉到旧代模型才触发。全 best-effort，绝不阻断启动。
    try {
      const fp = require('../services/futureProofing');
      const notice = fp.getModelRetirementNotice(modelName, {
        adapterName,
        nowMs: Date.now(),
      });
      if (notice) {
        console.log('  ' + c.yellow(notice));
        console.log('');
      }
    } catch { /* 退役提示是增益，绝不阻断启动 */ }

    // ── 未完成构建发现横幅 ──
    // 若当前工作目录存在被打断（断电/断网/token耗尽/Ctrl+C/khy故障）残留的可续检查点，
    // 在启动时主动提示，并给出确切续作命令。全 best-effort，绝不阻断启动。
    try {
      const resumeAdvisor = require('../services/resumeAdvisor');
      try { resumeAdvisor.pendingForCwd && require('../services/boulderState').purgeExpired?.(); } catch {}
      const pending = resumeAdvisor.pendingForCwd(process.cwd());
      if (pending) {
        const hint = resumeAdvisor.formatStartupHint(pending, { color: c });
        if (hint) { console.log(hint); console.log(''); }
      }
    } catch { /* 发现性是增益，绝不阻断启动 */ }

    // ── 启动轮换提示（对齐 CC tips「背后的逻辑」）──
    // 门控 KHY_STARTUP_TIPS（默认开）。从内置 tips 注册表按 per-tip cooldownSessions 冷却 +
    // isRelevant 相关性过滤，选「最久未显示」的一条，跨会话持久化 numStartups/tipsHistory，
    // 在横幅后浮现一行。门控关/无候选 → 不显示（逐字节回退今日行为：今日 tips 为死代码，
    // 本就不显示任何提示）。全 best-effort，绝不阻断启动。
    try {
      const tipStore = require('../services/tipHistoryStore');
      const tip = tipStore.bumpStartupAndSelectTip(process.env);
      if (tip && tip.text) {
        console.log('  ' + dim('※ 提示  ' + tip.text));
        console.log('');
      }
    } catch { /* 轮换提示是增益，绝不阻断启动 */ }
  }

  renderStartupHeader(true);

  // Initialize proxy configuration from saved settings
  try {
    const proxyConfig = require('../services/proxyConfigService');
    proxyConfig.initFromConfig();
  } catch { /* proxy init is non-critical */ }

  // Auto-start Windows clipboard image bridge:
  // bitmap clipboard -> PNG file -> quoted file path text for Ctrl+V in CLI.
  try {
    const clipboardBridge = require('../services/windowsClipboardImg2FileService');
    const shouldAutoStart = String(process.env.KHY_CLIPBOARD_IMG2FILE_AUTO_START || 'true').toLowerCase() !== 'false';
    if (shouldAutoStart) {
      const bridgeResult = clipboardBridge.startClipboardImg2FileBridge();
      if (bridgeResult && bridgeResult.started) {
        const pollMs = bridgeResult.meta?.pollMs || 500;
        process.stderr.write(`[repl] clipboard bridge started: poll=${pollMs}ms\n`);
      }
    }
  } catch {
    // Non-critical on unsupported environments.
  }

  // Initialize SDK plugin system (discovers and activates khy-* plugins)
  if (enablePluginAutoload) {
    try {
      const pluginLoader = require('../plugin-loader');
      const { createContextFactory } = require('../plugin-loader/contextFactory');
      const cmdRegistry = require('./commandRegistry');
      let aiGw = null;
      try { aiGw = require('../services/gateway/aiGateway'); } catch {}

      const contextFactory = createContextFactory({
        commandRegistry: cmdRegistry,
        toolRegistry: null,
        aiGateway: aiGw,
        logger: console,
        hostVersion: VERSION,
      });

      pluginLoader.init({
        hostVersion: VERSION,
        contextFactory,
        logger: { info: () => {}, warn: console.warn, error: console.error, debug: () => {} },
      }).catch(() => {}); // Non-blocking — don't hold up REPL
    } catch { /* plugin system is non-critical */ }
  }

  // Start periodic base self-check loop (can be disabled by KHY_SELF_CHECK_ENABLED=false)
  try {
    const selfCheck = require('../services/baseSelfCheckService');
    selfCheck.autoStartFromEnv();
  } catch { /* self-check is non-critical */ }

  // Start each session with a clean slate.
  // Previous conversations are saved on exit and can be restored explicitly
  // via /resume, which compacts and extracts key context before restoring.
  // Exception: when launched as `khy resume <id>` the caller has ALREADY
  // restored the transcript into ai._messages — clearing here would wipe the
  // very context the user asked to resume, so honor options.resumed and skip.
  let _autoResumed = !!options.resumed;
  if (!options.resumed) {
    try {
      ai().clearHistory();
    } catch { /* non-critical */ }
  }

  // ── State variables (must be before setTimeout calls and renderStatusBar) ──
  let _busy = false;
  let _busyStreaming = false; // true 当 AI 正在流式输出文本/thinking，不应重绘 prompt
  let _transientStatusActive = false; // true when an in-place status line occupies the current row — keepalive/prompt must not overwrite it
  let _deferredStatuses = []; // statuses buffered while _busyStreaming, flushed when streaming ends
  function _flushDeferredStatuses() {
    if (_deferredStatuses.length === 0) return;
    const batch = _deferredStatuses.splice(0);
    // Plan is NOT shown here — it should have appeared before text, not after.
    // Only replay non-noise statuses that are still meaningful post-stream.
    const renderer = require('./aiRenderer');
    for (const s of batch) {
      // Skip plan (stale — text already shown), skip low-value infrastructure noise
      if (s.phase === 'plan') continue;
      if (/已自动优化|Metrics|metrics|档位/i.test(s.text)) continue;
      // Skip completion/connection confirmations — already obvious from the response
      if (/完成处理|已连接并响应|已连接|通道状态刷新/i.test(s.text)) continue;
      // Show remaining deferred statuses in dim white (infrastructure, not delivery)
      renderer.printStepLine('done', s.phase || '状态', '', s.text);
    }
  }
  let _planMode = false;
  let _fastMode = false;
  let _localMode = false;  // force local-only processing (Tier 1 + Tier 2, no AI model)
  // Single source for the /local toggle so the command path and the slash-menu
  // path stay in lockstep (avoids two drifting copies of the message).
  const _toggleLocalMode = () => {
    _localMode = !_localMode;
    printSuccess(`本地模式 ${_localMode ? '已开启 — 所有请求将使用本地能力处理' : '已关闭 — 恢复 AI 模型调用'}`);
  };
  let _effortLevel = 'medium'; // low/medium/high/max
  let _lastCheckpointAt = 0; // Auto-checkpoint cooldown tracker
  const _sessionStart = Date.now();
  let _ctrlCCount = 0;
  let _ctrlCTimer = null;
  // 忙碌态中断逃生阀状态(KHY_BUSY_FORCE_EXIT,默认开):记录忙碌中优雅取消的连按序列。
  // 前两次仍走优雅取消(尽量打断卡住的任务);同窗口内累计第 3 次(仍忙)= 优雅取消没落地
  // → 强制结束会话,兑现用户「3 次,Ctrl+C 结束会话」。每轮 turn 边界(finally)重置,不跨轮泄漏。
  let _busyInterruptState = null;
  let _lastTipShown = 0;
  let _recentCommands = [];
  const PATTERN_WINDOW = 5;
  let _startupTimers = [];

  // ── Deferred prefetch: all non-blocking startup tasks in one place ─────
  // Replaces 8+ individual setTimeout calls with a single managed module.
  // Falls back to empty array if the bootstrap module is not available.
  try {
    const { deferredPrefetch } = require('../bootstrap/prefetch');
    _startupTimers = deferredPrefetch({
      mode: runtimeMode === 'khy' ? 'khy' : 'khyquant',
      isBusy: () => _busy,
      onOutput: (msg) => {
        if (!_busy) {
          console.log(msg);
          try { rl.prompt(); } catch { /* ignore */ }
        }
      },
    });
  } catch {
    // Fallback: if bootstrap module unavailable, no deferred tasks.
    // This should never happen in normal operation but ensures safety.
  }

  // Startup model picker is opt-in (avoid unexpected operation prompts).
  if (startupModelPickerEnabled && process.stdin.isTTY && process.stdout.isTTY) {
    await offerModelSelection();
  }

  // Setup readline
  // 上箭头历史回放只限当前 session，不跨会话
  const _persistedHistory = loadHistory(); // 文件历史仅用于保存（追加本次输入）
  const history = [];

  // Build prompt with abbreviated working directory (like Claude Code)
  function buildCwdPrompt() {
    // ~-collapse + intermediate-dir shortening are pure (displayFormatters);
    // this wrapper only applies the closure-bound chalk styling.
    const display = shortenPromptPath(formatShortCwd());
    return `${c.dim(display)} ${c.bold.cyan('>')} `;
  }

  const _plainTerminalUi = ['1', 'true', 'yes', 'on'].includes(String(process.env.KHY_PLAIN_TTY_UI || '').trim().toLowerCase())
    || !!process.env.NO_COLOR;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildCwdPrompt(),
    historySize: MAX_HISTORY,
    // Lower ESC ambiguity wait to improve perceived input responsiveness.
    escapeCodeTimeout: Math.max(10, parseInt(process.env.KHY_INPUT_ESCAPE_TIMEOUT_MS || '120', 10) || 120),
    completer: (line) => {
      const completions = getCompletions(line);
      return [completions.length > 0 ? completions : [], line];
    },
  });

  // ── TUI Phase 1: side-channel state bridge (best-effort, never affects legacy REPL) ──
  let _tuiCtrl = null;
  try {
    const { createReplController } = require('./tui/adapters/replController');
    _tuiCtrl = createReplController({ stdout: process.stdout });
  } catch { /* TUI controller is optional — legacy REPL continues unaffected */ }

  // ── 自维护顾问 · 外部编辑器监视器(§3,经典 REPL 路径)──────────────────
  // 会话 cwd 位于某 khy monorepo 内时,监视 khy 源码被外部编辑器直改,闲时主动向人
  // (清行 console.log)与 AI(下一轮 btw 注记)反馈。非 khy / 门控关 → no-op。模块级
  // 单例(_started 幂等),与 ink TUI 路径互斥,双启也只有一个真正运行。fail-open。
  let _selfEditWatcher = null;
  try {
    const _seaSvc = require('../services/selfEditAdvisoryService');
    _selfEditWatcher = require('../services/selfEditWatcher');
    const _seRoot = _seaSvc.detectKhyRepoRoot(process.env.KHYQUANT_CWD || process.cwd());
    if (_seRoot) {
      _selfEditWatcher.start({
        root: _seRoot,
        onAdvisory: (adv) => {
          if (!adv) return;
          // 人面:清输入框 → 打印 → 重画提示。
          try {
            if (adv.humanLine) {
              if (!_busy) leaveInputPromptFrame();
              console.log('\n' + adv.humanLine);
              if (!_busy) rl.prompt();
            }
          } catch { /* best-effort */ }
          // AI 下一轮:btw 注记。
          try {
            if (adv.aiNote) require('../services/conversation/btwNoteQueue').enqueue(adv.aiNote);
          } catch { /* best-effort */ }
        },
      });
    }
  } catch { /* watcher is best-effort; never disturbs the REPL */ }

  // readline history 只含当前 session 输入（不预填充文件历史）

  // Bottom HUD live bar mode:
  // - while user is typing: disabled (prevents input overlap)
  // - while command/AI is running: enabled
  let _liveHudEnabled = true;
  let _liveHudActive = false;
  try {
    const raw = String(process.env.KHY_LIVE_STATUS_BAR || 'true').trim().toLowerCase();
    _liveHudEnabled = !['0', 'false', 'off', 'no'].includes(raw);
  } catch { /* best effort */ }

  function _setLiveHudTypingMode() {
    if (!_liveHudEnabled || !_liveHudActive) return;
    try {
      const hud = require('./hudRenderer');
      hud.stopLiveStatusBar();
      _liveHudActive = false;
    } catch { /* non-critical */ }
  }

  function _setLiveHudWorkingMode() {
    if (!_liveHudEnabled || _liveHudActive) return;
    try {
      const hud = require('./hudRenderer');
      hud.startLiveStatusBar();
      _liveHudActive = true;
    } catch { /* non-critical */ }
  }

  // Start in typing mode to avoid covering prompt text.
  _setLiveHudTypingMode();

  // Bridge account-email events from kiroAdapter to HUD status bar.
  const _handleAccountEmail = (email) => {
    try { require('./hudRenderer').updateAccountEmail(email); } catch { /* non-critical */ }
  };
  process.on('khy:adapter:account-email', _handleAccountEmail);

  // ── Intercept _ttyWrite to suppress echo during bracketed paste ──
  // Node.js readline echoes every character via _ttyWrite.  We must intercept
  // this to prevent pasted text from flooding the terminal.  The bracketed
  // paste markers (\e[200~ … \e[201~) arrive inside the raw data but readline
  // would blindly echo every byte before our `line` handler can act.

  // ── Inline slash picker state ──
  const _lowLatencyInputOpt = String(process.env.KHY_LOW_LATENCY_INPUT || '').toLowerCase();
  const _lowLatencyInputEnabled = ['1', 'true', 'yes', 'on'].includes(_lowLatencyInputOpt);
  // Plain / recorded terminals are much more sensitive to machine-speed input.
  // Keep line batching enabled there, but disable aggressive byte-level paste
  // heuristics so Enter still commits normal scripted input.
  const _aggressivePasteDetectionEnabled = !_lowLatencyInputEnabled && !_plainTerminalUi;
  let _slashPickerActive = false;
  let _slashFilter = '';
  let _slashMatches = [];
  let _slashSelectedIdx = 0;
  let _slashRenderedLines = 0;
  const SLASH_PICKER_MAX = 12;
  let _slashCommandsCache = null;
  let _slashRenderPending = false;  // Render throttle flag

  // ── Inline @ file picker state ──
  let _atPickerActive = false;
  let _atFilter = '';           // characters typed after '@'
  let _atMatches = [];          // filtered file/dir entries
  let _atSelectedIdx = 0;
  let _atRenderedLines = 0;
  let _atCurrentDir = '';       // absolute path of directory being browsed
  let _atAnchorCol = 0;         // cursor position in rl.line where '@' was typed
  const AT_PICKER_MAX = 14;
  let _atRenderPending = false;

  function _mergeUserSkillCommands(baseCmds) {
    // 用户自建技能每次现扫并入(不缓存到进程生命周期),使刚创建的技能无需重启即出现在 `/` 菜单。
    // Claude Code 自定义斜杠命令(~/.claude/commands)同样现扫并入,复用第三方命令包。
    // 既有命令优先:同名 cmd 一律以 baseCmds 为准,技能/CC 命令仅补位。
    //
    // 性能:发现(listUserSkillCommands/listCcCommands)是同步磁盘 IO + JSON.parse,过去每次按键
    // (每次斜杠菜单刷新)都跑一遍;且合并每次产生新数组身份,击穿下游 slashRankIndexMemo 的 WeakMap。
    // → 经 mergedSlashCommandsCache 加短墙钟 TTL 缓存:亚秒突发按键复用同一合并引用(免 IO,恢复投影
    // 记忆命中),TTL 过后重扫(新建技能仍 ~1s 内出现)。门控关 → 每次现扫合并(逐字节回退今日行为)。
    const _discover = () => {
      let userSkills = [];
      try {
        userSkills = require('./repl/userSkillCommands').listUserSkillCommands();
      } catch { /* 发现失败不影响既有命令 */ }
      let ccCommands = [];
      try {
        ccCommands = require('./repl/ccUserCommands').listCcCommands();
      } catch { /* 发现失败不影响既有命令 */ }
      return { userSkills, ccCommands };
    };
    try {
      return require('./repl/mergedSlashCommandsCache').getMergedCommands(baseCmds, _discover);
    } catch {
      // 叶子加载失败 → 内联现算(与历史逐字节一致)。
      const { userSkills, ccCommands } = _discover();
      if (!userSkills.length && !ccCommands.length) return baseCmds;
      const existing = new Set(baseCmds.map((sc) => sc && sc.cmd));
      const merged = baseCmds.slice();
      for (const us of userSkills) {
        if (us && us.cmd && !existing.has(us.cmd)) { merged.push(us); existing.add(us.cmd); }
      }
      for (const cc of ccCommands) {
        if (cc && cc.cmd && !existing.has(cc.cmd)) { merged.push(cc); existing.add(cc.cmd); }
      }
      return merged;
    }
  }

  function _getSlashCommands() {
    // 内置/路由命令稳定 → 缓存到 _slashCommandsCache;用户技能每次现扫合并(见 _merge…)。
    if (_slashCommandsCache) return _mergeUserSkillCommands(_slashCommandsCache);
    let cmds = [];
    try {
      const cmdReg = require('./commandRegistry');
      cmds = cmdReg.toSlashCommands();
    } catch {
      try {
        const { SLASH_COMMANDS } = router();
        cmds = SLASH_COMMANDS || [];
      } catch { /* ignore */ }
    }
    // commandRegistry 之外的额外菜单命令(/study /hud …)现由 slashExtraCommands 单一真源供给,
    // 与 Ink TUI 菜单(tui/hooks/useCompletions)共用同一份列表——改一处两入口同步,不再两处维护。
    // 合并语义(既有 cmd 优先、按序补位)与历史内联 extras 逐字节一致;叶子加载失败则不追加(fail-soft)。
    try {
      cmds = require('./slashExtraCommands').mergeExtraCommands(cmds);
    } catch { /* 叶子不可用 → 保留 registry/router 命令,不因额外命令列表拖垮菜单 */ }
    // 内置/路由/extras 稳定 → 缓存;用户技能经 _mergeUserSkillCommands 每次现扫并入。
    _slashCommandsCache = cmds;
    return _mergeUserSkillCommands(cmds);
  }

  function _filterSlashCommands(filter) {
    // 纯排序内核已抽到 repl/slashCommandFilter，便于独立单测（REQ-2026-002 拆 repl.js）。
    return rankSlashCommands(_getSlashCommands(), filter);
  }

  function _clearSlashPicker() {
    if (_slashRenderedLines <= 0 || !process.stdout.isTTY) return;
    const promptLen = (rl._prompt || '> ').replace(/\x1b\[[^m]*m/g, '').length;
    const col = promptLen + fmt().displayWidth(rl.line || '');
    // Single ANSI write: down 1, col 1, clear below, up 1, restore col
    process.stdout.write(`\x1b[B\x1b[1G\x1b[J\x1b[A\x1b[${col + 1}G`);
    _slashRenderedLines = 0;
  }

  function _renderSlashPicker() {
    if (!process.stdout.isTTY) return;
    // Debounce: collapse rapid successive calls into one paint on next tick
    if (_slashRenderPending) return;
    _slashRenderPending = true;
    setImmediate(() => {
      _slashRenderPending = false;
      _renderSlashPickerNow();
    });
  }

  function _renderSlashPickerNow() {
    if (!process.stdout.isTTY) return;
    _slashMatches = _filterSlashCommands(_slashFilter);
    if (_slashMatches.length === 0) {
      _clearSlashPicker();
      return;
    }
    const totalMatches = _slashMatches.length;
    if (_slashSelectedIdx >= totalMatches) _slashSelectedIdx = totalMatches - 1;
    if (_slashSelectedIdx < 0) _slashSelectedIdx = 0;

    // Keep selected option visible: render a moving window instead of always the first N items.
    const maxVisible = Math.max(4, SLASH_PICKER_MAX);
    const halfWindow = Math.floor(maxVisible / 2);
    let windowStart = 0;
    if (totalMatches > maxVisible) {
      windowStart = _slashSelectedIdx - halfWindow;
      const maxStart = totalMatches - maxVisible;
      if (windowStart < 0) windowStart = 0;
      if (windowStart > maxStart) windowStart = maxStart;
    }
    const windowEnd = Math.min(totalMatches, windowStart + maxVisible);
    const visible = _slashMatches.slice(windowStart, windowEnd);
    const cols = process.stdout.columns || 80;

    // Build picker lines with enhanced display
    const lines = [];
    const filterLower = (_slashFilter || '').toLowerCase().slice(1); // strip leading '/'
    for (let i = 0; i < visible.length; i++) {
      const sc = visible[i];
      // Highlight matching characters in command name
      let cmdDisplay = sc.cmd;
      if (filterLower) {
        const cmdLower = sc.cmd.toLowerCase();
        const matchIdx = cmdLower.indexOf(filterLower, 1); // skip '/'
        if (matchIdx > 0) {
          cmdDisplay = sc.cmd.slice(0, matchIdx)
            + `\x1b[1m${sc.cmd.slice(matchIdx, matchIdx + filterLower.length)}\x1b[22m`
            + sc.cmd.slice(matchIdx + filterLower.length);
        }
      }
      const label = sc.label ? `\x1b[36m${sc.label}\x1b[39m` : '';
      const desc = sc.desc || '';
      const cmdPad = sc.cmd.length < 16 ? ' '.repeat(16 - sc.cmd.length) : ' ';
      const labelPart = label ? ` ${label}` : '';
      const row = `  ${cmdDisplay}${cmdPad}${desc}${labelPart}`;
      const trimmedRow = row.length > cols + 20 ? row.slice(0, cols + 20) : row; // allow ANSI overhead
      const absoluteIdx = windowStart + i;
      if (absoluteIdx === _slashSelectedIdx) {
        lines.push(`\x1b[7m${trimmedRow}\x1b[27m`);
      } else {
        lines.push(`\x1b[2m${trimmedRow}\x1b[22m`);
      }
    }

    const positionText = totalMatches > maxVisible
      ? `  ${_slashSelectedIdx + 1}/${totalMatches} · showing ${windowStart + 1}-${windowEnd}`
      : `  ${_slashSelectedIdx + 1}/${totalMatches}`;
    lines.push(`\x1b[2m${positionText} · ↑/↓ move · Enter select\x1b[22m`);

    // Single write: move down, clear, content, move back up, restore col
    const promptLen = (rl._prompt || '> ').replace(/\x1b\[[^m]*m/g, '').length;
    const col = promptLen + fmt().displayWidth(rl.line || '');
    const content = lines.join('\n');
    const up = lines.length;
    // \x1b[B = cursor down 1, \x1b[G = cursor to col 1, \x1b[J = clear below
    // After content: \x1b[{up}A = cursor up N, \x1b[{col+1}G = cursor to col
    process.stdout.write(
      `\x1b[B\x1b[1G\x1b[J${content}\x1b[${up}A\x1b[${col + 1}G`
    );
    _slashRenderedLines = lines.length;
  }

  function _acceptSlashPick() {
    const match = _slashMatches[_slashSelectedIdx];
    _clearSlashPicker();
    _slashPickerActive = false;
    if (!match) return;
    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    rl.line = '';
    rl.cursor = 0;
    // Suppress readline echo of the internal line prefix
    const savedOutput = rl.output;
    try {
      rl.output = null;
      rl.emit('line', `${INTERNAL_LINE_PREFIX}${match.cmd}`);
    } finally {
      rl.output = savedOutput;
    }
  }

  function _cancelSlashPicker() {
    _clearSlashPicker();
    _slashPickerActive = false;
    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    rl.line = '';
    rl.cursor = 0;
    rl.prompt();
  }

  // ── Inline @ file picker functions ──

  function _listAtEntries(dir, filter) {
    // 纯列举内核已抽到 repl/atPicker（并修复 _DIR_SKIP 未定义的潜伏 bug，REQ-2026-002）。
    //
    // 流畅性(keystroke):`@` 后每键都到这里。历史实现每键 readdirSync + 全量排序 + 映射;同一目录内
    // 连续键入 filter 时这些全不变,只有子串收窄。→ 两级缓存去掉每键 IO+排序:
    //   1. completionDirCache.readdirCached 按目录短 TTL 记忆 readdirSync(与 TUI @-mention 共享同一缓存);
    //   2. atProjectionCache.getProjection 按目录短 TTL 记忆「排序好的基础投影」;
    //   3. applyAtFilter 每键只做廉价子串收窄。
    // 任一叶子加载/执行失败 → 回退纯内核 _listAtEntriesPure(逐字节等价历史)。
    try {
      const _abs = dir;
      const _readdirCache = require('../cli/tui/completionDirCache');
      const _projCache = require('./repl/atProjectionCache');
      const projection = _projCache.getProjection(
        _abs,
        () => _buildAtProjection(_abs, (d) => _readdirCache.readdirCached(d, _atDefaultReaddir)),
      );
      return _applyAtFilter(projection, filter);
    } catch {
      return _listAtEntriesPure(dir, filter);
    }
  }

  function _clearAtPicker() {
    if (_atRenderedLines <= 0 || !process.stdout.isTTY) return;
    const promptLen = (rl._prompt || '> ').replace(/\x1b\[[^m]*m/g, '').length;
    const col = promptLen + fmt().displayWidth(rl.line || '');
    process.stdout.write(`\x1b[B\x1b[1G\x1b[J\x1b[A\x1b[${col + 1}G`);
    _atRenderedLines = 0;
  }

  function _renderAtPicker() {
    if (!process.stdout.isTTY) return;
    if (_atRenderPending) return;
    _atRenderPending = true;
    setImmediate(() => {
      _atRenderPending = false;
      _renderAtPickerNow();
    });
  }

  function _renderAtPickerNow() {
    if (!process.stdout.isTTY) return;
    _atMatches = _listAtEntries(_atCurrentDir, _atFilter);
    if (_atMatches.length === 0) { _clearAtPicker(); return; }
    if (_atSelectedIdx >= _atMatches.length) _atSelectedIdx = _atMatches.length - 1;
    if (_atSelectedIdx < 0) _atSelectedIdx = 0;

    const visible = _atMatches.slice(0, AT_PICKER_MAX);
    const cols = process.stdout.columns || 80;
    const lines = [];
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i];
      const row = `  + ${entry.display}`;
      const trimmedRow = row.length > cols - 1 ? row.slice(0, cols - 1) : row;
      if (i === _atSelectedIdx) {
        lines.push(`\x1b[7m${trimmedRow}\x1b[27m`);
      } else {
        lines.push(`\x1b[2m${trimmedRow}\x1b[22m`);
      }
    }
    if (_atMatches.length > AT_PICKER_MAX) {
      lines.push(`\x1b[2m  ... ${_atMatches.length - AT_PICKER_MAX} more\x1b[22m`);
    }

    const promptLen = (rl._prompt || '> ').replace(/\x1b\[[^m]*m/g, '').length;
    const col = promptLen + fmt().displayWidth(rl.line || '');
    const content = lines.join('\n');
    const up = lines.length;
    process.stdout.write(`\x1b[B\x1b[1G\x1b[J${content}\x1b[${up}A\x1b[${col + 1}G`);
    _atRenderedLines = lines.length;
  }

  function _acceptAtPick() {
    const match = _atMatches[_atSelectedIdx];
    _clearAtPicker();
    if (!match) { _atPickerActive = false; return; }

    const cwd = process.env.KHYQUANT_CWD || process.cwd();

    if (match.isDir) {
      // Descend into directory
      _atCurrentDir = path.join(_atCurrentDir, match.name);
      _atFilter = '';
      _atSelectedIdx = 0;
      const relPath = path.relative(cwd, _atCurrentDir).replace(/\\/g, '/') + '/';
      const before = (rl.line || '').slice(0, _atAnchorCol);
      const after = (rl.line || '').slice(rl.cursor);
      const newLine = before + '@' + relPath + after;
      if (process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
      }
      rl.line = newLine;
      rl.cursor = before.length + 1 + relPath.length;
      rl._refreshLine();
      _renderAtPicker();
      return;
    }

    // File selected
    _atPickerActive = false;
    const relDir = path.relative(cwd, _atCurrentDir).replace(/\\/g, '/');
    const relPath = relDir ? `${relDir}/${match.name}` : match.name;
    const before = (rl.line || '').slice(0, _atAnchorCol);
    const after = (rl.line || '').slice(rl.cursor);
    const newLine = before + '@' + relPath + ' ' + after;
    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    rl.line = newLine;
    rl.cursor = before.length + 1 + relPath.length + 1;
    rl._refreshLine();
  }

  function _cancelAtPicker() {
    _clearAtPicker();
    _atPickerActive = false;
  }

  // ── Claude Code style: raw stdin paste detection state ──
  // These must be in the outer function scope so _clearTransientInputState
  // and _flushRawPaste can access them.
  const RAW_PASTE_THRESHOLD = 40;  // chars — shorter than Claude's 800 for CJK/tables
  let _rawPasteActive = false;
  let _rawPasteBuf = [];
  let _rawPasteTimer = null;
  const RAW_PASTE_TIMEOUT_MS = 150;

  if (typeof rl._ttyWrite === 'function') {
    const _origTtyWrite = rl._ttyWrite.bind(rl);
    let _pasteBuf = [];
    let _pasteLinePrefix = '';
    let _pasteLineSuffix = '';

    // ── Claude Code style: raw stdin paste detection ──
    // When stdin delivers a chunk containing multiple newlines (>= 2) and
    // length above threshold, it is almost certainly a paste.  We set a flag
    // so _ttyWrite absorbs all subsequent keypress events into _rawPasteBuf
    // instead of forwarding them to readline.  A 150ms silence timer flushes
    // the accumulated content as a single paste.

    // Prepend so we see the raw data before readline's internal handler.
    // We cannot prevent readline from receiving the data (it has its own
    // listener), but by setting _rawPasteActive we make _ttyWrite swallow
    // all keypress events into our buffer.  The line events that readline
    // fires are empty/meaningless because _ttyWrite returns early.
    // 流畅性(keystroke):`data` 监听器对每一块 stdin chunk(即每次按键)都跑一遍粘贴判定。
    // 历史实现每键 `raw.match(/[\r\n]/g)` 分配一个匹配数组——普通短按键(长度 < 阈值)绝无可能被判为
    // 粘贴,却仍付正则/数组分配代价。经 rawPasteChunkClassify.isPasteChunk 先用长度短路(短 chunk 直接
    // false,零正则),仅长 chunk 才手扫换行。叶子加载/异常 → 回退历史正则(逐字节等价)。
    let _pasteClassify;
    try { _pasteClassify = require('./repl/rawPasteChunkClassify'); } catch { _pasteClassify = null; }
    // UTF-8-safe stdin decode (input-side twin of the SSE output-side fix):
    // stdin `data` events split on BYTE boundaries, so a multibyte char
    // (CJK = 3 bytes, emoji = 4) straddling two chunks gets decoded to U+FFFD
    // per-chunk and corrupted before it ever reaches the paste buffer. Hold ONE
    // StringDecoder (via the shared _sseTextDecoder leaf) across the listener's
    // lifetime so split sequences are stitched back together. Gate
    // KHY_STDIN_UTF8_DECODE (default on); off / leaf-load failure → historical
    // per-chunk `chunk.toString('utf8')` (byte-revert).
    let _stdinDecoder = null;
    const _stdinUtf8DecodeOn = !['0', 'false', 'off', 'no'].includes(
      String((process.env && process.env.KHY_STDIN_UTF8_DECODE) || '').trim().toLowerCase());
    if (_stdinUtf8DecodeOn) {
      try {
        _stdinDecoder = require('../services/gateway/adapters/_sseTextDecoder').createSseTextDecoder();
      } catch { _stdinDecoder = null; }
    }
    if (process.stdin.isTTY && _aggressivePasteDetectionEnabled) {
      process.stdin.prependListener('data', (chunk) => {
        const raw = _stdinDecoder
          ? _stdinDecoder.write(chunk)
          : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''));
        // Skip if already inside bracketed paste capture
        if (_pasteCapturing) return;
        // Skip if this is a bracketed paste (handled by _ttyWrite bracket logic)
        if (raw.includes('\x1b[200~') || raw.includes('[200~')) return;
        // Detect paste: multiple newlines + length above threshold.
        // Fast-path via leaf (length short-circuit avoids per-keystroke regex alloc);
        // byte-identical fallback to the historical regex when the leaf is unavailable.
        const _isPaste = _pasteClassify
          ? _pasteClassify.isPasteChunk(raw, RAW_PASTE_THRESHOLD, process.env)
          : (raw.length >= RAW_PASTE_THRESHOLD && (raw.match(/[\r\n]/g) || []).length >= 2);
        if (_isPaste) {
          _rawPasteActive = true;
          _rawPasteBuf.push(raw);
          if (_rawPasteTimer) clearTimeout(_rawPasteTimer);
          _rawPasteTimer = setTimeout(() => _flushRawPaste(), RAW_PASTE_TIMEOUT_MS);
          return;
        }
        // Continuation of an active raw paste (follow-up chunk)
        if (_rawPasteActive) {
          _rawPasteBuf.push(raw);
          if (_rawPasteTimer) clearTimeout(_rawPasteTimer);
          _rawPasteTimer = setTimeout(() => _flushRawPaste(), RAW_PASTE_TIMEOUT_MS);
        }
      });
    }

    function _flushRawPaste() {
      _rawPasteTimer = null;
      _rawPasteActive = false;
      const text = _rawPasteBuf.join('')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\x1b\[\?2004[hl]/g, '')
        .trim();
      _rawPasteBuf = [];
      if (!text) return;
      // Unified paste handling (busy or not): store as _pendingPaste,
      // inject tag into readline so user can add context before pressing Enter.
      _storePendingPaste(text, _origTtyWrite, String(rl.line || '').slice(0, rl.cursor || 0), false, String(rl.line || '').slice(rl.cursor || 0));
    }

    // ── DeepSeek-TUI style: rapid keystroke paste-burst detection ──
    // Tracks timing between consecutive keypress events.  When 3+ printable
    // characters arrive within BURST_CHAR_INTERVAL_MS, classify as paste.
    // During an active burst, Enter is converted to a buffered newline
    // instead of triggering readline submit.  After BURST_SUPPRESS_MS of
    // silence the buffer is flushed via _storePendingPaste.
    const BURST_CHAR_INTERVAL_MS = 12;  // DeepSeek uses 8ms; 12ms for Node overhead
    const BURST_MIN_CHARS = 3;
    const BURST_SUPPRESS_MS = 150;

    function _flushBurst() {
      if (_burstFlushTimer) { clearTimeout(_burstFlushTimer); _burstFlushTimer = null; }
      const wasActive = _burstActive;
      _burstActive = false;
      _burstConsecutive = 0;
      _burstLastCharAt = 0;
      _burstWindowUntil = 0;
      const text = _burstBuf.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      _burstBuf = '';
      if (!text) return;
      if (wasActive) {
        _storePendingPaste(text, _origTtyWrite, '', false);
      }
    }

    function _resetBurstFlushTimer() {
      if (_burstFlushTimer) clearTimeout(_burstFlushTimer);
      _burstFlushTimer = setTimeout(() => _flushBurst(), BURST_SUPPRESS_MS);
    }

    rl._ttyWrite = function (s, key) {
      // When raw paste detection is active, swallow all keypress events.
      if (_rawPasteActive) return;

      const str = typeof s === 'string' ? s : (s ? s.toString() : '');
      const k = key || {};

      if (k.ctrl && k.name === 'o') {
        _handleExpandShortcut();
        if (_busy) showBusyInterjectPrompt();
        else rl.prompt();
        return;
      }

      // ── Paste-burst detection (DeepSeek-TUI style) ──
      const isPlainChar = str.length === 1 && str >= ' ' && !k.ctrl && !k.meta;
      const isEnter = k.name === 'return' || k.name === 'enter';
      const now = Date.now();

      if (_aggressivePasteDetectionEnabled && isPlainChar && !_pasteCapturing && !_slashPickerActive) {
        const elapsed = now - _burstLastCharAt;
        _burstLastCharAt = now;

        if (_burstLastCharAt > 0 && elapsed <= BURST_CHAR_INTERVAL_MS) {
          _burstConsecutive++;
          if (_burstConsecutive >= BURST_MIN_CHARS && !_burstActive) {
            _burstActive = true;
            // Retroactively grab what readline already has in its buffer
            const currentLine = String(rl.line || '');
            if (currentLine) {
              _burstBuf = currentLine;
              try { rl.write(null, { ctrl: true, name: 'u' }); } catch { rl.line = ''; rl.cursor = 0; }
            }
          }
        } else {
          _burstConsecutive = 1;
        }

        if (_burstActive) {
          _burstBuf += str;
          _burstWindowUntil = now + BURST_SUPPRESS_MS;
          _resetBurstFlushTimer();
          return; // Don't pass to readline
        }
      }

      // Enter during active burst or within suppress window → buffer as newline
      if (_aggressivePasteDetectionEnabled && isEnter && !_pasteCapturing && (_burstActive || now < _burstWindowUntil)) {
        _burstBuf += '\n';
        _burstWindowUntil = now + BURST_SUPPRESS_MS;
        _resetBurstFlushTimer();
        return; // Don't let readline submit
      }

      // ── @ file picker mode — consume all keystrokes ──
      if (_atPickerActive) {
        if (k.name === 'escape' || (k.ctrl && k.name === 'c')) {
          _cancelAtPicker();
          return;
        }
        if (k.name === 'return' || k.name === 'tab') {
          _acceptAtPick();
          return;
        }
        if (k.name === 'up') {
          if (_atSelectedIdx > 0) _atSelectedIdx--;
          _renderAtPicker();
          return;
        }
        if (k.name === 'down') {
          if (_atSelectedIdx < _atMatches.length - 1) _atSelectedIdx++;
          _renderAtPicker();
          return;
        }
        if (k.name === 'backspace') {
          if (_atFilter.length <= 0) {
            _cancelAtPicker();
            _origTtyWrite(s, key);
            return;
          }
          _atFilter = _atFilter.slice(0, -1);
          _atSelectedIdx = 0;
          _origTtyWrite(s, key);
          _renderAtPicker();
          return;
        }
        if (str === '/' && _atMatches[_atSelectedIdx]?.isDir) {
          _acceptAtPick();
          return;
        }
        if (str === ' ') {
          if (_atMatches.length > 0) _acceptAtPick();
          else _cancelAtPicker();
          if (!_atPickerActive) _origTtyWrite(s, key);
          return;
        }
        if (str.length === 1 && str >= ' ') {
          _atFilter += str;
          _atSelectedIdx = 0;
          _origTtyWrite(s, key);
          _renderAtPicker();
          return;
        }
        return;
      }

      // ── Slash picker mode — consume all keystrokes ──
      if (_slashPickerActive) {
        if (k.name === 'escape' || (k.ctrl && k.name === 'c')) {
          _cancelSlashPicker();
          return;
        }
        if (k.name === 'return' || k.name === 'tab') {
          _acceptSlashPick();
          return;
        }
        if (k.name === 'up' || k.name === 'k') {
          if (_slashMatches.length > 0) {
            _slashSelectedIdx = (_slashSelectedIdx - 1 + _slashMatches.length) % _slashMatches.length;
          }
          _renderSlashPicker();
          return;
        }
        if (k.name === 'down' || k.name === 'j') {
          if (_slashMatches.length > 0) {
            _slashSelectedIdx = (_slashSelectedIdx + 1) % _slashMatches.length;
          }
          _renderSlashPicker();
          return;
        }
        if (k.name === 'backspace') {
          if (_slashFilter.length <= 1) {
            _cancelSlashPicker();
            return;
          }
          _slashFilter = _slashFilter.slice(0, -1);
          _slashSelectedIdx = 0;
          _origTtyWrite(s, key);
          _renderSlashPicker();
          return;
        }
        if (str === ' ') {
          const exact = _slashMatches.find(sc => sc.cmd === _slashFilter);
          if (exact) {
            _clearSlashPicker();
            _slashPickerActive = false;
            _origTtyWrite(s, key);
            return;
          }
          _acceptSlashPick();
          return;
        }
        if (str.length === 1 && str >= ' ') {
          _slashFilter += str;
          _slashSelectedIdx = 0;
          _origTtyWrite(s, key);
          _renderSlashPicker();
          return;
        }
        return;
      }

      // ── Busy + empty line + ↑ → pull the last queued (unsent) message back
      // into the input for editing (mirrors the TUI / Claude Code behaviour).
      // Placed after the picker blocks (which return earlier) and before the
      // low-latency short-circuit so it works in both input paths.
      if (k.name === 'up' && _busy && (rl.line || '') === '' && _queuedInputs.length > 0
          && !_slashPickerActive && !_atPickerActive && !_pasteCapturing) {
        const last = _queuedInputs.pop();
        _busyQueueShownSig = ''; // force the queue panel to repaint on next prompt
        _origConsoleLog(c.dim('  ↳ 已取回排队消息，可编辑后回车重新发送'));
        if (process.stdout.isTTY) {
          try { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); } catch { /* ignore */ }
        }
        rl.line = String(last == null ? '' : last);
        rl.cursor = rl.line.length;
        try { rl._refreshLine(); } catch { /* ignore */ }
        return;
      }

      // ── Detect '/' on empty line → enter picker mode ──
      if (!_pasteCapturing && !_busy && str === '/' && (rl.line || '') === '') {
        _slashPickerActive = true;
        _slashFilter = '/';
        _slashSelectedIdx = 0;
        _origTtyWrite(s, key);
        _renderSlashPicker();
        return;
      }

      // ── Detect '@' → enter file picker mode ──
      if (!_pasteCapturing && !_busy && !_slashPickerActive && str === '@') {
        _atPickerActive = true;
        _atFilter = '';
        _atSelectedIdx = 0;
        _atCurrentDir = process.env.KHYQUANT_CWD || process.cwd();
        _atAnchorCol = (rl.line || '').length;
        _origTtyWrite(s, key);
        _renderAtPicker();
        return;
      }

      // Low-latency mode keeps slash picker but skips bracketed-paste interception
      // to avoid any extra input-path overhead.
      if (_lowLatencyInputEnabled) {
        _origTtyWrite(s, key);
        return;
      }

      // ── Start marker ──
      if (str.includes('\x1b[200~') || str.includes('[200~')) {
        _pasteCapturing = true;
        _pasteBuf = [];
        _pasteLinePrefix = String(rl.line || '').slice(0, rl.cursor || 0);
        _pasteLineSuffix = String(rl.line || '').slice(rl.cursor || 0);
        const afterStart = str.split(/\x1b?\[200~/)[1];
        if (afterStart) {
          const endIdx = afterStart.indexOf('\x1b[201~');
          if (endIdx !== -1) {
            // Entire paste in one chunk (small paste)
            _pasteBuf.push(afterStart.slice(0, endIdx));
            _pasteCapturing = false;
            const tail = afterStart.slice(endIdx + 6);
            _finishPasteCapture(_origTtyWrite, /[\r\n]/.test(tail));
            if (tail) _origTtyWrite(tail, key);
            return;
          }
          _pasteBuf.push(afterStart);
        }
        return; // suppress echo
      }

      // ── During capture — accumulate silently ──
      if (_pasteCapturing) {
        const endIdx = str.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          if (endIdx > 0) _pasteBuf.push(str.slice(0, endIdx));
          _pasteCapturing = false;
          const tail = str.slice(endIdx + 6);
          _finishPasteCapture(_origTtyWrite, /[\r\n]/.test(tail));
          if (tail) _origTtyWrite(tail, key);
          return;
        }
        _pasteBuf.push(str);
        return; // suppress echo
      }

      // ── Normal input — pass through ──
      _origTtyWrite(s, key);
    };

    function _finishPasteCapture(writeFn, autoCommittedLine = false) {
      const text = _pasteBuf.join('')
        .replace(/\x1b\[\?2004[hl]/g, '')
        .replace(/\x1b\[(200|201)~/g, '')
        .replace(/\[(200|201)~/g, '')
        .trim();
      _pasteBuf = [];
      if (!text) return;
      // Unified: store as pending paste with tag, user adds context then Enter.
      const prefix = _pasteLinePrefix;
      const suffix = _pasteLineSuffix;
      _pasteLinePrefix = '';
      _pasteLineSuffix = '';
      _storePendingPaste(text, writeFn, prefix, !!autoCommittedLine, suffix);
    }
  }

  // ── Vim mode handler ──
  let _vimHandler = null;
  try {
    if (vimSettings().isVimEnabled()) {
      _vimHandler = vimInput().createVimInputHandler(rl, {
        enabled: true,
        prompt: buildCwdPrompt(),
        onModeChange: (mode) => {
          // Status bar will pick up mode from _vimHandler.getMode()
        },
      });
    }
  } catch { /* vim not available — ignore */ }

  function bindInteractiveInputGuard(renderer) {
    if (!renderer || typeof renderer.setInteractiveGuard !== 'function') return;
    renderer.setInteractiveGuard(() => (
      _busy
      && (
        (typeof rl.line === 'string' && rl.line.length > 0)
        || Date.now() < _busyTypingUntil
      )
    ));
  }

  // ── Exit handling ──
  // IMPORTANT: Do NOT add any keypress listener on rl.input / process.stdin.
  // readline internally calls emitKeypressEvents on its input stream.
  // Adding another 'keypress' listener causes every character to echo twice
  // because the keypress event fires for both readline's internal handler
  // and our external handler, each triggering a write to stdout.
  // The SIGINT handler (Ctrl+C double-press to exit) is registered later
  // in this function, after all state variables are initialized.

  // ── Prompt Frame (Claude Code style: upper line + branch badge + lower line) ──
  let _statusBarEnabled = process.stdout.isTTY && (process.stdout.columns || 0) > 28;
  let _currentOp = '';        // Active operation name (shown during AI work)
  let _requestStart = 0;      // Timestamp when current operation started
  let _sessionTokens = 0;     // Running token count for display
  let _queryEngine = null;    // QueryEngine singleton (KHY_QUERY_ENGINE mode)
  let _intentionalExit = false; // Guard: only exit on real user request, not inquirer side-effects
  let _inquirerActive = false;  // Track inquirer stdin usage for Ctrl+D guard
  let _busyTypingUntil = 0;     // Freeze spinner updates briefly while typing/deleting
  const _slashAutoMenuEnabled = !_lowLatencyInputEnabled
    && String(process.env.KHY_SLASH_AUTOMENU || 'true').toLowerCase() !== 'false';
  let _slashAutoMenuOpening = false;
  let _slashAutoMenuCooldownUntil = 0;

  try {
    process.stdin.on('data', (chunk) => {
      if (_busy) _busyTypingUntil = Date.now() + 900;
      const raw = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (_busy && _plainTerminalUi && /[^\r\n\t\x00-\x1f]/.test(raw)) {
        _busyPromptSuppressedUntilInput = false;
        _busyInterjectRequested = true;
        showBusyInterjectPrompt();
      }

      // Shift+Tab: cycle permission profile in CC order
      // (normal → acceptEdits → auto → strict → yolo). Single source of truth is
      // permissionStore; toolCalling dangerousMode is toggled in lockstep with
      // yolo via the *exported* enable/disableDangerousMode (the old
      // setDangerousMode was never exported and silently no-op'd). The dontAsk
      // profile is startup/settings only (KHY_PERMISSION_MODE=dontAsk), not cycled.
      if (raw === '\x1b[Z' && !_busy && !_inquirerActive) {
        try {
          const permStore = require('../services/permissionStore');
          const CYCLE = ['normal', 'acceptEdits', 'auto', 'strict', 'yolo'];
          const cur = typeof permStore.getProfile === 'function' ? permStore.getProfile() : 'normal';
          const idx = CYCLE.indexOf(cur);
          const next = CYCLE[(idx + 1) % CYCLE.length] || 'normal';
          permStore.setProfile(next);
          try {
            const toolCalling = require('../services/toolCalling');
            if (next === 'yolo') {
              toolCalling.enableDangerousMode();
              toolCalling.acknowledgeDangerousMode();
            } else {
              toolCalling.disableDangerousMode();
            }
          } catch { /* ignore */ }
          leaveInputPromptFrame();
          rl.prompt();
        } catch { /* ignore */ }
        return;
      }

      if (_busy && !_inquirerActive && _isEscOnlyInput(raw)) {
        // 逃生阀:同窗口内第 2 次 Esc(仍忙 = 优雅取消没落地)→ 强制退出;否则先优雅取消。
        if (_maybeForceExitOnBusyInterrupt('Esc')) return; // 已强制退出(不会返回)
        _requestRelayCancel('Interrupted by Esc');
        console.log(c.dim('\n  ⏸ Interrupted'));
        try { rl.prompt(); } catch { /* ignore */ }
        return;
      }

      if (!_slashAutoMenuEnabled) return;
      // When the inline picker is active, skip the legacy auto-menu entirely.
      if (_slashPickerActive) return;
      if (_busy || _inquirerActive || _slashAutoMenuOpening) return;
      if ((process.stdin && process.stdin.isTTY) !== true || (process.stdout && process.stdout.isTTY) !== true) return;
      if (typeof rl?.paused === 'boolean' && rl.paused) return;
      if (Date.now() < _slashAutoMenuCooldownUntil) return;
      if (!raw.includes('/')) return;

      if (String(rl.line || '') !== '/') return;
      _slashAutoMenuOpening = true;
      _slashAutoMenuCooldownUntil = Date.now() + 700;
      setTimeout(() => {
        try {
          if (_slashPickerActive) return;
          if (_busy || _inquirerActive) return;
          if (String(rl.line || '') !== '/') return;
          try { rl.write(null, { ctrl: true, name: 'u' }); } catch { rl.line = ''; }
          rl.emit('line', '__KHY_INTERNAL_LINE__ /');
        } finally {
          _slashAutoMenuOpening = false;
        }
      }, 0);
    });
  } catch { /* best effort */ }

  // Wrapper for inquirer.prompt that sets _inquirerActive flag
  async function inqPrompt(questions) {
    _inquirerActive = true;
    try {
      return await inquirer().prompt(questions);
    } finally {
      _inquirerActive = false;
    }
  }

  // ANSI cursor helpers
  // ANSI cursor constants removed — using simple console.log for cross-platform compat

  // Rotating tips
  const TIPS = [
    '/btw 在 AI 工作时插入不打断的提示',
    '/review 自动多轮代码审查',
    '/cost 查看 AI 费用统计',
    '/model 快速切换 AI 模型',
    '/plan 生成执行计划再动手',
    '/hud 展开完整仪表盘',
    'pool list 管理 AI 账号池',
    'image <路径> 图片分析/网页还原',
    '!<命令> 直接跑 shell，输出进上下文（如 !git status）',
  ];
  let _tipIdx = 0;
  const _tipTimer = setInterval(() => { _tipIdx = (_tipIdx + 1) % TIPS.length; }, 30000);

  /**
   * Render a simple static context line above the prompt.
   * No ANSI cursor movement — just prints lines that stay in the scrollback.
   * This avoids overlap/corruption issues on Windows and non-standard terminals.
   */
  function renderPromptContext() {
    // 计划执行期间：渲染任务进度面板
    try {
      const taskPanel = require('./taskPanelState');
      if (taskPanel.getTasks()) taskPanel.renderPanel();
    } catch { /* taskPanelState not available */ }
  }

  // Wrap rl.prompt to print context before prompt (simple, no ANSI tricks)
  const _origPrompt = rl.prompt.bind(rl);

  // Claude Code style prompt
  // IMPORTANT: keep width-stable prompt text to avoid cursor drift.
  // ANSI color codes in prompt cause readline to miscalculate display width,
  // leading to ghost characters when editing CJK text.
  const { isLegacyWinTerminal: _isLegWin } = require('../tools/platformUtils');
  const _promptChar = _isLegWin() ? '> ' : '❯ ';
  function _getPromptRaw() {
    return _promptChar;
  }
  function _getPlainPrompt() { return _promptChar; }
  const _framedPromptFn = _getPlainPrompt;
  // Full REPL no longer renders a live ANSI input frame.
  // Real terminal resize + readline repainting kept corrupting scrollback and
  // prompt geometry. Keep the plain prompt permanently until the input area is
  // rebuilt on a proper TUI layout instead of cursor-relative border drawing.
  const _inputFrameEnabled = false;
  const _minFrameCols = Math.max(24, parseInt(process.env.KHY_INPUT_FRAME_MIN_COLS || '28', 10) || 28);
  const _canRenderPromptFrame = () => {
    const cols = process.stdout.columns || 80;
    return _inputFrameEnabled && cols >= _minFrameCols;
  };

  // ── Claude Code style bottom status bar ──────────────────────────────
  // Shows: [permission mode] [X% until auto-compact]
  //        [git branch right-aligned above prompt]

  function _renderBottomStatusBar() {
    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 80;

    try {
      const hud = require('./hudRenderer');
      hud.refreshGit();

      // 用 hudRenderer 的完整状态栏：左侧活跃工具/状态，右侧模型/tokens/git
      const statusLine = hud.renderStatusBar(cols, {
        planMode: _planMode,
        localMode: _localMode,
      });
      if (statusLine) {
        console.log(statusLine);
        return;
      }
    } catch { /* fall through to basic */ }

    // Fallback: 基础 git branch
    try {
      const hud = require('./hudRenderer');
      const state = hud.getState();
      if (state.git && state.git.branch) {
        const branchText = ` ${state.git.branch} `;
        const branchLen = branchText.length;
        const pad = Math.max(0, cols - branchLen);
        process.stdout.write(' '.repeat(pad) + c.hex('#FFFFFF').dim(branchText) + '\n');
      }
    } catch { /* best-effort */ }
  }

  function _getPermissionModeState() {
    try {
      const toolCalling = require('../services/toolCalling');
      if (toolCalling && typeof toolCalling.isDangerousMode === 'function' && toolCalling.isDangerousMode()) {
        return { label: 'bypass permissions on', color: '#FF6B80' };
      }
    } catch { /* best effort */ }

    try {
      const permStore = require('../services/permissionStore');
      const profile = typeof permStore.getProfile === 'function'
        ? permStore.getProfile()
        : 'normal';
      if (profile === 'yolo') return { label: 'bypass permissions on', color: '#FF6B80' };
      if (profile === 'strict') return { label: 'ask before all tools on', color: '#FFFFFF' };
      if (profile === 'acceptEdits') return { label: 'accept edits on', color: '#7EE787' };
      // auto (CC-aligned): routine calls auto-approved, destructive/high-risk still ask.
      if (profile === 'auto') return { label: 'auto on', color: '#79C0FF' };
      // dontAsk (CC-aligned): deny-by-default; startup/settings only (not in cycle),
      // but display it when set via KHY_PERMISSION_MODE=dontAsk.
      if (profile === 'dontAsk') return { label: "don't ask on", color: '#D2A8FF' };
      return null;
    } catch {
      return null;
    }
  }

  function _renderPermissionBar() {
    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 80;

    // Left: mode text when non-default; fallback to shortcuts hint (Claude-style).
    const modeState = _getPermissionModeState();
    const permLeft = modeState
      ? c.hex(modeState.color || '#FFFFFF')(modeState.label)
      : c.hex('#FFFFFF').dim('(shift+tab to cycle)');

    // Right: auto-compact progress. The countdown is gated to CC's warning
    // band (only near the threshold) and measured against khy's REAL
    // auto-compact trigger (contextWindow.used vs ratio*window), not the old
    // cumulative-sessionTokens-vs-raw-limit approximation. See
    // cli/contextWarning.js. Gate KHY_CONTEXT_WARNING off → legacy behavior.
    let compactRight = '';
    try {
      const hud = require('./hudRenderer');
      const state = hud.getState();
      const limit = state.contextWindow.limit || 200000;
      const cw = require('./contextWarning');
      if (cw.isEnabled(process.env)) {
        let ratio;
        try { ratio = require('../services/query/compactPipeline').AUTOCOMPACT_THRESHOLD; } catch { /* leaf default */ }
        const decision = cw.buildContextWarning({
          tokenUsage: state.contextWindow.used || 0,
          contextWindow: limit,
          autoCompactEnabled: true,
          autoCompactRatio: ratio,
          lastCompactionUsed: state.contextWindow.lastCompactionUsed || 0,
        });
        if (decision.show) {
          compactRight = decision.style === 'error'
            ? c.hex('#E5484D')(decision.text)
            : decision.style === 'warning'
              ? c.hex('#E2A336')(decision.text)
              : c.dim(decision.text);
        }
      } else {
        // Legacy byte-fallback: session total vs raw limit, always shown.
        const sessionTokens = state.sessionTokens.total || 0;
        if (sessionTokens > 0 && limit > 0) {
          const usedPct = Math.round((sessionTokens / limit) * 100);
          const remaining = Math.max(0, 100 - usedPct);
          compactRight = c.dim(`${remaining}% until auto-compact`);
        }
      }
      // Don't show percentage when no tokens used yet (just started)
    } catch {
      // Don't show on error
    }

    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const truncatePlain = (s, n) => {
      const t = String(s || '');
      if (n <= 0) return '';
      if (t.length <= n) return t;
      return n <= 1 ? t.slice(0, n) : (t.slice(0, n - 1) + '…');
    };
    const plainLeft = stripAnsi(permLeft);
    const rightLen = stripAnsi(compactRight).length;
    const leftBudget = Math.max(1, cols - rightLen - 2);
    const safeLeft = plainLeft.length > leftBudget
      ? c.dim(truncatePlain(plainLeft, leftBudget))
      : permLeft;
    const leftLen = stripAnsi(safeLeft).length;
    const pad = Math.max(1, cols - leftLen - rightLen - 1);

    console.log(safeLeft + ' '.repeat(pad) + compactRight);
  }

  function _buildPermissionBarText() {
    if (!process.stdout.isTTY) return '';
    try {
      const cols = process.stdout.columns || 80;
      const modeState = _getPermissionModeState();
      const permLeft = modeState
        ? c.hex(modeState.color || '#FFFFFF')(modeState.label)
        : c.hex('#FFFFFF').dim('(shift+tab to cycle)');
      let compactRightPlain = '';
      let ctxRightPlain = '';
      try {
        const hud = require('./hudRenderer');
        const state = hud.getState();
        const limit = state.contextWindow.limit || 200000;
        const sessionTokens = state.sessionTokens.total || 0;
        const ctxUsed = state.contextWindow.used || 0;
        if (limit > 0) {
          const ctxPct = Math.max(0, Math.min(100, Math.round((ctxUsed / limit) * 100)));
          ctxRightPlain = `${ctxPct}% ctx`;
        }
        // Auto-compact countdown: same SSOT as _renderPermissionBar (warning
        // band + real trigger ratio). Plain text here; the footer composer
        // dims it. Gate KHY_CONTEXT_WARNING off → legacy byte-fallback.
        const cw = require('./contextWarning');
        if (cw.isEnabled(process.env)) {
          let ratio;
          try { ratio = require('../services/query/compactPipeline').AUTOCOMPACT_THRESHOLD; } catch { /* leaf default */ }
          const decision = cw.buildContextWarning({
            tokenUsage: ctxUsed,
            contextWindow: limit,
            autoCompactEnabled: true,
            autoCompactRatio: ratio,
            lastCompactionUsed: state.contextWindow.lastCompactionUsed || 0,
          });
          if (decision.show) compactRightPlain = decision.text;
        } else if (sessionTokens > 0 && limit > 0) {
          const usedPct = Math.round((sessionTokens / limit) * 100);
          const remaining = Math.max(0, 100 - usedPct);
          compactRightPlain = `${remaining}% until auto-compact`;
        }
      } catch { /* ignore */ }
      const rightPlain = [ctxRightPlain, compactRightPlain].filter(Boolean).join(' · ');
      // 纯排版数学（测量/截断/补白/硬钳位）已抽到 repl/footerLayout（REQ-2026-002）。
      return _composePermissionFooter({ permLeft, rightPlain, cols, dim: c.dim });
    } catch {
      return '';
    }
  }

  let _frameRendered = false; // track whether decoration has been rendered
  let _cachedBottomRule = '';  // cached bottom rule for _refreshLine repaint
  let _cachedBottomFooter = ''; // cached footer text for _refreshLine repaint
  let _lastFrameRuleWidth = 0; // previous top-rule width, used to clear wrapped residues on resize
  let _frameSuppressedUntilNextPrompt = false; // after resize, fall back to plain prompt until next prompt cycle
  // Prompt footer below input is enabled by default — EXCEPT on legacy Windows
  // conhost, where the per-keystroke repaint (rl._refreshLine → bottom-decoration
  // rewrite) turns every keystroke into a slow blocking WriteConsole and makes
  // typing visibly lag/"freeze". There it defaults OFF. Override either way with
  // KHY_PROMPT_FOOTER=1/0.
  const _promptFooterDefault = _isLegWin() ? 'false' : 'true';
  const _promptFooterEnabled = !['0', 'false', 'off', 'no']
    .includes(String(process.env.KHY_PROMPT_FOOTER || _promptFooterDefault).trim().toLowerCase());
  // Keep one blank line between input and bottom footer by default.
  const _inputFooterGapRows = Math.max(0, parseInt(process.env.KHY_INPUT_FOOTER_GAP_ROWS || '1', 10) || 1);

  // Recalculate how many terminal rows the current prompt+input occupies.
  // Needed so the _refreshLine patch can place bottom decoration correctly.
  function _getInputFrameRule() {
    const cols = process.stdout.columns || 80;
    // Reserve the last column so rule writes never trigger terminal auto-wrap.
    const ruleWidth = Math.max(1, cols - 1);
    return c.hex('#D77757')('─'.repeat(ruleWidth));
  }

  function _getInputFrameRuleWidth() {
    const cols = process.stdout.columns || 80;
    return Math.max(1, cols - 1);
  }

  // 承 keystroke 流畅性:每按键 _refreshLine 调本函数,单次刷新内还被 _inputVisualRows /
  // bottom-decoration repaint 再调。度量是 (line,cursor,cols,promptRaw) 的纯函数 → 单槽记忆。
  // promptLen 的 ANSI 剥离正则另按 prompt 串缓存(prompt 静态时跳正则)。
  // 门控 KHY_INPUT_CURSOR_METRICS_MEMO 关 / 叶子加载失败 → 现算(逐字节回退)。
  let _icmMemo;
  function _computeInputCursorMetrics(promptRaw) {
    const cols = Math.max(1, process.stdout.columns || 80);
    const promptLen = _icmMemo
      ? _icmMemo.getPromptLen(promptRaw)
      : (promptRaw || '> ').replace(/\x1b\[[^m]*m/g, '').length;
    const inputBeforeCursor = (rl.line || '').slice(0, rl.cursor || 0);
    const inputWidth = fmt().displayWidth(rl.line || '');
    const cursorPos = promptLen + fmt().displayWidth(inputBeforeCursor);
    const cursorRow = Math.floor(cursorPos / cols);
    const cursorCol = cursorPos % cols;
    // When prompt + input ends exactly on a column boundary, the terminal cursor
    // sits at col 0 of the next visual row. Count that trailing cursor row too.
    const totalRows = Math.max(1, Math.floor((promptLen + inputWidth) / cols) + 1);
    return { cols, promptLen, cursorRow, cursorCol, totalRows };
  }
  function _getInputCursorMetrics() {
    const promptRaw = rl._prompt || '> ';
    try {
      if (!_icmMemo) _icmMemo = require('./repl/inputCursorMetricsMemo');
      const cols = Math.max(1, process.stdout.columns || 80);
      return _icmMemo.getMetrics(
        { line: rl.line || '', cursor: rl.cursor || 0, cols, promptRaw },
        () => _computeInputCursorMetrics(promptRaw),
        process.env,
      );
    } catch {
      return _computeInputCursorMetrics(promptRaw);
    }
  }

  function _inputVisualRows() {
    return _getInputCursorMetrics().totalRows;
  }

  // 承 keystroke 流畅性:本函数在 rl._refreshLine(每按键)里被调,每次 ~6 段字符串拼接重建整段
  // bottom-decoration ANSI 序列。cursorCol-无关的前缀(下移+gap+rule+footer+上移)是
  // (rowsBelowCursor,gapRows,rule,footer) 的纯函数 → 单槽记忆前缀,每键只补廉价的 `\x1b[{col+1}G`。
  // 门控 KHY_BOTTOM_DECORATION_REPAINT_MEMO 关 / 叶子加载失败 → 现拼(逐字节回退)。
  let _bdrMemo;
  function _computeBottomDecorationRepaint(metrics) {
    const { cursorRow, cursorCol, totalRows } = metrics;
    const rowsBelowCursor = totalRows - cursorRow - 1;

    let out = '';
    if (rowsBelowCursor > 0) out += `\x1b[${rowsBelowCursor}B`;
    for (let i = 0; i < _inputFooterGapRows; i++) {
      out += '\x1b[1B\x1b[2K\x1b[1G';
    }
    out += '\x1b[1B\x1b[2K\x1b[1G' + _cachedBottomRule;
    out += '\x1b[1B\x1b[2K\x1b[1G' + _cachedBottomFooter;

    const rowsReturn = rowsBelowCursor + _inputFooterGapRows + 2;
    if (rowsReturn > 0) out += `\x1b[${rowsReturn}A`;
    out += `\x1b[${cursorCol + 1}G`;
    return out;
  }
  function _buildBottomDecorationRepaint(metrics) {
    try {
      if (!_bdrMemo) _bdrMemo = require('./repl/bottomDecorationRepaintMemo');
      const { cursorRow, cursorCol, totalRows } = metrics;
      const rowsBelowCursor = totalRows - cursorRow - 1;
      return _bdrMemo.getRepaint(
        {
          rowsBelowCursor,
          gapRows: _inputFooterGapRows,
          rule: _cachedBottomRule,
          footer: _cachedBottomFooter,
          cursorCol,
        },
        process.env,
      );
    } catch {
      return _computeBottomDecorationRepaint(metrics);
    }
  }

  function _clearRenderedInputFrameRegion() {
    const metrics = _getInputCursorMetrics();
    const staleRuleRows = Math.max(1, Math.ceil(Math.max(1, _lastFrameRuleWidth || _getInputFrameRuleWidth()) / metrics.cols));
    const clearUpRows = metrics.cursorRow + staleRuleRows;
    process.stdout.write(`\x1b[${clearUpRows}A\x1b[1G\x1b[J`);
  }

  function _renderPlainPromptAfterResize() {
    if (!process.stdout.isTTY) return;
    try {
      if (_syncOutput) _syncOutput.beginSync();
      _clearRenderedInputFrameRegion();
      _frameRendered = false;
      // resize 清了输入 frame 区域(终端下方内容被清/移)→ 底部装饰去重槽失效。
      try { if (_bdwDedup) _bdwDedup.invalidate(); } catch { /* ignore */ }
      _cachedBottomRule = '';
      _cachedBottomFooter = '';
      _lastFrameRuleWidth = 0;
      _frameSuppressedUntilNextPrompt = true;
      rl.setPrompt(_getPlainPrompt());
      _origRefreshLine();
    } catch { /* ignore */ }
    finally {
      if (_syncOutput) _syncOutput.endSync();
    }
  }

  // Update cached decoration on terminal resize
  const _handleFooterResize = () => {
    if (!process.stdout.isTTY) return;
    if (_frameRendered) {
      _renderPlainPromptAfterResize();
      return;
    }
    if (_frameSuppressedUntilNextPrompt) {
      try {
        rl.setPrompt(_getPlainPrompt());
        _origRefreshLine();
      } catch { /* ignore */ }
    }
  };
  process.stdout.on('resize', _handleFooterResize);

  // Monkey-patch rl._refreshLine: readline's clearScreenDown() wipes the bottom
  // decoration lines on every keystroke.  Repaint them immediately after.
  // This is the ONLY place bottom decoration is drawn — never pre-printed.
  const _origRefreshLine = rl._refreshLine.bind(rl);
  let _syncOutput;
  try { _syncOutput = require('./syncOutput'); } catch { _syncOutput = null; }
  // 承 keystroke 流畅性:每按键写出的底部装饰重绘串,仅当 (metrics,rule,footer) 变化时才不同;
  // 相同串重写纯属终端 IO + 潜在闪烁。按上次写出的串单槽去重(门控 KHY_BOTTOM_DECORATION_WRITE_DEDUP)。
  // frame 渲染/拆除时 invalidate() 强制下次必写(装饰相对光标定位,终端下方被别处改动后须重画)。
  let _bdwDedup;
  try { _bdwDedup = require('./repl/bottomDecorationWriteDedup'); } catch { _bdwDedup = null; }
  rl._refreshLine = function () {
    _origRefreshLine();
    if (_promptFooterEnabled && _frameRendered && process.stdout.isTTY && _cachedBottomRule) {
      try {
        // Calculate how many rows below the prompt line start the cursor is.
        // For a single-line input, cursor is on row 0 relative to prompt start.
        // For wrapped input, cursor may be on row 1, 2, etc.
        const metrics = _getInputCursorMetrics();
        // Relative repaint (avoid DECSC/DECRC restore issues on some terminals).
        // Clear any stale decoration rows left by previous wrap geometry, then
        // repaint the current gap + rule + footer and restore the input cursor.
        const _repaint = _buildBottomDecorationRepaint(metrics);
        // Skip the terminal write when the repaint string is byte-identical to the
        // last one written (gate off / leaf missing → always write = today's behavior).
        if (!_bdwDedup || _bdwDedup.shouldWrite(_repaint, process.env)) {
          if (_syncOutput) _syncOutput.beginSync();
          process.stdout.write(_repaint);
          if (_syncOutput) _syncOutput.endSync();
        }
      } catch { /* ignore */ }
    }
  };

  function renderInputPromptFrame(args) {
    const currentPrompt = _getPlainPrompt();
    if (_frameSuppressedUntilNextPrompt || !_canRenderPromptFrame()) {
      rl.setPrompt(currentPrompt);
      _origPrompt(...args);
      return;
    }

    if (!_frameRendered) {
      _frameRendered = true;
      // frame 重新渲染 → 终端下方状态换新,底部装饰去重槽失效(下次重绘必写)。
      try { if (_bdwDedup) _bdwDedup.invalidate(); } catch { /* ignore */ }

      const rule = _getInputFrameRule();
      _lastFrameRuleWidth = _getInputFrameRuleWidth();

      // Cache for _refreshLine repaint (bottom decoration is ONLY drawn by _refreshLine)
      if (_promptFooterEnabled) {
        _cachedBottomRule = rule;
        _cachedBottomFooter = _buildPermissionBarText();
      } else {
        _cachedBottomRule = '';
        _cachedBottomFooter = '';
      }

      // Reserve terminal rows below cursor so the top rule + prompt + bottom
      // decoration all remain visible.  Without this, if the cursor sits on
      // the last visible terminal row, the '\n' characters push the top rule
      // off-screen before the user ever sees it.
      // Need: 1 (status bar) + 1 (top rule) + 1 (prompt) + gap + 1 (bottom rule) + 1 (footer) = 5+gap
      if (_promptFooterEnabled && process.stdout.isTTY) {
        const reserveRows = 4 + _inputFooterGapRows;
        process.stdout.write('\n'.repeat(reserveRows) + `\x1b[${reserveRows}A`);
      }

      // Print git branch + top rule (these scroll with content — safe)
      try { _renderBottomStatusBar(); } catch { /* ignore */ }
      process.stdout.write(rule + '\n');
    }

    // Set prompt and render — _refreshLine will paint bottom decoration
    rl.setPrompt(currentPrompt);
    _origPrompt(...args);

    // Immediately paint bottom decoration so both borders are visible before
    // the first keystroke (readline's _refreshLine only fires on input).
    if (_promptFooterEnabled && _frameRendered && process.stdout.isTTY && _cachedBottomRule) {
      try {
        process.stdout.write(_buildBottomDecorationRepaint(_getInputCursorMetrics()));
      } catch { /* ignore */ }
    }
  }

  function leaveInputPromptFrame() {
    const wasRendered = _frameRendered;
    _frameRendered = false;
    _cachedBottomRule = '';
    _cachedBottomFooter = '';
    _lastFrameRuleWidth = 0;
    _frameSuppressedUntilNextPrompt = false;
    if (!wasRendered) return;
    // Clear any residual bottom decoration below current cursor
    try {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1B7');   // save cursor
        // Move past remaining input rows
        const rowsBelow = _inputVisualRows() - 1;
        if (rowsBelow > 0) process.stdout.write(`\x1b[${rowsBelow}B`);
        process.stdout.write('\x1b[1B\x1b[J'); // down 1 + clear to end of screen
        process.stdout.write('\x1B8');   // restore cursor
      }
    } catch { /* ignore */ }
  }

  rl.prompt = (...args) => {
    _setLiveHudTypingMode();
    // TUI bridge: record prompt state (best-effort)
    try { if (_tuiCtrl) _tuiCtrl.recordPrompt(rl.line, rl.cursor); } catch { /* */ }
    if (_statusBarEnabled) {
      renderPromptContext();
    }
    renderInputPromptFrame(args);
  };

  // 忙碌 prompt：明确告知用户可以输入 (/s 修正, /i 中断, 直接排队)
  const _busyHintLine = c.dim('  ↳ 注入时机: /s 下一轮注入 · /s! 紧急抢占续跑 · /i 立即打断 · 直接输入排队');
  let _busyHintShownAt = 0; // 0 = 尚未显示，非 0 = 已显示过（本轮忙碌只显示一次）
  // Signature of the last-rendered queue panel; reprint only when the queue
  // actually changes (enqueue / dequeue) to avoid flooding on every repaint.
  let _busyQueueShownSig = '';
  let _busyInterjectRequested = false;
  let _busyPromptSuppressedUntilInput = false;
  let _busyPromptVisible = false;

  function _clearVisibleBusyPromptLine() {
    if (!_busyPromptVisible) return;
    try {
      if (process.stdout.isTTY) {
        process.stdout.write('\r\x1b[K');
      }
    } catch { /* ignore */ }
    _busyPromptVisible = false;
  }

  function _suppressBusyInterjectPromptUntilNextInput() {
    _busyInterjectRequested = false;
    _busyTypingUntil = 0;
    if (!_plainTerminalUi) return;
    _busyPromptSuppressedUntilInput = true;
    _busyPromptVisible = false;
    if (_busyPromptRepaintPending) {
      clearTimeout(_busyPromptRepaintPending);
      _busyPromptRepaintPending = null;
    }
    try {
      if (_syncOutput) _syncOutput.beginSync();
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[2K\x1b[1G');
      }
      if (_syncOutput) _syncOutput.endSync();
    } catch { /* ignore */ }
  }

  function showBusyInterjectPrompt() {
    if (!_busy || _busyStreaming) return;
    // Don't overwrite an in-place transient status line — doing so pushes it
    // to a new row and causes stacking/flooding.
    if (_transientStatusActive) return;
    if (_plainTerminalUi && (
      _busyPromptSuppressedUntilInput
      || !_busyInterjectRequested
      || Date.now() >= _busyTypingUntil
    )) return;
    try {
      _setLiveHudTypingMode();
      // If frame was rendered, clear it first to prevent stale decoration
      if (_frameRendered) {
        _frameRendered = false;
        _cachedBottomRule = '';
        _cachedBottomFooter = '';
      }
      // 确保 stdin 活跃且 readline 在监听，防止输入丢失
      try { process.stdin.resume(); } catch { /* ignore */ }
      try { rl.resume(); } catch { /* ignore */ }
      try {
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function' && !process.stdin.isRaw) {
          process.stdin.setRawMode(true);
        }
      } catch { /* ignore */ }
      // Wrap in syncOutput so clear + prompt repaint is atomic (no flicker)
      if (_syncOutput) _syncOutput.beginSync();
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[2K\x1b[1G'); // clear line + cursor to col 1
      }
      // 本轮忙碌只显示一次操作提示
      if (_busyHintShownAt === 0) {
        _busyHintShownAt = Date.now();
        _origConsoleLog(_busyHintLine);
      }
      // 排队消息可见原貌：队列变化时列出每条（截断），队尾标注可 ↑ 取回。
      if (_queuedInputs.length > 0) {
        const sig = `${_queuedInputs.length}|${_queuedInputs.join('')}`;
        if (sig !== _busyQueueShownSig) {
          _busyQueueShownSig = sig;
          const lastIdx = _queuedInputs.length - 1;
          _queuedInputs.forEach((raw, i) => {
            const preview = _summarizeQueuedInputForDisplay(raw, 56);
            const tail = i === lastIdx ? '  ↑ 取回' : '';
            _origConsoleLog(c.dim(`  ${i + 1}. ${preview}${tail}`));
          });
          _origConsoleLog(c.dim(`  ⏳ ${_queuedInputs.length} 条排队（↑ 取回最后一条，/i 优先，Ctrl+C 中断）`));
        }
      } else {
        _busyQueueShownSig = '';
      }
      rl.setPrompt(_getPlainPrompt());
      _origPrompt();
      _busyPromptVisible = true;
      if (_syncOutput) _syncOutput.endSync();
    } catch { /* ignore */ }
  }

  // Keep busy-mode input visible even when many tool/status lines are printed.
  // We repaint with a small throttle to avoid flicker.
  const _busyPromptRepaintMinMs = Math.max(
    80,
    parseInt(process.env.KHY_BUSY_PROMPT_REPAINT_MS || '220', 10) || 220,
  );
  let _busyPromptRepaintAt = 0;
  let _busyPromptRepaintPending = null;
  let _busyPromptKeepalive = null; // 周期定时器，确保 busy 模式下输入框持续可见

  function _startBusyPromptKeepalive() {
    if (_busyPromptKeepalive) return;
    _busyPromptKeepalive = setInterval(() => {
      if (!_busy || _inquirerActive) { _stopBusyPromptKeepalive(); return; }
      if (_slashPickerActive || _atPickerActive || _pasteCapturing || _rawPasteActive) return;
      if (!process.stdout.isTTY || !process.stdin.isTTY) return;
      // Skip repaint when a transient in-place status line is occupying the
      // current row — repainting the prompt would push it to a new line and
      // cause the "flooding" bug where status lines stack up.
      if (_transientStatusActive) return;
      // 距上次重绘超过 400ms 才重绘（避免和 console.log 触发的重绘重复）
      if (Date.now() - _busyPromptRepaintAt < 400) return;
      _busyPromptRepaintAt = Date.now();
      showBusyInterjectPrompt();
    }, 500);
  }

  function _stopBusyPromptKeepalive() {
    if (_busyPromptKeepalive) {
      clearInterval(_busyPromptKeepalive);
      _busyPromptKeepalive = null;
    }
  }

  function _scheduleBusyPromptRepaint() {
    if (!_busy || _busyStreaming || _inquirerActive) return;
    if (_slashPickerActive || _atPickerActive || _pasteCapturing || _rawPasteActive) return;
    if (!process.stdout.isTTY || !process.stdin.isTTY) return;
    // 始终同步重绘——保证每次 console.log 后输入框可见。
    // spinner._render 被 isRaw 拦截不会画任何东西，
    // 所以 showBusyInterjectPrompt 是唯一的输入框来源。
    const now = Date.now();
    if (_busyPromptRepaintPending) {
      clearTimeout(_busyPromptRepaintPending);
      _busyPromptRepaintPending = null;
    }
    // 最小间隔防闪烁：距上次重绘不足 50ms 时延迟到 50ms
    const elapsed = now - _busyPromptRepaintAt;
    if (elapsed < 50) {
      _busyPromptRepaintPending = setTimeout(() => {
        _busyPromptRepaintPending = null;
        if (!_busy || _inquirerActive) return;
        if (_slashPickerActive || _atPickerActive || _pasteCapturing || _rawPasteActive) return;
        _busyPromptRepaintAt = Date.now();
        showBusyInterjectPrompt();
      }, 50 - elapsed);
      return;
    }
    _busyPromptRepaintAt = now;
    showBusyInterjectPrompt();
  }

  // Patch console.log once for this REPL session: whenever execution logs are
  // printed during busy mode, repaint the interjection input line below them.
  const _origConsoleLog = console.log.bind(console);
  let _consolePatched = false;

  // ── Task panel repaint throttle ──
  let _taskPanelRepaintAt = 0;
  let _taskPanelRepaintPending = null;
  function _scheduleTaskPanelRepaint() {
    try {
      const taskPanel = require('./taskPanelState');
      if (!taskPanel.getTasks()) return;
      const now = Date.now();
      if (_taskPanelRepaintPending) {
        clearTimeout(_taskPanelRepaintPending);
        _taskPanelRepaintPending = null;
      }
      if (now - _taskPanelRepaintAt < 100) {
        _taskPanelRepaintPending = setTimeout(() => {
          _taskPanelRepaintPending = null;
          _taskPanelRepaintAt = Date.now();
          try { taskPanel.renderPanel(); } catch { /* ignore */ }
        }, 100 - (now - _taskPanelRepaintAt));
        return;
      }
      _taskPanelRepaintAt = now;
      taskPanel.renderPanel();
    } catch { /* taskPanelState not available */ }
  }

  function _installBusyPromptConsolePatch() {
    if (_consolePatched) return;
    console.log = (...args) => {
      if (_busy && !_busyStreaming) {
        _clearVisibleBusyPromptLine();
      }
      _origConsoleLog(...args);
      _scheduleTaskPanelRepaint();
      _scheduleBusyPromptRepaint();
    };
    _consolePatched = true;
  }
  function _uninstallBusyPromptConsolePatch() {
    if (!_consolePatched) return;
    console.log = _origConsoleLog;
    _consolePatched = false;
  }
  _installBusyPromptConsolePatch();

  function showBusySlashMenu() {
    let commands = [];
    try {
      const cmdReg = require('./commandRegistry');
      const byCat = cmdReg.getByCategory();
      for (const items of Object.values(byCat)) {
        for (const sc of items || []) {
          if (sc && sc.cmd && sc.desc) commands.push({ cmd: sc.cmd, desc: sc.desc });
        }
      }
    } catch {
      try {
        const { SLASH_COMMANDS } = router();
        commands = (SLASH_COMMANDS || [])
          .filter(sc => sc && sc.cmd && sc.desc)
          .map(sc => ({ cmd: sc.cmd, desc: sc.desc }));
      } catch { /* ignore */ }
    }
    const preferred = ['/i', '/interrupt', '/model', '/gateway', '/status', '/help'];
    const picked = [];
    for (const key of preferred) {
      const hit = commands.find(c0 => c0.cmd === key);
      if (hit) picked.push(hit);
    }
    if (picked.length === 0) {
      commands.slice(0, 6).forEach(c0 => picked.push(c0));
    }

    console.log(c.dim('  ↳ 忙碌菜单（可继续输入，命令会排队）:'));
    for (const item of picked.slice(0, 6)) {
      console.log(c.dim(`    ${item.cmd.padEnd(12)} ${item.desc}`));
    }
    console.log(c.dim('    注入时机四档（控制何时矫正航向）:'));
    console.log(c.dim('    /s <内容>   下一轮注入 — 不打断，当前工具/回合结束后、AI 下次决策前读取'));
    console.log(c.dim('    /s! <内容>  紧急抢占 — 抢占当前模型回合，保留进度，注入修正后原地续跑（≈几秒）'));
    console.log(c.dim('    /i <内容>   立即打断 — 取消当前回合并作为新任务优先处理（航向偏大时用）'));
    console.log(c.dim('    直接输入    任务后排队 — 作为下一个独立任务执行'));
  }

  function recoverReadlineInput() {
    // If vim is active, resume vim handler instead of readline
    if (_vimHandler && _vimHandler.getMode()) {
      _vimHandler.resume();
      return;
    }
    try { process.stdin.resume(); } catch { /* ignore */ }
    try { rl.resume(); } catch { /* ignore */ }
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function' && !process.stdin.isRaw) {
        process.stdin.setRawMode(true);
      }
    } catch { /* ignore */ }
  }

  // Handle terminal resize
  const _handleStatusBarResize = () => {
    _statusBarEnabled = process.stdout.isTTY && (process.stdout.columns || 0) > 28;
  };
  if (process.stdout.on) {
    process.stdout.on('resize', _handleStatusBarResize);
  }

  rl.prompt();

  // Enable bracketed paste mode so the terminal wraps pasted text in
  // \e[200~ ... \e[201~ markers.  Without this, multi-line paste triggers
  // one 'line' event per line and the bracket detection never fires.
  if (process.stdout.isTTY && !_lowLatencyInputEnabled) {
    try { process.stdout.write('\x1b[?2004h'); } catch { /* ignore */ }
    // Disable on exit to avoid leaking mode into the parent shell
    const _disableBracketPaste = () => {
      try { process.stdout.write('\x1b[?2004l'); } catch { /* ignore */ }
    };
    process.on('exit', _disableBracketPaste);
    process.on('SIGINT', _disableBracketPaste);
  }

  // 安全网：确保进程退出时光标始终可见
  process.on('exit', () => {
    if (process.stdout.isTTY) {
      try { process.stdout.write('\x1B[?25h'); } catch { /* ignore */ }
    }
  });

  // Track session start
  userProfile().trackSessionStart();

  // Non-blocking startup tasks (cloudSync, adminService, skillLearning,
  // securityGuard) are now handled by deferredPrefetch() above.

  // /btw hint queue — non-interrupting hints queued while AI is working.
  // 收敛到进程级共享 store(conversation/btwNoteQueue),让 router `/btw` 与 ink TUI 看见同一队列;
  // 纯文本逻辑(规范化 / 并入下一回合的拼接格式)归纯叶子 conversation/btwNote(单一真源)。
  const _btwQueue = require('../services/conversation/btwNoteQueue');
  const _btwNote = require('../services/conversation/btwNote');
  // Queued user inputs submitted while AI is busy.
  let _queuedInputs = [];
  // Steer 队列 — 方向修正消息，注入到当前工具循环的下一轮迭代
  let _steerQueue = [];
  // 当前正在跑的 turn 的原始输入文本（话题基线）。在 _busy=true 起飞时置位，
  // 用于给忙碌插话的 steer 判定「是否其实换了新话题」（busyTopicShift）——若插话与
  // 运行话题重叠极低 → 判新话题 → steer 降级为 queue，不中途注入污染当前任务。
  let _busyTurnText = '';
  // 跨回合重复护栏的输入：最近 ~8 次「成功」工具调用签名的环形缓冲，跨回合存活
  // （每次「继续」都是一个新的 runToolUseLoop + 全新的回合内 detector，所以这个
  // 缓冲必须活在回合之上）。作为 recentToolSignatures 传入循环，让已经答过的同一
  // 条调用被引导改写/换路，而不是被静默重跑。
  let _recentToolSigs = [];
  // 当前在飞步骤 — 用于在用户 steer 的瞬间报出"修正将于何时被读取"。
  // 由主工具循环回调维护：onToolCall 起飞→置位，onToolResult/onIteration 落地→清空。
  // null 表示处于回合边界（无工具在飞），此时 steer 几乎立即被下一轮决策读取。
  let _inFlightStep = null; // { name: string, startedAt: number } | null
  // /s! 紧急 steer 抢占信号：用户用 /s! 抢占在飞模型回合后置 true，并触发 _requestRelayCancel。
  // 工具循环在 cancel 后经 consumeUrgentSteer 回调 pull-clear 读取它，据此把本次 cancel 当作
  // "注入修正并原地重发"而非整体 bail。/i 与真实网络 cancel 不置此信号，故行为不变。
  let _urgentSteerPending = false;

  // 描述一条 steer/方向修正补充提示词将于何时被注入读取，让"注入时机"对用户可见、可判断。
  // 回合边界 → 几乎立即；有长工具在飞 → 需等其返回，并报出已运行时长，便于用户改用 /i 立即打断。
  function _describeSteerLanding() {
    const step = _inFlightStep;
    if (!step || !step.name) {
      return 'AI 正处于回合边界，将在下一轮决策前立即读取（≈即时）';
    }
    const elapsedMs = Math.max(0, Date.now() - (step.startedAt || Date.now()));
    const elapsedS = Math.round(elapsedMs / 1000);
    const slow = elapsedS >= 8; // 长工具：提示用户可改用 /i 立即打断
    const tail = slow
      ? `；该工具已运行 ${elapsedS}s，如需立即矫正请用 /i 打断当前回合`
      : `（已运行 ${elapsedS}s）`;
    return `当前正在执行「${step.name}」，修正将在其返回后、AI 下一轮决策前读取${tail}`;
  }
  let _lastBusyEnterHintAt = 0;
  const INTERNAL_LINE_PREFIX = '__KHY_INTERNAL_LINE__ ';
  const INPUT_BATCH_WINDOW_MS = Math.max(20, parseInt(process.env.KHY_PASTE_MERGE_MS || '90', 10));
  // When busy, use a longer merge window — pasted lines arrive slower through
  // the readline layer because each line is a separate event.  Without bracketed
  // paste markers, this is the only way to detect paste-during-busy.
  const INPUT_BUSY_BATCH_WINDOW_MS = Math.max(INPUT_BATCH_WINDOW_MS, parseInt(process.env.KHY_BUSY_PASTE_MERGE_MS || '400', 10));
  const _inputBatchModeEnv = String(process.env.KHY_INPUT_BATCH_MODE || 'auto').toLowerCase();
  const INPUT_BATCH_MODE = _lowLatencyInputEnabled ? 'off' : _inputBatchModeEnv; // off | auto | always
  let _inputBatchTimer = null;
  let _inputBatchLines = [];
  let _pendingPaste = null;   // Buffered paste text waiting for user supplement
  let _pendingPasteTag = '';
  let _pendingPasteSkipNextEmptySubmit = false;
  let _pendingPasteHintedAt = 0;
  let _pendingPasteSetAt = 0;  // Timestamp when _pendingPaste was last set — suppresses ghost Enters

  // ── `!` shell escape ────────────────────────────────────────────────────
  // `!<cmd>` (e.g. `!dir`, `!git status`) runs a shell command directly in the
  // REPL and feeds its output into the AI's context for the next turn. The user
  // typed the command themselves, so it is human-authorized by definition — it
  // bypasses the tool-approval prompt but still flows through the single
  // cross-platform shell tool (Windows UTF-8 / idle-timeout / truncation
  // included), so behaviour matches what the AI would get.
  let _pendingShellEscapes = []; // queued {command, body, code} → injected as leading context next turn
  const _SHELL_ESCAPE_CTX_MAX = parseInt(process.env.KHY_SHELL_ESCAPE_CTX_MAX || '8000', 10) || 8000;

  async function _runShellEscape(command) {
    console.log(c.hex('#FF8C42').bold(`! ${command}`));
    let result;
    try {
      const shellTool = require('../tools/shellCommand');
      result = await shellTool.execute({ command }, {});
    } catch (err) {
      result = { success: false, error: err && err.message ? err.message : String(err) };
    }
    const body = String((result && (result.output || result.error)) || '').replace(/\s+$/, '');
    const code = result && Number.isFinite(result.exitCode)
      ? result.exitCode
      : (result && result.success ? 0 : 1);
    if (body) console.log(body);
    else console.log(c.dim('(无输出)'));
    if (!result || !result.success) console.log(c.hex('#FF6B6B')(`  └ 退出码 ${code}`));
    return { command, body: body || '(无输出)', code, success: !!(result && result.success) };
  }

  function _enqueueShellEscapeContext(rec) {
    if (rec && rec.command) _pendingShellEscapes.push(rec);
  }

  // Drain queued escapes into a single tagged context block (consumed once per
  // turn). Returns '' when nothing is queued. Total size is capped so a chatty
  // command (`!find /`) cannot blow the context budget.
  function _drainShellEscapeContext() {
    const block = formatShellEscapeContext(_pendingShellEscapes, _SHELL_ESCAPE_CTX_MAX);
    _pendingShellEscapes = [];
    return block;
  }

  // Archive of all pasted content by _pasteCounter, so queued [Pasted text #N] tags
  // can be expanded even after _pendingPaste is consumed or cleared.
  const _pasteArchive = new Map();
  let _pasteCapturing = false; // True while _ttyWrite is accumulating bracketed paste
  // Burst paste detection state (DeepSeek-TUI style, must be outer scope for _clearTransientInputState)
  let _burstLastCharAt = 0;
  let _burstConsecutive = 0;
  let _burstActive = false;
  let _burstBuf = '';
  let _burstWindowUntil = 0;
  let _burstFlushTimer = null;
  let _lastBusyMergeAt = 0;   // Timestamp for busy-state rapid merge
  const BUSY_QUEUE_MERGE_WINDOW_MS = Math.max(100, parseInt(process.env.KHY_BUSY_QUEUE_MERGE_MS || '150', 10));
  let _busyQueueMergeTimer = null; // Timer for deferred busy-queue flush
  let _busyQueueAccum = [];        // Lines accumulating before flush
  const PASTE_TAG_RE = /\[Pasted text #\d+(?:\s\+\d+ lines)?\]\s*/g;
  const PASTE_TAG_WITH_ID_RE = /\[Pasted text #(\d+)(?:\s\+\d+ lines)?\]/g;

  /**
   * Expand any residual [Pasted text #N ...] tags in text by looking up _pasteArchive.
   * Returns the text with tags replaced by actual pasted content wrapped in <pasted-content>.
   */
  function _expandPasteTags(text) {
    if (!text || !_pasteArchive.size) return text;
    return text.replace(PASTE_TAG_WITH_ID_RE, (_m, idStr) => {
      const id = Number(idStr);
      const archived = _pasteArchive.get(id);
      if (archived) {
        return `<pasted-content>\n${archived}\n</pasted-content>`;
      }
      return _m; // No archived content found, leave as-is
    });
  }
  const _featureCapabilityMap = new FeatureCapabilityMap();
  let _taskMindMap = createIdleTaskMindMap(); // Dual maps are always available: AI navigation + user-visible map
  const _taskMindMapAutoShowEnv = String(process.env.KHY_TASK_MINDMAP_AUTO_SHOW || 'false').trim().toLowerCase();
  let _taskMindMapAutoShow = ['1', 'true', 'yes', 'on'].includes(_taskMindMapAutoShowEnv);
  const _intentAssuranceDebugEnv = String(process.env.KHY_INTENT_ASSURANCE_DEBUG || 'false').trim().toLowerCase();
  let _intentAssuranceDebugEnabled = _loadBooleanKhySetting(
    INTENT_ASSURANCE_DEBUG_SETTING_KEY,
    ['1', 'true', 'yes', 'on'].includes(_intentAssuranceDebugEnv),
  );
  process.env.KHY_INTENT_ASSURANCE_DEBUG = _intentAssuranceDebugEnabled ? 'true' : 'false';
  let _lastIntentAssuranceDebug = null;

  // Apply a persisted output style (CC /output-style) into the env so the
  // choice is live from the first turn. An env value set explicitly by the
  // user always wins over the persisted setting.
  try {
    if (!process.env.KHY_OUTPUT_STYLE) {
      const _persistedStyle = _readKhySettings().outputStyle;
      if (_persistedStyle && typeof _persistedStyle === 'string') {
        process.env.KHY_OUTPUT_STYLE = _persistedStyle;
      }
    }
  } catch { /* settings optional */ }

  // REPL-level verbosity tracker — updated by chatFn on each turn so that
  // utility functions outside chatFn scope can check the current level.
  let _currentStatusVerbosity = 'normal';

  function _resetCognitionMapsToStartNode() {
    _featureCapabilityMap.reset();
    _taskMindMap = createIdleTaskMindMap();
  }

  function _initTaskMindMap(inputTitle = '', finalInput = '') {
    try {
      const inferredSteps = extractPlanStepsFromText(finalInput || inputTitle, 8);
      _taskMindMap = createTaskMindMap({
        title: inputTitle,
        userInput: finalInput,
        steps: inferredSteps,
      });
    } catch {
      _taskMindMap = createTaskMindMap({ title: inputTitle || finalInput, userInput: finalInput });
    }
    return _taskMindMap;
  }

  function _renderTaskMindMap(reason = 'status') {
    const renderedAny = _renderCognitionMaps(reason);
    if (!renderedAny) printInfo('认知双图不可用');
    return renderedAny;
  }

  function _renderFeatureCapabilityMap() {
    const c = chalk();
    const lines = _featureCapabilityMap.renderLines();
    lines.forEach((line) => {
      const text = String(line || '');
      if (/^Current Feature:/i.test(text)) {
        console.log(`    ${c.blue(text)}`);
        return;
      }
      if (/^Executable:/i.test(text)) {
        const state = text.split(':').slice(1).join(':').trim().toLowerCase();
        if (state === 'completed') {
          console.log(`    ${c.green(text)}`);
          return;
        }
        if (state === 'blocked') {
          console.log(`    ${c.red(text)}`);
          return;
        }
        if (state === 'running' || state === 'ready' || state === 'delegated') {
          console.log(`    ${c.blue(text)}`);
          return;
        }
      }
      if (/^Reason:/i.test(text) && /error|failed|blocked/i.test(text)) {
        console.log(`    ${c.red(text)}`);
        return;
      }
      console.log(`    ${text}`);
    });
  }

  function _renderTaskMindMapWithColors() {
    if (!_taskMindMap) return;
    try {
      const lines = _taskMindMap.renderColored();
      for (const line of lines) {
        console.log(`    ${line}`);
      }
    } catch {
      // Fallback: plain text rendering if colored rendering fails
      const lines = _taskMindMap.renderLines();
      for (const line of lines) {
        console.log(`    ${line}`);
      }
    }
  }

  function _renderCognitionMaps(reason = 'status') {
    const hasTaskMap = !!_taskMindMap;
    const hasFeatureMap = !!_featureCapabilityMap;
    if (!hasTaskMap && !hasFeatureMap) return false;

    console.log('');
    console.log(c.bold(`  认知双图 (${reason})`));
    console.log(c.dim('    AI 视角: 导航（能力图 + 任务图） | 用户视角: 地图（可随时查看）'));
    if (hasFeatureMap) {
      _renderFeatureCapabilityMap();
    }
    if (hasTaskMap) {
      _renderTaskMindMapWithColors();
    }
    console.log(c.dim('    提示: /mind show | /mind on | /mind off | /mind reset'));
    console.log('');
    return true;
  }

  function _printIntentAssuranceDebugSnapshot(snapshot, reason = 'live') {
    if (!snapshot) {
      printInfo(`暂无意图保护调试快照（自动展示: ${_intentAssuranceDebugEnabled ? '开启' : '关闭'}）`);
      return false;
    }
    const renderer = require('./aiRenderer');
    const sourceLabel = snapshot.source === 'external' ? '外部注入' : '实时提取';
    const targetLabel = snapshot.requestClass || sourceLabel;
    const headline = snapshot.shouldInject
      ? `${sourceLabel} | 已注入保护指令 | 约束 ${snapshot.constraintCount} · 锚点 ${snapshot.detailCount} · 尾部 ${snapshot.tailDetailCount}`
      : `${sourceLabel} | 未额外注入保护指令 | 直接按原始问题处理`;
    renderer.printStepLine(snapshot.shouldInject ? 'active' : 'done', '意图保护', targetLabel, headline);
    renderer.printStepDetail(`主目标: ${snapshot.primaryObjective || snapshot.summary || '未识别'}`, false);
    renderer.printStepDetail(`显式约束: ${snapshot.constraints.length > 0 ? snapshot.constraints.join(' | ') : '无'}`, false);
    renderer.printStepDetail(`细节锚点: ${snapshot.detailAnchors.length > 0 ? snapshot.detailAnchors.join(' | ') : '无'}`, false);
    renderer.printStepDetail(`尾部补充: ${snapshot.tailDetails.length > 0 ? snapshot.tailDetails.join(' | ') : '无'}`);
    if (reason === 'manual') {
      printInfo(`自动展示: ${_intentAssuranceDebugEnabled ? '开启' : '关闭'}`);
    }
    return true;
  }

  function _printTaskMindMapCompact(prefix = 'Task state') {
    if (!_taskMindMap) return;
    // Only show in detailed mode — these are internal diagnostics, not user-facing
    if (_currentStatusVerbosity !== 'detailed') return;
    try {
      const compact = _taskMindMap.getCompactStatus();
      console.log(c.dim(`  · ${prefix}: ${compact}`));
    } catch { /* best effort */ }
  }

  function _printFeatureCapabilityCompact(prefix = 'Feature state') {
    // Only show in detailed mode — these are internal diagnostics, not user-facing
    if (_currentStatusVerbosity !== 'detailed') return;
    try {
      const compact = _featureCapabilityMap.getCompactStatus();
      console.log(c.dim(`  · ${prefix}: ${compact}`));
    } catch { /* best effort */ }
  }

  function _buildTaskMindMapSteerMessage() {
    if (!_taskMindMap) return '';
    try {
      return _taskMindMap.buildAiSteerMessage();
    } catch {
      return '';
    }
  }

  function _buildFeatureCapabilitySteerMessage() {
    try {
      return _featureCapabilityMap.buildAiSteerMessage();
    } catch {
      return '';
    }
  }

  /**
   * Queue input during busy mode with paste merge.
   * Lines arriving within BUSY_QUEUE_MERGE_WINDOW_MS of each other are merged
   * into a single <pasted-content> block instead of creating separate queue
   * entries.  This handles terminals without bracketed paste support (e.g. SSH)
   * where pasted lines arrive as individual readline events spaced >400ms apart.
   */
  // 判定一条(已被 classifier 判为 steer 的)忙碌插话是否其实在「转向新话题」。
  // 复用纯叶子 busyTopicShift(内部用 overlap coefficient 比对包含度);token 由 memdir 的
  // SSOT tokenizer 生成、再经 memoryRecallTokens.enrichTokens 富化 CJK 二元组(缓解单字中文
  // 噪声),对称注入以保持叶子纯净。门控关 / 无基线 / memdir 异常 → 返 false(留 steer)。
  function _isBusyInterjectionNewTopic(interjectionText) {
    try {
      if (!_busyTurnText) return false;
      const memdir = require('../memdir/memdir');
      let enrich = null;
      try { enrich = require('../services/memoryEngine/memoryRecallTokens'); } catch { /* 富化不可用则退回裸 token */ }
      const tok = (t) => {
        const base = memdir._tokenizeForRecall(t);
        return enrich ? enrich.enrichTokens(base, t, process.env) : base;
      };
      return _busyTopicShift.isNewTopicInterjection(tok(interjectionText), tok(_busyTurnText), process.env);
    } catch {
      return false; // fail-soft:判定绝不能拖垮忙碌插话路由
    }
  }

  function _busyQueueWithMerge(text) {
    _busyQueueAccum.push(text);
    _lastBusyMergeAt = Date.now();
    if (_busyQueueMergeTimer) clearTimeout(_busyQueueMergeTimer);
    _busyQueueMergeTimer = setTimeout(() => {
      _busyQueueMergeTimer = null;
      const lines = _busyQueueAccum;
      _busyQueueAccum = [];
      if (lines.length === 0) return;
      if (lines.length === 1) {
        // Single typed line — queue as-is (genuine single-line input during busy)
        _queuedInputs.push(lines[0]);
        const queuePreview = _summarizeQueuedInputForDisplay(lines[0], 40);
        console.log(c.dim(`  ${DOT_PENDING} 已排队: "${queuePreview}" (队列: ${_queuedInputs.length})`));
        console.log(c.dim(`    ${TREE_LAST} AI 完成当前工作后自动处理，/i <内容> 可优先处理，Ctrl+C 可中断`));
        showBusyInterjectPrompt();
      } else {
        // Multiple lines merged — detected as paste.
        // Do NOT auto-queue. Instead, inject into readline as editable tag
        // so the user can add context before pressing Enter.
        const unwrapped = lines.map(l => {
          const m = PASTED_CONTENT_BLOCK_RE.exec(l);
          return m ? m[1] : l;
        });
        const merged = unwrapped.join('\n').trim();
        _storePendingPaste(merged, null, '', false);
      }
    }, BUSY_QUEUE_MERGE_WINDOW_MS);
    // Show immediate feedback for first line
    if (_busyQueueAccum.length === 1) {
      console.log(c.dim(`  ${DOT_PENDING} 输入接收中...（等待更多行以合并粘贴）`));
    }
  }

  // ── Bracketed paste detection ──
  const BRACKETED_PASTE_START = ['\u001b[200~', '[200~', '00~'];
  const BRACKETED_PASTE_END = ['\u001b[201~', '[201~', '01~'];
  const _pasteCapture = { active: false, lines: [] };

  function _consumeBracketedPaste(rawLine) {
    const line = _stripBracketArtifacts(String(rawLine || ''));
    if (!_pasteCapture.active) {
      const start = _findFirstMarker(line, BRACKETED_PASTE_START);
      if (!start || start.idx > 2) {
        return { state: 'normal', text: line };
      }
      const withoutStart = line.slice(0, start.idx) + line.slice(start.idx + start.marker.length);
      const inlineEnd = _findFirstMarker(withoutStart, BRACKETED_PASTE_END);
      if (inlineEnd) {
        const completed = (withoutStart.slice(0, inlineEnd.idx) + withoutStart.slice(inlineEnd.idx + inlineEnd.marker.length)).trim();
        return { state: 'completed', text: completed };
      }
      _pasteCapture.active = true;
      _pasteCapture.lines = [];
      if (withoutStart) _pasteCapture.lines.push(withoutStart);
      return { state: 'capturing', text: '' };
    }

    const end = _findFirstMarker(line, BRACKETED_PASTE_END);
    if (end) {
      const chunk = line.slice(0, end.idx) + line.slice(end.idx + end.marker.length);
      if (chunk) _pasteCapture.lines.push(chunk);
      const completed = _pasteCapture.lines.join('\n').trim();
      _pasteCapture.active = false;
      _pasteCapture.lines = [];
      return { state: 'completed', text: completed };
    }

    _pasteCapture.lines.push(line);
    return { state: 'capturing', text: '' };
  }

  let _pasteCounter = 0; // Running paste ID for display
  const SHORT_PASTE_LINE_THRESHOLD = 5; // ≤ this many lines → show content directly

  function _injectPasteIntoLine(text, rlRef) {
    _pasteCounter++;
    const lineCount = text.split('\n').length; // bare/non-bare 分支判定(lineCount>1 ⟺ CC numLines>0,边界恒等)
    // Claude Code style: [Pasted text #N +M lines] inline in the prompt。
    // M = CC getPastedTextRefNumLines(换行数,"+2 not 3")经 pastedRefLineCountOr;
    // 门控关 → 逐字节回退本处历史的 split('\n').length。
    const _displayLines = require('./pastedRefLines').pastedRefLineCountOr(text, lineCount, process.env);
    const tag = lineCount > 1
      ? `[Pasted text #${_pasteCounter} +${_displayLines} lines]`
      : `[Pasted text #${_pasteCounter}]`;
    // Write the tag into readline's line buffer so user can keep typing after it
    try { rlRef.write(tag); } catch { /* ignore */ }
    return tag;
  }

  /**
   * Store pasted text as _pendingPaste and inject a tag into the prompt.
   * Works the same whether busy or not — user can add context then press Enter.
   *
   * Short pastes (≤ SHORT_PASTE_LINE_THRESHOLD lines): show actual content in
   * readline so user can edit it directly.
   * Long pastes: fold into [Pasted text #N +M lines] tag.
   *
   * @param {string} text - The pasted content
   * @param {Function} writeFn - The _origTtyWrite function (or rl.write fallback)
   * @param {string} [prefix] - Text the user had typed before pasting
   * @param {boolean} [autoCommittedLine] - Whether a trailing newline triggered a line event
   */
  function _storePendingPaste(text, writeFn, prefix, autoCommittedLine, suffix) {
    const lineCount = text.split('\n').length;
    const isShort = lineCount <= SHORT_PASTE_LINE_THRESHOLD && text.length <= 500;

    if (isShort) {
      // Short paste — show content directly in readline for inline editing
      _pendingPaste = null; // No need for pending — content is visible
      _pendingPasteTag = '';
      _pendingPasteSkipNextEmptySubmit = false;
      _pendingPasteHintedAt = 0;
      try { rl.write(null, { ctrl: true, name: 'u' }); } catch { rl.line = ''; rl.cursor = 0; }
      if (prefix) {
        try { (writeFn || rl.write.bind(rl))(prefix, undefined); } catch { /* ignore */ }
      }
      // Write the actual paste content into readline
      const singleLine = text.replace(/\n/g, '  ');
      try { (writeFn || rl.write.bind(rl))(singleLine, undefined); } catch { /* ignore */ }
      // Restore text that was after cursor before paste
      if (suffix) {
        try { (writeFn || rl.write.bind(rl))(suffix, undefined); } catch { /* ignore */ }
      }
      return;
    }

    // Long paste — fold into tag (Claude Code style)
    _pendingPaste = text;
    _pendingPasteSkipNextEmptySubmit = !!autoCommittedLine;
    _pendingPasteHintedAt = 0;
    _pendingPasteSetAt = Date.now();
    _pasteCounter++;
    _pasteArchive.set(_pasteCounter, text); // Archive for later expansion
    // Prevent unbounded growth: keep only last 20 entries
    if (_pasteArchive.size > 20) {
      const oldest = _pasteArchive.keys().next().value;
      _pasteArchive.delete(oldest);
    }
    const tag = lineCount > 1
      ? `[Pasted text #${_pasteCounter} +${require('./pastedRefLines').pastedRefLineCountOr(text, lineCount, process.env)} lines]`
      : `[Pasted text #${_pasteCounter}]`;
    _pendingPasteTag = tag;
    try { rl.write(null, { ctrl: true, name: 'u' }); } catch { rl.line = ''; rl.cursor = 0; }
    if (prefix) {
      try { (writeFn || rl.write.bind(rl))(prefix, undefined); } catch { /* ignore */ }
    }
    try { (writeFn || rl.write.bind(rl))(tag, undefined); } catch { /* ignore */ }
    // Restore text that was after cursor before paste
    if (suffix) {
      try { (writeFn || rl.write.bind(rl))(suffix, undefined); } catch { /* ignore */ }
    }
    if (_busy) {
      // Show hint so user knows they can add context
      console.log(c.dim(`  ↳ 已折叠粘贴 ${lineCount} 行，输入提示词后回车发送（将排队等待处理）`));
    }
  }

  function _shouldBatchInputLine(lineText = '') {
    if (INPUT_BATCH_MODE === 'always') return true;
    if (INPUT_BATCH_MODE === 'off') return false;
    // Auto mode is only meaningful in a live TTY. In tests and non-interactive
    // environments we already receive complete lines, so forcing a timer-based
    // re-emit adds latency and can delay deterministic local fast paths.
    if ((process.stdin && process.stdin.isTTY) !== true || (process.stdout && process.stdout.isTTY) !== true) {
      return false;
    }
    // In an interactive terminal, the 90ms (idle) / 400ms (busy) window lets
    // us detect multi-line paste before the first line gets executed. Single
    // lines that don't receive a follow-up within the window are re-emitted as
    // normal input — the only cost is a barely perceptible short delay.
    return true;
  }

  function _scheduleInputBatch(lineText, rlRef) {
    _inputBatchLines.push(String(lineText || ''));
    if (_inputBatchTimer) clearTimeout(_inputBatchTimer);
    const batchWindowMs = _busy ? INPUT_BUSY_BATCH_WINDOW_MS : INPUT_BATCH_WINDOW_MS;
    _inputBatchTimer = setTimeout(() => {
      const merged = _inputBatchLines.join('\n').trim();
      const batchCount = _inputBatchLines.length;
      _inputBatchLines = [];
      _inputBatchTimer = null;
      if (!merged) {
        try { rlRef.prompt(); } catch { /* ignore */ }
        return;
      }
      // Single short line — pass through directly (busy: queue, not busy: emit)
      if (batchCount === 1 && merged.length < 180) {
        if (_busy) {
          _busyQueueWithMerge(merged);
        } else {
          const savedOutput = rlRef.output;
          try {
            rlRef.output = null;
            rlRef.emit('line', `${INTERNAL_LINE_PREFIX}${merged}`);
          } finally {
            rlRef.output = savedOutput;
          }
        }
        return;
      }
      // Multi-line or long content — detected as paste.
      // Use _storePendingPaste: inject tag, let user add context, Enter to send.
      _storePendingPaste(merged, null, '', false);
    }, batchWindowMs);
  }

  function _clearTransientInputState(rlRef) {
    if (_inputBatchTimer) {
      clearTimeout(_inputBatchTimer);
      _inputBatchTimer = null;
    }
    _inputBatchLines = [];
    if (_busyQueueMergeTimer) {
      clearTimeout(_busyQueueMergeTimer);
      _busyQueueMergeTimer = null;
    }
    _busyQueueAccum = [];
    // Clear raw paste detection state
    _rawPasteActive = false;
    _rawPasteBuf = [];
    if (_rawPasteTimer) { clearTimeout(_rawPasteTimer); _rawPasteTimer = null; }
    // Clear burst paste detection state
    _burstActive = false;
    _burstBuf = '';
    _burstConsecutive = 0;
    _burstLastCharAt = 0;
    _burstWindowUntil = 0;
    if (_burstFlushTimer) { clearTimeout(_burstFlushTimer); _burstFlushTimer = null; }
    _pendingPaste = null;
    _pendingPasteTag = '';
    _pendingPasteSkipNextEmptySubmit = false;
    _pendingPasteHintedAt = 0;
    _pendingPasteSetAt = 0;
    _pasteCapturing = false;
    _pasteCapture.active = false;
    _pasteCapture.lines = [];
    _busyTypingUntil = 0;
    try { rlRef.write(null, { ctrl: true, name: 'u' }); } catch { rlRef.line = ''; }
  }

  // ESC / 用户中断 → 取消执行中的工具:本轮 tool-use loop 的 abort controller(仅当门控
  // KHY_TOOL_ABORT_SIGNAL 开时创建,见 loopOptions 处)。_requestRelayCancel 一并 abort 它,
  // 使在途工具(长搜索/抓取/DB)立即松手、loop 迭代间断开本轮,而不必苦等工具 120s 硬超时。
  let _activeToolLoopAbort = null;

  function _requestRelayCancel(reason = 'Interrupted by user input') {
    let cancelled = false;
    try {
      if (_activeToolLoopAbort) { _activeToolLoopAbort.abort(reason); cancelled = true; }
    } catch { /* non-critical */ }
    try {
      const aiMod = ai();
      if (aiMod && typeof aiMod.cancelActiveRequest === 'function') {
        cancelled = !!aiMod.cancelActiveRequest(reason) || cancelled;
      }
    } catch { /* non-critical */ }
    try {
      const gateway = require('../services/gateway/aiGateway');
      const relay = gateway.getRelayAdapter();
      if (relay && typeof relay.cancelPending === 'function') {
        cancelled = !!relay.cancelPending(reason) || cancelled;
      }
    } catch { /* non-critical */ }
    return cancelled;
  }

  // 忙碌态中断逃生阀:在 _busy 状态下每次收到 Ctrl+C / Esc 时调用。返回 true 表示本次已升级为
  // 强制退出(调用方应立即 return,不再走优雅取消);返回 false 表示这是序列中的第 1 次(或门控关),
  // 调用方照常执行优雅取消。门控 KHY_BUSY_FORCE_EXIT 关 → 恒返 false → 逐字节回退到「只优雅取消」。
  function _maybeForceExitOnBusyInterrupt(sourceLabel) {
    try {
      if (!_busyInterruptEscalation.busyForceExitEnabled(process.env)) return false;
      const threshold = _busyInterruptEscalation.resolveThreshold(process.env);
      const windowMs = _busyInterruptEscalation.resolveWindowMs(process.env);
      _busyInterruptState = _busyInterruptEscalation.nextBusyInterruptState(
        _busyInterruptState, Date.now(), { threshold, windowMs },
      );
      if (!_busyInterruptState.shouldForceExit) return false;
    } catch { return false; } // 决策叶子异常 → 保守回退到优雅取消,绝不误杀

    // 逃生阀触发:优雅取消没能停下本轮 → 保存后强制退出(exit 130 = 标准 SIGINT 退出码)。
    try { _requestRelayCancel(`Force-exit via ${sourceLabel}`); } catch { /* best effort */ }
    let savedMeta = null;
    try { savedMeta = ai().saveConversation(); } catch { /* best effort */ }
    try { saveHistory(history); } catch { /* best effort */ }
    try { setTerminalTitle(''); } catch { /* best effort */ }
    try {
      leaveInputPromptFrame();
      console.log('');
      console.log(c.hex('#FF5252')(`  ${MASCOT_MINI} 已强制结束卡住的会话并退出 KHY`));
      printResumeRecoveryHints(savedMeta);
      printInterruptedTaskHint();
      console.log('');
    } catch { /* best effort — never block the hard exit on rendering */ }
    try { _uninstallBusyPromptConsolePatch(); } catch { /* best effort */ }
    _intentionalExit = true;
    process.exit(130);
    return true; // unreachable, kept for control-flow clarity
  }

  // 图片分析等非流式 ai().chat 子流的首响应守护(image 变体)。这些子流走
  // `await ai().chat(prompt,{images})`,无 onChunk 流、无 markChunk——只一个长 await,期间交互
  // raw-mode 终端全静默(spinner 被 render-suppress),视觉级联(vision→OCR)最耗时最像卡死。
  // arm 于 await 前,返回句柄由调用方在 await 完成/异常处 disarm;delay 内答复仍未落地 → emit
  // 「收到你的图片,正在识别分析…」(既补窗口又即时确认图片已收到,反驳偶发「没收到图片」假阴性)。
  // 门控关(父门/子门)/叶缺失/异常 → 返回 null(逐字节回退无提示)。绝不抛。
  function _armImageAck() {
    try {
      if (!_firstResponseAckVoice
        || typeof _firstResponseAckVoice.createFirstResponseAckScheduler !== 'function') return null;
      const s = _firstResponseAckVoice.createFirstResponseAckScheduler({
        turnIndex: (_replTurnAckSeq++),
        env: process.env,
        variant: 'image',
        deps: {
          emit: (line) => {
            if (!line) return;
            try { require('./aiRenderer').printStepDetail(line); } catch { /* 渲染失败不影响主流程 */ }
          },
        },
      });
      s.arm();
      return s;
    } catch { return null; }
  }

  rl.on('line', async (line) => {
    _setLiveHudWorkingMode();
    // TUI bridge: record input submission (best-effort)
    try { if (_tuiCtrl) _tuiCtrl.recordInputSubmit(line); } catch { /* */ }
    // Clean up slash picker if still rendered (safety net)
    if (_slashPickerActive || _slashRenderedLines > 0) {
      _clearSlashPicker();
      _slashPickerActive = false;
    }
    // Clean up @ file picker if still rendered (safety net)
    if (_atPickerActive || _atRenderedLines > 0) {
      _clearAtPicker();
      _atPickerActive = false;
    }
    // When input frame is active the cursor sits inside a 3-line decoration
    // (top rule → prompt → bottom rule + footer).  readline's built-in echo
    // prints the entered text at the prompt line and then moves the cursor
    // down into the decoration area.  If we only clearLine at the current
    // position, the original echo remains visible above → duplicate input.
    //
    // Fix: when the frame was rendered, move cursor to the prompt line first,
    // wipe everything from there downward (kills both the echo ghost AND the
    // decoration remnants), then reprint a clean "> {input}" line.
    const isInternalLine = typeof line === 'string' && line.startsWith(INTERNAL_LINE_PREFIX);
    const lineBody = isInternalLine ? line.slice(INTERNAL_LINE_PREFIX.length) : line;
    const shouldEchoInternalLine = isInternalLine && /^\/[^\n\r]*$/.test(String(lineBody || ''));
    let echoLineBody;
    if (!isInternalLine || shouldEchoInternalLine) {
      echoLineBody = lineBody;
    } else if (isInternalLine && lineBody) {
      // Show a single-line summary of pasted/batched content instead of blank
      const flat = String(lineBody).replace(/\n/g, ' ').trim();
      echoLineBody = flat.length > 120 ? flat.slice(0, 117) + '...' : flat;
    } else {
      echoLineBody = '';
    }
    if (process.stdout.isTTY && _frameRendered) {
      try {
        // Calculate how many visual rows the input + bottom decoration occupy.
        // After Enter, readline moves cursor past the prompt line. We need to
        // jump back up over prompt rows and also clear the frame's top rule,
        // so assistant output is never visually enclosed by the input frame.
        const inputRows = _inputVisualRows();
        const linesUp = Math.max(2, inputRows + 1);
        const echoLine = `${_getPlainPrompt()}${echoLineBody}`;
        process.stdout.write(`\x1b[${linesUp}A\x1b[1G\x1b[J${echoLine}\n`);
      } catch { /* ignore */ }
      _frameRendered = false;
    } else if (process.stdout.isTTY) {
      try {
        process.stdout.write('\x1b[2K\x1b[1G'); // clear line + cursor to col 1
      } catch { /* ignore */ }
    }
    _busyPromptVisible = false;
    line = isInternalLine ? line.slice(INTERNAL_LINE_PREFIX.length) : line;

    // Guard against nested inquirer prompts from external handlers (e.g. gateway/model).
    // Without this, Enter/leftover input can leak into the main REPL line handler.
    const _externalInquirerActive = global.__KHY_INQUIRER_ACTIVE__ === true;
    if (!isInternalLine && (_inquirerActive || _externalInquirerActive)) {
      return;
    }

    // ── Suppress ghost line events during _ttyWrite bracketed paste capture ──
    // When _ttyWrite intercepts \x1b[200~ and starts capturing, readline still
    // emits line events for each \n in the paste.  These lines are fragments
    // that must NOT be executed or queued — _ttyWrite's _finishPasteCapture
    // will handle the full paste once the end marker arrives.
    if ((_pasteCapturing || _burstActive) && !isInternalLine) {
      return;
    }

    // ── Bracketed paste detection ──
    if (!isInternalLine) {
      const pasteState = _consumeBracketedPaste(line);
      if (pasteState.state === 'capturing') return;
      if (pasteState.state === 'completed') {
        if (!pasteState.text) { rl.prompt(); return; }
        // Unified: store pending + inject tag (or show directly if short)
        _storePendingPaste(pasteState.text, null, '', true);
        return;
      }
      line = pasteState.text; // cleaned text for normal processing
    }

    const trimmed = (isInternalLine ? lineBody : line).trim();

    // ── Flush pending paste: merge with any supplement the user typed ──
    // Same flow for busy and non-busy: user can add context, then Enter to send.
    if (_pendingPaste !== null && !isInternalLine) {
      // Strip the [Pasted text ...] tag from readline's line to get only the supplement
      const supplement = trimmed.replace(PASTE_TAG_RE, '').trim();
      if (!supplement) {
        // Empty submit — auto-committed newlines from paste often arrive as
        // ghost Enter events.  Suppress any empty submit within 600ms of
        // _storePendingPaste setting the pending state.
        const msSincePaste = Date.now() - _pendingPasteSetAt;
        if (msSincePaste < 600) {
          // Ghost Enter from paste tail — suppress silently, re-inject tag
          try {
            rl.write(null, { ctrl: true, name: 'u' });
            if (_pendingPasteTag) rl.write(_pendingPasteTag);
          } catch { /* ignore */ }
          if (_busy) showBusyInterjectPrompt();
          else rl.prompt();
          return;
        }
        // User deliberately pressed Enter on empty tag — show hint once,
        // then on second press flush.
        if (_pendingPasteSkipNextEmptySubmit) {
          _pendingPasteSkipNextEmptySubmit = false;
          const now = Date.now();
          if (now - _pendingPasteHintedAt > 1200) {
            if (_busy) {
              printInfo('已折叠粘贴素材：按回车发送（排队），或补充意图后回车');
            } else {
              printInfo('已折叠粘贴素材：按回车发送，或继续补充意图后回车');
            }
            _pendingPasteHintedAt = now;
          }
          try {
            rl.write(null, { ctrl: true, name: 'u' });
            if (_pendingPasteTag) rl.write(_pendingPasteTag);
            else _pendingPasteTag = _injectPasteIntoLine(_pendingPaste, rl) || '';
          } catch { /* ignore */ }
          if (_busy) showBusyInterjectPrompt();
          else rl.prompt();
          return;
        }
      }
      const paste = _pendingPaste;
      _pendingPaste = null;
      _pendingPasteTag = '';
      _pendingPasteSkipNextEmptySubmit = false;
      _pendingPasteHintedAt = 0;
      _pendingPasteSetAt = 0;
      // Wrap paste in markers so downstream (e.g. complexity assessment) can
      // distinguish pasted context from the user's actual instruction.
      const wrappedPaste = `<pasted-content>\n${paste}\n</pasted-content>`;
      const finalText = supplement ? wrappedPaste + '\n' + supplement : wrappedPaste;
      rl.emit('line', `${INTERNAL_LINE_PREFIX}${finalText}`);
      return;
    }

    if (!isInternalLine && isArrowEscapeLine(line)) {
      rl.prompt();
      return;
    }

    // ── `!` shell escape — run a shell command now, feed output into context.
    // Handled before slash/batch/AI dispatch so `!dir` never reaches the model
    // as a prompt. Single leading `!` + a command; bare `!` shows usage.
    if (!isInternalLine && trimmed.startsWith('!') && trimmed.length > 1) {
      const shellCmd = trimmed.slice(1).trim();
      if (!shellCmd) {
        printInfo('用法: !<shell 命令>  例如 !dir / !git status —— 直接运行并把输出带进对话上下文');
        rl.prompt();
        return;
      }
      if (_busy) {
        printInfo('! shell 转义仅在空闲时可用（AI 正在工作）。可先 Ctrl-C 或等本轮结束再用。');
        showBusyInterjectPrompt();
        return;
      }
      leaveInputPromptFrame();
      try {
        _enqueueShellEscapeContext(await _runShellEscape(shellCmd));
      } catch (err) {
        printError(`shell 转义执行失败: ${err && err.message ? err.message : err}`);
      }
      rl.prompt();
      return;
    }

    // Merge rapid multi-line paste into a single request before execution.
    // Also merge when busy — pasted content should not be sent line-by-line.
    if (!isInternalLine && !trimmed.startsWith('/') && _shouldBatchInputLine(line)) {
      _scheduleInputBatch(line, rl);
      return;
    }

    if (!trimmed) {
      if (_busy) {
        const now = Date.now();
        if (now - _lastBusyEnterHintAt > 1200) {
          console.log(c.dim(`  ↳ AI 请求执行中（${ai().getActiveProvider() || 'AI'}）：输入内容后回车可排队，/i <内容> 可优先处理`));
          _lastBusyEnterHintAt = now;
        }
        showBusyInterjectPrompt();
        return;
      }
      // Empty line: check if clipboard has image data (user may have tried to
      // right-click paste an image but got nothing because clipboard only has
      // image/png without text/plain — common on Linux with screenshot tools
      // and image viewers like eog).
      try {
        const imageService = require('../services/imageService');
        if (imageService.isClipboardImageAvailable()) {
          const renderer = require('./aiRenderer');
          console.log(c.cyan('  ℹ 检测到剪贴板中有图片数据'));
          console.log(c.dim('    输入分析提示后回车，或直接回车使用默认提示'));
          console.log(c.dim('    示例: 分析这张图片 / describe this image'));
          rl.setPrompt(c.cyan('  图片提示❯ '));
          rl.prompt();
          // One-shot handler: next line input triggers clipboard image analysis
          const _onceImagePrompt = async (imgLine) => {
            rl.removeListener('line', _onceImagePrompt);
            const imgPrompt = String(imgLine || '').trim() || '请分析这张图片的内容';
            let _imgAck = null; // 声明于 try 前,使 finally 可见(承 holder-before-try 教训)
            try {
              const readStart = Date.now();
              const image = imageService.readImageFromClipboard();
              renderer.printToolCallResult('Clipboard', 'clipboard', 'success',
                `${image.format.toUpperCase()}, ${_formatImageSize(image.sizeBytes)}`,
                Date.now() - readStart
              );
              imageService.printImagePreview(image);
              _busy = true;
              _startBusyPromptKeepalive();
              _imgAck = _armImageAck(); // 图片非流式 await 前武装首响应守护
              const aiResult = await ai().chat(
                buildContextualImagePrompt(imgPrompt, buildImageSceneHint('clipboard paste image', history)),
                { images: [{ base64: image.base64, mimeType: image.mimeType }] },
              );
              if (aiResult.reply) {
                if (aiResult.errorType) {
                  _renderAiErrorCompact(aiResult.reply);
                  printInfo('提示: 可用 /model 切换到支持视觉的模型后重试');
                } else {
                  renderer.printStepLine('success', 'AI 图片分析', aiResult.provider || 'vision');
                  renderer.renderAiResponse(aiResult.reply).split('\n').forEach(l => console.log(`  ${l}`));
                }
              } else {
                printInfo('AI 未返回分析结果');
              }
              console.log('');
            } catch (e) {
              // 刀107:图像粘贴 chat() 子流的 abort 兜底,补记中断标记(承刀106,收敛 ESC 面剩余子流)。
              // ESC/Ctrl+C → 网关 AbortError(name==='AbortError'/code==='ABORT_ERR')冒泡到此本地
              // catch;chat() 已跳过结尾 assistant push → 悬空 user 无标记。仅 abort 记,真图片处理
              // 错误不误记「用户已中断」;partial 在此作用域不可达 → 仅记标记。门控/竞态守卫由
              // ai.recordInterruption 内部保证(关→no-op 逐字节回退)。fail-soft 不影响下方错误呈现。
              try {
                if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) ai().recordInterruption('');
              } catch { /* best effort */ }
              printError(`图片处理失败: ${e.message}`);
            } finally {
              try { if (_imgAck) _imgAck.disarm(); } catch { /* 守护解除失败不影响主流程 */ }
              _busy = false;
            }
            rl.setPrompt(_getPlainPrompt());
            rl.prompt();
          };
          rl.on('line', _onceImagePrompt);
          return;
        }
      } catch { /* clipboard check failed, ignore */ }
      // Empty line: just re-prompt without re-rendering decorations
      _setLiveHudTypingMode();
      rl.setPrompt(_getPlainPrompt());
      _origPrompt();
      return;
    }

    if (!_busy && /^\/(?:err|error|last-error)$/i.test(trimmed)) {
      _printLastAiError();
      rl.prompt();
      return;
    }

    // Non-empty input: clear frame so decorations re-render after processing
    if (!_busy) leaveInputPromptFrame();

    // Busy-safe slash menu: show commands without interactive dropdown, keep stream stable.
    if (_busy && trimmed === '/') {
      const now = Date.now();
      if (now - _lastBusyEnterHintAt > 1200) {
        showBusySlashMenu();
        _lastBusyEnterHintAt = now;
      }
      showBusyInterjectPrompt();
      return;
    }

    // Bare "/" — picker handles it in real-time via _ttyWrite. If user somehow
    // presses Enter on bare "/", just re-prompt.
    if (trimmed === '/' && !isInternalLine) {
      rl.prompt();
      return;
    }

    // Slash command dispatch — handles picker selections (internal lines) and
    // directly typed commands like "/plan", "/model", etc.
    //
    // flag-slash 带参路由修复（门控 KHY_FLAG_SLASH_ARG_FIX，默认开）：**只含 flag、无 route**
    // 的开关型 slash 命令若带参输入（`/thinking on`、`/plan on`），会被下方 `!/^\/\w+\s/` 守卫
    // 排除出拦截器 → 落到 :5294 通用路由 → route() 返 false → 误当 AI 消息转发（用户痛点
    // 「这命令不对那个部队的」）。对齐 TUI（App.js:851 handleFlag 先读 parsed.flag）：带参
    // flag-only 命令按**命令 token**进入本拦截器、复用同一 flag switch（开关型忽略参数，
    // 与裸命令行为一致）。**只放行 flag-only**：带 route 的命令（/model gpt-4）仍走通用路由
    // 以保留其参数。门控关 → `_flagArgEntry` 恒 null → 逐字节回退今日守卫。
    let _flagArgEntry = null;
    {
      const _off = ['0', 'false', 'off', 'no', 'disable', 'disabled'];
      const _fixOn = !_off.includes(String(process.env.KHY_FLAG_SLASH_ARG_FIX || '').trim().toLowerCase());
      if (_fixOn && trimmed.startsWith('/') && /^\/\w+\s+\S/.test(trimmed)) {
        const _tok = '/' + trimmed.slice(1).split(/\s+/)[0].toLowerCase();
        const _cand = _getSlashCommands().find((sc) => sc && typeof sc.cmd === 'string' && sc.cmd.toLowerCase() === _tok);
        if (_cand && _cand.flag && !_cand.route) _flagArgEntry = _cand;
      }
    }
    // 用户自建技能(~/.khy/skills)命令识别——无论是否带参、命令名长短,只要 token 命中
    // 一个已发现的技能斜杠命令(带 _skillDir)即进入统一派发。门控 KHY_USER_SKILL_MENU 关时
    // listUserSkillCommands 返 [] → _getSlashCommands 不含 _skillDir 项 → _skillEntry 恒 null,
    // 逐字节回退今日行为(技能命令落到通用路由/AI 消息)。
    let _skillEntry = null;
    let _skillArgText = '';
    if (trimmed.startsWith('/') && trimmed.length > 1) {
      const _stok = '/' + trimmed.slice(1).split(/\s+/)[0];
      const _scand = _getSlashCommands().find((sc) => sc && sc._skillDir && sc.cmd === _stok);
      if (_scand) {
        _skillEntry = _scand;
        _skillArgText = trimmed.slice(trimmed.indexOf(_stok) + _stok.length).trim();
      }
    }
    // Claude Code 自定义斜杠命令(~/.claude/commands)识别——与技能同构:token 命中一个带
    // _commandFile 的已发现 CC 命令即进入统一派发。门控 KHY_CC_COMMAND_BRIDGE 关时
    // listCcCommands 返 [] → _getSlashCommands 不含 _commandFile 项 → _ccEntry 恒 null,
    // 逐字节回退今日行为(命令落到通用路由/AI 消息)。
    let _ccEntry = null;
    let _ccArgText = '';
    if (!_skillEntry && trimmed.startsWith('/') && trimmed.length > 1) {
      const _ctok = '/' + trimmed.slice(1).split(/\s+/)[0];
      const _ccand = _getSlashCommands().find((sc) => sc && sc._commandFile && sc.cmd === _ctok);
      if (_ccand) {
        _ccEntry = _ccand;
        _ccArgText = trimmed.slice(trimmed.indexOf(_ctok) + _ctok.length).trim();
      }
    }
    if (_flagArgEntry || _skillEntry || _ccEntry || (trimmed.startsWith('/') && trimmed.length > 1 && trimmed.length <= 16 && !/^\/\w+\s/.test(trimmed))) {
      const cmds = _getSlashCommands();
      const selected = _flagArgEntry || _skillEntry || _ccEntry || cmds.find(sc => sc.cmd === trimmed);
      if (selected) {
        try {
          if (selected._skillDir) {
            // 用户自建技能:读该技能 prompt.md(回退 SKILL.md)正文,与本次参数拼成一条
            // 普通消息,经内部行重放喂进主 agentic 通道(与用户直接输入等效)。缺 prompt.md →
            // 明确提示而非静默无反应(用户痛点:khy 说建好了但 /x 敲了没动静)。
            const { loadUserSkillPrompt } = require('./repl/userSkillCommands');
            let _skillPrompt = null;
            try { _skillPrompt = loadUserSkillPrompt(selected._skillDir); } catch { _skillPrompt = null; }
            if (!_skillPrompt) {
              printError(`技能 ${selected.cmd} 缺少 prompt.md,无法执行`);
              printInfo(`请在 ${selected._skillDir} 下补全 prompt.md(或 SKILL.md)后重试`);
            } else {
              const _composed = _skillArgText
                ? `${_skillPrompt}\n\n${_skillArgText}`
                : _skillPrompt;
              printInfo(`已载入技能 ${selected.label || selected.cmd}${_skillArgText ? '(附带参数)' : ''}`);
              // 让当前 line 处理干净收尾后再重放,避免同步重入 rl.on('line')。
              recoverReadlineInput();
              rl.prompt();
              setImmediate(() => {
                try { rl.emit('line', `${INTERNAL_LINE_PREFIX}${_composed}`); } catch { /* best effort */ }
              });
              return;
            }
          } else if (selected._commandFile) {
            // Claude Code 自定义斜杠命令:读命令文件正文(剥离 frontmatter),兑现
            // $ARGUMENTS / $1..$9 占位符(CC 语义),拼成一条普通消息经内部行重放喂进主
            // agentic 通道(与用户直接输入等效)。文件缺失/空 → 明确提示而非静默无反应。
            const { loadCcCommandBody, renderCcCommandBody } = require('./repl/ccUserCommands');
            let _ccBody = null;
            try { _ccBody = loadCcCommandBody(selected._commandFile); } catch { _ccBody = null; }
            if (!_ccBody) {
              printError(`命令 ${selected.cmd} 的定义文件缺失或为空,无法执行`);
              printInfo(`请检查 ${selected._commandFile}`);
            } else {
              let _ccComposed = _ccBody;
              try { _ccComposed = renderCcCommandBody(_ccBody, _ccArgText); } catch { _ccComposed = _ccBody; }
              printInfo(`已载入命令 ${selected.label || selected.cmd}${_ccArgText ? '(附带参数)' : ''}`);
              recoverReadlineInput();
              rl.prompt();
              setImmediate(() => {
                try { rl.emit('line', `${INTERNAL_LINE_PREFIX}${_ccComposed}`); } catch { /* best effort */ }
              });
              return;
            }
          } else if (selected.flag) {
            // Handle special flags
            if (selected.flag.startsWith('effort-')) {
              const level = selected.flag.replace('effort-', '');
              if (ai().setEffort(level)) {
                const presets = ai().getEffortPresets();
                const p = presets[level];
                printSuccess(`模型精度已切换: ${level} (${p.label}) — temp=${p.temperature}, maxTokens=${p.maxTokens}`);
              }
            } else if (selected.flag === 'thinking') {
              const aiMod = ai();
              const nowEnabled = !aiMod.isThinkingEnabled();
              aiMod.setThinkingEnabled(nowEnabled);
              if (nowEnabled) {
                printSuccess('扩展思考已开启 — 模型将产出推理（DeepSeek 自动切 R1），实时显示后折叠');
              } else {
                printInfo('扩展思考已关闭 — 跳过推理请求（DeepSeek 用 V3），省时延与 token');
              }
            } else if (selected.flag === 'plan') {
              _planMode = true;
              printInfo('计划模式已开启 — AI 将先规划再执行');
            } else if (selected.flag === 'vim') {
              if (_vimHandler && _vimHandler.isActive()) {
                _vimHandler.disable();
                _vimHandler = null;
                vimSettings().setEditorMode('normal');
                printSuccess('Vim 模式已关闭');
              } else {
                if (!_vimHandler) {
                  _vimHandler = vimInput().createVimInputHandler(rl, {
                    enabled: true,
                    prompt: buildCwdPrompt(),
                  });
                } else {
                  _vimHandler.enable();
                }
                vimSettings().setEditorMode('vim');
                printSuccess('Vim 模式已开启 — Esc 进入 NORMAL，i 进入 INSERT');
              }
            } else if (selected.flag === 'voice') {
              try {
                const voiceService = require('../services/voiceService');
                const settings = voiceService.getVoiceSettings();
                if (settings.enabled) {
                  voiceService.setVoiceEnabled(false);
                  voiceService.stopSpeaking();
                  printSuccess('语音模式已关闭');
                } else {
                  const caps = voiceService.getCapabilities();
                  voiceService.setVoiceEnabled(true);
                  printSuccess(`语音模式已开启 — TTS: ${caps.tts || 'none'} | STT: ${caps.stt || 'none'}`);
                }
              } catch (err) {
                printError(`语音服务异常: ${err.message}`);
              }
            } else if (selected.flag === 'image') {
              printInfo('用法: image <文件路径> <分析提示>  或  paste <分析提示>');
              printInfo('示例: image ./landing.png 还原这个网页为可运行 HTML');
            } else if (selected.flag === 'paste') {
              let _imgAck = null; // 声明于 try 前,使 catch/成功两处 disarm 可见
              try {
                const imageService = require('../services/imageService');
                const renderer = require('./aiRenderer');
                const { prompt: userPrompt } = await inqPrompt([{
                  type: 'input', name: 'prompt', message: '图片分析提示:',
                  default: '请分析这张图片',
                }]);
                const readStart = Date.now();
                const image = imageService.readImageFromClipboard();
                renderer.printToolCallResult('Clipboard', 'clipboard', 'success',
                  `${image.format.toUpperCase()}, ${_formatImageSize(image.sizeBytes)}`,
                  Date.now() - readStart
                );
                imageService.printImagePreview(image);
                _busy = true;
                _startBusyPromptKeepalive();
                const prompt = buildContextualImagePrompt(
                  userPrompt,
                  buildImageSceneHint('clipboard paste image', history),
                );
                _imgAck = _armImageAck(); // 图片非流式 await 前武装首响应守护
                const aiResult = await ai().chat(prompt, {
                  images: [{ base64: image.base64, mimeType: image.mimeType }],
                });
                if (aiResult.reply) {
                  renderer.printStepLine('success', 'AI 图片分析', aiResult.provider || 'vision');
                  const rendered = renderer.renderAiResponse(aiResult.reply);
                  rendered.split('\n').forEach(l => console.log(`  ${l}`));
                } else {
                  printInfo('AI 未返回分析结果 — 当前提供方可能不支持视觉能力');
                }
                try { if (_imgAck) _imgAck.disarm(); } catch { /* 守护解除失败不影响主流程 */ }
                _busy = false;
              } catch (e) {
                try { if (_imgAck) _imgAck.disarm(); } catch { /* 守护解除失败不影响主流程 */ }
                _busy = false;
                // 刀107:同上——图像粘贴 chat() 子流 abort 兜底,补记中断标记(仅 abort·fail-soft)。
                try {
                  if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) ai().recordInterruption('');
                } catch { /* best effort */ }
                printError(`读取剪贴板图片失败: ${e.message}`);
                printInfo('请确认剪贴板中包含图片数据');
              }
            } else if (selected.flag === 'clipboard') {
              try {
                const clipAdapter = require('../services/gateway/adapters/clipboardRelayAdapter');
                const status = clipAdapter.getStatus();
                if (status.available) {
                  printSuccess(status.detail);
                } else {
                  printError(status.detail);
                }
                try {
                  const clipBridge = require('../services/windowsClipboardImg2FileService');
                  const bridgeStatus = clipBridge.getClipboardImg2FileBridgeStatus();
                  if (bridgeStatus.supported) {
                    if (bridgeStatus.running) {
                      const poll = bridgeStatus.meta?.pollMs || 500;
                      printSuccess(`图片粘贴桥接运行中（轮询 ${poll}ms，PID ${bridgeStatus.pid}）`);
                    } else if (!bridgeStatus.enabled) {
                      printInfo('图片粘贴桥接已禁用（环境变量 KHY_CLIPBOARD_IMG2FILE_ENABLED=false）');
                    } else {
                      printInfo('图片粘贴桥接未启动，可运行: clipboard bridge start');
                    }
                  }
                } catch {
                  // best effort
                }
                printInfo('用法: clipboard relay <提示>  或  webai <提示>');
                printInfo('管理: clipboard relay list / set <服务> / open');
                printInfo('图片粘贴桥接: clipboard bridge [status|start|stop|restart]');
              } catch (e) {
                printError(`剪贴板中继不可用: ${e.message}`);
              }
            } else if (selected.flag === 'websearch') {
              try {
                const webSearch = require('../services/webSearchService');
                if (!webSearch.isAvailable()) printInfo('未检测到 Kiro 认证，自动使用回退搜索');
                const { query } = await inqPrompt([{
                  type: 'input', name: 'query', message: '搜索关键词:',
                  validate: v => v.trim() ? true : '请输入搜索关键词',
                }]);
                printInfo(`正在搜索: ${query}`);
                const result = await webSearch.search(query);
                if (result.success) {
                  const digest = webSearch.digestResults(result.results || [], { limit: 10, perGroup: 5 });
                  console.log('');
                  console.log(c.bold.cyan(`  搜索结果（已整理 ${digest.total} 条，按来源分组）`));
                  console.log(c.dim('  ─'.repeat(30)));
                  if (digest.total === 0) {
                    console.log(c.dim('\n  未找到相关结果。\n'));
                  }
                  let n = 0;
                  for (const g of digest.groups) {
                    console.log('');
                    console.log(c.bold.white(`  【${g.label}】`));
                    for (const r of g.items) {
                      n += 1;
                      console.log(c.white(`    ${n}. ${r.title}`) + (r.domain ? c.dim(`  (${r.domain})`) : ''));
                      if (r.snippet) console.log(c.gray(`       ${r.snippet}`));
                      console.log(c.blue(`       ${r.url}`));
                    }
                  }
                  console.log('');
                } else {
                  printError(result.error || '搜索失败');
                }
              } catch (e) {
                printError(`搜索失败: ${e.message}`);
              }
            } else if (selected.flag === 'proxy') {
              try {
                const proxyConfig = require('../services/proxyConfigService');
                const status = proxyConfig.getStatus();
                if (status.active) {
                  printSuccess(`代理已启用: ${status.url}`);
                  const { action } = await inqPrompt([{
                    type: 'list', name: 'action', message: '代理操作:',
                    choices: [
                      { name: '关闭代理', value: 'off' },
                      { name: '重新检测 Clash', value: 'detect' },
                      { name: '取消', value: 'cancel' },
                    ],
                  }]);
                  if (action === 'off') { proxyConfig.disableProxy(); printSuccess('代理已关闭'); }
                  else if (action === 'detect') {
                    const r = await proxyConfig.autoDetectAndEnable();
                    r.success ? printSuccess(`已检测并启用: ${r.proxy.url}`) : printError(r.error);
                  }
                } else {
                  const { action } = await inqPrompt([{
                    type: 'list', name: 'action', message: '代理设置:',
                    choices: [
                      { name: '自动检测 Clash', value: 'detect' },
                      { name: '手动配置 HTTP 代理', value: 'http' },
                      { name: '手动配置 SOCKS5 代理', value: 'socks5' },
                      { name: '取消', value: 'cancel' },
                    ],
                  }]);
                  if (action === 'detect') {
                    printInfo('正在检测 Clash...');
                    const r = await proxyConfig.autoDetectAndEnable();
                    r.success ? printSuccess(`已检测并启用: ${r.proxy.url}`) : printError(r.error);
                  } else if (action === 'http' || action === 'socks5') {
                    const { port } = await inqPrompt([{
                      type: 'input', name: 'port', message: `端口 (默认 ${action === 'http' ? '7890' : '1080'}):`,
                      default: action === 'http' ? '7890' : '1080',
                    }]);
                    const r = await proxyConfig.enableProxy({ type: action, host: '127.0.0.1', port });
                    r.success ? printSuccess(`代理已启用: ${r.proxy.url}`) : printError(r.error);
                  }
                }
              } catch (e) { printError(`代理配置失败: ${e.message}`); }
            } else if (selected.flag === 'models') {
              try {
                const ollamaMgr = require('../services/ollamaModelManager');
                const running = await ollamaMgr.isOllamaRunning();
                const hw = ollamaMgr.detectHardware();

                console.log('');
                printInfo(`硬件: ${hw.totalRamGB} GB RAM · ${hw.cpuCount} CPUs` + (hw.gpu ? ` · GPU: ${hw.gpu.name} (${(hw.gpu.vramMB / 1024).toFixed(1)} GB)` : ''));
                printInfo(`硬件等级: ${hw.tier.toUpperCase()} — Ollama ${running ? c.green('运行中') : c.yellow('未运行')}`);
                console.log('');

                if (running) {
                  const models = await ollamaMgr.listModels();
                  if (models.length > 0) {
                    printSuccess(`已安装 ${models.length} 个模型:`);
                    for (const m of models) {
                      console.log(c.dim(`    ${m.name}  (${m.size}, ${m.paramSize})`));
                    }
                  } else {
                    printInfo('暂无已安装模型');
                  }
                }

                const { recommended } = ollamaMgr.getRecommendations();
                const mainChoices = [
                  { name: '下载推荐模型', value: 'pull' },
                  { name: '导入本地模型文件/目录 (GGUF / Safetensors)', value: 'import' },
                  { name: '设置默认模型', value: 'set' },
                  { name: '删除已安装模型', value: 'delete' },
                  { name: '取消', value: 'cancel' },
                ];
                const { action } = await inqPrompt([{
                  type: 'list', name: 'action', message: '模型管理操作:',
                  choices: mainChoices,
                }]);

                if (action === 'pull') {
                  console.log('');
                  printInfo(`推荐模型 (${hw.tier} 级别):`);
                  const choices = recommended.map(m => ({
                    name: `${m.name} (${m.size}) — ${m.reason}`,
                    value: m.id,
                  }));
                  choices.push({ name: '取消', value: 'cancel' });
                  const { modelId } = await inqPrompt([{
                    type: 'list', name: 'modelId', message: '选择要下载的模型:',
                    choices,
                  }]);
                  if (modelId !== 'cancel' && running) {
                    printInfo(`正在下载 ${modelId}...`);
                    await ollamaMgr.pullModel(modelId, (progress) => {
                      if (progress.total > 0 && process.stdout.isTTY) {
                        process.stdout.write(`\r  ⟳ ${progress.status} ${progress.percent}%`);
                      }
                    });
                    console.log('');
                    printSuccess(`模型 ${modelId} 下载完成!`);
                  }
                } else if (action === 'import') {
                  if (!running) {
                    printError('Ollama 未运行。请先安装并启动: https://ollama.ai');
                  } else {
                    const ans = await inqPrompt([
                      { type: 'input', name: 'source', message: '本地路径 (.gguf/.safetensors/目录):' },
                      { type: 'input', name: 'name', message: '目标模型名 (可空自动生成):', default: '' },
                      { type: 'input', name: 'base', message: '若是 adapter，填写 base 模型 (如 qwen2.5:7b，可空):', default: '' },
                    ]);
                    const imported = await ollamaMgr.importModel(ans.source, ans.name, { base: ans.base || undefined });
                    if (!imported.success) {
                      printError(`导入失败: ${imported.error}`);
                    } else {
                      printSuccess(`导入成功: ${imported.model} (${imported.sourceKind})`);
                      printInfo(`运行: models set ${imported.model}`);
                    }
                  }
                } else if (action === 'set') {
                  if (!running) {
                    printError('Ollama 未运行。请先安装并启动: https://ollama.ai');
                  } else {
                    const models = await ollamaMgr.listModels();
                    if (!models.length) {
                      printInfo('暂无已安装模型');
                    } else {
                      const fs = require('fs');
                      const envPath = path.resolve(__dirname, '../../.env');
                      let envContent = '';
                      try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* no .env */ }
                      const setEnvVar = (k, v) => {
                        const regex = new RegExp(`^${k}=.*$`, 'm');
                        const line = `${k}=${v}`;
                        if (regex.test(envContent)) envContent = envContent.replace(regex, line);
                        else envContent = envContent.trimEnd() + '\n' + line + '\n';
                        fs.writeFileSync(envPath, envContent);
                        process.env[k] = String(v);
                      };
                      const { picked } = await inqPrompt([{
                        type: 'list',
                        name: 'picked',
                        message: '选择默认 Ollama 模型:',
                        choices: models.map(m => ({ name: `${m.name} (${m.size})`, value: m.name })),
                      }]);
                      setEnvVar('GATEWAY_PREFERRED_ADAPTER', 'ollama');
                      setEnvVar('GATEWAY_PREFERRED_STRICT', 'true');
                      setEnvVar('OLLAMA_MODEL', picked);
                      try {
                        const gateway = require('../services/gateway/aiGateway');
                        await gateway.refreshAdapters();
                      } catch { /* best effort */ }
                      printSuccess(`已设置默认模型: ollama/${picked}`);
                    }
                  }
                } else if (action === 'delete') {
                  if (!running) {
                    printError('Ollama 未运行。请先安装并启动: https://ollama.ai');
                  } else {
                    const models = await ollamaMgr.listModels();
                    if (!models.length) {
                      printInfo('暂无已安装模型');
                    } else {
                      const { picked } = await inqPrompt([{
                        type: 'list',
                        name: 'picked',
                        message: '选择要删除的模型:',
                        choices: [...models.map(m => ({ name: `${m.name} (${m.size})`, value: m.name })), { name: '取消', value: 'cancel' }],
                      }]);
                      if (picked !== 'cancel') {
                        const ok = await ollamaMgr.deleteModel(picked);
                        if (ok) printSuccess(`已删除模型: ${picked}`);
                        else printError(`删除失败: ${picked}`);
                      }
                    }
                  }
                }
              } catch (e) { printError(`模型管理失败: ${e.message}`); }
            } else if (selected.flag === 'scan') {
              try {
                const av = require('../services/antivirusService');
                const tools = av.detectTools();
                if (!tools.hasClamAV) {
                  printError('ClamAV 未安装');
                  const inst = av.getInstallInstructions();
                  printInfo(`安装命令: ${inst.install}`);
                } else {
                  printInfo('正在扫描项目文件...');
                  const result = av.scanProject();
                  if (result.clean) {
                    printSuccess(`扫描完成: 未发现威胁 (${require('./ccFormat').ccFormatDurationOr(result.elapsed, `${(result.elapsed / 1000).toFixed(1)}s`, process.env)})`);
                  } else {
                    printError(`发现 ${result.infected} 个威胁!`);
                    for (const t of result.threats) {
                      console.log(c.red(`    ${t.virus} → ${t.file}`));
                    }
                    printInfo('已隔离到 ~/.khyquant/quarantine/');
                  }
                }
              } catch (e) { printError(`扫描失败: ${e.message}`); }
            } else if (selected.flag === 'security-full') {
              try {
                const secGuard = require('../services/securityGuardService');
                const integrity = require('../services/fileIntegrityService');
                const resGuard = require('../services/resourceGuard');

                console.log('');
                printInfo('文件完整性校验...');
                const intResult = integrity.verify();
                if (intResult.verified) {
                  printSuccess(`完整性: ${intResult.unchanged} 文件无改动`);
                } else {
                  printError(`完整性异常: ${intResult.modified.length} 修改, ${intResult.removed.length} 删除`);
                  for (const f of intResult.modified.slice(0, 5)) console.log(c.yellow(`    修改: ${f}`));
                  for (const f of intResult.removed.slice(0, 5)) console.log(c.red(`    删除: ${f}`));
                }
                if (intResult.added.length > 0) {
                  printInfo(`新增文件: ${intResult.added.length} (正常更新)`);
                }

                printInfo('威胁扫描...');
                const threats = secGuard.scanForThreats();
                if (threats.clean) {
                  printSuccess('威胁扫描: 未发现异常');
                } else {
                  printError(`发现 ${threats.threats.length} 个威胁:`);
                  for (const t of threats.threats) {
                    console.log(c.red(`    [${t.severity}] ${t.type}: ${t.detail}`));
                  }
                }

                const health = resGuard.systemHealthCheck();
                if (health.healthy) {
                  printSuccess('系统资源: 正常');
                } else {
                  for (const w of health.warnings) printWarn(w);
                }

                const stats = secGuard.getSecurityStats();
                if (stats.totalEvents > 0) {
                  printInfo(`安全事件: ${stats.totalEvents} 总计, ${stats.last24h} 近24小时`);
                }
                console.log('');
              } catch (e) { printError(`安全检查失败: ${e.message}`); }
            } else if (selected.flag === 'hardware') {
              try {
                const hw = require('../services/hardwareProfileService');
                const { lines, profile } = hw.getHardwareSummary();

                console.log('');
                printInfo('硬件配置:');
                for (const line of lines) console.log(c.dim(`    ${line}`));
                console.log('');

                // Operating-system dimension (identity + container/cgroup + modifiers)
                if (profile.os) {
                  printInfo('操作系统:');
                  const osp = profile.os;
                  console.log(c.dim(`    系统: ${osp.os} (${osp.kernel})`) + (osp.source === 'pinned' ? c.yellow(' (KHY_OS_PROFILE 锁定)') : ''));
                  if (osp.isWSL) console.log(c.yellow('    环境: WSL (跨 /mnt IO 较慢，已放宽超时)'));
                  if (osp.container && osp.container.detected) {
                    const eff = profile.effective || {};
                    const memTxt = eff.ramMB ? `${Math.round(eff.ramMB / 1024)}GB` : '未限';
                    const cpuTxt = eff.cpuCount ? `${eff.cpuCount}核` : '未限';
                    console.log(c.yellow(`    容器: ${osp.container.runtime} (有效 ${memTxt}/${cpuTxt})`));
                  }
                  if (profile.effective && profile.effective.clamped) {
                    console.log(c.yellow('    ⚠ 已按容器限额收紧档位 (宿主资源不代表可用资源)'));
                  }
                  const mult = osp.modifiers ? osp.modifiers.timeoutMultiplier : 1;
                  if (mult && mult !== 1) {
                    console.log(c.dim(`    超时修正系数: ×${mult}`));
                  }
                  console.log('');
                }

                if (profile.localModels.length > 0) {
                  printInfo('推荐本地模型:');
                  for (const m of profile.localModels) {
                    const rec = m.recommended ? c.green(' ★ 推荐') : '';
                    if (m.recommendation === 'api-only') {
                      console.log(c.yellow(`    ${m.reason}`));
                    } else {
                      console.log(c.dim(`    ${m.name} (${m.sizeGB}GB)`) + rec);
                      console.log(c.dim(`      ${m.reason}`));
                    }
                  }
                }

                console.log('');
                printInfo('资源限制:');
                const lim = profile.limits;
                console.log(c.dim(`    Node.js 堆: ${lim.nodeHeapMB}MB`));
                console.log(c.dim(`    并发数: ${lim.maxConcurrency}`));
                console.log(c.dim(`    多智能体: ${lim.enableMultiAgent ? '启用' : '禁用'}`));
                console.log(c.dim(`    本地模型: ${lim.enableLocalModel ? '启用' : '禁用'}`));
                console.log('');

                // Effective runtime knobs + their source (auto-derived vs user override)
                try {
                  const applied = hw.getAppliedLimits();
                  printInfo('生效运行参数:');
                  const tierTag = applied.pinned ? c.yellow(' (KHY_HW_PROFILE 锁定)') : '';
                  console.log(c.dim(`    档位: ${applied.profile}`) + tierTag);
                  for (const [key, val] of Object.entries(applied.env)) {
                    const overridden = applied.source[key] === 'user-override';
                    const tag = overridden ? c.yellow(' ← 用户覆盖') : c.dim(' (硬件派生)');
                    console.log(c.dim(`    ${key}=${val}`) + tag);
                  }
                  console.log(c.dim('    提示: 设 KHY_HW_PROFILE=server-minimal|desktop-cpu|workstation 可手动锁定档位'));
                  console.log(c.dim('    提示: 设 KHY_OS_PROFILE=linux|windows|macos 锁定 OS；KHY_EFFECTIVE_MEM_MB/KHY_EFFECTIVE_CPUS 手动夹取有效资源'));
                  console.log('');
                } catch { /* transparency block is best-effort */ }
              } catch (e) { printError(`硬件检测失败: ${e.message}`); }
            } else if (selected.flag === 'review') {
              try {
                const { handleReview } = require('./handlers/review');
                _busy = true;
                _startBusyPromptKeepalive();
                await handleReview();
                _busy = false;
              } catch (e) { printError(`代码审查失败: ${e.message}`); _busy = false; }
            } else if (selected.flag === 'subscribe') {
              try {
                const { handleDocsSubscription } = require('./handlers/docs');
                await handleDocsSubscription();
              } catch (e) { printError(`显示订阅指引失败: ${e.message}`); }

            // ── Claude Code aligned flag handlers ──────────────────────
            } else if (new Set([
              'compact', 'snip', 'config', 'context', 'diff', 'effort', 'env',
              'export', 'fast', 'files', 'hooks', 'mcp', 'session',
              'share', 'stats', 'status', 'summary', 'tasks', 'theme',
              'branch', 'debug', 'stickers',
            ]).has(selected.flag)) {
              recoverReadlineInput();
              const cmdParsed = parseInput(selected.cmd.slice(1));
              if (cmdParsed) {
                const result = await route(cmdParsed);
                recoverReadlineInput();
                if (result === 'exit') {
                  const savedMeta = ai().saveConversation();
                  saveHistory(history);
                  setTerminalTitle('');
                  console.log('');
                  console.log(c.cyan(`  ${MASCOT_MINI} `) + c.dim(getRandomFarewell()));
                  printResumeRecoveryHints(savedMeta);
                  console.log('');
                  _uninstallBusyPromptConsolePatch();
                  _intentionalExit = true; process.exit(0);
                }
              }

            } else if (selected.flag === 'compact') {
              // 刀108:菜单 /compact 孪生对齐 router 富化路径(承刀101-104 drift 家族)。
              // 菜单选择无自由文本 → 无聚焦指令;但补齐「无需压缩 / 失败」分支 + 富化成功行
              // (强度档·折叠条数)。门控 KHY_COMPACT_TWIN_ALIGN 关 → 逐字节回退今日 '对话已压缩'。
              printInfo('正在压缩会话历史...');
              const _crAlign = require('./compactResultSummary');
              if (!_crAlign.compactTwinAlignEnabled(process.env)) {
                try {
                  ai().compactConversation && ai().compactConversation();
                  printSuccess('对话已压缩');
                } catch (e) { printError(`会话压缩失败: ${e.message}`); }
              } else {
                try {
                  let _opts = { mode: 'auto' };
                  try { _opts = require('./compactInstructions').buildCompactOptions({}, process.env); } catch (_) {}
                  const _res = ai().compactConversation ? ai().compactConversation(_opts) : null;
                  if (!_res || _res.success === false) {
                    printError('会话压缩失败');
                  } else if (_res.changed === false) {
                    printInfo(`无需压缩：当前消息 ${_res.previousCount}`);
                  } else {
                    let _line = `会话已压缩：${_res.previousCount} -> ${_res.nextCount}`;
                    try { _line = _crAlign.buildCompactSuccessLine(_res, process.env); } catch (_) {}
                    printSuccess(_line);
                  }
                } catch (e) { printError(`会话压缩失败: ${e.message}`); }
              }

            } else if (selected.flag === 'config') {
              const settings = (() => {
                try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.khy', 'settings.json'), 'utf-8')); } catch { return {}; }
              })();
              console.log(c.bold('\n  配置'));
              for (const [k, v] of Object.entries(settings)) {
                console.log(`    ${c.cyan(k)}: ${JSON.stringify(v)}`);
              }
              if (Object.keys(settings).length === 0) console.log(c.dim('    未发现自定义配置'));
              console.log('');

            } else if (selected.flag === 'context') {
              try {
                const hud = require('./hudRenderer');
                const state = hud.getState();
                // 占用率/余量/健康分级收敛到纯叶子 SSOT(与 CtxInspectTool / router 同源,不再自写 round 公式)。
                const { computeContextStats } = require('../services/context/ctxWindowStats');
                const stats = computeContextStats({
                  used: state.contextWindow.used,
                  limit: state.contextWindow.limit,
                  sessionInput: state.sessionTokens.input,
                  sessionOutput: state.sessionTokens.output,
                  requestCount: state.requestCount,
                  // 刀103:透传 model 供身份详情行(菜单孪生此前从不传 → stats.model 恒 '')。
                  model: state.lastModel,
                }, process.env);
                const statusZh = stats.status === 'critical' ? c.red('接近上限')
                  : stats.status === 'warning' ? c.yellow('偏高') : c.green('健康');
                console.log(c.bold('\n  上下文窗口'));
                console.log(`    已使用: ${_tk1(stats.used)} / ${_tk0(stats.limit)} 令牌 (${stats.percentUsed}%) ${statusZh}`);
                console.log(`    剩余: ${_tk1(stats.remaining)} 令牌`);
                console.log(`    会话令牌: ↑${_tk1(stats.sessionInput)} ↓${_tk1(stats.sessionOutput)}`);
                console.log(`    请求次数: ${stats.requestCount}`);
                // 刀103:补 router 详情行里两条交互中文孪生共漏的 模型 + 上限来源(诚实标注)。
                // 同源纯叶子 buildContextIdentityLines(不含 Requests·中文孪生自印请求次数)。
                // 门控 KHY_CONTEXT_PANEL_DETAIL 关 → [] → 逐字节回退刀103前四行。
                try {
                  for (const _l of require('./contextPanelDetail').buildContextIdentityLines(stats, process.env)) {
                    console.log(`    ${c.dim(_l)}`);
                  }
                } catch (_) { /* fail-soft:略过身份行 */ }
                // Thread4:per-category 上下文分解网格(对齐 CC /context 分类可视化)。
                // 收集真实数据源(System tools = 工具定义 JSON 估算,即 API 实发的工具
                // schema 开销),纯叶子后端逻辑生成 CC 风格 10×10 网格 + 图例。门控
                // KHY_CONTEXT_BREAKDOWN 关 / 无数据 → [] → 逐字节回退(不追加网格)。
                try {
                  const { analyzeContextBreakdown, renderContextBreakdownLines } = require('../services/context/contextBreakdown');
                  const { estimateTokens } = require('../services/textHeuristics');
                  const _sections = [];
                  try {
                    const { getToolDefinitions } = require('../services/toolCalling');
                    const _defs = getToolDefinitions();
                    if (Array.isArray(_defs) && _defs.length > 0) {
                      _sections.push({ name: 'System tools', text: JSON.stringify(_defs) });
                    }
                  } catch (_) { /* 注册表不可用则该类别省略 */ }
                  const _bd = analyzeContextBreakdown({ contextWindow: stats.limit, sections: _sections, estimateTokens }, process.env);
                  const _bdLines = renderContextBreakdownLines(_bd, { model: stats.model, width: 10, height: 10 }, process.env);
                  if (_bdLines.length > 0) {
                    console.log('');
                    for (const _l of _bdLines) console.log(`    ${c.dim(_l)}`);
                  }
                  if (_bd) {
                    try {
                      const { analyzeContextSuggestions, renderContextSuggestionLines } = require('../services/context/contextSuggestions');
                      let _tct = null;
                      try {
                        const { analyzeMessageBreakdown } = require('../services/context/messageBreakdown');
                        const _mb = analyzeMessageBreakdown({ messages: ai().getConversation ? ai().getConversation() : [], estimateTokens }, process.env);
                        if (_mb && _mb.toolCallsByType && _mb.toolCallsByType.length > 0) _tct = _mb.toolCallsByType;
                      } catch (_) { /* honest-NA */ }
                      const _sug = analyzeContextSuggestions({ percentage: _bd.percentage, contextWindow: _bd.contextWindow, categories: _bd.categories, toolCallsByType: _tct }, process.env);
                      const _sugLines = renderContextSuggestionLines(_sug, {}, process.env);
                      if (_sugLines.length > 0) {
                        console.log('');
                        for (const _l of _sugLines) console.log(`    ${c.dim(_l)}`);
                      }
                    } catch (_) { /* fail-soft:略过建议 */ }
                  }
                } catch (_) { /* fail-soft:略过分解网格 */ }
                console.log('');
              } catch (e) { printError(`上下文窗口读取失败: ${e.message}`); }

            } else if (selected.flag === 'diff') {
              try {
                const { execFileSync } = require('child_process');
                // --no-index 在有差异时退出码为 1(execFileSync 抛),diff 文本在 e.stdout,须捕获。
                const runGit = (args) => {
                  try { return { stdout: execFileSync('git', args, { encoding: 'utf-8', timeout: 8000, maxBuffer: 1 << 24 }) }; }
                  catch (e) { return { stdout: (e && e.stdout) ? String(e.stdout) : '' }; }
                };
                const diff = require('./gitDiffCollect').collectWorkingTreeDiff(runGit, process.env).trim();
                if (diff) {
                  // 统一 diff 文本按行首 +/-/@@ 着色:新增绿、删除红、上下文/头部 dim。
                  // 不可用 renderSideBySideDiff(它会把整份 diff 当 oldContent 与空串再做一次 LCS,
                  // 导致每行都变红删除且丢弃返回值=屏上全无输出/全红)。
                  console.log(require('./diffRenderer').renderDiff(diff));
                } else {
                  printInfo('当前没有未提交变更');
                }
              } catch (e) { printError(`Git 差异读取失败: ${e.message}`); }

            } else if (selected.flag === 'effort') {
              printInfo('使用 /max、/high、/medium 或 /low 设置思考强度');

            } else if (selected.flag === 'env') {
              console.log(c.bold('\n  环境信息'));
              // 刀109:菜单 /env 孪生对齐键入孪生超集(承刀103/104 change-both-twins)。门控关 →
              // 逐字节回退今日行(平台/Node/工作目录/Shell/终端/Git 分支·无版本)。门控开 → 复用
              // envInfoLines SSOT 叶子(补 版本,与键入孪生逐字段一致)。
              const _envLeaf = (() => { try { return require('./envInfoLines'); } catch { return null; } })();
              if (_envLeaf && _envLeaf.envInfoAlignEnabled(process.env)) {
                let _branch = '';
                try { _branch = require('child_process').execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 2000 }).trim(); } catch (_) { /* not a git repo */ }
                for (const _l of _envLeaf.buildEnvInfoLines({
                  platform: process.platform, arch: process.arch, nodeVersion: process.version,
                  cwd: process.cwd(), shell: process.env.SHELL, term: process.env.TERM,
                  version: VERSION, gitBranch: _branch,
                })) console.log(_l);
              } else {
                console.log(`    平台: ${process.platform} ${process.arch}`);
                console.log(`    Node: ${process.version}`);
                console.log(`    工作目录: ${process.cwd()}`);
                console.log(`    Shell: ${process.env.SHELL || 'N/A'}`);
                console.log(`    终端: ${process.env.TERM || 'N/A'}`);
                try {
                  const { execSync } = require('child_process');
                  const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 2000 }).trim();
                  console.log(`    Git 分支: ${branch}`);
                } catch { /* not a git repo */ }
              }
              console.log('');

            } else if (selected.flag === 'export') {
              try {
                const convo = ai().getConversation ? ai().getConversation() : [];
                const stamp = Date.now();
                // JSON: faithful structured dump of the live conversation.
                const jsonPath = path.join(process.cwd(), `khy-session-${stamp}.json`);
                fs.writeFileSync(jsonPath, JSON.stringify(convo, null, 2), 'utf-8');
                // Markdown: readable transcript via the shared session builder.
                let mdPath = '';
                try {
                  const { formatSessionMarkdown } = require('./handlers/session');
                  const liveId = (ai().getLiveSessionId && ai().getLiveSessionId()) || '';
                  const md = formatSessionMarkdown({
                    sessionId: liveId,
                    title: '',
                    messages: convo,
                    updatedAt: stamp,
                  });
                  mdPath = path.join(process.cwd(), `khy-session-${stamp}.md`);
                  fs.writeFileSync(mdPath, md, 'utf-8');
                } catch { /* markdown is a bonus; JSON already written */ }
                printSuccess(`会话已导出: ${jsonPath}${mdPath ? `\n  + ${mdPath}` : ''}`);
                printInfo('导出过去/已保存的会话可用: session export <序号|ID> [--format md|json]');
              } catch (e) { printError(`导出失败: ${e.message}`); }

            } else if (selected.flag === 'local') {
              _toggleLocalMode();

            } else if (selected.flag === 'fast') {
              _fastMode = !_fastMode;
              printSuccess(`快速模式已${_fastMode ? '开启' : '关闭'}`);

            } else if (selected.flag === 'files') {
              try {
                const { execSync } = require('child_process');
                const files = execSync('git ls-files', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n');
                console.log(c.bold(`\n  仓库文件（${files.length} 个）:`));
                files.slice(0, 30).forEach(f => console.log(`    ${f}`));
                if (files.length > 30) console.log(c.dim(`    ... 其余 ${files.length - 30} 个文件未展开`));
                console.log('');
              } catch (e) { printError(`文件列表读取失败: ${e.message}`); }

            } else if (selected.flag === 'hooks') {
              try {
                const hookSystem = require('./hooks/hookSystem');
                const count = hookSystem.registry.count;
                console.log(c.bold(`\n  Hook 注册情况（共 ${count} 个）`));
                for (const ev of hookSystem.registry.events) {
                  const hooks = hookSystem.registry.getHooks(ev);
                  if (hooks.length > 0) console.log(`    ${ev}: ${hooks.length} hook(s)`);
                }
                console.log('');
              } catch (e) { printError(`Hook 信息读取失败: ${e.message}`); }

            } else if (selected.flag === 'mcp') {
              try {
                const mcp = require('../services/mcp');
                const cfg = mcp.loadConfig(process.env.KHYQUANT_CWD || process.cwd());
                const configured = Object.keys((cfg && cfg.mcpServers) || {});
                const connected = typeof mcp.getConnectedServers === 'function'
                  ? mcp.getConnectedServers() : [];
                console.log(c.bold(`\n  MCP 服务（已配置 ${configured.length} · 已连接 ${connected.length}）`));
                if (configured.length === 0) {
                  console.log('    暂无已配置的 MCP 服务。');
                } else {
                  for (const name of configured) {
                    const mark = connected.includes(name) ? c.green('●已连接') : c.gray('○未连接');
                    console.log(`    ${mark}  ${name}`);
                  }
                }
                console.log(c.gray('\n  配置文件: ~/.khy/mcp.json（项目级 <项目>/.khy/mcp.json）'));
                console.log(c.gray('  添加服务: 编辑该文件的 mcpServers 段，重启会话自动连接'));
                console.log(c.gray('  开关自动连接: KHY_MCP_AUTOCONNECT=false 可禁用'));
                console.log('');
              } catch (e) { printError(`MCP 状态读取失败: ${e.message}`); }

            } else if (selected.flag === 'session') {
              const elapsed = ((Date.now() - _sessionStart) / 1000 / 60).toFixed(1);
              console.log(c.bold('\n  会话信息'));
              console.log(`    时长: ${elapsed} 分钟`);
              console.log(`    版本: ${VERSION}`);
              console.log('');

            } else if (selected.flag === 'share') {
              printInfo('CLI 模式暂不支持分享。');

            } else if (selected.flag === 'stats') {
              try {
                const hud = require('./hudRenderer');
                const s = hud.getState();
                console.log(c.bold('\n  会话统计'));
                console.log(`    请求次数: ${s.requestCount}`);
                console.log(`    令牌用量: ↑${_tk1(s.sessionTokens.input)} ↓${_tk1(s.sessionTokens.output)}，总计 ${_tk1(s.sessionTokens.total)}`);
                console.log(`    已使用工具: ${s.toolHistory.length}`);
                console.log(`    活跃代理: ${s.activeAgents.length}`);
                // 刀104:补 router /stats(router.js:1679)已呈现、两交互中文孪生共漏的对话构成
                // (消息按角色分布)——走 ai.getConversationStats() live 数据,fail-soft。
                try {
                  const _cs = ai().getConversationStats && ai().getConversationStats();
                  for (const _l of require('./statsConversationLines').buildConversationCompositionLines(_cs, process.env)) {
                    console.log(`    ${_l}`);
                  }
                } catch (_) { /* fail-soft:略过对话构成行 */ }
                console.log('');
              } catch (e) { printError(`统计读取失败: ${e.message}`); }

            } else if (selected.flag === 'status') {
              try {
                const hud = require('./hudRenderer');
                hud.refreshGit();
                const s = hud.getState();
                // 刀111:菜单 /status 孪生对齐 刀101 已富化的键入 /status 孪生(repl.js:4715)——补同一
                // statusPanelExtras 叶子的 模型/账户/git ahead-behind。router(刀94)+键入孪生(刀101)早已走此
                // 叶子,菜单孪生却仍只印 分支/活跃工具/活跃代理/上下文窗口(漏 模型/账户/gitSuffix)= 同一命令
                // 第三处实现的残留 drift(呈现侧未接 half-wired)。复用同一叶子(模型友好名走 formatModelLabel
                // SSOT 由此壳注入),渲染留壳;门控 KHY_STATUS_PANEL_DETAIL 关 → 三片全空 → 逐字节回退刀111前。
                // 刻意不动菜单孪生特有的 活跃工具/活跃代理(既存面差异·超本刀范围)。
                let extras = { model: null, account: null, gitSuffix: '' };
                try {
                  const { buildStatusPanelExtras } = require('./statusPanelExtras');
                  const { formatModelLabel } = require('./ccModelName');
                  extras = buildStatusPanelExtras(s, { formatModelLabel }, process.env);
                } catch { /* fail-soft:额外三片失败绝不影响主 /status */ }
                console.log(c.bold('\n  状态'));
                if (extras.model) console.log(`    模型: ${extras.model}`);
                if (extras.account) console.log(`    账户: ${extras.account}`);
                if (s.git.branch) console.log(`    分支: ${s.git.branch}${s.git.dirty ? ` (${s.git.dirtyCount} 处变更)` : ''}${extras.gitSuffix}`);
                if (s.activeTool) console.log(`    活跃工具: ${s.activeTool.name}`);
                if (s.activeAgents.length > 0) console.log(`    活跃代理: ${s.activeAgents.map(a => a.name).join(', ')}`);
                console.log(`    上下文窗口: ${Math.round(s.contextWindow.used/1000)}k/${Math.round(s.contextWindow.limit/1000)}k`);
                console.log('');
              } catch (e) { printError(`状态读取失败: ${e.message}`); }

            } else if (selected.flag === 'mind') {
              _renderTaskMindMap('manual');

            } else if (selected.flag === 'summary') {
              printInfo('正在生成会话摘要...');
              try {
                const convo = ai().getConversation ? ai().getConversation() : [];
                printInfo(`当前会话共有 ${convo.length} 条消息，可继续让 AI 生成摘要。`);
              } catch (e) { printError(`会话摘要生成失败: ${e.message}`); }

            } else if (selected.flag === 'tasks') {
              await _handleTasksCommand('');

            } else if (selected.flag === 'theme') {
              // 刀112:菜单 /theme 孪生对齐 live 主题注册表(cli/themeRegistry.js·8 套主题·
              // 被 router /theme→/skin list + aiRenderer + TUI 消费)。此前硬编码 "主题: dark(默认)"
              // 无视注册表 = 呈现侧未接的 half-wired 幽灵显示(用户 /skin set dracula 明明生效)。
              // 复用 listThemes() SSOT + 纯叶子 themePanelLines 排版;门控 KHY_THEME_PANEL 关 /
              // 注册表读空 → [] → 逐字节回退刀112前单行 printInfo。
              let _themeLines = [];
              try {
                const _tp = require('./themePanelLines');
                if (_tp.themePanelEnabled(process.env)) {
                  const tr = require('./themeRegistry');
                  try { tr.init && tr.init(); } catch { /* 已初始化则忽略 */ }
                  _themeLines = _tp.buildThemePanelLines(tr.listThemes(), process.env);
                }
              } catch { /* fail-soft:主题面板失败绝不影响菜单 */ }
              if (_themeLines.length > 0) {
                console.log(c.bold('\n  主题'));
                for (const _l of _themeLines) console.log(_l);
                console.log('');
              } else {
                printInfo('主题: dark（默认），可使用 /config 设置自定义主题。');
              }

            } else if (selected.flag === 'branch') {
              try {
                const { execSync } = require('child_process');
                const branches = execSync('git branch -a', { encoding: 'utf-8', timeout: 5000 }).trim();
                console.log(c.bold('\n  Git 分支'));
                console.log(branches.split('\n').map(b => `    ${b.trim()}`).join('\n'));
                console.log('');
              } catch (e) { printError(`分支信息读取失败: ${e.message}`); }

            } else if (selected.flag === 'debug') {
              // 刀113:菜单 /debug 孪生从静态提示接到 live 工具调用查看器。此前只印一行提示
              // (且指向 /debug <tool_name>,而真查看器是 /debug-tool-call —— 提示误导)。复用
              // 与 handleDebugToolCall 同一底座(sessionForestService.getCurrentSessionId +
              // sessionPersistence.buildConversationChain + debugToolCall 叶子 extractToolCalls/
              // formatToolCallDebug)内联渲染本会话最近 5 次工具调用 = 呈现侧接上 half-wired。
              // 双门控:KHY_DEBUG_MENU_INLINE(菜单内联)+ KHY_DEBUG_TOOL_CALL(底层特性)任一关、
              // 或无会话 / 无工具调用 / fail-soft → 逐字节回退刀113前静态提示行。
              let _dbgShown = false;
              try {
                const dbg = require('./debugToolCall');
                if (dbg.menuInlineEnabled(process.env) && dbg.isEnabled(process.env)) {
                  let _sid = null;
                  try { _sid = require('../services/session/sessionForestService').getCurrentSessionId(); } catch { /* best-effort */ }
                  if (_sid) {
                    let _chain = [];
                    try { _chain = require('../services/sessionPersistence').buildConversationChain(_sid); } catch { _chain = []; }
                    const _pairs = dbg.extractToolCalls(_chain, { limit: 5 });
                    if (_pairs.length > 0) {
                      console.log(c.bold('\n  最近工具调用'));
                      console.log(dbg.formatToolCallDebug(_pairs, {}));
                      console.log(c.dim('    更多历史:/debug-tool-call [N]'));
                      console.log('');
                      _dbgShown = true;
                    }
                  }
                }
              } catch { /* fail-soft:调试面板失败绝不影响菜单 */ }
              if (!_dbgShown) printInfo('调试模式：使用 /debug <tool_name> 调试最近一次工具调用。');

            } else if (selected.flag === 'stickers') {
              const stickers = ['(╯°□°)╯︵ ┻━┻', '┬─┬ノ( º _ ºノ)', '( •_•)>⌐■-■', '(⌐■_■)', '\\(^_^)/', '(>_<)', '(◕‿◕)', '(ノಠ益ಠ)ノ彡┻━┻'];
              console.log('\n  ' + stickers[Math.floor(Math.random() * stickers.length)] + '\n');

            } else if (selected.flag === 'effort-max') {
              _effortLevel = 'max';
              printSuccess('思考强度已切换为 MAX — AI 将使用最高精度');

            } else if (selected.flag === 'checkpoint') {
              try {
                const cwd = process.env.KHYQUANT_CWD || process.cwd();
                const ckptSvc = require('../services/workspace/checkpointService');
                const ckResult = ckptSvc.saveCheckpoint(cwd, { message: '手动检查点', mode: 'auto' });
                printSuccess(`检查点已保存: ${ckResult.id} (${ckResult.mode}, ${ckResult.files || 0} 文件)`);
              } catch (e) { printError(`检查点保存失败: ${e.message}`); }

            } else if (selected.flag === 'rollback') {
              try {
                const cwd = process.env.KHYQUANT_CWD || process.cwd();
                const ckptSvc = require('../services/workspace/checkpointService');
                const ckList = ckptSvc.listCheckpoints(cwd);
                if (!ckList || ckList.length === 0) {
                  printWarn('没有可用的检查点。使用 /checkpoint 手动保存，或等待 AI 对话自动保存。');
                } else {
                  const recent = ckList.slice(-10).reverse();
                  const choices = recent.map(ck => ({
                    name: `${ck.id}  ${ck.mode}  ${new Date(ck.timestamp).toLocaleString()}  ${(ck.message || '').slice(0, 40)}`,
                    value: ck.id,
                  }));
                  const { selected: chosenId } = await inqPrompt([{
                    type: 'list',
                    name: 'selected',
                    message: '选择要回滚到的检查点:',
                    choices,
                  }]);
                  if (chosenId) {
                    ckptSvc.restoreCheckpoint(cwd, chosenId);
                    printSuccess(`已回滚到检查点: ${chosenId}`);
                  }
                }
              } catch (e) { printError(`回滚失败: ${e.message}`); }

            } else if (selected.flag === 'worktree') {
              // Bare /worktree (picker / no args) → show usage. Args go through the
              // /worktree regex handler below (this exact-match path excludes spaces).
              try {
                const { runWorktreeCommand } = require('./repl/worktreeCommand');
                await runWorktreeCommand('', { onCwdChange: (t) => { _atCurrentDir = t; } });
              } catch (e) { printError(`/worktree 执行失败: ${e.message}`); }

            }
          } else if (selected.cmd === '/study') {
            // ── /study — study mode toggle (no password required) ──
            try {
              const aiMod = ai();
              // Parse action from the trimmed text (trimmed is just "/study" from picker)
              const studyState = aiMod.isStudyMode ? aiMod.isStudyMode() : false;
              // Prompt user for action
              const { action } = await inqPrompt([{
                type: 'list', name: 'action',
                message: `学习模式: ${studyState ? c.green('开启') : c.dim('关闭')}`,
                choices: [
                  { name: studyState ? '关闭学习模式' : '开启学习模式', value: studyState ? 'off' : 'on' },
                  { name: '查看状态', value: 'status' },
                  { name: '取消', value: 'cancel' },
                ],
              }]);
              if (action === 'status') {
                printInfo(`学习模式当前状态: ${studyState ? c.green('开启') : c.dim('关闭')}`);
              } else if (action === 'on') {
                if (studyState) {
                  printInfo('学习模式已处于激活状态');
                } else {
                  // Study mode is no longer password-gated — enable directly.
                  aiMod.enableStudyMode && aiMod.enableStudyMode();
                  console.log('');
                  printSuccess('学习模式已开启！');
                  console.log(c.dim('  现在你可以向 AI 提问关于本项目的一切'));
                  console.log(c.dim('  建议先运行 knowledge self 查看当前能力边界与学习路径'));
                  console.log('');
                }
              } else if (action === 'off') {
                if (!studyState) {
                  printInfo('学习模式已处于关闭状态');
                } else {
                  aiMod.disableStudyMode && aiMod.disableStudyMode();
                  printSuccess('学习模式已关闭');
                }
              }
            } catch (e) { printError(`学习模式操作失败: ${e.message}`); }
          } else if (selected.route) {
            recoverReadlineInput();
            const cmdParsed = parseInput(selected.route);
            if (cmdParsed) {
              const result = await route(cmdParsed);
              recoverReadlineInput();
              if (result === 'exit') {
                const savedMeta = ai().saveConversation();
                saveHistory(history);
                setTerminalTitle('');
                console.log('');
                console.log(c.cyan(`  ${MASCOT_MINI} `) + c.dim(getRandomFarewell()));
                printResumeRecoveryHints(savedMeta);
                console.log('');
                _uninstallBusyPromptConsolePatch();
                _intentionalExit = true; process.exit(0);
              }
            }
          } else {
            // No flag/route defined — try routing the command name directly
            recoverReadlineInput();
            const cmdParsed = parseInput(selected.cmd.slice(1)); // strip leading '/'
            if (cmdParsed) {
              const result = await route(cmdParsed);
              recoverReadlineInput();
              if (result === 'exit') {
                const savedMeta = ai().saveConversation();
                saveHistory(history);
                setTerminalTitle('');
                console.log('');
                console.log(c.cyan(`  ${MASCOT_MINI} `) + c.dim(getRandomFarewell()));
                printResumeRecoveryHints(savedMeta);
                console.log('');
                _uninstallBusyPromptConsolePatch();
                _intentionalExit = true; process.exit(0);
              }
            }
          }
        } catch (e) { /* command handler error */ }
        recoverReadlineInput();
        rl.prompt();
        return;
      }
    }

    // `#` quick-add memory (Claude Code aligned): a line beginning with `#`
    // appends the remainder to an instruction file (khy.md) so it persists into
    // every future turn's system prompt. `#g <note>` targets the global file.
    if (/^#/.test(trimmed)) {
      const body = trimmed.replace(/^#+/, '').trim();
      let scope = 'project';
      let note = body;
      const gm = body.match(/^(g|global)\s+(.*)$/i);
      if (gm) { scope = 'global'; note = gm[2].trim(); }
      if (!note) {
        console.log(c.dim('  用法: # <要记住的内容>   （#g <内容> 写入全局 khy.md）'));
        rl.prompt();
        return;
      }
      try {
        const instr = require('../services/instructionFileService');
        const res = instr.appendQuickMemory(note, { scope });
        if (res.success) {
          console.log(c.hex('#7EE787')(`  ✓ 已记住（${scope === 'global' ? '全局' : '项目'}）: ${res.file}${res.created ? ' (新建)' : ''}`));
        } else {
          console.log(c.hex('#D77757')(`  记忆未写入: ${res.error}`));
        }
        // If the model has queued proactive khy.md/agent.md writes, nudge (once,
        // non-blocking) toward the review command. Best-effort.
        try {
          const cnt = require('../services/instructionReviewStore').count();
          if (cnt > 0) console.log(c.dim(`  （有 ${cnt} 条待审核的指令写入，/instructions 查看）`));
        } catch { /* review store optional */ }
      } catch (e) {
        console.log(c.hex('#D77757')(`  记忆写入异常: ${e.message}`));
      }
      rl.prompt();
      return;
    }

    // /btw — queue hint without interrupting current AI work
    if (trimmed === '/btw' || trimmed.startsWith('/btw ')) {
      const hint = trimmed.slice(4).trim();
      if (_btwQueue.enqueue(hint)) {
        console.log(c.dim(`  已排队补充提示（当前队列 ${_btwQueue.count()} 条）`));
      } else {
        console.log(c.dim('  用法: /btw <提示内容>'));
        console.log(c.dim('  AI 工作期间可排队补充提示，不会打断当前请求'));
        console.log(c.dim(`  当前队列: ${_btwQueue.count()} 条提示`));
      }
      rl.prompt();
      return;
    }

    // /s! 或 /steer! — 紧急方向修正：抢占当前在飞模型回合、保留循环上下文、注入修正后原地续跑。
    // 必须显式处理：_classifyBusyInput 的前缀正则要求 /s|/steer 后接空白，"/s!" 不匹配，故不能依赖分类器。
    // 须排在普通 /steer|/s 分支之前（否则 startsWith('/s ') 永远拦不到带 ! 的形式，但前缀不同仍需先判）。
    if (trimmed.startsWith('/s!') || trimmed.startsWith('/steer!')) {
      const hint = trimmed.replace(/^\/(?:steer|s)!\s*/, '').trim();
      if (!hint) {
        console.log(c.hex('#FF8C42')('  用法: /s! <修正内容> 或 /steer! <修正内容>'));
        console.log(c.dim('  紧急方向修正：抢占当前模型回合、保留已完成进度、注入修正后原地续跑'));
        console.log(c.dim('  对比 /s（被动·下一轮注入）与 /i（破坏·取消重跑丢上下文）'));
      } else if (!_busy) {
        printInfo('/s! 仅在 AI 工作中可用，当前空闲请直接输入');
      } else {
        _steerQueue.push(hint);            // 先入队（同步，先于 cancel，杜绝竞态）
        _urgentSteerPending = true;        // 再置抢占信号，供工具循环 consumeUrgentSteer pull-clear
        const cancelled = _requestRelayCancel('Urgent steer — preempt current turn');
        const preview = _summarizeQueuedInputForDisplay(hint, 40);
        console.log(c.hex('#FF8C42')(`  ⚡⟳ 紧急方向修正: "${preview}"`));
        console.log(c.dim(cancelled
          ? '    └ 已抢占当前回合，保留进度，注入修正后原地续跑（≈几秒落地）'
          : '    └ 当前无在飞模型请求可抢占，将于下一轮决策前注入'));
      }
      showBusyInterjectPrompt();
      rl.prompt();
      return;
    }

    // /steer 或 /s — 方向修正，注入到当前工具循环
    if (trimmed === '/steer' || trimmed.startsWith('/steer ') ||
        (trimmed.startsWith('/s ') && trimmed.length > 3 && !/^\/s(?:kin|ession|earch|can|ecurity|ub|kill|erver)/.test(trimmed))) {
      const hint = trimmed.replace(/^\/(?:steer|s)\s*/, '').trim();
      if (!hint) {
        console.log(c.hex('#D77757')('  用法: /steer <修正内容> 或 /s <修正内容>'));
        console.log(c.dim('  在 AI 工作中注入方向修正（如"别用那个库"、"改成 TS"）'));
        console.log(c.dim(`  当前 steer 队列: ${_steerQueue.length} 条`));
      } else if (!_busy) {
        printInfo('/steer 仅在 AI 工作中可用，当前空闲请直接输入');
      } else {
        _steerQueue.push(hint);
        const preview = _summarizeQueuedInputForDisplay(hint, 40);
        console.log(c.hex('#D77757')(`  ⟳ 已注入方向修正: "${preview}"`));
        console.log(c.dim(`    └ ${_describeSteerLanding()}`));
      }
      showBusyInterjectPrompt();
      rl.prompt();
      return;
    }

    // /study on|off|status — direct typed study mode commands (no password)
    if (/^\/study(?:\s|$)/i.test(trimmed)) {
      try {
        const aiMod = ai();
        const studyState = aiMod.isStudyMode ? aiMod.isStudyMode() : false;
        const args = trimmed.slice(6).trim(); // after "/study"
        const actionMatch = /^(on|off|status)/i.exec(args);
        const action = actionMatch ? actionMatch[1].toLowerCase() : 'status';

        if (action === 'status') {
          printInfo(`学习模式当前状态: ${studyState ? c.green('开启') : c.dim('关闭')}`);
        } else if (action === 'on') {
          if (studyState) {
            printInfo('学习模式已处于激活状态');
          } else {
            // Study mode is no longer password-gated — enable directly.
            aiMod.enableStudyMode && aiMod.enableStudyMode();
            console.log('');
            printSuccess('学习模式已开启！');
            console.log(c.dim('  现在你可以向 AI 提问关于本项目的一切'));
            console.log(c.dim('  建议先运行 knowledge self 查看当前能力边界与学习路径'));
            console.log('');
          }
        } else if (action === 'off') {
          if (!studyState) {
            printInfo('学习模式已处于关闭状态');
          } else {
            aiMod.disableStudyMode && aiMod.disableStudyMode();
            printSuccess('学习模式已关闭');
          }
        }
      } catch (e) { printError(`学习模式操作失败: ${e.message}`); }
      recoverReadlineInput();
      rl.prompt();
      return;
    }

    // /vim — toggle vim mode
    if (trimmed === '/vim') {
      const c = chalk();
      if (_vimHandler && _vimHandler.isActive()) {
        _vimHandler.disable();
        _vimHandler = null;
        vimSettings().setEditorMode('normal');
        console.log(c.green('  Vim 模式已关闭'));
      } else {
        if (!_vimHandler) {
          _vimHandler = vimInput().createVimInputHandler(rl, {
            enabled: true,
            prompt: buildCwdPrompt(),
          });
        } else {
          _vimHandler.enable();
        }
        vimSettings().setEditorMode('vim');
        console.log(c.green('  Vim 模式已开启 — Esc 进入 NORMAL，i 进入 INSERT'));
      }
      if (!_vimHandler || !_vimHandler.isActive()) {
        rl.prompt();
      }
      return;
    }

    // /voice — toggle voice mode
    if (trimmed === '/voice') {
      const c = chalk();
      try {
        const voiceService = require('../services/voiceService');
        const settings = voiceService.getVoiceSettings();
        if (settings.enabled) {
          voiceService.setVoiceEnabled(false);
          voiceService.stopSpeaking();
          console.log(c.green('  语音模式已关闭'));
        } else {
          const caps = voiceService.getCapabilities();
          voiceService.setVoiceEnabled(true);
          console.log(c.green('  语音模式已开启'));
          console.log(c.dim(`    TTS: ${caps.tts || 'none'} | STT: ${caps.stt || 'none'}`));
          if (!caps.tts) console.log(c.yellow('    未检测到 TTS 提供方，请安装 espeak 或 edge-tts。'));
          if (!caps.stt) console.log(c.yellow('    未检测到 STT 提供方，请安装 sox 或 whisper。'));
        }
      } catch (err) {
        console.log(c.red(`  语音服务异常: ${err.message}`));
      }
      rl.prompt();
      return;
    }

    // /desktop — toggle desktop-control gate (mouse/keyboard/window automation).
    // Maps to KHY_DESKTOP_CONTROL, read fresh by safetyGate on every action.
    if (trimmed === '/desktop' || trimmed.startsWith('/desktop ')) {
      const c = chalk();
      const arg = trimmed.slice('/desktop'.length).trim().toLowerCase();
      const VALID = { on: 'on', ask: 'ask', strict: 'strict', off: 'off',
        '1': 'on', '0': 'off', enable: 'on', disable: 'off' };
      const cur = (() => {
        const raw = String(process.env.KHY_DESKTOP_CONTROL || '').trim().toLowerCase();
        return VALID[raw] || 'off';
      })();
      if (!arg || arg === 'status') {
        let caps = null;
        try { caps = require('../services/desktopControl').create().capabilities(); } catch { /* optional */ }
        console.log(c.cyan(`  桌面操控当前模式: ${cur}`));
        console.log(c.dim('    off=全拒(默认安全) | ask=每会话审批一次 | strict=每步审批 | on=无人值守自主'));
        if (caps && caps.summary) {
          console.log(c.dim(`    眼(截屏):${caps.summary.canSee ? '✓' : '✗'} 手(鼠标键盘):${caps.summary.canActuate ? '✓' : '✗'} 感知(元素):${caps.summary.canPerceive ? '✓' : '✗'}`));
        }
        console.log(c.dim('    切换: /desktop on | /desktop ask | /desktop strict | /desktop off'));
        rl.prompt();
        return;
      }
      const next = VALID[arg];
      if (!next) {
        console.log(c.yellow(`  未知模式「${arg}」。可用: on / ask / strict / off`));
        rl.prompt();
        return;
      }
      process.env.KHY_DESKTOP_CONTROL = next;
      if (next === 'off') {
        console.log(c.green('  桌面操控已关闭（鼠标/键盘/窗口自动化被拒绝）'));
      } else {
        const note = next === 'on' ? '无人值守自主' : next === 'ask' ? '每会话审批一次' : '每步审批';
        console.log(c.green(`  桌面操控已开启 [${next}] — ${note}`));
        console.log(c.dim('    现在可用自然语言操控，例如「关闭火狐窗口」「激活 VS Code」「打开 example.com」'));
        console.log(c.yellow('    ⚠ 这是高危能力（接管真实鼠标/键盘）。完成后建议 /desktop off 关闭。'));
      }
      rl.prompt();
      return;
    }

    // /local — toggle local mode (force Tier 1 + Tier 2, skip AI model)
    if (trimmed === '/local' || trimmed === '本地模式') {
      _toggleLocalMode();
      rl.prompt();
      return;
    }

    // /fast — toggle fast mode
    if (trimmed === '/fast') {
      _fastMode = !_fastMode;
      printSuccess(`快速模式已${_fastMode ? '开启' : '关闭'}`);
      rl.prompt();
      return;
    }

    // /compact — compact conversation (刀108:对齐 router 富化路径,承刀101-104 drift 家族)
    if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
      const _crAlign = require('./compactResultSummary');
      const _align = _crAlign.compactTwinAlignEnabled(process.env);
      const _isBare = trimmed === '/compact';
      // 门控关 + 带参数形式('/compact <文本>')→ 落回今日路由(此 if 不处理,继续后续匹配)。
      // 门控开 → 裸 /compact 或 /compact <文本> 皆在此处理并镜像 router。
      if (_isBare || _align) {
        printInfo('正在压缩会话上下文...');
        if (!_align) {
          // 门控关(仅裸 /compact 到此)→ 逐字节回退今日 '对话已压缩'。
          try {
            ai().compactConversation && ai().compactConversation();
            printSuccess('对话已压缩');
          } catch (e) { printError(`会话压缩失败: ${e.message}`); }
        } else {
          // 门控开 → 镜像 router:提取自由文本聚焦指令 + 无需压缩/失败分支 + 富化成功行。
          try {
            const _instr = _isBare ? '' : trimmed.slice('/compact'.length).trim();
            let _opts = { mode: 'auto' };
            try {
              _opts = require('./compactInstructions')
                .buildCompactOptions({ args: _instr ? [_instr] : [] }, process.env);
            } catch (_) {}
            const _res = ai().compactConversation ? ai().compactConversation(_opts) : null;
            if (!_res || _res.success === false) {
              printError('会话压缩失败');
            } else if (_res.changed === false) {
              printInfo(`无需压缩：当前消息 ${_res.previousCount}`);
            } else {
              let _line = `会话已压缩：${_res.previousCount} -> ${_res.nextCount}`;
              try { _line = _crAlign.buildCompactSuccessLine(_res, process.env); } catch (_) {}
              printSuccess(_line);
            }
          } catch (e) { printError(`会话压缩失败: ${e.message}`); }
        }
        rl.prompt();
        return;
      }
    }

    if (trimmed === '/folded') {
      const shown = _printFoldedStatusDetails();
      if (!shown) printInfo('暂无折叠状态明细');
      rl.prompt();
      return;
    }

    // /context — show context window usage
    if (trimmed === '/context') {
      try {
        const hud = require('./hudRenderer');
        const s = hud.getState();
        const pct = s.contextWindow.limit > 0 ? Math.round((s.contextWindow.used / s.contextWindow.limit) * 100) : 0;
        const c = chalk();
        // 刀102:键入 /context 孪生对齐它最近的姊妹——菜单 /context 路径(repl.js:3936 selected.flag==='context')。
        // 同一命令概念在同一交互中文面有两条实现:菜单路径早已走 computeContextStats SSOT + 中文健康分级
        // (健康/偏高/接近上限)印 已使用/剩余/会话令牌/请求次数,而**键入** /context 孪生却塌缩成 已使用/会话令牌
        // 两行(自写内联 round、漏 剩余/健康分级/请求次数)= 呈现侧未接的 half-wired 孤儿(承刀101 router-path
        // vs interactive-twin drift 家族)。复用同源 SSOT,渲染留壳,字段/中文措辞/百分比口径与菜单孪生逐字对齐
        // (故门控开时用 stats.percentUsed=min(100,round) 与菜单一致;门控关时回退原内联 pct 保逐字节回退)。
        // 门控 KHY_CONTEXT_PANEL_DETAIL 关 → _stats=null → 逐字节回退刀102前两行。
        let _stats = null;
        try {
          const { computeContextStats } = require('../services/context/ctxWindowStats');
          const { contextPanelDetailEnabled } = require('./contextPanelDetail');
          if (contextPanelDetailEnabled(process.env)) {
            _stats = computeContextStats({
              used: s.contextWindow.used,
              limit: s.contextWindow.limit,
              sessionInput: s.sessionTokens.input,
              sessionOutput: s.sessionTokens.output,
              requestCount: s.requestCount,
              // 刀103:透传 model 供身份详情行(键入孪生此前从不传 → stats.model 恒 '')。
              model: s.lastModel,
            }, process.env);
          }
        } catch { /* fail-soft:富行失败绝不影响基础两行 */ }
        const _statusZh = _stats
          ? ' ' + (_stats.status === 'critical' ? c.red('接近上限') : _stats.status === 'warning' ? c.yellow('偏高') : c.green('健康'))
          : '';
        const _pctShown = _stats ? _stats.percentUsed : pct;
        console.log(c.bold('\n  上下文窗口'));
        console.log(`    已使用: ${_tk1(s.contextWindow.used)} / ${_tk0(s.contextWindow.limit)} 令牌 (${_pctShown}%)${_statusZh}`);
        if (_stats) console.log(`    剩余: ${_tk1(_stats.remaining)} 令牌`);
        console.log(`    会话令牌: ↑${_tk1(s.sessionTokens.input)} ↓${_tk1(s.sessionTokens.output)}`);
        if (_stats) console.log(`    请求次数: ${_stats.requestCount}`);
        // 刀103:补 router 详情行里两条交互中文孪生共漏的 模型 + 上限来源(同源纯叶子·不含 Requests)。
        // 门控关时 _stats=null,for-of 不进,逐字节回退刀102/103前。
        if (_stats) {
          try {
            for (const _l of require('./contextPanelDetail').buildContextIdentityLines(_stats, process.env)) {
              console.log(`    ${c.dim(_l)}`);
            }
          } catch (_) { /* fail-soft:略过身份行 */ }
        }
        // Thread4:per-category 上下文分解网格(与菜单孪生同源,对齐 CC /context 分类可视化)。
        // 门控 KHY_CONTEXT_BREAKDOWN 关 / 无数据 → [] → 逐字节回退(不追加网格)。
        try {
          const { analyzeContextBreakdown, renderContextBreakdownLines } = require('../services/context/contextBreakdown');
          const { estimateTokens } = require('../services/textHeuristics');
          const _sections = [];
          try {
            const { getToolDefinitions } = require('../services/toolCalling');
            const _defs = getToolDefinitions();
            if (Array.isArray(_defs) && _defs.length > 0) {
              _sections.push({ name: 'System tools', text: JSON.stringify(_defs) });
            }
          } catch (_) { /* 注册表不可用则该类别省略 */ }
          const _bd = analyzeContextBreakdown({ contextWindow: s.contextWindow.limit, sections: _sections, estimateTokens }, process.env);
          const _bdLines = renderContextBreakdownLines(_bd, { model: s.lastModel, width: 10, height: 10 }, process.env);
          if (_bdLines.length > 0) {
            console.log('');
            for (const _l of _bdLines) console.log(`    ${c.dim(_l)}`);
          }
          if (_bd) {
            try {
              const { analyzeContextSuggestions, renderContextSuggestionLines } = require('../services/context/contextSuggestions');
              let _tct = null;
              try {
                const { analyzeMessageBreakdown } = require('../services/context/messageBreakdown');
                const _mb = analyzeMessageBreakdown({ messages: ai().getConversation ? ai().getConversation() : [], estimateTokens }, process.env);
                if (_mb && _mb.toolCallsByType && _mb.toolCallsByType.length > 0) _tct = _mb.toolCallsByType;
              } catch (_) { /* honest-NA */ }
              const _sug = analyzeContextSuggestions({ percentage: _bd.percentage, contextWindow: _bd.contextWindow, categories: _bd.categories, toolCallsByType: _tct }, process.env);
              const _sugLines = renderContextSuggestionLines(_sug, {}, process.env);
              if (_sugLines.length > 0) {
                console.log('');
                for (const _l of _sugLines) console.log(`    ${c.dim(_l)}`);
              }
            } catch (_) { /* fail-soft:略过建议 */ }
          }
        } catch (_) { /* fail-soft:略过分解网格 */ }
        console.log('');
      } catch (e) { printError(`上下文窗口读取失败: ${e.message}`); }
      rl.prompt();
      return;
    }

    // /diff — show git diff
    if (trimmed === '/diff') {
      try {
        const { execFileSync } = require('child_process');
        // --no-index 在有差异时退出码为 1(execFileSync 抛),diff 文本在 e.stdout,须捕获。
        const runGit = (args) => {
          try { return { stdout: execFileSync('git', args, { encoding: 'utf-8', timeout: 8000, maxBuffer: 1 << 24 }) }; }
          catch (e) { return { stdout: (e && e.stdout) ? String(e.stdout) : '' }; }
        };
        const diff = require('./gitDiffCollect').collectWorkingTreeDiff(runGit, process.env).trim();
        if (diff) {
          // 统一 diff 按行首着色:新增绿、删除红、头部/上下文 dim(见上方 flag==='diff' 同款说明)。
          console.log(require('./diffRenderer').renderDiff(diff));
        } else {
          printInfo('当前没有未提交变更');
        }
      } catch (e) { printError(`Git 差异读取失败: ${e.message}`); }
      rl.prompt();
      return;
    }

    // /status — show current status
    if (trimmed === '/status') {
      try {
        const hud = require('./hudRenderer');
        hud.refreshGit();
        const s = hud.getState();
        const c = chalk();
        // 刀101:交互式 /status 孪生对齐 router 路径(刀94)——补 CC status.tsx 点名的 Model + Account
        // 及 git ahead/behind。router case 'status'(router.js:1700)已走 statusPanelExtras 叶子,此交互
        // 孪生却只印 分支/上下文窗口/请求次数三行(漏 Model/Account/ahead-behind)= 呈现侧未接的 half-wired
        // 孤儿。复用同一 statusPanelExtras 叶子(模型友好名走 formatModelLabel SSOT 由此壳注入),渲染留壳;
        // 门控 KHY_STATUS_PANEL_DETAIL 关 → 三片全空 → 逐字节回退刀101前三行。
        let extras = { model: null, account: null, gitSuffix: '' };
        try {
          const { buildStatusPanelExtras } = require('./statusPanelExtras');
          const { formatModelLabel } = require('./ccModelName');
          extras = buildStatusPanelExtras(s, { formatModelLabel }, process.env);
        } catch { /* fail-soft:额外三片失败绝不影响主 /status */ }
        console.log(c.bold('\n  状态'));
        if (extras.model) console.log(`    模型: ${extras.model}`);
        if (extras.account) console.log(`    账户: ${extras.account}`);
        if (s.git.branch) console.log(`    分支: ${s.git.branch}${s.git.dirty ? ` (${s.git.dirtyCount} 处变更)` : ''}${extras.gitSuffix}`);
        console.log(`    上下文窗口: ${Math.round(s.contextWindow.used/1000)}k/${Math.round(s.contextWindow.limit/1000)}k`);
        console.log(`    请求次数: ${s.requestCount}`);
        console.log('');
      } catch (e) { printError(`状态读取失败: ${e.message}`); }
      rl.prompt();
      return;
    }

    // /mind — inspect AI task mind-map state
    const mindMatch = trimmed.match(/^\/mind(?:\s+(show|status|on|off|reset))?$/i);
    if (mindMatch) {
      const action = String(mindMatch[1] || 'show').toLowerCase();
      if (action === 'on') {
        _taskMindMapAutoShow = true;
        printSuccess('已开启认知双图自动展示');
      } else if (action === 'off') {
        _taskMindMapAutoShow = false;
        printSuccess('已关闭认知双图自动展示');
      } else if (action === 'reset') {
        _resetCognitionMapsToStartNode();
        printSuccess('认知双图已重置到起点');
      } else {
        _renderTaskMindMap('manual');
        printInfo(`自动展示: ${_taskMindMapAutoShow ? '开启' : '关闭'}`);
      }
      rl.prompt();
      return;
    }

    const intentMatch = trimmed.match(/^\/intent(?:\s+(show|status|on|off))?$/i);
    if (intentMatch) {
      const action = String(intentMatch[1] || 'show').toLowerCase();
      if (action === 'on') {
        _intentAssuranceDebugEnabled = true;
        process.env.KHY_INTENT_ASSURANCE_DEBUG = 'true';
        const persisted = _persistBooleanKhySetting(INTENT_ASSURANCE_DEBUG_SETTING_KEY, true);
        printSuccess('已开启意图保护调试显示');
        if (!persisted) printWarn('意图保护调试已开启，但保存设置失败');
      } else if (action === 'off') {
        _intentAssuranceDebugEnabled = false;
        process.env.KHY_INTENT_ASSURANCE_DEBUG = 'false';
        const persisted = _persistBooleanKhySetting(INTENT_ASSURANCE_DEBUG_SETTING_KEY, false);
        printSuccess('已关闭意图保护调试显示');
        if (!persisted) printWarn('意图保护调试已关闭，但保存设置失败');
      } else {
        _printIntentAssuranceDebugSnapshot(_lastIntentAssuranceDebug, 'manual');
      }
      rl.prompt();
      return;
    }

    // /stats — show session statistics
    if (trimmed === '/stats') {
      try {
        const hud = require('./hudRenderer');
        const s = hud.getState();
        const c = chalk();
        const elapsed = ((Date.now() - _sessionStart) / 1000 / 60).toFixed(1);
        console.log(c.bold('\n  会话统计'));
        console.log(`    时长: ${elapsed} 分钟`);
        console.log(`    请求次数: ${s.requestCount}`);
        console.log(`    令牌用量: ↑${_tk1(s.sessionTokens.input)} ↓${_tk1(s.sessionTokens.output)}`);
        console.log(`    工具调用: ${s.toolHistory.length} 次`);
        // 刀104:补 router /stats(router.js:1679)已呈现、两交互中文孪生共漏的对话构成
        // (消息按角色分布)——走 ai.getConversationStats() live 数据,fail-soft。
        try {
          const _cs = ai().getConversationStats && ai().getConversationStats();
          for (const _l of require('./statsConversationLines').buildConversationCompositionLines(_cs, process.env)) {
            console.log(`    ${_l}`);
          }
        } catch (_) { /* fail-soft:略过对话构成行 */ }
        console.log('');
      } catch (e) { printError(`会话统计读取失败: ${e.message}`); }
      rl.prompt();
      return;
    }

    // /env — environment info
    if (trimmed === '/env') {
      const c = chalk();
      console.log(c.bold('\n  环境信息'));
      // 刀109:键入 /env 孪生对齐菜单孪生超集(承刀103/104 change-both-twins)。门控关 →
      // 逐字节回退今日 5 行(平台/Node/工作目录/Shell/版本)。门控开 → 复用 envInfoLines SSOT
      // 叶子(补 终端 + Git 分支,与菜单孪生逐字段一致)。
      const _envLeaf = (() => { try { return require('./envInfoLines'); } catch { return null; } })();
      if (_envLeaf && _envLeaf.envInfoAlignEnabled(process.env)) {
        let _branch = '';
        try { _branch = require('child_process').execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 2000 }).trim(); } catch (_) { /* not a git repo */ }
        for (const _l of _envLeaf.buildEnvInfoLines({
          platform: process.platform, arch: process.arch, nodeVersion: process.version,
          cwd: process.cwd(), shell: process.env.SHELL, term: process.env.TERM,
          version: VERSION, gitBranch: _branch,
        })) console.log(_l);
      } else {
        console.log(`    平台: ${process.platform} ${process.arch}`);
        console.log(`    Node: ${process.version}`);
        console.log(`    工作目录: ${process.cwd()}`);
        console.log(`    Shell: ${process.env.SHELL || 'N/A'}`);
        console.log(`    版本: ${VERSION}`);
      }
      console.log('');
      rl.prompt();
      return;
    }

    // /tasks — task runtime inspect & control
    const tasksCmdMatch = trimmed.match(/^\/tasks(?:\s+([\s\S]+))?$/i);
    if (tasksCmdMatch) {
      await _handleTasksCommand(tasksCmdMatch[1] || '');
      rl.prompt();
      return;
    }

    // /worktree <enter|exit|list|status> — manual isolated git-worktree control.
    // Subcommands carry args (a space), so they land here rather than the bare
    // exact-match slash path; both reuse repl/worktreeCommand and keep
    // _atCurrentDir aligned with the KHYQUANT_CWD + chdir switch.
    const worktreeCmdMatch = trimmed.match(/^\/worktree(?:\s+([\s\S]+))?$/i);
    if (worktreeCmdMatch) {
      try {
        const { runWorktreeCommand } = require('./repl/worktreeCommand');
        await runWorktreeCommand(worktreeCmdMatch[1] || '', { onCwdChange: (t) => { _atCurrentDir = t; } });
      } catch (e) { printError(`/worktree 执行失败: ${e.message}`); }
      rl.prompt();
      return;
    }

    // /max, /high, /medium, /low — effort level switching
    const effortMatch = trimmed.match(/^\/(max|high|medium|low)$/);
    if (effortMatch) {
      const level = effortMatch[1];
      if (ai().setEffort(level)) {
        const presets = ai().getEffortPresets();
        const p = presets[level];
        printSuccess(`模型精度已切换: ${level} (${p.label}) — temp=${p.temperature}, maxTokens=${p.maxTokens}`);
      } else {
        printError('无效的精度级别');
      }
      rl.prompt();
      return;
    }

    // ── Clipboard image bridge commands (Windows bitmap -> file path) ────
    const clipBridgeMatch = /^(?:clipboard\s+bridge|clipboard\s+img2file|剪贴板桥接)(?:\s+(.+))?$/i.exec(trimmed);
    if (clipBridgeMatch) {
      const action = String(clipBridgeMatch[1] || 'status').trim().toLowerCase();
      try {
        const bridge = require('../services/windowsClipboardImg2FileService');
        const showStatus = () => {
          const status = bridge.getClipboardImg2FileBridgeStatus();
          if (!status.supported) {
            printInfo('图片粘贴桥接仅支持 Windows 平台');
            return;
          }
          if (!status.enabled) {
            printInfo('图片粘贴桥接已禁用（设置 KHY_CLIPBOARD_IMG2FILE_ENABLED=true 可启用）');
            return;
          }
          if (status.running) {
            const pollMs = status.meta?.pollMs || 500;
            const keepFiles = status.meta?.keepFiles || 8;
            printSuccess(`图片粘贴桥接运行中：位图监听 ${pollMs}ms/次，保留最近 ${keepFiles} 张，PID ${status.pid}`);
          } else {
            printInfo('图片粘贴桥接未运行，可执行: clipboard bridge start');
          }
        };

        if (action === 'start' || action === 'on' || action === 'enable' || action === '开启') {
          const result = bridge.startClipboardImg2FileBridge();
          if (result.started) {
            const pollMs = result.meta?.pollMs || 500;
            printSuccess(`图片粘贴桥接已启动：监听位图剪贴板并注入路径文本（轮询 ${pollMs}ms）`);
          } else if (result.reason === 'already_running') {
            printInfo('图片粘贴桥接已在运行中');
          } else {
            showStatus();
          }
        } else if (action === 'stop' || action === 'off' || action === 'disable' || action === '关闭') {
          const stopped = bridge.stopClipboardImg2FileBridge();
          if (stopped) printSuccess('图片粘贴桥接已停止');
          else printInfo('图片粘贴桥接未运行');
        } else if (action === 'restart' || action === '重启') {
          bridge.stopClipboardImg2FileBridge();
          const result = bridge.startClipboardImg2FileBridge();
          if (result.started || result.reason === 'already_running') {
            printSuccess('图片粘贴桥接重启完成');
          } else {
            showStatus();
          }
        } else if (action === 'help' || action === 'h' || action === '?') {
          printInfo('用法: clipboard bridge [status|start|stop|restart]');
          printInfo('说明: 自动把剪贴板位图转换为 PNG 文件路径，便于在 CLI 中 Ctrl+V');
        } else {
          showStatus();
        }
      } catch (err) {
        printError(`图片粘贴桥接操作失败: ${err.message}`);
      }
      rl.prompt();
      return;
    }

    // ── Clipboard relay commands ──────────────────────────────────
    const clipRelayMatch = /^(?:clipboard\s+relay|剪贴板中继|webai)(?:\s+(.+))?$/i.exec(trimmed);
    if (clipRelayMatch) {
      const subCmd = (clipRelayMatch[1] || '').trim().toLowerCase();

      try {
        const clipAdapter = require('../services/gateway/adapters/clipboardRelayAdapter');

        // Sub-commands: service list, service set, open, or direct prompt
        if (subCmd === 'list' || subCmd === '列表') {
          const services = clipAdapter.getServices();
          const current = clipAdapter.getPreferredService();
          printInfo('可用的 Web AI 服务:');
          for (const [key, svc] of Object.entries(services)) {
            const marker = key === current ? c.green(' ← 当前') : '';
            console.log(`  ${c.cyan(key.padEnd(10))} ${svc.name.padEnd(20)} ${c.dim(svc.url)}${marker}`);
          }
        } else if (subCmd.startsWith('set ') || subCmd.startsWith('切换 ')) {
          const serviceKey = subCmd.replace(/^(set|切换)\s+/i, '').trim();
          if (clipAdapter.setService(serviceKey)) {
            const services = clipAdapter.getServices();
            printSuccess(`已切换到 ${services[serviceKey].name}`);
          } else {
            printError(`未知服务: ${serviceKey} — 运行 clipboard relay list 查看可用服务`);
          }
        } else if (subCmd === 'open' || subCmd === '打开') {
          const services = clipAdapter.getServices();
          const current = clipAdapter.getPreferredService();
          const svc = services[current];
          clipAdapter.openBrowser(svc.url);
          printInfo(`已打开 ${svc.name}: ${svc.url}`);
        } else if (subCmd === 'status' || subCmd === '状态' || !subCmd) {
          const status = clipAdapter.getStatus();
          if (status.available) {
            printSuccess(status.detail);
          } else {
            printError(status.detail);
          }
        } else {
          // Treat as a prompt to relay via clipboard
          _busy = true;
          _startBusyPromptKeepalive();
          try {
            const result = await clipAdapter.generate(subCmd);
            if (result.success) {
              const renderer = require('./aiRenderer');
              renderer.printStepLine('success', 'AI 回复', result.provider);
              const rendered = renderer.renderAiResponse(result.content);
              rendered.split('\n').forEach(l => console.log(`  ${l}`));
            } else {
              printError(result.content);
            }
          } finally {
            _busy = false;
          }
        }
      } catch (err) {
        printError(`剪贴板中继失败: ${err.message}`);
      }
      rl.prompt();
      return;
    }

    // Image analysis — file path or clipboard paste
    const imageMatch = trimmed.match(/^(?:image|图片|img)\s+(.+?\.(png|jpg|jpeg|gif|webp))\s*(.*)/i);
    const pasteMatch = /^(?:paste|粘贴|clipboard|剪贴板)(?:\s+(.*))?$/i.exec(trimmed);
    const sceneHint = buildImageSceneHint(trimmed, history);
    const inlineImage = (!imageMatch && !pasteMatch) ? extractInlineImageIntent(trimmed, sceneHint) : null;

    // Bare image-recognition intent with NO attached image / path (e.g. 裸「图片识别」).
    // Deterministic guard so it does NOT fall into the agentic loop and blindly glob the
    // filesystem for images. Gated KHY_IMAGE_INTENT_GUARD (default on); off → byte fallback.
    //   clipboard-image → auto-use the clipboard image (Q1), reuse the vision/OCR path below;
    //   no-image-reply   → deterministic guidance, no model call (Q2).
    const imgAssist = (!imageMatch && !pasteMatch && !inlineImage)
      ? resolveImageRecognitionAssist(trimmed, { hasImages: false })
      : null;
    if (imgAssist && imgAssist.handled && imgAssist.action === 'no-image-reply') {
      imgAssist.reply.split('\n').forEach(l => console.log(`  ${l}`));
      console.log('');
      rl.prompt();
      return;
    }
    const clipboardAssist = (imgAssist && imgAssist.handled && imgAssist.action === 'clipboard-image')
      ? imgAssist : null;

    if (imageMatch || pasteMatch || inlineImage || clipboardAssist) {
      let _imgAck = null; // 声明于 try 前,使 finally 处 disarm 可见
      try {
        const imageService = require('../services/imageService');
        const renderer = require('./aiRenderer');
        let image, prompt;

        if (imageMatch || inlineImage) {
          // File path mode
          const filePath = imageMatch ? imageMatch[1] : inlineImage.filePath;
          prompt = imageMatch
            ? buildContextualImagePrompt(imageMatch[3] || '', sceneHint)
            : inlineImage.prompt;
          const readStart = Date.now();
          image = imageService.readImageFromFile(filePath);
          renderer.printToolCallResult('Read', { path: filePath }, 'success',
            `${image.format.toUpperCase()}, ${_formatImageSize(image.sizeBytes)}`,
            Date.now() - readStart
          );
        } else {
          // Clipboard paste mode (explicit /paste, or auto-picked bare「图片识别」via clipboardAssist)
          prompt = clipboardAssist
            ? clipboardAssist.text
            : buildContextualImagePrompt(
                pasteMatch[1] || '',
                buildImageSceneHint('clipboard paste image', history),
              );
          const readStart = Date.now();
          image = imageService.readImageFromClipboard();
          renderer.printToolCallResult('Clipboard', 'clipboard', 'success',
            `${image.format.toUpperCase()}, ${_formatImageSize(image.sizeBytes)}`,
            Date.now() - readStart
          );
        }

        // Show preview
        imageService.printImagePreview(image);

        // Send to AI with vision
        _busy = true;
        _startBusyPromptKeepalive();
        _imgAck = _armImageAck(); // 图片非流式 await 前武装首响应守护
        const aiResult = await ai().chat(prompt, {
          images: [{ base64: image.base64, mimeType: image.mimeType }],
        });

        if (aiResult.reply) {
          if (aiResult.errorType) {
            const rendered = _renderAiErrorCompact(aiResult.reply);
            if (!rendered?.merged) {
              printInfo('提示: 可用 /model 切换到支持视觉的模型后重试');
            }
          } else {
            renderer.printStepLine('success', 'AI 图片分析', aiResult.provider || 'vision');
            const rendered = renderer.renderAiResponse(aiResult.reply);
            rendered.split('\n').forEach(l => console.log(`  ${l}`));
          }
        } else {
          printInfo('AI 未返回分析结果 — 当前 AI 服务可能不支持图片分析');
        }
        console.log('');
      } catch (imgErr) {
        // 刀107:同上——图像粘贴 chat() 子流 abort 兜底,补记中断标记(仅 abort·fail-soft)。
        try {
          if (imgErr && (imgErr.name === 'AbortError' || imgErr.code === 'ABORT_ERR')) ai().recordInterruption('');
        } catch { /* best effort */ }
        printError(`图片处理失败: ${imgErr.message}`);
      } finally {
        try { if (_imgAck) _imgAck.disarm(); } catch { /* 守护解除失败不影响主流程 */ }
        _busy = false;
      }
      rl.prompt();
      return;
    }

    // Prevent concurrent command execution
    if (_busy) {
      _suppressBusyInterjectPromptUntilNextInput();
      const busyMindMatch = trimmed.match(/^\/mind(?:\s+(show|status|on|off|reset))?$/i);
      if (busyMindMatch) {
        const action = String(busyMindMatch[1] || 'show').toLowerCase();
        if (action === 'on') {
          _taskMindMapAutoShow = true;
          printSuccess('已开启认知双图自动展示');
        } else if (action === 'off') {
          _taskMindMapAutoShow = false;
          printSuccess('已关闭认知双图自动展示');
        } else if (action === 'reset') {
          _resetCognitionMapsToStartNode();
          printSuccess('认知双图已重置到起点');
        } else {
          _renderTaskMindMap('live');
          printInfo(`自动展示: ${_taskMindMapAutoShow ? 'on' : 'off'}`);
        }
        showBusyInterjectPrompt();
        return;
      }

      const busyIntentMatch = trimmed.match(/^\/intent(?:\s+(show|status|on|off))?$/i);
      if (busyIntentMatch) {
        const action = String(busyIntentMatch[1] || 'show').toLowerCase();
        if (action === 'on') {
          _intentAssuranceDebugEnabled = true;
          process.env.KHY_INTENT_ASSURANCE_DEBUG = 'true';
          const persisted = _persistBooleanKhySetting(INTENT_ASSURANCE_DEBUG_SETTING_KEY, true);
          printSuccess('已开启意图保护调试显示');
          if (!persisted) printWarn('意图保护调试已开启，但保存设置失败');
        } else if (action === 'off') {
          _intentAssuranceDebugEnabled = false;
          process.env.KHY_INTENT_ASSURANCE_DEBUG = 'false';
          const persisted = _persistBooleanKhySetting(INTENT_ASSURANCE_DEBUG_SETTING_KEY, false);
          printSuccess('已关闭意图保护调试显示');
          if (!persisted) printWarn('意图保护调试已关闭，但保存设置失败');
        } else {
          _printIntentAssuranceDebugSnapshot(_lastIntentAssuranceDebug, 'manual');
        }
        showBusyInterjectPrompt();
        return;
      }

      // /interrupt (or /i) while busy: request cancellation and prioritize next input
      const interruptMatch = /^\/(?:interrupt|i)\s+([\s\S]+)$/i.exec(trimmed);
      if (interruptMatch) {
        const nextInput = interruptMatch[1].trim();
        if (!nextInput) {
          printInfo('用法: /interrupt <新输入> 或 /i <新输入>');
          return;
        }
        _queuedInputs.unshift(nextInput);
        const cancelled = _requestRelayCancel('Interrupted by /interrupt');
        if (cancelled) {
          console.log(c.dim('  ⚡ 已发送中断信号，完成后优先处理新输入'));
        } else {
          console.log(c.dim('  ⚡ 已记录中断请求，将在当前步骤结束后优先处理新输入'));
        }
        showBusyInterjectPrompt();
        return;
      }

      // ── 3 模式忙碌输入分流 (queue/steer/interrupt) ──────────────
      const classified = _classifyBusyInput(trimmed);
      if (classified.mode === 'steer' && _isBusyInterjectionNewTopic(classified.text)) {
        // steer 命中方向词，但与当前运行话题几乎无重叠 → 判为「转向新话题」→ 降级为排队，
        // 作为独立新 turn 在收口后执行，不中途注入污染当前任务。门控关时该判定恒 false。
        console.log(c.dim('  ⤳ 检测到新话题，已改为排队（不打断当前任务）'));
        _busyQueueWithMerge(trimmed);
        return;
      }
      if (classified.mode === 'steer') {
        _steerQueue.push(classified.text);
        const steerPreview = _summarizeQueuedInputForDisplay(classified.text, 40);
        console.log(c.hex('#D77757')(`  ⟳ 已注入方向修正: "${steerPreview}"`));
        console.log(c.dim(`    └ ${_describeSteerLanding()}`));
        showBusyInterjectPrompt();
        return;
      } else if (classified.mode === 'interrupt') {
        _queuedInputs.unshift(classified.text);
        const cancelled = _requestRelayCancel('Interrupted by auto-detected interrupt');
        if (cancelled) {
          console.log(c.hex('#FF6B80')(`  ⚡ 已发送中断信号，完成后优先处理新输入`));
        } else {
          console.log(c.hex('#FF6B80')(`  ⚡ 已记录中断请求，将在当前步骤结束后优先处理新输入`));
        }
        showBusyInterjectPrompt();
        return;
      }
      // queue 模式：沿用 merge-aware 排队
      _busyQueueWithMerge(trimmed);
      return;
    }
    _busy = true;
    _busyTurnText = trimmed; // 记录本 turn 话题基线，供忙碌插话的换话题判定使用
    _busyHintShownAt = 0; // 重置 hint 计时，确保首次立即显示
    _busyInterjectRequested = false;
    _busyPromptSuppressedUntilInput = false;
    _startBusyPromptKeepalive();
    showBusyInterjectPrompt();

    // Suspend vim handler during command execution (raw mode conflicts)
    if (_vimHandler) try { _vimHandler.suspend(); } catch { /* ignore */ }

    // Save to history
    history.push(trimmed);

    // Parse and route the command
    const parsed = parseInput(trimmed);
    if (!parsed) {
      _busy = false;
      rl.prompt();
      return;
    }

    let agentTreeCtrl = null;
    let _adapterStatusHandler = null;
    // 首响应静默窗口守护调度器句柄。**声明在 try 之外**(与 finally 同作用域),实体在
    // spinner.start('request') 处创建 + arm(那里 renderer / _turnAckEmitted 均在作用域内);
    // onChunk 首 chunk markChunk、finally disarm 都用它 → 三处都能看见。
    let _firstResponseAckScheduler = null;
    try {
      _featureCapabilityMap.markCommandParsed(parsed);
      const result = await route(parsed);
      _featureCapabilityMap.markRouteResult(result);

      // Restore stdin/readline after route handlers that may use inquirer internally.
      // Inquirer creates its own readline and may pause stdin, leaving our rl deaf.
      recoverReadlineInput();

      // Claude Code style: /clear clears screen + conversation history.
      // /new 与 /reset 语义同为「清空当前会话上下文」(见斜杠面板描述),一并在此处理:
      // 清历史 + 清熔断器(误锁自愈) + 重绘。
      if (parsed.command === 'clear' || parsed.command === 'new' || parsed.command === 'reset') {
        try { ai().clearHistory(); } catch {}
        if (_queryEngine) {
          try { _queryEngine.clearHistory(); } catch {}
        }
        _resetGatewayBreakerOnSessionClear();
        // Reprint startup header after a hard screen reset.
        // Avoid router-level + frame-level double clear artifacts.
        try { leaveInputPromptFrame(); } catch {}
        try {
          if (process.stdout.isTTY) {
            readline.cursorTo(process.stdout, 0, 0);
            readline.clearScreenDown(process.stdout);
          } else {
            console.clear();
          }
        } catch { console.clear(); }
        _startupHeaderRendered = false;
        try { renderStartupHeader(true); } catch {}
      }

      if (result === 'exit') {
        const savedMeta = ai().saveConversation();
        saveHistory(history);
        setTerminalTitle(''); // restore terminal title
        console.log('');
        console.log(c.cyan(`  ${MASCOT_MINI} `) + c.dim(getRandomFarewell()));
        printResumeRecoveryHints(savedMeta);
        console.log('');
        _uninstallBusyPromptConsolePatch();
        _intentionalExit = true; process.exit(0);
      }

      if (result === 'menu') {
        let menuResult;
        do {
          menuResult = await menu().runMenuLoop();
          await executeMenuResult(menuResult);
        } while (menuResult !== null);
        rl.prompt();
        return;
      }

      if (result === 'ai-status') {
        await ai().handleAiStatus();
        rl.prompt();
        return;
      }

      if (result === 'ai-config') {
        await ai().handleAiConfig();
        rl.prompt();
        return;
      }

      if (result === 'ai-on' || result === 'ai-off') {
        // AI is always on — no manual toggle needed
        printInfo('AI 对话已默认开启，无需手动切换');
        rl.prompt();
        return;
      }

      if (result === true) {
        // Command was handled — track it
        if (parsed && parsed.command) userProfile().trackCommand(parsed.command);

        // Record command sequence for pattern learning
        if (parsed && parsed.command) {
          _recentCommands.push(trimmed);
          if (_recentCommands.length > PATTERN_WINDOW) _recentCommands.shift();

          // Record workflow step for habit optimization
          try {
            const { recordWorkflowStep, recordInteraction: recordHabit } = require('../services/usageHabitService');
            recordHabit(trimmed);
            if (_recentCommands.length >= 2) {
              recordWorkflowStep(_recentCommands.slice(-2));
            }
          } catch { /* best effort */ }

          // Check for patterns when we have enough commands
          if (_recentCommands.length >= 2) {
            try {
              const { recordCommandSequence } = require('../services/skillLearningService');
              const suggestion = recordCommandSequence(_recentCommands.slice(-3));
              if (suggestion && suggestion.suggest) {
                console.log('');
                console.log(c.hex('#FFC107')(`  Detected repeated operation pattern (${suggestion.count} times):`));
                console.log(c.dim(`     ${suggestion.sequence.join(' → ')}`));
                console.log(c.dim(`     输入 skill learn workflow "${suggestion.sequence.join(' → ')}" 自动化`));
                console.log('');
              }
            } catch { /* pattern learning is best-effort */ }
          }
        }

        rl.prompt();
        return;
      }

      // result.aiForward → a command generated a prompt for AI
      const aiInput = (result && result.aiForward) ? result.aiForward : trimmed;

      // Natural-language model switch (TUI parity): a plain prose line like
      // 「切换模型到 deepseek」/「switch model to deepseek」 is intercepted BEFORE the
      // AI turn — it opens the SAME /model catalog filtered to that vendor (each
      // provider/official = a distinct choice), or switches directly when the named
      // model uniquely matches. Via the pure leaf nlModelSwitchResolver (zero IO,
      // deterministic, three-gate zero-false-positive). Only genuine prose is
      // considered (never a command-generated aiForward). Never throws; gated
      // KHY_NL_MODEL_SWITCH (default on) → off / non-match / require-fail falls
      // through to the AI turn byte-for-byte.
      if (!(result && result.aiForward)) {
        try {
          const nl = require('./nlModelSwitchResolver');
          const hit = nl.resolve(trimmed, process.env);
          if (hit) {
            await require('./handlers/gateway').handleModelSwitchByVendor({ vendor: hit.vendor, modelHint: hit.model });
            _busy = false;
            recoverReadlineInput();
            rl.prompt();
            return;
          }
        } catch { /* best-effort; fall through to the AI turn */ }
      }

      // Unrecognized command → auto-route to AI (always on)

      // result === false or aiForward → send to AI
      let streamState = {
        phase: 'idle',
        thinkingStarted: false,
        textStarted: false,
        thinkingLineOpen: false,
        thinkingCol: 0,
        _textBuffer: '',
        _streamedTextLen: 0,
        _deliveryGapPending: false,
      };

      // turn 级即时确认「先回应用户,再干活」的 turn 级状态。**闭包变量而非 streamState 字段**:
      // streamState 在工具循环每次迭代(chatFn :7064)整体重建,若放进 streamState 会被每轮清空 →
      // ack 每次迭代重放。闭包变量落在本「用户回合」作用域,横跨所有迭代只判一次(_turnAckEmitted)。
      let _turnAckEmitted = false;      // 本回合是否已注入过 ack(每回合至多一次)
      let _turnAckSawText = false;      // 本回合模型是否已自出文本(已回应 → 不叠加)
      const _turnAckIndex = (_replTurnAckSeq++); // 轮换序号(治单调,跨回合递增)
      // 回合内「用户可见中间消息」逐字节去重集(KHY_VISION_NOTICE_DEDUP;/goal「减少心灵噪音」)。
      // **闭包变量而非 streamState 字段**(同 _turnAckEmitted):streamState 每次工具迭代整体重建,
      // 放进去会被清空 → 去重失效;落在本「用户回合」作用域,横跨所有迭代累积 → 同一句话一回合只渲染一次。
      const _visionNoticeSeen = new Set();

      // G1/G2: 初始化 LineBuffer + AdaptiveChunker
      // Streaming Markdown: wrap render callback through MarkdownStreamState
      // so blocks are committed at structural boundaries, not arbitrary chunk edges.
      streamState._streamingMd = _createStreamingMdState();
      streamState._lineBuffer = new LineBuffer();
      streamState._chunker = new AdaptiveChunker(streamState._lineBuffer, (text) => {
        if (streamState._streamingMd) {
          streamState._streamingMd.feed(text);
        } else {
          const trimmed = text.trim();
          if (trimmed) _renderTextBlock(trimmed);
        }
      });

      // Update terminal title with user's topic immediately
      updateTitleFromConversation(aiInput);

      // Merge any queued /btw hints into the input(经纯叶子单一真源拼接格式;无提示 → 逐字节不变)。
      let finalAiInput = aiInput;
      if (_btwQueue.count() > 0) {
        finalAiInput = _btwNote.mergeHints(aiInput, _btwQueue.drainAll());
      }

      // ── Resolve @path file mentions ──
      // 单一真源 cli/atMentionInject.resolveAtMentions(TUI 与本 REPL 共用,避免两套正则/敏感清单漂移)。
      // 本处仅负责把它返回的 reads/blocked 渲染成 REPL 既有的 Read 行 / Security 提示。
      try {
        const { resolveAtMentions } = require('./atMentionInject');
        const at = resolveAtMentions(finalAiInput, { cwd: process.env.KHYQUANT_CWD || process.cwd() });
        for (const b of at.blocked) {
          printInfo(`Security: blocked reading sensitive file via @mention: ${String(b).toLowerCase()}`);
        }
        if (at.reads.length > 0) {
          const renderer = require('./aiRenderer');
          for (const r of at.reads) {
            renderer.printStepLine('success', 'Read', r.kind === 'dir' ? r.relPath + '/' : r.relPath, r.sizeInfo);
          }
        }
        finalAiInput = at.text;
      } catch { /* @mention resolution is best-effort */ }

      // Detect inline image paths (file:///...png, /path/to/img.jpg, etc.)
      // If found, extract image and send via vision API instead of text-only chat.
      let _inlineImageOpts = null;
      try {
        const _imgIntent = extractInlineImageIntent(finalAiInput, buildImageSceneHint(finalAiInput, history));
        if (_imgIntent) {
          const imageService = require('../services/imageService');
          const image = imageService.readImageFromFile(_imgIntent.filePath);
          _inlineImageOpts = {
            images: [{ base64: image.base64, mimeType: image.mimeType }],
          };
          finalAiInput = _imgIntent.prompt || '请分析这张图片的内容';
          const renderer = require('./aiRenderer');
          renderer.printStepLine('success', 'Read', _imgIntent.filePath,
            `${image.format.toUpperCase()}, ${_formatImageSize(image.sizeBytes)}`);
          imageService.printImagePreview(image);
        }
      } catch (imgErr) {
        printInfo(`图片读取失败: ${imgErr.message}，将作为文本发送`);
      }

      // Detect file paths in input (drag-and-drop support)
      // Strips quotes, resolves paths. Supports files, directories, and archives.
      try {
        const fileExts = /\.(txt|js|jsx|ts|tsx|mjs|cjs|py|json|csv|md|log|yaml|yml|toml|html|css|scss|less|vue|sql|sh|bat|ps1|xml|ini|cfg|conf|java|go|rs|c|cpp|h|hpp|rb|php|swift|kt|dart|r|lua|pl|ex|exs|zig|proto|graphql)$/i;
        const archiveExts = /\.(zip|tar|tar\.gz|tgz|gz|bz2|xz)$/i;
        // Strip outer quotes, normalize path separators for Windows
        const stripped = path.normalize(
          finalAiInput.replace(/^['"`]+|['"`]+$/g, '').replace(/\\ /g, ' ')
        );
        let pathCandidate;
        if (/^[A-Za-z]:[\\/]/.test(stripped)) {
          // Windows drive-letter path — match greedily up to known extension
          const extMatch = stripped.match(/^(.+?\.(?:txt|js|jsx|ts|tsx|mjs|cjs|py|json|csv|md|log|yaml|yml|toml|html|css|scss|less|vue|sql|sh|bat|ps1|xml|ini|cfg|conf|java|go|rs|c|cpp|h|hpp|rb|php|swift|kt|dart|r|lua|pl|ex|exs|zig|proto|graphql|zip|tar\.gz|tgz|tar|gz|bz2|xz|gguf|safetensors))\b/i);
          pathCandidate = extMatch ? extMatch[1] : stripped.split(/\s+/)[0];
        } else {
          // Try greedy extension match first (handles paths with spaces escaped by shell)
          const extMatch = stripped.match(/^(.+?\.(?:txt|js|jsx|ts|tsx|mjs|cjs|py|json|csv|md|log|yaml|yml|toml|html|css|scss|less|vue|sql|sh|bat|ps1|xml|ini|cfg|conf|java|go|rs|c|cpp|h|hpp|rb|php|swift|kt|dart|r|lua|pl|ex|exs|zig|proto|graphql|zip|tar\.gz|tgz|tar|gz|bz2|xz|gguf|safetensors))\b/i);
          pathCandidate = extMatch ? extMatch[1] : stripped.split(/\s+/)[0];
        }
        // WSL: convert Windows paths (C:\Users\...) to /mnt/c/Users/...
        if (/^[A-Za-z]:[\\/]/.test(pathCandidate) && process.platform === 'linux') {
          const drive = pathCandidate[0].toLowerCase();
          if (fs.existsSync(`/mnt/${drive}`) || fs.existsSync('/mnt/c')) {
            pathCandidate = `/mnt/${drive}/${pathCandidate.slice(3).replace(/\\/g, '/')}`;
          }
        }
        const BLOCKED_NAMES = ['.env', '.pem', '.key', '.crt', '.pfx', '.p12', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'credentials', 'secret', 'token', '.admin_initial_password', '.htpasswd', 'shadow', '.netrc', '.pgpass'];
        const BLOCKED_EXTS = ['.pem', '.key', '.crt', '.pfx', '.p12', '.jks', '.keystore'];
        const resolvedPath = path.isAbsolute(pathCandidate) ? pathCandidate : path.resolve(process.env.KHYQUANT_CWD || process.cwd(), pathCandidate);
        const basename = path.basename(resolvedPath).toLowerCase();
        const ext = path.extname(resolvedPath).toLowerCase();
        const isBlocked = BLOCKED_NAMES.some(b => basename === b || basename.startsWith(b + '.') || basename.endsWith(b)) || BLOCKED_EXTS.includes(ext);
        if (isBlocked) {
          printInfo(`Security: blocked reading sensitive file: ${basename}`);
        } else if ((() => {
          // Model path detection: ZIP/dir/.gguf that looks like a model file
          try {
            const { looksLikeModelPath } = require('../services/modelImportService');
            return looksLikeModelPath(resolvedPath);
          } catch { return false; }
        })()) {
          // Detected model file — ask user before importing
          const stat = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath) : null;
          const sizeStr = stat ? `${(stat.size / 1024 / 1024).toFixed(0)} MB` : '';
          const isDir = stat && stat.isDirectory();
          const typeStr = isDir ? '模型目录' : /\.gguf$/i.test(resolvedPath) ? 'GGUF 模型' : '模型压缩包';
          printInfo(`检测到${typeStr}: ${path.basename(resolvedPath)}${sizeStr ? ` (${sizeStr})` : ''}`);
          const answer = await new Promise(res => {
            rl.question(c.yellow('  是否导入并加载该模型? [Y/n] '), ans => res(ans.trim()));
          });
          if (!answer || /^y(es)?$/i.test(answer)) {
            printInfo('正在导入模型...');
            try {
              const modelImport = require('../services/modelImportService');
              const result = await modelImport.importModel(resolvedPath);
              if (result.success) {
                printSuccess(`模型导入成功: ${result.model || result.modelPath || ''}`);
                if (result.steps) result.steps.forEach(s => printInfo(`  ${s}`));
                // Auto-reload localLLMService
                try {
                  const llm = require('../services/localLLMService');
                  if (llm.dispose) llm.dispose();
                  if (llm.ensureLoaded) await llm.ensureLoaded();
                  printSuccess('本地模型已重新加载');
                } catch (loadErr) {
                  printWarn(`模型加载失败: ${loadErr.message}`);
                }
              } else {
                printError(`模型导入失败: ${result.error}`);
              }
            } catch (impErr) {
              printError(`导入出错: ${impErr.message}`);
            }
            _busy = false;
            rl.prompt();
            return;
          } else {
            printInfo('已跳过模型导入，作为普通文件处理');
            // Fall through to normal file/archive handling below
          }
        } else if (archiveExts.test(pathCandidate) && fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
          const stat = fs.statSync(resolvedPath);
          const sizeInfo = `${(stat.size / 1024).toFixed(1)} KB`;
          printInfo(`检测到压缩文件: ${path.basename(resolvedPath)} (${sizeInfo})`);
          const followUp = finalAiInput.slice(pathCandidate.length).trim();
          finalAiInput = `[压缩文件: ${path.basename(resolvedPath)}] (${sizeInfo})\n路径: ${resolvedPath}\n\n${followUp || '请帮我解压这个文件'}`;
        } else if (fileExts.test(pathCandidate) && fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
          const stat = fs.statSync(resolvedPath);
          const maxSize = 100 * 1024;
          const content = fs.readFileSync(resolvedPath, 'utf-8').slice(0, maxSize);
          const sizeInfo = stat.size > maxSize ? `截取前 100KB / 总 ${(stat.size / 1024).toFixed(0)}KB` : `${(stat.size / 1024).toFixed(1)} KB`;
          printInfo(`已读取文件: ${path.basename(resolvedPath)} (${sizeInfo})`);
          const followUp = finalAiInput.slice(pathCandidate.length).trim();
          const prompt = followUp || '请分析这个文件的内容';
          finalAiInput = `[文件内容: ${path.basename(resolvedPath)}]\n\`\`\`\n${content}\n\`\`\`\n\n${prompt}`;
        } else if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
          // Directory drag-and-drop: list project structure
          const tree = _buildDirTree(resolvedPath, { maxDepth: 3, maxFiles: 80 });
          printInfo(`已读取目录结构: ${path.basename(resolvedPath)} (${tree.fileCount} 个文件)`);
          const followUp = finalAiInput.slice(pathCandidate.length).trim();
          finalAiInput = `[项目结构: ${path.basename(resolvedPath)}]\n${tree.text}\n\n${followUp || '请分析这个项目的结构'}`;
        }
      } catch { /* file detection is best-effort, ignore errors */ }

      // Expand any residual [Pasted text #N] tags into actual pasted content.
      // This handles cases where paste tags survive into the AI input due to
      // timing races (e.g., busy-queue consuming the tag before _pendingPaste
      // expansion, or non-bracketed-paste terminals on Windows).
      finalAiInput = _expandPasteTags(finalAiInput);

      // Inject any queued `!` shell-escape output as leading context for this turn.
      // Drained once here (the single common assembly point for the AI turn) so
      // the model sees `!dir` output the user just ran.
      const _shellEscapeCtx = _drainShellEscapeContext();
      if (_shellEscapeCtx) finalAiInput = `${_shellEscapeCtx}\n\n${finalAiInput}`;

      // Check for multi-agent trigger
      const agentRunner = require('../services/cliAgentRunner');
      if (agentRunner.shouldUseMultiAgent(finalAiInput)) {
        _currentOp = '多智能体协作';
        _requestStart = Date.now();
        const agentDisplay = require('./agentRenderer');
        const renderer = require('./aiRenderer');

        // Decompose task into sub-tasks
        const subtasks = agentRunner.decomposeTask(finalAiInput);
        let renderedLines = 0;

        // Show initial agent display
        renderedLines = agentDisplay.renderAgentDisplay(subtasks.map(st => ({
          name: st.name, status: 'pending', toolCalls: 0, tokens: 0, elapsed: 0, detail: '',
        })));

        // Run agents with progress updates
        const agentResults = await agentRunner.runAgents(subtasks, {
          ai: ai(),
          onProgress: (states) => {
            renderedLines = agentDisplay.rerenderAgentDisplay(states, renderedLines);
          },
        });

        // Show final state
        agentDisplay.rerenderAgentDisplay(agentResults, renderedLines, true);
        agentDisplay.renderAgentSummary(agentResults);

        // Synthesize results
        renderer.printToolCallStart('Synthesize', '综合分析');
        const synthStart = Date.now();
        const synthesized = await agentRunner.synthesizeResults(agentResults, finalAiInput, ai());
        renderer.printToolCallResult('Synthesize', '综合分析', 'success', '合成完成', Date.now() - synthStart);

        // Display synthesized result
        agentDisplay.renderSynthesisResult(synthesized, agentResults);
        console.log('');
        _busy = false;
        rl.prompt();
        return;
      }

      // Check for plan mode trigger
      const planService = require('../services/planModeService');
      if (looksLikeUiEchoInput(aiInput)) {
        printInfo('检测到界面状态文本，已忽略该输入');
        return;
      }
      let needsPlan = false;
      const bypassPlan = shouldBypassPlanMode(aiInput);
      try {
        const { preprocess } = require('../services/inputPreprocessor');
        const pp = preprocess(aiInput);
        needsPlan = bypassPlan ? false : (pp.needsPlan || _planMode);
      } catch { /* best effort */ }

      if (bypassPlan && _planMode) _planMode = false;
      if (bypassPlan) {
        printInfo('已按请求跳过计划模式，直接执行任务');
      }

      if (needsPlan || _planMode) {
        const renderer = require('./aiRenderer');
        _planMode = false; // Reset after use
        _currentOp = 'Planning';
        _requestStart = Date.now();

        // Step 1: Generate plan
        renderer.printStepLine('active', '计划模式', '计划分解器', '正在生成执行计划');
        const { plan, rawResponse, provider, elapsed, errorType } = await planService.enterPlanMode(finalAiInput, ai());

        if (plan && plan.steps.length > 0) {
          if (process.stdout.isTTY) {
            process.stdout.write('\x1b[1A\r\x1b[K');
          }
          renderer.printStepLine('success', '计划模式', '计划分解器', `已生成 ${plan.steps.length} 步执行计划`);

          // Step 2: Present for approval
          const approval = await planService.presentForApproval(plan, renderer, rl);

          if (approval.approved) {
            // Step 3: Execute step by step
            console.log('');
            renderer.printStepLine('active', '执行计划', `${plan.steps.filter(s => s.status !== 'skipped').length} 步骤`);

            const results = await planService.executePlanSteps(plan, {
              ai: ai(),
              renderer,
              rl,
              route,
              parseInput,
              onStepResult: ({ step, result }) => {
                const attempts = Number(result?._planAttempts || 0);
                if (step.status === 'error') {
                  const reason = String(result?.error || '未知错误');
                  renderer.printStepLine('error', `步骤 ${step.id}`, '失败', reason);
                } else {
                  renderer.printStepLine('success', `步骤 ${step.id}`, `完成${attempts > 1 ? `（${attempts} 次尝试）` : ''}`);
                }
                if (result.reply) {
                  console.log(c.dim(`  ${step.description}`));
                  const rendered = renderer.renderAiResponse(result.reply);
                  rendered.split('\n').forEach(l => console.log(`  ${l}`));
                } else if (step.status === 'error' && result?.error) {
                  console.log(c.red(`  ${String(result.error)}`));
                }
              },
            });

            if (process.stdout.isTTY) {
              process.stdout.write('\x1b[1A\r\x1b[K');
            }
            renderer.printStepLine('success', '计划执行完成', `${results.filter(r => r.step.status === 'completed').length}/${results.length} 成功`);
            renderer.renderAgentDone({
              toolCalls: results.length,
              elapsedMs: elapsed,
            });
          } else {
            printInfo('计划已取消');
          }
        } else {
          // Plan generation failed — fall through to normal AI
          if (process.stdout.isTTY) {
            process.stdout.write('\x1b[1A\r\x1b[K');
          }
          renderer.printStepLine('error', '计划模式', errorType || '未知错误', '生成执行计划失败，已停止进入计划链路');
          if (rawResponse) {
            const renderer2 = require('./aiRenderer');
            const rendered = renderer2.renderAiResponse(rawResponse);
            rendered.split('\n').forEach(l => console.log(`  ${l}`));
          } else {
            printError('计划模式生成失败，且未返回具体错误信息');
          }
        }
        planService.reset();
        console.log('');
        _busy = false;
        rl.prompt();
        return;
      }

      // Load AI renderer for rich output
      const renderer = require('./aiRenderer');
      bindInteractiveInputGuard(renderer);
      const spinner = new renderer.DynamicSpinner();
      const tracker = new renderer.ProcessTracker();
      if (_plainTerminalUi) {
        if (typeof spinner.setPromptMode === 'function') spinner.setPromptMode('none');
        spinner.start = () => {};
        spinner.stop = () => {};
      } else if (_inputFrameEnabled && typeof spinner.setPromptMode === 'function') {
        spinner.setPromptMode('framed', {
          ruleColor: '#D77757',
          footer: c.hex('#FFFFFF').dim('(shift+tab to cycle)'),
        });
      }

      // Claude Code style: no intent analysis step — go straight to AI

      // Step 1: Preprocessing — detect complexity for display
      let complexTask = false;
      try {
        const { preprocess } = require('../services/inputPreprocessor');
        const pp = preprocess(aiInput);
        complexTask = pp.needsPlan;
      } catch { /* best effort */ }

      if (complexTask) {
        tracker.start('Analyzing', aiInput.slice(0, 40), 'complex task detected');
        tracker.complete('AI will plan first');
      }

      // Step 2: AI request — Claude Code style: rich spinner with effort/tokens
      _currentOp = 'Requesting AI';
      _requestStart = Date.now();
      renderer.resetStepCounter(); // Reset "Step N" progress for new AI turn

      // Get current effort level for spinner display
      try {
        const aiModule = require('./ai');
        const effort = typeof aiModule.getEffort === 'function' ? aiModule.getEffort() : 'high';
        spinner.setEffort(effort);
      } catch { /* best effort */ }

      let _streamTokenCount = 0;
      const streamedToolNames = new Map(); // tool_use_id -> tool name
      const streamedTaskStatus = new Map(); // task_id -> latest status
      // 过程叙述「不机械」:本回合每类工具已出现的次数(normalizeToolName→count),
      // 喂给共享 voice 让连续同类调用轮换续接句,而非每次复述同一句开场白。
      const _prefaceOccurrences = new Map();
      const _nextPrefaceOcc = (toolLabel) => {
        try {
          const key = String(toolLabel || '').toLowerCase().replace(/[\s_-]/g, '');
          const cur = _prefaceOccurrences.get(key) || 0;
          _prefaceOccurrences.set(key, cur + 1);
          return cur;
        } catch { return 0; }
      };
      let _lastRuntimeStatusSig = '';
      let _sharedStatusPhase = 'request';
      let _sharedStatusText = '准备请求模型';

      const _setStatusContext = (phase = '', text = '') => {
        if (phase) _sharedStatusPhase = String(phase).trim() || _sharedStatusPhase;
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (normalized) _sharedStatusText = normalized;
      };

      // 统一的 status 输出 + prompt 重绘：
      // spinner._render 被 isRaw 拦截永远不执行，所以 spinner.start() 后
      // 唯一能画输入框的是 showBusyInterjectPrompt()。
      // 直接在每次输出后同步调用，不依赖 console.log patch 的间接触发。
      //
      // Transient status lines (adapter switching, probing, retries) overwrite
      // the previous transient line instead of appending, preventing the
      // "flooding" effect when the gateway cascade retries many adapters.
      // ── Transient in-place status ──────────────────────────────────
      // Uses a single \r\x1b[K line (no newline!) that the spinner,
      // busy-prompt keepalive, or the next real content will naturally
      // overwrite.  This completely sidesteps the console.log patch,
      // hint line, and prompt repaint chains that caused flooding.
      let _transientStatusOpen = false;

      function _writeTransientStatus(text) {
        if (!process.stdout.isTTY) return;
        spinner.stop();
        _clearVisibleBusyPromptLine();
        const c2 = require('chalk');
        const line = (c2.default || c2).dim(`  · ${text}`);
        process.stdout.write(`\r\x1b[K${line}`);
        _transientStatusOpen = true;
        _transientStatusActive = true; // Block keepalive/prompt from overwriting this line
        // Do NOT restart spinner or call showBusyInterjectPrompt here.
        // The line stays in-place; the next status overwrites it via
        // \r\x1b[K, and real content clears it via _flushTransientStatus.
      }

      function _flushTransientStatus() {
        if (!_transientStatusOpen) return;
        _transientStatusOpen = false;
        _transientStatusActive = false;
        if (process.stdout.isTTY) {
          process.stdout.write('\r\x1b[K');
        }
      }

      // For non-transient (terminal) status lines that should remain
      // on screen — uses console.log so it scrolls up normally.
      function _printTerminalStatus(status, label, target, detail) {
        _flushTransientStatus();
        spinner.stop();
        renderer.printStepLine(status, label, target, detail);
        spinner.start('request');
        showBusyInterjectPrompt();
      }

      let _bridgeStatusShown = false; // Gate: show bridge handshake once, suppress repeats
      const emitRuntimeStatus = (text = '') => {
        const msg = String(text || '').trim();
        if (!msg) return;
        // Bridge handshake is one-shot informational — show once as a permanent
        // step line, then suppress.  This prevents ANY rendering path (spinner,
        // keepalive, transient overwrite) from causing flood.
        if (msg.includes('中转桥接')) {
          if (_bridgeStatusShown) return;
          _bridgeStatusShown = true;
          spinner.stop();
          _clearVisibleBusyPromptLine();
          renderer.printStepLine('active', '中转桥接', '', msg.replace(/🔗\s*/g, '').replace(/中转桥接[：:]\s*/g, ''));
          spinner.start('request');
          showBusyInterjectPrompt();
          return;
        }
        _setStatusContext('request', msg);
        const sig = `status:${msg}`;
        if (sig === _lastRuntimeStatusSig) return;
        _lastRuntimeStatusSig = sig;

        // Defer non-critical adapter statuses while streaming text/thinking
        // to avoid breaking the continuous output flow (same guard as onStatus).
        const lower = msg.toLowerCase();
        if (_busyStreaming) {
          const isCritical = lower.includes('failed') || lower.includes('error')
            || lower.includes('异常') || lower.includes('失败')
            || lower.includes('封禁') || lower.includes('banned');
          if (!isCritical) {
            _deferredStatuses.push({ phase: 'request', text: msg });
            return;
          }
        }

        // Classify status messages for rich display.
        // Terminal statuses (connected, banned, failed) use _printTerminalStatus
        // which outputs a permanent line via console.log.
        // Transient statuses (retries, probing, generic) use _writeTransientStatus
        // which writes in-place via \r\x1b[K — no newline, no console.log, no
        // spinner restart.  This prevents the busy-prompt/spinner interference
        // that caused the "flooding" bug.
        if (lower.includes('重试') || lower.includes('retry')) {
          _printTerminalStatus('error', '请求重试', '', msg);
        } else if (lower.includes('responded') || lower.includes('成功')) {
          _printTerminalStatus('done', '模型已连接', '', msg);
        } else if (lower.includes('封禁') || lower.includes('banned') || lower.includes('suspended')) {
          _printTerminalStatus('error', '通道异常', '', msg);
        } else if (lower.includes('failed') || lower.includes('error') || lower.includes('异常') || lower.includes('失败')) {
          _printTerminalStatus('error', '请求异常', '', msg);
        } else {
          // Everything else: transient in-place line
          _writeTransientStatus(msg);
        }
      };

      // Bridge adapter-level status events (kiroAdapter etc.) into the TUI.
      // These fire on process because the adapter has no direct access to the
      // REPL's onStatus callback — process events are the simplest bridge.
      _adapterStatusHandler = (text) => emitRuntimeStatus(text);
      process.on('khy:adapter:status', _adapterStatusHandler);

      const handleControlRequest = async ({ request, requestId }) => {
        const subtype = String(request?.subtype || '').trim().toLowerCase();
        if (subtype !== 'can_use_tool') {
          return { subtype: 'success', response: {} };
        }

        const toolName = String(request?.tool_name || request?.tool || 'tool');
        const normalizedTool = toolName.toLowerCase().replace(/[\s_-]/g, '');
        const input = (request && typeof request.input === 'object' && request.input) ? request.input : {};

        spinner.stop();
        try {
          if (normalizedTool === 'askuserquestion') {
            const questions = Array.isArray(input.questions) ? input.questions : [];
            const answers = {};

            for (const q of questions.slice(0, 4)) {
              const questionText = String(q?.question || '').trim() || 'Please choose an option';
              const qHeader = String(q?.header || '').trim().slice(0, 12);
              const qOptions = Array.isArray(q?.options) ? q.options : [];
              const renderedOptions = qOptions
                .map(opt => ({
                  label: String(opt?.label || '').trim(),
                  description: String(opt?.description || '').trim(),
                  preview: String(opt?.preview || '').trim(),
                }))
                .filter(opt => opt.label);

              if (renderedOptions.length === 0) continue;

              const selection = await renderer.askInlineQuestion(questionText, renderedOptions, {
                multiSelect: !!q?.multiSelect,
                header: qHeader,
                rl,
              });

              if (selection === null || selection === undefined) {
                return {
                  subtype: 'success',
                  response: {
                    behavior: 'deny',
                    message: 'User declined to answer questions',
                  },
                };
              }

              answers[questionText] = Array.isArray(selection)
                ? selection.join(', ')
                : String(selection);
            }

            // 持久回显(对齐 TUI role:'qa' / Claude Code):askInlineQuestion 的 cleanup 会
            // 擦除交互菜单(含问题),此处在擦除之后另打印一段问题+所选答案,落进滚动历史,
            // 让用户「选完仍看得见自己给的答案」。门控 KHY_QA_ECHO 关 → []→ 不打印(回退今日
            // 「选完即消失」)。纯叶子失败/打印失败均 fail-soft,绝不影响 behavior:'allow'。
            try {
              const _qaEcho = require('./qaEchoLines');
              const _echoLines = _qaEcho.buildQaEchoLines(answers, process.env);
              if (_echoLines.length > 0) {
                console.log(c.dim('\n  你的选择:'));
                for (const _l of _echoLines) {
                  console.log(_l.startsWith('  ❓') ? c.cyan(_l) : _l);
                }
                console.log('');
              }
            } catch { /* fail-soft:回显失败绝不影响返回答案 */ }

            return {
              subtype: 'success',
              response: {
                behavior: 'allow',
                updatedInput: { ...input, answers },
              },
            };
          }

          // 面向小白的执行前说明（Part D）：在任何权限提示前，按操作的难易/重要
          // 程度打印深浅不同的中文说明。内容由网关 preExecutionExplainer 基于
          // khyos 已采集的数据生成并随 input 下发；此处只负责渲染，缺失则静默跳过。
          if (input.explanation && typeof input.explanation.text === 'string' && input.explanation.text.trim()) {
            try { console.log('\n' + input.explanation.text + '\n'); } catch { /* best effort */ }
          }

          // Syscall gateway L2 (red-line) confirmation. The gateway advertises
          // input.level === 'L2' + input.requireTyped and reads back
          // response.typed (must strictly equal the confirm word, default
          // 'YES'). A bare {behavior:'allow'} can never satisfy it, so a
          // genuine terminal approval would be dropped. Mirror the Ink TUI
          // (PermissionsPrompt.js): offer a single, differentiated high-risk
          // choice that, when selected, returns the typed confirm word.
          const isL2 = String(input.level || '').toUpperCase() === 'L2'
            || typeof input.requireTyped === 'string';
          if (isL2) {
            const confirmWord = (typeof input.requireTyped === 'string' && input.requireTyped)
              ? input.requireTyped : 'YES';
            const resourceText = String(
              input.resource || input.command || input.action || '',
            ).trim();
            const titleParts = [`⚠ CRITICAL — ${toolName}`];
            if (resourceText) titleParts.push(resourceText);
            const l2Choice = await renderer.askInlineQuestion(
              titleParts.join(': '),
              [
                { label: 'Yes, run this CRITICAL operation', description: '确认执行此高危操作（不可逆/系统级）' },
                { label: 'Deny', description: 'Reject this critical operation' },
              ],
              { rl },
            );
            if (l2Choice === 'Yes, run this CRITICAL operation') {
              return { subtype: 'success', response: { behavior: 'allow', typed: confirmWord } };
            }
            return {
              subtype: 'success',
              response: { behavior: 'deny', message: 'Critical operation denied' },
            };
          }

          // A dependency-install heal prompt may advertise a third decision via
          // input.options (discuss = 先一起讨论再决定). Offer it as a real choice so
          // the classic REPL is on par with the Ink TUI; other tools stay binary.
          const advertised = Array.isArray(input.options) ? input.options.map((o) => String(o).toLowerCase()) : [];
          const offerDiscuss = advertised.includes('discuss');
          const permChoices = [
            { label: 'Allow', description: 'Approve this tool call once' },
            ...(offerDiscuss ? [{ label: 'Discuss', description: '先一起讨论再决定（不安装，让 AI 给方向）' }] : []),
            { label: 'Deny', description: 'Reject this tool call' },
          ];
          const permissionChoice = await renderer.askInlineQuestion(
            `Allow ${toolName}?`,
            permChoices,
            { rl },
          );

          if (permissionChoice === 'Allow') {
            return { subtype: 'success', response: { behavior: 'allow' } };
          }
          if (permissionChoice === 'Discuss') {
            return { subtype: 'success', response: { behavior: 'discuss' } };
          }
          return {
            subtype: 'success',
            response: {
              behavior: 'deny',
              message: 'Permission denied',
            },
          };
        } finally {
          spinner.start('request');

          // 中途选项及时回应(承 OPS-136 首响应静默窗口守护):用户刚在 AskUserQuestion /
          // L2 确认 / 权限 Allow-Deny 里作出选择,模型即将据此恢复流式。这之间又是一段
          // raw-mode spinner 被抑制的静默窗口(和「提交 → 首 token」同构),而本回合首个
          // 提交守护早已被此前的 chunk markChunk 消费掉。故在此重新武装一个 selection 变体
          // 守护:先 disarm 任何残留句柄,再新建 arm——delay 内模型没恢复出 chunk → 甩一句
          // 「收到你的选择,正在据此继续…」;首个恢复 chunk 到达即 onChunk markChunk 取消,
          // 回合 finally disarm 兜底。子门 KHY_FIRST_RESPONSE_ACK_SELECTION(或父门)关 →
          // arm no-op、逐字节回退无提示。emit 置 _turnAckEmitted=true,与 turnAck 不叠话。
          try {
            if (_firstResponseAckVoice
                && typeof _firstResponseAckVoice.createFirstResponseAckScheduler === 'function') {
              try { if (_firstResponseAckScheduler) _firstResponseAckScheduler.disarm(); } catch { /* ignore */ }
              _firstResponseAckScheduler = _firstResponseAckVoice.createFirstResponseAckScheduler({
                turnIndex: _turnAckIndex,
                variant: 'selection',
                env: process.env,
                deps: {
                  emit: (line) => {
                    if (!line) return;
                    try { renderer.printStepDetail(line); } catch { /* 渲染失败不影响主流程 */ }
                    _turnAckEmitted = true; // 已代码级回应用户 → 抑制后续 turnAck,避免叠话
                  },
                },
              });
              _firstResponseAckScheduler.arm();
            }
          } catch { /* fail-soft:守护失败绝不影响控制请求返回 */ }
        }
      };

      let _timerResetDone = false;
      let _briefRenderedLines = 0;
      let _briefCollapseOpts = {};
      // 本回合累计已流式输出的「原始」文本(跨工具循环迭代)。streamState 每迭代重建会丢
      // 这个跨迭代视角,故用回合作用域变量;供出口判「最终文本是否已展示过」去重。
      let _turnStreamedText = '';
      const _initTracker = new renderer.InitPhaseTracker();
      const _markDeliveryGapPending = () => {
        streamState._deliveryGapPending = true;
      };
      const _flushDeliveryGap = () => {
        if (!streamState._deliveryGapPending) return;
        console.log('');
        streamState._deliveryGapPending = false;
      };
      // 工具迭代间的静默窗口守护(resume 变体)。一个工具刚返回、模型将据此续跑,而本回合最初的
      // 「提交守护」(spinner.start('request') 处那次 arm)早被首 chunk markChunk 消费掉、turnAck 也
      // 一回合至多一次 → 「工具返回 → 模型下一 chunk」之间若模型迟迟不开口(交互 raw-mode 下 spinner
      // 被 render-suppress),又是一段像卡死的死寂。这里在每个「工具已收尾」信号处(tool_result /
      // tool_complete)重装一个 resume 变体守护:超阈值仍无下一 chunk → emit「工具已返回,正在继续
      // 处理…」;下一个 chunk 一到即由 onChunk 顶部的 markChunk 取消;回合 finally 的 disarm 兜底。
      // 门 KHY_FIRST_RESPONSE_ACK_RESUME(父门 KHY_FIRST_RESPONSE_ACK)关 → 逐字节回退无提示。绝不抛。
      function _rearmResumeAck() {
        try {
          if (!_firstResponseAckVoice
            || typeof _firstResponseAckVoice.createFirstResponseAckScheduler !== 'function') return;
          try { if (_firstResponseAckScheduler) _firstResponseAckScheduler.disarm(); } catch { /* ignore */ }
          _firstResponseAckScheduler = _firstResponseAckVoice.createFirstResponseAckScheduler({
            turnIndex: _turnAckIndex,
            env: process.env,
            variant: 'resume',
            deps: {
              emit: (line) => {
                if (!line) return;
                try { renderer.printStepDetail(line); } catch { /* 渲染失败不影响主流程 */ }
              },
            },
          });
          _firstResponseAckScheduler.arm();
        } catch { /* 守护重装失败不影响主流程 */ }
      }
      const onChunk = (chunk) => {
          // TUI bridge: record chunk (best-effort)
          try { if (_tuiCtrl) _tuiCtrl.recordChunk(chunk.type, chunk.text); } catch { /* */ }
          // 首响应静默窗口守护:任何 chunk 到达 = 模型已开始响应 → 取消未决的「还在等模型」提示。幂等。
          try { if (_firstResponseAckScheduler) _firstResponseAckScheduler.markChunk(); } catch { /* */ }
          // Reset spinner timer on the first received SSE event
          if (!_timerResetDone) {
            _timerResetDone = true;
            if (spinner && typeof spinner.resetTimer === 'function') spinner.resetTimer();
          }
          // Collapse execution brief on first real output
          if (_briefRenderedLines > 0 && (chunk.type === 'tool_use' || chunk.type === 'text' || chunk.type === 'thinking' || chunk.type === 'assistant_preface')) {
            try { renderer.collapseExecutionBrief(_briefRenderedLines, _briefCollapseOpts); } catch { /* */ }
            _briefRenderedLines = 0;
          }
          // Clear transient in-place status before real content
          if (chunk.type === 'text' || chunk.type === 'thinking' || chunk.type === 'tool_use' || chunk.type === 'assistant_preface') {
            _flushTransientStatus();
          }
          if (chunk.type === 'thinking') {
            spinner.stop();
            _clearVisibleBusyPromptLine();
            _busyStreaming = true;
            _currentOp = 'Thinking';
            updateTitlePhase('thinking');
          if (!streamState.thinkingStarted) {
            streamState.thinkingStarted = true;
            streamState._thinkingStartAt = Date.now();
            streamState.phase = 'thinking';
              _setStatusContext('thinking', '正在解析约束与执行计划');
              console.log('');
              console.log(c.dim('  💭 正在解析约束与执行计划...'));
            }
            streamThinkingChunk(chunk.text, streamState, c);
          } else if (chunk.type === 'assistant_preface') {
            const prefaceText = String(chunk.text || '').replace(/\s+/g, ' ').trim();
            if (!prefaceText) return;
            if (streamState.phase === 'thinking') {
              closeThinkingStream(streamState);
              console.log('');
            }
            if (streamState.phase === 'text') {
              flushTextBuffer(streamState, c, true);
            }
            _flushDeliveryGap();
            spinner.stop();
            _clearVisibleBusyPromptLine();
            _busyStreaming = true;
            _currentOp = 'Tool preface';
            _setStatusContext('tool_progress', prefaceText);
            updateTitlePhase('tool');
            renderer.printStepDetail(prefaceText);
            streamState.phase = 'tool';
            streamState._assistantPrefaceForNextTool = true;
          } else if (chunk.type === 'tool_use') {
            if (streamState.phase === 'thinking') {
              closeThinkingStream(streamState);
              console.log('');
              streamState.phase = 'tool';
              streamState._deliveryGapPending = false;
            }
            // Flush buffered text with markdown formatting before tool output.
            // Use force=true so no remainder is held — tool display follows
            // immediately and any held text would be lost.
            flushTextBuffer(streamState, c, true);
            spinner.stop();
            _currentOp = 'Tool use';
            updateTitlePhase('tool', chunk.tool || 'Tool');
            if (chunk.id) streamedToolNames.set(String(chunk.id), chunk.tool || 'tool');
            // Always show tool_use events from adapter streaming (Codex CLI, Claude, etc.)
            {
              const toolLabel = chunk.tool || 'tool';
              // turn 级即时确认「先回应用户,再干活」:本回合首个工具即将渲染 → 先甩一句 khy 的回应,
              // 再出该工具的 preface/调用行。每回合至多一次(_turnAckEmitted 闭包变量,横跨工具循环迭代);
              // 模型已出文本(_turnAckSawText)时判空跳过。缺叶子/门控关 → line 为空 → 逐字节回退无 ack。
              if (!_turnAckEmitted) {
                _turnAckEmitted = true;
                let _ackLine = '';
                try {
                  if (_turnAckVoice && typeof _turnAckVoice.computeTurnAck === 'function') {
                    _ackLine = _turnAckVoice.computeTurnAck({
                      turnIndex: _turnAckIndex,
                      sawText: !!_turnAckSawText,
                      env: process.env,
                    });
                  }
                } catch { _ackLine = ''; }
                if (_ackLine) renderer.printStepDetail(_ackLine);
              }
              _setStatusContext('tool_progress', `${mapToolToPhaseLabel(toolLabel)} 已启动，等待工具返回结果`);
              const inputHint = typeof chunk.input === 'string' ? chunk.input.slice(0, 80) : '';
              const preface = streamState._assistantPrefaceForNextTool
                ? ''
                : _buildStreamingToolPreface(toolLabel, inputHint, _nextPrefaceOcc(toolLabel));
              streamState._assistantPrefaceForNextTool = false;
              if (preface) renderer.printStepDetail(preface);
              renderer.printToolCallStart(toolLabel, inputHint);
              if (_taskMindMap) {
                _taskMindMap.markToolCall(toolLabel, { command: inputHint });
                if (_taskMindMapAutoShow) {
                  _printTaskMindMapCompact('Mind map · tool call');
                }
              }
              _featureCapabilityMap.markToolCall(toolLabel, { command: inputHint });
              if (_taskMindMapAutoShow) {
                _printFeatureCapabilityCompact('Feature map · tool call');
              }
            }
            _markDeliveryGapPending();
          } else if (chunk.type === 'tool_result') {
            // Always show tool_result events from adapter streaming
            if (chunk.content) {
              const fullDetail = String(chunk.content).replace(/\n/g, ' ').trim();
              const brief = fullDetail.slice(0, 80);
              const toolLabel = streamedToolNames.get(String(chunk.id || '')) || 'tool';
              _setStatusContext('tool_progress', `${mapToolToPhaseLabel(toolLabel)} 已返回结果`);
              // The pass/fail verdict must come from a structured success flag.
              // When the adapter stream omits it, render a neutral 'done' rather
              // than guessing success/failure by sniffing the result text.
              const hasStructuredVerdict = typeof chunk.success === 'boolean';
              const ok = hasStructuredVerdict ? chunk.success : null;
              const stepStatus = ok === null ? 'done' : (ok ? 'success' : 'error');
              renderer.printStepLine(stepStatus, toolLabel, '', brief);
              if (hasStructuredVerdict) {
                const reflection = _toolResultReflection(toolLabel, ok, fullDetail);
                if (reflection) renderer.printStepDetail(reflection);
              }
              if (_taskMindMap) {
                _taskMindMap.markToolResult(toolLabel, ok === true, brief);
                if (_taskMindMapAutoShow) {
                  _printTaskMindMapCompact('Mind map · tool result');
                }
              }
              _featureCapabilityMap.markToolResult(toolLabel, ok === true, brief);
              if (_taskMindMapAutoShow) {
                _printFeatureCapabilityCompact('Feature map · tool result');
              }
              _markDeliveryGapPending();
            }
            if (chunk.id) streamedToolNames.delete(String(chunk.id));
            _rearmResumeAck(); // 工具已返回 → 重装 resume 守护,补「工具返回 → 模型续跑」的静默窗口
          } else if (chunk.type === 'tool_complete') {
            // Rich tool completion from adapter — render file diffs
            maybeRenderWriteDiff(chunk.name, chunk.params || {}, chunk.result || {}, c);
            maybeRenderInlineDiffFromToolOutput(chunk.name, chunk.result || {}, c);
            _markDeliveryGapPending();
            _rearmResumeAck(); // 工具收尾(富完成)→ 重装 resume 守护;下一 model chunk 到即取消
          } else if (chunk.type === 'tool_progress') {
            spinner.stop();
            const toolName = chunk.tool || streamedToolNames.get(String(chunk.id || '')) || 'tool';
            const status = String(chunk.status || '').toLowerCase();
            const detail = String(chunk.detail || '').trim();
            _setStatusContext('tool_progress', detail || `${mapToolToPhaseLabel(toolName)} 正在推进工具步骤`);
            if (status.includes('fail') || status.includes('error')) {
              renderer.printStepLine('error', toolName, '', detail || '失败');
            } else if (status.includes('complete') || status.includes('success') || status === 'done') {
              renderer.printStepLine('success', toolName, '', detail || '已完成');
              if (chunk.id) streamedToolNames.delete(String(chunk.id));
            } else {
              renderer.printStepLine('active', toolName, '', detail || '工具步骤已启动，等待下一条进度更新');
            }
            _markDeliveryGapPending();
          } else if (chunk.type === 'task_started') {
            spinner.stop();
            const taskId = String(chunk.taskId || chunk.toolUseId || 'task');
            streamedTaskStatus.set(taskId, 'running');
            const taskSummary = String(chunk.summary || '').trim() || '任务已创建，等待首条执行进度';
            _setStatusContext('tool_progress', taskSummary);
            renderer.printStepLine('active', '任务开始', taskId, taskSummary);
            _markDeliveryGapPending();
          } else if (chunk.type === 'task_progress') {
            spinner.stop();
            const taskId = String(chunk.taskId || chunk.toolUseId || 'task');
            const taskProgress = String(chunk.summary || chunk.status || '任务继续推进，等待下一条进度更新').trim();
            _setStatusContext('tool_progress', taskProgress);
            renderer.printStepLine('active', '任务进度', taskId, taskProgress);
            _markDeliveryGapPending();
          } else if (chunk.type === 'task_notification') {
            spinner.stop();
            const taskId = String(chunk.taskId || chunk.toolUseId || 'task');
            const status = String(chunk.status || '').toLowerCase();
            const ok = status === 'completed' || status === 'success';
            renderer.printStepLine(ok ? 'success' : 'error', '任务结束', taskId, String(chunk.summary || status || '完成').trim());
            streamedTaskStatus.delete(taskId);
            _markDeliveryGapPending();
          } else if (chunk.type === 'auth_status') {
            spinner.stop();
            if (chunk.error) {
              renderer.printStepLine('error', '认证', '', String(chunk.error));
            } else if (chunk.isAuthenticating) {
              const authText = String(chunk.output || '认证握手已发起，等待上游确认');
              _setStatusContext('request', authText);
              renderer.printStepLine('active', '认证', '', authText);
            } else if (chunk.output) {
              emitRuntimeStatus(`认证：${String(chunk.output)}`);
            }
            _markDeliveryGapPending();
          } else if (chunk.type === 'status') {
          // Bridge handshake status is handled exclusively by emitRuntimeStatus
          // (which shows it once then suppresses) — do NOT touch spinner or phase.
          const _statusText = String(chunk.text || '');
          if (!_statusText.includes('中转桥接')) {
            _setStatusContext('request', _statusText);
          }
          emitRuntimeStatus(_statusText);
          _markDeliveryGapPending();
          } else if (chunk.type === 'control_request') {
            spinner.stop();
            const req = chunk.request || {};
            const reqSubtype = String(req.subtype || '').trim() || 'control';
            const reqTool = String(req.tool_name || req.tool || '').trim();
            if (reqSubtype === 'can_use_tool') {
              renderer.printStepLine('active', '权限确认', reqTool || 'tool', `请求 ${chunk.requestId || ''}`.trim());
            } else {
              renderer.printStepLine('active', '控制请求', reqSubtype, `请求 ${chunk.requestId || ''}`.trim());
            }
            _markDeliveryGapPending();
          } else if (chunk.type === 'notice') {
          // Bright notice from adapters — always render immediately, never defer
          spinner.stop();
          const noticeText = String(chunk.text || '');
          renderer.printStepLine('active', '注意', '', c.hex('#FFD700').bold(noticeText));
          spinner.start(spinner._phase || 'request');
          showBusyInterjectPrompt();
          _markDeliveryGapPending();
          } else if (chunk.type === 'assistant_message') {
          // 用户可见的中间消息(如视觉路由说明:文本模型先说明「我无法识别图片,正在调用视觉模型」)。
          // 这是 khy 在回合中对用户说的一句话,与流式最终答复独立 → 立即渲染为一条助手消息行,
          // 不缓冲、不延后。后续视觉识别/最终答复照常经 text chunk 流出,衔接其后。
          const msgText = String(chunk.content || chunk.text || '').trim();
          // 回合内逐字节去重:同一句中间消息(如同一「正在调用 X 请稍候」/ 同一失败总结块)被工具循环
          // 多次迭代重放时,首次照常「明显告知」,后续逐字节重复的压制(治刷屏)。门关 → shouldRender 恒真
          // = 逐字节回退旧「每条都渲染」。不同模型名 / 不同失败真因 → 签名不同 → 照常全渲染。
          if (msgText && require('./visionNoticeDedup').shouldRender(_visionNoticeSeen, msgText, process.env)) {
            // 先收尾进行中的思考/文本阶段,避免与中间消息交错。
            if (streamState.phase === 'thinking') {
              closeThinkingStream(streamState);
              console.log('');
              streamState.phase = 'text';
            }
            if (streamState.phase === 'text') {
              flushTextBuffer(streamState, c, true);
            }
            _flushTransientStatus();
            _flushDeliveryGap();
            spinner.stop();
            _clearVisibleBusyPromptLine();
            console.log('');
            console.log(`  ${ICON_BOT} ${c.cyan(msgText)}`);
            console.log('');
            spinner.start(spinner._phase || 'request');
            showBusyInterjectPrompt();
          }
          _markDeliveryGapPending();
          } else if (chunk.type === 'text') {
          if (streamState.phase === 'thinking') {
            closeThinkingStream(streamState);
            console.log('');
            streamState.phase = 'text';
            spinner.setPhase('generating');
            streamState._deliveryGapPending = false;
          }
          // Close any prior tool phase so text appears on a fresh line
          if (streamState.phase === 'tool') {
            streamState.phase = 'text';
          }
          // Track output tokens approximately
          if (chunk.text) {
            // 模型已自己吐出答复文本 → 本回合首工具的 turn-ack 判空跳过(用户已被回应,不叠加)。
            _turnAckSawText = true;
            _streamTokenCount += Math.ceil(chunk.text.length / 4);
            spinner.setTokens(_streamTokenCount, 'output');
          }
          if (!streamState.textStarted) {
            streamState.textStarted = true;
            _flushDeliveryGap();
            _clearVisibleBusyPromptLine();
            _busyStreaming = true;
            _currentOp = 'Generating';
            _setStatusContext('generating', '正在生成最终答复');
            updateTitlePhase('generating');
            spinner.stop();
          }
          // Buffer text for formatted rendering when tool call arrives
          if (chunk.text) {
            spinner.stop();
            bufferTextChunk(chunk.text, streamState);
            streamState._streamedTextLen = (streamState._streamedTextLen || 0) + chunk.text.length;
            _turnStreamedText += chunk.text; // 回合级累计(跨迭代),供出口去重判定
          }
        } else if (chunk.type === 'cost') {
          streamState.cost = chunk.cost;
          if (chunk.cost?.totalTokens) _sessionTokens = chunk.cost.totalTokens;
          // Update spinner with real token counts
          if (chunk.cost?.inputTokens) spinner.setTokens(chunk.cost.inputTokens, 'input');
          if (chunk.cost?.outputTokens) spinner.setTokens(chunk.cost.outputTokens, 'output');
        }
      };

      // Start dynamic spinner
      spinner.start('request');

      // 首响应静默窗口守护:请求已发出,若 KHY_FIRST_RESPONSE_ACK_MS(默认 1200ms)内一个 chunk 都没到,
      // 就甩一句「还在等模型响应」让用户知道 khy 收到了、正在处理(治交互 raw-mode 下 spinner 被抑制的静默)。
      // 首个 chunk 到达即 markChunk 取消;finally disarm 兜底。emit 时置 _turnAckEmitted=true,避免同回合与
      // turnAck 两处叠话。门控关/叶缺失 → arm no-op、逐字节回退无提示。
      try {
        if (_firstResponseAckVoice && typeof _firstResponseAckVoice.createFirstResponseAckScheduler === 'function') {
          _firstResponseAckScheduler = _firstResponseAckVoice.createFirstResponseAckScheduler({
            turnIndex: _turnAckIndex,
            env: process.env,
            deps: {
              emit: (line) => {
                if (!line) return;
                try { renderer.printStepDetail(line); } catch { /* 渲染失败不影响主流程 */ }
                _turnAckEmitted = true; // 已代码级回应用户 → 抑制后续 turnAck,避免叠话
              },
            },
          });
          _firstResponseAckScheduler.arm();
        }
      } catch { _firstResponseAckScheduler = null; }

      let aiResult;
      let responseAlreadyRendered = false;
      let _lastMindMapSteerPayload = '';
      let _lastFeatureMapSteerPayload = '';
      _initTaskMindMap(aiInput, finalAiInput);
      _featureCapabilityMap.markAiTask(finalAiInput, true);
      if (_taskMindMapAutoShow && _currentStatusVerbosity === 'detailed') {
        _renderTaskMindMap('start');
      } else if (_currentStatusVerbosity === 'detailed') {
        _printFeatureCapabilityCompact('Feature map initialized');
        _printTaskMindMapCompact('Mind map initialized');
      }

      // ── QueryEngine path (KHY_QUERY_ENGINE=true) ────────────────
      let _useQueryEngine = false;
      try { _useQueryEngine = require('../services/queryEngine').isEnabled(); } catch {}

      if (_useQueryEngine) {
        try {
          const { QueryEngine } = require('../services/queryEngine');
          if (!_queryEngine) _queryEngine = new QueryEngine();
          let _qePlanTracker = null; // P1: orchestration-driven task plan
          for await (const event of _queryEngine.submitMessage(finalAiInput, {
            effort: ai().getEffort(),
          })) {
            switch (event.type) {
              case 'thinking':
                onChunk({ type: 'thinking', text: event.data });
                break;
              case 'text':
                onChunk({ type: 'text', text: event.data });
                break;
              case 'assistant_message':
                // 用户可见的中间消息(如视觉路由说明)——桥到主 onChunk 的 assistant_message 分支渲染。
                onChunk({ type: 'assistant_message', content: event.data });
                break;
              case 'tool_call':
                spinner.stop();
                {
                  const toolName = event.data.name;
                  // turn 级即时确认:QueryEngine 路径的首个工具同样先甩一句 khy 的回应,再渲染工具。
                  // 与主 tool_use 分支共用同一批闭包哨兵,保证每回合至多一次(honor「仅跑工具轮次」)。
                  if (!_turnAckEmitted) {
                    _turnAckEmitted = true;
                    let _ackLine = '';
                    try {
                      if (_turnAckVoice && typeof _turnAckVoice.computeTurnAck === 'function') {
                        _ackLine = _turnAckVoice.computeTurnAck({
                          turnIndex: _turnAckIndex,
                          sawText: !!_turnAckSawText,
                          env: process.env,
                        });
                      }
                    } catch { _ackLine = ''; }
                    if (_ackLine) renderer.printStepDetail(_ackLine);
                  }
                  const activity = _toolProgressStart(toolName, event.data.params || {});
                  if (activity) {
                    renderer.printStepLine('active', activity.label, activity.target || '');
                  }
                  // Claude Code style: ⏺ ToolName(params)
                  renderer.printToolCallStart(toolName, event.data.params || {});
                  // P1: Orchestration-driven plan — add tool as task
                  if (!_qePlanTracker) {
                    _qePlanTracker = new renderer.TaskPlanTracker({ rewriteInPlace: false });
                  }
                  _qePlanTracker.addTask(
                    (() => {
                      const target = event.data.params?.file_path || event.data.params?.path
                        || event.data.params?.pattern || event.data.params?.command
                        || event.data.params?.query || '';
                      return target ? `${toolName}: ${String(target).slice(0, 40)}` : toolName;
                    })()
                  );
                  if (_taskMindMap) {
                    _taskMindMap.markToolCall(toolName, event.data.params || {});
                    if (_taskMindMapAutoShow) {
                      _printTaskMindMapCompact('Mind map · tool call');
                    }
                  }
                  _featureCapabilityMap.markToolCall(toolName, event.data.params || {});
                  if (_taskMindMapAutoShow) {
                    _printFeatureCapabilityCompact('Feature map · tool call');
                  }
                }
                spinner.start('tool');
                break;
              case 'tool_result': {
                spinner.stop();
                const ok = event.data.status ? event.data.status === 'success' : !!event.data.result?.success;
                const toolName = event.data.name;
                let progressDetail = '';
                if (ok) {
                  const detail = _formatToolResult(toolName, event.data.result || {}, event.data.params);
                  progressDetail = detail;
                  renderer.printToolCallResult(toolName, event.data.params || {}, 'success', detail, event.data.elapsed || 0);
                } else {
                  const rawErr = event.data.result?.error || event.data.result || 'failed';
                  const errStr = (rawErr && typeof rawErr === 'object')
                    ? (rawErr.message || JSON.stringify(rawErr))
                    : String(rawErr);
                  progressDetail = String(errStr).slice(0, 120);
                  renderer.printToolCallResult(toolName, event.data.params || {}, 'error', progressDetail, event.data.elapsed || 0);
                }
                const progressDone = _toolProgressDone(toolName, ok, progressDetail);
                if (progressDone) {
                  renderer.printStepLine(progressDone.status, progressDone.label, '', progressDone.detail || '');
                }
                if (_taskMindMap) {
                  _taskMindMap.markToolResult(toolName, ok, progressDetail);
                  if (_taskMindMapAutoShow) {
                    _printTaskMindMapCompact('Mind map · tool result');
                  }
                }
                _featureCapabilityMap.markToolResult(toolName, ok, progressDetail);
                if (_taskMindMapAutoShow) {
                  _printFeatureCapabilityCompact('Feature map · tool result');
                }
                // P1: Update orchestration-driven plan from tool result
                if (_qePlanTracker) {
                  _qePlanTracker.updateFromToolResult(toolName, ok);
                }
                maybeRenderWriteDiff(event.data.name, event.data.params || {}, event.data.result, c);
                maybeRenderInlineDiffFromToolOutput(event.data.name, event.data.result, c);
                break;
              }
              case 'cost':
                if (event.data?.totalTokens) _sessionTokens += event.data.totalTokens;
                // Accumulate for printTurnCost at done
                streamState._qeCost = event.data;
                break;
              case 'done':
                // Flush remaining buffered text before rendering status/summary
                flushTextBuffer(streamState, c, true);
                aiResult = event.data;
                if (_taskMindMap) {
                  const success = !event.data?.errorType;
                  _taskMindMap.complete({ success, reason: success ? '' : String(event.data?.errorType || 'query engine error') });
                  if (_currentStatusVerbosity === 'detailed' && (_taskMindMapAutoShow || !success)) {
                    _renderTaskMindMap(success ? 'completed' : 'incomplete');
                  } else {
                    _printTaskMindMapCompact('Mind map finalized');
                  }
                }
                _featureCapabilityMap.markAiCompletion(!event.data?.errorType, String(event.data?.errorType || 'query engine done'));
                if (_currentStatusVerbosity === 'detailed' && (_taskMindMapAutoShow || event.data?.errorType)) {
                  _printFeatureCapabilityCompact('Feature map finalized');
                }
                // Print turn cost/token transparency (matching legacy path)
                try {
                  const qeCost = streamState._qeCost;
                  if (qeCost) {
                    const turnData = {
                      inputTokens: qeCost.inputTokens || qeCost.promptTokens || 0,
                      outputTokens: qeCost.outputTokens || qeCost.completionTokens || 0,
                      cacheReadTokens: qeCost.cacheReadTokens || 0,
                      model: event.data?.model || event.data?.provider || '',
                      adapter: event.data?.provider || event.data?.adapter || '',
                      durationMs: event.data?.elapsed || event.data?.elapsedMs || 0,
                    };
                    try {
                      const tokenSvc = require('../services/tokenUsageService');
                      turnData.costUSD = tokenSvc.estimateCost(turnData.inputTokens, turnData.outputTokens, turnData.model || turnData.adapter);
                    } catch { /* cost estimation not critical */ }
                    renderer.printTurnCost(turnData);
                    if (event.data?.cascade && Array.isArray(event.data.cascade) && event.data.cascade.length > 1) {
                      renderer.printCascadeSteps(event.data.cascade);
                    }
                  }
                } catch { /* transparency is best-effort */ }

                // ── P0: Completion panel for QE path (mirrors toolUseLoop path) ──
                try {
                  const qeLog = (event.data?.toolCallLog || []).filter(t => t.tool !== '_legacy_cmd');
                  const qeToolCount = qeLog.length;
                  const qeIterations = event.data?.iterations || 0;
                  if (qeIterations > 0 && qeToolCount > 0) {
                    const qeSearches = qeLog.filter(t => /grep|glob|search|find/i.test(t.tool)).length;
                    const qeReads = qeLog.filter(t => /read/i.test(t.tool)).length;
                    const qeWebSearches = qeLog.filter(t => /websearch|webfetch/i.test(t.tool)).length;
                    const qeSucceeded = qeLog.filter(t => {
                      if (typeof t?.result?.success === 'boolean') return t.result.success;
                      if (typeof t?.success === 'boolean') return t.success;
                      return false;
                    }).length;
                    const qeFailed = qeToolCount - qeSucceeded;
                    const qeTotalElapsed = qeLog.reduce((sum, t) => sum + (t.elapsed || 0), 0);
                    const qeElapsedStr = qeTotalElapsed > 1000
                      ? require('./ccFormat').ccFormatDurationOr(qeTotalElapsed, `${(qeTotalElapsed / 1000).toFixed(1)}s`, process.env)
                      : `${qeTotalElapsed}ms`;

                    // Build file changes
                    const qeFileChanges = [];
                    const qeSeenPaths = new Map();
                    for (const t of qeLog) {
                      const tool = String(t.tool || '').toLowerCase().replace(/[\s_-]/g, '');
                      const fp = t.params?.file_path || t.params?.filePath || t.params?.path || '';
                      if (!fp) continue;
                      if (/^(write|writefile|createfile|filewrite)$/.test(tool)) {
                        if (!qeSeenPaths.has(fp)) {
                          const diff = t.result?._khyWriteDiff;
                          const isNew = diff && !diff.beforeContent;
                          const lines = diff?.afterContent ? diff.afterContent.split('\n').length : 0;
                          qeSeenPaths.set(fp, true);
                          qeFileChanges.push({ path: fp, operation: isNew ? 'create' : 'modify', diff: lines > 0 ? `${lines} 行` : '' });
                        }
                      } else if (/^(edit|editfile|fileedit)$/.test(tool)) {
                        const oldLen = (t.params?.old_string || t.params?.oldString || '').split('\n').length;
                        const newLen = (t.params?.new_string || t.params?.newString || '').split('\n').length;
                        const added = Math.max(0, newLen - oldLen);
                        const removed = Math.max(0, oldLen - newLen);
                        const existing = qeSeenPaths.get(fp);
                        if (existing && typeof existing === 'object') {
                          existing.added = (existing.added || 0) + added;
                          existing.removed = (existing.removed || 0) + removed;
                        } else if (!qeSeenPaths.has(fp)) {
                          const entry = { path: fp, operation: 'modify', diff: `+${added}/-${removed}`, added, removed };
                          qeSeenPaths.set(fp, entry);
                          qeFileChanges.push(entry);
                        }
                      }
                    }
                    for (const fc of qeFileChanges) {
                      if (fc.added !== undefined) fc.diff = `+${fc.added}/-${fc.removed}`;
                    }

                    // Build commands
                    const qeCommands = [];
                    for (const t of qeLog) {
                      const tool = String(t.tool || '').toLowerCase().replace(/[\s_-]/g, '');
                      if (/^(bash|shell|shellcommand)$/.test(tool)) {
                        const cmd = String(t.params?.command || '').trim();
                        if (cmd && !/^\s*(ls|dir|cat|head|tail|find|tree|pwd|whoami|echo)\b/i.test(cmd)) {
                          qeCommands.push({ cmd: cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd, success: t.result?.success !== false });
                        }
                      }
                    }

                    // Build summary
                    const qeSummary = [];
                    if (qeFileChanges.length > 0) {
                      const creates = qeFileChanges.filter(f => f.operation === 'create').length;
                      const mods = qeFileChanges.filter(f => f.operation === 'modify').length;
                      const parts = [];
                      if (mods > 0) parts.push(`修改了 ${mods} 个文件`);
                      if (creates > 0) parts.push(`新建了 ${creates} 个文件`);
                      if (parts.length > 0) qeSummary.push(parts.join('，'));
                    }
                    if (qeCommands.length > 0) {
                      const allOk = qeCommands.every(cmd => cmd.success !== false);
                      qeSummary.push(allOk ? '所有命令执行成功' : `${qeCommands.filter(cmd => cmd.success === false).length} 条命令失败`);
                    }

                    const qePanelSuccess = qeFailed === 0;
                    renderer.printCompletionPanel({
                      success: qePanelSuccess,
                      iterations: qeIterations,
                      totalCalls: qeToolCount,
                      succeeded: qeSucceeded,
                      elapsed: qeElapsedStr,
                      fileChanges: qeFileChanges,
                      commands: qeCommands.slice(0, 5),
                      searches: qeSearches + qeWebSearches,
                      reads: qeReads,
                      summary: qeSummary.length > 0 ? qeSummary : undefined,
                    });
                    _markDeliveryGapPending();
                  }
                } catch { /* completion panel is best-effort */ }

                break;
            }
          }
          spinner.stop();
        } catch (qeErr) {
          spinner.stop();
          // Fall through to legacy path on QueryEngine error
          _useQueryEngine = false;
          console.log(c.hex('#FFC107')(`  QueryEngine error: ${qeErr.message} — falling back to legacy`));
        }
      }

      if (!_useQueryEngine) {
        // ── Tool-use loop path (execution-first) ─────────────────────
        const toolUseLoop = require('../services/toolUseLoop');
        const loopManaged = toolUseLoop.isEnabled();
        _featureCapabilityMap.markAiTask(finalAiInput, loopManaged);
        if (!_taskMindMapAutoShow) {
          _printFeatureCapabilityCompact('Feature map updated');
        }
        // Claude Code: no busy-mode hint text
        showBusyInterjectPrompt();

        const chatFn = async (message, opts = {}) => {
          // Reset streaming state for each iteration
          _busyStreaming = false; _flushDeferredStatuses(); // 上一轮流式输出已结束，重置
          streamState = { phase: 'idle', thinkingStarted: false, textStarted: false, thinkingLineOpen: false, thinkingCol: 0, _textBuffer: '', _streamedTextLen: 0, _inToolLoop: true };
          // Re-create chunker/lineBuffer so tool-loop iterations also stream text incrementally
          streamState._streamingMd = _createStreamingMdState();
          streamState._lineBuffer = new LineBuffer();
          streamState._chunker = new AdaptiveChunker(streamState._lineBuffer, (text) => {
            if (streamState._streamingMd) {
              streamState._streamingMd.feed(text);
            } else {
              const trimmed = text.trim();
              if (trimmed) _renderTextBlock(trimmed);
            }
          });
          let _lastStatusLine = '';
          let _lastStatusLineAt = 0;
          let _lastStatusText = '';
          let _lastStatusTextAt = 0;
          let _liveStatusOpen = false;
          let _liveStatusKey = '';
          // Transient status: overwrite previous non-essential status line to prevent flooding
          let _onStatusTransientOpen = false; // in-place status line active
          let _lastStatusNormKey = '';
          let _lastStatusNormAt = 0;
          let _lastStatusNormCount = 0;
          const _requestStartedAt = Date.now();
          let _currentPhase = opts._isFollowUp ? 'request' : 'init';
          let _currentStatusText = opts._isFollowUp ? '基于工具结果继续执行' : '准备请求模型';
          const _statusVerbosityPref = String(process.env.KHY_STATUS_VERBOSITY || 'auto').trim().toLowerCase();
          let _statusVerbosity = 'normal';
          let _lowValueRepeatGate = 3;
          let _toolProgressSuccessCount = 0;
          let _suppressedLowValueStatusCount = 0;
          let _suppressedToolProgressSuccessCount = 0;
          let _suppressedExactDedupCount = 0;
          let _suppressedStartWindowCount = 0;
          const _statusEscalateOnErrorEnabled = (() => {
            const raw = String(process.env.KHY_STATUS_ESCALATE_ON_ERROR || 'true').trim().toLowerCase();
            return !['0', 'false', 'off', 'no'].includes(raw);
          })();
          let _statusEscalatedToDetailed = false;
          let _statusFirstAt = 0;
          const _statusStartSilentMs = (() => {
            const raw = String(process.env.KHY_STATUS_START_SILENT_MS || '2000').trim();
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isFinite(parsed)) return 2000;
            return Math.max(0, Math.min(10000, parsed));
          })();
          const _briefToolProgressEvery = (() => {
            const raw = String(process.env.KHY_BRIEF_TOOL_PROGRESS_EVERY || '4').trim();
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isFinite(parsed)) return 4;
            return Math.max(2, Math.min(12, parsed));
          })();
          const _statusBriefInputLen = (() => {
            const raw = String(process.env.KHY_STATUS_BRIEF_INPUT_LEN || '220').trim();
            const parsed = Number.parseInt(raw, 10);
            if (!Number.isFinite(parsed)) return 220;
            return Math.max(80, Math.min(1200, parsed));
          })();
          const _statusDedupMs = (() => {
            const raw = process.env.KHY_AI_STATUS_DEDUP_MS || process.env.GATEWAY_STATUS_DEDUP_MS || '1500';
            const parsed = Number.parseInt(String(raw).trim(), 10);
            if (!Number.isFinite(parsed) || parsed < 200) return 1500;
            return parsed;
          })();
          const _phaseTargetLabel = (phase = '', text = '') => {
            const p = String(phase || '').trim().toLowerCase();
            const provider = ai().getActiveProvider() || 'AI 服务';
            const detail = String(text || '');
            if (p === 'request') {
              if (/预热|本地模型|ollama/i.test(detail)) return '本地模型引擎';
              if (/预检|网关|gateway/i.test(detail)) return 'AI 网关';
              if (/adapter|通道|fallback|切换/i.test(detail)) return '上游通道';
              return provider;
            }
            if (p === 'tool_progress') return '工具执行链路';
            if (p === 'plan') return '计划分解器';
            if (p === 'summary') return '结果整合器';
            if (p === 'compacted') return '上下文压缩器';
            return provider;
          };
          const _buildStatusDetail = (phase = '', text = '', now = Date.now()) => {
            const stage = _phaseStageLabel(phase, text);
            const progress = String(text || '等待下一条链路更新').replace(/\s+/g, ' ').trim();
            const elapsedSec = Math.max(0, Math.floor((now - _requestStartedAt) / 1000));
            return `阶段: ${stage} | 进度: ${progress} | 已耗时: ${elapsedSec}s`;
          };
          const _buildRichStatusLine = (phase = '', text = '', now = Date.now()) => {
            const action = _phaseActionLabel(phase);
            const target = _phaseTargetLabel(phase, text);
            return `${action} | 目标: ${target} | ${_buildStatusDetail(phase, text, now)}`;
          };
          const _setStatusContext = (phase = '', text = '') => {
            if (phase) _currentPhase = String(phase).trim() || _currentPhase;
            const normalized = String(text || '').replace(/\s+/g, ' ').trim();
            if (normalized) _currentStatusText = normalized;
          };
          const _resolveStatusVerbosity = (taskText = '', isLargeTask = false) => {
            if (['brief', 'normal', 'detailed'].includes(_statusVerbosityPref)) return _statusVerbosityPref;
            const len = String(taskText || '').trim().length;
            if (isLargeTask || len >= 700) return 'detailed';
            if (len <= _statusBriefInputLen) return 'brief';
            return 'normal';
          };
          const _flushLiveStatusLine = () => {
            if (!_liveStatusOpen) return;
            try { process.stdout.write('\n'); } catch { /* ignore */ }
            _liveStatusOpen = false;
            _liveStatusKey = '';
            _transientStatusActive = false;
          };
          const _printSuppressedStatusSummary = () => {
            // Only show the folded-status summary in detailed mode or when
            // escalated — in brief mode this line is itself noise.
            if (!_statusEscalatedToDetailed && _statusVerbosity !== 'detailed') return;
            const parts = [];
            if (_suppressedStartWindowCount > 0) parts.push(`启动窗口 ${_suppressedStartWindowCount} 条`);
            if (_suppressedLowValueStatusCount > 0) parts.push(`通道状态 ${_suppressedLowValueStatusCount} 条`);
            if (_suppressedToolProgressSuccessCount > 0) parts.push(`工具成功进度 ${_suppressedToolProgressSuccessCount} 条`);
            if (_suppressedExactDedupCount > 0) parts.push(`重复状态 ${_suppressedExactDedupCount} 条`);
            if (parts.length <= 0) return;
            console.log(c.dim(`  · 已折叠状态：${parts.join(' · ')}`));
          };
          const _maybeEscalateToDetailed = (phase, text, status = null) => {
            if (!_statusEscalateOnErrorEnabled) return;
            if (_statusVerbosity === 'detailed') return;
            if (!_isFailureSignalStatus(phase, text, status)) return;
            _statusVerbosity = 'detailed';
            _currentStatusVerbosity = 'detailed'; // Sync REPL-level tracker
            _lowValueRepeatGate = 1;
            _statusFirstAt = 0;
            if (!_statusEscalatedToDetailed) {
              _statusEscalatedToDetailed = true;
              _flushLiveStatusLine();
              console.log(c.dim('  · 检测到失败信号：本次请求已自动切换为详细状态'));
            }
          };

          // In-chat role auto-detection (DESIGN-ARCH-059 #3). On the interactive
          // CLI path only (this loop never runs in the multi-tenant daemon), spot
          // "你现在是X / 扮演X / act as X" (or "退出角色") in the user's message and
          // adopt/clear the ephemeral role BEFORE the turn — the role store is an
          // in-process singleton, so makeSystemPrompt() picks it up this same turn
          // via getRoleSection. Transparent: print a one-line notice. KHY_ROLE_AUTODETECT=0 off.
          if (process.env.KHY_ROLE_AUTODETECT !== '0') {
            try {
              const _roleSvc = require('../services/roleService');
              const _intent = _roleSvc.detectRoleIntent(message);
              if (_intent.action === 'set' || _intent.action === 'clear') {
                const _r = require('./handlers/role').runRole({
                  role: _intent.role,
                  action: _intent.action,
                });
                if (_r && _r.notice) {
                  const _already = _intent.action === 'set'
                    && _r.success && _r.title
                    && _roleSvc.getActiveRole()
                    && _roleSvc.getActiveRole().title === _r.title;
                  // Always surface set/clear; a redundant re-set still prints once.
                  console.log(c.hex('#9C7BE0')(`  🎭 ${_r.success ? _r.notice : _r.error}`));
                  void _already;
                }
              }
            } catch { /* role auto-detect is best-effort; never block the turn */ }
          }

          // Claude Code: just spinner, no "Requesting AI" text line
          spinner.start(opts._isFollowUp ? 'generating' : 'request');

          let result;
          try {
            const { startWatchdog, WATCHDOG_TIMEOUT_MS } = require('../services/resourceGuard');
            const isLargeTask = (() => {
              const text = String(message || '');
              return text.length >= 700
                || /大型任务|大任务|完整实现|全量|全流程|端到端|deep|exhaustive|full implementation|end-to-end/i.test(text);
            })();
            _statusVerbosity = _resolveStatusVerbosity(message, isLargeTask);
            _currentStatusVerbosity = _statusVerbosity; // Expose to REPL-level utils
            _lowValueRepeatGate = _statusVerbosity === 'brief'
              ? 6
              : (_statusVerbosity === 'detailed' ? 1 : 3);
            _statusFirstAt = Date.now();
            const largeTaskMinTimeoutMs = parseInt(String(process.env.KHY_AI_REQUEST_TIMEOUT_LARGE_MS || '900000'), 10) || 900000;
            const timeoutMs = Math.max(
              isLargeTask ? Math.max(300000, largeTaskMinTimeoutMs) : 300000, // large tasks get wider budget
              Number(process.env.KHY_AI_REQUEST_TIMEOUT_MS || WATCHDOG_TIMEOUT_MS),
            );
            let wd = null;
            wd = startWatchdog('ai-chat', timeoutMs, () => {
              spinner.stop();
              const timeoutTarget = _phaseTargetLabel(_currentPhase, _currentStatusText);
              const timeoutStage = _phaseStageLabel(_currentPhase, _currentStatusText);
              const timeoutProgress = String(_currentStatusText || '等待模型或工具反馈').replace(/\s+/g, ' ').trim();
              renderer.printStepLine(
                'error',
                '链路空闲超时',
                timeoutTarget,
                `阶段: ${timeoutStage} | 最近进度: ${timeoutProgress} | 空闲窗口: ${Math.round(timeoutMs / 1000)}s`
              );
            });
            // Auto-checkpoint before AI turn (30s cooldown)
            let _turnCheckpointId;
            try {
              const _ckCwd = process.env.KHYQUANT_CWD || process.cwd();
              const _ckSvc = require('../services/workspace/checkpointService');
              if (!_lastCheckpointAt || Date.now() - _lastCheckpointAt > 30000) {
                const _ck = _ckSvc.saveCheckpoint(_ckCwd, { message: 'auto: AI 对话前', mode: 'auto' });
                // 记下本回合实拍的检查点 id,随 user 消息盖戳(让逐回合回溯精确恢复到此刻代码)。
                // 仅在真拍了快照时盖戳;cooldown 跳过 → 留空,回溯诚实退回最近检查点。
                _turnCheckpointId = _ck && _ck.id;
                _lastCheckpointAt = Date.now();
              }
            } catch { /* non-critical */ }

            try {
              result = await ai().chat(message, {
                ...opts,
                turnCheckpointId: _turnCheckpointId,
                intentAssuranceDebug: _intentAssuranceDebugEnabled,
                disableNaturalToolLoop: loopManaged,
                onChunk: (chunk) => {
                  if (wd) wd.touch();
                  // Clear in-place transient status when real content arrives
                  if (chunk && (chunk.type === 'text' || chunk.type === 'thinking' || chunk.type === 'tool_use' || chunk.type === 'assistant_preface')) {
                    if (_onStatusTransientOpen && process.stdout.isTTY) {
                      process.stdout.write('\r\x1b[K');
                    }
                    _onStatusTransientOpen = false;
                    _transientStatusActive = false;
                    _flushTransientStatus(); // also clear emitRuntimeStatus transient
                  }
                  return onChunk(chunk);
                },
                onControlRequest: (...args) => {
                  if (wd) wd.touch();
                  const handler = opts.onControlRequest || handleControlRequest;
                  return handler(...args);
                },
                onStatus: (status) => {
                  if (wd) wd.touch();
                  // TUI bridge: record status (best-effort)
                  try { if (_tuiCtrl) _tuiCtrl.recordStatus(status.phase, status.detail || status.text); } catch { /* */ }
                  if (status.phase === 'compacted') {
                    _flushLiveStatusLine();
                    spinner.stop();
                    console.log(`\n${c.hex('#D77757')('✻')} ${c.bold('对话已压缩')} ${c.dim('(ctrl+o 查看历史)')}`);
                    spinner.start('request');
                    showBusyInterjectPrompt();
                    return;
                  }
                const phase = String(status && status.phase ? status.phase : '').trim();
                if (phase === 'intent_assurance_debug') {
                  try {
                    const snapshot = _buildIntentAssuranceDebugSnapshot(status);
                    if (snapshot) {
                      _lastIntentAssuranceDebug = snapshot;
                      _flushLiveStatusLine();
                      spinner.stop();
                      _printIntentAssuranceDebugSnapshot(snapshot, 'live');
                      spinner.start('request');
                      showBusyInterjectPrompt();
                    }
                  } catch { /* non-critical */ }
                  return;
                }
                // Execution brief panel — render immediately before any streaming
                if (phase === 'execution_brief') {
                  // small 任务 + 轻量对话不显示执行简报
                  if (_isSmallTask || String(status.scale || '') === 'small') return;
                  // Collapse init-phase lines before showing brief
                  _initTracker.collapse(c.dim('  · 初始化完成'));
                  try {
                    const briefResult = renderer.printExecutionBrief({
                      request: status.request,
                      scale: status.scale,
                      analysis: status.analysis,
                      steps: status.steps,
                      files: status.files,
                      decomposed: status.decomposed,
                      subtaskCount: status.subtaskCount,
                    }) || {};
                    _briefRenderedLines = briefResult.lineCount || 0;
                    _briefCollapseOpts = {
                      scale: status.scale,
                      fileCount: (status.files || []).length,
                      briefText: briefResult.plainText || '',
                    };
                  } catch { /* non-critical */ }
                  return;
                }
                let text = String(status && status.message ? status.message : '').replace(/\s+/g, ' ').trim();
                if (!text) return;
                _setStatusContext(phase || _currentPhase, text);
                if (phase === 'done') {
                  _markDeliveryGapPending();
                  return;
                }
                // Defer non-critical statuses while AI is streaming text/thinking
                // to avoid breaking the continuous output flow.
                // Plan is allowed through (it should precede text); if it arrives
                // mid-stream, flush buffered text first so plan appears on its own line.
                if (_busyStreaming && phase !== 'error' && phase !== 'compacted') {
                  if (phase === 'plan') {
                    // Flush any in-progress streamed text so plan appears cleanly
                    try { flushTextBuffer(streamState, c, true); } catch {}
                  } else {
                    // Non-plan, non-error: suppress entirely during streaming
                    _deferredStatuses.push({ phase, text, status });
                    return;
                  }
                }
                // Init-phase diagnostics: suppress in brief mode, track via
                // InitPhaseTracker in detailed mode (for later folding).
                if (phase === 'init') {
                  if (_statusVerbosity === 'brief') {
                    _suppressedLowValueStatusCount += 1;
                    _recordFoldedStatus('init-brief', phase, text);
                  } else {
                    spinner.stop();
                    _initTracker.addLine(c.dim(`  · ${text}`));
                    spinner.start('request');
                    showBusyInterjectPrompt();
                  }
                  return;
                }
                if (phase === 'request') {
                  if (/^建议下一步[:：]/.test(text)) return;
                  if (/真实失败原因|建议下一步|失败原因[:：]\s*真实失败原因/.test(text)) {
                    text = compactGatewayStatusText(text, { maxLen: 200 });
                  }
                }
                _maybeEscalateToDetailed(phase, text, status);
                const now = Date.now();
                _markDeliveryGapPending();
                if (
                  _statusVerbosity === 'brief'
                  && _statusStartSilentMs > 0
                  && _statusFirstAt > 0
                  && (now - _statusFirstAt) < _statusStartSilentMs
                  && !_shouldBypassStartSilent(phase, text, status)
                ) {
                  _suppressedStartWindowCount += 1;
                  _recordFoldedStatus('start-window', phase, text);
                  return;
                }
                const normKey = _normalizeStatusDedupKey(phase, text);
                const normBurstWindowMs = Math.max(1200, _statusDedupMs * 2);
                if (
                  normKey
                  && _lastStatusNormKey
                  && normKey === _lastStatusNormKey
                  && (now - _lastStatusNormAt) < normBurstWindowMs
                ) {
                  _lastStatusNormAt = now;
                  _lastStatusNormCount += 1;
                  if (_isLowValueGatewayStatus(phase, text)) {
                    if (_lowValueRepeatGate > 1 && (_lastStatusNormCount % _lowValueRepeatGate) !== 0) {
                      _suppressedLowValueStatusCount += 1;
                      _recordFoldedStatus('low-value-repeat', phase, text);
                      return;
                    }
                    text = `${text}（同类状态 ×${_lastStatusNormCount}）`;
                  }
                } else {
                  _lastStatusNormKey = normKey;
                  _lastStatusNormAt = now;
                  _lastStatusNormCount = 1;
                }
                const sig = `${phase}:${text}`;
                  if (sig === _lastStatusLine && (now - _lastStatusLineAt) < _statusDedupMs) {
                    _suppressedExactDedupCount += 1;
                    _recordFoldedStatus('exact-dedup', phase, text);
                    return;
                  }
                  if (text === _lastStatusText && (now - _lastStatusTextAt) < _statusDedupMs) {
                    _suppressedExactDedupCount += 1;
                    _recordFoldedStatus('exact-dedup', phase, text);
                    return;
                  }
                  _lastStatusLine = sig;
                  _lastStatusLineAt = now;
                  _lastStatusText = text;
                  _lastStatusTextAt = now;
                  if (_isDynamicProgressStatus(phase, text)) {
                    spinner.stop();
                    const liveKey = _normalizeProgressKey(phase, text);
                    const liveLine = _buildRichStatusLine(phase, text, now);
                    if (!_liveStatusOpen || _liveStatusKey !== liveKey) {
                      if (_liveStatusOpen) _flushLiveStatusLine();
                      _clearVisibleBusyPromptLine();
                      try { process.stdout.write(c.dim(`  · ${liveLine}`)); } catch { console.log(c.dim(`  · ${liveLine}`)); }
                      _liveStatusOpen = true;
                      _liveStatusKey = liveKey;
                    } else {
                      try { process.stdout.write(`\r\x1b[K${c.dim(`  · ${liveLine}`)}`); } catch { /* ignore */ }
                    }
                    _transientStatusActive = true; // Block keepalive/prompt
                    // Do NOT restart spinner here — it would fight with the
                    // live-status line for the same terminal row, causing
                    // duplicate/stacking lines on screen.
                    return;
                  }
                  _flushLiveStatusLine();
                  spinner.stop();

                  // Tool progress from ai.chat() natural tool loop — show with step indicators
                  if (phase === 'tool_progress') {
                    const toolName = status.toolName || '';
                    const toolLabel = toolName ? mapToolToPhaseLabel(toolName) : '工具步骤';
                    // Prefer the shared live-activity target ("正在 … 里搜索 \"x\"") so the
                    // REPL names the real event, matching the TUI. Falls back to the
                    // bare tool name, then the generic phase target.
                    let _liveTarget = '';
                    try {
                      _liveTarget = toolName
                        ? (_deriveLiveActivity({ status: 'tool_progress', runningTool: { name: toolName, input: status.toolArg } }) || '')
                        : '';
                    } catch { _liveTarget = ''; }
                    const toolTarget = _liveTarget || toolName || _phaseTargetLabel(phase, text);
                    const toolDetail = _buildStatusDetail(phase, text, now);
                    const success = status.success;
                    if (_statusVerbosity === 'brief' && success === true) {
                      _toolProgressSuccessCount += 1;
                      if ((_toolProgressSuccessCount % _briefToolProgressEvery) !== 0) {
                        _suppressedToolProgressSuccessCount += 1;
                        _recordFoldedStatus('tool-progress-brief', phase, text);
                        spinner.start('request');
                        showBusyInterjectPrompt();
                        return;
                      }
                      text = `${text}（进度摘要 ×${_toolProgressSuccessCount}）`;
                    }
                    if (success === true) {
                      renderer.printStepLine('success', toolLabel, toolTarget, toolDetail);
                    } else if (success === false) {
                      renderer.printStepLine('error', toolLabel, toolTarget, toolDetail);
                    } else {
                      renderer.printStepLine('active', toolLabel, toolTarget, toolDetail);
                    }
                    spinner.start('request');
                    showBusyInterjectPrompt();
                    return;
                  }

                  if (phase === 'plan') {
                    if (_statusVerbosity !== 'brief') {
                      renderer.printStepLine('active', '执行计划', _phaseTargetLabel(phase, text), _buildStatusDetail(phase, text, now));
                    }
                    spinner.start('request');
                    showBusyInterjectPrompt();
                    return;
                  }

                  if (phase === 'summary') {
                    if (_statusVerbosity !== 'brief') {
                      renderer.printStepLine('done', '交付总结', _phaseTargetLabel(phase, text), _buildStatusDetail(phase, text, now));
                    }
                    spinner.start('request');
                    showBusyInterjectPrompt();
                    return;
                  }

                  // Classify onStatus messages for rich display.
                  // Transient status lines (adapter switching, probing, retries, general)
                  // overwrite the previous transient line to prevent flooding when the
                  // gateway cascade retries many adapters.
                  const _lower = text.toLowerCase();
                  const richTarget = _phaseTargetLabel(phase, text);
                  const richDetail = _buildStatusDetail(phase, text, now);
                  // Helper: write in-place transient line (no newline, no spinner)
                  const _writeOnStatusTransient = (txt) => {
                    if (!process.stdout.isTTY) return;
                    spinner.stop();
                    _clearVisibleBusyPromptLine();
                    process.stdout.write(`\r\x1b[K${c.dim(`  · ${txt}`)}`);
                    _onStatusTransientOpen = true;
                    _transientStatusActive = true; // Block keepalive/prompt
                  };
                  // Helper: print permanent status line
                  const _printOnStatusTerminal = (st, lbl, tgt, dtl) => {
                    if (_onStatusTransientOpen && process.stdout.isTTY) {
                      process.stdout.write('\r\x1b[K');
                      _onStatusTransientOpen = false;
                      _transientStatusActive = false;
                    }
                    _flushTransientStatus();
                    spinner.stop();
                    renderer.printStepLine(st, lbl, tgt, dtl);
                    spinner.start('request');
                    showBusyInterjectPrompt();
                  };

                  if (_lower.includes('重试') || _lower.includes('retry')) {
                    _printOnStatusTerminal('error', '请求重试', richTarget, richDetail);
                  } else if (_lower.includes('responded') || _lower.includes('已连接')) {
                    _printOnStatusTerminal('done', '模型已连接', richTarget, richDetail);
                  } else if (_isFailureMetricOnlyStatus(text)) {
                    if (_statusVerbosity !== 'brief') {
                      _writeOnStatusTransient(_buildRichStatusLine(phase, text, now));
                    } else {
                      _suppressedLowValueStatusCount += 1;
                      _recordFoldedStatus('brief-metrics', phase, text);
                    }
                  } else if (_lower.includes('failed') || _lower.includes('error') || _lower.includes('异常') || _lower.includes('失败')) {
                    _printOnStatusTerminal('error', '请求异常', richTarget, richDetail);
                  } else if (_lower.includes('尝试通道') || _lower.includes('switching') || _lower.includes('首选通道')) {
                    if (_statusVerbosity !== 'brief') {
                      _writeOnStatusTransient(_buildRichStatusLine(phase, text, now));
                    } else {
                      _suppressedLowValueStatusCount += 1;
                      _recordFoldedStatus('brief-adapter', phase, text);
                    }
                  } else {
                    if (_statusVerbosity !== 'brief') {
                      _writeOnStatusTransient(_buildRichStatusLine(phase, text, now));
                    } else {
                      _suppressedLowValueStatusCount += 1;
                      _recordFoldedStatus('brief-generic', phase, text);
                    }
                  }
                  // For transient writes, do NOT restart spinner or repaint
                  // prompt — the in-place line will be overwritten naturally.
                  if (!_onStatusTransientOpen) {
                    // Terminal status already restarted spinner+prompt
                  }
                },
                onWait: (adapterKey, waitMs) => {
                  if (wd) wd.touch();
                  try {
                    _flushLiveStatusLine();
                    spinner.stop();
                    const sec = Math.max(0, Number(waitMs || 0) / 1000);
                    const waitText = `限流等待 ${sec.toFixed(1)}s，结束后继续请求`;
                    _setStatusContext('request', waitText);
                    renderer.printStepLine('active', '频率限制', adapterKey || _phaseTargetLabel('request', waitText), `API 限制了请求频率，等待 ${sec.toFixed(1)}s 后自动恢复`);
                    spinner.start('request');
                    showBusyInterjectPrompt();
                  } catch { /* best effort */ }
                },
                onFallback: (info) => {
                  if (wd) wd.touch();
                  _maybeEscalateToDetailed('fallback', info && info.failedError ? info.failedError : '', { success: false });
                  _flushLiveStatusLine();
                  spinner.stop();
                  // Clear text buffer accumulated from the failed adapter to
                  // prevent duplicate content when the next adapter streams
                  // the same reply.
                  streamState._textBuffer = '';
                  streamState._streamedTextLen = 0;
                  streamState.textStarted = false;
                  if (streamState._streamingMd) streamState._streamingMd.reset();
                  const statusCode = info.failedStatusCode ? ` (${info.failedStatusCode})` : '';
                  const fallbackText = `${info.failedError || '上游返回失败'}${statusCode}，准备切换到下一个通道`;
                  _setStatusContext('request', fallbackText);
                  renderer.printStepLine('error', '通道不可用', info.failedAdapter || _phaseTargetLabel('request', fallbackText), _buildStatusDetail('request', fallbackText));
                  if (info.nextAdapter) {
                    const switchText = `准备切换到 ${info.nextAdapter}`;
                    _setStatusContext('request', switchText);
                    renderer.printStepLine('active', '切换备用通道', info.nextAdapter, _buildStatusDetail('request', switchText));
                  }
                  spinner.start('request');
                  showBusyInterjectPrompt();
                },
              });
            } finally {
              wd.done();
            }
          } catch (wdErr) {
            spinner.stop();
            if (tracker.isActive) tracker.complete();
            throw wdErr;
          }

          spinner.stop();
          _flushLiveStatusLine();

          if (streamState.phase === 'thinking') {
            closeThinkingStream(streamState);
            console.log('');
          }

          // Flush any remaining buffered text so the complete response is
          // rendered before summary/status lines appear.
          flushTextBuffer(streamState, c, true);

          // Update context usage for auto-compact display
          if (result && result.tokenUsage) {
            try {
              const hud = require('./hudRenderer');
              // 占用率喂入值 = 未缓存输入 + 读/写缓存段(对齐 CC context.ts
              // totalInputTokens = input + cache_creation + cache_read;命中缓存的
              // token 仍占据上下文窗口,只是计费更便宜。门控关 → 仅 inputTokens 字节回退)。
              const inputTokens = result.tokenUsage.inputTokens || result.tokenUsage.promptTokens || 0;
              if (inputTokens > 0) {
                const limit = hud.getContextLimit(result.model || '');
                const { contextResidentTokensOr } = require('./contextResidentTokens');
                hud.setContextUsage(contextResidentTokensOr(result.tokenUsage, inputTokens, process.env), limit);
              }
              hud.updateTokens(result.tokenUsage);
              // Forward model/adapter/cost to HUD status bar
              const modelName = result.model || '';
              const adapterName = result.adapter || result.provider || result.actualAdapter || '';
              let turnCostUSD = 0;
              try {
                const tokenSvc = require('../services/tokenUsageService');
                turnCostUSD = tokenSvc.estimateCost(inputTokens, result.tokenUsage.outputTokens || 0, modelName || adapterName);
              } catch { /* cost estimation not critical */ }
              hud.updateModelInfo(modelName, adapterName, turnCostUSD);
            } catch { /* best-effort */ }
            // 刀114:缓存命中率警告(对齐 CC cacheWarning.ts 每回合一次性 system 警告,
            // 及 TUI useQueryBridge 孪生)。命中率跌破阈值(默认 80%,KHY_CACHE_THRESHOLD)
            // → 打一行 dim 通知并带 vs 上回合趋势箭头;首观只播种不警告;无缓存数据
            // (usage 无 read/write 段)→ null 不动 state。经典 REPL 此前从不接此判定
            // (仅 TUI 有)—— TUI-vs-经典 REPL drift 家族(承刀105/106):同一「背后逻辑」
            // TUI 已接、经典面缺席。display-only 绝不回灌模型/碰权限/预算;门控
            // KHY_CACHE_WARNING 关 / 任何错误 → no-op(不打印本行,逐字节回退刀114前)。
            try {
              const cacheWarn = require('./cacheWarning');
              const cw = cacheWarn.cacheWarningFor(
                { usage: result.tokenUsage, lastHitRate: _lastCacheHitRate },
                process.env,
              );
              if (cw) {
                _lastCacheHitRate = cw.hitRate;
                if (cw.text) {
                  console.log(c.dim(`  ${cw.text}`));
                  // 命中率低时才归因(承 promptPrefixShape 叶子,此前零消费者):把「为什么没
                  // 命中」从数字变成可定位。attribution 无低命中警告时属噪音,故只在此追加一行。
                  // display-only;门控 KHY_CACHE_PREFIX_SHAPE 关 / 无 shape / 首观 / 前缀未变
                  // → pa 为 null 或 pa.text 为 null → 不打印(逐字节回退)。
                  try {
                    const pa = cacheWarn.prefixAttributionFor(
                      { curShape: result.prefixShape, prevShape: _lastPrefixShape },
                      process.env,
                    );
                    if (pa && pa.text) console.log(c.dim(`  ↳ ${pa.text}`));
                  } catch { /* 归因是装饰性,绝不打断 */ }
                }
              }
              // 无论是否警告,都刷新前缀基线供下一轮趋势对比;无 shape → 保持不动(逐字节回退)。
              if (result.prefixShape) _lastPrefixShape = result.prefixShape;
              // 会话累计命中率(承 KHY_CACHE_SESSION_AGGREGATE)。比单轮稳:把整会话
              // hit/miss 累加。仅 ≥2 轮才显示(单轮时会话=单轮,无额外信息)。门控关 /
              // 任何错误 → null,不累计不打印(逐字节回退到只显示单轮)。display-only。
              const agg = cacheWarn.sessionAggregateFor(
                { usage: result.tokenUsage, session: _sessionCache },
                process.env,
              );
              if (agg) {
                _sessionCache = agg.session;
                if (agg.text) console.log(c.dim(`  ${agg.text}`));
              }
            } catch { /* cache warning is cosmetic; never disrupt a turn */ }
            // 会话花费阈值一次性警告(对齐 CC CostThresholdDialog 的背后逻辑:累计
            // 会话 API 花费首次越过阈值 —— CC 硬编码 $5 —— 时提醒一次)。经典 REPL 与
            // TUI 此前皆无此判定(不同于缓存警告的 TUI-only drift,本项两面同缺),故
            // 两面一并接线以免制造新 drift。display-only:仅打一行 dim 通知,一次性由
            // _costThresholdWarned 守(对齐 hasShownCostDialog),绝不阻断/回灌模型/碰
            // 预算/权限。门控 KHY_COST_THRESHOLD_WARNING 关 / 任何错误 → no-op
            // (不打印本行,逐字节回退本刀前)。花费取 tokenUsageService 累计会话真值。
            try {
              const costWarn = require('./costThresholdWarning');
              const tokenSvc = require('../services/tokenUsageService');
              const sessionCostUSD = tokenSvc.getSessionCost().costUSD;
              const cw = costWarn.costThresholdFor(
                { sessionCostUSD, alreadyWarned: _costThresholdWarned },
                process.env,
              );
              if (cw && cw.text) {
                _costThresholdWarned = true;
                console.log(c.dim(`  ${cw.text}`));
              }
            } catch { /* cost warning is cosmetic; never disrupt a turn */ }
          }

          // Print completion summary with stats (provider, elapsed, tokens)
          if (result && result.content) {
            const elapsed = result.elapsed || result.elapsedMs || (Date.now() - (result._startTime || Date.now()));
            const elapsedSec = typeof elapsed === 'number' && elapsed > 0 ? (elapsed / 1000).toFixed(1) : null;
            const provider = result.provider || result.adapter || result.actualAdapter || '';
            const model = result.model || '';
            const tokens = result.tokenUsage;
            const parts = [];
            if (provider) parts.push(provider);
            if (model && model !== provider) parts.push(model);
            if (elapsedSec) parts.push(require('./ccFormat').ccFormatDurationOr(elapsed, `${elapsedSec}s`, process.env));
            if (tokens) {
              const inT = tokens.inputTokens || tokens.promptTokens || 0;
              const outT = tokens.outputTokens || tokens.completionTokens || 0;
              if (inT || outT) {
                const fmt = (n) => _tkSpin(n);
                parts.push(`↑${fmt(inT)} ↓${fmt(outT)}`);
              }
            }
            // Enhanced transparency: per-turn cost + model + cascade
            try {
              const turnData = {
                inputTokens: tokens?.inputTokens || tokens?.promptTokens || 0,
                outputTokens: tokens?.outputTokens || tokens?.completionTokens || 0,
                cacheReadTokens: tokens?.cacheReadTokens || 0,
                model: model || '',
                adapter: provider || '',
                durationMs: typeof elapsed === 'number' ? elapsed : 0,
              };
              // Estimate cost
              try {
                const tokenSvc = require('../services/tokenUsageService');
                turnData.costUSD = tokenSvc.estimateCost(turnData.inputTokens, turnData.outputTokens, model || provider);
              } catch { /* no cost estimation available */ }

              renderer.printTurnCost(turnData);

              // Cascade transparency (if multiple adapters were tried)
              if (result.cascade && Array.isArray(result.cascade) && result.cascade.length > 1) {
                renderer.printCascadeSteps(result.cascade);
              }

              // Quota warning check
              try {
                const tokenSvc = require('../services/tokenUsageService');
                const quota = tokenSvc.getRemainingQuota();
                renderer.printQuotaWarning(quota);
              } catch { /* ignore */ }
            } catch { /* transparency is best-effort */ }

            if (parts.length > 0 && !renderer.printTurnCost) {
              // Fallback if transparency not available
              console.log(c.dim(`  ${parts.join(' · ')}`));
            }
          }
          _printSuppressedStatusSummary();
          return result;
        };

        let loopResult;
        let _cooperativeFallbackText = null;
        let _cooperativeLabel = '';
        let loopIterations = 0;
        let _regressionGateResult = null;
        let _loopToolCount = 0;
        // 过程叙述「不机械」:本回合每类工具出现次数,供共享 voice 轮换续接句(见 streaming
        // 路径同名 helper)。loop-callback 路径与 streaming 路径各持一个计数器(两路径互斥)。
        const _loopPrefaceOccurrences = new Map();
        // 连续同类工具 preface 抑制(修刷屏):记上一条已发出 preface 的工具类别键。
        let _lastLoopPrefaceKey = '';
        const _nextLoopPrefaceOcc = (toolName) => {
          try {
            const key = String(toolName || '').toLowerCase().replace(/[\s_-]/g, '');
            const cur = _loopPrefaceOccurrences.get(key) || 0;
            _loopPrefaceOccurrences.set(key, cur + 1);
            return cur;
          } catch { return 0; }
        };
        // small task: suppress verbose process steps (decision detail, capability check, etc.)
        const _isSmallTask = (() => {
          try {
            const { resolveTaskScale } = require('../services/taskScale');
            return resolveTaskScale(finalAiInput) === 'small';
          } catch { return false; }
        })();
        const _loopStartTime = Date.now();
        const deterministicQuickTasksEnabled = String(process.env.KHY_DETERMINISTIC_QUICK_TASKS || 'true').toLowerCase() !== 'false';
        let quickTaskPlan = null;
        // 图片附着时通常应让路给视觉路径(用户文本多为图注/指令,不应被 calc/file-op 等
        // 确定性 handler 劫持)。**唯一例外**:一段裸 API Key 绝不可能是合法图注——若用户
        // 在识图失败后直接粘 key,必须仍被 key_update 拦截写入,否则 key 会随图一起被送进
        // 视觉/agent 路径当作泛化 token 处理(model 去解码 hash / 搜盘),邀请贴 key 的承诺落空。
        const _imageAttached = !!(_inlineImageOpts && Array.isArray(_inlineImageOpts.images) && _inlineImageOpts.images.length > 0);
        if (deterministicQuickTasksEnabled) {
          try {
            const quickTaskService = require('../services/quickTaskService');
            const _plan = quickTaskService.detectQuickTask(finalAiInput, { cwd: process.cwd() });
            // 有图时只接受 key_update(裸 key 永不是图注);无图时接受全部确定性计划。
            if (_plan && (!_imageAttached || _plan.type === 'key_update')) {
              quickTaskPlan = _plan;
            }
          } catch { /* non-blocking */ }
        }
        const useDeterministicQuickTask = !!(quickTaskPlan && quickTaskPlan.type);
        if (useDeterministicQuickTask) {
          renderer.printStepLine('active', '执行策略', quickTaskPlan.type, `确定性快执行（${quickTaskPlan.label || quickTaskPlan.type}）`);
        }

        if (useDeterministicQuickTask) {
          const quickTaskService = require('../services/quickTaskService');
          const quickStartedAt = Date.now();
          let quickResult;
          try {
            quickResult = await Promise.resolve(quickTaskService.executeQuickTask(quickTaskPlan, {
              cwd: process.cwd(),
              onStatus: (status = {}) => {
                const level = status.level === 'success' ? 'success' : (status.level === 'error' ? 'error' : 'active');
                const action = String(status.action || '快速执行').trim() || '快速执行';
                const target = String(status.target || '').trim();
                const progress = String(status.progress || '').trim();
                const detail = String(status.detail || '').trim();
                const progressText = progress || '步骤已启动，等待下一条进度更新';
                renderer.printStepLine(level, action, target, progressText);
                if (detail) renderer.printStepDetail(detail);
              },
            }));
          } catch (err) {
            quickResult = { success: false, error: String(err && err.message ? err.message : err || '快速执行失败') };
          }

          const quickText = quickTaskService.formatQuickTaskResult(quickResult);
          const quickElapsed = Date.now() - quickStartedAt;
          renderer.printStepLine(
            quickResult && quickResult.success ? 'success' : 'error',
            '快速执行结果',
            quickTaskPlan.label || quickTaskPlan.type || 'quick-task',
            require('./ccFormat').ccFormatDurationOr(quickElapsed, `${(quickElapsed / 1000).toFixed(1)}s`, process.env),
          );
          // Record Tier 1 turns into session context memory
          try {
            const _lb = require('../services/localBrainService');
            _lb.pushContext('user', finalAiInput);
            if (quickText) _lb.pushContext('assistant', quickText, { category: quickTaskPlan.category || quickTaskPlan.type });
          } catch { /* non-blocking */ }

          // ── 协作模式：有模型 + cooperative → 注入数据为上下文，交给模型增强 ──
          const _isCooperative = quickTaskPlan.cooperative && quickResult && quickResult.success;
          let _cooperativeModelAvail = false;
          if (_isCooperative) {
            try { _cooperativeModelAvail = require('../services/localBrainService').isModelAvailable(); } catch {}
          }
          if (_isCooperative && _cooperativeModelAvail && quickText && !_localMode) {
            // 重写 finalAiInput，注入本地数据为上下文，不设 loopResult → 继续到模型路径
            const _dataLabel = quickTaskPlan.category || quickTaskPlan.type || 'local-data';
            _cooperativeLabel = quickTaskPlan.label || _dataLabel;
            _cooperativeFallbackText = quickText;
            const _originalInput = finalAiInput;
            finalAiInput = `[KHY 本地能力已获取以下实时数据/分析结果，请基于此数据用自然语言回答用户问题，不要重复原始数据格式]\n\n` +
                           `--- ${_dataLabel} 数据 ---\n${quickText}\n---\n\n` +
                           `用户原始问题: ${_originalInput}`;
            renderer.printStepLine('success', '本地数据', _cooperativeLabel, '已获取实时结果，正在交给模型生成最终答复');
          } else {
            // 无模型 / 非协作 / 失败 → 直接展示（当前行为）
            spinner.stop();
            if (quickText) {
              renderer.renderAiResponse(quickText).split('\n').forEach((line) => console.log(`  ${line}`));
              console.log('');
              responseAlreadyRendered = true;
            }
            loopResult = {
              finalResponse: quickText || '',
              provider: 'khy-quick-task',
              tokenUsage: null,
              errorType: quickResult && quickResult.success ? null : (quickResult && quickResult.error ? String(quickResult.error) : 'quick_task_failed'),
              iterations: 1,
              toolCallLog: [],
            };
          }
        }

        // ── Force local mode: deterministic brain → local LLM → web search ──
        // "本地模式" means no cloud dependency, NOT "no model": a locally-running
        // model (Ollama / llama.cpp) is still local, so prefer it for anything
        // the deterministic Tier 1/2 brain can't answer.
        if (_localMode && !loopResult) {
          try {
            const localBrain = require('../services/localBrainService');
            spinner.stop();
            const fallback = await localBrain.tryFallback(finalAiInput, { cwd: process.cwd(), forceLocal: true, skipWebSolver: true });
            if (fallback && fallback.handled) {
              renderer.printStepLine('success', 'KHY 本地', fallback.category || '', '');
              renderer.renderAiResponse(String(fallback.response || '')).split('\n').forEach(l => console.log(`  ${l}`));
              console.log('');
              responseAlreadyRendered = true;
              loopResult = { finalResponse: fallback.response, provider: 'khy-local-forced', tokenUsage: null, iterations: 0, toolCallLog: [] };
            } else {
              // Deterministic brain missed. Before degrading to web-search
              // links, run the local tool loop. If a local model (Ollama /
              // llama.cpp) is available it drives the loop; if NOT, the loop
              // still runs deterministically (no model) via its rule-based
              // planner — "本地模式无模型也要能用". Either way tools go through the
              // same guarded executeTool funnel.
              let localLLMHandled = false;
              try {
                const gateway = require('../services/gateway/aiGateway');
                const localLoop = require('../services/localToolLoop');
                const localKey = typeof gateway.getAvailableLocalAdapter === 'function'
                  ? gateway.getAvailableLocalAdapter()
                  : null;

                // Routing (loop-collapse):
                //  • KHY_LEGACY_LOCAL_LOOP=1 → legacy localToolLoop MODEL mode
                //    (kill-switch, removed in a later cleanup PR).
                //  • local model present → UNIFIED runToolUseLoop over the text
                //    tool-call protocol, so the weak model gains PostToolUse
                //    hooks, failsafe attribution, write-diff and dedup for free.
                //  • no model (offline) → standalone deterministic localToolLoop
                //    planner (kept independent by design — read-only).
                const legacyLocalLoop = /^(1|true|yes|on)$/i.test(String(process.env.KHY_LEGACY_LOCAL_LOOP || '').trim());
                const useMainLoop = !!localKey && !legacyLocalLoop;

                let originSource = '确定性';
                let providerLabel = 'KHY 本地工具';
                let providerKey = 'deterministic';
                if (localKey) {
                  const origin = gateway.getAdapterOrigin ? gateway.getAdapterOrigin(localKey) : { source: localKey };
                  originSource = origin.source || localKey;
                  providerLabel = 'KHY 本地模型';
                  providerKey = localKey;
                }
                const busyLabel = () => (localKey ? `本地模型推理中（${originSource}）` : '本地工具循环（无模型）');
                if (spinner && spinner.start) spinner.start(busyLabel());

                // Tell the deterministic planner whether the network is up, so
                // it won't plan WebFetch/WebSearch while we hold a fresh offline
                // reading (those would just burn a connect timeout before
                // failing). Permissive: defaults to true unless confidently offline.
                let netUpForPlan = true;
                try {
                  const netDetector = require('../services/networkDetector');
                  netUpForPlan = typeof netDetector.shouldAttemptNetwork === 'function'
                    ? netDetector.shouldAttemptNetwork()
                    : true;
                } catch { /* detector unavailable → stay permissive */ }

                // Normalized across both loops: { finalText, ranTool, iterations, toolCalls }.
                let finalText = '';
                let ranTool = false;
                let iterations = 0;
                let toolCalls = [];

                if (useMainLoop) {
                  // ── UNIFIED PATH: weak local model on the text protocol ──────
                  const { makeLocalModelChat } = require('../services/localChatAdapters');
                  const { runToolUseLoop } = require('../services/toolUseLoop');
                  // Approval channel present → advertise the write/shell delivery
                  // tier. executeTool still fail-closes every high-risk call; the
                  // syscall gateway L2 red lines are never relaxed here.
                  const chat = makeLocalModelChat(gateway, localKey, {
                    writeEnabled: typeof handleControlRequest === 'function',
                  });
                  const loopRes = await runToolUseLoop(finalAiInput, {
                    chat,
                    toolCallProtocol: 'text',
                    sessionId: 'local-tool-loop',
                    onControlRequest: handleControlRequest,
                    // Same cross-turn repeat guard feed as the main path.
                    recentToolSignatures: {
                      exact: _recentToolSigs.map((e) => e.sig).filter(Boolean),
                      intents: _recentToolSigs.map((e) => e.intentKey).filter(Boolean),
                    },
                    onToolCall: (name) => {
                      if (spinner && spinner.stop) spinner.stop();
                      renderer.printStepLine('active', '本地工具', name || '', '');
                      if (spinner && spinner.start) spinner.start(busyLabel());
                    },
                    onToolResult: (name, result, params) => {
                      // Surface denials/failures — a weak model's denied write
                      // must not be silently swallowed.
                      const r = result || {};
                      if (r.denied) {
                        if (spinner && spinner.stop) spinner.stop();
                        renderer.printStepLine('error', '本地工具', name || '', '已拒绝');
                        if (spinner && spinner.start) spinner.start(busyLabel());
                      } else if (r.success === false) {
                        if (spinner && spinner.stop) spinner.stop();
                        renderer.printStepLine('error', '本地工具', name || '', '失败');
                        if (spinner && spinner.start) spinner.start(busyLabel());
                      } else {
                        // Harvest the successful local call's signature (bounded).
                        try {
                          const sigFor = require('../services/toolUseLoop')._signatureForCall;
                          const { sig, intentKey } = sigFor(name, params || {}, null);
                          if (sig || intentKey) {
                            _recentToolSigs.push({ sig, intentKey });
                            if (_recentToolSigs.length > 8) _recentToolSigs.shift();
                          }
                        } catch { /* best-effort */ }
                      }
                    },
                  });
                  if (spinner && spinner.stop) spinner.stop();
                  finalText = loopRes && String(loopRes.finalResponse || '').trim();
                  toolCalls = (loopRes && loopRes.toolCallLog) || [];
                  ranTool = toolCalls.length > 0;
                  iterations = (loopRes && loopRes.iterations) || 0;
                } else {
                  // ── LEGACY / DETERMINISTIC PATH via localToolLoop ────────────
                  // generate undefined → deterministic no-model planner.
                  let generate;
                  if (localKey) {
                    generate = (prompt, genOpts = {}) => gateway.generateWithSubModel(
                      prompt, localKey,
                      { cwd: process.cwd(), system: genOpts.system, messages: genOpts.messages }
                    );
                  }
                  const loopRes = await localLoop.runLocalToolLoop(finalAiInput, {
                    generate,
                    networkUp: netUpForPlan,
                    // Real fs existence drives the read-before-write enforcer: an
                    // edit always needs a prior read; a write only when the target
                    // already exists (overwrite) — a fresh create needs no read.
                    fileExists: (p) => { try { return require('fs').existsSync(require('path').resolve(process.cwd(), String(p))); } catch { return false; } },
                    // Approval channel tags the audit trail and carries the
                    // can_use_tool prompt; without it the write tier fail-closes.
                    traceContext: {
                      sessionId: 'local-tool-loop',
                      onControlRequest: handleControlRequest,
                    },
                    onStep: (ev) => {
                      // State transparency: surface each tool step as it runs.
                      if (ev.type === 'tool') {
                        if (spinner && spinner.stop) spinner.stop();
                        renderer.printStepLine('active', '本地工具', ev.name || '', '');
                        if (spinner && spinner.start) spinner.start(busyLabel());
                      } else if (ev.type === 'tool_result' && ev.result) {
                        const r = ev.result;
                        if (r.denied) {
                          if (spinner && spinner.stop) spinner.stop();
                          renderer.printStepLine('error', '本地工具', ev.name || '', '已拒绝');
                          if (spinner && spinner.start) spinner.start(busyLabel());
                        } else if (r.success === false) {
                          if (spinner && spinner.stop) spinner.stop();
                          renderer.printStepLine('error', '本地工具', ev.name || '', '失败');
                          if (spinner && spinner.start) spinner.start(busyLabel());
                        }
                      }
                    },
                  });
                  if (spinner && spinner.stop) spinner.stop();
                  finalText = loopRes && String(loopRes.finalText || '').trim();
                  toolCalls = (loopRes && loopRes.toolCalls) || [];
                  ranTool = toolCalls.length > 0;
                  iterations = (loopRes && loopRes.iterations) || 0;
                }

                // With a model, any non-empty answer counts. Without a model, an
                // empty deterministic result means "no tool intent matched" → let
                // it fall through to web search rather than printing nothing.
                if (finalText && (localKey || ranTool)) {
                  renderer.printStepLine('success', providerLabel, originSource, '');
                  String(finalText).split('\n').forEach(l => console.log(`  ${l}`));
                  console.log('');
                  responseAlreadyRendered = true;
                  loopResult = {
                    finalResponse: finalText,
                    provider: `khy-local-${providerKey}`,
                    tokenUsage: null,
                    iterations,
                    toolCallLog: toolCalls,
                  };
                  localLLMHandled = true;
                }
              } catch { /* local loop failed — fall through to web search */ }

              // 工具循环未命中（非可执行任务）→ 尽力联网求解：多策略检索
              // （原始查询→核心词→关键词蒸馏）+ 跨策略聚合 + IR/organize 综合；
              // 确实无结果时给出诚实的「已尝试 + 如何继续」，而非道歉或能力菜单。
              if (!localLLMHandled) {
                const c = require('chalk');
                let solved = null;
                try {
                  solved = await localBrain.solveWithWeb(finalAiInput);
                } catch { /* solver unavailable → honest message below */ }
                if (solved && solved.answer) {
                  if (solved.resultCount > 0) {
                    renderer.printStepLine('success', 'KHY 本地', '网络搜索', '');
                  }
                  renderer.renderAiResponse(String(solved.answer)).split('\n').forEach(l => console.log(`  ${l}`));
                  console.log('');
                  loopResult = { finalResponse: solved.answer, provider: 'khy-local-forced', tokenUsage: null, iterations: 0, toolCallLog: [] };
                } else {
                  // 离线或检索通道不可用：诚实告知 + 可继续的方式（仍非道歉）。
                  console.log(c.yellow('\n  本地模式 — 当前离线，无法联网检索该问题。\n'));
                  console.log(c.dim('  你可以：联网后重试、把问题拆得更具体，或输入 /local 关闭本地模式以使用 AI 模型。\n'));
                  loopResult = { finalResponse: '', provider: 'khy-local-forced', tokenUsage: null, iterations: 0, toolCallLog: [] };
                }
                responseAlreadyRendered = true;
              }
            }
          } catch (e) {
            spinner.stop();
            printError(`本地模式处理失败: ${e.message}`);
            loopResult = { finalResponse: '', provider: 'khy-local-forced', tokenUsage: null, iterations: 0, toolCallLog: [] };
          }
        }

        if (!loopResult) {
          if (await (async () => {
            // ── Tier 2: 无模型保底层 ─────────────────────────────────
            if (useDeterministicQuickTask) return false;
            try {
              const localBrain = require('../services/localBrainService');
              if (!localBrain.isModelAvailable()) {
                spinner.stop();
                // 首次模型不可用时输出一次性诊断公告
                if (typeof localBrain._checkModelFailureAnnouncement === 'function') {
                  const announcement = localBrain._checkModelFailureAnnouncement();
                  if (announcement) {
                    const c = require('chalk');
                    announcement.split('\n').forEach(l => console.log(c.yellow(`  ${l}`)));
                    console.log('');
                  }
                }
                const fallback = await localBrain.tryFallback(finalAiInput, { cwd: process.cwd() });
                if (fallback && fallback.handled) {
                  renderer.printStepLine('success', 'KHY 本地', fallback.category || '', '');
                  // 本地问候/帮助类回退是纯文本,直接逐行打印,绝不再经 renderer.renderAiResponse
                  // (AI markdown 渲染)—— 否则会与本地回退的直接呈现叠加成「渲染两次」。这正是
                  // repl.tasks.interaction 「renders the intro only once」回归测试所守护的行为:
                  // 快速任务路径走 renderAiResponse(断言 1 次),问候回退走直接路径(断言 0 次)。
                  const lines = String(fallback.response || '').split('\n');
                  lines.forEach(l => console.log(`  ${l}`));
                  console.log('');
                  responseAlreadyRendered = true;
                  loopResult = { finalResponse: fallback.response, provider: 'khy-local', tokenUsage: null, iterations: 0, toolCallLog: [] };
                  return true;
                }
                // 兜底菜单
                const c = require('chalk');
                const apiDesc = typeof localBrain.describeApis === 'function' ? localBrain.describeApis() : localBrain.listCapabilities().join('\n');
                console.log(c.yellow('\n  当前未配置 AI 模型。KHY 仍可为您提供以下本地服务：\n'));
                apiDesc.split('\n').forEach(l => console.log(c.dim(`  ${l}`)));
                console.log(c.dim('\n  运行 khy gateway config 配置 AI 模型，解锁完整能力。\n'));
                // API Key 失效→无模型也主动邀请更新(KHY_KEY_UPDATE_FLOW)。用户随后直接粘一把
                // 裸 key,由 localBrainService 的 key_update 确定性 handler 就地写入(全程无需模型)。
                let _keyInvite = '';
                try {
                  _keyInvite = require('../services/keyUpdateFlow').buildKeyUpdateInvite({}, process.env);
                  if (_keyInvite) console.log(c.yellow(`  ${_keyInvite}\n`));
                } catch { /* invite optional */ }
                try {
                  const hint = require('../services/gateway/gatewayGuide').guideHintLine();
                  if (hint) console.log(c.dim(`  ${hint}\n`));
                } catch { /* hint optional */ }
                // 兜底菜单**就是**本轮回复:它已直接打印(上面的 console.log),故必须
                // 与「问候回退」分支一样标记 responseAlreadyRendered=true,并把菜单纯文本
                // 记入 finalResponse。否则空 finalResponse 会触发下游 zero-silent-failure
                // 闸门(empty_reply),在诚实菜单之后再叠加一个自相矛盾的「模型请求失败」面板
                // —— 这恰恰破坏了「无模型也能诚实降级」的 Tier A 契约。
                const _menuPlain = `当前未配置 AI 模型。KHY 仍可为您提供以下本地服务：\n${apiDesc}\n运行 khy gateway config 配置 AI 模型，解锁完整能力。${_keyInvite ? `\n${_keyInvite}` : ''}`;
                responseAlreadyRendered = true;
                loopResult = { finalResponse: _menuPlain, provider: 'khy-local-fallback', tokenUsage: null, iterations: 0, toolCallLog: [] };
                return true;
              }
            } catch { /* localBrain not available, proceed to AI */ }
            return false;
          })()) {
            // Tier 2 handled — loopResult already set above
          } else if (_cooperativeFallbackText) {
            // ── Cooperative 超时保护：模型 15s 无响应 → 回退本地结果 ──
            const _COOPERATIVE_TIMEOUT_MS = parseInt(String(process.env.KHY_COOPERATIVE_TIMEOUT_MS || '15000'), 10) || 15000;
            let _coopTimedOut = false;
            const _coopModelPromise = (async () => {
              if (toolUseLoop.isEnabled()) {
                const _coopChatFn = chatFn;
                const r = await _coopChatFn(finalAiInput, _inlineImageOpts || {});
                return {
                  finalResponse: r.reply,
                  provider: r.provider,
                  tokenUsage: r.tokenUsage,
                  errorType: r.errorType || null,
                  iterations: 1,
                  toolCallLog: [],
                };
              } else {
                const r = await chatFn(finalAiInput, _inlineImageOpts || {});
                return {
                  finalResponse: r.reply,
                  provider: r.provider,
                  tokenUsage: r.tokenUsage,
                  errorType: r.errorType || null,
                  iterations: 1,
                  toolCallLog: [],
                };
              }
            })();
            const _coopTimeoutPromise = new Promise((resolve) => {
              setTimeout(() => {
                _coopTimedOut = true;
                resolve(null);
              }, _COOPERATIVE_TIMEOUT_MS);
            });
            const _coopResult = await Promise.race([_coopModelPromise, _coopTimeoutPromise]);
            if (_coopTimedOut || !_coopResult) {
              // 模型超时，回退到本地结果直接展示
              spinner.stop();
              renderer.printStepLine('active', '等待超时', '', `本地已获取数据，等待 AI 增强超时（${Math.round(_COOPERATIVE_TIMEOUT_MS / 1000)}s），使用本地结果`);
              renderer.renderAiResponse(_cooperativeFallbackText).split('\n').forEach((line) => console.log(`  ${line}`));
              console.log('');
              responseAlreadyRendered = true;
              loopResult = {
                finalResponse: _cooperativeFallbackText,
                provider: 'khy-cooperative-fallback',
                tokenUsage: null,
                errorType: null,
                iterations: 1,
                toolCallLog: [],
              };
            } else {
              spinner.stop();
              loopResult = _coopResult;
            }
          } else if (toolUseLoop.isEnabled()) {
          // Claude Code-style read/search collapse tracking (READ_SEARCH_TOOLS
          // is a module constant — see top of file).
          let _collapseGroup = { count: 0, searches: 0, reads: 0, files: new Set(), patterns: [] };
          const _flushCollapseGroup = () => {
            if (_collapseGroup.count <= 1) return; // Don't collapse single operations
            const parts = [];
            if (_collapseGroup.searches > 0) parts.push(`搜索 ${_collapseGroup.searches} 次`);
            if (_collapseGroup.reads > 0) parts.push(`读取 ${_collapseGroup.reads} 个文件`);
            if (parts.length > 0) {
              const summary = parts.join('，');
              renderer.printStepLine('success', 'Explored', '', `${summary} (ctrl+o 展开)`);
              const patternPreview = _collapseGroup.patterns
                .map(p => String(p || '').trim())
                .filter(Boolean)
                .slice(0, 3);
              if (patternPreview.length > 0) {
                renderer.printStepDetail(`Patterns: ${patternPreview.join(' | ')}`);
              }
              const filePreview = [..._collapseGroup.files]
                .map(f => String(f || '').trim())
                .filter(Boolean)
                .slice(0, 4);
              if (filePreview.length > 0) {
                renderer.printStepDetail(`Read: ${filePreview.join(', ')}`);
              }
            }
            _collapseGroup = { count: 0, searches: 0, reads: 0, files: new Set(), patterns: [] };
          };

          // Agent tree-view controller: tracks sub-agent progress for real-time tree display
          try {
            // Lazy-load to avoid circular dependency issues at startup
            var AgentTreeController = require('./agentTreeController').AgentTreeController;
          } catch { /* agentTreeController not available */ }

          const loopMaxIterations = (() => {
            const base = parseInt(String(process.env.KHY_TOOL_LOOP_MAX_ITERATIONS || '12'), 10) || 12;
            const lengthBoost = String(finalAiInput || '').length >= 700 ? 6 : 0;
            let intentBoost = 0;
            try {
              const { detectModes, getLoopLimitBoost } = require('../services/intentGate');
              const detected = detectModes(finalAiInput);
              intentBoost = getLoopLimitBoost(detected.modes).outerBoost;
            } catch { /* intentGate not available */ }
            const maxCap = parseInt(String(process.env.KHY_INTENT_LOOP_MAX_CAP || '60'), 10) || 60;
            return Math.max(8, Math.min(maxCap, base + lengthBoost + intentBoost));
          })();
          // ESC → 取消在途工具:仅当门控 KHY_TOOL_ABORT_SIGNAL 开时,为本轮 loop 建一个 abort
          // controller 并交给 loop;_requestRelayCancel(ESC/输入中断)会 abort 它。关 → 不建、
          // 不传 abortSignal,逐字节回退今日行为。每轮覆盖,末尾清空(见 loop 之后)。
          let _toolAbortWiring = true;
          try { _toolAbortWiring = require('../services/flagRegistry').isFlagEnabled('KHY_TOOL_ABORT_SIGNAL', process.env); }
          catch { _toolAbortWiring = true; }
          _activeToolLoopAbort = _toolAbortWiring ? new AbortController() : null;
          const loopOptions = {
            chat: chatFn,
            chatOpts: _inlineImageOpts || {},
            maxIterations: loopMaxIterations,
            ...(_activeToolLoopAbort ? { abortSignal: _activeToolLoopAbort.signal } : {}),
            // 自维护顾问人面(§2 工具路径):AI 面已由 loop 注入 currentMessage,这里把给人看
            // 的一行直接打印(本轮进行中,输入框已离开,console.log 安全)。best-effort。
            onSelfEditAdvisory: (adv) => {
              try { if (adv && adv.humanLine) console.log('\n' + adv.humanLine); } catch { /* best-effort */ }
            },
            // Cross-turn repeat guard: feed recent successful signatures so a call
            // already answered in a prior turn is steered, not silently re-run.
            recentToolSignatures: {
              exact: _recentToolSigs.map((e) => e.sig).filter(Boolean),
              intents: _recentToolSigs.map((e) => e.intentKey).filter(Boolean),
            },
            // Interactive AskUserQuestion channel: the loop surfaces structured
            // question results through this, reusing the same renderer/answer
            // packing as the gateway control_request path.
            onControlRequest: handleControlRequest,
            getSteerMessages: () => {
              const merged = [];
              const featurePayload = _buildFeatureCapabilitySteerMessage();
              if (featurePayload && featurePayload !== _lastFeatureMapSteerPayload) {
                merged.push(featurePayload);
                _lastFeatureMapSteerPayload = featurePayload;
              }
              const mindPayload = _buildTaskMindMapSteerMessage();
              if (mindPayload && mindPayload !== _lastMindMapSteerPayload) {
                merged.push(mindPayload);
                _lastMindMapSteerPayload = mindPayload;
              }
              if (_steerQueue.length > 0) {
                merged.push(..._steerQueue.splice(0));
              }
              return merged;
            },
            // /s! 紧急 steer 抢占信号（pull-clear）：工具循环在 cancel 后查询本回调，
            // 返回 true 表示本次 cancel 是用户抢占，应注入修正并原地重发而非整体 bail。
            consumeUrgentSteer: () => {
              const v = _urgentSteerPending;
              _urgentSteerPending = false;
              return v;
            },
            onCapabilityCheck: (assessment = {}) => {
              if (_isSmallTask) return; // small 任务不显示能力评估
              const reasons = Array.isArray(assessment.reasons) ? assessment.reasons : [];
              const warnings = Array.isArray(assessment.warnings) ? assessment.warnings : [];
              if (assessment.canProceed === false) {
                renderer.printStepLine('error', '能力评估', '受限', reasons[0] || '任务超出当前可执行能力');
                return;
              }
              // Suppress routine "passed" checks in brief/normal mode
              if (_currentStatusVerbosity !== 'detailed') return;
              if (warnings.length > 0) {
                renderer.printStepLine('active', '能力评估', '有风险', warnings[0]);
              } else {
                renderer.printStepLine('success', '能力评估', '通过', '确认当前模型和工具足以完成任务');
              }
            },
            onDecision: (decision = {}) => {
              // 流式输出已结束，重置 streaming 标志让忙碌输入框恢复可见
              _busyStreaming = false; _flushDeferredStatuses();
              if (_isSmallTask) return; // small 任务不显示 AI 决策过程
              const preview = String(decision.preview || '').trim();
              const tools = Array.isArray(decision.tools) ? decision.tools : [];
              const mode = String(decision.mode || '');
              const round = `第${decision.iteration || 1}轮`;
              if (mode === 'tool') {
                renderer.printStepLine('active', 'AI 决策', round, preview || '分析你的需求后，决定调用工具');
                if (tools.length > 0) {
                  const list = tools.slice(0, 5).join(' → ');
                  const suffix = tools.length > 5 ? ` +${tools.length - 5}` : '';
                  renderer.printStepDetail(`计划工具: ${list}${suffix}`);
                }
              }
              // mode='final' (无工具决策) 不输出步骤行 — 模型已直接回答，无需再说"无需工具"
              if (_taskMindMap) {
                _taskMindMap.markDecision(decision);
              }
            },
            onPlanReady: (plan) => {
              // 主动说明：把模型解析出的 <execution_plan>（默认会被剥除、用户看不到）
              // 作为一段「这件事打算怎么做」的前置说明渲染出来，让复杂任务开场先讲清
              // 整体步骤而不是闷头连环调用工具。单一真源（toolPrefaceVoice），best-effort。
              try {
                const e = process.env;
                if (String(e.KHY_TOOL_PREFACE || '').trim() === '0') return;
                if (String(e.KHY_PLAN_ANNOUNCE || '').trim() === '0') return;
                const voice = require('../toolPrefaceVoice');
                const text = typeof voice.composePlanAnnouncement === 'function'
                  ? voice.composePlanAnnouncement(plan) : '';
                if (text) _renderTextBlock(text);
              } catch { /* proactive plan narration is best-effort; never break the loop */ }
            },
            onKeyFinding: (finding) => {
              // 关键节点主动汇报：把 loop 发来的 finding（测试结果 / 根因 / 突破 /
              // 受阻）渲成一段可见说明。单一真源 cli/keyFindings.js，best-effort。
              try {
                if (!finding) return;
                const kf = require('../keyFindings');
                const text = finding.kind === 'test'
                  ? kf.composeFindingReport(finding)
                  : kf.composeModelFinding(finding);
                if (text) _renderTextBlock(text);
              } catch { /* proactive finding narration is best-effort; never break the loop */ }
            },
            onIterationSummary: (summary = {}) => {
              if (_isSmallTask) return; // small 任务不显示轮次小结
              const total = Number(summary.total || 0);
              if (total <= 0) return;
              // ── Rich iteration summary with breakdown ──
              const b = summary.breakdown || {};
              const parts = [];
              if (b.reads > 0) parts.push(`读取 ${b.reads} 个文件`);
              if (b.searches > 0) parts.push(`搜索 ${b.searches} 次`);
              if (b.writes > 0) parts.push(`修改 ${b.writes} 个文件`);
              if (b.commands > 0) parts.push(`执行 ${b.commands} 条命令`);
              if (b.agents > 0) parts.push(`${b.agents} 个子任务`);
              const failed = Number(summary.failed || 0);
              if (failed > 0) parts.push(`${failed} 失败`);
              const elapsed = summary.elapsedMs > 0 ? `  ${require('./ccFormat').ccFormatDurationOr(summary.elapsedMs, `${(summary.elapsedMs / 1000).toFixed(1)}s`, process.env)}` : '';
              const details = parts.length > 0 ? parts.join(' · ') : `${total} 次调用`;
              // 每轮推进判决(roundAdvanceAssessor):门开且有判决时,在小结行尾附紧凑标签(推进/停滞/空转)——
              // 衡量该轮的必要性与价值;门关时 summary.advance 缺失,此段无副作用(逐字节回退到无标签小结)。
              const _adv = summary.advance;
              const advTag = (_adv && _adv.label) ? `  [${_adv.label}]` : '';
              renderer.printStepLine(failed > 0 ? 'active' : 'success',
                `第 ${summary.iteration || 1} 轮小结`, '', `${details}${elapsed}${advTag}`);
              // Show modified file names if small count
              if (summary.modifiedFiles && summary.modifiedFiles.length > 0 && summary.modifiedFiles.length <= 5) {
                const basenames = summary.modifiedFiles.map(f => require('path').basename(f));
                renderer.printStepDetail(`修改：${basenames.join(', ')}`);
              }
              if (_taskMindMap) {
                _taskMindMap.markIterationSummary(summary);
              }
            },
            onIteration: (iteration) => {
              loopIterations = iteration;
              // 进入新一轮迭代 = 回合边界，无工具在飞；steer 将于此刻被读取注入。
              _inFlightStep = null;
              // Flush collapse group between iterations (AI is about to make new decisions)
              if (iteration > 1) _flushCollapseGroup();
            },
            onToolCall: (toolName, params) => {
              // Flush any remaining text from the previous iteration's streaming
              // before switching to tool display — prevents text truncation when
              // auto-injected tools (web search etc.) interrupt the model's output.
              if (streamState._chunker) {
                streamState._chunker.flushAll();
                streamState._textBuffer = '';
              } else {
                const remaining = (streamState._textBuffer || '').trim();
                streamState._textBuffer = '';
                if (remaining) _renderTextBlock(remaining);
              }
              if (streamState._streamingMd) streamState._streamingMd.flush();

              // 流式输出已结束，进入工具执行 — 重置 streaming 让忙碌输入框可见
              _busyStreaming = false; _flushDeferredStatuses();
              // 工具起飞：记录在飞步骤，供 steer 落地时机描述使用。
              _inFlightStep = { name: String(toolName || '工具'), startedAt: Date.now() };
              _currentOp = 'Tool use';
              _loopToolCount++;
              spinner.stop();
              updateTitlePhase('tool', mapToolToPhaseLabel(toolName));
              // Restart spinner with tool-specific phase so user sees "联网搜索中" etc.
              const toolDetail = String(toolName).toLowerCase().replace(/[\s_-]/g, '');
              spinner.start('tool');
              spinner.setPhase('tool', toolDetail);

              const activity = _toolProgressStart(toolName, params || {});
              if (activity) {
                renderer.printStepLine('active', activity.label, activity.target || '');
                // 连续同类工具抑制(修刷屏):上一条已发出 preface 的工具与本工具同类 → 静默,
                // 一串同类工具只在首个开口。叶子不可用 / 门控关 → suppress 返 false 逐字节回退。
                let _suppressPreface = false;
                try {
                  const _voiceMod = require('../toolPrefaceVoice');
                  if (_voiceMod && typeof _voiceMod.suppressConsecutivePreface === 'function') {
                    _suppressPreface = _voiceMod.suppressConsecutivePreface(
                      toolName, _lastLoopPrefaceKey, process.env);
                  }
                } catch { /* 抑制判定出错绝不吞掉叙述 */ }
                if (!_suppressPreface) {
                  const reason = _toolProgressReason(toolName, params || {}, _nextLoopPrefaceOcc(toolName));
                  if (reason) {
                    renderer.printStepDetail(reason);
                    try { _lastLoopPrefaceKey = String(toolName || '').toLowerCase().replace(/[\s_-]/g, ''); }
                    catch { /* cosmetic tracker — never disturb the loop */ }
                  }
                }
              }
              if (_taskMindMap) {
                _taskMindMap.markToolCall(toolName, params || {});
                if (_taskMindMapAutoShow) {
                  _printTaskMindMapCompact('Mind map · tool call');
                }
              }
              _featureCapabilityMap.markToolCall(toolName, params || {});
              if (_taskMindMapAutoShow) {
                _printFeatureCapabilityCompact('Feature map · tool call');
              }

              const normalizedName = String(toolName).toLowerCase().replace(/[\s_-]/g, '');
              const isReadSearch = READ_SEARCH_TOOLS.has(toolName) || READ_SEARCH_TOOLS.has(normalizedName);

              if (isReadSearch) {
                // Track in collapse group
                _collapseGroup.count++;
                if (/grep|search|glob|find|explore/i.test(toolName)) {
                  _collapseGroup.searches++;
                  if (params?.pattern) _collapseGroup.patterns.push(params.pattern);
                } else {
                  _collapseGroup.reads++;
                  const filePath = params?.path || params?.file_path || params?.filePath || '';
                  if (filePath) _collapseGroup.files.add(filePath);
                }
                // After 2 consecutive read/search ops, suppress individual lines
                // and show a collapsing counter instead
                if (_collapseGroup.count > 2) {
                  const summary = [];
                  if (_collapseGroup.searches > 0) summary.push(`搜索 ${_collapseGroup.searches} 次`);
                  if (_collapseGroup.reads > 0) summary.push(`读取 ${_collapseGroup.reads} 个文件`);
                  renderer.printCollapseCounter(summary.join('，'));
                  return; // skip printToolCallStart for this tool
                }
              } else {
                // Non-read-search tool: flush any pending collapse group
                _flushCollapseGroup();
              }

              // Claude Code: ⏺ ToolName(params) — one clean line per tool
              renderer.printToolCallStart(toolName, params);

              // Agent tools get special treatment: register in tree controller for live tracking
              const normName = String(toolName).toLowerCase().replace(/[\s_-]/g, '');
              if (normName === 'agent' || normName === 'spawnworker' || normName === 'subagent') {
                if (AgentTreeController && !agentTreeCtrl) {
                  agentTreeCtrl = new AgentTreeController();
                  agentTreeCtrl.start();
                }
                if (agentTreeCtrl) {
                  const agentId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
                  const agentName = `${params?.subagent_type || params?.role || 'general'}: ${(params?.prompt || '').slice(0, 40)}`;
                  const progressCb = agentTreeCtrl.register(agentId, agentName, params?.subagent_type || 'general');
                  return { onAgentProgress: progressCb, _agentTreeId: agentId };
                }
                // Fallback: static header if tree controller unavailable
                const role = params?.role || 'general';
                const prompt = (params?.prompt || '').slice(0, 50);
                renderer.renderAgentHeader(1, `${role}: ${prompt}...`);
              }
            },
            onParallelBatch: (calls) => {
              // Register parallel agents in tree controller for live tracking
              const agentCalls = calls.filter(c =>
                /^(agent|spawn_worker|sub_agent)$/i.test(String(c.name).replace(/[\s_-]/g, ''))
              );
              if (agentCalls.length >= 1) {
                if (AgentTreeController && !agentTreeCtrl) {
                  agentTreeCtrl = new AgentTreeController();
                  agentTreeCtrl.start();
                }
                if (agentTreeCtrl) {
                  for (const call of agentCalls) {
                    const agentId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
                    const agentName = `${call.params?.subagent_type || call.params?.role || 'general'}: ${(call.params?.prompt || '').slice(0, 40)}`;
                    const progressCb = agentTreeCtrl.register(agentId, agentName, call.params?.subagent_type);
                    call._traceContext = { ...(call._traceContext || {}), onAgentProgress: progressCb, _agentTreeId: agentId };
                  }
                } else {
                  // Fallback: static display
                  if (agentCalls.length >= 2) {
                    renderer.renderAgentHeader(agentCalls.length, '(ctrl+o to expand)');
                    const agentInfos = agentCalls.map(c => ({
                      name: `${c.params?.role || 'general'} agent`,
                      status: 'running',
                      detail: (c.params?.prompt || '').slice(0, 60),
                    }));
                    renderer.renderAgentProgress(agentInfos);
                  }
                }
              }
            },
            onToolResult: (toolName, params, result, _iteration, elapsedMs) => {
              // 工具落地：清空在飞步骤（即将进入回合边界，steer 随后被读取）。
              _inFlightStep = null;
              // Claude Code: overwrite tool start line with success/error dot + ⎿ result
              const status = (result && result.success) ? 'success' : 'error';
              let detail = '';
              if (result && result.denied) {
                detail = '权限被拒绝';
              } else if (result && result.success) {
                detail = _formatToolResult(toolName, result, params);
              } else if (result && result._displayHint != null) {
                // Guard-injected steer (cross-turn repeat / loop) carries a clean,
                // user-facing summary here; the raw `error` holds the model-only
                // [SYSTEM:…] nudge and must never reach the visible ✗ line.
                detail = String(result._displayHint).slice(0, 120);
              } else {
                const err = result && result.error;
                detail = (err && typeof err === 'object')
                  ? (err.message || JSON.stringify(err))
                  : (err || 'failed');
                // Defensive: strip any leaked internal control text before display.
                detail = _stripInternalControlText(String(detail)).slice(0, 120);
              }
              renderer.printToolCallResult(toolName, params, status, detail, elapsedMs || 0);
              const activityDone = _toolProgressDone(toolName, status === 'success', detail);
              if (activityDone) {
                renderer.printStepLine(activityDone.status, activityDone.label, '', activityDone.detail || '');
              }
              const reflection = _toolResultReflection(toolName, status === 'success', detail);
              if (reflection) renderer.printStepDetail(reflection);
              if (_taskMindMap) {
                _taskMindMap.markToolResult(toolName, status === 'success', detail);
                if (_taskMindMapAutoShow) {
                  _printTaskMindMapCompact('Mind map · tool result');
                }
              }
              _featureCapabilityMap.markToolResult(toolName, status === 'success', detail);
              if (_taskMindMapAutoShow) {
                _printFeatureCapabilityCompact('Feature map · tool result');
              }
              maybeRenderWriteDiff(toolName, params, result, c);
              maybeRenderInlineDiffFromToolOutput(toolName, result, c);
              // Cross-turn repeat guard feed: harvest this call's signature iff it
              // succeeded. Bounded to 8 so long sessions can't accumulate false
              // positives. Fail-soft — a harvest error never disturbs rendering.
              try {
                if (status === 'success' && !(result && result.denied)) {
                  const sigFor = require('../services/toolUseLoop')._signatureForCall;
                  const { sig, intentKey } = sigFor(toolName, params || {}, null);
                  if (sig || intentKey) {
                    _recentToolSigs.push({ sig, intentKey });
                    if (_recentToolSigs.length > 8) _recentToolSigs.shift();
                  }
                }
              } catch { /* signature harvest is best-effort */ }
            },
          };

          const harnessEnabled = (() => {
            const raw = String(process.env.KHY_REPL_HARNESS || 'true').trim().toLowerCase();
            return !['0', 'false', 'off', 'no', 'n'].includes(raw);
          })();
          const harnessRetryAttempts = Math.max(1, parseInt(String(process.env.KHY_HARNESS_RETRY_ATTEMPTS || '2'), 10) || 2);
          const harnessRetryMinDelayMs = Math.max(100, parseInt(String(process.env.KHY_HARNESS_RETRY_MIN_DELAY_MS || '700'), 10) || 700);
          const harnessRetryMaxDelayMs = Math.max(
            harnessRetryMinDelayMs,
            parseInt(String(process.env.KHY_HARNESS_RETRY_MAX_DELAY_MS || '5000'), 10) || 5000
          );
          const harnessMaxContinuationRounds = Math.max(0, parseInt(String(process.env.KHY_HARNESS_MAX_CONTINUATION_ROUNDS || '3'), 10) || 3);

          if (harnessEnabled) {
            try {
              const { createAgenticHarness } = require('../services/agenticHarnessService');
              const harness = createAgenticHarness();
              loopResult = await harness.run({
                userMessage: finalAiInput,
                chat: chatFn,
                chatOpts: _inlineImageOpts || {},
                loopOptions,
                recentFiles: [],
                taskLabel: 'repl-tool-loop',
                retryAttempts: harnessRetryAttempts,
                retryMinDelayMs: harnessRetryMinDelayMs,
                retryMaxDelayMs: harnessRetryMaxDelayMs,
                maxContinuationRounds: harnessMaxContinuationRounds,
                onEvent: (event) => {
                  if (!event) return;
                  if (event.type === 'retry') {
                    const attempt = Number(event.attempt || 0);
                    const maxAttempts = Number(event.maxAttempts || 0);
                    const waitSec = Math.max(0, Number(event.delayMs || 0) / 1000);
                    renderer.printStepLine('active', '自动恢复', `${attempt}/${maxAttempts}`, `第${attempt}次请求失败，等待 ${waitSec.toFixed(1)}s 后重试`);
                  } else if (event.type === 'continuation') {
                    renderer.printStepLine('active', '自动续跑', `${event.round}/${event.maxRounds}`, 'AI 达到单轮上限，自动开启下一轮继续');
                  } else if (
                    (event.type === 'bugfix_regression_gate' || event.type === 'change_regression_gate')
                    && event.phase === 'baseline_completed'
                  ) {
                    const target = Array.isArray(event.requiredSteps) && event.requiredSteps.length > 0
                      ? event.requiredSteps.join('+')
                      : 'auto';
                    renderer.printStepLine('active', '变更验证', '采集基线', `记录修改前的测试状态作为基准（步骤: ${target}）`);
                  } else if (
                    (event.type === 'bugfix_regression_gate' || event.type === 'change_regression_gate')
                    && event.phase === 'final_evaluation'
                  ) {
                    // 存储结果，稍后折叠到完成面板 summary 中，不直接打印步骤行
                    const detail = String(event.summary || '').replace(/\s+/g, ' ').trim().slice(0, 140);
                    _regressionGateResult = {
                      passed: !!event.passed,
                      detail: detail || (event.passed ? '修改前后对比通过，未引入新问题' : '发现修改引入了新的失败'),
                    };
                  } else if (
                    event.type === 'bugfix_regression_gate_error' || event.type === 'change_regression_gate_error'
                  ) {
                    const detail = String(event.error || '未知错误').replace(/\s+/g, ' ').trim().slice(0, 140);
                    _regressionGateResult = {
                      passed: false,
                      detail: detail || '验证过程异常',
                      error: true,
                    };
                  }
                },
              });
            } catch (harnessErr) {
              renderer.printStepLine('error', '执行引擎', '降级', `高级执行框架出错，切换到基础模式继续: ${String(harnessErr?.message || '未知错误')}`);
              loopResult = await toolUseLoop.runToolUseLoop(finalAiInput, loopOptions);
            }
          } else {
            loopResult = await toolUseLoop.runToolUseLoop(finalAiInput, loopOptions);
          }
          // Flush any remaining collapse group
          _flushCollapseGroup();
          } else {
            const r = await chatFn(finalAiInput, _inlineImageOpts || {});
            loopResult = {
              finalResponse: r.reply,
              provider: r.provider,
              tokenUsage: r.tokenUsage,
              errorType: r.errorType || null,
              iterations: 1,
              toolCallLog: [],
            };
          }
        }

        aiResult = {
          reply: loopResult.finalResponse || '',
          terminalNotice: loopResult.terminalNotice || '',
          provider: loopResult.provider,
          tokenUsage: loopResult.tokenUsage,
          toolSummary: loopResult.toolSummary || undefined,
          errorType: loopResult.errorType || null,
          elapsed: 0,
        };

        if (loopIterations > 0) {
          const log = (loopResult.toolCallLog || []).filter(t => t.tool !== '_legacy_cmd');
          const toolCount = log.length;
          if (toolCount > 0) {
            const searches = log.filter(t => /grep|glob|search|find/i.test(t.tool)).length;
            const reads = log.filter(t => /read/i.test(t.tool)).length;
            const bashes = log.filter(t => /bash|shell|command/i.test(t.tool)).length;
            const webSearches = log.filter(t => /websearch|webfetch/i.test(t.tool)).length;
            const succeeded = log.filter((t) => {
              if (typeof t?.result?.success === 'boolean') return t.result.success;
              if (typeof t?.success === 'boolean') return t.success;
              return false;
            }).length;
            const failed = toolCount - succeeded;
            const totalElapsed = log.reduce((sum, t) => sum + (t.elapsed || 0), 0);
            const elapsedStr = totalElapsed > 1000
              ? require('./ccFormat').ccFormatDurationOr(totalElapsed, `${(totalElapsed / 1000).toFixed(1)}s`, process.env)
              : `${totalElapsed}ms`;

            // ── Build structured file changes ──
            const fileChanges = [];
            const seenPaths = new Map();
            for (const t of log) {
              const tool = String(t.tool || '').toLowerCase().replace(/[\s_-]/g, '');
              const fp = t.params?.file_path || t.params?.filePath || t.params?.path || '';
              if (!fp) continue;
              if (/^(write|writefile|createfile)$/.test(tool)) {
                if (!seenPaths.has(fp)) {
                  const diff = t.result?._khyWriteDiff;
                  const isNew = diff && !diff.beforeContent;
                  const lines = diff?.afterContent ? diff.afterContent.split('\n').length : 0;
                  seenPaths.set(fp, true);
                  fileChanges.push({ path: fp, operation: isNew ? 'create' : 'modify', diff: lines > 0 ? `${lines} 行` : '' });
                }
              } else if (/^(edit|editfile|fileedit)$/.test(tool)) {
                const oldLen = (t.params?.old_string || t.params?.oldString || '').split('\n').length;
                const newLen = (t.params?.new_string || t.params?.newString || '').split('\n').length;
                const added = Math.max(0, newLen - oldLen);
                const removed = Math.max(0, oldLen - newLen);
                const existing = seenPaths.get(fp);
                if (existing && typeof existing === 'object') {
                  existing.added = (existing.added || 0) + added;
                  existing.removed = (existing.removed || 0) + removed;
                } else if (!seenPaths.has(fp)) {
                  const entry = { path: fp, operation: 'modify', diff: `+${added}/-${removed}`, added, removed };
                  seenPaths.set(fp, entry);
                  fileChanges.push(entry);
                }
              }
            }
            // Rebuild diff strings for aggregated edits
            for (const fc of fileChanges) {
              if (fc.added !== undefined) fc.diff = `+${fc.added}/-${fc.removed}`;
            }

            // Merge upstream file operations (e.g. Codex CLI internal file writes)
            const upstreamFileOps = aiResult?.toolSummary?.fileOps;
            if (Array.isArray(upstreamFileOps)) {
              for (const op of upstreamFileOps) {
                const operation = String(op?.operation || 'create');
                const fp = op?.path || op?.toPath || op?.fromPath || '';
                const fromPath = op?.fromPath || '';
                const toPath = op?.toPath || '';
                if (!fp) continue;
                const exists = fileChanges.some((entry) =>
                  entry.operation === operation
                  && String(entry.path || '') === fp
                  && String(entry.fromPath || '') === fromPath
                  && String(entry.toPath || '') === toPath
                );
                if (exists) continue;
                if (operation === 'create' || operation === 'modify' || operation === 'scaffold') {
                  seenPaths.set(fp, true);
                }
                fileChanges.push({ path: fp, operation, fromPath, toPath, diff: '' });
              }
            }

            // ── Build commands list ──
            const commands = [];
            for (const t of log) {
              const tool = String(t.tool || '').toLowerCase().replace(/[\s_-]/g, '');
              if (/^(bash|shell|shellcommand)$/.test(tool)) {
                const cmd = String(t.params?.command || '').trim();
                if (cmd && !/^\s*(ls|dir|cat|head|tail|find|tree|pwd|whoami|echo)\b/i.test(cmd)) {
                  commands.push({ cmd: cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd, success: t.result?.success !== false });
                }
              }
            }

            // ── Build completion summary lines ──
            const _completionSummary = [];
            if (fileChanges.length > 0) {
              const creates = fileChanges.filter(f => f.operation === 'create' || f.operation === 'scaffold').length;
              const mods = fileChanges.filter(f => f.operation === 'modify').length;
              const renames = fileChanges.filter(f => f.operation === 'rename').length;
              const moves = fileChanges.filter(f => f.operation === 'move').length;
              const deletes = fileChanges.filter(f => f.operation === 'delete').length;
              const parts = [];
              if (mods > 0) parts.push(`修改了 ${mods} 个文件`);
              if (creates > 0) parts.push(`新建了 ${creates} 个文件`);
              if (renames > 0) parts.push(`重命名了 ${renames} 个文件`);
              if (moves > 0) parts.push(`移动了 ${moves} 个文件`);
              if (deletes > 0) parts.push(`删除了 ${deletes} 个文件`);
              if (parts.length > 0) _completionSummary.push(parts.join('，'));
            }
            if (commands.length > 0) {
              const allOk = commands.every(cmd => cmd.success !== false);
              _completionSummary.push(allOk ? '所有命令执行成功' : `${commands.filter(cmd => cmd.success === false).length} 条命令失败`);
            }
            // Decomposition report
            const _subtaskReport = (loopResult.decomposed && loopResult.subtaskResults)
              ? { total: loopResult.subtaskResults.length, succeeded: loopResult.successCount || 0, failed: loopResult.failCount || 0 }
              : null;

            // ── 将回归闸门结果折叠到完成面板 summary 中 ──
            if (_regressionGateResult) {
              const gateIcon = _regressionGateResult.passed ? '✓' : '✗';
              _completionSummary.push(`${gateIcon} 变更验证: ${_regressionGateResult.detail}`);
            }

            // ── Print structured completion panel ──
            // Mark as warning if: any tools failed, loop bailed out, or max iterations hit
            const _panelSuccess = failed === 0
              && !loopResult.consecutiveFailureBailout
              && !loopResult.maxIterationsReached;
            renderer.printCompletionPanel({
              success: _panelSuccess,
              iterations: loopIterations,
              totalCalls: toolCount,
              succeeded,
              elapsed: elapsedStr,
              fileChanges,
              commands: commands.slice(0, 5),
              searches: searches + webSearches,
              reads,
              summary: _completionSummary.length > 0 ? _completionSummary : undefined,
              subtaskReport: _subtaskReport,
            });
            _markDeliveryGapPending();
          }
        }

        if (loopResult.consecutiveFailureBailout) {
          console.log(c.hex('#FFC107')('  连续工具调用失败，已停止重试'));
          _markDeliveryGapPending();
        } else if (loopResult.timeLimitReached) {
          const limitMs = Number(loopResult.maxElapsedMs || 0);
          const totalSec = Math.max(1, Math.ceil(limitMs / 1000));
          const m = Math.floor(totalSec / 60);
          const s = totalSec % 60;
          const limitText = (m > 0 && s > 0) ? `${m}m ${s}s` : (m > 0 ? `${m}m` : `${s}s`);
          console.log(c.hex('#FFC107')(`  工具循环已 ${limitText} 无新进展，返回已收集结果`));
          _markDeliveryGapPending();
        } else if (loopResult.maxIterationsReached) {
          const contInfo = loopResult.continuationRounds > 0
            ? ` (含 ${loopResult.continuationRounds} 轮续跑)`
            : '';
          console.log(c.hex('#FFC107')(`  达到最大迭代次数 (${loopResult.iterations}${contInfo})，返回最后结果`));
          _markDeliveryGapPending();
        }
        if (_taskMindMap) {
          const completed = !(loopResult.consecutiveFailureBailout || loopResult.timeLimitReached);
          let reason = '';
          if (loopResult.consecutiveFailureBailout) reason = 'stopped after consecutive tool failures';
          else if (loopResult.timeLimitReached) reason = 'stopped after tool loop idle window';
          else if (loopResult.maxIterationsReached) reason = 'stopped by max iterations';
          // 更新内部状态但不输出 — 避免完成面板后的输出污染
          _taskMindMap.complete({ success: completed, reason });
          _featureCapabilityMap.markAiCompletion(completed, reason || 'tool loop done');
        }
        if (loopIterations > 1 && loopResult.finalResponse && streamState._streamedTextLen > 0) {
          responseAlreadyRendered = true;
        } else if (
          loopIterations > 1 && loopResult.finalResponse && _renderDedup
          && _renderDedup.finalAlreadyStreamed(loopResult.finalResponse, _turnStreamedText, process.env)
        ) {
          // 末轮以非流式方式重述了前轮已流式打印过的同一句结论。此处 streamState 已被该
          // 末轮重建清零(_streamedTextLen===0),故上一分支漏掉;用回合级累计文本判重复,
          // 抑制下方「无流式」分支的整段重渲,杜绝同句打印两遍。门控关 → 恒 false 逐字节回退。
          responseAlreadyRendered = true;
        }
      } // end if (!_useQueryEngine)

      // AI 请求完成，重置流式标志确保输入框可见
      _busyStreaming = false; _flushDeferredStatuses();

      // Close thinking block if it was still open
      if (streamState.phase === 'thinking') {
        closeThinkingStream(streamState);
        console.log('');
        streamState._deliveryGapPending = false;
      }

      // ── Render-boundary SafeResponse (zero-silent-failure) ────────────────
      // The render gate below prints nothing when aiResult.reply is empty. An
      // empty finalResponse after a tool run must NEVER reach the user as
      // silence ("为什么没有输出"). If nothing was streamed and the reply is
      // empty, degrade to the salvaged tool content (single source:
      // _salvageToolResults), else a precise E01 failsafe message.
      if (!aiResult.reply && !responseAlreadyRendered) {
        let _safe = '';
        try {
          const { _salvageToolResults } = require('../services/toolUseLoop');
          _safe = _salvageToolResults(loopResult && loopResult.toolCallLog) || '';
        } catch { /* salvage best-effort */ }
        if (!_safe) {
          try {
            const _fs = require('../services/failsafe');
            const _att = _fs.classify(
              { errorType: 'empty_reply', model: loopResult && loopResult.provider },
              { kind: 'llm' },
            );
            if (_att && _att.reason) {
              const _code = _att.error_code ? `[${_att.error_code}] ` : '';
              const _sugg = _att.suggestion ? `\n${_att.suggestion}` : '';
              _safe = `${_code}${_att.reason}${_sugg}`;
              aiResult.errorType = aiResult.errorType || 'empty_reply';
            } else {
              _safe = '抱歉，本轮未能生成有效回复（工具已执行但模型未产出文本）。请重试或换一个问法。';
            }
          } catch {
            _safe = '抱歉，本轮未能生成有效回复（工具已执行但模型未产出文本）。请重试或换一个问法。';
          }
        }
        aiResult.reply = _safe;
      }

      if (aiResult.reply && !responseAlreadyRendered) {
        if (aiResult.errorType) {
          // ── 模型失败 → 尝试本地降级（附失败原因）─────────────────
          let _localFallbackHandled = false;
          try {
            const _fallbackBrain = require('../services/localBrainService');
            const _fb = await _fallbackBrain.tryFallback(aiInput, { cwd: process.cwd() });
            if (_fb && _fb.handled) {
              _localFallbackHandled = true;
              const _c = require('chalk');
              // 提取失败原因（从 aiResult.reply 或 errorType）
              const _errReason = (() => {
                const raw = String(aiResult.reply || '').replace(/[\r\n]+/g, ' ').trim();
                // 从错误消息中提取关键原因
                const match = raw.match(/(?:失败原因|Reason|error)[:\s]*(.{10,120})/i);
                if (match) return match[1].trim();
                if (aiResult.errorType && aiResult.errorType !== 'unknown') return aiResult.errorType;
                return raw.slice(0, 120) || '模型请求失败';
              })();
              console.log(_c.yellow(`  ⚠ 模型降级: ${_errReason}`));
              console.log(_c.dim(`    → 已切换到本地模式处理`));
              renderer.printStepLine('active', '本地处理', _fb.category || '', '');
              const _fbLines = String(_fb.response || '').split('\n');
              _fbLines.forEach(l => console.log(`  ${l}`));
              console.log('');
              responseAlreadyRendered = true;
            }
          } catch { /* local fallback best-effort */ }

          if (!_localFallbackHandled) {
            // 本地也无法处理 → 展示结构化错误面板（含原因+针对性建议）
            const _errType = String(aiResult.errorType || 'unknown').toLowerCase();
            const _rawErr = String(aiResult.reply || '').trim();

            // 提取人类可读的失败原因
            const _humanReason = (() => {
              // 从错误消息中提取核心原因短语
              const patterns = [
                /tool_use.*ids.*without.*tool_result/i,
                /Bedrock error[:\s]+(.{10,150})/i,
                /失败原因[:\s]*(.{10,150})/,
                /Reason[:\s]*(.{10,150})/i,
                /Error[:\s]*(.{10,150})/i,
              ];
              for (const p of patterns) {
                const m = _rawErr.match(p);
                if (m) return (m[1] || m[0]).replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
              }
              if (_errType === 'timeout') return '请求超时 — 模型响应时间超过限制';
              if (_errType === 'network') return '网络连接失败 — 无法到达 AI 服务';
              if (_errType === 'auth' || _errType === 'forbidden') return '认证失败 — API 密钥无效或过期';
              if (_errType === 'rate_limit') return '请求频率超限 — 稍后重试';
              return _rawErr.replace(/[\r\n]+/g, ' ').slice(0, 150) || '模型请求失败（原因未知）';
            })();

            // 基于错误类型给出针对性建议
            const _suggestions = [];
            if (/tool_use.*tool_result|配对/i.test(_rawErr)) {
              _suggestions.push('消息历史中工具调用记录损坏，输入 /clear 清空上下文后重试');
            }
            if (_errType === 'timeout' || /timeout|超时/i.test(_rawErr)) {
              _suggestions.push('当前网络到 AI 服务延迟较高，检查代理设置或稍后重试');
            }
            if (_errType === 'auth' || /401|403|expired|认证/i.test(_rawErr)) {
              _suggestions.push('运行 khy gateway config 重新配置 API 认证信息');
            }
            if (_errType === 'rate_limit' || /429|rate.?limit|频率/i.test(_rawErr)) {
              _suggestions.push('等待 30 秒后重试，或切换到其他模型: khy gateway model');
            }
            if (_suggestions.length === 0) {
              _suggestions.push('输入 /clear 清空上下文后重试');
              _suggestions.push('运行 khy gateway status 查看各通道状态');
            }

            printErrorPanel({
              title: '模型请求失败',
              message: _humanReason,
              reason: `错误类型: ${_errType}`,
              suggestions: _suggestions,
            });
            console.log('');
          }
        } else {
          // Update terminal title with conversation topic
          updateTitleFromConversation(aiInput);

          // Update session tokens for prompt frame display
          if (aiResult.tokenUsage?.totalTokens) {
            _sessionTokens += aiResult.tokenUsage.totalTokens;
          }

          // Build meta info line (Claude Code style)
          const elapsedSec = aiResult.elapsed ? require('./ccFormat').ccFormatDurationOr(aiResult.elapsed, `${(aiResult.elapsed / 1000).toFixed(1)}s`, process.env) : '';
	          const tokenCount = aiResult.tokenUsage
	            ? `↑ ${aiResult.tokenUsage.totalTokens?.toLocaleString() || '?'} 令牌` : '';
	          const thinkTime = streamState.thinkingStarted ? '已显示推理' : '';
          const toolSummaryText = formatToolSummary(aiResult.toolSummary);
	          const metaParts = [elapsedSec, tokenCount, thinkTime].filter(Boolean);

          // Claude Code style: no "AI response" header — just render the response text directly

          // If text was already streamed incrementally to the terminal,
          // skip the final full render to avoid duplicate output.
          // Only re-render from aiResult.reply when no streaming happened
          // (e.g. adapter cascade or non-streaming response).
          if (streamState._streamedTextLen > 0) {
            // G1/G2: 使用 AdaptiveChunker flushAll 输出剩余内容
            if (streamState._chunker) {
              streamState._chunker.flushAll();
              streamState._textBuffer = '';
            } else {
              const remaining = (streamState._textBuffer || '').trim();
              streamState._textBuffer = '';
              if (remaining) {
                _renderTextBlock(remaining);
              }
            }
            // Flush streaming markdown state machine so any buffered block is committed
            if (streamState._streamingMd) {
              streamState._streamingMd.flush();
            }
            // 零静默失败（DESIGN-ARCH-028）：流式只输出了模型 token 散文，
            // 服务端在 finalText 末尾合成追加的「终端通知」（失败摘要/交付摘要/
            // 验证封顶）从未进入 token 流。此处补渲该尾巴，否则模型末轮为空且
            // 存在失败工具时，失败说明会被静默丢弃，违反「零静默失败」契约。
            const _notice = String(aiResult.terminalNotice || '').trim();
            if (_notice) {
              _flushDeliveryGap();
              const renderedNotice = renderer.renderAiResponse(_notice);
              renderedNotice.split('\n').forEach(l => console.log(`  ${l}`));
            }
          } else {
            streamState._textBuffer = '';
            if (aiResult.reply) {
              _flushDeliveryGap();
              const rendered = renderer.renderAiResponse(aiResult.reply);
              const lines = rendered.split('\n');
              lines.forEach(l => console.log(`  ${l}`));
            }
          }

          // Compacting notice — only when context is actually getting large (>80% of limit)
          try {
            const hud = require('./hudRenderer');
            const state = hud.getState();
            const usedPct = state.contextWindow.limit > 0
              ? (state.sessionTokens.total / state.contextWindow.limit) * 100
              : 0;
            if (usedPct > 80) {
              renderer.printCompactingNotice({
                tokens: state.sessionTokens.total?.toLocaleString() || '?',
              });
            }
          } catch { /* best effort */ }

          // Extract and display task plan if AI response contains numbered steps
          try {
            const planPattern = /执行计划|分析步骤|操作步骤|回测计划|分步|plan|steps|implementation/i;
            if (planPattern.test(aiResult.reply) || needsPlan) {
              const planTracker = new renderer.TaskPlanTracker();
              if (planTracker.extractFromResponse(aiResult.reply)) {
                planTracker.render();
              }
            }
          } catch { /* best effort */ }

          // Claude Code style: show random Tip after AI response (throttled)
          try {
            if (!_lastTipShown || (Date.now() - _lastTipShown > 120000)) {
              const tips = [
                '输入 /clear 切换话题时清空上下文',
                '按 Ctrl+C 中断当前 AI 请求',
                '↑/↓ 方向键浏览历史命令',
                '拖拽文件到终端可附带文件内容',
                '输入 /plan 让 AI 先规划再执行复杂任务',
                '输入 /btw 在 AI 工作时补充提示',
                '输入 /resume 恢复上次对话',
              ];
              const tip = tips[Math.floor(Math.random() * tips.length)];
              console.log('');
              console.log(c.dim(`    提示: ${tip}`));
              _lastTipShown = Date.now();
            }
          } catch { /* tips are best-effort */ }

          // Detect inline options in AI response (numbered lists ending with ?)
          // Pattern: AI asks a question with numbered options like "1. xxx\n2. xxx\n请选择"
          try {
            const optionPattern = /(?:^|\n)\s*(\d)\.\s+(.+)/g;
            const questionPattern = /请选择|你想|哪个|选哪|怎么做|如何选/;
            const hasQuestion = questionPattern.test(aiResult.reply);

            if (hasQuestion) {
              const matches = [...aiResult.reply.matchAll(optionPattern)];
              if (matches.length >= 2 && matches.length <= 6) {
                const options = matches.map(m => ({ label: m[2].trim() }));
                const selection = await renderer.askInlineQuestion(
                  'AI needs your choice:',
                  options,
                  { rl }
                );
                if (selection) {
                  const selLabel = Array.isArray(selection) ? selection.join(', ') : selection;
                  console.log(c.hex('#4EBA65')(`  ✓ ${selLabel}`));
                  // 自动续接：将选择作为下一轮用户输入触发 AI 继续执行
                  _queuedInputs.unshift(`我选择了: ${selLabel}，请根据我的选择继续执行`);
                }
              }
            }
          } catch (e) {
            // B4: AI 内联选择失败日志，便于诊断"选择无响应"问题
            try { console.error('[repl] AI 内联选择失败:', e?.message); } catch {}
          }
        }

        console.log('');
      } else if (!aiResult.reply && !responseAlreadyRendered) {
        // Truly empty reply — try local fallback before giving up
        let _emptyFallbackHandled = false;
        try {
          const _fallbackBrain2 = require('../services/localBrainService');
          const _fb2 = await _fallbackBrain2.tryFallback(aiInput, { cwd: process.cwd() });
          if (_fb2 && _fb2.handled) {
            _emptyFallbackHandled = true;
            const _c2 = require('chalk');
            const _emptyReason = aiResult.errorType && aiResult.errorType !== 'unknown'
              ? aiResult.errorType
              : '模型未返回结果（可能超时或连接中断）';
            console.log(_c2.yellow(`  ⚠ 模型降级: ${_emptyReason}`));
            console.log(_c2.dim(`    → 已切换到本地模式处理`));
            renderer.printStepLine('active', '本地处理', _fb2.category || '', '');
            String(_fb2.response || '').split('\n').forEach(l => console.log(`  ${l}`));
            console.log('');
          }
        } catch { /* best-effort */ }
        if (!_emptyFallbackHandled) {
          // 精准归因优先：不再吐模糊的"未返回有效回复"。若结果带了 errorType/续接
          // 提示就如实展示，并告知可说「继续」推进（单一真源 continuation 策略）。
          let _emptyLine = 'AI 未返回有效回复 — 请重试或检查连接';
          try {
            const _cont = require('../services/query/continuation');
            const _et = aiResult && aiResult.errorType;
            if (_et && _et !== 'unknown' && _et !== 'empty_reply') {
              _emptyLine = `AI 未返回内容（原因类型: ${_et}）`;
            }
            const _hint = (aiResult && aiResult.continueHint)
              || (_cont.isResumableError(_et) ? _cont.CONTINUE_HINT : null);
            if (_hint) _emptyLine += `\n${_hint}`;
          } catch { /* fail-soft: keep default line */ }
          printInfo(_emptyLine);
        }
        console.log('');
      }

      // Execute any embedded commands with Claude Code-style tool call display
      // Also handle <tool_call> tags via the new tool-use loop
      if (aiResult.commands && aiResult.commands.length > 0) {
        console.log('');
        const toolCallStats = { toolCalls: 0, startTime: Date.now() };
        for (const cmd of aiResult.commands) {
          const cmdParts = cmd.split(/\s+/);
          const cmdLabel = cmdParts[0] || cmd;
          const cmdTarget = cmdParts.slice(1).join(' ') || '';
          toolCallStats.toolCalls++;

          // Show Claude Code-style tool call start
          renderer.printToolCallStart(cmdLabel, cmdTarget || cmd);
          const cmdStart = Date.now();

          try {
            const cmdParsed = parseInput(cmd);
            if (cmdParsed) {
              // Capture output by temporarily redirecting console.log
              const origLog = console.log;
              const output = [];
              console.log = (...args) => {
                const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
                output.push(line);
              };
              try {
                await route(cmdParsed);
              } finally {
                console.log = origLog;
              }

              const cmdElapsed = Date.now() - cmdStart;

              // Show condensed result via tool call result display
              const condensed = output.filter(l => l.trim()).slice(0, 5);
              const cleanLines = condensed.map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 80));
              const detail = cleanLines.length > 0 ? cleanLines[0] : `${cmdLabel} completed`;
              const moreLines = output.filter(l => l.trim()).length;

              renderer.printToolCallResult(
                cmdLabel,
                cmdTarget || cmd,
                'success',
                moreLines > 1 ? `${detail} (+${moreLines - 1} more lines)` : detail,
                cmdElapsed
              );
            } else {
              renderer.printToolCallResult(cmdLabel, cmd, 'error', 'Cannot parse command', 0);
            }
          } catch (cmdErr) {
            renderer.printToolCallResult(
              cmdLabel, cmd, 'error',
              cmdErr.message || 'Execution failed',
              Date.now() - cmdStart
            );
          }
        }
        // Show completion summary
        renderer.renderAgentDone({
          toolCalls: toolCallStats.toolCalls,
          elapsedMs: Date.now() - toolCallStats.startTime,
        });
      }

    } catch (err) {
      // 刀106:经典 REPL 主消息路径的 abort 兜底,补记中断标记(承刀105 honest-deferred)。
      // ESC/Ctrl+C/`/interrupt` → 网关 createAbortError 抛出(name==='AbortError' /
      // code==='ABORT_ERR')并冒泡到此;chat() 已因异常跳过结尾的 assistant push
      // → 模型可见历史停在悬空 user 回合、无「被中断」标记(同 TUI 刀105前)。这里与
      // useQueryBridge 的 aborted 分支一致地记一条中断标记,使下一句「改用 X」进来时模型
      // 看得到上一轮是被用户打断的。门控 KHY_INTERRUPT_MARKER 由 ai.recordInterruption 内部
      // 保证(关→no-op→逐字节回退今日行为);部分回复文本在此 catch 作用域不可达(streamState
      // 是 try 内 let)→ 仅记标记(honest-boundary②:抓不到正文不假装有正文)。仅 abort 记,
      // 真错误(网络/上游)不误记「用户已中断」。fail-soft:任何异常都不影响既有错误呈现。
      try {
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
          ai().recordInterruption('');
        }
      } catch { /* best effort:记录失败不影响下方错误呈现 */ }
      _featureCapabilityMap.markError(err);
      try { printError(err?.message || String(err) || '执行出错'); } catch { /* ignore */ }
    } finally {
      // Safety net: ensure spinner is always stopped at request boundary
      try { spinner.stop(); } catch { /* ignore */ }
      // 首响应静默窗口守护:请求边界兜底取消未决计时器(无论正常完成 / abort / 错误)。幂等。
      try { if (_firstResponseAckScheduler) _firstResponseAckScheduler.disarm(); } catch { /* ignore */ }
      // TUI bridge: record turn completion (best-effort)
      try { if (_tuiCtrl) _tuiCtrl.completeTurn({ turnCount: _turnCount }); } catch { /* */ }
      _busy = false;
      _busyStreaming = false; _flushDeferredStatuses();
      _transientStatusActive = false; // Reset transient guard
      _busyHintShownAt = 0; // 重置 hint，下次忙碌可再次显示
      _busyInterruptState = null; // 重置忙碌态中断逃生阀连按序列,不跨轮泄漏
      _busyInterjectRequested = false;
      _busyPromptSuppressedUntilInput = false;
      _busyPromptVisible = false;
      _currentOp = '';
      // Unsubscribe adapter status bridge
      if (_adapterStatusHandler) {
        process.removeListener('khy:adapter:status', _adapterStatusHandler);
        _adapterStatusHandler = null;
      }
      // Stop agent tree controller if active
      if (typeof agentTreeCtrl !== 'undefined' && agentTreeCtrl) {
        try { agentTreeCtrl.stop(); } catch { /* ignore */ }
        agentTreeCtrl = null;
      }
      // Cancel any pending busy prompt repaint and keepalive
      _stopBusyPromptKeepalive();
      if (_busyPromptRepaintPending) {
        clearTimeout(_busyPromptRepaintPending);
        _busyPromptRepaintPending = null;
      }
      updateTitlePhase('idle');
      try {
        const renderer = require('./aiRenderer');
        if (typeof renderer.setInteractiveGuard === 'function') renderer.setInteractiveGuard(null);
      } catch { /* non-critical */ }
      // Claude Code style: subtle dim separator after AI response ends
      if (process.stdout.isTTY && !process.stdout.isTTY) {
        try { console.log(c.dim('  ─')); } catch { /* non-critical */ }
      }
      // Ensure terminal is in a clean state after AI streaming
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[?25h'); // show cursor (in case hidden during streaming)
      }
      // Resume vim handler after command execution
      if (_vimHandler) try { _vimHandler.resume(); } catch { /* ignore */ }
      // Re-enable frame rendering so decoration lines appear on next prompt
      leaveInputPromptFrame();
      _flushMergedErrorHintLine();
      // No active task now: return cognition maps to start node (AI navigation baseline).
      _resetCognitionMapsToStartNode();
      // Flush any pending merge-queue lines before dequeuing — lines may still
      // be accumulating if the user pasted right before the AI finished.
      // B3: 每段清理独立 try-catch，确保异常不阻塞 readline 恢复
      try {
        if (_busyQueueMergeTimer) {
          clearTimeout(_busyQueueMergeTimer);
          _busyQueueMergeTimer = null;
          if (_busyQueueAccum.length > 0) {
            const lines = _busyQueueAccum;
            _busyQueueAccum = [];
            if (lines.length === 1) {
              _queuedInputs.push(lines[0]);
            } else {
              // Multi-line = paste. Don't auto-queue — let user edit first.
              const unwrapped = lines.map(l => {
                const m = PASTED_CONTENT_BLOCK_RE.exec(l);
                return m ? m[1] : l;
              });
              const merged = unwrapped.join('\n').trim();
              if (merged) _storePendingPaste(merged, null, '', false);
            }
          }
        }
      } catch (e) { try { console.error('[repl] paste queue cleanup error:', e?.message); } catch {} }
      // Also flush burst paste buffer if active
      try {
        if (_burstActive || _burstBuf) {
          if (_burstFlushTimer) { clearTimeout(_burstFlushTimer); _burstFlushTimer = null; }
          const burstText = _burstBuf.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
          _burstActive = false;
          _burstConsecutive = 0;
          _burstLastCharAt = 0;
          _burstWindowUntil = 0;
          _burstBuf = '';
          if (burstText) _storePendingPaste(burstText, null, '', false);
        }
      } catch (e) { try { console.error('[repl] burst buffer cleanup error:', e?.message); } catch {} }
      // If _pendingPaste was just set (paste waiting for user to press Enter),
      // don't dequeue anything — let the user interact with the paste first.
      if (_pendingPaste !== null) {
        recoverReadlineInput();
        try { rl.prompt(); } catch { /* readline may be destroyed */ }
        return;
      }
      // Steer 队列清理：未消费的 steer 消息转入 queue，避免丢失
      if (_steerQueue.length > 0) {
        for (const msg of _steerQueue.splice(0)) {
          _queuedInputs.push(msg);
        }
      }
      const nextQueued = _queuedInputs.shift();
      if (nextQueued) {
        try {
          const queuedPreview = _summarizeQueuedInputForDisplay(nextQueued, 48);
          console.log(c.dim(`  ↳ 继续处理排队输入: "${queuedPreview}"`));
          setImmediate(() => rl.emit('line', `${INTERNAL_LINE_PREFIX}${nextQueued}`));
          return;
        } catch { /* fallthrough to prompt */ }
      }
      recoverReadlineInput();
      try { rl.prompt(); } catch { /* readline may be destroyed */ }
    }
  });

  // Handle Ctrl+C — 2 presses terminate session, 3 presses exit KHY
  rl.on('SIGINT', () => {
    if (_busy) {
      // Busy state: Ctrl+C should interrupt current request, not arm exit.
      // 逃生阀:同窗口内累计第 3 次 Ctrl+C(仍忙 = 优雅取消没落地)→ 强制结束会话并退出,
      // 兑现用户「3 次 Ctrl+C 结束会话」。前两次先走原有的优雅取消(打断卡住的任务)。
      if (_maybeForceExitOnBusyInterrupt('Ctrl+C')) return; // 已强制退出(不会返回)
      _ctrlCCount = 0;
      if (_ctrlCTimer) {
        clearTimeout(_ctrlCTimer);
        _ctrlCTimer = null;
      }
      leaveInputPromptFrame();
      const cancelled = _requestRelayCancel('Interrupted by Ctrl+C');
      // Claude Code style: concise inline "Interrupted" marker
      console.log(c.dim('\n  ⏸ Interrupted') + c.dim('  (仍卡住？连按 Ctrl+C 3 次强制结束会话)'));
      printInterruptedTaskHint();
      try { rl.prompt(); } catch { /* readline may be destroyed */ }
      return;
    }

    _ctrlCCount++;
    if (_ctrlCTimer) clearTimeout(_ctrlCTimer);
    _ctrlCTimer = setTimeout(() => { _ctrlCCount = 0; }, 3000);

    if (_ctrlCCount >= 3) {
      // Triple Ctrl+C — exit KHY
      const savedMeta = ai().saveConversation();
      saveHistory(history);
      setTerminalTitle(''); // restore terminal title
      console.log('');
      console.log(c.cyan(`  ${MASCOT_MINI} `) + c.dim(getRandomFarewell()));
      printResumeRecoveryHints(savedMeta);
      printInterruptedTaskHint();
      console.log('');
      _uninstallBusyPromptConsolePatch();
      _intentionalExit = true; process.exit(0);
    }

    if (_ctrlCCount === 2) {
      // Double Ctrl+C — terminate current session, start fresh
      const savedMeta = ai().saveConversation();
      saveHistory(history);
      try { ai().clearHistory(); } catch {}
      if (_queryEngine) { try { _queryEngine.clearHistory(); } catch {} }
      _resetGatewayBreakerOnSessionClear();
      leaveInputPromptFrame();
      console.log('');
      console.log(c.hex('#FF9800')(`  ${MASCOT_MINI} 当前会话已保存并终止`));
      printResumeRecoveryHints(savedMeta);
      printInterruptedTaskHint();
      console.log(c.dim('  新会话已开始。再按一次 Ctrl+C 退出 KHY'));
      console.log('');
      try { rl.prompt(); } catch { /* readline may be destroyed */ }
      return;
    }

    _clearTransientInputState(rl);
    leaveInputPromptFrame();
    console.log(c.hex('#FFC107')('\n  Ctrl+C ×2 终止会话 | ×3 退出 KHY'));
    rl.prompt();
  });

  // Handle Ctrl+D (EOF) — save and exit gracefully
  // Guard: inquirer may close stdin which triggers 'close' on our readline.
  // _intentionalExit is set by /exit and double-Ctrl+C. For Ctrl+D (real EOF),
  // we check if inquirer is active — if not, it's a genuine exit request.
  rl.on('close', () => {
    if (_intentionalExit) {
      // Already handled (e.g., /exit command triggered process.exit above)
      return;
    }
    // Also honor the cross-module inquirer flag: handlers that run inquirer
    // outside repl.js (e.g. handleGatewaySelectModel via promptWithReplGuard)
    // set global.__KHY_INQUIRER_ACTIVE__ instead of the local _inquirerActive.
    // Without this check, /model's inquirer closing stdin was misread as a
    // real Ctrl+D (EOF) and exited the whole process to the shell.
    if (_inquirerActive || global.__KHY_INQUIRER_ACTIVE__ === true) {
      // Triggered by inquirer closing stdin — reopen readline
      try {
        process.stdin.resume();
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function' && !process.stdin.isRaw) {
          process.stdin.setRawMode(true);
        }
        rl.resume();
        rl.prompt();
      } catch { /* ignore */ }
      return;
    }
    // Real EOF (Ctrl+D) — save and exit
    // 「会话结束自动进度检查点」安全网(门控 KHY_PROGRESS_AUTO_CHECKPOINT):关闭应用/明天再来
    // 走的正是这条 EOF 退出,不经 clearHistory。在 saveConversation 前做启发式检查点,让下次能
    // 接上「上次学到哪」。绝不抛、绝不阻塞退出。
    try { ai().maybeAutoCheckpointProgress('eofExit'); } catch { /* never blocks exit */ }
    for (const t of _startupTimers) clearTimeout(t);
    clearInterval(_tipTimer);
    if (_ctrlCTimer) clearTimeout(_ctrlCTimer);
    try { process.removeListener('khy:adapter:account-email', _handleAccountEmail); } catch { /* ignore */ }
    try { process.stdout.removeListener('resize', _handleFooterResize); } catch { /* ignore */ }
    try { process.stdout.removeListener('resize', _handleStatusBarResize); } catch { /* ignore */ }
    try { require('./hudRenderer').stopLiveStatusBar(); } catch { /* ignore */ }
    try { if (_selfEditWatcher) _selfEditWatcher.stop(); } catch { /* ignore */ }
    try { require('../services/resourceGuard').cancelAll(); } catch { /* ignore */ }
    const savedMeta = ai().saveConversation();
    saveHistory(history);
    setTerminalTitle('');
    // Session recap transparency
    try {
      const hud = require('./hudRenderer');
      const state = hud.getState();
      const sessionData = {
        durationMs: Date.now() - state.sessionStart,
        totalInputTokens: state.sessionTokens.input,
        totalOutputTokens: state.sessionTokens.output,
        totalCostUSD: 0,
        requestCount: state.requestCount,
        toolCallCount: state.toolHistory.length,
        topTools: [],
      };
      // Calculate cost
      try {
        const tokenSvc = require('../services/tokenUsageService');
        const cost = tokenSvc.getSessionCost();
        sessionData.totalCostUSD = cost.costUSD || 0;
      } catch { /* ignore */ }
      // Compute top tools
      const toolCounts = {};
      for (const t of state.toolHistory) {
        toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
      }
      sessionData.topTools = Object.entries(toolCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      renderer.printSessionRecap(sessionData);
    } catch { /* transparency is best-effort */ }
    console.log('');
    console.log(c.cyan(`  ${MASCOT_MINI} `) + c.dim(getRandomFarewell()));
    printResumeRecoveryHints(savedMeta);
    console.log('');
    _uninstallBusyPromptConsolePatch();
    process.exit(0);
  });
}

module.exports = { startRepl, setReplSessionDeps };
