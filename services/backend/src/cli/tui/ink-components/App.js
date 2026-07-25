'use strict';

/**
 * App — root component for the Ink TUI (official `ink` package).
 *
 * Editing is delegated to useTextInput (Cursor-backed, CC-aligned keymap);
 * top-level useInput only handles routing concerns: permission prompts,
 * completion-menu navigation, global chords (Ctrl+C/O/L, Shift+Tab), and the
 * help overlay. Everything else falls through to the text input's onInput.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
const WelcomeBanner = require('./WelcomeBanner');
const Transcript = require('./Transcript');
const StreamingBlock = require('./StreamingBlock');
const PromptFrame = require('./PromptFrame');
const caretGeometry = require('./caretGeometry');
const _sessionColorLeaf = require('../../sessionColor');
const _sessionColorState = require('../../sessionColorState');
const FooterBar = require('./FooterBar');
const PermissionsPrompt = require('./PermissionsPrompt');
const QuestionPrompt = require('./QuestionPrompt');
const ModelPicker = require('./ModelPicker');
const RewindPicker = require('./RewindPicker');
const FormFlow = require('./FormFlow');
const KhyOsView = require('./KhyOsView');
const PlanApproval = require('./PlanApproval');
const Spinner = require('./Spinner');
const CompactionProgress = require('./CompactionProgress');
const CompletionMenu = require('./CompletionMenu');
const HelpMenu = require('./HelpMenu');
const ShellView = require('./ShellView');
const TaskListPanel = require('./TaskListPanel');
const TopologyPanel = require('./TopologyPanel');
const { useQueryBridge, buildResumedTranscript } = require('../hooks/useQueryBridge');
const { useVimInput } = require('../hooks/useVimInput');
const { useCompletions, applyCompletion } = require('../hooks/useCompletions');
const { useTopic } = require('../hooks/useTopic');
const topicBar = require('../runtime/topicBar');
const rewindControl = require('../rewindControl');
const interruptHint = require('../interruptHint');
// ↑/↓ history-browse decision while editing (pure leaf, single source + gate).
const { shouldBrowseHistoryWhileEditing } = require('../historyBrowseDecision');
// footer identity equality (pure, single source of truth) — lets refreshFooter's
// setFooter return the SAME ref when nothing changed, so an adapterInfo churn can
// no longer force an unconditional re-render (the render-storm "loaded gun").
const { footersEqual } = require('../footerStability');

// Live-region height coordinator (anti scroll-jump). Pure leaf; fail-soft require
// so a missing module byte-reverts to legacy reserves. Gate KHY_LIVE_HEIGHT_BUDGET.
let _liveBudget = null;
try { _liveBudget = require('./liveRegionBudget'); } catch { _liveBudget = null; }
// CC-aligned chat/global key chords → action name (pure leaf, fail-soft require).
// Gate KHY_CHAT_CHORDS. Missing module / gate off → resolveChatChord yields null
// so the keys byte-revert to falling through to the text input. See chatChords.js.
let _chatChords = null;
try { _chatChords = require('../chatChords'); } catch { _chatChords = null; }
// CC-aligned Ctrl+R reverse-incremental history search (pure leaf, fail-soft
// require). Gate KHY_HISTORY_REVERSE_SEARCH. Missing module / gate off →
// isEnabled false → the Ctrl+R branch never activates and the key byte-reverts
// to falling through to the text input. See services/keybindings/historyReverseSearch.js.
let _revSearch = null;
try { _revSearch = require('../../../services/keybindings/historyReverseSearch'); } catch { _revSearch = null; }
// Thin read-only Ink overlay for the reverse-search prompt line. Fail-soft; if the
// component is unavailable the search state simply renders nothing.
let _HistorySearchOverlay = null;
try { _HistorySearchOverlay = require('./HistorySearchOverlay'); } catch { _HistorySearchOverlay = null; }
// Single-slot memo for the completion dropdown's caret margin (skips full-buffer
// re-layout while arrowing through the open menu). Fail-soft require; gate off /
// absent → compute every render (byte-identical). See promptCaretMarginMemo.
let _caretMarginMemo = null;
try { _caretMarginMemo = require('./promptCaretMarginMemo'); } catch { _caretMarginMemo = null; }
// ── App.js 模块作用域助手（已抽取为叶子 ./appHostHelpers.js）────────────────────────
// 权限模式应用 + 任务面板行 + 状态行/spinner/队列面板派生,皆 React 闭包无关。完整实现见该
// 叶子(降上帝文件·DESIGN-ARCH-051 lineage,范式同 queryBridgeTimeline)。此处以 **同名
// re-import** 接回:App() 体、_renderQueuePanel 内部调用与 module.exports 均按原名消费,契约
// 字节不变。_caretMarginMemo(App() 专用,非本簇)保留于上方模块作用域。
const {
  _readMergedTaskLines, PERMISSION_MODES, applyPermissionMode,
  _normToolName, isQuestionRequest, _learnNeedsClassic, tuiUnsupportedReason,
  _taskActivity, _getStatusLabel, _liveActivity, _spinnerCcTokensEnabled,
  _estimateTok, _spinnerProgress, _queuePanelLines, _renderQueuePanel,
  _liveClampBoundaryDecision,
} = require('./appHostHelpers');

function App({ options = {} }) {
  const h = React.createElement;
  const { Box, Text, Static, useInput, useApp } = inkRuntime.get();
  const { exit } = useApp();

  // CC 对齐计划模式:真·循环拦到 ExitPlanMode(plan) 时,经 bridge 回调本 ref → 落 currentPlan、
  // 切 reviewing 态复用既有 PlanApproval。用 ref 打破「query 依赖 handler、handler 依赖 query」的
  // 循环依赖:先建空 ref、下方 effect 再装真正的句柄(handleLoopExitPlan)。门关时循环根本不回调。
  const planExitRef = React.useRef(null);
  const query = useQueryBridge({
    onExitPlanMode: (p) => { const fn = planExitRef.current; if (typeof fn === 'function') fn(p); },
  });
  const [footer, setFooter] = React.useState({});

  // CC 对齐:页脚 `◎ /goal active (Nm)` 指示器状态。读活动持久目标 + 纯叶子 formatGoalElapsed
  // 算已持续时长标签。goalStore.getActiveGoal 走文件(非缓存),故不在每帧读——由下方一个低频
  // (30s)心跳 + 目标设定/清除后的显式刷新驱动(分钟级粒度足够)。异常/无目标 → null → 不渲。
  const [goalActive, setGoalActive] = React.useState(null);
  const refreshGoalActive = React.useCallback(() => {
    try {
      const goal = require('../../../services/goalStore').getActiveGoal(process.cwd());
      if (!goal || !goal.text) { setGoalActive((g) => (g == null ? g : null)); return; }
      const label = require('../../../services/goalKickoff').formatGoalElapsed(goal.createdAt, Date.now());
      setGoalActive((g) => (g && g.elapsedLabel === label && g.id === goal.id ? g : { id: goal.id, elapsedLabel: label }));
    } catch { setGoalActive((g) => (g == null ? g : null)); }
  }, []);
  // 挂载即读一次,并每 30s 刷新一次已持续时长(分钟级粒度,低频足够,idle 时也保持推进)。
  React.useEffect(() => {
    refreshGoalActive();
    const id = setInterval(refreshGoalActive, 30000);
    return () => clearInterval(id);
  }, [refreshGoalActive]);

  // LAN collaboration bridge status, surfaced PERSISTENTLY in the footer so the
  // pairing URL / PIN / live client count never scroll away after the one-shot
  // startup banner (the banner lands in scrollback and is buried once a turn
  // streams). Lazy-initialized from the snapshot, then kept live by subscribing
  // to bridge events (connect/disconnect/presence/rename). Opt out with
  // KHY_BRIDGE_FOOTER=0. Renders nothing when no bridge is running.
  const bridgeFooterOff = String(process.env.KHY_BRIDGE_FOOTER ?? '').trim().toLowerCase() === '0';
  const [bridgeStatus, setBridgeStatus] = React.useState(() => {
    if (bridgeFooterOff) return null;
    try { return require('../../../bridge/bridgeServer').getStatusSnapshot(); }
    catch { return null; }
  });
  React.useEffect(() => {
    if (bridgeFooterOff) return undefined;
    let bridge;
    try { bridge = require('../../../bridge/bridgeServer'); } catch { return undefined; }
    const refresh = () => {
      try { setBridgeStatus(bridge.getStatusSnapshot()); } catch { /* keep last */ }
    };
    refresh(); // reconcile against the live server once mounted
    const unsubscribe = typeof bridge.onBridgeEvent === 'function'
      ? bridge.onBridgeEvent(refresh)
      : null;
    return () => { try { if (unsubscribe) unsubscribe(); } catch { /* ignore */ } };
  }, [bridgeFooterOff]);

  // 自维护顾问 · 外部编辑器监视器(§3):当会话 cwd 位于某 khy monorepo 内,监视 khy 源码
  // 被外部编辑器(VS Code/vim 等)直改,主动向人(notice)与 AI(下一轮 btw 注记)反馈。
  // 非 khy 工程 / 门控关 → start 直接 no-op。挂载起、卸载停。fail-open,绝不影响会话。
  React.useEffect(() => {
    let watcher = null;
    try {
      const svc = require('../../../services/selfEditAdvisoryService');
      watcher = require('../../../services/selfEditWatcher');
      const root = svc.detectKhyRepoRoot(process.env.KHYQUANT_CWD || process.cwd());
      if (!root) return undefined; // 非 khy monorepo → 不监视
      watcher.start({
        root,
        onAdvisory: (adv) => {
          if (!adv) return;
          // 人面:notice 追加(闲时可见)。
          try {
            if (adv.humanLine) query.setMessages((m) => [...m, { type: 'notice', content: adv.humanLine, timestamp: Date.now() }]);
          } catch { /* best-effort */ }
          // AI 下一轮:btw 注记(提交时 mergeHints 排空)。
          try {
            if (adv.aiNote) require('../../../services/conversation/btwNoteQueue').enqueue(adv.aiNote);
          } catch { /* best-effort */ }
        },
      });
    } catch { /* watcher is best-effort; never disturbs the session */ }
    return () => { try { if (watcher) watcher.stop(); } catch { /* ignore */ } };
  }, []);

  // Recompute the footer from LIVE sources (active adapter + ai.js getters),
  // not mount-time defaults. Two real bugs this fixes: (1) getContextLimit() was
  // called with NO model hint, so it couldn't resolve the active model's real
  // window and fell back to a generic 128k; we now pass the active model so the
  // gateway/static table reports the true window. (2) The footer was loaded once
  // on mount, before the gateway had async-resolved the model — so it froze at
  // the unresolved defaults; refreshFooter is re-run on adapter changes, on turn
  // settle, and after a model switch so model/effort/context stay truthful.
  const refreshFooter = React.useCallback(() => {
    try {
      const aiMod = require('../../ai');
      const gateway = require('../../../services/gateway/aiGateway');
      const active = gateway.getActiveAdapter ? gateway.getActiveAdapter() : null;
      const activeModel = active?.activeModel || process.env.GATEWAY_PREFERRED_MODEL || 'auto';
      setFooter((f) => {
        const next = {
          ...f,
          model: activeModel,
          adapter: process.env.GATEWAY_PREFERRED_ADAPTER || active?.name || f.adapter || 'auto',
          effort: aiMod.getActiveEffort ? aiMod.getActiveEffort()
            : (aiMod.getEffort ? aiMod.getEffort() : (f.effort || 'medium')),
          // Pass the active model so the REAL context window resolves; without the
          // hint getContextLimit() guesses and falls back to 128k.
          contextLimit: aiMod.getContextLimit ? aiMod.getContextLimit(activeModel) : (f.contextLimit || 128000),
          contextPct: f.contextPct || 0,
        };
        // Equality guard: if every identity field is unchanged, return the SAME
        // ref so React skips the re-render (mirrors the contextPct guard at the
        // G-A effect). Without this, refreshFooter forced a render on every call.
        return footersEqual(f, next) ? f : next;
      });
    } catch { /* gateway/ai not ready yet — a later refresh will fill it in */ }
  }, []);
  // Initial badge reflects the REAL booted permission mode (KHY_PERMISSION_MODE,
  // normalized by toolCalling) so the displayed mode never lies about the actual
  // tool-gating. Lazy + guarded: falls back to 'default' if toolCalling is
  // unavailable. getPermissionMode() returns the same vocabulary as
  // PERMISSION_MODES, so no extra normalization is needed here.
  const [permissionMode, setPermissionMode] = React.useState(() => {
    try {
      const tc = require('../../../services/toolCalling');
      return tc.getPermissionMode ? tc.getPermissionMode() : 'default';
    } catch { return 'default'; }
  });
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [showHelp, setShowHelp] = React.useState(false);
  // Ctrl+R reverse-incremental history search (CC parity). null = inactive;
  // active = { query, matches, index, current } as returned by the pure leaf
  // historyReverseSearch. The overlay is a thin read-only renderer; all decision
  // logic lives in the leaf. Gated by KHY_HISTORY_REVERSE_SEARCH (default on).
  const [revSearch, setRevSearch] = React.useState(null);
  const [dismissedFor, setDismissedFor] = React.useState(null);
  const [expanded, setExpanded] = React.useState(false);
  // Ctrl+T (CC app:toggleTodos) toggles the task checklist panel's visibility.
  // When hidden, the coordination block forces zero task lines so the live region
  // shrinks and StreamingBlock reclaims the rows.
  const [tasksHidden, setTasksHidden] = React.useState(false);
  // 测量反馈钳制(KHY_LIVE_HEIGHT_CLAMP 默认开):额外叠加到前馈 reserve 的行数,由 ink 实测
  // 的上一帧 live 高度驱动(见下方 useLayoutEffect)。一轮内单调非降,轮次边界复位 0。
  const [extraReserve, setExtraReserve] = React.useState(0);
  const _extraTurnKey = React.useRef(null);
  // When false, the live UI region is unmounted and ink's input is released so
  // an interactive command handler (e.g. inquirer-driven `/model`) can own the
  // terminal. Restored to true once the handler resolves.
  const [inputActive, setInputActive] = React.useState(true);
  // Native model selection overlay (replaces inquirer-driven `/model`). When set
  // to { choices, defaultValue } the ModelPicker is mounted and owns input.
  const [modelPicker, setModelPicker] = React.useState(null);
  // Native rewind-target overlay (Phase 2 of the double-ESC 回溯). When set to
  // { targets } the RewindPicker is mounted and owns input; selecting a row runs
  // the same performRewind pipeline Phase 1 uses.
  const [rewindPicker, setRewindPicker] = React.useState(null);
  // Native /rollback checkpoint picker (classic-REPL parity repl.js:3951-3975).
  // When set to { targets, cwd } a RewindPicker is reused to choose a checkpoint;
  // selecting a row restores it via checkpointService. Distinct from rewindPicker
  // (conversation rewind) so the two pipelines never conflate.
  const [rollbackPicker, setRollbackPicker] = React.useState(null);
  // Native sequential-form overlay (replaces inquirer-driven `/login`,
  // `/register`, `/passwd`). When set to { fields, title, resolve } the FormFlow
  // is mounted and owns input; `resolve` is the pending promise resolver.
  const [formFlow, setFormFlow] = React.useState(null);
  // KHY OS kernel terminal overlay (/khyos). When true the KhyOsView is mounted
  // and owns input: it boots a KhyOsRunner under QEMU and bridges the bare-metal
  // kernel's serial console. Esc returns to the AI chat.
  const [khyosOpen, setKhyosOpen] = React.useState(false);
  // 会话拓扑「森林」只读面板(/topology view·学自 Stello「把线性对话炸开成一张网」)。
  // 设为 { forest, currentId, degraded } 时挂 TopologyPanel 覆盖层;Esc/Enter 关闭。
  // 只读、不拥有导航,故主 useInput 仅在面板挂载时拦 Esc/Enter 关闭即可(无双重处理)。
  const [topologyView, setTopologyView] = React.useState(null);
  // Transient affordance line ("再按一次 Ctrl-C 退出" / "Esc again to clear"),
  // mirroring Claude Code's double-press hints.
  const [hint, setHint] = React.useState('');
  // Images attached to the next turn (Ctrl+V from clipboard). Each entry is
  // { base64, mimeType, ... } as produced by imageService.readImageFromClipboard.
  const [pendingImages, setPendingImages] = React.useState([]);
  // Local mode toggle (/local). When true, turns skip the AI model and are
  // handled by the Tier 1 + Tier 2 local brain (forceLocal) — same semantics as
  // the classic REPL's _localMode. Threaded into query.submit as `forceLocal`.
  const [localMode, setLocalMode] = React.useState(false);
  // Fast mode toggle (/fast). On → disable extended thinking + effort 'low' for
  // quicker responses; off → restore the thinking/effort captured at enable
  // time. fastSavedRef holds the pre-fast settings so the toggle is reversible.
  const [fastMode, setFastMode] = React.useState(false);
  const fastSavedRef = React.useRef(null);
  // Voice mode toggle (/voice). Mirrors the persisted voiceService flag; when on
  // the query bridge speaks each assistant reply via TTS. State here only drives
  // the footer badge — the persisted setting is the single source of truth.
  const [voiceMode, setVoiceMode] = React.useState(false);
  // Vim modal editing toggle (/vim). When true the prompt uses useVimInput.
  const [vimEnabled, setVimEnabled] = React.useState(false);
  // Current vim mode ('INSERT' | 'NORMAL'), surfaced for the indicator + caret.
  const [vimMode, setVimMode] = React.useState('INSERT');
  // Plan-mode workflow (Shift+Tab→plan or /plan). planPhase:
  //   null         — not in a plan flow (cosmetic 'plan' permission may still be set)
  //   'generating' — enterPlanMode() streaming a plan from the model
  //   'reviewing'  — plan rendered, awaiting approval grammar via the text input
  //   'executing'  — executePlanSteps() running the approved steps
  const [planPhase, setPlanPhase] = React.useState(null);
  const [currentPlan, setCurrentPlan] = React.useState(null);
  const [planGenText, setPlanGenText] = React.useState('');
  // Shell peek panel (块4 SUBVIEW): opened with ↓ while a turn is executing to
  // inspect the current/recent tool's output; ← returns to the main flow, ↑/↓
  // scroll within it. `shellScroll` is the line offset into the tool output.
  const [shellViewOpen, setShellViewOpen] = React.useState(false);
  const [shellScroll, setShellScroll] = React.useState(0);
  // Spinner heartbeat: a 1s tick drives elapsed-time + stall detection while a
  // turn is in flight. lastActivityRef stamps the last time streamed output
  // changed, so a gap > 3s flags the turn as "等待响应…" (stalled).
  const [nowTick, setNowTick] = React.useState(0);
  const lastActivityRef = React.useRef(0);

  // 排队编辑提示计数(CC queuedCommandUpHintCount):用户按 ↑ 取回排队消息 N 次后
  // 不再提示(cap = promptPlaceholder.QUEUE_HINT_MAX_SHOWS)。见占位符阶梯 wiring。
  const queueHintUsesRef = React.useRef(0);

  // Double-press tracking + hint timer (CC's useDoublePress mechanism inlined).
  const ctrlCAt = React.useRef(0);
  const ctrlDAt = React.useRef(0);
  const escAt = React.useRef(0);
  const hintTimer = React.useRef(null);
  const DOUBLE_PRESS_MS = 1000;
  const showHint = React.useCallback((text) => {
    setHint(text);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(''), 1500);
  }, []);
  React.useEffect(() => () => clearTimeout(hintTimer.current), []);

  // G-A: reflect the TRUE context-window fill in the footer. contextTokens is
  // the latest turn's reported usage (≈ current occupancy); contextLimit is the
  // resolved model window. Previously contextPct was pinned to 0 → a fake 0%.
  React.useEffect(() => {
    const limit = footer.contextLimit;
    const used = query.contextTokens || 0;
    if (!limit || limit <= 0) return;
    const pct = Math.min(100, Math.round((used / limit) * 100));
    setFooter((f) => (f.contextPct === pct ? f : { ...f, contextPct: pct }));
  }, [query.contextTokens, footer.contextLimit]);

  // G-B: 1s heartbeat while a turn is busy so the spinner can show elapsed time
  // and detect a stall. Stops when the turn settles (idle/done) to avoid an
  // always-on timer.
  React.useEffect(() => {
    const active = query.status && query.status !== 'idle' && query.status !== 'done';
    if (!active) return undefined;
    setNowTick(Date.now());
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [query.status]);

  // G-B: stamp the last time streamed output changed (throttled ~40ms upstream).
  // The stall check compares now − this stamp; a fresh turn resets it.
  React.useEffect(() => {
    lastActivityRef.current = Date.now();
  }, [query.streaming]);

  // `khy os` (no subcommand) launches straight into the kernel terminal: open
  // the KhyOsView overlay once on mount when the option is set.
  React.useEffect(() => {
    if (options.khyosDirect) setKhyosOpen(true);
    // `khy resume <id>` restored the transcript into ai._messages at the process
    // level (startRepl skipped clearHistory). Replay those messages into the
    // visible <Static> region so the user actually SEES "the previous
    // conversation window" instead of an empty shell. Purely visual — the model
    // context already lives in _messages; this seeding is independent of it.
    if (options.resumed) {
      try {
        const aiMod = require('../../ai');
        const source = typeof aiMod.getConversation === 'function' ? aiMod.getConversation() : [];
        const restored = buildResumedTranscript(source);
        if (restored.length > 0) query.setMessages(() => restored);
      } catch { /* visual replay only — a failure must not affect loaded context */ }
      // Interrupted-build continuation: auto-submit the original goal so the user
      // need not retype it (the bare-resume aiForward contract).
      if (options.resumeForward && typeof options.resumeForward === 'string') {
        try { query.submit(options.resumeForward, {}); } catch { /* best effort */ }
      }
    }
    // Sync the voice badge with the persisted voiceService flag on mount, so a
    // previously-enabled session shows the indicator without a re-toggle.
    try {
      const vs = require('../../../services/voiceService');
      if (vs.getVoiceSettings().enabled) setVoiceMode(true);
    } catch { /* voiceService unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+V image paste (Claude Code `chat:imagePaste`). Terminals deliver an
  // image on the system clipboard, not through stdin, so we read it explicitly
  // via the shared imageService (same cross-platform path the readline REPL
  // uses) and stage it as an attachment for the next turn. Nothing is sent yet.
  const attachClipboardImage = React.useCallback(() => {
    let imageService;
    try { imageService = require('../../../services/imageService'); } catch { imageService = null; }
    if (!imageService || typeof imageService.readImageFromClipboard !== 'function') {
      showHint('图片粘贴不可用');
      return;
    }
    try {
      // Image-first, then clipboard file-path fallback (Claude Code model): a
      // bitmap is read directly; otherwise a copied/bridge-produced image path
      // is loaded. Falls back to the bitmap-only reader on older builds.
      const reader = typeof imageService.readImageFromClipboardOrPath === 'function'
        ? imageService.readImageFromClipboardOrPath
        : imageService.readImageFromClipboard;
      const img = reader();
      if (!img || !img.base64) { showHint('剪贴板没有图片（也不是图片路径）'); return; }
      setPendingImages((list) => {
        const next = [...list, { base64: img.base64, mimeType: img.mimeType || 'image/png' }];
        showHint(`已附加图片 ${next.length}（Enter 发送，Esc 取消）`);
        return next;
      });
    } catch (err) {
      showHint('读取剪贴板图片失败：' + (err.message || err));
    }
  }, [showHint]);

  // ── Native model picker (/model) ───────────────────────────────────────
  // Probe adapters and open the ModelPicker overlay. Replaces the inquirer
  // prompt, which cannot coexist with ink's managed raw-mode input (the reason
  // `/model` exited immediately inside the TUI). Probe progress/diagnostics are
  // pushed into the transcript via the build callbacks.
  const openModelPicker = React.useCallback(async () => {
    const push = (role, content) =>
      query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
    let gw;
    try { gw = require('../../handlers/gateway'); } catch { gw = null; }
    if (!gw || typeof gw.buildGatewayModelChoices !== 'function') {
      push('error', '模型选择不可用');
      return;
    }
    let built;
    try {
      built = await gw.buildGatewayModelChoices({
        onNotice: (msg) => push('notice', msg),
        onError: (msg) => push('error', msg),
      });
    } catch (err) {
      push('error', '探测模型失败：' + (err.message || err));
      return;
    }
    // Empty case already emitted its own explanatory notices in build().
    if (!built || built.empty || !Array.isArray(built.modelChoices) || built.modelChoices.length === 0) {
      return;
    }
    setModelPicker({
      choices: built.modelChoices,
      defaultValue: {
        adapter: process.env.GATEWAY_PREFERRED_ADAPTER || undefined,
        model: process.env.GATEWAY_PREFERRED_MODEL || undefined,
      },
    });
  }, [query]);

  // Resolve the model picker: apply the selection (persist + sync + refresh) and
  // mirror the new model/adapter into the footer, or report cancellation.
  const resolveModelPicker = React.useCallback(async (value) => {
    setModelPicker(null);
    if (!value) {
      query.setMessages((m) => [...m, { role: 'notice', content: '已取消模型选择', timestamp: Date.now() }]);
      return;
    }
    let gw;
    try { gw = require('../../handlers/gateway'); } catch { gw = null; }
    if (!gw || typeof gw.applyGatewayModelSelection !== 'function') {
      query.setMessages((m) => [...m, { role: 'error', content: '应用模型选择不可用', timestamp: Date.now() }]);
      return;
    }
    try {
      const { tokenInfo } = await gw.applyGatewayModelSelection(value);
      query.setMessages((m) => [...m, {
        role: 'notice',
        content: `已选择: ${value.model || '默认模型'} (${value.adapter}) · Token: ${tokenInfo.source} → ${tokenInfo.detail}`,
        timestamp: Date.now(),
      }]);
      // Recompute from live sources so the new model's REAL context window and
      // effort are shown (not just the model/adapter labels).
      setFooter((f) => ({ ...f, model: value.model || 'auto', adapter: value.adapter }));
      refreshFooter();
    } catch (err) {
      query.setMessages((m) => [...m, { role: 'error', content: '应用模型选择失败：' + (err.message || err), timestamp: Date.now() }]);
    }
  }, [query, refreshFooter]);

  // Natural-language model switch ("切换模型到 deepseek"): reuse the SAME catalog
  // /model uses, filtered to one vendor. If the user named a model that uniquely
  // matches, apply it directly; otherwise open the picker over the vendor's models.
  // Driven by the pure leaf nlModelSwitchResolver (gated KHY_NL_MODEL_SWITCH); the
  // handleSubmit interceptor only calls this when resolve() returned a vendor hit.
  const openModelPickerForVendor = React.useCallback(async (vendor, modelHint) => {
    const push = (role, content) =>
      query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
    let gw;
    try { gw = require('../../handlers/gateway'); } catch { gw = null; }
    if (!gw || typeof gw.buildVendorModelChoices !== 'function') {
      push('error', '模型切换不可用');
      return;
    }
    let built;
    try {
      built = await gw.buildVendorModelChoices({
        vendor,
        modelHint,
        onNotice: (msg) => push('notice', msg),
        onError: (msg) => push('error', msg),
      });
    } catch (err) {
      push('error', '探测模型失败：' + (err.message || err));
      return;
    }
    // Empty case already emitted its own explanatory notice in build().
    if (!built || built.empty || !Array.isArray(built.modelChoices) || built.modelChoices.length === 0) {
      return;
    }
    // Uniquely-named model → apply directly (reuse resolveModelPicker: persist +
    // sync + refresh + footer + notice, with a null-safe cancel path).
    if (built.directPick) {
      await resolveModelPicker(built.directPick);
      return;
    }
    setModelPicker({
      choices: built.modelChoices,
      defaultValue: {
        adapter: process.env.GATEWAY_PREFERRED_ADAPTER || undefined,
        model: process.env.GATEWAY_PREFERRED_MODEL || undefined,
      },
    });
  }, [query, resolveModelPicker]);

  // Open a FormFlow overlay and resolve with the collected answers (or null on
  // cancel). Returns a promise so command handlers can `await` the input the
  // same way they awaited inquirer, without inquirer fighting ink for stdin.
  const askForm = React.useCallback((spec) => new Promise((resolve) => {
    setFormFlow({ ...spec, resolve });
  }), []);

  const resolveFormFlow = React.useCallback((answers) => {
    setFormFlow((cur) => {
      if (cur && typeof cur.resolve === 'function') cur.resolve(answers);
      return null;
    });
  }, []);

  // Register askForm with the process-wide uiPrompt bridge so inquirer-style
  // command handlers (review/cloud/pool/app/docs/publish/…) collect input
  // through this native overlay instead of toppling Ink with real inquirer.
  // Registered only while <App/> is mounted; cleared on unmount so a stale
  // closure is never invoked after the TUI exits (handlers then see
  // isTuiActive()===false and use real inquirer in the classic REPL).
  React.useEffect(() => {
    let uiPrompt;
    try { uiPrompt = require('../../uiPrompt'); } catch { uiPrompt = null; }
    if (!uiPrompt) return undefined;
    uiPrompt.register(askForm);
    return () => uiPrompt.unregister();
  }, [askForm]);

  // Drive the auth commands (login/register/passwd) through the native form
  // instead of the inquirer prompts baked into router.js's switch. The auth
  // service (cliAuthService) is the same one the readline REPL calls; only the
  // input-collection layer differs. Returns true if the command was consumed.
  const runAuthForm = React.useCallback(async (command) => {
    const push = (role, content) =>
      query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
    let cliAuth;
    try { cliAuth = require('../../../services/cliAuthService'); } catch { cliAuth = null; }
    if (!cliAuth) { push('error', '账号服务不可用'); return true; }

    if (command === 'login') {
      const session = cliAuth.checkSession();
      if (session.loggedIn) {
        push('notice', `当前已登录: ${session.username}（切换账号请先 /logout）`);
        return true;
      }
      const answers = await askForm({
        title: '登录',
        fields: [
          { name: 'username', label: '用户名:', validate: (v) => v.trim().length > 0 || '请输入用户名' },
          { name: 'password', label: '密码:', type: 'password', validate: (v) => v.length > 0 || '请输入密码' },
        ],
      });
      if (!answers) { push('notice', '已取消登录'); return true; }
      const result = await cliAuth.login(answers.username, answers.password);
      if (result.success) push('notice', `登录成功! 欢迎, ${result.username}`);
      else push('error', result.error || '登录失败');
      return true;
    }

    if (command === 'register') {
      if (cliAuth.isRegistered()) {
        push('notice', '本机已有注册账号。如需重置请删除 ~/.khyquant/credentials.json');
        return true;
      }
      const answers = await askForm({
        title: '注册',
        fields: [
          { name: 'username', label: '用户名 (至少 2 字符):', validate: (v) => v.trim().length >= 2 || '至少 2 个字符' },
          { name: 'password', label: '设置密码 (至少 6 字符):', type: 'password', validate: (v) => v.length >= 6 || '至少 6 个字符' },
          { name: 'confirm', label: '确认密码:', type: 'password', validate: (v, a) => v === a.password || '两次密码不一致' },
          { name: 'email', label: '邮箱 (可选):', validate: () => true },
        ],
      });
      if (!answers) { push('notice', '已取消注册'); return true; }
      const result = await cliAuth.register(answers.username, answers.password, answers.email || undefined);
      if (result.success) push('notice', `注册成功! 欢迎, ${result.username}`);
      else push('error', result.error || '注册失败');
      return true;
    }

    if (command === 'passwd') {
      const answers = await askForm({
        title: '修改密码',
        fields: [
          { name: 'oldPassword', label: '当前密码:', type: 'password', validate: (v) => v.length > 0 || '请输入当前密码' },
          { name: 'newPassword', label: '新密码 (至少 6 字符):', type: 'password', validate: (v) => v.length >= 6 || '至少 6 个字符' },
          { name: 'confirm', label: '确认新密码:', type: 'password', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
        ],
      });
      if (!answers) { push('notice', '已取消修改密码'); return true; }
      const result = await cliAuth.changePassword(answers.oldPassword, answers.newPassword);
      if (result.success) push('notice', '密码修改成功');
      else push('error', result.error || '修改失败');
      return true;
    }

    return false;
  }, [query, askForm]);

  // /apikey (gateway config) common paths — add a provider API key and configure
  // the network proxy — driven by native FormFlow overlays. The full settings
  // tree (ollama / relay / routing-policy / key-strategy / subscriptions / custom
  // providers …) stays in the classic inquirer flow; the entry menu routes there
  // with a notice when an advanced action is chosen.
  const runApiKeyConfig = React.useCallback(async () => {
    const push = (role, content) =>
      query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
    let gw;
    try { gw = require('../../handlers/gateway'); } catch { gw = null; }
    if (!gw) { push('error', '网关服务不可用'); return; }
    const onNotice = (c) => push('notice', c);
    const onError = (c) => push('error', c);

    const top = await askForm({
      title: 'API Key 配置',
      fields: [{
        name: 'action', label: '请选择:', type: 'select',
        choices: [
          { name: '添加 API Key（厂商密钥）', value: 'add-key' },
          { name: '配置网络代理（Clash / HTTP）', value: 'proxy' },
          { name: '其他高级配置（经典模式）', value: 'advanced' },
        ],
      }],
    });
    if (!top) { push('notice', '已取消'); return; }

    if (top.action === 'advanced') {
      push('notice', '「高级网关配置」暂需经典模式：请退出后用 KHY_FULL_TUI=0 khy 运行 /apikey。');
      return;
    }

    if (top.action === 'add-key') {
      const choices = gw.getProviderKeyChoices();
      const pick = await askForm({
        title: '选择厂商',
        fields: [{ name: 'provider', label: '厂商:', type: 'select', choices }],
      });
      if (!pick) { push('notice', '已取消'); return; }
      const provider = pick.provider;

      const fields = [
        { name: 'keyInput', label: `${provider.name} API Key:`, type: 'password',
          validate: (v) => v.trim().length > 0 || '请输入 API Key' },
      ];
      if (!provider.isToken) {
        fields.push({ name: 'label', label: '标签 (可选):', validate: () => true });
      }
      if (provider.models && provider.models.length > 0) {
        fields.push({
          name: 'model', label: '默认模型 (可选):', type: 'select',
          choices: [
            { name: '（不设置默认模型）', value: '' },
            ...provider.models.map((m) => ({ name: m, value: m })),
          ],
        });
      }
      const ans = await askForm({ title: `添加 ${provider.name}`, fields });
      if (!ans) { push('notice', '已取消'); return; }

      await gw.applyProviderKey({
        provider,
        keyInput: ans.keyInput,
        label: ans.label || '',
        model: ans.model || '',
      }, { onNotice, onError });
      return;
    }

    if (top.action === 'proxy') {
      const info = gw.getProxyConfigInfo();
      push('notice', info.active
        ? `当前代理: ${info.url || '(已启用)'}`
        : '当前未启用代理');
      if (info.warning) push('notice', info.warning);

      const ans = await askForm({
        title: '网络代理',
        fields: [{
          name: 'action', label: '操作:', type: 'select',
          choices: [
            { name: '自动检测并启用 Clash', value: 'detect' },
            { name: '手动设置 HTTP 代理端口', value: 'http' },
            { name: '关闭代理', value: 'off' },
          ],
        }],
      });
      if (!ans) { push('notice', '已取消'); return; }

      let port;
      if (ans.action === 'http') {
        const p = await askForm({
          title: 'HTTP 代理端口',
          fields: [{
            name: 'port', label: '端口:', defaultValue: '7890',
            validate: (v) => /^\d+$/.test(v.trim()) || '请输入端口数字',
          }],
        });
        if (!p) { push('notice', '已取消'); return; }
        port = p.port;
      }
      await gw.applyProxyAction({ action: ans.action, port }, { onNotice, onError });
      return;
    }
  }, [query, askForm]);

  // Handle a `{ route: null, flag }` slash command that toggles TUI/session
  // state in-process. Returns true if consumed (caller must NOT fall through to
  // route(), which would forward the command to the AI as plain text). State
  // toggles reuse the same ai() setters the readline REPL uses.
  const handleFlag = React.useCallback((flag) => {
    const ai = () => require('../../ai');
    const notice = (content) =>
      query.setMessages((m) => [...m, { role: 'notice', content, timestamp: Date.now() }]);

    switch (flag) {
      case 'thinking': {
        const next = !ai().isThinkingEnabled();
        ai().setThinkingEnabled(next);
        notice(next
          ? '扩展思考已开启 — 模型产出推理（DeepSeek 切 R1），实时显示后折叠'
          : '扩展思考已关闭 — 跳过推理请求（DeepSeek 用 V3），省时延与 token');
        return true;
      }
      case 'effort-max':
      case 'effort-high':
      case 'effort-medium':
      case 'effort-low': {
        const level = flag.slice('effort-'.length);
        ai().setEffort(level);
        refreshFooter(); // reflect the new effort in the status bar immediately
        notice(`精度模式已切换为 ${level}`);
        return true;
      }
      case 'vim': {
        setVimEnabled((v) => {
          const next = !v;
          if (!next) setVimMode('INSERT');
          notice(next
            ? 'Vim 模式已开启（INSERT 起步 · Esc 进 NORMAL · i/a/o 回 INSERT）'
            : 'Vim 模式已关闭');
          return next;
        });
        return true;
      }
      case 'plan': {
        // Enter plan mode: read-only profile + flag the mode. The plan
        // generation/approval flow is driven on the next submit (stage 3).
        setPermissionMode('plan');
        applyPermissionMode('plan');
        notice('已进入计划模式（只读）：输入需求以生成执行计划，Shift+Tab 可切回');
        return true;
      }
      case 'local': {
        setLocalMode((v) => {
          const next = !v;
          notice(next
            ? '本地模式已开启 — 所有请求将使用本地能力处理（跳过 AI 模型）'
            : '本地模式已关闭 — 恢复 AI 模型调用');
          return next;
        });
        return true;
      }
      case 'fast': {
        setFastMode((on) => {
          const next = !on;
          if (next) {
            // Capture current settings, then apply the quick-response preset.
            fastSavedRef.current = { thinking: ai().isThinkingEnabled(), effort: ai().getEffort() };
            ai().setThinkingEnabled(false);
            ai().setEffort('low');
            notice('快速模式已开启 — 已关闭扩展思考并切换到低精度（更快响应）');
          } else {
            const saved = fastSavedRef.current || { thinking: false, effort: 'medium' };
            ai().setThinkingEnabled(saved.thinking);
            ai().setEffort(saved.effort);
            fastSavedRef.current = null;
            notice('快速模式已关闭 — 已恢复之前的思考与精度设置');
          }
          refreshFooter();
          return next;
        });
        return true;
      }
      case 'voice': {
        try {
          const voiceService = require('../../../services/voiceService');
          const settings = voiceService.getVoiceSettings();
          if (settings.enabled) {
            voiceService.setVoiceEnabled(false);
            voiceService.stopSpeaking();
            setVoiceMode(false);
            notice('语音模式已关闭');
          } else {
            const caps = voiceService.getCapabilities();
            voiceService.setVoiceEnabled(true);
            setVoiceMode(true);
            notice(`语音模式已开启 — TTS: ${caps.tts || 'none'} | STT: ${caps.stt || 'none'}`);
          }
        } catch (err) {
          notice(`语音服务异常：${err.message}`);
        }
        return true;
      }
      default:
        return false;
    }
  }, [query, refreshFooter]);

  // Route a slash command through the shared router, yielding the terminal to
  // any interactive handler. The committed <Static> region stays mounted so
  // scrollback is not reprinted; only the transient live UI is suspended.
  const runRouted = React.useCallback(async (text) => {
    const { parseInput, route } = require('../../router');
    const parsed = parseInput(text.trim());
    if (!parsed) return;

    // /clear · /new · /reset 对齐 CC:清后端历史 + 复位网关熔断 + 清可见 transcript +
    // 清屏 + 归零上下文占用。三者语义相同(REPL repl.js 一并处理:/new「新建会话(清空当前
    // 上下文)」·/reset「重置会话(同 /new)」)。此前 TUI 只 /clear 有特判且只清了可见
    // transcript 与屏幕,后端模型上下文(ai._messages)与已跳闸的网关熔断都残留 → 用户眼中
    // 「完全失效」(AI 仍记得全部对话);而 /new·/reset 连特判都没有,直接被当普通文本转发给
    // AI(比 /clear 更糟:零动作)。全 best-effort try/catch,任何一步失败都不影响清屏/transcript。
    if (parsed.command === 'clear' || parsed.command === 'new' || parsed.command === 'reset') {
      try { require('../../ai').clearHistory(); } catch { /* 清后端历史 best-effort */ }
      try {
        require('../../sessionClear').resetGatewayBreakerOnSessionClear(process.env);
      } catch { /* 复位熔断 best-effort */ }
      try { query.resetContext(); } catch { /* 归零页脚上下文占用 best-effort */ }
      query.setMessages([]);
      const app0 = inkRuntime.getApp();
      try { if (app0 && typeof app0.clear === 'function') app0.clear(); } catch { /* ignore */ }
      return;
    }

    // State-toggle flag commands (/thinking, /vim, /plan, /effort-*, …) are
    // handled in-process. route() returns false for most of them and would
    // otherwise forward the command to the AI as plain text.
    if (parsed.flag && handleFlag(parsed.flag)) return;

    // /rewind · /undo(无参)→ 打开原生 RewindPicker,与双 Esc 键流一致(共用
    // openRewindPicker → performRewind 管线)。此前无参 /rewind 落到 route()→handleRollback
    // 只在瞬态区打印一个纯文本回溯点列表(退化体验),而双 Esc 却给富交互原生选择器 —
    // 同一功能两套体验。带参形式(/rewind <n> 按序号直接回溯)仍走 route() 保留原语义。
    if ((parsed.command === 'rewind' || parsed.command === 'undo')
        && (!parsed.args || parsed.args.length === 0)
        && !parsed.subCommand) {
      try { openRewindPicker(); } catch { /* 打不开选择器则安全静默;不误发给 AI */ }
      return;
    }

    // /model (and /gateway model) — drive the native ModelPicker instead of the
    // inquirer-backed handler, which cannot share ink's managed input. We do NOT
    // release the live region here; the picker renders inside it.
    if (parsed.command === 'gateway'
        && (parsed.subCommand === 'model' || (parsed.args && parsed.args[0] === 'model'))) {
      await openModelPicker();
      return;
    }

    // /khyos (and /os) — open the native KHY OS kernel terminal overlay. The
    // view boots a KhyOsRunner and owns input until the user presses Esc. We do
    // NOT release the live region; the terminal renders inside it.
    if (parsed.command === 'khyos' || parsed.command === 'os') {
      setKhyosOpen(true);
      return;
    }

    // /topology (and /forest) 默认视图 — 原生挂 TopologyPanel 只读覆盖层(会话拓扑
    // 「森林」)。子命令(digest/synthesize/putInsight/putMemory/help)仍走下面的
    // route() → handlers/topology(打印表/做综合),只把无参的「看一眼这张网」截到
    // 原生面板,避免 route() 清屏路径把纯打印输出覆盖掉。算法/数据全经共享 SSOT
    // (sessionForestService.listForest → sessionTopology),面板只着色。fail-soft:
    // 取数异常 → 不拦截,落到 route() 文本树。
    if ((parsed.command === 'topology' || parsed.command === 'forest')
        && !parsed.subCommand
        && !(parsed.args && parsed.args.length)) {
      try {
        const forestSvc = require('../../../services/session/sessionForestService');
        const topoLeaf = require('../../sessionTopology');
        const { forest } = forestSvc.listForest({});
        const currentId = forestSvc.getCurrentSessionId();
        const degraded = !topoLeaf.topologyEnabled(process.env);
        setTopologyView({ forest, currentId, degraded });
        return;
      } catch { /* fall through to the text-tree handler */ }
    }

    // Auth commands (/login /register /passwd) use the native FormFlow overlay
    // instead of router.js's inquirer prompts; the form renders in-place.
    if (parsed.command === 'login' || parsed.command === 'register' || parsed.command === 'passwd') {
      await runAuthForm(parsed.command);
      return;
    }

    // /apikey (gateway config) — native overlays for the common paths (add key /
    // proxy). Advanced sub-trees route to a classic-mode notice from inside.
    if (parsed.command === 'gateway'
        && (parsed.subCommand === 'config' || (parsed.args && parsed.args[0] === 'config'))) {
      await runApiKeyConfig();
      return;
    }

    // Native async/interactive classic-REPL commands (parity, goal 2026-06-28
    // 「我只要使用 tui」): /worktree (隔离工作区·async), /review (代码审查·清屏区+
    // 原生确认), /rollback (检查点选择器). These do real local work in the classic
    // REPL; run them natively here instead of forwarding the literal command to the
    // AI or telling the user to drop to classic mode. Gated KHY_TUI_NATIVE_COMMANDS
    // (default on) → off falls through to the legacy silent-forward path.
    try {
      const reports = require('../tuiCommandReports');
      const c = parsed.command;
      if (reports.isEnabled() && (c === 'worktree' || c === 'review' || c === 'rollback')) {
        if (c === 'rollback') {
          openRollbackPicker();
          return;
        }
        if (c === 'worktree') {
          const argStr = Array.isArray(parsed.args) ? parsed.args.join(' ') : '';
          const lines = await reports.runWorktreeNative(argStr, {});
          query.setMessages((m) => [...m, { role: 'notice', content: lines.join('\n'), timestamp: Date.now() }]);
          return;
        }
        // /review — handleReview prints via console.log and collects its single
        // auto-fix confirm through the native uiPrompt/FormFlow bridge (because
        // KHY_INK_TUI_ACTIVE=1). Run it in a cleared transient region exactly like
        // the route() handlers below so the output is not clipped by the topic bar.
        const reviewApp = inkRuntime.getApp();
        setInputActive(false);
        try { topicBar.suspend(); } catch { /* best effort */ }
        await new Promise((r) => setTimeout(r, 16));
        try { if (reviewApp && typeof reviewApp.clear === 'function') reviewApp.clear(); } catch { /* ignore */ }
        try {
          const { handleReview } = require('../../handlers/review');
          await handleReview({});
        } catch (err) {
          query.setMessages((m) => [...m, { role: 'error', content: `代码审查失败: ${err && err.message ? err.message : String(err)}`, timestamp: Date.now() }]);
        } finally {
          setInputActive(true);
          try { topicBar.resume(); } catch { /* best effort */ }
        }
        return;
      }
    } catch { /* best-effort; fall through to existing dispatch */ }

    // Native non-interactive commands (classic-REPL parity): /scan /hardware
    // /checkpoint /intent /study /mind do real local work in the classic REPL but
    // were silently forwarded to the AI here. Run them via the SAME services the
    // REPL calls (cli/tui/tuiCommandReports) and render the report into the
    // transcript. Gated KHY_TUI_NATIVE_COMMANDS (default on) → off falls through.
    try {
      const { dispatchNativeCommand } = require('../tuiCommandReports');
      const native = dispatchNativeCommand(parsed, { cwd: process.env.KHYQUANT_CWD || process.cwd() });
      if (native.handled) {
        const content = (native.lines || []).join('\n') || '(无输出)';
        query.setMessages((m) => [...m, { role: 'notice', content, timestamp: Date.now() }]);
        return;
      }
    } catch { /* best-effort; fall through to existing dispatch */ }

    // Remaining inquirer-driven handlers cannot yet share ink's managed input.
    // Intercept them with a clear notice instead of letting inquirer fight ink
    // for stdin and force the whole TUI to exit (the "/model quits KHY" class).
    const unsupported = tuiUnsupportedReason(parsed);
    if (unsupported) {
      query.setMessages((m) => [...m, {
        role: 'notice',
        content: `「${unsupported}」暂需经典模式：请退出后用 KHY_FULL_TUI=0 khy 运行此命令。`,
        timestamp: Date.now(),
      }]);
      return;
    }

    const app = inkRuntime.getApp();
    setInputActive(false);
    // Hand the interactive sub-command a clean full-screen scroll region: drop
    // the pinned topic bar (块3) so its reserved row 1 / DECSTBM does not clip
    // inquirer-style prompts. Restored in finally.
    try { topicBar.suspend(); } catch { /* best effort */ }
    // Let React flush the suspended (empty live UI) frame before clearing, so
    // the handler starts from a clean transient region.
    await new Promise((r) => setTimeout(r, 16));
    try { if (app && typeof app.clear === 'function') app.clear(); } catch { /* ignore */ }

    let result;
    try {
      result = await route(parsed);
    } catch (err) {
      query.setMessages((m) => [...m, { role: 'error', content: err.message, timestamp: Date.now() }]);
    } finally {
      setInputActive(true);
      try { topicBar.resume(); } catch { /* best effort */ }
    }

    if (result === 'exit') { exit(); return; }
    // 命令跑完(可能是 /goal set/clear)→ 立即刷新页脚目标指示器,不等 30s 心跳。
    try { refreshGoalActive(); } catch { /* footer indicator refresh is best-effort */ }
    // /resume(= history resume)恢复了后端 ai._messages,但 route() 只返 true 无消息载荷 →
    // 复用启动 --resume 的同款机制(App.js:378-384)把已恢复的对话重放进可见 transcript,
    // 否则用户看到空屏而 AI 却"记得"全部对话(与旧 /clear 缺口同类的 UI↔后端不同步)。
    // bare-resume 返 {aiForward} 走下方分支自然回填,故仅在 result===true(完整恢复)时重放。
    if (result === true
        && (parsed.command === 'resume'
            || (parsed.command === 'history' && parsed.subCommand === 'resume'))) {
      try {
        const restored = buildResumedTranscript(require('../../ai').getConversation());
        if (restored.length > 0) query.setMessages(() => restored);
      } catch { /* 可见重放 best-effort;模型上下文已在 ai._messages */ }
    }
    // route() declined (unknown command / explicit AI forward) → send to AI.
    if (result === false || (result && result.aiForward)) {
      const aiInput = (result && result.aiForward) ? result.aiForward : text;
      query.submit(aiInput, { permissionMode, forceLocal: localMode });
    }
  }, [query, exit, permissionMode, handleFlag, openModelPicker, runAuthForm, runApiKeyConfig, localMode, refreshGoalActive]);

  // Run a `!`-prefixed line as a shell command, reusing the shared shellCommand
  // tool (same execution path / Windows patching the AI uses). The command and
  // its output are committed to the transcript; nothing is sent to the model.
  const runBash = React.useCallback(async (text) => {
    const command = text.replace(/^!\s*/, '').trim();
    if (!command) return;
    query.setMessages((m) => [...m, { role: 'bash-command', content: command, timestamp: Date.now() }]);

    let tool;
    try { tool = require('../../../tools/shellCommand'); } catch { tool = null; }
    if (!tool || typeof tool.execute !== 'function') {
      query.setMessages((m) => [...m, { role: 'error', content: 'shell 工具不可用', timestamp: Date.now() }]);
      return;
    }

    let res;
    let caught = null;
    try {
      res = await tool.execute({ command }, {});
    } catch (err) {
      caught = err;
      res = { success: false, error: err && err.message };
    }
    if (res && res.success) {
      query.setMessages((m) => [...m, { role: 'bash-output', content: res.output || '', timestamp: Date.now() }]);
    } else {
      // 红线：错误必须含真实原因 + 解决方向，绝不只是「命令执行失败」。
      let content;
      try {
        const { formatCliErrorLine } = require('../../cliErrorReporter');
        content = formatCliErrorLine(caught || res, { context: command, stderr: res && res.stderr });
      } catch {
        content = (res && res.error) || '命令执行失败（未能解析具体原因，请以 KHY_VERBOSE=1 重跑）';
      }
      query.setMessages((m) => [...m, { role: 'error', content, timestamp: Date.now() }]);
    }
  }, [query]);

  // Run a `#`-prefixed line as a quick instruction-file add (Claude Code `#`
  // behaviour): append it to khy.md's `## Memories` section via the SAME path as
  // the classic REPL (`#`) and `/remember` — instructionFileService.appendQuickMemory —
  // so the `#` entry has ONE consistent target across both front-ends. (Structured
  // personal memories go through SaveMemory / the proactive capture pipeline.)
  // The content is injection-scanned before write. Nothing is sent to the model.
  const runMemory = React.useCallback(async (text) => {
    const raw = text.replace(/^#+\s*/, '').trim();
    if (!raw) return;

    // `#g <note>` / `#global <note>` targets the user-global instruction file.
    let scope = 'project';
    let note = raw;
    const gm = raw.match(/^(g|global)\s+(.*)$/i);
    if (gm) { scope = 'global'; note = gm[2].trim(); }
    if (!note) return;

    let instr;
    try { instr = require('../../../services/instructionFileService'); } catch { instr = null; }
    if (!instr || typeof instr.appendQuickMemory !== 'function') {
      query.setMessages((m) => [...m, { role: 'error', content: '记忆设施不可用', timestamp: Date.now() }]);
      return;
    }

    try {
      const res = instr.appendQuickMemory(note, { scope });
      if (res && res.success) {
        const where = scope === 'global' ? '全局' : '项目';
        query.setMessages((m) => [...m, { role: 'notice', content: `已记入指令文件（${where}）：${res.file}${res.created ? ' (新建)' : ''}`, timestamp: Date.now() }]);
      } else {
        query.setMessages((m) => [...m, { role: 'error', content: '写入记忆失败：' + ((res && res.error) || '未知错误'), timestamp: Date.now() }]);
      }
    } catch (err) {
      query.setMessages((m) => [...m, { role: 'error', content: '写入记忆失败：' + err.message, timestamp: Date.now() }]);
    }
  }, [query]);

  // ── Plan mode (stage 3) ────────────────────────────────────────────────
  // No-op renderer so planModeService.executePlanSteps (which is written for the
  // readline REPL and writes step progress straight to stdout via a
  // TaskPlanTracker) does not leak into ink's managed frame. Progress is
  // surfaced through the onStepStart/onStepResult callbacks into the transcript.
  const makeStubRenderer = () => ({
    TaskPlanTracker: function StubTracker() {
      return { addTask() {}, render() {}, start() {}, complete() {}, fail() {} };
    },
    printStepLine: () => {},
    printStepDetail: () => {},
  });

  const restorePermissionDefault = React.useCallback(() => {
    setPermissionMode('default');
    applyPermissionMode('default');
  }, []);

  // Run the approved plan step-by-step. Each step's start and result is pushed
  // to the transcript; the model runs inside planModeService (bypassing the
  // query bridge), so its streaming is suppressed and only final replies show.
  const executePlan = React.useCallback(async (plan) => {
    const planModeService = require('../../../services/planModeService');
    const ai = require('../../ai');
    const notice = (content, role = 'notice') =>
      query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
    setPlanPhase('executing');

    // Seed the persistent task panel (above the input box) from the approved plan
    // so progress is visible Claude-Code-style, not just as scrolling notices.
    // executePlanSteps gets a stub renderer here (no stdout/_taskStore writes), so
    // we drive taskPanelState directly from the step callbacks. TaskListPanel merges
    // it and the nowTick heartbeat repaints. Gated by KHY_PLAN_TASK_PANEL (default on).
    const planPanelOn = process.env.KHY_PLAN_TASK_PANEL !== '0';
    const panelState = require('../../../services/taskPanelState');
    const idxByStepId = new Map();
    if (planPanelOn) {
      try {
        const activeSteps = (plan.steps || []).filter((s) => s.status !== 'skipped');
        panelState.setTasks(activeSteps.map((s) => ({ description: s.description, status: 'pending' })));
        activeSteps.forEach((s, i) => idxByStepId.set(s.id, i));
      } catch { /* best effort — panel is auxiliary */ }
    }

    try {
      const results = await planModeService.executePlanSteps(plan, {
        ai,
        renderer: makeStubRenderer(),
        onStepStart: ({ step, index, total }) => {
          if (planPanelOn) { try { panelState.updateTask(index, 'in_progress'); } catch { /* ignore */ } }
          notice(`▶ 第 ${step.id} 步（${index + 1}/${total}）：${step.description}`);
        },
        onStepResult: ({ step, result }) => {
          const ok = step.status === 'completed';
          if (planPanelOn) {
            try {
              const idx = idxByStepId.has(step.id) ? idxByStepId.get(step.id) : -1;
              if (idx >= 0) panelState.updateTask(idx, ok ? 'completed' : 'error');
            } catch { /* ignore */ }
          }
          notice(ok ? `✓ 第 ${step.id} 步完成` : `✗ 第 ${step.id} 步失败：${(result && result.error) || ''}`,
            ok ? 'notice' : 'error');
          if (result && result.reply) {
            notice(result.reply, 'assistant');
          }
        },
      });
      const okCount = results.filter((r) => r.step && r.step.status === 'completed').length;
      notice(`计划执行完成：${okCount}/${results.length} 步成功`);
    } catch (err) {
      notice('计划执行异常：' + (err.message || err), 'error');
    } finally {
      // Let the final ✓/✗ checklist linger briefly, then clear; nowTick drops the panel.
      if (planPanelOn) {
        setTimeout(() => { try { panelState.clearTasks(); } catch { /* ignore */ } }, 1500);
      }
      setPlanPhase(null);
      setCurrentPlan(null);
      setPlanGenText('');
      try { planModeService.reset(); } catch { /* ignore */ }
      restorePermissionDefault();
    }
  }, [query, restorePermissionDefault]);

  // Generate a plan from a plain request (driven on submit while in plan mode).
  const startPlan = React.useCallback(async (request) => {
    const planModeService = require('../../../services/planModeService');
    const ai = require('../../ai');
    query.setMessages((m) => [...m, { role: 'user', content: request, timestamp: Date.now() }]);
    setPlanGenText('');
    setCurrentPlan(null);
    setPlanPhase('generating');
    try {
      const res = await planModeService.enterPlanMode(request, ai, {
        onChunk: (chunk) => {
          if (chunk && chunk.type === 'text') {
            setPlanGenText((t) => t + (chunk.text || ''));
          }
        },
      });
      if (!res || res.errorType || !res.plan || !Array.isArray(res.plan.steps) || res.plan.steps.length === 0) {
        setPlanPhase(null);
        setPlanGenText('');
        query.setMessages((m) => [...m, {
          role: 'error',
          content: '计划生成失败：' + ((res && res.rawResponse) || '无有效计划，请重试或更具体地描述需求'),
          timestamp: Date.now(),
        }]);
        return;
      }
      setCurrentPlan(res.plan);
      setPlanPhase('reviewing');
    } catch (err) {
      setPlanPhase(null);
      setPlanGenText('');
      query.setMessages((m) => [...m, { role: 'error', content: '计划生成异常：' + (err.message || err), timestamp: Date.now() }]);
    }
  }, [query]);

  // CC 对齐计划模式:真·循环里模型调 ExitPlanMode(plan) 后经 bridge 回调至此——把编号计划串
  // 解析成 steps 进 reviewing 复用既有 PlanApproval + 批准语法 + executePlan。解析不出步骤时
  // 兜底成单步(至少可批准执行),绝不因空计划把用户卡死。executePlanSteps 不依赖 planModeService
  // 的 reviewing 内部态(它自置 executing),故这里只驱动 UI 态即可,fail-soft 绝不崩 Ink。
  const handleLoopExitPlan = React.useCallback((p) => {
    try {
      const planModeService = require('../../../services/planModeService');
      const raw = (p && typeof p.plan === 'string') ? p.plan : '';
      let plan = null;
      try { plan = planModeService.parsePlanFromResponse(raw); } catch { plan = null; }
      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        const desc = (raw.trim() || '按上述调研结论执行').slice(0, 100);
        plan = { steps: [{ id: 1, description: desc, status: 'pending', stepType: 'flexible', blocks: [], blockedBy: [] }] };
      }
      setPlanGenText('');
      setCurrentPlan(plan);
      setPlanPhase('reviewing');
    } catch { /* fail-soft:计划评审装配绝不崩 UI */ }
  }, []);
  React.useEffect(() => { planExitRef.current = handleLoopExitPlan; }, [handleLoopExitPlan]);

  // Parse a submitted line as a plan-approval command (mirrors the readline
  // presentForApproval grammar). Empty/y → approve+execute; n → cancel;
  // skip/edit/add → mutate the plan and keep reviewing; ? → show examples.
  const handlePlanCommand = React.useCallback((text) => {
    const planModeService = require('../../../services/planModeService');
    const trimmed = String(text || '').trim();
    const lower = trimmed.toLowerCase();
    const notice = (content) =>
      query.setMessages((m) => [...m, { role: 'notice', content, timestamp: Date.now() }]);

    if (!trimmed || ['y', 'yes', 'ok', '确认', '执行', '继续'].includes(lower)) {
      if (currentPlan) executePlan(currentPlan);
      return;
    }
    if (['n', 'no', '取消', 'abort', 'stop'].includes(lower)) {
      try { planModeService.reset(); } catch { /* ignore */ }
      setPlanPhase(null);
      setCurrentPlan(null);
      setPlanGenText('');
      restorePermissionDefault();
      notice('已取消计划');
      return;
    }
    if (lower === '?' || lower === 'help' || lower === 'h') {
      notice('示例：skip 2 · edit 1 新的步骤描述 · add after 2 新步骤 · n 取消');
      return;
    }

    if (!currentPlan) return;
    const plan = { ...currentPlan, steps: currentPlan.steps.map((s) => ({ ...s })) };
    const commands = trimmed.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    const applied = [];
    const invalid = [];
    for (const cmd of commands) {
      const skipMatch = cmd.match(/^(?:skip|跳过)\s+(\d+)$/i);
      const editMatch = cmd.match(/^(?:edit|修改)\s+(\d+)\s+(.+)$/i);
      const addMatch = cmd.match(/^(?:add|添加)\s+(?:after\s+)?(\d+)\s+(.+)$/i)
        || cmd.match(/^在\s*(\d+)\s*后(?:添加)?\s+(.+)$/i);
      if (skipMatch) {
        const idx = parseInt(skipMatch[1], 10) - 1;
        if (idx >= 0 && idx < plan.steps.length) { plan.steps[idx].status = 'skipped'; applied.push(`跳过 ${skipMatch[1]}`); }
        else invalid.push(cmd);
        continue;
      }
      if (editMatch) {
        const idx = parseInt(editMatch[1], 10) - 1;
        if (idx >= 0 && idx < plan.steps.length) { plan.steps[idx].description = editMatch[2].trim(); applied.push(`修改 ${editMatch[1]}`); }
        else invalid.push(cmd);
        continue;
      }
      if (addMatch) {
        const afterIdx = parseInt(addMatch[1], 10);
        if (!Number.isNaN(afterIdx) && afterIdx >= 0 && afterIdx <= plan.steps.length) {
          plan.steps.splice(afterIdx, 0, { id: afterIdx + 1, description: addMatch[2].trim(), status: 'pending', blocks: [], blockedBy: [] });
          plan.steps.forEach((s, i) => { s.id = i + 1; });
          applied.push(`在 ${addMatch[1]} 后新增`);
        } else invalid.push(cmd);
        continue;
      }
      invalid.push(cmd);
    }
    setCurrentPlan(plan);
    if (applied.length) notice('已更新计划：' + applied.join('、'));
    if (invalid.length) notice('未识别：' + invalid.join(' ; ') + '（Enter 确认 / skip N / edit N 描述 / add after N 描述 / n）');
  }, [currentPlan, executePlan, query, restorePermissionDefault]);

  const handleSubmit = React.useCallback((text) => {
    // Plan-mode approval grammar consumes every submit while reviewing.
    if (planPhase === 'reviewing') { handlePlanCommand(text); return; }
    // Generation/execution are busy phases: ignore stray submits.
    if (planPhase === 'generating' || planPhase === 'executing') return;
    if (!text || !text.trim()) {
      // Allow an image-only turn: Enter with attachments but no text sends the
      // images with a default prompt.
      if (pendingImages.length > 0) {
        const imgs = pendingImages;
        setPendingImages([]);
        query.submit('请描述这张图片', { permissionMode, images: imgs });
      }
      return;
    }
    const trimmed = text.trim();
    // `!`-prefixed input is the bash mode surface (Claude Code behaviour): run
    // the remainder as a shell command instead of routing or sending to the AI.
    if (trimmed.startsWith('!')) { runBash(trimmed); return; }
    // `#`-prefixed input is the memory mode surface: persist a memory note.
    if (trimmed.startsWith('#')) { runMemory(trimmed); return; }
    // Slash input is the command surface; everything else goes to the model.
    if (trimmed.startsWith('/')) { runRouted(text); return; }
    // Bare alias surface (classic-REPL parity): an explicit command shortcut as
    // the first token — e.g. `khyguanli`/`guanli`/`管理页` → gateway manage — is
    // dispatched through the router instead of being sent to the model. Only
    // ALIAS_MAP keys trigger this; plain prose still falls through to the AI
    // below, and runRouted forwards to the AI if route() ultimately declines.
    {
      const firstToken = trimmed.split(/\s+/)[0];
      let aliasHit = false;
      try { aliasHit = !!require('../../aliases').resolveAlias(firstToken); } catch { /* ignore */ }
      if (aliasHit) { runRouted(trimmed); return; }
    }
    // Natural-language model switch (classic-REPL parity): a plain prose line like
    // 「切换模型到 deepseek」/「switch model to deepseek」 is intercepted BEFORE it
    // reaches the model — it opens the SAME /model picker filtered to that vendor
    // (each provider/official = a distinct choice), or applies directly when the
    // named model uniquely matches. Via the pure leaf nlModelSwitchResolver (zero
    // IO, deterministic, three-gate zero-false-positive). Never throws; gated
    // KHY_NL_MODEL_SWITCH (default on) → off / non-match / require-fail falls
    // through to the model byte-for-byte.
    try {
      const nl = require('../../nlModelSwitchResolver');
      const hit = nl.resolve(trimmed, process.env);
      if (hit) { openModelPickerForVendor(hit.vendor, hit.model); return; }
    } catch { /* best-effort; fall through to the model */ }
    // Plan mode: a plain request generates an execution plan instead of a turn.
    if (permissionMode === 'plan') {
      // CC 对齐(KHY_PLAN_CC_RESEARCH):门开→计划提交走真·工具循环,先用只读工具调研、实时渲染
      // 工具调用(不弹「◴ 正在生成执行计划」大方框),模型调 ExitPlanMode(plan) 后经 onExitPlanMode
      // 进 reviewing。门关/异常→逐字节回退旧单次 startPlan(enterPlanMode)。submit 自身会入用户
      // 消息(bridge:1167),故此处不手动 setMessages。只读闸由 bridge 的 setTurnReadOnly 每轮把控。
      let _ccPlan = false;
      try { _ccPlan = require('../../../services/planModeDirective').isPlanResearchEnabled(process.env); } catch { _ccPlan = false; }
      if (_ccPlan) {
        query.submit(trimmed, { permissionMode: 'plan', forceLocal: localMode });
        return;
      }
      startPlan(trimmed);
      return;
    }
    let submitText = text;
    // /btw drain (classic-REPL parity, repl.js merge-into-next-turn): queued
    // non-interrupting hints (enqueued via router `/btw` → handlers/btw.js into the
    // shared process-level store conversation/btwNoteQueue) are merged into THIS
    // real turn's input via the SAME single source the REPL uses
    // (conversation/btwNote.mergeHints). Without this the TUI never drains the queue
    // and `/btw` notes would be silently lost. Never throws; gated KHY_BTW (default
    // on) → off leaves the queue untouched (router handler also no-ops when off).
    try {
      const btw = require('../../../services/conversation/btwNote');
      const btwQueue = require('../../../services/conversation/btwNoteQueue');
      if (btw.isEnabled(process.env) && btwQueue.count() > 0) {
        submitText = btw.mergeHints(submitText, btwQueue.drainAll());
      }
    } catch { /* best-effort; fall through to plain text */ }
    // @path file/dir mention → content injection (classic-REPL parity, repl.js:4940-5001):
    // `@file` expands to a `[File: …]` content block, `@dir` to a `[Directory: …]` tree,
    // and sensitive files (.env/id_rsa/*.key) are blocked — via the SAME single source the
    // classic REPL now delegates to (cli/atMentionInject). Without this the TUI's `@` only
    // autocompletes a path and the model sees the literal `@path`. Never throws; surfaces
    // blocked/read notices into the transcript. Gated KHY_AT_MENTION_INJECT (default on).
    try {
      const { resolveAtMentions } = require('../../atMentionInject');
      const at = resolveAtMentions(submitText);
      if (at.blocked && at.blocked.length > 0) {
        const notices = at.blocked.map((b) => ({
          type: 'notice',
          content: `安全：已拦截通过 @ 引用敏感文件 ${String(b).toLowerCase()}`,
          timestamp: Date.now(),
        }));
        query.setMessages((m) => [...m, ...notices]);
      }
      submitText = at.text;
    } catch { /* best-effort; fall through to plain text */ }
    // Inline image path → attachment (classic-REPL parity, repl.js:5003-5022):
    // a typed/pasted local image path (file:///…png, C:\…\shot.png, /path/img.jpg)
    // is extracted into an image attachment via the SAME single source the REPL
    // and the web channel use, so the model gets the pixels instead of the path as
    // plain text. Reuses cli/repl/imageIntent + imageService; never throws (failure
    // → original text, no image). Gated KHY_TUI_INLINE_IMAGE_PATH (default on).
    let inlineImages = [];
    try {
      const { resolveInlineImageSubmit } = require('../inlineImageSubmit');
      const r = resolveInlineImageSubmit(submitText);
      submitText = r.text;
      inlineImages = r.images || [];
    } catch { /* best-effort; fall through to plain text */ }
    // Normal AI turn — attach staged clipboard images + any inline-path image and
    // clear the buffer. The clipboard (pendingImages) and inline-path images merge
    // so a path typed alongside a pasted screenshot keeps both.
    const stagedImages = pendingImages.length > 0 ? pendingImages : [];
    const mergedImages = stagedImages.concat(inlineImages);
    if (mergedImages.length > 0) {
      if (stagedImages.length > 0) setPendingImages([]);
      query.submit(submitText, { permissionMode, images: mergedImages, forceLocal: localMode });
      return;
    }
    // Bare image-recognition intent with NO attached image (e.g. 裸「图片识别」): give it a
    // deterministic handling instead of falling into the agentic loop and globbing the disk.
    // clipboard-image → auto-use the clipboard image (Q1); no-image-reply → local notice, no
    // model call (Q2). Gated KHY_IMAGE_INTENT_GUARD (default on); off → byte fallback. Never throws.
    try {
      const { resolveImageRecognitionAssist } = require('../../repl/imageRecognitionIntent');
      const assist = resolveImageRecognitionAssist(submitText, { hasImages: false });
      if (assist && assist.handled) {
        if (assist.action === 'clipboard-image') {
          query.submit(assist.text, { permissionMode, images: assist.images, forceLocal: localMode });
          return;
        }
        if (assist.action === 'no-image-reply') {
          query.setMessages((m) => [...m, { role: 'notice', content: assist.reply, timestamp: Date.now() }]);
          return;
        }
      }
    } catch { /* best-effort; fall through to plain submit */ }
    query.submit(submitText, { permissionMode, forceLocal: localMode });
  }, [runBash, runMemory, runRouted, query, permissionMode, pendingImages,
      planPhase, handlePlanCommand, startPlan, localMode, openModelPickerForVendor]);

  const textInput = useVimInput({
    onSubmit: handleSubmit,
    enabled: vimEnabled,
    onModeChange: setVimMode,
  });
  const { value, offset } = textInput;

  // ── Conversation+code rewind (double-ESC, Claude Code alignment) ───────
  // Declared here (after `textInput`) so the callbacks can reference it without
  // hitting a temporal-dead-zone error: a useCallback dependency array is read
  // eagerly during render, so referencing `textInput` above its `const`
  // declaration crashed the whole Ink mount on every startup.
  // Phase 1: rewind to the most recent user turn (no picker). Delegates the
  // model-history + code-restore work to the bridge's query.rewind(), then
  // truncates the UI transcript and reloads the recalled text into the box for
  // editing/resend. Fail-soft: a missing/empty target or a bridge that predates
  // rewind() just hints and leaves everything untouched.
  const performRewind = React.useCallback((preselected, scope) => {
    const target = preselected || rewindControl.selectLastUserTarget(query.messages);
    if (!target) { showHint('无可回溯的对话'); return; }
    if (typeof query.rewind !== 'function') { showHint('回溯不可用'); return; }
    let res;
    try { res = query.rewind(target, scope); } catch { res = null; }
    if (!res || !res.success) { showHint('回溯失败'); return; }
    // Code-only scope keeps the conversation intact: skip the transcript truncation
    // and text reload, and surface a code-only notice. Every other scope (both /
    // conversation / gate-off) rewinds the conversation exactly as before.
    const conversationRewound = res.conversationRewound !== false;
    if (conversationRewound) {
      query.setMessages((m) => m.slice(0, target.idx));
      textInput.setText(String(target.content || ''));
    }
    // Notice routes through the rewindNotice leaf so a code rewind surfaces the
    // diff-stat it rolled back (CC parity). Gate off / no stat / require failure →
    // the plain legacy notices, byte-identical to before.
    let _notice;
    if (res.summarized) {
      // Summarize-from-here: transcript is intentionally NOT truncated (model
      // context was collapsed, visible scrollback stays). A durable notice makes
      // the divergence explicit rather than an ephemeral hint.
      const n = Number(res.summarizedCount) || 0;
      const summaryNotice = `已把此处及之后的 ${n} 条对话压缩为摘要（模型上下文已更新，界面记录保留）`;
      try {
        query.setMessages((m) => [...m, { role: 'notice', content: summaryNotice, timestamp: Date.now() }]);
      } catch { /* fail-soft: fall back to the hint below */ }
      _notice = summaryNotice;
    } else if (!conversationRewound) {
      // Code-only: conversation preserved.
      let stat = '';
      if (res.codeDiffStats) stat = `（+${res.codeDiffStats.additions}/-${res.codeDiffStats.deletions} 行）`;
      _notice = res.codeRestored ? `已恢复代码${stat},对话保留` : '代码检查点不可用,未改动';
    } else {
      try {
        _notice = require('../../rewindNotice').buildRewindNotice(
          { codeRestored: res.codeRestored, stats: res.codeDiffStats }, process.env);
      } catch {
        _notice = res.codeRestored
          ? '已回溯对话与代码，可编辑后重发'
          : '已回溯对话（代码检查点不可用），可编辑后重发';
      }
    }
    showHint(_notice);
  }, [query, textInput, showHint]);

  // Phase 2: open the RewindPicker so the user chooses *which* earlier user turn
  // to rewind to (not just the last). Builds the newest-first target list from
  // the single-source leaf; an empty history just hints. Selection routes back
  // through performRewind, so both phases share one rewind pipeline.
  const openRewindPicker = React.useCallback(() => {
    let targets = [];
    try { targets = rewindControl.listUserTargets(query.messages); } catch { targets = []; }
    if (!targets || targets.length === 0) { showHint('无可回溯的对话'); return; }
    // One turn only → skip the overlay; Phase-1 semantics with no extra keystroke.
    if (targets.length === 1) { performRewind(targets[0]); return; }
    setRewindPicker({ targets });
  }, [query, showHint, performRewind]);

  const resolveRewindPicker = React.useCallback((target, scope) => {
    setRewindPicker(null);
    if (target) performRewind(target, scope);
  }, [performRewind]);

  // ── Native /rollback checkpoint picker (parity repl.js:3951-3975) ──────────
  // List recent checkpoints via the SAME checkpointService the classic REPL uses,
  // shape them into RewindPicker targets, and on selection restore the chosen
  // checkpoint. Empty history → honest notice (no overlay).
  const openRollbackPicker = React.useCallback(() => {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    let list = [];
    try { list = require('../../../services/workspace/checkpointService').listCheckpoints(cwd) || []; } catch { list = []; }
    if (!list.length) {
      query.setMessages((m) => [...m, { role: 'notice', content: '没有可用的检查点。用 /checkpoint 手动保存，或等待 AI 对话自动保存。', timestamp: Date.now() }]);
      return;
    }
    const recent = list.slice(-10).reverse();
    const targets = recent.map((ck) => {
      let when = '';
      try { when = new Date(ck.timestamp).toLocaleString(); } catch { when = ''; }
      return {
        id: ck.id,
        checkpointId: ck.id,
        preview: `${ck.id}  ${ck.mode}  ${when}  ${String(ck.message || '').slice(0, 40)}`,
      };
    });
    setRollbackPicker({ targets, cwd });
  }, [query]);

  const resolveRollbackPicker = React.useCallback((target) => {
    setRollbackPicker((cur) => {
      const cwd = (cur && cur.cwd) || process.env.KHYQUANT_CWD || process.cwd();
      if (target && target.id) {
        try {
          require('../../../services/workspace/checkpointService').restoreCheckpoint(cwd, target.id);
          query.setMessages((m) => [...m, { role: 'notice', content: `已回滚到检查点: ${target.id}`, timestamp: Date.now() }]);
        } catch (e) {
          query.setMessages((m) => [...m, { role: 'error', content: `回滚失败: ${e && e.message ? e.message : String(e)}`, timestamp: Date.now() }]);
        }
      }
      return null;
    });
  }, [query]);

  const completionRaw = useCompletions(value, offset);
  const completion = completionRaw.active && dismissedFor !== value ? completionRaw : { active: false, items: [] };

  // Reset menu selection whenever the candidate list changes.
  React.useEffect(() => { setSelectedIndex(0); }, [value, offset]);

  // Keep the footer truthful: refresh on mount, whenever the adapter reports new
  // status (model/window resolved asynchronously after gateway init), and once a
  // turn settles to idle/done (the active model + real context window are
  // guaranteed resolved by then). Cheap — it only reads getters.
  React.useEffect(() => {
    refreshFooter();
  }, [refreshFooter, query.adapterInfo, query.status === 'idle' || query.status === 'done']);

  const busy = query.status !== 'idle' && query.status !== 'done';
  // True while a user-selection overlay owns the screen (AskUserQuestion /
  // permission prompt / model picker / form flow). Used to freeze the ambient
  // spinner: its 80ms tick otherwise repaints the whole live region ~12x/second
  // underneath the overlay, which the terminal shows as flicker. A "thinking"
  // spinner is also misleading here — we are blocked waiting for the user, not
  // computing. The spinner returns automatically once the choice resolves.
  const awaitingUserChoice = !!query.controlRequest || !!modelPicker || !!formFlow || khyosOpen;

  // ── Resize handling (缩放时的线条残留) ──────────────────────────────────
  // On terminal resize/zoom the emulator reflows wrapped lines, but two things
  // go stale: (1) our terminal-capability cache still holds the PRE-resize
  // columns/rows — `invalidateCache()` existed for exactly this but was never
  // wired to the resize event, so capability-gated layout kept using old sizes;
  // (2) the live region needs a clean repaint at the new width. We debounce so a
  // drag-resize fires this once on settle rather than on every reflow tick, then
  // refresh the cache and nudge a re-render so the live region is laid out
  // against the correct, freshly-read dimensions.
  //
  // NOTE: Ink's own incremental eraser keys off LOGICAL line count, not visual
  // rows after reflow, so a perfectly residue-free repaint would require Ink's
  // internal overflow branch — unreachable from outside the package (its
  // instance is walled off by the `exports` map) without forking the dependency.
  // This handler is the safe mitigation that does not risk transcript
  // duplication or breaking an in-flight stream.
  const [resizeNonce, setResizeNonce] = React.useState(0);
  const resizeTimer = React.useRef(null);
  React.useEffect(() => {
    const onResize = () => {
      clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        try { require('../runtime/terminalCapabilities').invalidateCache(); } catch { /* best effort */ }
        // Harmless re-render nudge: forces a layout pass at the settled width.
        setResizeNonce((n) => (n + 1) % 1000000);
      }, 120);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
      clearTimeout(resizeTimer.current);
    };
  }, []);
  // resizeNonce schedules a React commit so width-baking children (e.g.
  // PromptFrame's full-row border, read from process.stdout.columns) re-render
  // against the refreshed dimensions on settle.
  void resizeNonce;

  // After that settled-resize commit lands, resync ink's renderer so a reflow
  // never leaves residue ("残线") or STACKS the live region. The direction of the
  // width change decides how expensive the resync has to be:
  //
  //   • Width DECREASE (zoom-in): lines painted at the old, wider width now
  //     exceed the narrower one, so the terminal re-wraps already-printed text.
  //     log-update's logical line count then under-erases — worst on tall
  //     streaming content (e.g. the plan "正在生成执行计划…" block) — and several
  //     zooms pile copies down the screen. Only a hard clear is safe here, so we
  //     drive ink's OWN fullscreen branch: pre-setting `lastOutputHeight >= rows`
  //     makes onRender() emit `clearTerminal + fullStaticOutput + output` then
  //     `log.sync()` — one clean frame, accumulation-proof. This re-emits the
  //     transcript, so we pay it ONLY on shrink.
  //
  //   • Width INCREASE (zoom-out) or unchanged: old lines still fit the wider
  //     width, nothing re-wraps, the old frame keeps its row count — a cheap
  //     incremental resync (mirror ink's shrink-branch minus clearTerminal)
  //     erases exactly the right amount with NO transcript redraw.
  //
  // Best-effort throughout: if the internal instance is unavailable we fall back
  // to ink's built-in repaint.
  const _resizeFirstCommit = React.useRef(true);
  const _resizePrevCols = React.useRef(process.stdout.columns || 80);
  React.useEffect(() => {
    if (_resizeFirstCommit.current) {
      _resizeFirstCommit.current = false;
      _resizePrevCols.current = process.stdout.columns || _resizePrevCols.current;
      return;
    }
    let inst = null;
    try { inst = inkRuntime.getInkInstance(); } catch { inst = null; }
    const out = inst && inst.options && inst.options.stdout;
    const curCols = (out && Number(out.columns)) || process.stdout.columns || _resizePrevCols.current;
    const prevCols = _resizePrevCols.current;
    _resizePrevCols.current = curCols;
    if (!inst || typeof inst.onRender !== 'function') return;
    // Coalesce the repaint's writes into ONE stdout flush. ink's onRender emits
    // the frame as many separate process.stdout.write calls; on Windows each is a
    // blocking WriteConsole syscall, so a full-transcript shrink repaint becomes a
    // write storm that visibly freezes the terminal. syncWrite buffers every write
    // inside the frame and flushes a single chunk (and adds DEC-2026 markers where
    // supported). Best-effort: if syncOutput is unavailable, run the repaint bare.
    let _sync = null;
    try { _sync = require('../../syncOutput'); } catch { _sync = null; }
    const _repaint = () => {
      const rows = out ? Number(out.rows) : NaN;
      const shrunk = curCols < prevCols;
      const grew = curCols > prevCols;
      // 输出层软 bug 主动监听(goal 2026-06-25):缩放丢行/残线规避。列宽任一方向变化(缩小
      // OR 放大)都会让终端 reflow 已印行,使 ink/log-update 行计数失真 → 增量重绘残线;放大
      // (zoom-out)方向 ink 本就跳过 resync,残线尤重(用户报「放大缩小后刷屏」)。改由
      // outputIntegrityMonitor 决策:两个方向都强制全屏重绘;rows 测不出时用兜底 rows 仍全屏
      // 重绘并记错误日志。fail-soft:监听器缺失回退原判定(此时也覆盖放大方向)。
      let _decision = null;
      try {
        _decision = require('../../../services/outputIntegrityMonitor').assessResize({
          prevCols, curCols, rows, isTTY: !!(out && out.isTTY),
          fallbackRows: process.stdout.rows || 24, source: 'tui-resize',
        });
      } catch { _decision = null; }
      const _fullRepaint = _decision
        ? _decision.action === 'full-repaint'
        : ((shrunk || grew) && out && out.isTTY && Number.isFinite(rows) && rows > 0);
      if (_fullRepaint) {
        // Zoom-in / shrink: force the fullscreen branch (hard clear + transcript
        // + live + log.sync). Heavy, but only on the direction that stacks.
        inst.lastOutputHeight = _decision ? _decision.rows : rows;
        if (typeof inst.calculateLayout === 'function') inst.calculateLayout();
        inst.onRender();
      } else {
        // Zoom-out / unchanged / non-TTY: light incremental resync, no redraw of
        // the transcript. Old lines still fit, so this erases exactly right.
        if (inst.log && typeof inst.log.clear === 'function') inst.log.clear();
        inst.lastOutput = '';
        inst.lastOutputToRender = '';
        if (typeof inst.calculateLayout === 'function') inst.calculateLayout();
        inst.onRender();
      }
    };
    try {
      if (_sync && typeof _sync.syncWrite === 'function') _sync.syncWrite(_repaint);
      else _repaint();
    } catch { /* best effort — ink's built-in repaint still applies */ }
  }, [resizeNonce]);

  // ── Measurement-feedback height clamp (KHY_LIVE_HEIGHT_CLAMP 默认开) ──────────
  // resolveStreamReserve 是前馈预测,无法准确预知数据相关的工具/兄弟面板真实高度,故 live 区
  // 会间歇性触顶 → ink 全屏清屏(clearTerminal 含 `\x1b[3J`)→ 视图被拽回顶、滚不到中间。
  // 此钳制在每次提交后读 ink 实测的 `lastOutputHeight`(即 ink 决策全屏清屏所用的同一高度),
  // 若 live 区超顶就抬高 extraReserve → StreamingBlock 正文预览下一帧收缩 → live < rows →
  // ink 停止「每帧全屏重绘」→ 生成中滚轮可稳停中间态(对齐 CC)。
  //
  // 用 useLayoutEffect(非 useEffect):ink 处 legacy sync 渲染,提交阶段 resetAfterCommit
  // (ink 在此 onRender 绘制并写 lastOutputHeight)先于 commitLayoutEffects,故 useLayoutEffect
  // 同步读到刚绘制的真实高度,修正提交排在下一次可见绘制前=过冲最小。无依赖数组:每次提交采样;
  // 终止由叶子的单调非降 + 下方 `next !== extraReserve` 相等守卫保证(非依赖数组)。
  // 每轮边界(turnKey 变化 / streaming→null)复位 extraReserve=0,回到前馈种子。
  // 关键细节:若新轮本就以 extraReserve=0 开始,必须**允许首帧立即采样**。历史这里无条件
  // `return` 跳过首帧,最容易超顶的第一帧(首条消息/首个工具批)恰好失去钳制窗口;Windows 上
  // ink fullscreen 重刷会把这一帧整批刷进 scrollback,用户看到「第一条消息出现几份一模
  // 一样的输入/输出」。只有在确实要先清零旧轮残留 reserve(extraReserve!==0)时才应跳过本帧。
  // Best-effort:_liveBudget 缺失 / getInkInstance 返 null / 非 TTY → no-op,ink 内建行为不变。
  React.useLayoutEffect(() => {
    if (!_liveBudget || typeof _liveBudget.resolveExtraReserve !== 'function') return;
    const turnKey = query.streaming ? (query.turnStartedAt || 0) : null;
    const _boundary = _liveClampBoundaryDecision(_extraTurnKey.current, turnKey, extraReserve);
    if (_boundary.changed) _extraTurnKey.current = turnKey;
    if (_boundary.reset) {
      setExtraReserve(0); // 新轮 / 轮结束且旧 reserve 非 0 → 先复位,下一帧再采样
      return;
    }
    if (!_boundary.sample || !query.streaming) return; // 仅生成中钳制; idle/复位态不采样
    let inst = null;
    try { inst = inkRuntime.getInkInstance(); } catch { inst = null; }
    const out = inst && inst.options && inst.options.stdout;
    if (!out || !out.isTTY) return; // 非 TTY 永不 fullscreen
    let next = extraReserve;
    try {
      next = _liveBudget.resolveExtraReserve({
        lastOutputHeight: Number(inst.lastOutputHeight),
        rows: Number(out.rows),
        prevExtra: extraReserve,
      }, process.env);
    } catch { next = extraReserve; }
    if (next !== extraReserve) setExtraReserve(next); // 相等守卫防渲染循环
  });

  // ── Topic bar (块3) ────────────────────────────────────────────────────────
  // A pinned row-1 header showing the CURRENT conversation topic, driven by raw
  // ANSI outside the Ink tree (see runtime/topicBar.js). When the terminal can't
  // host it (legacy conhost / not a TTY / KHY_NO_TOPIC_BAR), `topicBarOn` stays
  // false and the topic is shown in the FooterBar instead.
  const topic = useTopic(query.messages);
  const [topicBarOn, setTopicBarOn] = React.useState(false);
  React.useEffect(() => {
    let on = false;
    try { on = topicBar.enable(); } catch { on = false; }
    setTopicBarOn(on);
    return () => { try { topicBar.disable(); } catch { /* terminal gone */ } };
  }, []);
  // Auto-close the shell peek panel when the turn ends (块4): its data source is
  // the live streaming state, which clears on finalize — keep the panel scoped
  // to EXECUTING so it never lingers showing an empty/stale tool.
  React.useEffect(() => {
    if (!busy && shellViewOpen) { setShellViewOpen(false); setShellScroll(0); }
  }, [busy, shellViewOpen]);

  // Push topic changes to the pinned bar (coarse instantly, AI-refined in place).
  React.useEffect(() => {
    if (!topicBarOn) return;
    try { topicBar.setTitle(topic); } catch { /* best effort */ }
  }, [topic, topicBarOn]);
  // Animate the title glyph while khy is working: idle → static ✱ ("太阳"),
  // busy → left-right bouncing dot. Gated in the leaf (KHY_TOPIC_BAR_WORKING_DOT);
  // off → setWorking is a no-op and the glyph stays the static ✱.
  React.useEffect(() => {
    if (!topicBarOn) return;
    try { topicBar.setWorking(busy); } catch { /* best effort */ }
  }, [busy, topicBarOn]);
  // Repaint the pinned bar after a settled resize, alongside the cache refresh.
  React.useEffect(() => {
    if (!topicBarOn) return;
    try { topicBar.onResize(); } catch { /* best effort */ }
  }, [resizeNonce, topicBarOn]);

  // Prompt input modes (Claude Code behaviour): `!` → bash, `#` → memory.
  const bashMode = value.startsWith('!');
  const memoryMode = value.startsWith('#');
  // Per-session accent (/color, aligns with Claude Code /color): mode colors win,
  // otherwise fall back to the session's stored color (default cyan). The leaf
  // gates on KHY_SESSION_COLOR — off → ignores sessionColor → byte-identical null.
  const accent = _sessionColorLeaf.resolveAccent({
    bashMode,
    memoryMode,
    sessionColor: _sessionColorState.getSessionColor(),
    env: process.env,
  });

  useInput((input, key) => {
    // 0) Model picker overlay owns input while mounted (its own useInput drives
    //    navigation/selection); yield so there is no double-handling.
    if (modelPicker) return;
    // 0a2) Rewind picker overlay (Phase 2 double-ESC 回溯) owns input while mounted.
    if (rewindPicker) return;
    // 0a3) Rollback checkpoint picker (/rollback) likewise owns input while mounted.
    if (rollbackPicker) return;
    // 0b) FormFlow overlay (/login, /register, /passwd) likewise owns input.
    if (formFlow) return;
    // 0c) KHY OS kernel terminal overlay owns input (its own useInput sends
    //     keystrokes to the kernel serial port; Esc there closes the view).
    if (khyosOpen) return;
    // 0d) 会话拓扑只读面板(/topology view)挂载时:任意 Esc/Enter 关闭并归还输入。
    //     面板只读、不导航,故在此直接消费关闭键即可,其余键一律吞掉防穿透。
    if (topologyView) {
      if (key.escape || key.return) setTopologyView(null);
      return;
    }

    // 1) Permission prompt has top priority. Both QuestionPrompt and
    //    PermissionsPrompt own their own useInput (arrow-key navigation) and are
    //    mounted only while their request is pending, so we just yield here and
    //    let the overlay consume the key — no y/n/a handling in the parent.
    if (query.controlRequest) {
      return;
    }

    // 1a) Reverse-incremental history search (Ctrl+R) owns all input while
    //     active — mirrors the completion.active intercept. All decisions come
    //     from the pure leaf historyReverseSearch; this shell only maps keys to
    //     leaf calls and moves text into/out of the buffer.
    if (revSearch) {
      const hist = (textInput.getHistory && textInput.getHistory()) || [];
      // Esc / Ctrl+C / Ctrl+G → cancel, leave the input buffer untouched.
      if (key.escape || (key.ctrl && (input === 'c' || input === 'g'))) {
        setRevSearch(null);
        return;
      }
      // Ctrl+R again → advance to the next (older) match; no wrap.
      if (key.ctrl && input === 'r') {
        try { setRevSearch(_revSearch.nextMatch(hist, revSearch)); } catch { setRevSearch(null); }
        return;
      }
      // Enter / Tab → accept the current match into the input buffer, close.
      if (key.return || key.tab) {
        const chosen = revSearch.current || '';
        setRevSearch(null);
        if (chosen) textInput.setText(chosen, chosen.length);
        return;
      }
      // Arrow keys → CC behaviour: accept current into buffer, close, then let
      // the arrow move the cursor on the next tick (here we just accept + close).
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        const chosen = revSearch.current || '';
        setRevSearch(null);
        if (chosen) textInput.setText(chosen, chosen.length);
        return;
      }
      // Backspace / Delete → trim one char off the query and re-search.
      if (key.backspace || key.delete) {
        const q = String(revSearch.query || '').slice(0, -1);
        try { setRevSearch(_revSearch.search(hist, q)); } catch { setRevSearch(null); }
        return;
      }
      // Printable char (no ctrl/meta) → append to query and re-search.
      if (input && !key.ctrl && !key.meta) {
        const q = String(revSearch.query || '') + input;
        try { setRevSearch(_revSearch.search(hist, q)); } catch { setRevSearch(null); }
        return;
      }
      // Any other key while active → swallow so it can't leak to the buffer.
      return;
    }


    //    a double-press exit — the first press also clears any pending input and
    //    arms the timer; a second press within the window exits.
    if (key.ctrl && input === 'c') {
      // Claude Code semantics: while a turn runs, Ctrl-C only cancels it — it does
      // NOT arm the exit timer. abort() flips status to a terminal state within a
      // tick, so the *next* Ctrl-C is evaluated as idle and starts a fresh
      // double-press-to-exit (and Ctrl-D double-press still exits a hung idle
      // line). This stops an accidental second press from killing the process
      // mid-task. When idle it is the plain double-press exit.
      if (busy) {
        query.clearQueue();
        query.abort();
        showHint('已中断当前轮次');
        return; // note: do NOT touch ctrlCAt.current — no exit-arming while busy
      }
      const now = Date.now();
      if (now - ctrlCAt.current < DOUBLE_PRESS_MS) { exit(); return; }
      ctrlCAt.current = now;
      if (value) textInput.clear();
      showHint('再按一次 Ctrl-C 退出');
      return;
    }
    // Ctrl+D (CC chord): forward-delete when the line has text; on an empty
    // line, double-press exits.
    if (key.ctrl && input === 'd') {
      if (value) { textInput.onInput(input, key); return; }
      const now = Date.now();
      if (now - ctrlDAt.current < DOUBLE_PRESS_MS) { exit(); return; }
      ctrlDAt.current = now;
      showHint('再按一次 Ctrl-D 退出');
      return;
    }
    // Ctrl+L: clear committed transcript.
    if (key.ctrl && input === 'l') { query.setMessages([]); return; }
    // Image paste (stage a clipboard image for the next turn). Windows binds
    // Alt+V because Ctrl+V is the terminal's own paste there (conhost / Windows
    // Terminal) and never reaches the app; other platforms keep Ctrl+V (their
    // terminal paste is Ctrl+Shift+V). In ink, Alt+V arrives as key.meta + 'v'.
    if (input === 'v' && (process.platform === 'win32' ? key.meta : key.ctrl)) {
      attachClipboardImage();
      return;
    }
    // Ctrl+O: expand/collapse process groups + tool output.
    if (key.ctrl && input === 'o') {
      // While a turn is live-streaming, the process group / thinking lives in the
      // dynamic StreamingBlock, which re-renders on prop change — toggle the
      // global flag so it expands/collapses in place.
      if (query.streaming) {
        setExpanded((v) => {
          const next = !v;
          showHint(next ? '过程组：已展开（显示工具详情）' : '过程组：已折叠');
          return next;
        });
        return;
      }
      // Otherwise the foldable detail has already committed into Ink's <Static>,
      // which never re-renders printed items — so toggling `expanded` is a no-op
      // for it (this was the "Ctrl+O 失效" report). Append a one-shot expanded
      // copy of the most recent foldable turn below the transcript instead.
      const appended = query.expandLastFoldable();
      showHint(appended ? '已在下方展开上一步详情' : '暂无可展开的折叠内容');
      return;
    }
    // Shift+Tab: cycle permission mode and push it to the real tool gate.
    if (key.tab && key.shift) {
      setPermissionMode((m) => {
        const next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(m) + 1) % PERMISSION_MODES.length];
        applyPermissionMode(next);
        showHint(`权限模式：${next}`);
        return next;
      });
      return;
    }

    // CC-aligned chat/global chords (meta+p/o/t, ctrl+t). The pure leaf decides
    // key→action; the dispatch here runs the matching existing feature. Placed
    // after Shift+Tab and the dedicated ctrl chords above so those keep priority.
    // Gate off / leaf missing → resolveChatChord is null → fall through to input.
    if (_chatChords) {
      let _chord = null;
      try { _chord = _chatChords.resolveChatChord({ key, input }, process.env); } catch { _chord = null; }
      if (_chord === 'modelPicker') {
        if (busy) { showHint('忙碌中：请等当前轮次结束再切模型'); return; }
        openModelPicker();
        return;
      }
      if (_chord === 'fastMode') { handleFlag('fast'); return; }
      if (_chord === 'thinkingToggle') { handleFlag('thinking'); return; }
      if (_chord === 'toggleTasks') {
        setTasksHidden((v) => {
          const next = !v;
          showHint(next ? '任务清单：已隐藏（Ctrl+T 再显示）' : '任务清单：已显示');
          return next;
        });
        return;
      }
    }

    // Ctrl+R: open reverse-incremental history search (CC parity). Only when
    // idle and the gate is on; otherwise fall through so the key is unchanged.
    // Initialises with an empty query (awaits typing, like bash reverse-i-search).
    if (key.ctrl && input === 'r' && _revSearch && _revSearch.isEnabled(process.env)) {
      const hist = (textInput.getHistory && textInput.getHistory()) || [];
      try { setRevSearch(_revSearch.search(hist, '')); } catch { setRevSearch(null); }
      return;
    }

    // 3) Completion menu navigation (when open).
    if (completion.active) {
      if (key.upArrow) { setSelectedIndex((i) => (i - 1 + completion.items.length) % completion.items.length); return; }
      if (key.downArrow) { setSelectedIndex((i) => (i + 1) % completion.items.length); return; }
      // Tab → complete the highlighted item into the buffer (keep editing).
      if (key.tab) {
        const item = completion.items[selectedIndex] || completion.items[0];
        const { text, offset: off } = applyCompletion(value, completion, item);
        textInput.setText(text, off);
        setDismissedFor(null);
        return;
      }
      // Enter → for a slash command, run the highlighted command immediately
      // (Claude Code behaviour). For a file completion, accept into the buffer
      // and keep editing so the user can add more.
      if (key.return) {
        const item = completion.items[selectedIndex] || completion.items[0];
        if (completion.kind === 'slash') {
          textInput.setText('', 0);
          setDismissedFor(null);
          handleSubmit(item.value);
          return;
        }
        const { text, offset: off } = applyCompletion(value, completion, item);
        textInput.setText(text, off);
        setDismissedFor(null);
        return;
      }
      if (key.escape) { setDismissedFor(value); return; }
      // any other key falls through to editing (and recomputes the menu)
    }

    // 4) Help overlay: "?" on an empty prompt toggles it.
    if (!completion.active && input === '?' && value === '') { setShowHelp((v) => !v); return; }
    if (showHelp && key.escape) { setShowHelp(false); return; }

    // 4.4) Esc while reviewing a plan cancels it (mirrors the `n` command).
    if (key.escape && planPhase === 'reviewing') { handlePlanCommand('n'); return; }

    // 4.5) Esc (CC chat:cancel): a running turn is interrupted first so the user
    //      can always stop Claude. When idle, Esc clears the input line on a
    //      double-press ("Esc again to clear"), saving it to history.
    if (key.escape) {
      if (busy) {
        // CC-like graduated interrupt that never loses or auto-sends an unsent
        // message. A queued message hasn't reached the model yet, so it must go
        // back to the input box rather than being dropped — and it must never be
        // resurrected by the turn's abort/drain (the catch path calls drainNext,
        // which would otherwise send it). So while anything is still queued, Esc
        // returns the most recent unsent message to the (empty) input box and
        // clears the rest; only once nothing is left to recover does the next
        // Esc abort the in-flight turn itself.
        if (query.queueLen > 0) {
          if (value === '') {
            const item = query.dequeueLast();
            if (item) {
              query.clearQueue();
              textInput.setText(item.text);
              showHint('已取回未发送消息到输入框，可编辑后重发');
              return;
            }
          }
          // The box already holds a draft — keep it intact, just clear the queue
          // so the abort below can't auto-send the unsent messages.
          query.clearQueue();
          showHint('已清空排队消息（输入框草稿已保留）');
          return;
        }
        query.abort();
        // 对齐 CC 中断后 `What should Claude do instead?`:补一条「想让 khy 做什么
        // 替代?」引导。文案+门控住在 interruptHint 叶子;门关/异常→回退旧「已中断」。
        showHint(interruptHint.buildPostInterruptHint());
        return;
      }
      // Idle Esc: a single source (rewindControl.decideEscIdle) reconciles the
      // two double-press semantics — the draft-clear affordance and the
      // Claude-Code-style double-ESC rewind — so they never collide. Vim still
      // owns Esc; staged images still drop first; rewind never hijacks a draft.
      const verdict = rewindControl.decideEscIdle({
        vimEnabled,
        pendingImagesLen: pendingImages.length,
        value,
        withinWindow: (Date.now() - escAt.current) < DOUBLE_PRESS_MS,
        rewindEnabled: rewindControl.isRewindEnabled(),
      });
      switch (verdict) {
        case 'vim': textInput.onInput(input, key); return;
        case 'drop-images': setPendingImages([]); showHint('已清除附加图片'); return;
        case 'clear-input': textInput.clear(); setHint(''); return;
        case 'arm-clear': escAt.current = Date.now(); showHint('再按一次 Esc 清空'); return;
        case 'arm-rewind': escAt.current = Date.now(); showHint('再按一次 Esc 回溯对话'); return;
        case 'open-rewind': escAt.current = 0; openRewindPicker(); return;
        default: return; // 'noop'
      }
    }

    // 4.7) Arrow navigation routed by interaction state (块4). Runs before the
    //      editing fallthrough. Vim owns its own motions, plan/help overlays
    //      keep their handling, so we only route plain arrows outside those.
    const isArrow = key.upArrow || key.downArrow || key.leftArrow || key.rightArrow;
    if (isArrow && !vimEnabled && !planPhase && !showHelp) {
      const empty = value === '';

      // SUBVIEW — shell peek panel is open: ← returns, ↑/↓ scroll it, → no-op.
      if (shellViewOpen) {
        if (key.leftArrow) { setShellViewOpen(false); return; }
        if (key.upArrow) { setShellScroll((s) => Math.max(0, s - 1)); return; }
        if (key.downArrow) { setShellScroll((s) => s + 1); return; }
        return; // rightArrow inside the panel: swallow
      }

      // EXECUTING (busy && empty): ↑ pulls the last queued (unsent) message back
      // into the input for editing; ↓ opens the peek panel; ← no-op; → swallowed.
      if (busy && empty) {
        if (key.upArrow && query.queueLen > 0) {
          const item = query.dequeueLast();
          if (item) {
            textInput.setText(item.text);
            queueHintUsesRef.current += 1; // 学会一次「按 ↑ 编辑」→ 计入,达上限后占位符不再提示
            showHint('已取回排队消息，可编辑后重新发送');
          }
          return;
        }
        if (key.downArrow) { setShellScroll(0); setShellViewOpen(true); return; }
        return;
      }

      // IDLE_EMPTY (!busy && empty): ↑/↓ browse history (forward to textInput),
      // ← returns/no-op, → forwards (cursor no-op on empty).
      if (!busy && empty) {
        if (key.leftArrow) { return; } // no subview to return from → no-op
        textInput.onInput(input, key);
        return;
      }

      // EDITING (!empty): ←/→ forward (cursor). For vertical arrows:
      //   • multiline buffer → forward (useTextInput moves the cursor interiorly
      //     line-by-line, then browses history once on the boundary line);
      //   • single line → forward too (default), so ↑/↓ keep browsing history
      //     across ALL entries even with a draft/recalled entry present.
      // useTextInput stashes the live draft (draft.current) on the first ↑ and
      // restores it when ↓ walks past the newest entry, so the draft is never
      // lost — matching Claude Code / bash / readline. Without this the buffer
      // becomes non-empty after the first recall and every further ↑ was
      // swallowed, so you could only ever go back ONE entry and had to clear the
      // line before ↑ would recall the entry before it. Gate
      // KHY_HISTORY_BROWSE_EDITING∈{0,false,off,no} restores the legacy
      // "swallow single-line vertical arrows" behaviour (byte-identical).
      if (!empty) {
        if (key.upArrow || key.downArrow) {
          if (shouldBrowseHistoryWhileEditing({ hasNewline: value.includes('\n') })) {
            textInput.onInput(input, key); return;
          }
          return; // gate off + single-line with text → ignore vertical arrows
        }
        textInput.onInput(input, key);
        return;
      }
    }

    // 5) Everything else → text editing.
    textInput.onInput(input, key);
  }, { isActive: inputActive });

  // Welcome banner props.
  let bannerProps = {};
  try {
    const pkg = require('../../../../package.json');
    // CC 后端口径对齐(与页脚统一):横幅同样走友好模型名 + ccFormatTokens 的窗口大小。
    // model 经 FooterBar.formatModelLabel(裸 slug → "Opus 4.8",未知 → 原样);
    // contextWindow 经 ccFormatTokens(1M 窗口 → "1m 令牌" 而非旧的 "1000k 令牌";
    // 200k → "200k 令牌" 逐字节不变)——消除 [[project_cc_token_count_semantics]] 记的最后一处
    // 散落本地 token 格式器(Math.round(limit/1000)+"k")。两者各自包 try,异常静默回退旧形。
    let bannerModel = footer.model;
    try { if (FooterBar && FooterBar.formatModelLabel) bannerModel = FooterBar.formatModelLabel(footer.model); } catch { bannerModel = footer.model; }
    let bannerWindow = footer.contextLimit ? `${Math.round(footer.contextLimit / 1000)}k 令牌` : '';
    try {
      if (footer.contextLimit) {
        const fmt = require('../../ccFormat').ccFormatTokens;
        if (typeof fmt === 'function') bannerWindow = `${fmt(footer.contextLimit)} 令牌`;
      }
    } catch { /* keep the legacy window string */ }
    bannerProps = {
      version: pkg.version,
      model: bannerModel,
      adapter: footer.adapter || process.env.GATEWAY_PREFERRED_ADAPTER || 'auto',
      authMethod: 'API 密钥',
      contextWindow: bannerWindow,
      gatewayAdapters: 9,
    };
  } catch { /* */ }

  // 输入框占位符:优先级阶梯收敛到纯叶子 promptPlaceholder(CC usePromptInputPlaceholder)。
  // 新增「有可编辑排队消息且提示未用尽 → 按 ↑ 编辑」一档;门控关/叶子缺失 → 逐字节回退历史两分支。
  let placeholder;
  try {
    const _pp = require('../promptPlaceholder');
    placeholder = _pp.resolvePromptPlaceholder({
      reviewing: planPhase === 'reviewing',
      busy,
      queueEditable: !!(query && query.queueLen > 0),
      queueHintExhausted: queueHintUsesRef.current >= _pp.QUEUE_HINT_MAX_SHOWS,
      reviewText: 'Enter 确认执行 · skip/edit/add 修改 · n 取消',
      busyText: '',
      defaultText: '输入消息，/ 命令，@ 文件，! shell，# 记忆，? 快捷键',
      queueHintText: '按 ↑ 编辑排队消息，或继续输入',
    }, process.env);
  } catch {
    placeholder = planPhase === 'reviewing'
      ? 'Enter 确认执行 · skip/edit/add 修改 · n 取消'
      : (busy ? '' : '输入消息，/ 命令，@ 文件，! shell，# 记忆，? 快捷键');
  }

  // ── Live-region height coordination (anti scroll-jump) ──────────────────────
  // Read the merged task lines ONCE here (SSOT), cap them to a terminal-proportional
  // height, and compute StreamingBlock's reserve so it folds in the heights of the
  // sibling live panels below it. This keeps the whole live region < terminal rows,
  // so ink never enters its fullscreen clearTerminal repaint — which is what wipes
  // scrollback and yanks the view back to the top during long output. When the leaf
  // is unavailable / gate off, `_streamReserve` stays null and `_taskProps` empty →
  // StreamingBlock + TaskListPanel byte-revert to their legacy self-managed paths.
  let _streamReserve = null;
  let _taskProps = {};
  if (_liveBudget) {
    const _termRows = (process.stdout.rows && process.stdout.rows > 0) ? process.stdout.rows : 24;
    // Ctrl+T hides the checklist: force zero lines so the panel unmounts and its
    // height drops out of StreamingBlock's reserve (the live window grows back).
    const _rawTaskLines = tasksHidden ? [] : _readMergedTaskLines();
    const _capped = _liveBudget.capTaskLines(_rawTaskLines, _termRows, process.env);
    _taskProps = { lines: _capped.lines, hidden: _capped.hidden, hiddenLines: _capped.hiddenLines };
    // 语义分区(缺口②)会在 TaskListPanel 里为「本会话清单 / 项目任务」各插一行 dim 标签。
    // 把标签行数前馈进 reserve,使 anti-scroll-jump 高度账本包含它们(SSOT:同一 splitTaskLinesBySource
    // 叶子;门控关 / 单一来源 → null → 0 行,面板亦不分区,口径一致)。
    let _splitLabelRows = 0;
    try {
      const { splitTaskLinesBySource } = require('./taskPanelLines');
      const _g = splitTaskLinesBySource(_capped.lines, process.env);
      _splitLabelRows = _g ? _g.length : 0;
    } catch { _splitLabelRows = 0; }
    _streamReserve = _liveBudget.resolveStreamReserve({
      rows: _termRows,
      toolCount: (query.streaming && query.streaming.tools && query.streaming.tools.length) || 0,
      taskLineCount: _capped.lines.length + _splitLabelRows,
      taskHasHiddenNotice: _capped.hidden > 0,
      planActive: planPhase === 'generating' || planPhase === 'reviewing' || planPhase === 'executing',
      queueLen: query.queueLen || 0,
      steerLen: query.steerLen || 0,
      // 页脚变高的两条条件行(BASE_CHROME 未计入)+ 平台。协作行在 bridge 运行时渲;主题回退行在
      // 置顶 topicBar 跑不起来(topicBarOn=false,典型 Windows conhost)时把主题塞进页脚——与 :2082
      // 传给 FooterBar 的 `topic: topicBarOn?null:topic` 同一判定,口径单源不漂移。platform 让叶子
      // 对 win32 叠加静态余量(Windows fullscreen 重绘会把整屏刷进 scrollback,须前馈多留)。
      collabActive: !!(bridgeStatus && bridgeStatus.running),
      topicInFooter: !!(topic && !topicBarOn),
      platform: process.platform,
    }, process.env);
  }

  // Fix 1b — khy 自己的 /命令·@文件 补全下拉横向对齐到输入光标列(门控
  // KHY_COMPLETION_FOLLOW_CURSOR 默认开)。复用 PromptFrame.layoutPromptRows 得同款宽度
  // 感知行模型,caretGeometry 求 caret 显示列,clamp 保不出屏;门控关 → 0=贴左逐字节 legacy。
  // 全程无副作用、纯计算;lazy require displayWidth(CJK 宽度)与 PromptFrame 同惰性哲学。
  let _completionMarginLeft = 0;
  if (completion.active && caretGeometry.completionFollowEnabled(process.env)) {
    try {
      const _cols = (process.stdout.columns || 80);
      // Single-slot memo keyed on (value, offset, cols): while the completion menu
      // is open and the user arrows through options (App re-renders on selectedIndex
      // with value/offset/cols UNCHANGED), skip re-laying-out the whole buffer +
      // caret geometry — byte-identical, gate KHY_COMPLETION_MARGIN_MEMO. Fail-soft.
      const _computeMargin = () => {
        let _measure;
        try { _measure = require('../../formatters').displayWidth; } catch { _measure = null; }
        const _layout = PromptFrame.layoutPromptRows({ value, offset, cols: _cols });
        const _caretCol = caretGeometry.caretColumn(_layout.rows, _measure ? { measure: _measure } : {}).col;
        return caretGeometry.clampColumn(_caretCol, _cols, 24);
      };
      _completionMarginLeft = _caretMarginMemo
        ? _caretMarginMemo.memoCompletionMargin(value, offset, _cols, _computeMargin, process.env)
        : _computeMargin();
    } catch { _completionMarginLeft = 0; }
  }

  return h(Box, { flexDirection: 'column' },
    // Committed output (banner + transcript) via <Static>. Always mounted so
    // that suspending the live UI does not reprint scrollback.
    h(Static, { items: query.staticItems }, (item) => {
      if (item.kind === 'banner') return h(WelcomeBanner, { key: 'banner', ...bannerProps });
      return h(Transcript.MessageBlock, { key: item.key, msg: item.msg, expanded });
    }),

    // Live region — suspended while an interactive command owns the terminal.
    inputActive ? h(Box, { key: 'live', flexDirection: 'column' },
      // Live streaming turn.
      query.streaming
        ? h(StreamingBlock, { streaming: query.streaming, status: query.status, expanded, reserveRows: (_streamReserve == null ? null : _streamReserve + extraReserve) })
        : null,
      query.status === 'done' ? h(Text, { dimColor: true }, '✱ 完成') : null,

      // Plan-mode surface (stage 3): generation preview, approval view, or the
      // execution spinner. Step progress itself lands in the transcript.
      planPhase === 'generating' ? h(PlanApproval, { generating: true, genText: planGenText }) : null,
      planPhase === 'reviewing' ? h(PlanApproval, { plan: currentPlan }) : null,
      planPhase === 'executing' ? h(Box, { marginTop: 1 }, h(Spinner, { label: '执行计划中…' })) : null,

      // Shell peek panel (块4 SUBVIEW): live tool command + output, ↓ to open
      // while executing, ← to return, ↑/↓ to scroll.
      shellViewOpen ? h(ShellView, { streaming: query.streaming, scroll: shellScroll }) : null,

      busy && !awaitingUserChoice ? (query.status === 'compacting'
        ? h(CompactionProgress, { compaction: query.compaction })
        : h(Box, { marginTop: 1, flexDirection: 'column' },
            h(Spinner, {
              label: _getStatusLabel(query.status,
                _liveActivity(query.status, query.streaming, query.statusDetail) || _taskActivity()),
              detail: query.statusDetail,
              ..._spinnerProgress(query.turnStartedAt, nowTick, lastActivityRef.current, query.streaming),
            }),
            ...(query.queueLen > 0 ? _renderQueuePanel(query.queueItems) : []),
            ...(query.steerLen > 0 ? [
              h(inkRuntime.get().Text, { key: 'steer-pending', dimColor: true },
                `  ⟳ ${query.steerLen} 条方向修正待注入（下一个工具边界生效）`)
            ] : []),
            // Discoverability of the interrupt affordance (对齐 CC isLoading footer
            // "esc to interrupt"). Only when NOTHING is queued — with a queue the
            // panel above already shows the accurate two-step "Esc 取回并清空；再按
            // Esc 打断". Decision + text live in the interruptHint leaf; gated by
            // KHY_ESC_INTERRUPT_HINT (default on). Empty string → nothing rendered.
            ...((() => {
              const hint = interruptHint.buildInterruptHint({
                busy: true,
                queueLen: query.queueLen,
                compacting: query.status === 'compacting',
                awaitingChoice: awaitingUserChoice,
              });
              return hint
                ? [h(inkRuntime.get().Text, { key: 'esc-interrupt-hint', dimColor: true }, `  ⎋ ${hint}`)]
                : [];
            })())
          )
      ) : null,

      // Persistent task checklist (缺口②). Reads _taskStore.snapshot() pull-style;
      // the existing nowTick 1s heartbeat repaints the live region, so newly
      // added / status-changed tasks surface within ≤1s without wiring an event
      // emitter into _taskStore. Empty list / store error → renders nothing.
      // Escape hatch: KHY_TASK_PANEL=0 (checked inside TaskListPanel).
      // Ctrl+T (tasksHidden) forces the coordinated empty-lines path → null, so the
      // toggle works even when the budget leaf is unavailable (legacy self-read path).
      h(TaskListPanel, { key: 'task-panel', tick: nowTick, ..._taskProps, ...(tasksHidden ? { lines: [], hidden: 0, hiddenLines: [] } : {}) }),

      // Help overlay.
      showHelp ? h(HelpMenu, null) : null,

      // Input mode indicator (CC PromptInputModeIndicator).
      bashMode ? h(Text, { color: 'magenta' }, '! BASH 模式 · Enter 运行 shell 命令') : null,
      memoryMode ? h(Text, { color: 'green' }, '# 记忆模式 · Enter 写入记忆（下次对话生效）') : null,

      // Staged image attachments (Ctrl+V). Shown until the next turn is sent.
      pendingImages.length > 0
        ? h(Text, { color: 'blue' }, `📎 已附加 ${pendingImages.length} 张图片 · Enter 发送 · Ctrl+V 再加 · Esc 清除`)
        : null,

      // Vim mode indicator (CC PromptInputModeIndicator). Only while /vim is on.
      vimEnabled
        ? h(Text, { color: vimMode === 'NORMAL' ? 'green' : 'yellow', bold: true },
            vimMode === 'NORMAL' ? '-- NORMAL --' : '-- INSERT --')
        : null,

      // Prompt input.
      h(PromptFrame, { value, offset, busy, placeholder, accent,
        vimMode: vimEnabled ? vimMode : null }),

      // Completion dropdown (slash / @file).
      completion.active ? h(CompletionMenu, { completion, selectedIndex, marginLeft: _completionMarginLeft }) : null,

      // Reverse-incremental history search prompt (Ctrl+R). Thin read-only
      // overlay; state comes from the historyReverseSearch leaf.
      revSearch && _HistorySearchOverlay ? h(_HistorySearchOverlay, { state: revSearch }) : null,

      // Transient double-press affordance ("再按一次 Ctrl-C 退出" 等).
      hint ? h(Text, { dimColor: true }, hint) : null,

      // Footer. When the pinned topic bar is unavailable, the current topic is
      // shown here as a fallback (块3 degraded path).
      h(FooterBar, { ...footer, contextTokens: query.contextTokens || 0, permissionMode, localMode, fastMode, voiceMode, topic: topicBarOn ? null : topic, bridge: bridgeStatus, goalActive }),

      // Control-request overlay: AskUserQuestion → selection menu, else permission.
      query.controlRequest
        ? (isQuestionRequest(query.controlRequest)
            ? h(QuestionPrompt, { request: query.controlRequest.request, onResolve: query.resolveControl })
            : h(PermissionsPrompt, { request: query.controlRequest.request, onResolve: query.resolveControl }))
        : null,

      // Native model picker overlay (/model).
      modelPicker
        ? h(ModelPicker, {
            choices: modelPicker.choices,
            defaultValue: modelPicker.defaultValue,
            onResolve: resolveModelPicker,
          })
        : null,

      // Native rewind-target picker overlay (Phase 2 double-ESC 回溯).
      rewindPicker
        ? h(RewindPicker, {
            targets: rewindPicker.targets,
            onResolve: resolveRewindPicker,
          })
        : null,

      // Native /rollback checkpoint picker overlay (reuses RewindPicker).
      rollbackPicker
        ? h(RewindPicker, {
            targets: rollbackPicker.targets,
            title: '选择要回滚到的检查点（↑/↓ 选择，回车确认）',
            onResolve: resolveRollbackPicker,
          })
        : null,

      // Native sequential-form overlay (/login, /register, /passwd).
      formFlow
        ? h(FormFlow, {
            fields: formFlow.fields,
            title: formFlow.title,
            onResolve: resolveFormFlow,
          })
        : null,

      // KHY OS kernel terminal overlay (/khyos): boots the bare-metal kernel
      // under QEMU and bridges its serial console. Esc returns to the AI chat.
      khyosOpen
        ? h(KhyOsView, { onExit: () => setKhyosOpen(false) })
        : null,

      // 会话拓扑「森林」只读面板(/topology view)。TopologyPanel 自身只着色;
      // 走树/字形/标签全来自共享 SSOT(sessionTopology)。Esc/Enter 关闭(主
      // useInput 0d 分支消费)。
      topologyView
        ? h(Box, { flexDirection: 'column' },
            h(TopologyPanel, {
              forest: topologyView.forest,
              currentId: topologyView.currentId,
              degraded: topologyView.degraded,
            }),
            h(Text, { dimColor: true }, '（Esc / 回车 关闭)'))
        : null
    ) : null
  );
}


module.exports = App;
// Exported for unit tests: status-line label composition + live activity read.
module.exports._getStatusLabel = _getStatusLabel;
module.exports._taskActivity = _taskActivity;
module.exports._liveActivity = _liveActivity;
module.exports._spinnerProgress = _spinnerProgress;
module.exports._queuePanelLines = _queuePanelLines;
module.exports._liveClampBoundaryDecision = _liveClampBoundaryDecision;
